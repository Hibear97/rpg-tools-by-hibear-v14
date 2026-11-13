/**
 * BG3-style Roll Requests — Foundry VTT v13
 * Мастер отправляет запросы на броски; у всех появляется затемнение и карточка броска.
 */

import { SUITE_ID } from "../../core/constants.js";
import { suiteSocket } from "../../core/socket.js";
import { createFeatureHooks } from "../../core/feature-hooks.js";

/** Функция «Запросы бросков (BG3)» внутри RPG Suite.
 *  Настройки: "rpg-tools-by-hibear.rr-*", сокет: suiteSocket "rolls". */
const MODULE_ID = SUITE_ID;
const FEATURE = "rolls";
const SK = (k) => `rr-${k}`;
const ASSETS = `modules/${SUITE_ID}/features/roll-requests`;
const Hooks = createFeatureHooks();

/** API для макросов: game.rpgSuite.api.rolls (и game.modules.get("rpg-suite").api.rolls) */
export const api = {
  openPanel: () => openPanel(),
  request: (opts) => createRequest(opts),
  cancel: () => state.current && game.user.isGM && broadcast({ action: "cancel", requestId: state.current.request.id })
};

export function setup() {
  Hooks.activate();
}
const MIN_SPIN_MS = 1400;     // минимальная длительность «прокрутки» числа
const OUTCOME_DELAY_MS = 450; // пауза между показом числа и баннером успеха/провала

const L = (key, data) => (data
  ? game.i18n.format(`BG3RR.${key}`, data)
  : game.i18n.localize(`BG3RR.${key}`));

const esc = (s) => String(s ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const setting = (key) => game.settings.get(MODULE_ID, SK(key));

/* -------------------------------------------- */
/*  Справочники характеристик и навыков          */
/* -------------------------------------------- */

const ABILITY_KEYS = ["str", "dex", "con", "int", "wis", "cha"];

function getAbilities() {
  const cfg = CONFIG.DND5E?.abilities;
  if (cfg) {
    return Object.entries(cfg).map(([key, v]) => ({ key, label: game.i18n.localize(v.label ?? key) }));
  }
  return ABILITY_KEYS.map((key) => ({ key, label: L(`Abilities.${key}`) }));
}

function getSkills() {
  const cfg = CONFIG.DND5E?.skills;
  if (!cfg) return [];
  return Object.entries(cfg)
    .map(([key, v]) => ({ key, label: game.i18n.localize(v.label ?? key), ability: v.ability }))
    .sort((a, b) => a.label.localeCompare(b.label, game.i18n.lang));
}

function abilityLabel(key) {
  return getAbilities().find((a) => a.key === key)?.label ?? key;
}

function skillLabel(key) {
  return getSkills().find((s) => s.key === key)?.label ?? key;
}

function buildLabel(r) {
  switch (r.type) {
    case "check": return L("LabelCheck", { ability: abilityLabel(r.ability) });
    case "save": return L("LabelSave", { ability: abilityLabel(r.ability) });
    case "skill": return L("LabelSkill", { skill: skillLabel(r.skill) });
    default: return L("LabelCustom", { formula: r.formula || "1d20" });
  }
}

/* -------------------------------------------- */
/*  Настройки                                    */
/* -------------------------------------------- */

function registerSettings() {
  const reg = (key, data) => game.settings.register(MODULE_ID, SK(key), data);

  reg("autoCloseDelay", {
    name: "BG3RR.Settings.AutoClose", hint: "BG3RR.Settings.AutoCloseHint",
    scope: "world", config: true, type: Number, default: 4,
    range: { min: 1, max: 20, step: 1 }
  });
  reg("natCrits", {
    name: "BG3RR.Settings.NatCrits", hint: "BG3RR.Settings.NatCritsHint",
    scope: "world", config: true, type: Boolean, default: true
  });
  reg("postToChat", {
    name: "BG3RR.Settings.PostToChat", hint: "BG3RR.Settings.PostToChatHint",
    scope: "world", config: true, type: Boolean, default: true
  });
  reg("useSystemRoll", {
    name: "BG3RR.Settings.UseSystemRoll", hint: "BG3RR.Settings.UseSystemRollHint",
    scope: "world", config: true, type: Boolean, default: true
  });
  reg("successSound", {
    name: "BG3RR.Settings.SuccessSound", scope: "world", config: true, type: String,
    filePicker: "audio", default: `${ASSETS}/sounds/success.ogg`
  });
  reg("failureSound", {
    name: "BG3RR.Settings.FailureSound", scope: "world", config: true, type: String,
    filePicker: "audio", default: `${ASSETS}/sounds/failure.ogg`
  });
  reg("requestSound", {
    name: "BG3RR.Settings.RequestSound", scope: "world", config: true, type: String,
    filePicker: "audio", default: `${ASSETS}/sounds/request.ogg`
  });
  reg("volume", {
    name: "BG3RR.Settings.Volume", scope: "client", config: true, type: Number, default: 0.8,
    range: { min: 0, max: 1, step: 0.05 }
  });
  reg("panelState", { scope: "client", config: false, type: Object, default: {} });

  game.keybindings.register(MODULE_ID, "rr-openPanel", {
    name: "BG3RR.Settings.Keybind",
    editable: [],
    restricted: true,
    onDown: () => { openPanel(); return true; }
  });
}

function playSound(key) {
  const src = setting(key);
  if (!src) return;
  const volume = setting("volume");
  try {
    foundry.audio.AudioHelper.play({ src, volume, autoplay: true, loop: false }, false);
  } catch (err) {
    console.warn(`${MODULE_ID} | sound failed`, err);
  }
}

/* -------------------------------------------- */
/*  Сокеты                                       */
/* -------------------------------------------- */

function broadcast(msg) {
  suiteSocket.emit(FEATURE, msg);
  handleMessage(msg);
}

function handleMessage(msg) {
  switch (msg?.action) {
    case "request": return enqueue(msg.request);
    case "rolling": return onRolling(msg);
    case "rollAborted": return onRollAborted(msg);
    case "result": return onResult(msg);
    case "cancel": return onCancel(msg);
  }
}

/* -------------------------------------------- */
/*  API: создание запроса                        */
/* -------------------------------------------- */

/** Кто бросает за персонажа: активный игрок-владелец (лучше тот, чей это персонаж), иначе мастер (null). */
function responsibleUser(actor) {
  if (!actor) return null;
  const owners = game.users.filter((u) => u.active && !u.isGM && actor.testUserPermission(u, "OWNER"));
  return owners.find((u) => u.character?.id === actor.id) ?? owners[0] ?? null;
}

/** Любой владелец-игрок (даже не в сети) — чтобы показать в списке, чей это персонаж. */
function ownerName(actor) {
  const owners = game.users.filter((u) => !u.isGM && actor?.testUserPermission(u, "OWNER"));
  return (owners.find((u) => u.character?.id === actor.id) ?? owners[0])?.name ?? null;
}

/** Токен / документ токена / id / uuid → документ токена на текущей сцене. */
function toTokenDoc(t) {
  if (!t) return null;
  if (t.document?.documentName === "Token") return t.document;
  if (t.documentName === "Token") return t;
  if (typeof t === "string") return canvas?.scene?.tokens.get(t) ?? fromUuidSync(t) ?? null;
  return null;
}

function targetFromToken(td) {
  const actor = td?.actor;
  if (!actor) return null;
  const user = responsibleUser(actor);
  return {
    key: td.id,
    tokenUuid: td.uuid,
    actorUuid: actor.uuid,
    actorName: td.name ?? actor.name,
    userId: user?.id ?? null,
    userName: user?.name ?? "",
    img: td.texture?.src ?? actor.img ?? "icons/svg/mystery-man.svg",
    color: user?.color?.css ?? String(user?.color ?? "#d8b46a")
  };
}

function targetFromActor(actor) {
  const td = actor?.getActiveTokens?.(false, true)?.[0];
  if (td) return targetFromToken(td);
  if (!actor) return null;
  const user = responsibleUser(actor);
  return {
    key: actor.id, tokenUuid: null, actorUuid: actor.uuid, actorName: actor.name,
    userId: user?.id ?? null, userName: user?.name ?? "",
    img: actor.img ?? "icons/svg/mystery-man.svg",
    color: user?.color?.css ?? String(user?.color ?? "#d8b46a")
  };
}

/**
 * Отправить запрос на бросок. Можно вызывать из макросов:
 * game.rpgSuite.api.rolls.request({
 *   tokens: canvas.tokens.controlled,     // токены (объекты, id или uuid)
 *   actors: ["Кайзер"],                   // или персонажи (документы, id или имена)
 *   users: ["Аня"],                       // или игроки — берётся их персонаж
 *   type: "skill", skill: "ath", dc: 15, mode: "adv", reason: "Выбить дверь"
 * })
 * type: "check" | "save" | "skill" | "custom"
 */
function createRequest(opts = {}) {
  if (!game.user.isGM) return null;
  const targets = [];
  for (const t of opts.tokens ?? []) {
    const tg = targetFromToken(toTokenDoc(t));
    if (tg) targets.push(tg);
  }
  for (const a of opts.actors ?? []) {
    const actor = typeof a === "string" ? (game.actors.get(a) ?? game.actors.getName(a) ?? fromUuidSync(a)) : a;
    const tg = targetFromActor(actor);
    if (tg) targets.push(tg);
  }
  for (const u of opts.users ?? []) {
    const user = typeof u === "string" ? game.users.get(u) ?? game.users.getName(u) : u;
    const tg = targetFromActor(user?.character);
    if (tg) targets.push(tg);
  }
  const seen = new Set();
  const unique = targets.filter((t) => (seen.has(t.key) ? false : seen.add(t.key)));
  if (!unique.length) {
    ui.notifications.warn(L("SelectTarget"));
    return null;
  }

  const dcRaw = opts.dc;
  const dc = (dcRaw === "" || dcRaw === null || dcRaw === undefined || Number.isNaN(Number(dcRaw)))
    ? null : Number(dcRaw);

  const request = {
    id: foundry.utils.randomID(),
    type: ["check", "save", "skill", "custom"].includes(opts.type) ? opts.type : "check",
    ability: opts.ability ?? "str",
    skill: opts.skill ?? "ath",
    formula: (opts.formula ?? "1d20").trim() || "1d20",
    dc,
    showDC: opts.showDC ?? true,
    mode: ["adv", "dis"].includes(opts.mode) ? opts.mode : "normal",
    reason: opts.reason ?? "",
    targets: unique
  };
  request.label = buildLabel(request);
  broadcast({ action: "request", request });
  return request.id;
}

/* -------------------------------------------- */
/*  Выполнение броска (на клиенте бросающего)    */
/* -------------------------------------------- */

async function resolveTargetActor(target) {
  if (target.tokenUuid) {
    const td = await fromUuid(target.tokenUuid).catch(() => null);
    if (td?.actor) return td.actor;
  }
  return target.actorUuid ? await fromUuid(target.actorUuid).catch(() => null) : null;
}

/** Может ли этот клиент бросить за цель: её игрок или мастер. */
function canRollFor(target) {
  return game.user.isGM || (!!target.userId && target.userId === game.user.id);
}

async function systemRoll(actor, r) {
  if (game.system.id !== "dnd5e" || !setting("useSystemRoll")) return null;
  const config = { advantage: r.mode === "adv", disadvantage: r.mode === "dis" };
  const dialog = { configure: false };
  const message = { create: false };
  try {
    let rolls;
    if (r.type === "check" && actor.rollAbilityCheck) {
      rolls = await actor.rollAbilityCheck({ ...config, ability: r.ability }, dialog, message);
    } else if (r.type === "save" && actor.rollSavingThrow) {
      rolls = await actor.rollSavingThrow({ ...config, ability: r.ability }, dialog, message);
    } else if (r.type === "skill" && actor.rollSkill) {
      rolls = await actor.rollSkill({ ...config, skill: r.skill }, dialog, message);
    }
    const roll = Array.isArray(rolls) ? rolls[0] : rolls;
    return roll instanceof foundry.dice.Roll ? roll : null;
  } catch (err) {
    console.warn(`${MODULE_ID} | system roll failed, falling back to manual`, err);
    return null;
  }
}

function getModifier(actor, r) {
  const sys = actor?.system;
  if (!sys) return 0;
  if (r.type === "skill") {
    const sk = sys.skills?.[r.skill];
    if (sk && sk.total !== undefined) return num(sk.total);
    const abilityKey = CONFIG.DND5E?.skills?.[r.skill]?.ability;
    return num(sys.abilities?.[abilityKey]?.mod);
  }
  const abl = sys.abilities?.[r.ability];
  if (!abl) return 0;
  if (r.type === "save") {
    return typeof abl.save === "object" && abl.save !== null ? num(abl.save.value) : num(abl.save ?? abl.mod);
  }
  return num(abl.mod) + num(abl.checkBonus) + num(abl.checkProf?.flat);
}

async function manualRoll(actor, r) {
  const d20 = r.mode === "adv" ? "2d20kh" : r.mode === "dis" ? "2d20kl" : "1d20";
  let formula;
  if (r.type === "custom") {
    formula = r.formula.replace(/^\s*1?d20(?![0-9])/i, d20);
  } else {
    const mod = getModifier(actor, r);
    formula = mod ? `${d20} ${mod < 0 ? "-" : "+"} ${Math.abs(mod)}` : d20;
  }
  const RollCls = foundry.dice.Roll;
  if (!RollCls.validate(formula)) {
    ui.notifications.error(L("BadFormula", { formula }));
    return null;
  }
  const roll = new RollCls(formula, actor?.getRollData?.() ?? {});
  await roll.evaluate();
  return roll;
}

function analyzeRoll(roll) {
  const first = roll.dice?.[0];
  const isD20 = !!first && first.faces === 20;
  const natural = isD20 ? first.total : null;
  return { isD20, natural };
}

function computeOutcome(total, natural, isD20, dc) {
  const crits = setting("natCrits");
  const hasDC = dc !== null && dc !== undefined;
  if (isD20 && crits && natural === 20) return { success: hasDC ? true : null, crit: "success" };
  if (isD20 && crits && natural === 1) return { success: hasDC ? false : null, crit: "failure" };
  return { success: hasDC ? total >= dc : null, crit: null };
}

async function waitForDiceSoNice(getMessageId) {
  return new Promise((resolve) => {
    let hookId = null;
    const finish = () => { if (hookId !== null) Hooks.off("diceSoNiceRollComplete", hookId); resolve(); };
    hookId = Hooks.on("diceSoNiceRollComplete", (messageId) => {
      if (messageId === getMessageId()) finish();
    });
    setTimeout(finish, 10000);
  });
}

/** То же для 3D-кубиков RPG Suite (функция «3D-кубики»): хук rpgSuite.diceSettled(messageId). */
async function waitForSuiteDice(getMessageId) {
  return new Promise((resolve) => {
    let hookId = null;
    const finish = () => { if (hookId !== null) Hooks.off("rpgSuite.diceSettled", hookId); resolve(); };
    hookId = Hooks.on("rpgSuite.diceSettled", (messageId) => {
      if (messageId === getMessageId()) finish();
    });
    setTimeout(finish, 10000);
  });
}

async function executeRoll(r, target) {
  const actor = await resolveTargetActor(target);
  if (!actor && r.type !== "custom") ui.notifications.warn(L("NoActor"));

  let roll = null;
  if (actor && r.type !== "custom") roll = await systemRoll(actor, r);
  if (!roll) roll = await manualRoll(actor, r);
  if (!roll) return null;

  const { isD20, natural } = analyzeRoll(roll);
  const outcome = computeOutcome(roll.total, natural, isD20, r.dc);

  const dsn = game.modules.get("dice-so-nice")?.active && game.dice3d;
  if (setting("postToChat")) {
    let flavor = r.label;
    if (r.reason) flavor += ` — ${r.reason}`;
    if (r.dc !== null && r.showDC) flavor += ` (${L("Difficulty")} ${r.dc})`;
    let messageId = null;
    const s3d = game.rpgSuite?.isActive?.("dice");
    const wait = dsn ? waitForDiceSoNice(() => messageId) : (s3d ? waitForSuiteDice(() => messageId) : null);
    const token = target.tokenUuid ? fromUuidSync(target.tokenUuid) : null;
    const speaker = actor
      ? ChatMessage.getSpeaker({ actor, token })
      : { alias: target.actorName || game.user.name };
    const msg = await roll.toMessage({ speaker, flavor }, { rollMode: CONST.DICE_ROLL_MODES.PUBLIC });
    messageId = msg?.id ?? null;
    if (wait) await wait;
  } else if (dsn) {
    await game.dice3d.showForRoll(roll, game.user, true);
  } else if (game.rpgSuite?.isActive?.("dice") && game.rpgSuite.api?.dice?.showRoll) {
    await game.rpgSuite.api.dice.showRoll(roll, game.user);
  } else {
    foundry.audio.AudioHelper.play({ src: CONFIG.sounds.dice, volume: 0.8, autoplay: true }, true);
  }

  return {
    total: roll.total,
    natural,
    isD20,
    formula: roll.formula,
    breakdown: roll.result,
    success: outcome.success,
    crit: outcome.crit
  };
}

async function performRoll(requestId, key) {
  const cur = state.current;
  if (!cur || cur.request.id !== requestId) return;
  const card = cur.cards.get(key);
  if (!card || card.status !== "pending" || !canRollFor(card.target)) return;

  broadcast({ action: "rolling", requestId, key });
  let result = null;
  try {
    result = await executeRoll(cur.request, card.target);
  } catch (err) {
    console.error(`${MODULE_ID} | roll failed`, err);
  }
  if (!result) return broadcast({ action: "rollAborted", requestId, key });
  broadcast({ action: "result", requestId, key, result });
}

/* -------------------------------------------- */
/*  Состояние оверлея и очередь                  */
/* -------------------------------------------- */

const state = {
  queue: [],
  current: null // { request, cards: Map<userId, card>, el, closeTimer }
};

function enqueue(request) {
  state.queue.push(request);
  if (!state.current) showNext();
}

function showNext() {
  const request = state.queue.shift();
  if (!request) return;
  const cards = new Map();
  for (const t of request.targets) {
    cards.set(t.key, { target: t, status: "pending", rollingSince: 0, flicker: null, result: null });
  }
  state.current = { request, cards, el: null, closeTimer: null };
  renderOverlay();
  playSound("requestSound");
}

function closeCurrent() {
  const cur = state.current;
  if (!cur) return;
  clearTimeout(cur.closeTimer);
  for (const card of cur.cards.values()) clearInterval(card.flicker);
  const el = cur.el;
  state.current = null;
  if (el) {
    el.classList.add("bg3rr-closing");
    setTimeout(() => {
      el.remove();
      if (!state.current) document.body.classList.remove("bg3rr-active");
      showNext();
    }, 450);
  } else {
    showNext();
  }
}

function findCard(msg) {
  const cur = state.current;
  if (!cur || cur.request.id !== msg.requestId) return null;
  return cur.cards.get(msg.key) ?? null;
}

function startFlicker(card, userId) {
  clearInterval(card.flicker);
  const valueEl = cardEl(userId)?.querySelector(".bg3rr-value");
  card.flicker = setInterval(() => {
    if (valueEl) valueEl.textContent = String(1 + Math.floor(Math.random() * 20));
  }, 70);
}

function onRolling(msg) {
  const card = findCard(msg);
  if (!card || card.status !== "pending") return;
  card.status = "rolling";
  card.rollingSince = Date.now();
  updateCard(msg.key);
  startFlicker(card, msg.key);
}

function onRollAborted(msg) {
  const card = findCard(msg);
  if (!card || card.status === "done") return;
  clearInterval(card.flicker);
  card.status = "pending";
  updateCard(msg.key);
}

function onResult(msg) {
  const card = findCard(msg);
  if (!card || card.status === "done") return;
  if (card.status !== "rolling") {
    card.rollingSince = Date.now();
    startFlicker(card, msg.key);
  }
  card.status = "done";
  card.result = msg.result;
  const requestId = msg.requestId;
  const wait = Math.max(0, MIN_SPIN_MS - (Date.now() - card.rollingSince));

  setTimeout(() => {
    if (state.current?.request.id !== requestId) return;
    clearInterval(card.flicker);
    updateCard(msg.key);
    const el = cardEl(msg.key);
    el?.classList.add("bg3rr-revealed");

    setTimeout(() => {
      if (state.current?.request.id !== requestId) return;
      const r = card.result;
      const hasBanner = r.crit || r.success !== null;
      if (hasBanner) {
        el?.classList.add("bg3rr-show-outcome");
        const good = r.success ?? (r.crit === "success");
        playSound(good ? "successSound" : "failureSound");
      }
      maybeScheduleClose();
    }, OUTCOME_DELAY_MS);
  }, wait);
}

function onCancel(msg) {
  if (state.current?.request.id === msg.requestId) {
    if (!game.user.isGM) ui.notifications.info(L("Cancelled"));
    closeCurrent();
  } else {
    state.queue = state.queue.filter((r) => r.id !== msg.requestId);
  }
}

function maybeScheduleClose() {
  const cur = state.current;
  if (!cur) return;
  const allDone = [...cur.cards.values()].every((c) => c.status === "done");
  if (!allDone) return;
  clearTimeout(cur.closeTimer);
  cur.closeTimer = setTimeout(closeCurrent, setting("autoCloseDelay") * 1000);
}

/* -------------------------------------------- */
/*  Отрисовка оверлея                            */
/* -------------------------------------------- */

const D20_SVG = `
<svg class="bg3rr-d20" viewBox="0 0 200 220" aria-hidden="true">
  <defs>
    <linearGradient id="bg3rr-face" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#3a2a1a"/><stop offset="1" stop-color="#140d08"/>
    </linearGradient>
  </defs>
  <polygon class="bg3rr-d20-outer" points="100,6 190,58 190,162 100,214 10,162 10,58"/>
  <polygon class="bg3rr-d20-inner" points="100,52 162,152 38,152"/>
  <path class="bg3rr-d20-lines" d="M100,6 L100,52 M190,58 L100,52 M10,58 L100,52 M190,58 L162,152 M10,58 L38,152
    M190,162 L162,152 M10,162 L38,152 M100,214 L38,152 M100,214 L162,152"/>
</svg>`;

function cardEl(key) {
  return state.current?.el?.querySelector(`.bg3rr-card[data-key="${CSS.escape(key)}"]`) ?? null;
}

function renderOverlay() {
  const cur = state.current;
  const r = cur.request;
  document.getElementById("bg3rr-overlay")?.remove();

  const el = document.createElement("div");
  el.id = "bg3rr-overlay";
  el.className = "bg3rr-overlay";
  el.innerHTML = `
    <div class="bg3rr-backdrop"></div>
    ${game.user.isGM ? `<button type="button" class="bg3rr-close" data-bg3rr="cancel" title="${esc(L("Close"))}"><i class="fa-solid fa-xmark"></i></button>` : ""}
    <div class="bg3rr-stage ${r.targets.length > 1 ? "bg3rr-multi" : ""}">
      ${r.targets.map((t) => cardHTML(r, t)).join("")}
    </div>`;

  el.addEventListener("click", (ev) => {
    const btn = ev.target.closest("[data-bg3rr]");
    if (!btn) return;
    ev.preventDefault();
    const action = btn.dataset.bg3rr;
    if (action === "cancel" && game.user.isGM) {
      broadcast({ action: "cancel", requestId: r.id });
    } else if (action === "roll") {
      btn.disabled = true;
      performRoll(r.id, btn.closest(".bg3rr-card").dataset.key);
    }
  });

  document.body.appendChild(el);
  document.body.classList.add("bg3rr-active");
  cur.el = el;
  for (const t of r.targets) updateCard(t.key);
}

function cardHTML(r, t) {
  const modeTag = r.mode === "adv" ? `<span class="bg3rr-mode bg3rr-adv">${esc(L("AdvShort"))}</span>`
    : r.mode === "dis" ? `<span class="bg3rr-mode bg3rr-dis">${esc(L("DisShort"))}</span>` : "";
  const dcText = r.dc === null ? "" : (r.showDC || game.user.isGM ? String(r.dc) : L("Hidden"));
  const who = `${esc(t.actorName)}${t.userName ? ` <small>(${esc(t.userName)})</small>` : ""}`;
  return `
  <section class="bg3rr-card" data-key="${esc(t.key)}" style="--bg3rr-player:${esc(t.color)}">
    <div class="bg3rr-outcome"><span></span></div>
    <div class="bg3rr-frame">
      <i class="bg3rr-corner bg3rr-tl"></i><i class="bg3rr-corner bg3rr-tr"></i>
      <i class="bg3rr-corner bg3rr-bl"></i><i class="bg3rr-corner bg3rr-br"></i>
      <header class="bg3rr-header">
        <img class="bg3rr-portrait" src="${esc(t.img)}" alt="">
        <div class="bg3rr-who">
          <div class="bg3rr-name">${who}</div>
          <div class="bg3rr-requested">${esc(L("Requested"))}</div>
        </div>
      </header>
      <div class="bg3rr-label">${esc(r.label)} ${modeTag}</div>
      ${r.reason ? `<div class="bg3rr-reason">${esc(r.reason)}</div>` : ""}
      <div class="bg3rr-die">
        ${D20_SVG}
        <span class="bg3rr-value">?</span>
      </div>
      <div class="bg3rr-breakdown"></div>
      <div class="bg3rr-actions"></div>
      ${r.dc === null ? "" : `<div class="bg3rr-dc">${esc(L("Difficulty"))} <b>${esc(dcText)}</b></div>`}
    </div>
  </section>`;
}

function updateCard(userId) {
  const cur = state.current;
  const card = cur?.cards.get(userId);
  const el = cardEl(userId);
  if (!card || !el) return;

  el.classList.toggle("bg3rr-rolling", card.status === "rolling");
  const actions = el.querySelector(".bg3rr-actions");
  const valueEl = el.querySelector(".bg3rr-value");
  const breakdown = el.querySelector(".bg3rr-breakdown");

  if (card.status === "pending") {
    valueEl.textContent = "?";
    if (card.target.userId && game.user.id === card.target.userId) {
      actions.innerHTML = `<button type="button" class="bg3rr-roll" data-bg3rr="roll"><i class="fa-solid fa-dice-d20"></i> ${esc(L("RollButton"))}</button>`;
    } else if (game.user.isGM) {
      actions.innerHTML = card.target.userId
        ? `<div class="bg3rr-waiting">${esc(L("Waiting"))}</div>
        <button type="button" class="bg3rr-roll bg3rr-roll-gm" data-bg3rr="roll">${esc(L("RollForPlayer"))}</button>`
        : `<button type="button" class="bg3rr-roll" data-bg3rr="roll"><i class="fa-solid fa-dice-d20"></i> ${esc(L("RollButton"))}</button>`;
    } else {
      actions.innerHTML = `<div class="bg3rr-waiting">${esc(L("Waiting"))}</div>`;
    }
  } else if (card.status === "rolling") {
    actions.innerHTML = `<div class="bg3rr-waiting">${esc(L("Rolling"))}</div>`;
  } else if (card.status === "done" && card.result) {
    const res = card.result;
    actions.innerHTML = "";
    valueEl.textContent = String(res.total);
    breakdown.textContent = res.breakdown && res.breakdown !== String(res.total) ? res.breakdown : "";
    el.classList.toggle("bg3rr-nat20", res.isD20 && res.natural === 20);
    el.classList.toggle("bg3rr-nat1", res.isD20 && res.natural === 1);

    const outcome = el.querySelector(".bg3rr-outcome");
    const span = outcome.querySelector("span");
    outcome.classList.remove("bg3rr-good", "bg3rr-bad");
    if (res.crit === "success") span.textContent = L("CritSuccess");
    else if (res.crit === "failure") span.textContent = L("CritFailure");
    else if (res.success === true) span.textContent = L("Success");
    else if (res.success === false) span.textContent = L("Failure");
    else span.textContent = "";
    const good = res.success ?? (res.crit === "success");
    outcome.classList.add(good ? "bg3rr-good" : "bg3rr-bad");
  }
}

/* -------------------------------------------- */
/*  Панель мастера                               */
/* -------------------------------------------- */

const { ApplicationV2 } = foundry.applications.api;

/** Токены текущей сцены, у которых есть персонаж: сначала персонажи игроков, потом остальные. */
function sceneTokens() {
  const tokens = [...(canvas?.scene?.tokens ?? [])].filter((td) => td.actor);
  tokens.sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "", game.i18n.lang));
  return {
    pcs: tokens.filter((td) => td.actor.hasPlayerOwner),
    npcs: tokens.filter((td) => !td.actor.hasPlayerOwner)
  };
}

/** Короткое имя характеристики (СИЛ / STR) */
function abilityAbbr(key) {
  const a = CONFIG.DND5E?.abilities?.[key];
  return a?.abbreviation ? game.i18n.localize(a.abbreviation) : (key ?? "").toUpperCase();
}

class RollRequestPanel extends ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: "bg3rr-panel",
    tag: "form",
    classes: ["bg3rr-panel"],
    window: { title: "BG3RR.PanelTitle", icon: "fa-solid fa-dice-d20", resizable: true },
    position: { width: 820, height: "auto" },
    form: { handler: RollRequestPanel.#onSubmit, closeOnSubmit: false, submitOnChange: false },
    actions: {
      selectControlled: RollRequestPanel.#onSelectControlled,
      selectPCs: RollRequestPanel.#onSelectPCs,
      selectNone: RollRequestPanel.#onSelectNone,
      pick: RollRequestPanel.#onPick,
      die: RollRequestPanel.#onDie
    }
  };

  get draft() {
    const defaults = {
      tokens: [], type: "skill", ability: "str", skill: "ath", formula: "1d20",
      dc: "", showDC: true, mode: "normal", reason: "", showNpc: false
    };
    const d = { ...defaults, ...(this._draft ?? setting("panelState") ?? {}) };
    if (!Array.isArray(d.tokens)) d.tokens = [];
    return d;
  }

  async _renderHTML() {
    const d = this.draft;
    const skills = getSkills();
    const abilities = getAbilities();
    const { pcs, npcs } = sceneTokens();
    const opt = (value, label, current) =>
      `<option value="${esc(value)}" ${value === current ? "selected" : ""}>${esc(label)}</option>`;

    const tokenRow = (td) => {
      const actor = td.actor;
      let note;
      if (actor.hasPlayerOwner) {
        const user = responsibleUser(actor);
        note = user ? esc(user.name) : `${esc(ownerName(actor) ?? "")} · ${esc(L("Offline"))} — ${esc(L("GmRolls"))}`;
      } else note = esc(L("GmRolls"));
      const user = responsibleUser(actor);
      const offline = actor.hasPlayerOwner && !user;
      return `<label class="bg3rr-token ${offline ? "bg3rr-offline" : ""}">
        <input type="checkbox" name="tokens" value="${esc(td.id)}" ${d.tokens.includes(td.id) ? "checked" : ""}>
        <img src="${esc(td.texture?.src ?? actor.img)}" alt="">
        <span class="bg3rr-tname">${esc(td.name)}</span>
        <small data-tooltip="${note}">${note}</small>
      </label>`;
    };
    let tokensHTML;
    if (!canvas?.scene) tokensHTML = `<p class="hint">${esc(L("NoScene"))}</p>`;
    else if (!pcs.length && !npcs.length) tokensHTML = `<p class="hint">${esc(L("NoTokens"))}</p>`;
    else {
      tokensHTML = pcs.map(tokenRow).join("");
      if (npcs.length) {
        tokensHTML += `<details class="bg3rr-npcs" ${d.showNpc ? "open" : ""}>
          <summary>${esc(L("NpcGroup"))} (${npcs.length})</summary>${npcs.map(tokenRow).join("")}</details>`;
      }
    }

    const types = [["check", L("TypeCheck")], ["save", L("TypeSave")]];
    if (skills.length) types.push(["skill", L("TypeSkill")]);
    types.push(["custom", L("TypeCustom")]);

    const tile = (kind, key, label, sub, current) => `
      <button type="button" class="bg3rr-tile ${key === current ? "selected" : ""}" data-action="pick" data-kind="${kind}" data-key="${esc(key)}">
        <span class="bg3rr-tile-label">${esc(label)}</span>${sub ? `<small>${esc(sub)}</small>` : ""}
      </button>`;

    return `
    <div class="bg3rr-panel-body" data-type="${esc(d.type)}">
      <div class="bg3rr-col bg3rr-col-left">
        <fieldset>
          <legend>${esc(L("Targets"))}</legend>
          <div class="bg3rr-tokens">${tokensHTML}</div>
          <div class="bg3rr-row">
            <button type="button" class="bg3rr-small" data-action="selectControlled"><i class="fa-solid fa-object-group"></i> ${esc(L("SelectControlled"))}</button>
            <button type="button" class="bg3rr-small" data-action="selectPCs"><i class="fa-solid fa-users"></i> ${esc(L("SelectPCs"))}</button>
            <button type="button" class="bg3rr-small" data-action="selectNone"><i class="fa-regular fa-square"></i> ${esc(L("SelectNone"))}</button>
          </div>
        </fieldset>

        <div class="form-group">
          <label>${esc(L("RollType"))}</label>
          <select name="type">${types.map(([v, l]) => opt(v, l, d.type)).join("")}</select>
        </div>
        <div class="form-group">
          <label>${esc(L("DC"))}</label>
          <input type="number" name="dc" min="1" max="99" step="1" value="${esc(d.dc)}" placeholder="${esc(L("DCHint"))}">
        </div>
        <div class="form-group">
          <label>${esc(L("ShowDC"))}</label>
          <input type="checkbox" name="showDC" ${d.showDC ? "checked" : ""}>
        </div>
        <div class="form-group">
          <label>${esc(L("Mode"))}</label>
          <select name="mode">
            ${opt("normal", L("Normal"), d.mode)}${opt("adv", L("Advantage"), d.mode)}${opt("dis", L("Disadvantage"), d.mode)}
          </select>
        </div>
        <div class="form-group">
          <label>${esc(L("Reason"))}</label>
          <input type="text" name="reason" value="${esc(d.reason)}" placeholder="${esc(L("ReasonPlaceholder"))}">
        </div>
        <button type="submit" class="bg3rr-send"><i class="fa-solid fa-paper-plane"></i> ${esc(L("Send"))}</button>
      </div>

      <div class="bg3rr-col bg3rr-col-right">
        <input type="hidden" name="skill" value="${esc(d.skill)}">
        <input type="hidden" name="ability" value="${esc(d.ability)}">
        ${skills.length ? `
        <div class="bg3rr-f-skill">
          <h4>${esc(L("PickSkill"))}</h4>
          <div class="bg3rr-tiles">${skills.map((sk) => tile("skill", sk.key, sk.label, abilityAbbr(sk.ability), d.skill)).join("")}</div>
        </div>` : ""}
        <div class="bg3rr-f-ability">
          <h4>${esc(L("PickAbility"))}</h4>
          <div class="bg3rr-tiles bg3rr-tiles-big">${abilities.map((a) => tile("ability", a.key, a.label, abilityAbbr(a.key), d.ability)).join("")}</div>
        </div>
        <div class="bg3rr-f-formula">
          <h4>${esc(L("PickFormula"))}</h4>
          <input type="text" name="formula" value="${esc(d.formula)}" placeholder="1d20">
          <div class="bg3rr-dice">
            ${["1d4", "1d6", "1d8", "1d10", "1d12", "1d20", "1d100", "2d6"].map((f) =>
              `<button type="button" data-action="die" data-formula="${f}">${f}</button>`).join("")}
          </div>
        </div>
      </div>
    </div>`;
  }

  _replaceHTML(result, content) {
    content.innerHTML = result;
  }

  _onFirstRender(context, options) {
    super._onFirstRender?.(context, options);
    // Элемент формы сохраняется между перерисовками, поэтому слушатели вешаем один раз.
    const form = this.element;
    const onChange = () => {
      this._draft = RollRequestPanel.#readForm(form);
      const body = form.querySelector(".bg3rr-panel-body");
      if (body) body.dataset.type = this._draft.type;
    };
    form.addEventListener("change", onChange);
    form.addEventListener("input", onChange);
    form.addEventListener("toggle", onChange, true);   // раскрытие списка NPC
  }

  static #readForm(form) {
    const val = (n) => form.querySelector(`[name="${n}"]`)?.value ?? "";
    return {
      tokens: [...form.querySelectorAll('input[name="tokens"]:checked')].map((i) => i.value),
      type: val("type") || "skill",
      ability: val("ability"),
      skill: val("skill"),
      formula: val("formula"),
      dc: val("dc"),
      showDC: !!form.querySelector('[name="showDC"]')?.checked,
      mode: val("mode") || "normal",
      reason: val("reason"),
      showNpc: !!form.querySelector(".bg3rr-npcs")?.open
    };
  }

  static async #onSubmit(event, form) {
    const data = RollRequestPanel.#readForm(form);
    this._draft = data;
    await game.settings.set(MODULE_ID, SK("panelState"), data);
    if (!data.tokens.length) return ui.notifications.warn(L("SelectTarget"));
    const id = createRequest(data);
    if (id) ui.notifications.info(L("Sent"));
  }

  #setChecked(test) {
    for (const input of this.element.querySelectorAll('input[name="tokens"]')) input.checked = !!test(input.value);
    this.element.dispatchEvent(new Event("change"));
  }

  static #onSelectControlled() {
    const ids = new Set((canvas?.tokens?.controlled ?? []).map((t) => t.id));
    if (!ids.size) ui.notifications.info(L("NoControlled"));
    this.#setChecked((id) => ids.has(id));
  }

  static #onSelectPCs() {
    const ids = new Set(sceneTokens().pcs.map((td) => td.id));
    this.#setChecked((id) => ids.has(id));
  }

  static #onSelectNone() {
    this.#setChecked(() => false);
  }

  /** Плитка навыка / характеристики: выделяется рамкой, значение уходит в скрытое поле. */
  static #onPick(event, target) {
    const kind = target.dataset.kind;
    const input = this.element.querySelector(`input[name="${kind}"]`);
    if (input) input.value = target.dataset.key;
    target.closest(".bg3rr-tiles")?.querySelectorAll(".bg3rr-tile").forEach((b) => b.classList.toggle("selected", b === target));
    this.element.dispatchEvent(new Event("change"));
  }

  static #onDie(event, target) {
    const input = this.element.querySelector('[name="formula"]');
    if (input) input.value = target.dataset.formula;
    this.element.dispatchEvent(new Event("change"));
  }
}

let panel = null;
function openPanel() {
  if (!game.user.isGM) return;
  panel ??= new RollRequestPanel();
  panel.render({ force: true });
}

/* -------------------------------------------- */
/*  Хуки                                         */
/* -------------------------------------------- */

Hooks.once("init", () => {
  registerSettings();
});

Hooks.once("ready", () => {
  suiteSocket.on(FEATURE, handleMessage);
});

Hooks.on("getSceneControlButtons", (controls) => {
  if (!game.user?.isGM) return;
  const tokens = controls.tokens ?? controls.token;
  if (!tokens?.tools) return;
  tokens.tools.bg3RollRequest = {
    name: "bg3RollRequest",
    title: "BG3RR.OpenPanel",
    icon: "fa-solid fa-dice-d20",
    order: Object.keys(tokens.tools).length,
    button: true,
    visible: true,
    onChange: () => openPanel()
  };
});

const refreshPanel = () => { if (panel?.rendered) panel.render(); };
for (const hook of ["userConnected", "canvasReady", "createToken", "deleteToken"]) {
  Hooks.on(hook, refreshPanel);
}
Hooks.on("updateToken", (td, changes) => {
  if ("name" in changes || "texture" in changes || "actorId" in changes) refreshPanel();
});
