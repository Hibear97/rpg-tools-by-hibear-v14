/**
 * Piles tool — общие помощники: константы, настройки, сокет «через мастера», работа с предметами.
 */
import { SUITE_ID } from "../../core/constants.js";
import { suiteSocket } from "../../core/socket.js";

/** Функция «Сундуки, торговцы и обмен» (бывший Piles tool) внутри RPG-Tools.
 *  Настройки: "rpg-tools-by-hibear.pt-*", флаги тайлов/актёров/предметов: flags["rpg-tools-by-hibear"].pt.*, сокет: suiteSocket "piles". */
export const MODULE_ID = SUITE_ID;
export const FEATURE = "piles";
export const MODULE_TITLE = "Сундуки, торговцы и обмен";

export const { ApplicationV2, DialogV2 } = foundry.applications.api;

export const esc = (s) => Handlebars.escapeExpression(String(s ?? ""));
export const setting = (key) => game.settings.get(MODULE_ID, `pt-${key}`);

/** Типы предметов, которые можно класть, продавать и передавать. */
export const PHYSICAL_TYPES = ["weapon", "equipment", "consumable", "tool", "loot", "container", "backpack"];
/** Типы, которые складываются в стопку при передаче. */
const STACKABLE_TYPES = ["consumable", "loot"];

export const RARITY = {
  common:    { label: "Обычный",      color: "#ffffff" },
  uncommon:  { label: "Необычный",    color: "#1eff00" },
  rare:      { label: "Редкий",       color: "#0070dd" },
  veryRare:  { label: "Очень редкий", color: "#a335ee" },
  legendary: { label: "Легендарный",  color: "#ff8000" },
  artifact:  { label: "Артефакт",     color: "#e6cc80" }
};
export const rarityColor = (r) => RARITY[r]?.color ?? "#9d9d9d";

export function getDragData(event) {
  const TE = foundry.applications?.ux?.TextEditor?.implementation ?? globalThis.TextEditor;
  try { return TE.getDragEventData(event); } catch { return null; }
}

export function playSound(src, everyone = true) {
  if (!src) return;
  const AH = foundry.audio?.AudioHelper ?? globalThis.AudioHelper;
  try { AH.play({ src, volume: 0.8, autoplay: true, loop: false }, everyone); } catch (e) { console.warn(MODULE_ID, e); }
}

/** Стандартные звуки двери из ядра Foundry (используются, если у контейнера свои не заданы). */
export function defaultSounds() {
  const set = CONFIG.Wall?.doorSounds?.woodBasic ?? Object.values(CONFIG.Wall?.doorSounds ?? {})[0] ?? {};
  return { open: set.open, close: set.close, locked: set.test, unlock: set.unlock, lock: set.lock };
}

/* -------------------------------------------- */
/*  Базовое окно (как в RPG-Tools)              */
/* -------------------------------------------- */

export class RppApp extends ApplicationV2 {
  /** Возвращает HTML окна. Переопределяется. */
  async _html() { return ""; }
  async _renderHTML() { return this._html(); }
  _replaceHTML(result, content) {
    content.innerHTML = result;
    this._bind(content);
  }
  /** Навесить обработчики после отрисовки. */
  _bind(content) {}

  /** Сделать элемент зоной сброса предметов. */
  static dropZone(el, onDrop) {
    if (!el) return;
    el.addEventListener("dragover", (ev) => { ev.preventDefault(); el.classList.add("hover"); });
    el.addEventListener("dragleave", () => el.classList.remove("hover"));
    el.addEventListener("drop", (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      el.classList.remove("hover");
      const data = getDragData(ev);
      if (data) onDrop(data, ev);
    });
  }
}

/** Спросить количество (если в стопке больше одного). */
export async function askQuantity(max, title = "Сколько?", label = "Количество") {
  max = Math.max(1, Math.floor(Number(max) || 1));
  if (max === 1) return 1;
  const res = await DialogV2.prompt({
    window: { title, icon: "fa-solid fa-layer-group" },
    classes: ["rpp-dialog"],
    content: `<div class="rpp-qty">
        <label>${esc(label)} (1–${max})</label>
        <input type="number" name="qty" min="1" max="${max}" step="1" value="${max}" autofocus>
      </div>`,
    ok: { label: "Готово", icon: "fa-solid fa-check", callback: (event, button) => button.form.elements.qty.valueAsNumber },
    rejectClose: false
  });
  if (!res || res < 1) return null;
  return Math.min(max, Math.floor(res));
}

/* -------------------------------------------- */
/*  Предметы                                    */
/* -------------------------------------------- */

export const qtyOf = (data) => Math.max(0, Number(data?.system?.quantity ?? 1));
export const isPhysical = (item) => PHYSICAL_TYPES.includes(item?.type);

/** Подготовить данные предмета для хранения/передачи. */
export function cleanItemData(itemOrData, qty) {
  const data = itemOrData?.toObject ? itemOrData.toObject() : foundry.utils.deepClone(itemOrData);
  delete data._id;
  delete data.folder;
  delete data.sort;
  delete data.ownership;
  data.system ??= {};
  if (qty != null) data.system.quantity = qty;
  if ("container" in data.system) data.system.container = null;
  if ("equipped" in data.system) data.system.equipped = false;
  if ("attuned" in data.system) data.system.attuned = false;
  return data;
}

/** Добавить предмет актёру; стопки складываются. */
export async function giveItemData(actor, itemData, qty) {
  const data = cleanItemData(itemData, qty);
  if (STACKABLE_TYPES.includes(data.type)) {
    const same = actor.items.find((i) => i.type === data.type && i.name === data.name && !i.system?.container);
    if (same) {
      await same.update({ "system.quantity": qtyOf(same) + qty });
      return same;
    }
  }
  const [created] = await actor.createEmbeddedDocuments("Item", [data]);
  return created;
}

/** Убрать qty штук предмета у актёра. */
export async function removeItemQty(item, qty) {
  const have = qtyOf(item);
  if (qty >= have) await item.delete();
  else await item.update({ "system.quantity": have - qty });
}

/** Добавить данные предмета в список (стопки складываются). Возвращает новый список. */
export function addToList(list, itemData, qty) {
  list = foundry.utils.deepClone(list ?? []);
  const data = cleanItemData(itemData, qty);
  const same = STACKABLE_TYPES.includes(data.type)
    && list.find((e) => e.data.type === data.type && e.data.name === data.name);
  if (same) same.data.system.quantity = qtyOf(same.data) + qty;
  else list.push({ key: foundry.utils.randomID(), data });
  return list;
}

/** Показать предмет из сохранённых данных (временный документ, только просмотр). */
export function inspectData(data) {
  try {
    const Cls = CONFIG.Item.documentClass;
    const tmp = new Cls(foundry.utils.deepClone(data));
    tmp.sheet.render(true, { editable: false });
  } catch (e) {
    console.warn(MODULE_ID, e);
    ui.notifications.info(data?.name ?? "Предмет");
  }
}

/* -------------------------------------------- */
/*  Игрок, его персонаж и токен                 */
/* -------------------------------------------- */

/** Персонаж игрока: выделенный токен, иначе назначенный персонаж. */
export function playerActor() {
  const t = canvas?.tokens?.controlled?.find((x) => x.actor?.isOwner);
  return t?.actor ?? game.user.character ?? null;
}

/** Токен игрока на текущей сцене. */
export function playerToken() {
  const ctrl = canvas?.tokens?.controlled?.find((x) => x.actor?.isOwner);
  if (ctrl) return ctrl;
  const ch = game.user.character;
  if (!ch) return null;
  return canvas.tokens.placeables.find((t) => t.actor?.id === ch.id) ?? null;
}

/** Расстояние (в клетках) от токена до прямоугольника. */
export function cellsTo(token, rect) {
  const c = token.center;
  const nx = Math.max(rect.x, Math.min(c.x, rect.x + rect.width));
  const ny = Math.max(rect.y, Math.min(c.y, rect.y + rect.height));
  const px = Math.hypot(c.x - nx, c.y - ny);
  const half = Math.min(token.w, token.h) / 2;
  return Math.max(0, px - half) / (canvas.grid.size || 100);
}

/** Проверка дистанции для игрока. Мастер всегда «рядом». */
export function inRange(rect, range) {
  if (game.user.isGM) return true;
  const tok = playerToken();
  if (!tok) { ui.notifications.warn("Нужен токен вашего персонажа на этой сцене."); return false; }
  const r = Number(range ?? setting("interactRange")) || 0;
  if (r <= 0) return true;
  if (cellsTo(tok, rect) > r + 0.01) {
    ui.notifications.warn("Слишком далеко — подойдите ближе.");
    return false;
  }
  return true;
}

/** Активный игрок-владелец персонажа (не мастер). */
export function ownerUserOf(actor) {
  return game.users.find((u) => !u.isGM && u.active && u.character?.id === actor.id)
    ?? game.users.find((u) => !u.isGM && u.active && actor.testUserPermission(u, "OWNER"))
    ?? null;
}

/* -------------------------------------------- */
/*  Сокет: всё, что меняет документы, делает мастер */
/* -------------------------------------------- */

const handlers = new Map();      // action -> async (data, user) => result
const events = new Map();        // event -> [fn(data)]
const pending = new Map();

export const isMainGM = () => game.user.isGM && (game.users.activeGM ? game.users.activeGM.id === game.user.id : true);

export function onRequest(action, fn) { handlers.set(action, fn); }
export function onEvent(name, fn) {
  if (!events.has(name)) events.set(name, []);
  events.get(name).push(fn);
}

function fireEvent(name, data) {
  for (const fn of events.get(name) ?? []) {
    try { fn(data); } catch (e) { console.error(`${MODULE_ID} | event ${name}`, e); }
  }
}

/** Отправить событие пользователям (to — список id; пусто = всем). */
export function emitEvent(name, data, to = null) {
  suiteSocket.emit(FEATURE, { t: "evt", name, data, to });
  if (!to || to.includes(game.user.id)) fireEvent(name, data);
}

async function runHandler(action, data, userId) {
  const fn = handlers.get(action);
  if (!fn) throw new Error(`Неизвестное действие: ${action}`);
  return fn(data, game.users.get(userId));
}

/** Попросить мастера выполнить действие. Возвращает результат или бросает ошибку с текстом. */
export async function gmRequest(action, data = {}) {
  if (isMainGM()) return runHandler(action, data, game.user.id);
  if (!game.users.activeGM) {
    const msg = "Нужен мастер в сети — без него это действие выполнить нельзя.";
    ui.notifications.warn(msg);
    throw new Error(msg);
  }
  const id = foundry.utils.randomID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("Мастер не ответил.")); }, 20000);
    pending.set(id, { resolve, reject, timer });
    suiteSocket.emit(FEATURE, { t: "req", id, from: game.user.id, action, data });
  });
}

/** То же, но ошибки показываются уведомлением и возвращается null. */
export async function gmTry(action, data) {
  try { return await gmRequest(action, data); }
  catch (e) { ui.notifications.warn(e.message ?? String(e)); return null; }
}

export function initSocket() {
  suiteSocket.on(FEATURE, async (msg) => {
    if (!msg || typeof msg !== "object") return;
    if (msg.t === "req") {
      if (!isMainGM()) return;
      let res;
      try { res = { ok: true, result: await runHandler(msg.action, msg.data, msg.from) }; }
      catch (e) { console.warn(`${MODULE_ID} | ${msg.action}`, e); res = { ok: false, error: e.message ?? String(e) }; }
      suiteSocket.emit(FEATURE, { t: "res", id: msg.id, to: msg.from, ...res });
    } else if (msg.t === "res") {
      if (msg.to !== game.user.id) return;
      const p = pending.get(msg.id);
      if (!p) return;
      clearTimeout(p.timer);
      pending.delete(msg.id);
      msg.ok ? p.resolve(msg.result) : p.reject(new Error(msg.error));
    } else if (msg.t === "evt") {
      if (msg.to && !msg.to.includes(game.user.id)) return;
      fireEvent(msg.name, msg.data);
    }
  });
}

/** Проверка: пользователь владеет документом. */
export function assertOwner(doc, user) {
  if (!doc) throw new Error("Документ не найден.");
  if (user?.isGM) return;
  if (!doc.testUserPermission(user, "OWNER")) throw new Error("Нет прав на этот предмет или персонажа.");
}

/** Короткое сообщение в чат. */
export async function chat(content, { whisper = null, alias = "Добыча" } = {}) {
  return ChatMessage.create({
    speaker: { alias },
    content: `<div class="rpp-chat">${content}</div>`,
    whisper: whisper ?? undefined
  });
}
