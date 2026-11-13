/**
 * Lockpicking Tool (lockpicking-tool) — Foundry VTT v12/v13, dnd5e.
 *
 * Игрок подходит токеном к запертой двери или запертому сундуку Item Piles,
 * жмёт ПКМ по значку замка (или по сундуку) и выбирает способ:
 *   • Воровские инструменты — проверка инструмента (Ловкость + владение);
 *   • Отмычка — проверка Ловкости;
 *   • Выломать — проверка Силы или Силы (Атлетики).
 * Успешный взлом отпирает замок, успешное выламывание удаляет стену-дверь
 * (или открывает её, если так выбрано в настройках) / отпирает сундук.
 * Все изменения сцены выполняет ГМ через сокет.
 */

import { SUITE_ID } from "../../core/constants.js";
import { suiteSocket } from "../../core/socket.js";
import { createFeatureHooks } from "../../core/feature-hooks.js";

/** Функция «Взлом замков» внутри RPG-Tools.
 *  Настройки: "rpg-tools-by-hibear.lp-*", флаги дверей и сундуков: flags["rpg-tools-by-hibear"].lp.*, сокет: suiteSocket "lockpick".
 *  libWrapper регистрируется под id модуля (под чужим id libWrapper отказывает). */
const MODULE_ID = SUITE_ID;
const FEATURE = "lockpick";
const Hooks = createFeatureHooks();

/** API для макросов: game.rpgSuite.api.lockpick.lockpickNearest() */
export const api = {};

export function setup() {
  Hooks.activate();
}

/* -------------------------------------------- */
/*  Утилиты                                     */
/* -------------------------------------------- */

const t = (key, data) =>
  data ? game.i18n.format(`HLP.${key}`, data) : game.i18n.localize(`HLP.${key}`);

const setting = (key) => game.settings.get(MODULE_ID, `lp-${key}`);

const DialogV2 = () => foundry.applications?.api?.DialogV2;

function getClass(paths) {
  for (const p of paths) {
    const obj = foundry.utils.getProperty(globalThis, p);
    if (obj) return { cls: obj, path: p };
  }
  return null;
}

/** Обёртка метода прототипа: через libWrapper, если он есть, иначе вручную. */
function wrapMethod(classPaths, method, wrapper) {
  const found = getClass(classPaths);
  if (!found) {
    console.warn(`${MODULE_ID} | Не найден класс для ${method}:`, classPaths);
    return;
  }
  const fullPath = `${found.path}.prototype.${method}`;
  if (game.modules.get("lib-wrapper")?.active && globalThis.libWrapper) {
    libWrapper.register(MODULE_ID, fullPath, wrapper, "MIXED");
    return;
  }
  const proto = found.cls.prototype;
  const original = proto[method];
  proto[method] = function (...args) {
    return wrapper.call(this, (...a) => original.apply(this, a), ...args);
  };
}

function splitNames(str) {
  return String(str ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function escapeHTML(s) {
  return foundry.utils.escapeHTML ? foundry.utils.escapeHTML(String(s)) : String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/* -------------------------------------------- */
/*  Настройки                                   */
/* -------------------------------------------- */

function registerSettings() {
  const reg = (key, data) =>
    game.settings.register(MODULE_ID, `lp-${key}`, {
      name: `HLP.Settings.${key}.Name`,
      hint: `HLP.Settings.${key}.Hint`,
      scope: "world",
      config: true,
      ...data
    });

  reg("maxDistance", { type: Number, default: 5 });
  reg("doorPickDC", { type: Number, default: 15 });
  reg("doorBreakDC", { type: Number, default: 17 });
  reg("chestPickDC", { type: Number, default: 15 });
  reg("chestBreakDC", { type: Number, default: 18 });
  reg("toolNames", { type: String, default: "Воровские инструменты, Thieves' Tools, Thieves Tools" });
  reg("lockpickNames", { type: String, default: "Отмычка, Отмычки, Lockpick, Lockpicks" });
  reg("allowBreak", { type: Boolean, default: true });
  reg("breakDoorAction", {
    type: String,
    default: "delete",
    choices: {
      delete: "HLP.Settings.breakDoorAction.delete",
      open: "HLP.Settings.breakDoorAction.open"
    }
  });
  reg("openAfterPick", { type: Boolean, default: false });
  reg("pickBreaks", {
    type: String,
    default: "nat1",
    choices: {
      never: "HLP.Settings.pickBreaks.never",
      nat1: "HLP.Settings.pickBreaks.nat1",
      fail: "HLP.Settings.pickBreaks.fail"
    }
  });
  reg("showDC", { type: Boolean, default: false });
}

/* -------------------------------------------- */
/*  Определение целей                           */
/* -------------------------------------------- */

const DOOR_STATES = () => CONST.WALL_DOOR_STATES;

function isLockedDoor(wall) {
  const doc = wall?.document ?? wall;
  return !!doc && doc.door > 0 && doc.ds === DOOR_STATES().LOCKED;
}

function ip() {
  return game.modules.get("item-piles")?.active ? game.itempiles?.API : null;
}

function isItemPile(tokenDoc) {
  const api = ip();
  if (!api || !tokenDoc) return false;
  try {
    return !!api.isValidItemPile(tokenDoc);
  } catch {
    return false;
  }
}

function isPileLocked(tokenDoc) {
  const api = ip();
  if (!api || !tokenDoc) return false;
  try {
    if (typeof api.isItemPileLocked === "function") return !!api.isItemPileLocked(tokenDoc);
  } catch { /* fallback ниже */ }
  return !!(
    foundry.utils.getProperty(tokenDoc, "flags.item-piles.data.locked") ??
    foundry.utils.getProperty(tokenDoc.actor ?? {}, "flags.item-piles.data.locked")
  );
}

/** Запертый сундук, который этот пользователь не может просто открыть. */
function isLockedPileForUser(token, user = game.user) {
  const doc = token?.document ?? token;
  if (!isItemPile(doc) || !isPileLocked(doc)) return false;
  if (user.isGM) return false;
  return true;
}

/** Токен, которым действует игрок: выделенный, иначе токен его персонажа на сцене. */
function getActingToken() {
  const controlled = canvas.tokens.controlled.filter((tk) => tk.actor?.isOwner && !isItemPile(tk.document));
  if (controlled.length) return controlled[0];
  const char = game.user.character;
  if (char) {
    const tk = char.getActiveTokens(false, false).find((t) => t.scene === canvas.scene || t.document?.parent === canvas.scene);
    if (tk) return tk;
  }
  return null;
}

/* -------------------------------------------- */
/*  Дистанция                                   */
/* -------------------------------------------- */

function maxGapInCells() {
  const cells = Math.max(1, setting("maxDistance") / canvas.dimensions.distance);
  // Соседняя клетка = зазор 0. Небольшой допуск на диагонали и концы стен.
  return cells - 1 + 0.3;
}

function distToSegment(px, py, [x0, y0, x1, y1]) {
  const dx = x1 - x0, dy = y1 - y0;
  const len2 = dx * dx + dy * dy;
  let tt = len2 ? ((px - x0) * dx + (py - y0) * dy) / len2 : 0;
  tt = Math.max(0, Math.min(1, tt));
  return Math.hypot(px - (x0 + tt * dx), py - (y0 + tt * dy));
}

function isNearDoor(token, wall) {
  const size = canvas.dimensions.size;
  const c = token.center;
  const gapPx = distToSegment(c.x, c.y, wall.document.c) - Math.min(token.w, token.h) / 2;
  return Math.max(0, gapPx) / size <= maxGapInCells();
}

function isNearToken(token, other) {
  const size = canvas.dimensions.size;
  const a = token.center, b = other.center;
  const dx = Math.max(0, Math.abs(a.x - b.x) - (token.w + other.w) / 2);
  const dy = Math.max(0, Math.abs(a.y - b.y) - (token.h + other.h) / 2);
  return Math.max(dx, dy) / size <= maxGapInCells();
}

/* -------------------------------------------- */
/*  Инструменты в инвентаре                     */
/* -------------------------------------------- */

function findThievesTools(actor) {
  const names = splitNames(setting("toolNames"));
  return actor.items.find((i) => {
    if (i.type !== "tool") return false;
    if (i.system?.type?.baseItem === "thief") return true;
    const n = i.name.toLowerCase();
    return names.some((x) => n.includes(x));
  }) ?? null;
}

function findLockpick(actor) {
  const names = splitNames(setting("lockpickNames"));
  return actor.items.find((i) => {
    if ((i.system?.quantity ?? 1) <= 0) return false;
    const n = i.name.toLowerCase();
    return names.some((x) => n.includes(x));
  }) ?? null;
}

/* -------------------------------------------- */
/*  Броски dnd5e (4.x/5.x с запасным вариантом) */
/* -------------------------------------------- */

const firstRoll = (res) => (Array.isArray(res) ? res[0] : res) ?? null;

function rollConfig(extra, dc) {
  const cfg = { ...extra };
  if (setting("showDC") && dc) cfg.target = dc;
  return cfg;
}

async function rollThievesTools(actor, tool, dc) {
  try {
    if (typeof actor.rollToolCheck === "function") {
      return firstRoll(await actor.rollToolCheck(rollConfig({ tool: "thief", ability: "dex" }, dc)));
    }
    if (typeof tool?.rollToolCheck === "function") return firstRoll(await tool.rollToolCheck());
  } catch (err) {
    console.warn(`${MODULE_ID} | rollToolCheck не сработал, бросаю Ловкость`, err);
  }
  return rollAbility(actor, "dex", dc);
}

async function rollAbility(actor, ability, dc) {
  if (typeof actor.rollAbilityCheck === "function") {
    return firstRoll(await actor.rollAbilityCheck(rollConfig({ ability }, dc)));
  }
  return firstRoll(await actor.rollAbilityTest(ability)); // dnd5e 3.x
}

async function rollSkill(actor, skill, dc) {
  if (foundry.utils.isNewerVersion(game.system.version, "3.99")) {
    return firstRoll(await actor.rollSkill(rollConfig({ skill }, dc)));
  }
  return firstRoll(await actor.rollSkill(skill)); // dnd5e 3.x
}

function isNat1(roll) {
  if (typeof roll?.isFumble === "boolean") return roll.isFumble;
  const d20 = roll?.dice?.[0];
  return d20?.faces === 20 && d20.total === 1;
}

/* -------------------------------------------- */
/*  Диалог взлома                               */
/* -------------------------------------------- */

/**
 * @param {object} target  { kind: "door"|"pile", wall?, token? }
 */
async function openLockpickDialog(target) {
  // Сундук функции «Сундуки, торговцы и обмен» — у него своё окно вскрытия (бросок, отмычки, содержимое)
  if (target?.kind === "tile") {
    const piles = game.rpgSuite?.isActive?.("piles") ? game.rpgSuite.api.piles : null;
    const doc = target.tile?.document ?? target.tile;
    if (!piles || !doc) return ui.notifications.warn(t("Warn.NotLocked"));
    return piles.interact(doc);
  }
  if (!target?.wall && !target?.token) return ui.notifications.warn(t("Warn.NothingNear"));
  const actorToken = getActingToken();
  if (!actorToken) return ui.notifications.warn(t("Warn.NoToken"));
  const actor = actorToken.actor;

  // Проверки цели
  const isDoor = target.kind === "door";
  const targetDoc = isDoor ? target.wall.document : target.token.document;
  const flags = targetDoc.flags?.[MODULE_ID]?.lp ?? {};

  if (isDoor ? !isLockedDoor(target.wall) : !isPileLocked(targetDoc)) {
    return ui.notifications.info(t("Warn.NotLocked"));
  }
  const near = isDoor ? isNearDoor(actorToken, target.wall) : isNearToken(actorToken, target.token);
  if (!near && !game.user.isGM) {
    return ui.notifications.warn(t("Warn.TooFar", { dist: setting("maxDistance"), units: canvas.dimensions.units || "" }));
  }

  const pickDC = Number(flags.pickDC) || setting(isDoor ? "doorPickDC" : "chestPickDC");
  const breakDC = Number(flags.breakDC) || setting(isDoor ? "doorBreakDC" : "chestBreakDC");
  const canPick = !flags.noPick;
  const canBreak = setting("allowBreak") && !flags.noBreak;

  const tools = findThievesTools(actor);
  const lockpick = tools ? null : findLockpick(actor);

  const buttons = [];
  if (canPick && tools) buttons.push({ action: "tools", icon: "fa-solid fa-screwdriver-wrench", label: t("Btn.Tools") });
  if (canPick && lockpick) buttons.push({ action: "lockpick", icon: "fa-solid fa-key", label: t("Btn.Lockpick") });
  if (canBreak) {
    buttons.push({ action: "str", icon: "fa-solid fa-hand-fist", label: t("Btn.BreakStr") });
    buttons.push({ action: "ath", icon: "fa-solid fa-person-running", label: t("Btn.BreakAth") });
  }
  buttons.push({ action: "cancel", icon: "fa-solid fa-xmark", label: t("Btn.Cancel") });

  const notes = [];
  if (canPick && !tools && !lockpick) notes.push(t("Dialog.NoTools"));
  if (!canPick) notes.push(t("Dialog.Unpickable"));
  if (!canBreak) notes.push(t("Dialog.Unbreakable"));
  const showDC = setting("showDC") || game.user.isGM;

  const name = isDoor ? t("Dialog.Door") : escapeHTML(target.token.document.name);
  const content = `
    <div class="hlp-dialog">
      <p class="hlp-target"><i class="fa-solid fa-lock"></i> <strong>${name}</strong></p>
      <p>${t("Dialog.Who", { name: escapeHTML(actor.name) })}</p>
      ${showDC ? `<p class="hlp-dc">${t("Dialog.DC", { pick: pickDC, brk: breakDC })}</p>` : ""}
      ${notes.map((n) => `<p class="hlp-note">${n}</p>`).join("")}
    </div>`;

  let choice;
  const D = DialogV2();
  if (D) {
    choice = await D.wait({
      window: { title: t("Dialog.Title"), icon: "fa-solid fa-lock" },
      classes: ["hlp-window"],
      content,
      buttons: buttons.map((b, i) => ({ ...b, default: i === 0 })),
      rejectClose: false
    });
  } else {
    choice = await new Promise((resolve) => {
      const btns = Object.fromEntries(buttons.map((b) => [b.action, {
        icon: `<i class="${b.icon}"></i>`, label: b.label, callback: () => resolve(b.action)
      }]));
      new Dialog({ title: t("Dialog.Title"), content, buttons: btns, close: () => resolve(null) }).render(true);
    });
  }
  if (!choice || choice === "cancel") return;

  // Бросок
  const isBreak = choice === "str" || choice === "ath";
  const dc = isBreak ? breakDC : pickDC;
  let roll;
  if (choice === "tools") roll = await rollThievesTools(actor, tools, dc);
  else if (choice === "lockpick") roll = await rollAbility(actor, "dex", dc);
  else if (choice === "str") roll = await rollAbility(actor, "str", dc);
  else if (choice === "ath") roll = await rollSkill(actor, "ath", dc);
  if (!roll) return; // бросок отменён

  const success = roll.total >= dc;

  // Отмычка ломается
  let pickBroke = false;
  if (choice === "lockpick" && lockpick && !success) {
    const mode = setting("pickBreaks");
    if (mode === "fail" || (mode === "nat1" && isNat1(roll))) {
      pickBroke = true;
      const qty = lockpick.system?.quantity ?? 1;
      if (qty > 1) await lockpick.update({ "system.quantity": qty - 1 });
      else await lockpick.delete();
    }
  }

  // Применяем результат (через ГМа)
  if (success) {
    const action = isDoor ? (isBreak ? "doorBreak" : "doorUnlock") : "pileUnlock";
    await requestGM(action, {
      sceneId: canvas.scene.id,
      wallId: isDoor ? targetDoc.id : null,
      tokenId: isDoor ? null : targetDoc.id,
      actorTokenId: actorToken.document.id
    });
  }

  await postResult({ actor, actorToken, choice, success, dc, roll, isDoor, name, pickBroke });
}

async function postResult({ actor, actorToken, choice, success, dc, roll, isDoor, name, pickBroke }) {
  const isBreak = choice === "str" || choice === "ath";
  let key;
  if (success) key = isBreak ? (isDoor && setting("breakDoorAction") === "delete" ? "Chat.BrokeDoor" : "Chat.BrokeOpen") : "Chat.Picked";
  else key = isBreak ? "Chat.BreakFail" : "Chat.PickFail";

  const method = t(`Method.${choice}`);
  const lines = [
    `<div class="hlp-chat ${success ? "success" : "failure"}">`,
    `<h3><i class="fa-solid ${success ? "fa-lock-open" : "fa-lock"}"></i> ${t(key, { name: escapeHTML(actor.name), target: name })}</h3>`,
    `<p>${method}: <strong>${roll.total}</strong>${setting("showDC") ? ` / ${t("Chat.DC")} ${dc}` : ""}</p>`,
    pickBroke ? `<p class="hlp-broke"><i class="fa-solid fa-heart-crack"></i> ${t("Chat.PickBroke")}</p>` : "",
    `</div>`
  ];
  await ChatMessage.create({
    content: lines.join(""),
    speaker: ChatMessage.getSpeaker({ token: actorToken.document, actor })
  });

  // ГМу шёпотом с КС, если игрокам он не показан
  if (!setting("showDC")) {
    const gmIds = game.users.filter((u) => u.isGM).map((u) => u.id);
    await ChatMessage.create({
      content: `<p class="hlp-gm">${t("Chat.GMInfo", { name: escapeHTML(actor.name), total: roll.total, dc })}</p>`,
      whisper: gmIds,
      speaker: { alias: t("Title") }
    });
  }
}

/* -------------------------------------------- */
/*  Сокет: изменения сцены делает ГМ            */
/* -------------------------------------------- */

function activeGM() {
  return game.users.activeGM ?? game.users.find((u) => u.isGM && u.active) ?? null;
}

async function requestGM(action, data) {
  if (game.user.isGM) return gmExecute(action, data);
  if (!activeGM()) {
    ui.notifications.error(t("Warn.NoGM"));
    return;
  }
  suiteSocket.emit(FEATURE, { action, data, userId: game.user.id });
}

async function gmExecute(action, { sceneId, wallId, tokenId, actorTokenId }) {
  const scene = game.scenes.get(sceneId);
  if (!scene) return;

  if (action === "doorUnlock" || action === "doorBreak") {
    const wall = scene.walls.get(wallId);
    if (!wall || wall.ds !== DOOR_STATES().LOCKED) return;
    if (action === "doorBreak" && setting("breakDoorAction") === "delete") {
      await wall.delete();
    } else {
      const open = action === "doorBreak" || setting("openAfterPick");
      await wall.update({ ds: open ? DOOR_STATES().OPEN : DOOR_STATES().CLOSED });
    }
    return;
  }

  if (action === "pileUnlock") {
    const tokenDoc = scene.tokens.get(tokenId);
    if (!tokenDoc) return;
    const interacting = scene.tokens.get(actorTokenId) ?? false;
    const api = ip();
    try {
      if (api?.unlockItemPile) await api.unlockItemPile(tokenDoc, interacting);
      else throw new Error("no API");
    } catch (err) {
      console.warn(`${MODULE_ID} | unlockItemPile недоступен, снимаю флаг напрямую`, err);
      await tokenDoc.update({ "flags.item-piles.data.locked": false });
    }
  }
}

function onSocket({ action, data }) {
  if (!game.user.isGM) return;
  if (activeGM()?.id !== game.user.id) return; // выполняет только один ГМ
  gmExecute(action, data);
}

/* -------------------------------------------- */
/*  Патчи: ПКМ по замку двери и по сундуку      */
/* -------------------------------------------- */

function patchCanvas() {
  // Дверь: ПКМ по значку замка
  wrapMethod(
    ["foundry.canvas.containers.DoorControl", "DoorControl"],
    "_onRightDown",
    function (wrapped, event) {
      const wall = this.wall;
      const gmTest = game.user.isGM && event?.shiftKey; // ГМ: Shift+ПКМ — протестировать взлом
      if (isLockedDoor(wall) && (!game.user.isGM || gmTest)) {
        event?.stopPropagation?.();
        openLockpickDialog({ kind: "door", wall });
        return;
      }
      return wrapped(event);
    }
  );

  // Сундук Item Piles: разрешаем ПКМ не-владельцу по запертому сундуку…
  const tokenPaths = ["foundry.canvas.placeables.Token", "Token"];
  wrapMethod(tokenPaths, "_canHUD", function (wrapped, user, event) {
    if (isLockedPileForUser(this, user) && this.layer?.active) return true;
    return wrapped(user, event);
  });
  // …и вместо HUD показываем окно взлома
  wrapMethod(tokenPaths, "_onClickRight", function (wrapped, event) {
    if (isLockedPileForUser(this)) {
      event?.stopPropagation?.();
      openLockpickDialog({ kind: "pile", token: this });
      return;
    }
    return wrapped(event);
  });
}

/* -------------------------------------------- */
/*  Поля КС в настройках стены и токена         */
/* -------------------------------------------- */

function injectFields(app, html, doc, isDoor) {
  const root = html instanceof HTMLElement ? html : html?.[0];
  if (!root || root.querySelector(".hlp-config")) return;
  const f = doc.flags?.[MODULE_ID]?.lp ?? {};
  const n = (k) => `flags.${MODULE_ID}.lp.${k}`;
  const ph = (k) => setting(k);

  const fs = document.createElement("fieldset");
  fs.className = "hlp-config";
  fs.innerHTML = `
    <legend><i class="fa-solid fa-lock"></i> ${t("Config.Legend")}</legend>
    <div class="form-group">
      <label>${t("Config.PickDC")}</label>
      <div class="form-fields"><input type="number" name="${n("pickDC")}" value="${f.pickDC ?? ""}" placeholder="${ph(isDoor ? "doorPickDC" : "chestPickDC")}" min="0" step="1"></div>
    </div>
    <div class="form-group">
      <label>${t("Config.BreakDC")}</label>
      <div class="form-fields"><input type="number" name="${n("breakDC")}" value="${f.breakDC ?? ""}" placeholder="${ph(isDoor ? "doorBreakDC" : "chestBreakDC")}" min="0" step="1"></div>
    </div>
    <div class="form-group">
      <label>${t("Config.NoPick")}</label>
      <div class="form-fields"><input type="checkbox" name="${n("noPick")}" ${f.noPick ? "checked" : ""}></div>
    </div>
    <div class="form-group">
      <label>${t("Config.NoBreak")}</label>
      <div class="form-fields"><input type="checkbox" name="${n("noBreak")}" ${f.noBreak ? "checked" : ""}></div>
    </div>
    <p class="hint">${t("Config.Hint")}</p>`;

  const footer = root.querySelector("footer.form-footer, footer.sheet-footer, footer, button[type='submit']");
  if (footer?.parentElement) footer.parentElement.insertBefore(fs, footer);
  else (root.querySelector("form") ?? root).appendChild(fs);
  app.setPosition?.({ height: "auto" });
}

function registerConfigHooks() {
  Hooks.on("renderWallConfig", (app, html) => {
    const doc = app.document ?? app.object;
    if (!doc) return;
    injectFields(app, html, doc, true);
  });
  Hooks.on("renderTokenConfig", (app, html) => {
    const doc = app.document ?? app.token ?? app.object;
    if (!doc || doc.documentName !== "Token" || !isItemPile(doc)) return;
    injectFields(app, html, doc, false);
  });
}

/* -------------------------------------------- */
/*  Item Piles: двойной клик по запертому сундуку */
/* -------------------------------------------- */

function registerItemPilesHooks() {
  Hooks.on("item-piles-preClickItemPile", (target, interactingActor) => {
    const doc = target?.document ?? target;
    if (game.user.isGM || !isPileLocked(doc)) return;
    const token = doc.object ?? canvas.tokens.get(doc.id);
    if (!token) return;
    openLockpickDialog({ kind: "pile", token });
    return false;
  });
}

/* -------------------------------------------- */
/*  API / горячая клавиша: взломать ближайшее   */
/* -------------------------------------------- */

function findNearestLocked() {
  const tk = getActingToken();
  if (!tk) return null;
  const c = tk.center;
  const candidates = [];
  for (const wall of canvas.walls.placeables) {
    if (!isLockedDoor(wall) || !isNearDoor(tk, wall)) continue;
    candidates.push({ kind: "door", wall, d: distToSegment(c.x, c.y, wall.document.c) });
  }
  for (const token of canvas.tokens.placeables) {
    if (token === tk || !isItemPile(token.document) || !isPileLocked(token.document)) continue;
    if (!isNearToken(tk, token)) continue;
    candidates.push({ kind: "pile", token, d: Math.hypot(token.center.x - c.x, token.center.y - c.y) });
  }
  // Сундуки функции «Сундуки, торговцы и обмен» (Piles tool) — это тайлы со своим замком
  const piles = game.rpgSuite?.isActive?.("piles") ? game.rpgSuite.api.piles : null;
  if (piles?.isLockedContainer) {
    for (const tile of canvas.tiles?.placeables ?? []) {
      if (!piles.isLockedContainer(tile.document) || tile.document.hidden) continue;
      const b = tile.bounds; const r = b?.width ? b : tile.document;
      const nx = Math.max(r.x, Math.min(c.x, r.x + r.width));
      const ny = Math.max(r.y, Math.min(c.y, r.y + r.height));
      const gap = Math.max(0, Math.hypot(c.x - nx, c.y - ny) - Math.min(tk.w, tk.h) / 2) / canvas.dimensions.size;
      if (gap > maxGapInCells()) continue;
      candidates.push({ kind: "tile", tile, d: Math.hypot(c.x - nx, c.y - ny) });
    }
  }
  candidates.sort((a, b) => a.d - b.d);
  return candidates[0] ?? null;
}

function lockpickNearest() {
  const target = findNearestLocked();
  if (!target) return ui.notifications.info(t("Warn.NothingNear"));
  if (target.kind === "tile") return game.rpgSuite.api.piles.interact(target.tile.document);
  return openLockpickDialog(target);
}

/* -------------------------------------------- */
/*  Инициализация                               */
/* -------------------------------------------- */

Hooks.once("init", () => {
  registerSettings();
  patchCanvas();
  registerConfigHooks();

  game.keybindings.register(MODULE_ID, "lp-lockpickNearest", {
    name: "HLP.Keybind.Name",
    hint: "HLP.Keybind.Hint",
    editable: [],
    onDown: () => { lockpickNearest(); return true; }
  });
});

Hooks.once("ready", () => {
  suiteSocket.on(FEATURE, onSocket);
  registerItemPilesHooks();
  Object.assign(api, { lockpickNearest, openLockpickDialog, findNearestLocked });
  console.log(`${MODULE_ID} | готов`);
});
