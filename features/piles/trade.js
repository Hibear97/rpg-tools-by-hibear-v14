/**
 * Обмен между игроками в стиле World of Warcraft.
 *  1. Игрок жмёт ПКМ по токену другого игрока (или кнопку «Обмен» на панели токенов) → тому приходит приглашение.
 *  2. Открывается окно: слева ваши ячейки, справа — партнёра. Перетащите предметы из листа персонажа в свои ячейки,
 *     впишите монеты.
 *  3. Оба жмут «Обмен». Любое изменение предложения снимает оба подтверждения (защита от подмены).
 *  4. Когда оба подтвердили — мастер проверяет, что всё на месте, и переносит предметы и монеты.
 */
import {
  MODULE_ID, RppApp, DialogV2, esc, setting, rarityColor, qtyOf, isPhysical, askQuantity,
  giveItemData, removeItemQty, playerActor, gmRequest, gmTry, onRequest, onEvent, emitEvent, assertOwner,
  chat, inspectData, ownerUserOf
} from "./core.js";
import { coinInputsHTML, readCoinInputs, coinsEmpty, coinsText, coinsCp, walletCp, walletAmounts, transferCoins, walletHTML } from "./currency.js";

/* -------------------------------------------- */
/*  Состояние у мастера                          */
/* -------------------------------------------- */

const trades = new Map();

function publicState(t) {
  const side = (s) => ({ user: s.user, actorUuid: s.actor, name: s.name, img: s.img, items: s.items, coins: s.coins, ready: s.ready });
  return { id: t.id, open: t.open, a: side(t.a), b: side(t.b) };
}
const broadcast = (t) => { t.touched = Date.now(); emitEvent("trState", publicState(t), [t.a.user, t.b.user]); };
const closeTrade = (t, reason, done = false) => {
  trades.delete(t.id);
  emitEvent("trClosed", { id: t.id, reason, done }, [t.a.user, t.b.user]);
};
const sideOf = (t, user) => (t.a.user === user.id ? "a" : t.b.user === user.id ? "b" : null);

function canAfford(actor, coins) {
  if (coinsEmpty(coins)) return true;
  if (coins.__cp != null) return walletCp(actor) >= coins.__cp;
  const have = walletAmounts(actor);
  return Object.entries(coins).every(([k, v]) => (have[k] ?? 0) >= v);
}

async function validateSide(s) {
  const actor = await fromUuid(s.actor);
  if (!actor) throw new Error("Персонаж не найден.");
  for (const it of s.items) {
    const item = actor.items.get(it.itemId);
    if (!item || qtyOf(item) < it.qty) throw new Error(`У «${actor.name}» больше нет «${it.name}»${it.qty > 1 ? ` ×${it.qty}` : ""}.`);
  }
  if (!canAfford(actor, s.coins)) throw new Error(`У «${actor.name}» не хватает монет.`);
  return actor;
}

export function registerTradeHandlers() {
  onRequest("trReq", async ({ actor, targetActor }, user) => {
    if (!setting("tradeEnabled")) throw new Error("Обмен выключен мастером.");
    const a = await fromUuid(actor);
    assertOwner(a, user);
    const b = await fromUuid(targetActor);
    if (!b) throw new Error("Персонаж партнёра не найден.");
    const target = ownerUserOf(b);
    if (!target) throw new Error(`Игрок «${b.name}» не в сети.`);
    if (target.id === user.id) throw new Error("Нельзя торговать с самим собой.");
    for (const t of [...trades.values()]) {
      const involved = [t.a.user, t.b.user];
      // Повисший обмен (окно закрыли вместе с вкладкой, игрок вышел, прошло больше 15 минут) — убираем.
      const stale = involved.some((u) => !game.users.get(u)?.active) || Date.now() - (t.touched ?? 0) > 15 * 60 * 1000;
      // Тот, кто начинает новый обмен, сам отказывается от своего прежнего.
      if (stale || involved.includes(user.id)) { closeTrade(t, stale ? "Прежний обмен закрыт." : "Прежний обмен отменён."); continue; }
      if (involved.includes(target.id)) throw new Error(`${b.name} сейчас занят другим обменом.`);
    }
    const t = {
      id: foundry.utils.randomID(), open: false, touched: Date.now(),
      a: { user: user.id, actor: a.uuid, name: a.name, img: a.img, items: [], coins: {}, ready: false },
      b: { user: target.id, actor: b.uuid, name: b.name, img: b.img, items: [], coins: {}, ready: false }
    };
    trades.set(t.id, t);
    emitEvent("trInvite", { id: t.id, from: a.name, img: a.img, player: user.name }, [target.id]);
    setTimeout(() => { if (trades.get(t.id) && !t.open) closeTrade(t, "Приглашение к обмену истекло."); }, 35000);
    return { id: t.id };
  });

  onRequest("trAnswer", async ({ id, accept }, user) => {
    const t = trades.get(id);
    if (!t || t.b.user !== user.id) throw new Error("Обмен не найден.");
    if (!accept) return closeTrade(t, `${t.b.name} отказывается от обмена.`);
    t.open = true;
    broadcast(t);
    return true;
  });

  onRequest("trOffer", async ({ id, items, coins }, user) => {
    const t = trades.get(id);
    const k = t && sideOf(t, user);
    if (!k || !t.open) throw new Error("Обмен не найден.");
    const s = t[k];
    const actor = await fromUuid(s.actor);
    const slots = setting("tradeSlots");
    const clean = [];
    for (const it of (items ?? []).slice(0, slots)) {
      const item = actor.items.get(it.itemId);
      if (!item || !isPhysical(item)) continue;
      const qty = Math.max(1, Math.min(Math.floor(Number(it.qty) || 1), qtyOf(item)));
      clean.push({ itemId: item.id, qty, name: item.name, img: item.img, rarity: item.system?.rarity ?? "" });
    }
    s.items = clean;
    s.coins = coins ?? {};
    t.a.ready = false; t.b.ready = false;
    broadcast(t);
    return true;
  });

  onRequest("trReady", async ({ id, ready }, user) => {
    const t = trades.get(id);
    const k = t && sideOf(t, user);
    if (!k || !t.open) throw new Error("Обмен не найден.");
    t[k].ready = !!ready;
    if (!(t.a.ready && t.b.ready)) { broadcast(t); return true; }

    // Оба согласны — проводим обмен.
    let A, B;
    try {
      A = await validateSide(t.a);
      B = await validateSide(t.b);
    } catch (e) {
      t.a.ready = false; t.b.ready = false;
      broadcast(t);
      throw e;
    }
    const move = async (from, to, items) => {
      for (const it of items) {
        const item = from.items.get(it.itemId);
        await giveItemData(to, item, it.qty);
        await removeItemQty(item, it.qty);
      }
    };
    await move(A, B, t.a.items);
    await move(B, A, t.b.items);
    await transferCoins(A, B, t.a.coins);
    await transferCoins(B, A, t.b.coins);

    const list = (s) => [...s.items.map((i) => `${esc(i.name)}${i.qty > 1 ? ` ×${i.qty}` : ""}`), coinsText(s.coins)].filter(Boolean).join(", ") || "ничего";
    await chat(`<h3><i class="fa-solid fa-handshake"></i> Обмен</h3>
      <p><b>${esc(A.name)}</b> → ${list(t.a)}</p><p><b>${esc(B.name)}</b> → ${list(t.b)}</p>`,
    { alias: "Обмен", whisper: [t.a.user, t.b.user, ...game.users.filter((u) => u.isGM).map((u) => u.id)] });
    closeTrade(t, "Обмен состоялся.", true);
    return true;
  });

  onRequest("trCancel", async ({ id }, user) => {
    const t = trades.get(id);
    if (!t || !sideOf(t, user)) return true;
    const who = t[sideOf(t, user)].name;
    closeTrade(t, `${who} отменяет обмен.`);
    return true;
  });

  /* Клиентские события */
  onEvent("trInvite", (d) => showInvite(d));
  onEvent("trState", (s) => TradeApp.update(s));
  onEvent("trClosed", (d) => {
    document.getElementById(`rpp-invite-${d.id}`)?.remove();
    TradeApp.closed(d);
  });
}

/* -------------------------------------------- */
/*  Начать обмен                                 */
/* -------------------------------------------- */

export async function requestTrade(targetActor) {
  const me = playerActor();
  if (!me) return ui.notifications.warn("Выберите своего персонажа.");
  if (!targetActor) return pickPartner();
  const ok = await DialogV2.confirm({
    window: { title: "Обмен", icon: "fa-solid fa-handshake" },
    classes: ["rpp-dialog"],
    content: `<p>Предложить обмен <b>${esc(targetActor.name)}</b>?</p>`,
    rejectClose: false
  });
  if (!ok) return;
  const r = await gmTry("trReq", { actor: me.uuid, targetActor: targetActor.uuid });
  if (r) ui.notifications.info(`Приглашение к обмену отправлено: ${targetActor.name}.`);
}

/** Выбор партнёра из игроков в сети. */
export async function pickPartner() {
  const me = playerActor();
  if (!me) return ui.notifications.warn("Выберите своего персонажа.");
  const others = game.users.filter((u) => u.active && !u.isGM && u.id !== game.user.id && u.character);
  if (!others.length) return ui.notifications.info("Сейчас не с кем меняться.");
  const id = await DialogV2.prompt({
    window: { title: "С кем меняемся?", icon: "fa-solid fa-handshake" },
    classes: ["rpp-dialog"],
    content: `<ul class="rpp-partner-list">${others.map((u, i) => `
      <li><label><input type="radio" name="who" value="${u.character.uuid}" ${i ? "" : "checked"}>
        <img src="${esc(u.character.img)}" alt=""> <b>${esc(u.character.name)}</b> <small>${esc(u.name)}</small></label></li>`).join("")}</ul>`,
    ok: { label: "Предложить обмен", icon: "fa-solid fa-handshake", callback: (e, btn) => btn.form.elements.who.value },
    rejectClose: false
  });
  if (!id) return;
  const r = await gmTry("trReq", { actor: me.uuid, targetActor: id });
  if (r) ui.notifications.info("Приглашение к обмену отправлено.");
}

/* -------------------------------------------- */
/*  Всплывающее приглашение                       */
/* -------------------------------------------- */

function showInvite({ id, from, img, player }) {
  let stack = document.getElementById("rpp-invite-stack");
  if (!stack) {
    stack = document.createElement("div");
    stack.id = "rpp-invite-stack";
    document.body.append(stack);
  }
  const el = document.createElement("div");
  el.className = "rpp-frame rpp-invite";
  el.id = `rpp-invite-${id}`;
  el.innerHTML = `
    <div class="rpp-frame-top">
      <img class="rpp-frame-icon" src="${esc(img)}" alt="">
      <div class="rpp-frame-info">
        <div class="rpp-frame-name">${esc(from)}</div>
        <div class="rpp-frame-meta">хочет обменяться с вами</div>
        <div class="rpp-frame-for">${esc(player)}</div>
      </div>
      <div class="rpp-round-buttons">
        <button type="button" class="rpp-rbtn ok" data-tooltip="Принять"><i class="fa-solid fa-check"></i></button>
        <button type="button" class="rpp-rbtn no" data-tooltip="Отклонить"><i class="fa-solid fa-xmark"></i></button>
      </div>
    </div>
    <div class="rpp-timer"><div class="rpp-timer-bar"></div></div>`;
  stack.append(el);
  try { foundry.audio.AudioHelper.play({ src: "sounds/notify.wav", volume: 0.6 }, false); } catch { /* нет звука */ }

  const total = 30000, start = Date.now();
  const bar = el.querySelector(".rpp-timer-bar");
  const tick = setInterval(() => {
    const left = Math.max(0, 1 - (Date.now() - start) / total);
    bar.style.width = `${left * 100}%`;
    if (left <= 0) answer(false);
  }, 100);
  let done = false;
  const answer = async (accept) => {
    if (done) return;
    done = true;
    clearInterval(tick);
    el.classList.add("closing");
    setTimeout(() => el.remove(), 200);
    await gmTry("trAnswer", { id, accept });
  };
  el.querySelector(".ok").addEventListener("click", () => answer(true));
  el.querySelector(".no").addEventListener("click", () => answer(false));
}

/* -------------------------------------------- */
/*  Окно обмена                                  */
/* -------------------------------------------- */

export class TradeApp extends RppApp {
  static instances = new Map();

  static update(state) {
    let app = this.instances.get(state.id);
    if (!app) {
      app = new this(state);
      this.instances.set(state.id, app);
    } else app.trade = state;
    app.render(true);
  }

  static closed({ id, reason, done }) {
    const app = this.instances.get(id);
    if (reason) ui.notifications[done ? "info" : "warn"](reason);
    if (app) { app._silent = true; app.close(); }
  }

  constructor(state, options = {}) {
    super({ id: `rpp-trade-${state.id}`, ...options });
    this.trade = state;
  }

  static DEFAULT_OPTIONS = {
    classes: ["rpp-window", "rpp-trade"],
    window: { title: "Обмен", icon: "fa-solid fa-handshake", resizable: false },
    position: { width: 560, height: "auto" },
    actions: { ready: TradeApp.#onReady, cancel: TradeApp.#onCancel, removeSlot: TradeApp.#onRemove, inspect: TradeApp.#onInspect }
  };

  get mine() { return this.trade.a.user === game.user.id ? "a" : "b"; }
  get theirs() { return this.mine === "a" ? "b" : "a"; }
  get title() { return `Обмен: ${this.trade[this.theirs].name}`; }

  async close(options) {
    TradeApp.instances.delete(this.trade.id);
    if (!this._silent) gmTry("trCancel", { id: this.trade.id });
    return super.close(options);
  }

  #panel(side, own) {
    const s = this.trade[side];
    const n = setting("tradeSlots");
    const slots = [];
    for (let i = 0; i < n; i++) {
      const it = s.items[i];
      slots.push(it ? `
        <div class="rpp-trade-slot filled" style="--rarity:${rarityColor(it.rarity)}" data-tooltip="${esc(it.name)}">
          <img src="${esc(it.img)}" alt="" data-action="inspect" data-side="${side}" data-index="${i}">
          ${it.qty > 1 ? `<span class="rpp-qty-badge">${it.qty}</span>` : ""}
          <span class="rpp-trade-name">${esc(it.name)}</span>
          ${own ? `<a class="rpp-slot-del" data-action="removeSlot" data-index="${i}" data-tooltip="Убрать"><i class="fa-solid fa-xmark"></i></a>` : ""}
        </div>` : `<div class="rpp-trade-slot empty"><span class="rpp-trade-name">${own ? "Перетащите предмет" : ""}</span></div>`);
    }
    const coins = own
      ? `<div class="rpp-coins-edit">${coinInputsHTML(s.coins)}</div>`
      : `<div class="rpp-coins-view">${coinsEmpty(s.coins) ? `<span class="rpp-muted">Монет нет</span>` : `<span class="rpp-price big"><i class="fa-solid fa-coins"></i> ${esc(coinsText(s.coins))}</span>`}</div>`;
    return `
      <section class="rpp-trade-panel ${own ? "own rpp-drop" : ""} ${s.ready ? "ready" : ""}">
        <header><img src="${esc(s.img)}" alt=""><span>${esc(s.name)}</span>
          ${s.ready ? `<i class="fa-solid fa-circle-check rpp-ok" data-tooltip="Готов к обмену"></i>` : ""}</header>
        <div class="rpp-trade-slots">${slots.join("")}</div>
        ${coins}
      </section>`;
  }

  async _html() {
    const me = this.trade[this.mine];
    const actor = fromUuidSync(me.actorUuid);
    return `
      <div class="rpp-trade-cols">
        ${this.#panel(this.mine, true)}
        ${this.#panel(this.theirs, false)}
      </div>
      <div class="rpp-wallet small">${actor ? `<span class="rpp-muted">У вас:</span> ${walletHTML(actor)}` : ""}</div>
      <p class="rpp-hint"><i class="fa-solid fa-shield-halved"></i> Любое изменение снимает подтверждение у обоих.</p>
      <footer class="rpp-footer">
        <button type="button" data-action="cancel"><i class="fa-solid fa-xmark"></i> Отмена</button>
        <button type="button" class="rpp-confirm ${me.ready ? "pressed" : ""}" data-action="ready">
          <i class="fa-solid fa-handshake"></i> ${me.ready ? "Ожидание партнёра…" : "Обмен"}</button>
      </footer>`;
  }

  _bind(content) {
    RppApp.dropZone(content.querySelector(".rpp-trade-panel.own"), (data) => this.#onDrop(data));
    const send = foundry.utils.debounce(() => this.#sendOffer(), 450);
    for (const inp of content.querySelectorAll(".rpp-trade-panel.own .rpp-coins-edit input")) {
      inp.addEventListener("input", send);
    }
  }

  #offerItems() { return this.trade[this.mine].items.map((i) => ({ itemId: i.itemId, qty: i.qty })); }

  async #sendOffer(items = this.#offerItems()) {
    const root = this.element?.querySelector(".rpp-trade-panel.own");
    const coins = root ? readCoinInputs(root) : this.trade[this.mine].coins;
    const actor = fromUuidSync(this.trade[this.mine].actorUuid);
    const cost = coins.__cp ?? coinsCp(coins);
    if (actor && cost > walletCp(actor)) ui.notifications.warn("У вас столько нет.");
    await gmTry("trOffer", { id: this.trade.id, items, coins });
  }

  async #onDrop(data) {
    if (data.type !== "Item" || !data.uuid) return;
    const item = await fromUuid(data.uuid);
    const me = this.trade[this.mine];
    if (!item || item.parent?.uuid !== me.actorUuid) return ui.notifications.warn("Перетащите предмет из инвентаря своего персонажа.");
    if (!isPhysical(item)) return ui.notifications.warn("Этот предмет нельзя передать.");
    const items = this.#offerItems().filter((i) => i.itemId !== item.id);
    if (items.length >= setting("tradeSlots")) return ui.notifications.warn("Все ячейки заняты.");
    const qty = await askQuantity(qtyOf(item), "Сколько передать?", item.name);
    if (!qty) return;
    items.push({ itemId: item.id, qty });
    await this.#sendOffer(items);
  }

  static async #onRemove(event, target) {
    const items = this.#offerItems();
    items.splice(Number(target.dataset.index), 1);
    await this.#sendOffer(items);
  }

  static #onInspect(event, target) {
    const s = this.trade[target.dataset.side];
    const it = s.items[Number(target.dataset.index)];
    const actor = fromUuidSync(s.actorUuid);
    const item = actor?.items.get(it?.itemId);
    if (item) item.sheet.render(true, { editable: false });
  }

  static async #onReady() {
    await gmTry("trReady", { id: this.trade.id, ready: !this.trade[this.mine].ready });
  }

  static #onCancel() { this.close(); }
}
