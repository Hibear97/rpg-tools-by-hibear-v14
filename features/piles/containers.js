/**
 * Контейнеры (сундуки, бочки…) и кучи лута на тайлах.
 *
 * Мастер ставит тайл и включает на нём «контейнер» (кнопка в HUD тайла или инструмент «Сундук» на панели тайлов).
 * Состояния: заперт / закрыт / открыт. Игрок подходит и жмёт ПКМ по тайлу:
 *  - заперт  → запрос броска на вскрытие (нужны воровские инструменты или отмычки; при провале отмычка ломается);
 *  - закрыт  → открывается (звук, смена картинки) и показывается содержимое;
 *  - открыт  → показывается содержимое.
 * Куча лута — тот же контейнер без замка: появляется, когда предмет бросают на карту или мастер превращает токен в кучу.
 */
import {
  MODULE_ID, RppApp, DialogV2, esc, setting, rarityColor, qtyOf, isPhysical, askQuantity,
  addToList, cleanItemData, giveItemData, removeItemQty, inspectData, playerActor, inRange,
  gmRequest, gmTry, onRequest, assertOwner, playSound, defaultSounds, chat
} from "./core.js";
import { formatCp, walletCp, pay, receive, coinInputsHTML, readCoinInputs, coinsCp, goldOnly } from "./currency.js";

const DEFAULTS = {
  enabled: false, kind: "container", name: "Сундук", state: "closed", dc: 15, showDC: false,
  imgClosed: "", imgOpen: "", imgEmpty: "",
  soundOpen: "", soundClose: "", soundLocked: "", soundUnlock: "",
  deposit: true, deleteEmpty: false, range: null, items: [], cp: 0
};
const STATE = {
  locked: { label: "Заперт", icon: "fa-solid fa-lock", color: "#e05050" },
  closed: { label: "Закрыт", icon: "fa-solid fa-box", color: "#c9a35b" },
  open:   { label: "Открыт", icon: "fa-solid fa-box-open", color: "#46c35f" }
};

export const cfgOf = (tileDoc) => ({ ...DEFAULTS, ...(tileDoc?.flags?.[MODULE_ID]?.pt ?? {}) });
export const isContainer = (tileDoc) => !!tileDoc?.flags?.[MODULE_ID]?.pt?.enabled;
/** Закрыт ли контейнер для игрока: куча лута (сумка, мешок) закрыта только если заперта, сундук — пока не открыт. */
const isShut = (cfg) => (cfg.kind === "pile" ? cfg.state === "locked" : cfg.state !== "open");
const isEmpty = (cfg) => !(cfg.items?.length) && !(Number(cfg.cp) > 0);
/** Прямоугольник тайла на сцене. В Foundry v14 точка (x, y) тайла — это его якорь (Anchor X/Y),
 *  поэтому берём границы с канваса, а без канваса считаем от якоря. */
export function tileRect(doc) {
  const b = doc?.object?.bounds;
  if (b && b.width) return { x: b.x, y: b.y, width: b.width, height: b.height };
  const ax = Number(doc?.texture?.anchorX ?? 0) || 0, ay = Number(doc?.texture?.anchorY ?? 0) || 0;
  return { x: doc.x - ax * doc.width, y: doc.y - ay * doc.height, width: doc.width, height: doc.height };
}
/** Новые тайлы сборки: якорь в левом верхнем углу, чтобы (x, y) был углом, как раньше */
const TOP_LEFT = { anchorX: 0, anchorY: 0 };

function soundsOf(cfg) {
  const d = defaultSounds();
  return {
    open: cfg.soundOpen || d.open, close: cfg.soundClose || d.close,
    locked: cfg.soundLocked || d.locked, unlock: cfg.soundUnlock || d.unlock
  };
}

/** Какая картинка должна стоять у тайла. null — не трогать. */
function textureFor(cfg) {
  if (cfg.kind === "pile") return null;
  if (cfg.state === "open" && isEmpty(cfg) && cfg.imgEmpty) return cfg.imgEmpty;
  if (cfg.state === "open" && cfg.imgOpen) return cfg.imgOpen;
  return cfg.imgClosed || null;
}

/** Записать изменения контейнера (только мастер). Удаляет пустую кучу. */
async function saveCfg(tileDoc, patch) {
  const cfg = { ...cfgOf(tileDoc), ...patch };
  if (cfg.kind === "pile" && cfg.deleteEmpty && isEmpty(cfg)) {
    await tileDoc.delete();
    return null;
  }
  const upd = {};
  for (const [k, v] of Object.entries(patch)) upd[`flags.${MODULE_ID}.pt.${k}`] = v;
  const tex = textureFor(cfg);
  if (tex && tex !== tileDoc.texture?.src) upd["texture.src"] = tex;
  await tileDoc.update(upd);
  return cfg;
}

function getTile(uuid) {
  const doc = fromUuidSync(uuid);
  if (!doc || doc.documentName !== "Tile" || !isContainer(doc)) throw new Error("Контейнер не найден.");
  return doc;
}

async function getActor(uuid, user) {
  const actor = await fromUuid(uuid);
  if (!actor || actor.documentName !== "Actor") throw new Error("Персонаж не найден.");
  assertOwner(actor, user);
  return actor;
}

/* -------------------------------------------- */
/*  Действия, которые выполняет мастер          */
/* -------------------------------------------- */

export function registerContainerHandlers() {
  onRequest("ctState", async ({ tile, state }, user) => {
    const doc = getTile(tile);
    const cfg = cfgOf(doc);
    if (!STATE[state]) throw new Error("Неизвестное состояние.");
    if (!user.isGM) {
      const allowed = (cfg.state === "closed" && state === "open") || (cfg.state === "open" && state === "closed");
      if (!allowed) throw new Error(cfg.state === "locked" ? "Заперто." : "Так нельзя.");
    }
    if (cfg.state === state) return { state };
    await saveCfg(doc, { state });
    const s = soundsOf(cfg);
    if (state === "open") playSound(s.open);
    else if (state === "closed" && cfg.state === "open") playSound(s.close);
    else if (state === "closed" && cfg.state === "locked") playSound(s.unlock);
    else if (state === "locked") playSound(s.unlock);
    return { state };
  });

  onRequest("ctPick", async ({ tile, actor, total, tool, pickId }, user) => {
    const doc = getTile(tile);
    const cfg = cfgOf(doc);
    const a = await getActor(actor, user);
    if (cfg.state !== "locked") return { success: true };
    const success = Number(total) >= Number(cfg.dc);
    const s = soundsOf(cfg);
    if (success) {
      await saveCfg(doc, { state: "open" });
      playSound(s.unlock);
      setTimeout(() => playSound(s.open), 500);
      await chat(`<h3><i class="fa-solid fa-lock-open"></i> Замок вскрыт</h3>
        <p><b>${esc(a.name)}</b> ${tool === "force" ? "выламывает замок" : "вскрывает"} «${esc(cfg.name)}».</p>`);
      return { success: true };
    }
    playSound(s.locked);
    let broke = false;
    if (tool === "pick" && setting("lockpickBreak")) {
      const pick = a.items.get(pickId);
      if (pick) { await removeItemQty(pick, 1); broke = true; }
    }
    await chat(`<h3><i class="fa-solid fa-lock"></i> Замок не поддался</h3>
      <p><b>${esc(a.name)}</b> не смог ${tool === "force" ? "выломать замок" : "вскрыть"} «${esc(cfg.name)}».${broke ? ` <span class="rpp-bad"><i class="fa-solid fa-heart-crack"></i> Отмычка сломалась!</span>` : ""}</p>`);
    return { success: false, broke };
  });

  onRequest("ctTake", async ({ tile, actor, key, qty, all, coins }, user) => {
    const doc = getTile(tile);
    const cfg = cfgOf(doc);
    if (!user.isGM && isShut(cfg)) throw new Error(cfg.state === "locked" ? "Заперто." : "Контейнер закрыт.");
    const a = await getActor(actor, user);
    let items = foundry.utils.deepClone(cfg.items ?? []);
    let cp = Number(cfg.cp) || 0;
    const taken = [];

    const takeOne = async (entry, n) => {
      n = Math.min(n, qtyOf(entry.data));
      if (n <= 0) return;
      await giveItemData(a, entry.data, n);
      taken.push(`${entry.data.name}${n > 1 ? ` ×${n}` : ""}`);
      if (n >= qtyOf(entry.data)) items = items.filter((e) => e.key !== entry.key);
      else entry.data.system.quantity = qtyOf(entry.data) - n;
    };

    if (all) {
      for (const e of [...items]) await takeOne(e, qtyOf(e.data));
    } else if (key) {
      const e = items.find((x) => x.key === key);
      if (!e) throw new Error("Этого предмета уже нет.");
      await takeOne(e, Math.max(1, Number(qty) || 1));
    }
    if ((all || coins) && cp > 0) {
      await receive(a, cp);
      taken.push(formatCp(cp));
      cp = 0;
    }
    await saveCfg(doc, { items, cp });
    return { taken };
  });

  onRequest("ctPut", async ({ tile, actor, itemUuid, qty, cp }, user) => {
    const doc = getTile(tile);
    const cfg = cfgOf(doc);
    if (!user.isGM) {
      if (!cfg.deposit) throw new Error("Сюда нельзя ничего класть.");
      if (isShut(cfg)) throw new Error(cfg.state === "locked" ? "Заперто." : "Контейнер закрыт.");
    }
    let items = cfg.items ?? [];
    let total = Number(cfg.cp) || 0;
    if (itemUuid) {
      const item = await fromUuid(itemUuid);
      if (!item) throw new Error("Предмет не найден.");
      if (!isPhysical(item)) throw new Error("Это нельзя положить.");
      const n = Math.max(1, Math.min(Number(qty) || 1, qtyOf(item) || 1));
      if (item.parent?.documentName === "Actor") {
        assertOwner(item.parent, user);
        items = addToList(items, item, n);
        await removeItemQty(item, n);
      } else {
        if (!user.isGM) throw new Error("Класть можно только свои предметы.");
        items = addToList(items, item, n);
      }
    }
    if (cp > 0) {
      if (actor) { const a = await getActor(actor, user); await pay(a, cp); }
      else if (!user.isGM) throw new Error("Нет персонажа.");
      total += Math.round(cp);
    }
    await saveCfg(doc, { items, cp: total });
    return true;
  });

  onRequest("ctGmEdit", async ({ tile, items, cp }, user) => {
    if (!user.isGM) throw new Error("Только мастер.");
    const doc = getTile(tile);
    const patch = {};
    if (items) patch.items = items;
    if (cp != null) patch.cp = Math.max(0, Math.round(cp));
    await saveCfg(doc, patch);
    return true;
  });

  onRequest("pileDrop", async ({ itemUuid, qty, x, y, sceneId }, user) => {
    const item = await fromUuid(itemUuid);
    if (!item) throw new Error("Предмет не найден.");
    if (!isPhysical(item)) throw new Error("Это нельзя бросить на карту.");
    const fromActor = item.parent?.documentName === "Actor";
    if (fromActor) assertOwner(item.parent, user);
    else if (!user.isGM) throw new Error("Бросать можно только свои предметы.");
    const scene = game.scenes.get(sceneId) ?? canvas.scene;
    const n = Math.max(1, Math.min(Number(qty) || 1, qtyOf(item)));

    // Бросили на существующую кучу — добавляем в неё.
    const existing = scene.tiles.find((t) => {
      const c = cfgOf(t);
      const r = tileRect(t);
      return c.enabled && c.kind === "pile" && x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height;
    });
    if (existing) {
      await saveCfg(existing, { items: addToList(cfgOf(existing).items, item, n) });
    } else {
      const size = scene.grid.size;
      const tl = canvas.grid.getTopLeftPoint ? canvas.grid.getTopLeftPoint({ x, y }) : { x: x - size / 2, y: y - size / 2 };
      await scene.createEmbeddedDocuments("Tile", [{
        texture: { src: item.img || setting("pileImage"), ...TOP_LEFT },
        x: tl.x, y: tl.y, width: size, height: size,
        flags: { [MODULE_ID]: { pt: { ...DEFAULTS, enabled: true, kind: "pile", name: item.name, deleteEmpty: setting("pileDeleteEmpty"), items: addToList([], item, n) } } }
      }]);
    }
    if (fromActor) await removeItemQty(item, n);
    return true;
  });
}

/* -------------------------------------------- */
/*  Взаимодействие (ПКМ)                         */
/* -------------------------------------------- */

export async function interactTile(tileDoc) {
  const cfg = cfgOf(tileDoc);
  if (!game.user.isGM && !inRange(tileRect(tileDoc), cfg.range)) return;

  if (game.user.isGM) return ContainerApp.open(tileDoc);

  // Заперто может быть что угодно: сундук, бочка, сумка или куча лута.
  if (cfg.state === "locked") {
    playSound(soundsOf(cfg).locked, false);
    const actor = playerActor();
    if (!actor) return ui.notifications.warn("Выберите своего персонажа.");
    return new LockpickApp(tileDoc, actor).render(true);
  }
  if (cfg.kind === "pile") return ContainerApp.open(tileDoc);
  if (cfg.state === "closed") {
    const r = await gmTry("ctState", { tile: tileDoc.uuid, state: "open" });
    if (!r) return;
  }
  ContainerApp.open(tileDoc);
}

/* -------------------------------------------- */
/*  Окно содержимого                             */
/* -------------------------------------------- */

export class ContainerApp extends RppApp {
  static instances = new Map();

  static open(tileDoc) {
    const ex = this.instances.get(tileDoc.uuid);
    if (ex) { ex.render(true); ex.bringToFront?.(); return ex; }
    const app = new this(tileDoc);
    this.instances.set(tileDoc.uuid, app);
    app.render(true);
    return app;
  }

  static refresh(tileDoc) {
    const app = this.instances.get(tileDoc.uuid);
    if (!app) return;
    if (!isContainer(tileDoc) || (!game.user.isGM && isShut(cfgOf(tileDoc)))) return app.close();
    app.render();
  }

  constructor(tileDoc, options = {}) {
    super(options);
    this.tile = tileDoc;
  }

  static DEFAULT_OPTIONS = {
    classes: ["rpp-window", "rpp-container"],
    window: { title: "Контейнер", icon: "fa-solid fa-box-open", resizable: true },
    position: { width: 400, height: "auto" },
    actions: {
      take: ContainerApp.#onTake,
      takeAll: ContainerApp.#onTakeAll,
      takeCoins: ContainerApp.#onTakeCoins,
      closeBox: ContainerApp.#onCloseBox,
      putCoins: ContainerApp.#onPutCoins,
      gmRemove: ContainerApp.#onGmRemove,
      gmCoins: ContainerApp.#onGmCoins,
      gmConfig: ContainerApp.#onGmConfig,
      gmState: ContainerApp.#onGmState
    }
  };

  get title() { return cfgOf(this.tile).name || "Контейнер"; }

  async close(options) {
    ContainerApp.instances.delete(this.tile.uuid);
    return super.close(options);
  }

  async _html() {
    const cfg = cfgOf(this.tile);
    const gm = game.user.isGM;
    const st = STATE[cfg.state];
    const slots = Math.max(cfg.items.length + (cfg.deposit || gm ? 2 : 0), 12);
    const cells = [];
    for (let i = 0; i < slots; i++) {
      const e = cfg.items[i];
      if (!e) { cells.push(`<div class="rpp-slot empty"></div>`); continue; }
      const q = qtyOf(e.data);
      cells.push(`
        <div class="rpp-slot" style="--rarity:${rarityColor(e.data.system?.rarity)}" data-action="take" data-key="${e.key}"
             data-tooltip="${esc(e.data.name)}${q > 1 ? ` ×${q}` : ""}<br><small>ЛКМ — взять, ПКМ — осмотреть</small>">
          <img src="${esc(e.data.img)}" alt="">
          ${q > 1 ? `<span class="rpp-qty-badge">${q}</span>` : ""}
          ${gm ? `<a class="rpp-slot-del" data-action="gmRemove" data-key="${e.key}" data-tooltip="Удалить"><i class="fa-solid fa-xmark"></i></a>` : ""}
        </div>`);
    }

    const coins = Number(cfg.cp) > 0
      ? `<div class="rpp-row"><span class="rpp-price big"><i class="fa-solid fa-coins"></i> ${esc(formatCp(cfg.cp))}</span>
           <button type="button" data-action="takeCoins"><i class="fa-solid fa-hand-holding-dollar"></i> Забрать монеты</button></div>`
      : "";

    const head = `
      <header class="rpp-head">
        <img class="rpp-head-img" src="${esc(this.tile.texture?.src)}" alt="">
        <div class="rpp-head-text">
          <h2>${esc(cfg.name)}</h2>
          <div class="rpp-sub">${cfg.kind === "pile" && cfg.state !== "locked" ? `<i class="fa-solid fa-sack"></i> Куча лута`
            : `<span style="color:${st.color}"><i class="${st.icon}"></i> ${st.label}</span>${gm && cfg.state === "locked" ? ` · Сл ${cfg.dc}` : ""}`}</div>
        </div>
        ${gm ? `<div class="rpp-head-tools">
          <a data-action="gmState" data-state="locked" data-tooltip="Запереть"><i class="fa-solid fa-lock"></i></a>
          ${cfg.kind !== "pile" ? `<a data-action="gmState" data-state="closed" data-tooltip="Закрыть"><i class="fa-solid fa-box"></i></a>` : ""}
          <a data-action="gmState" data-state="open" data-tooltip="${cfg.kind === "pile" ? "Отпереть" : "Открыть"}"><i class="fa-solid fa-box-open"></i></a>
          <a data-action="gmConfig" data-tooltip="Настроить"><i class="fa-solid fa-gear"></i></a></div>` : ""}
      </header>`;

    const canPut = gm || cfg.deposit;
    const gmCoins = gm ? `
      <section class="rpp-section"><h3><i class="fa-solid fa-coins"></i> Монеты внутри (мастер)</h3>
        <div class="rpp-coins-edit">${coinInputsHTML(goldOnly() ? { __cp: cfg.cp } : {})}</div>
        <div class="rpp-row"><span class="rpp-muted">${goldOnly() ? "" : "Введите монеты — они сложатся в сумму."}</span>
          <button type="button" data-action="gmCoins"><i class="fa-solid fa-floppy-disk"></i> Записать</button></div>
      </section>` : (canPut ? `
      <details class="rpp-section rpp-put-coins"><summary><i class="fa-solid fa-coins"></i> Положить монеты</summary>
        <div class="rpp-coins-edit">${coinInputsHTML({})}</div>
        <div class="rpp-row"><span></span><button type="button" data-action="putCoins"><i class="fa-solid fa-arrow-down"></i> Положить</button></div>
      </details>` : "");

    return `
      ${head}
      <div class="rpp-grid rpp-drop" data-tooltip-direction="UP">${cells.join("")}</div>
      ${canPut ? `<p class="rpp-hint"><i class="fa-solid fa-hand-holding-hand"></i> Перетащите сюда предмет из инвентаря, чтобы положить.</p>` : ""}
      ${coins}
      ${gmCoins}
      <footer class="rpp-footer">
        ${cfg.kind !== "pile" && !gm ? `<button type="button" data-action="closeBox"><i class="fa-solid fa-box"></i> Закрыть</button>` : ""}
        <button type="button" class="rpp-confirm" data-action="takeAll" ${isEmpty(cfg) ? "disabled" : ""}><i class="fa-solid fa-hands"></i> Взять всё</button>
      </footer>`;
  }

  _bind(content) {
    RppApp.dropZone(content.querySelector(".rpp-drop"), (data) => this.#onDrop(data));
    for (const el of content.querySelectorAll(".rpp-slot[data-key]")) {
      el.addEventListener("contextmenu", (ev) => {
        ev.preventDefault();
        const e = cfgOf(this.tile).items.find((x) => x.key === el.dataset.key);
        if (e) inspectData(e.data);
      });
    }
  }

  #actorOrWarn() {
    const a = playerActor();
    if (!a) ui.notifications.warn(game.user.isGM ? "Выделите токен персонажа, которому отдать предмет." : "Выберите своего персонажа.");
    return a;
  }

  async #onDrop(data) {
    if (data.type !== "Item" || !data.uuid) return ui.notifications.warn("Сюда можно положить только предмет.");
    const item = await fromUuid(data.uuid);
    if (!item) return;
    const qty = await askQuantity(qtyOf(item), "Положить", item.name);
    if (!qty) return;
    const actor = item.parent?.documentName === "Actor" ? item.parent.uuid : null;
    await gmTry("ctPut", { tile: this.tile.uuid, actor, itemUuid: item.uuid, qty });
  }

  static async #onTake(event, target) {
    if (event.target.closest(".rpp-slot-del")) return;
    const a = this.#actorOrWarn(); if (!a) return;
    const e = cfgOf(this.tile).items.find((x) => x.key === target.dataset.key);
    if (!e) return;
    const qty = event.shiftKey ? qtyOf(e.data) : await askQuantity(qtyOf(e.data), "Взять", e.data.name);
    if (!qty) return;
    await gmTry("ctTake", { tile: this.tile.uuid, actor: a.uuid, key: e.key, qty });
  }

  static async #onTakeAll() {
    const a = this.#actorOrWarn(); if (!a) return;
    const r = await gmTry("ctTake", { tile: this.tile.uuid, actor: a.uuid, all: true });
    if (r?.taken?.length) ui.notifications.info(`Получено: ${r.taken.join(", ")}`);
  }

  static async #onTakeCoins() {
    const a = this.#actorOrWarn(); if (!a) return;
    await gmTry("ctTake", { tile: this.tile.uuid, actor: a.uuid, coins: true });
  }

  static async #onPutCoins() {
    const a = this.#actorOrWarn(); if (!a) return;
    const vals = readCoinInputs(this.element);
    const cp = vals.__cp ?? coinsCp(vals);
    if (!cp) return;
    if (walletCp(a) < cp) return ui.notifications.warn("Не хватает денег.");
    await gmTry("ctPut", { tile: this.tile.uuid, actor: a.uuid, cp });
  }

  static async #onCloseBox() {
    await gmTry("ctState", { tile: this.tile.uuid, state: "closed" });
    this.close();
  }

  static async #onGmRemove(event, target) {
    event.stopPropagation();
    const items = cfgOf(this.tile).items.filter((x) => x.key !== target.dataset.key);
    await gmTry("ctGmEdit", { tile: this.tile.uuid, items });
  }

  static async #onGmCoins() {
    const vals = readCoinInputs(this.element);
    await gmTry("ctGmEdit", { tile: this.tile.uuid, cp: vals.__cp ?? coinsCp(vals) });
  }

  static #onGmConfig() { new ContainerConfigApp(this.tile).render(true); }
  static async #onGmState(event, target) { await gmTry("ctState", { tile: this.tile.uuid, state: target.dataset.state }); }
}

/* -------------------------------------------- */
/*  Вскрытие замка                               */
/* -------------------------------------------- */

/** Названия из настроек функции «Взлом замков» (если она включена) — одна и та же отмычка работает и на дверях, и на сундуках */
function lockpickFeatureNames(key) {
  if (!game.rpgSuite?.isActive?.("lockpick")) return [];
  try { return String(game.settings.get(MODULE_ID, `lp-${key}`) || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean); }
  catch { return []; }
}

function findLockTools(actor) {
  const toolNames = lockpickFeatureNames("toolNames");
  const isThief = (i) => i.type === "tool" && (
    i.system?.type?.baseItem === "thief" || i.system?.baseItem === "thief" || /вор|thie/i.test(i.name)
    || toolNames.some((n) => i.name.toLowerCase().includes(n)));
  const names = [...new Set([
    ...String(setting("lockpickNames") || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
    ...lockpickFeatureNames("lockpickNames")
  ])];
  const tools = actor.items.filter(isThief);
  const picks = actor.items.filter((i) => !isThief(i) && names.some((n) => i.name.toLowerCase().includes(n)) && qtyOf(i) > 0);
  return { tools, picks };
}

function lockBonus(actor, toolItem) {
  const dex = Number(actor.system?.abilities?.dex?.mod) || 0;
  const prof = Number(actor.system?.attributes?.prof) || 0;
  const mult = Math.max(Number(actor.system?.tools?.thief?.value) || 0, Number(toolItem?.system?.proficient) || 0);
  return { dex, profPart: Math.floor(prof * mult), total: dex + Math.floor(prof * mult) };
}

/** Без инструментов замок можно попробовать выломать: проверка Силы (Атлетика). */
const FORCE_OPTION = { v: "force:", item: { name: "Выломать силой", img: "icons/skills/melee/unarmed-punch-fist.webp" }, note: "Сила (Атлетика), без инструментов" };

function forceBonus(actor) {
  const ath = actor.system?.skills?.ath;
  const str = Number(actor.system?.abilities?.str?.mod) || 0;
  const total = Number.isFinite(Number(ath?.total)) ? Number(ath.total) : (Number(ath?.mod) || str);
  return { dex: str, profPart: total - str, total };
}

export class LockpickApp extends RppApp {
  constructor(tileDoc, actor, options = {}) {
    super(options);
    this.tile = tileDoc;
    this.actor = actor;
    const { tools, picks } = findLockTools(actor);
    this.tools = tools; this.picks = picks;
    this.choice = tools.length ? `tool:${tools[0].id}` : (picks.length ? `pick:${picks[0].id}` : FORCE_OPTION.v);
    this.result = null;
  }

  static DEFAULT_OPTIONS = {
    classes: ["rpp-window", "rpp-lockpick"],
    window: { title: "Заперто", icon: "fa-solid fa-lock", resizable: false },
    position: { width: 380, height: "auto" },
    actions: { roll: LockpickApp.#onRoll, cancel: LockpickApp.#onCancel }
  };

  async _html() {
    const cfg = cfgOf(this.tile);
    const head = `
      <div class="rpp-frame-top">
        <img class="rpp-frame-icon" src="${esc(this.tile.texture?.src)}" alt="">
        <div class="rpp-frame-info">
          <div class="rpp-frame-name">${esc(cfg.name)}</div>
          <div class="rpp-frame-meta"><i class="fa-solid fa-lock"></i> Заперто${cfg.showDC ? ` · Сл ${cfg.dc}` : ""}</div>
          <div class="rpp-frame-for">${esc(this.actor.name)} · Ловкость (воровские инструменты)</div>
        </div>
      </div>`;

    if (this.result) {
      const r = this.result;
      return `${head}
        <div class="rpp-result ${r.success ? "ok" : "bad"}">
          <i class="fa-solid ${r.success ? "fa-lock-open" : "fa-lock"}"></i>
          ${r.success ? "Замок вскрыт!" : "Не получилось."}
          ${r.broke ? `<div class="rpp-bad"><i class="fa-solid fa-heart-crack"></i> Отмычка сломалась</div>` : ""}
        </div>
        <footer class="rpp-footer"><button type="button" data-action="cancel">Закрыть</button></footer>`;
    }

    if (!this.choice) {
      return `${head}
        <p class="rpp-warn"><i class="fa-solid fa-triangle-exclamation"></i>
          Чтобы вскрыть замок, нужны <b>воровские инструменты</b> или <b>отмычки</b> в инвентаре.</p>
        <footer class="rpp-footer"><button type="button" data-action="cancel">Понятно</button></footer>`;
    }

    const opts = [
      ...this.tools.map((t) => ({ v: `tool:${t.id}`, item: t, note: "не ломаются" })),
      ...this.picks.map((p) => ({ v: `pick:${p.id}`, item: p, note: setting("lockpickBreak") ? `×${qtyOf(p)}, ломается при провале` : `×${qtyOf(p)}` })),
      FORCE_OPTION
    ];
    const cur = this.#current();
    const b = cur.kind === "force" ? forceBonus(this.actor) : lockBonus(this.actor, cur.kind === "tool" ? cur.item : null);
    const sign = (n) => (n >= 0 ? `+${n}` : `${n}`);

    return `${head}
      <ul class="rpp-tools">
        ${opts.map((o) => `
          <li><label>
            <input type="radio" name="tool" value="${o.v}" ${o.v === this.choice ? "checked" : ""}>
            <img src="${esc(o.item.img)}" alt=""> <span>${esc(o.item.name)}</span> <small>${esc(o.note)}</small>
          </label></li>`).join("")}
      </ul>
      <p class="rpp-formula">Бросок: <b>1d20 ${sign(b.total)}</b> <small>${cur.kind === "force" ? "(Сила · Атлетика)" : `(Лвк ${sign(b.dex)}${b.profPart ? `, владение ${sign(b.profPart)}` : ""})`}</small></p>
      <div class="rpp-roll-buttons">
        <button type="button" data-action="roll" data-mode="dis" class="rpp-dis"><i class="fa-solid fa-angles-down"></i> Помеха</button>
        <button type="button" data-action="roll" data-mode="normal" class="rpp-confirm"><i class="fa-solid fa-dice-d20"></i> Вскрыть</button>
        <button type="button" data-action="roll" data-mode="adv" class="rpp-adv"><i class="fa-solid fa-angles-up"></i> Преимущество</button>
      </div>`;
  }

  _bind(content) {
    for (const r of content.querySelectorAll("input[name=tool]")) {
      r.addEventListener("change", () => { this.choice = r.value; this.render(); });
    }
  }

  #current() {
    const [kind, id] = String(this.choice).split(":");
    if (kind === "force") return { kind, item: FORCE_OPTION.item };
    return { kind, item: this.actor.items.get(id) };
  }

  static async #onRoll(event, target) {
    const cur = this.#current();
    if (!cur.item) return ui.notifications.warn("Инструмент не найден.");
    const b = cur.kind === "force" ? forceBonus(this.actor) : lockBonus(this.actor, cur.kind === "tool" ? cur.item : null);
    const die = { adv: "2d20kh", dis: "2d20kl" }[target.dataset.mode] ?? "1d20";
    const roll = await new Roll(`${die} + ${b.total}`).evaluate();
    await roll.toMessage({
      speaker: ChatMessage.getSpeaker({ actor: this.actor }),
      flavor: `<i class="fa-solid fa-key"></i> Вскрытие замка: «${esc(cfgOf(this.tile).name)}» (${esc(cur.item.name)})`
    });
    const res = await gmTry("ctPick", {
      tile: this.tile.uuid, actor: this.actor.uuid, total: roll.total,
      tool: cur.kind, pickId: cur.kind === "pick" ? cur.item.id : null
    });
    if (!res) return;
    this.result = res;
    this.render();
    if (res.success) setTimeout(() => { this.close(); ContainerApp.open(this.tile); }, 900);
  }

  static #onCancel() { this.close(); }
}

/* -------------------------------------------- */
/*  Настройка контейнера (мастер)               */
/* -------------------------------------------- */

function browse(type, current, cb) {
  const FP = foundry.applications?.apps?.FilePicker?.implementation ?? globalThis.FilePicker;
  const fp = new FP({ type, current, callback: cb });
  return fp.browse ? fp.browse() : fp.render(true);
}

export class ContainerConfigApp extends RppApp {
  constructor(tileDoc, options = {}) {
    super(options);
    this.tile = tileDoc;
  }

  static DEFAULT_OPTIONS = {
    classes: ["rpp-window", "rpp-config"],
    tag: "form",
    window: { title: "Настройка контейнера", icon: "fa-solid fa-box", resizable: true },
    position: { width: 520, height: "auto" },
    form: { handler: ContainerConfigApp.#onSubmit, closeOnSubmit: true },
    actions: { pick: ContainerConfigApp.#onPick, contents: ContainerConfigApp.#onContents, disable: ContainerConfigApp.#onDisable }
  };

  async _html() {
    const c = cfgOf(this.tile);
    if (!c.imgClosed && c.kind !== "pile") c.imgClosed = this.tile.texture?.src ?? "";
    const field = (label, input, hint = "") => `
      <div class="rpp-field"><label>${label}</label><div class="rpp-input">${input}</div>${hint ? `<p class="hint">${hint}</p>` : ""}</div>`;
    const file = (name, type, val) => `<div class="rpp-file"><input type="text" name="${name}" value="${esc(val)}">
      <button type="button" data-action="pick" data-target="${name}" data-type="${type}"><i class="fa-solid fa-file-import"></i></button></div>`;
    const sel = (name, val, opts) => `<select name="${name}">${Object.entries(opts).map(([k, v]) =>
      `<option value="${k}" ${k === val ? "selected" : ""}>${v}</option>`).join("")}</select>`;
    const chk = (name, val) => `<input type="checkbox" name="${name}" ${val ? "checked" : ""}>`;

    return `
      <section class="rpp-section"><h3><i class="fa-solid fa-box"></i> Основное</h3>
        <div class="rpp-fields">
          ${field("Название", `<input type="text" name="name" value="${esc(c.name)}">`)}
          ${field("Тип", sel("kind", c.kind, { container: "Контейнер (сундук, бочка…)", pile: "Куча лута" }))}
          ${field("Состояние", sel("state", c.state, { locked: "Заперт", closed: "Закрыт", open: "Открыт" }), "Кучу лута (сумку, мешок) тоже можно запереть — тогда её придётся вскрыть.")}
          ${field("Сложность замка (Сл)", `<input type="number" name="dc" min="1" max="40" value="${c.dc}">`)}
          ${field("Показывать Сл игрокам", chk("showDC", c.showDC))}
          ${field("Игроки могут класть предметы", chk("deposit", c.deposit))}
          ${field("Удалять, когда пусто", chk("deleteEmpty", c.deleteEmpty), "Только для кучи лута.")}
          ${field("Дистанция (клеток)", `<input type="number" name="range" min="0" step="0.5" value="${c.range ?? ""}" placeholder="${setting("interactRange")}">`, "Пусто — как в общих настройках. 0 — без ограничения.")}
        </div>
      </section>
      <section class="rpp-section"><h3><i class="fa-solid fa-image"></i> Картинки</h3>
        <div class="rpp-fields">
          ${field("Закрыт / заперт", file("imgClosed", "image", c.imgClosed))}
          ${field("Открыт", file("imgOpen", "image", c.imgOpen))}
          ${field("Открыт и пуст", file("imgEmpty", "image", c.imgEmpty))}
        </div>
      </section>
      <section class="rpp-section"><h3><i class="fa-solid fa-volume-high"></i> Звуки</h3>
        <p class="rpp-hint">Пусто — стандартные звуки деревянной двери из Foundry.</p>
        <div class="rpp-fields">
          ${field("Открытие", file("soundOpen", "audio", c.soundOpen))}
          ${field("Закрытие", file("soundClose", "audio", c.soundClose))}
          ${field("Заперто (дёрнули)", file("soundLocked", "audio", c.soundLocked))}
          ${field("Замок вскрыт", file("soundUnlock", "audio", c.soundUnlock))}
        </div>
      </section>
      <footer class="rpp-footer">
        ${c.enabled ? `<button type="button" data-action="disable"><i class="fa-solid fa-ban"></i> Сделать обычным тайлом</button>` : ""}
        <button type="button" data-action="contents"><i class="fa-solid fa-box-open"></i> Содержимое</button>
        <button type="submit" class="rpp-confirm"><i class="fa-solid fa-floppy-disk"></i> Сохранить</button>
      </footer>`;
  }

  static async #onSubmit(event, form, formData) {
    const d = formData.object;
    const patch = {
      enabled: true, name: d.name || "Сундук", kind: d.kind, state: d.state, dc: Number(d.dc) || 15,
      showDC: !!d.showDC, deposit: !!d.deposit, deleteEmpty: !!d.deleteEmpty,
      range: d.range === "" || d.range == null ? null : Number(d.range),
      imgClosed: d.imgClosed, imgOpen: d.imgOpen, imgEmpty: d.imgEmpty,
      soundOpen: d.soundOpen, soundClose: d.soundClose, soundLocked: d.soundLocked, soundUnlock: d.soundUnlock
    };
    await saveCfg(this.tile, patch);
    ContainerApp.refresh(this.tile);
  }

  static #onPick(event, target) {
    const input = this.element.querySelector(`input[name="${target.dataset.target}"]`);
    browse(target.dataset.type, input.value, (path) => { input.value = path; });
  }

  static async #onContents() {
    if (!isContainer(this.tile)) await saveCfg(this.tile, { enabled: true, imgClosed: this.tile.texture?.src ?? "" });
    ContainerApp.open(this.tile);
  }

  static async #onDisable() {
    await this.tile.update({ [`flags.${MODULE_ID}.-=pt`]: null });
    this.close();
  }
}

/* -------------------------------------------- */
/*  Создание: инструмент «Сундук», токен → куча  */
/* -------------------------------------------- */

export async function createChestAtCenter() {
  const size = canvas.grid.size;
  const c = canvas.stage.pivot;
  const tl = canvas.grid.getTopLeftPoint ? canvas.grid.getTopLeftPoint({ x: c.x, y: c.y }) : { x: c.x, y: c.y };
  const [tile] = await canvas.scene.createEmbeddedDocuments("Tile", [{
    texture: { src: setting("chestImage"), ...TOP_LEFT }, x: tl.x, y: tl.y, width: size, height: size,
    flags: { [MODULE_ID]: { pt: { ...DEFAULTS, enabled: true, imgClosed: setting("chestImage") } } }
  }]);
  if (tile) new ContainerConfigApp(tile).render(true);
}

export async function tokenToPile(tokenDoc) {
  const actor = tokenDoc.actor;
  if (!actor) return;
  const items = actor.items.filter((i) => isPhysical(i) && qtyOf(i) > 0);
  const cp = walletCp(actor);
  const res = await DialogV2.prompt({
    window: { title: "Превратить в кучу лута", icon: "fa-solid fa-sack" },
    classes: ["rpp-dialog"],
    content: `<p>Из «<b>${esc(actor.name)}</b>» получится куча: предметов <b>${items.length}</b>, монет <b>${esc(formatCp(cp))}</b>.</p>
      <label class="rpp-check"><input type="checkbox" name="strip" checked> Убрать предметы и монеты у персонажа</label>
      <label class="rpp-check"><input type="checkbox" name="del"> Удалить токен</label>`,
    ok: { label: "Создать", icon: "fa-solid fa-check",
      callback: (e, btn) => ({ strip: btn.form.elements.strip.checked, del: btn.form.elements.del.checked }) },
    rejectClose: false
  });
  if (!res) return;
  let list = [];
  for (const i of items) list = addToList(list, i, qtyOf(i));
  const w = tokenDoc.width * canvas.grid.size, h = tokenDoc.height * canvas.grid.size;
  await canvas.scene.createEmbeddedDocuments("Tile", [{
    texture: { src: setting("pileImage"), ...TOP_LEFT }, x: tokenDoc.x, y: tokenDoc.y, width: w, height: h,
    flags: { [MODULE_ID]: { pt: { ...DEFAULTS, enabled: true, kind: "pile", name: `Добыча: ${actor.name}`,
      deleteEmpty: setting("pileDeleteEmpty"), items: list, cp } } }
  }]);
  if (res.strip) {
    await actor.deleteEmbeddedDocuments("Item", items.map((i) => i.id));
    if (cp) await pay(actor, cp);
  }
  if (res.del) await tokenDoc.delete();
}

/** Обработчик броска предмета на карту. Возвращает false, если событие обработано. */
export function onDropCanvas(cnv, data) {
  if (data?.type !== "Item" || !data.uuid) return;
  // Ячейки «Панели мастера» и UI-интерфейса — это ярлыки, а не сами предметы: на карту их не бросаем
  if (data.rpgtGmb || data.bg3hud || data.bg3custom) return;
  if (!game.user.isGM && !setting("pileDrop")) return;
  (async () => {
    const item = await fromUuid(data.uuid);
    if (!item || !isPhysical(item)) return;
    const fromActor = item.parent?.documentName === "Actor";
    if (!fromActor && !game.user.isGM) return;
    const qty = await askQuantity(qtyOf(item), "Бросить на землю", item.name);
    if (!qty) return;
    await gmTry("pileDrop", { itemUuid: item.uuid, qty, x: data.x, y: data.y, sceneId: canvas.scene.id });
  })();
  return false;
}

export { cleanItemData };
