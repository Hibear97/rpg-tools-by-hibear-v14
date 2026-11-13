/**
 * Торговцы. Любой актёр (обычно NPC) становится лавкой.
 * Игрок подходит к токену торговца и жмёт ПКМ — открывается окно «Купить / Продать».
 * Мастер настраивает наценку, цену скупки, бесконечный товар, скидки для персонажей, цены и видимость отдельных товаров.
 */
import {
  MODULE_ID, RppApp, esc, setting, rarityColor, qtyOf, isPhysical, askQuantity,
  giveItemData, removeItemQty, playerActor, gmTry, onRequest, assertOwner, chat
} from "./core.js";
import { itemPriceCp, formatCp, priceHTML, walletHTML, walletCp, pay, receive } from "./currency.js";

export function mcfg(actor) {
  return {
    enabled: false, open: true, buyMult: setting("buyMult"), sellMult: setting("sellMult"),
    infinite: false, unlimitedGold: true, buys: true, keepZero: false, greeting: "", discounts: {},
    ...(actor?.flags?.[MODULE_ID]?.pt?.merchant ?? {})
  };
}
export const isMerchant = (actor) => !!actor?.flags?.[MODULE_ID]?.pt?.merchant?.enabled;
const shopOf = (item) => ({ price: null, infinite: false, hidden: false, ...(item?.flags?.[MODULE_ID]?.pt?.shop ?? {}) });

const discountFor = (cfg, buyer) => {
  const d = buyer ? Number(cfg.discounts?.[buyer.id] ?? cfg.discounts?.[buyer.baseActor?.id]) : NaN;
  return Number.isFinite(d) && d > 0 ? d : 1;
};

export function buyPrice(merchant, item, buyer) {
  const cfg = mcfg(merchant);
  const s = shopOf(item);
  const base = s.price != null && s.price !== "" ? Math.round(Number(s.price) * 100) : itemPriceCp(item);
  return Math.ceil(base * Number(cfg.buyMult) * discountFor(cfg, buyer));
}
export function sellPrice(merchant, item) {
  return Math.floor(itemPriceCp(item) * Number(mcfg(merchant).sellMult));
}
const infiniteOf = (merchant, item) => mcfg(merchant).infinite || shopOf(item).infinite;
const forSale = (merchant, item, gm = false) =>
  isPhysical(item) && !item.system?.container && (gm || !shopOf(item).hidden) && (infiniteOf(merchant, item) || qtyOf(item) > 0 || gm);

/* -------------------------------------------- */
/*  Мастер: покупка и продажа                    */
/* -------------------------------------------- */

export function registerMerchantHandlers() {
  onRequest("mBuy", async ({ merchant, actor, itemId, qty }, user) => {
    const m = await fromUuid(merchant);
    const a = await fromUuid(actor);
    assertOwner(a, user);
    if (!isMerchant(m)) throw new Error("Это не торговец.");
    const cfg = mcfg(m);
    if (!cfg.open && !user.isGM) throw new Error("Лавка закрыта.");
    const item = m.items.get(itemId);
    if (!item || !forSale(m, item)) throw new Error("Этот товар больше не продаётся.");
    const inf = infiniteOf(m, item);
    const n = Math.max(1, Math.floor(Number(qty) || 1));
    if (!inf && n > qtyOf(item)) throw new Error(`В наличии только ${qtyOf(item)}.`);
    const cost = buyPrice(m, item, a) * n;
    if (walletCp(a) < cost) throw new Error(`Не хватает денег: нужно ${formatCp(cost)}.`);

    await pay(a, cost);
    await receive(m, cost);
    await giveItemData(a, item, n);
    if (!inf) {
      if (n >= qtyOf(item) && !cfg.keepZero) await item.delete();
      else await item.update({ "system.quantity": Math.max(0, qtyOf(item) - n) });
    }
    if (setting("tradeChat")) {
      await chat(`<p><i class="fa-solid fa-cart-shopping"></i> <b>${esc(a.name)}</b> купил у ${esc(m.name)}:
        <b>${esc(item.name)}</b>${n > 1 ? ` ×${n}` : ""} за ${esc(formatCp(cost))}</p>`,
      { alias: m.name, whisper: [user.id, ...game.users.filter((u) => u.isGM).map((u) => u.id)] });
    }
    return { cost };
  });

  onRequest("mSell", async ({ merchant, actor, itemId, qty }, user) => {
    const m = await fromUuid(merchant);
    const a = await fromUuid(actor);
    assertOwner(a, user);
    if (!isMerchant(m)) throw new Error("Это не торговец.");
    const cfg = mcfg(m);
    if (!cfg.open && !user.isGM) throw new Error("Лавка закрыта.");
    if (!cfg.buys) throw new Error("Этот торговец ничего не покупает.");
    const item = a.items.get(itemId);
    if (!item || !isPhysical(item)) throw new Error("Этот предмет нельзя продать.");
    const n = Math.max(1, Math.min(Math.floor(Number(qty) || 1), qtyOf(item)));
    const value = sellPrice(m, item) * n;
    if (value <= 0) throw new Error("Торговцу это не нужно.");
    if (!cfg.unlimitedGold && walletCp(m) < value) throw new Error("У торговца не хватает денег.");

    if (!cfg.unlimitedGold) await pay(m, value);
    await receive(a, value);
    if (!cfg.infinite) await giveItemData(m, item, n);
    await removeItemQty(item, n);
    if (setting("tradeChat")) {
      await chat(`<p><i class="fa-solid fa-coins"></i> <b>${esc(a.name)}</b> продал ${esc(m.name)}:
        <b>${esc(item.name)}</b>${n > 1 ? ` ×${n}` : ""} за ${esc(formatCp(value))}</p>`,
      { alias: m.name, whisper: [user.id, ...game.users.filter((u) => u.isGM).map((u) => u.id)] });
    }
    return { value };
  });
}

/* -------------------------------------------- */
/*  Окно лавки                                   */
/* -------------------------------------------- */

export class MerchantApp extends RppApp {
  static instances = new Map();

  static open(merchant, buyer) {
    if (!isMerchant(merchant)) return ui.notifications.warn("Это не торговец.");
    if (!mcfg(merchant).open && !game.user.isGM) return ui.notifications.info(`${merchant.name}: лавка закрыта.`);
    const ex = this.instances.get(merchant.uuid);
    if (ex) { ex.buyer = buyer ?? ex.buyer; ex.render(true); return ex; }
    const app = new this(merchant, buyer);
    this.instances.set(merchant.uuid, app);
    app.render(true);
    return app;
  }

  /** Перерисовать окна, где участвует этот актёр. */
  static refreshFor(actor) {
    if (!actor) return;
    for (const app of this.instances.values()) {
      if (app.merchant.uuid === actor.uuid || app.buyer?.uuid === actor.uuid
        || app.merchant.id === actor.id || app.buyer?.id === actor.id) app.render();
    }
  }

  constructor(merchant, buyer, options = {}) {
    super(options);
    this.merchant = merchant;
    this.buyer = buyer ?? playerActor();
    this.tab = "buy";
    this.search = "";
  }

  static DEFAULT_OPTIONS = {
    classes: ["rpp-window", "rpp-merchant"],
    window: { title: "Торговец", icon: "fa-solid fa-store", resizable: true },
    position: { width: 520, height: 640 },
    actions: {
      tab: MerchantApp.#onTab, buy: MerchantApp.#onBuy, sell: MerchantApp.#onSell,
      inspect: MerchantApp.#onInspect, config: MerchantApp.#onConfig
    }
  };

  get title() { return this.merchant.name; }

  async close(options) {
    MerchantApp.instances.delete(this.merchant.uuid);
    return super.close(options);
  }

  async _html() {
    const m = this.merchant, b = this.buyer, cfg = mcfg(m), gm = game.user.isGM;
    const q = this.search.toLowerCase();
    const match = (i) => !q || i.name.toLowerCase().includes(q);

    let rows = "";
    if (this.tab === "buy") {
      const items = m.items.filter((i) => forSale(m, i, gm) && match(i)).sort((x, y) => x.name.localeCompare(y.name, "ru"));
      rows = items.length ? items.map((i) => {
        const inf = infiniteOf(m, i);
        const price = buyPrice(m, i, b);
        const s = shopOf(i);
        const cant = !b || (walletCp(b) < price);
        return `
          <li class="rpp-shop-row ${s.hidden ? "hidden-item" : ""} ${!inf && qtyOf(i) <= 0 ? "sold-out" : ""}" style="--rarity:${rarityColor(i.system?.rarity)}">
            <img src="${esc(i.img)}" alt="" data-action="inspect" data-id="${i.id}" data-tooltip="Осмотреть">
            <div class="rpp-shop-info">
              <span class="rpp-item-name">${esc(i.name)}${s.hidden ? ` <i class="fa-solid fa-eye-slash" data-tooltip="Скрыт от игроков"></i>` : ""}</span>
              <span class="rpp-item-meta">${inf ? "∞ в наличии" : `В наличии: ${qtyOf(i)}`}</span>
            </div>
            ${priceHTML(price)}
            <button type="button" class="rpp-buy ${cant ? "poor" : ""}" data-action="buy" data-id="${i.id}"
              ${!inf && qtyOf(i) <= 0 ? "disabled" : ""}><i class="fa-solid fa-cart-shopping"></i> Купить</button>
          </li>`;
      }).join("") : `<li class="rpp-empty">Товаров нет.</li>`;
    } else {
      if (!b) rows = `<li class="rpp-empty">Выберите своего персонажа.</li>`;
      else if (!cfg.buys) rows = `<li class="rpp-empty">Этот торговец ничего не покупает.</li>`;
      else {
        const items = b.items.filter((i) => isPhysical(i) && !i.system?.container && qtyOf(i) > 0 && match(i))
          .sort((x, y) => x.name.localeCompare(y.name, "ru"));
        rows = items.length ? items.map((i) => {
          const price = sellPrice(m, i);
          return `
            <li class="rpp-shop-row" style="--rarity:${rarityColor(i.system?.rarity)}">
              <img src="${esc(i.img)}" alt="">
              <div class="rpp-shop-info">
                <span class="rpp-item-name">${esc(i.name)}</span>
                <span class="rpp-item-meta">У вас: ${qtyOf(i)}${i.system?.equipped ? " · экипировано" : ""}</span>
              </div>
              ${price > 0 ? priceHTML(price) : `<span class="rpp-muted">не нужен</span>`}
              <button type="button" data-action="sell" data-id="${i.id}" ${price > 0 ? "" : "disabled"}><i class="fa-solid fa-coins"></i> Продать</button>
            </li>`;
        }).join("") : `<li class="rpp-empty">Нечего продать.</li>`;
      }
    }

    return `
      <header class="rpp-head">
        <img class="rpp-head-img round" src="${esc(m.img)}" alt="">
        <div class="rpp-head-text">
          <h2>${esc(m.name)}</h2>
          <div class="rpp-sub">${cfg.open ? `<span class="rpp-ok"><i class="fa-solid fa-door-open"></i> Открыто</span>` : `<span class="rpp-bad"><i class="fa-solid fa-door-closed"></i> Закрыто</span>`}
            ${cfg.greeting ? ` · <i>${esc(cfg.greeting)}</i>` : ""}</div>
        </div>
        ${gm ? `<div class="rpp-head-tools"><a data-action="config" data-tooltip="Настроить торговца"><i class="fa-solid fa-gear"></i></a></div>` : ""}
      </header>
      <nav class="rpp-tabs">
        <a class="${this.tab === "buy" ? "active" : ""}" data-action="tab" data-tab="buy"><i class="fa-solid fa-cart-shopping"></i> Купить</a>
        <a class="${this.tab === "sell" ? "active" : ""}" data-action="tab" data-tab="sell"><i class="fa-solid fa-coins"></i> Продать</a>
        <input type="search" class="rpp-search" placeholder="Поиск…" value="${esc(this.search)}">
      </nav>
      <ul class="rpp-shop-list">${rows}</ul>
      <footer class="rpp-wallet">
        ${b ? `<span class="rpp-wallet-name"><img src="${esc(b.img)}" alt=""> ${esc(b.name)}</span><span class="rpp-coins">${walletHTML(b)}</span>`
          : `<span class="rpp-muted">Персонаж не выбран</span>`}
        ${!gm && !cfg.unlimitedGold ? `<span class="rpp-muted" data-tooltip="Деньги торговца">Касса: ${esc(formatCp(walletCp(m)))}</span>` : ""}
      </footer>`;
  }

  _bind(content) {
    const s = content.querySelector(".rpp-search");
    s?.addEventListener("input", foundry.utils.debounce(() => {
      this.search = s.value;
      this.render().then(() => {
        const el = this.element.querySelector(".rpp-search");
        el?.focus(); el?.setSelectionRange(el.value.length, el.value.length);
      });
    }, 250));
    RppApp.dropZone(content.querySelector(".rpp-shop-list"), async (data) => {
      if (data.type !== "Item" || !data.uuid) return;
      const item = await fromUuid(data.uuid);
      if (game.user.isGM && item?.parent?.uuid !== this.merchant.uuid && item?.parent?.uuid !== this.buyer?.uuid) {
        // Мастер пополняет ассортимент перетаскиванием
        await this.merchant.createEmbeddedDocuments("Item", [item.toObject()]);
        return;
      }
      if (item?.parent?.uuid === this.buyer?.uuid) { this.tab = "sell"; MerchantApp.#sellItem.call(this, item); }
    });
  }

  static #onTab(event, target) { this.tab = target.dataset.tab; this.render(); }
  static #onConfig() { new MerchantConfigApp(this.merchant).render(true); }

  static #onInspect(event, target) { this.merchant.items.get(target.dataset.id)?.sheet?.render(true, { editable: game.user.isGM }); }

  static async #onBuy(event, target) {
    if (!this.buyer) return ui.notifications.warn("Выберите своего персонажа.");
    const item = this.merchant.items.get(target.dataset.id);
    if (!item) return;
    const unit = buyPrice(this.merchant, item, this.buyer);
    const max = infiniteOf(this.merchant, item) ? Math.max(1, Math.floor(walletCp(this.buyer) / Math.max(1, unit)) || 1) : qtyOf(item);
    const qty = event.shiftKey ? 1 : await askQuantity(Math.min(max, 999), `Купить: ${item.name}`, `Цена за штуку ${formatCp(unit)}. Количество`);
    if (!qty) return;
    const r = await gmTry("mBuy", { merchant: this.merchant.uuid, actor: this.buyer.uuid, itemId: item.id, qty });
    if (r) ui.notifications.info(`Куплено: ${item.name}${qty > 1 ? ` ×${qty}` : ""} за ${formatCp(r.cost)}`);
  }

  static async #onSell(event, target) {
    const item = this.buyer?.items.get(target.dataset.id);
    if (item) await MerchantApp.#sellItem.call(this, item, event.shiftKey);
  }

  static async #sellItem(item, one = false) {
    const unit = sellPrice(this.merchant, item);
    const qty = one ? 1 : await askQuantity(qtyOf(item), `Продать: ${item.name}`, `Цена за штуку ${formatCp(unit)}. Количество`);
    if (!qty) return;
    const r = await gmTry("mSell", { merchant: this.merchant.uuid, actor: this.buyer.uuid, itemId: item.id, qty });
    if (r) ui.notifications.info(`Продано: ${item.name}${qty > 1 ? ` ×${qty}` : ""} за ${formatCp(r.value)}`);
  }
}

/* -------------------------------------------- */
/*  Настройка торговца (мастер)                  */
/* -------------------------------------------- */

export class MerchantConfigApp extends RppApp {
  constructor(merchant, options = {}) {
    super(options);
    this.merchant = merchant;
    this.discounts = foundry.utils.deepClone(mcfg(merchant).discounts ?? {});
  }

  static DEFAULT_OPTIONS = {
    classes: ["rpp-window", "rpp-config", "rpp-merchant-config"],
    tag: "form",
    window: { title: "Настройка торговца", icon: "fa-solid fa-store", resizable: true },
    position: { width: 640, height: 720 },
    form: { handler: MerchantConfigApp.#onSubmit, closeOnSubmit: true },
    actions: { removeDiscount: MerchantConfigApp.#onRemoveDiscount, disable: MerchantConfigApp.#onDisable }
  };

  get title() { return `Торговец: ${this.merchant.name}`; }

  async _html() {
    const c = mcfg(this.merchant);
    const field = (label, input, hint = "") => `
      <div class="rpp-field"><label>${label}</label><div class="rpp-input">${input}</div>${hint ? `<p class="hint">${hint}</p>` : ""}</div>`;
    const chk = (name, val) => `<input type="checkbox" name="${name}" ${val ? "checked" : ""}>`;

    const disc = Object.entries(this.discounts).map(([id, mult]) => {
      const a = game.actors.get(id);
      return `<li class="rpp-disc"><img src="${esc(a?.img ?? "icons/svg/mystery-man.svg")}" alt=""> <span>${esc(a?.name ?? id)}</span>
        <input type="number" name="disc-${id}" step="0.05" min="0" value="${mult}">
        <a data-action="removeDiscount" data-id="${id}"><i class="fa-solid fa-trash"></i></a></li>`;
    }).join("") || `<li class="rpp-empty">Перетащите сюда персонажа, чтобы дать ему особую цену (0.8 = скидка 20%).</li>`;

    const items = this.merchant.items.filter((i) => isPhysical(i) && !i.system?.container)
      .sort((x, y) => x.name.localeCompare(y.name, "ru"));
    const itemRows = items.map((i) => {
      const s = shopOf(i);
      return `<tr style="--rarity:${rarityColor(i.system?.rarity)}">
        <td><img src="${esc(i.img)}" alt=""></td>
        <td class="rpp-item-name">${esc(i.name)}</td>
        <td>${qtyOf(i)}</td>
        <td class="rpp-muted">${esc(formatCp(itemPriceCp(i)))}</td>
        <td><input type="number" name="price-${i.id}" step="0.01" min="0" value="${s.price ?? ""}" placeholder="—"></td>
        <td><input type="checkbox" name="inf-${i.id}" ${s.infinite ? "checked" : ""}></td>
        <td><input type="checkbox" name="hid-${i.id}" ${s.hidden ? "checked" : ""}></td>
      </tr>`;
    }).join("");

    return `
      <section class="rpp-section"><h3><i class="fa-solid fa-store"></i> Лавка</h3>
        <div class="rpp-fields">
          ${field("Это торговец", chk("enabled", true))}
          ${field("Открыто", chk("open", c.open), "Закрытая лавка не открывается у игроков.")}
          ${field("Приветствие", `<input type="text" name="greeting" value="${esc(c.greeting)}" placeholder="Заходите, путники!">`)}
          ${field("Наценка (покупка игроком)", `<input type="number" name="buyMult" step="0.05" min="0" value="${c.buyMult}">`, "1 — по цене из книги, 1.5 — на 50% дороже.")}
          ${field("Скупка (продажа игроком)", `<input type="number" name="sellMult" step="0.05" min="0" value="${c.sellMult}">`, "0.5 — торговец платит половину цены.")}
          ${field("Покупает у игроков", chk("buys", c.buys))}
          ${field("Бесконечный товар", chk("infinite", c.infinite), "Товар не заканчивается, проданное игроками не появляется на прилавке.")}
          ${field("Бесконечная касса", chk("unlimitedGold", c.unlimitedGold), "Иначе торговец платит из своих монет.")}
          ${field("Оставлять товар с 0 шт.", chk("keepZero", c.keepZero))}
        </div>
      </section>
      <section class="rpp-section"><h3><i class="fa-solid fa-percent"></i> Особые цены для персонажей</h3>
        <ul class="rpp-discounts rpp-drop">${disc}</ul>
      </section>
      <section class="rpp-section"><h3><i class="fa-solid fa-boxes-stacked"></i> Товары</h3>
        <p class="rpp-hint">Товары — это предметы в инвентаре торговца. Добавляйте их перетаскиванием в лист персонажа или в окно лавки.
          «Своя цена» — в золотых, пусто = цена из предмета.</p>
        <table class="rpp-items-table">
          <thead><tr><th></th><th>Предмет</th><th>Шт.</th><th>Цена</th><th>Своя цена</th><th data-tooltip="Бесконечно">∞</th><th data-tooltip="Скрыть от игроков"><i class="fa-solid fa-eye-slash"></i></th></tr></thead>
          <tbody>${itemRows || `<tr><td colspan="7" class="rpp-empty">Инвентарь пуст.</td></tr>`}</tbody>
        </table>
      </section>
      <footer class="rpp-footer">
        <button type="button" data-action="disable"><i class="fa-solid fa-ban"></i> Больше не торговец</button>
        <button type="submit" class="rpp-confirm"><i class="fa-solid fa-floppy-disk"></i> Сохранить</button>
      </footer>`;
  }

  _bind(content) {
    RppApp.dropZone(content.querySelector(".rpp-discounts"), async (data) => {
      if (data.type !== "Actor") return;
      const a = await fromUuid(data.uuid);
      if (!a) return;
      this.discounts[a.id] = this.discounts[a.id] ?? 0.9;
      this.render();
    });
  }

  static #onRemoveDiscount(event, target) { delete this.discounts[target.dataset.id]; this.render(); }

  static async #onDisable() {
    await this.merchant.update({ [`flags.${MODULE_ID}.pt.merchant.enabled`]: false });
    MerchantApp.instances.get(this.merchant.uuid)?.close();
    this.close();
  }

  static async #onSubmit(event, form, formData) {
    const d = formData.object;
    const discounts = {};
    for (const id of Object.keys(this.discounts)) discounts[id] = Number(d[`disc-${id}`]) || 1;
    await this.merchant.update({
      [`flags.${MODULE_ID}.pt.-=merchant`]: null
    });
    await this.merchant.update({
      [`flags.${MODULE_ID}.pt.merchant`]: {
        enabled: !!d.enabled, open: !!d.open, greeting: d.greeting ?? "",
        buyMult: Number(d.buyMult) || 0, sellMult: Number(d.sellMult) || 0,
        buys: !!d.buys, infinite: !!d.infinite, unlimitedGold: !!d.unlimitedGold, keepZero: !!d.keepZero, discounts
      }
    });
    const updates = [];
    for (const i of this.merchant.items) {
      if (!(`price-${i.id}` in d) && !(`inf-${i.id}` in d)) continue;
      const raw = d[`price-${i.id}`];
      updates.push({
        _id: i.id,
        [`flags.${MODULE_ID}.pt.shop`]: {
          price: raw === "" || raw == null || Number.isNaN(Number(raw)) ? null : Number(raw),
          infinite: !!d[`inf-${i.id}`], hidden: !!d[`hid-${i.id}`]
        }
      });
    }
    if (updates.length) await this.merchant.updateEmbeddedDocuments("Item", updates);
    MerchantApp.refreshFor(this.merchant);
  }
}

/** Сделать актёра торговцем и открыть настройку. */
export async function makeMerchant(actor) {
  if (!isMerchant(actor)) await actor.update({ [`flags.${MODULE_ID}.pt.merchant`]: { ...mcfg(actor), enabled: true } });
  new MerchantConfigApp(actor).render(true);
}
