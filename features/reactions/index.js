/**
 * Reaction Prompts (D&D 5e) — Foundry VTT v13
 *
 * Когда по персонажу попадает атака или враг рядом колдует заклинание,
 * владелец персонажа получает окно: «Использовать реакцию?».
 * При согласии реакция тратится (ячейка, заряд, карточка в чат) и применяется эффект:
 *   - acBonus      — бонус к КД до начала своего хода (Щит)
 *   - reduceDamage — уменьшение урона от этой атаки на бросок (Отражение снарядов)
 *   - halveDamage  — урон от этой атаки вдвое (Невероятное уклонение)
 *   - cancel       — прерывание заклинания (Контрзаклинание)
 *   - none         — просто напоминание, эффект вручную
 */

import { SUITE_ID } from "../../core/constants.js";
import { suiteSocket } from "../../core/socket.js";
import { shared } from "../../core/shared.js";
import { createFeatureHooks } from "../../core/feature-hooks.js";

/** Функция «Реакции» внутри RPG Suite.
 *  Настройки: "rpg-tools-by-hibear.rp-*", флаги: flags["rpg-tools-by-hibear"].rp.*, сокет: suiteSocket "reactions". */
const MOD = SUITE_ID;
const FEATURE = "reactions";
const SK = (k) => `rp-${k}`;
const FK = (k) => `rp.${k}`;
const Hooks = createFeatureHooks();

/** API для макросов: game.rpgSuite.api.reactions.configureItem(item) */
export const api = {
  configureItem: (item) => configureItem(item),
  getReactionConfig: (item) => getReactionConfig(item),
  collectReactions: (...a) => collectReactions(...a),
  resetReaction: (actor) => cleanupActor(actor)
};

export function setup() {
  Hooks.activate();
}

const t = (key, data) => data ? game.i18n.format(`RP.${key}`, data) : game.i18n.localize(`RP.${key}`);
const setting = key => game.settings.get(MOD, SK(key));
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const ATTACK_TYPES = ["mwak", "rwak", "msak", "rsak"];
const TRIGGERS = ["attacked", "spellCast"];
const EFFECTS = ["none", "acBonus", "reduceDamage", "halveDamage", "cancel"];
const BLOCKING_STATUSES = ["incapacitated", "unconscious", "paralyzed", "petrified", "stunned", "dead"];

const MONK_DEFLECT = "1d10 + @abilities.dex.mod + @classes.monk.levels";

/** Встроенные пресеты: распознаются по identifier или по названию (рус/англ). */
const PRESETS = [
  { keys: ["shield", "щит"], spellOnly: true, trigger: "attacked", effect: "acBonus", value: "5" },
  { keys: ["counterspell", "контрзаклинание"], spellOnly: true, trigger: "spellCast", effect: "cancel", range: 60 },
  { keys: ["deflect-missiles", "отражение-снарядов", "отражение-стрел", "отбивание-снарядов"],
    trigger: "attacked", attackTypes: ["rwak"], effect: "reduceDamage", value: MONK_DEFLECT },
  { keys: ["deflect-attacks", "отражение-атак", "отбивание-атак"],
    trigger: "attacked", attackTypes: ["mwak", "rwak"], effect: "reduceDamage", value: MONK_DEFLECT },
  { keys: ["uncanny-dodge", "невероятное-уклонение", "сверхъестественное-уклонение", "невероятное-уворачивание"],
    trigger: "attacked", effect: "halveDamage" },
  { keys: ["defensive-duelist", "дуэлянт-защитник", "оборонительный-дуэлянт", "защитный-дуэлянт"],
    trigger: "attacked", attackTypes: ["mwak"], effect: "acBonus", value: "@prof" }
];

const pending = new Map();
const handledRolls = new WeakSet();

/* -------------------------------------------- */
/*  Init / settings                             */
/* -------------------------------------------- */

Hooks.once("init", () => {
  const reg = (key, type, def, scope = "world", extra = {}) => game.settings.register(MOD, SK(key), {
    name: `RP.Settings.${key}.Name`, hint: `RP.Settings.${key}.Hint`,
    scope, config: true, type, default: def, ...extra
  });
  reg("enabled", Boolean, true);
  reg("timeout", Number, 30, "world", { range: { min: 5, max: 120, step: 5 } });
  reg("useItem", Boolean, true);
  reg("trackReactions", Boolean, true);
  reg("genericReactions", Boolean, true);
  reg("promptNPCs", Boolean, true);
  reg("hostileOnly", Boolean, true);
  reg("onlyInCombat", Boolean, false);
  reg("playSound", Boolean, true, "client");
});

Hooks.once("setup", patchActivityUse);

Hooks.once("ready", () => {
  suiteSocket.on(FEATURE, onSocket);
});

/* -------------------------------------------- */
/*  Конфигурация реакций у предметов            */
/* -------------------------------------------- */

function slug(s) {
  return String(s ?? "").toLowerCase().replace(/ё/g, "е").trim()
    .replace(/[\s_]+/g, "-").replace(/[^\p{L}\p{N}-]/gu, "").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

function findPreset(item) {
  const name = item.name ?? "";
  const names = new Set([
    slug(item.system?.identifier),
    slug(name),
    slug(name.replace(/\(.*?\)|\[.*?\]/g, "")),
    ...[...name.matchAll(/[([](.*?)[)\]]/g)].map(m => slug(m[1])),
    ...name.split(/[/|]/).map(slug)
  ]);
  names.delete("");
  return PRESETS.find(p => (!p.spellOnly || item.type === "spell") && p.keys.some(k => names.has(k))) ?? null;
}

function getReactionActivity(item) {
  const acts = item.system?.activities;
  if (!acts?.size) return null;
  return acts.find(a => a.activation?.type === "reaction") ?? null;
}

/** Итоговая настройка реакции для предмета (флаг предмета > пресет > общая реакция) или null. */
function getReactionConfig(item) {
  const activity = getReactionActivity(item);
  const custom = item.getFlag(MOD, FK("config"));
  if (custom?.trigger && custom.trigger !== "auto") {
    if (custom.trigger === "disabled") return null;
    return {
      trigger: custom.trigger, effect: custom.effect ?? "none", value: custom.value ?? "",
      attackTypes: custom.attackTypes ?? [], range: Number(custom.range) || 0,
      activityId: activity?.id ?? null, source: "custom"
    };
  }
  const preset = findPreset(item);
  if (preset) return { attackTypes: [], range: 0, value: "", ...preset, activityId: activity?.id ?? null, source: "preset" };
  if (activity && setting("genericReactions")) {
    return { trigger: "attacked", effect: "none", value: "", attackTypes: [], range: 0, activityId: activity.id, source: "generic" };
  }
  return null;
}

/* -------------------------------------------- */
/*  Проверки доступности                        */
/* -------------------------------------------- */

function isReactionUsed(actor) {
  const used = actor.getFlag(MOD, FK("used"));
  return !!used && !!game.combat && used === game.combat.id;
}

function canReact(actor) {
  if (!actor) return false;
  if (BLOCKING_STATUSES.some(s => actor.statuses?.has(s))) return false;
  if (setting("trackReactions") && isReactionUsed(actor)) return false;
  if (!setting("promptNPCs") && !actor.hasPlayerOwner) return false;
  return true;
}

function spellAvailable(item) {
  const sys = item.system;
  const actor = item.actor;
  const lvl = Number(sys.level) || 0;
  const mode = sys.method ?? sys.preparation?.mode;
  if (actor?.type === "character" && mode === "prepared" && sys.preparation?.prepared === false) return false;
  const uses = sys.uses;
  if (uses?.max && (uses.value ?? 0) <= 0) return false;
  if (lvl === 0 || ["atwill", "innate", "ritual"].includes(mode)) return true;
  for (const [key, s] of Object.entries(actor?.system?.spells ?? {})) {
    if (!s || !((s.value ?? 0) > 0)) continue;
    const slotLevel = key.startsWith("spell") ? Number(key.slice(5)) : Number(s.level) || 0;
    if (slotLevel >= lvl) return true;
  }
  return false;
}

function itemAvailable(item) {
  if (item.type === "spell") return spellAvailable(item);
  const uses = item.system?.uses;
  if (uses?.max && (uses.value ?? 0) <= 0) return false;
  return true;
}

/** Список реакций актёра, подходящих под триггер. */
function collectReactions(actor, trigger, ctx = {}) {
  const out = [];
  for (const item of actor.items) {
    const cfg = getReactionConfig(item);
    if (!cfg || cfg.trigger !== trigger) continue;
    if (trigger === "attacked" && cfg.attackTypes?.length && !cfg.attackTypes.includes(ctx.actionType)) continue;
    if (!itemAvailable(item)) continue;
    out.push({
      itemUuid: item.uuid, activityId: cfg.activityId, name: item.name, img: item.img,
      effect: cfg.effect, value: cfg.value ?? "", range: cfg.range ?? 0, source: cfg.source
    });
  }
  return out;
}

/** Кто отвечает за актёра: активный игрок-владелец, иначе активный ГМ. */
function getResponder(actor) {
  const owners = game.users.filter(u => u.active && !u.isGM && actor.testUserPermission(u, "OWNER"));
  return owners.find(u => u.character?.id === actor.id) ?? owners[0] ?? game.users.activeGM ?? null;
}

function tokenOf(actor) {
  return actor?.token?.object ?? actor?.getActiveTokens?.()[0] ?? null;
}

function areHostile(a, b) {
  const D = CONST.TOKEN_DISPOSITIONS;
  const x = a.document.disposition, y = b.document.disposition;
  return (x === D.FRIENDLY && y === D.HOSTILE) || (x === D.HOSTILE && y === D.FRIENDLY);
}

function distance(a, b) {
  try { return canvas.grid.measurePath([a.center, b.center]).distance; }
  catch { return Infinity; }
}

/* -------------------------------------------- */
/*  Триггер 1: по цели попала атака             */
/* -------------------------------------------- */

for (const hook of ["dnd5e.rollAttackV2", "dnd5e.rollAttack"]) {
  Hooks.on(hook, (rolls, data) => {
    if (!Array.isArray(rolls)) return; // старая сигнатура (item, roll) — пропускаем
    const roll = rolls[0];
    if (!roll || handledRolls.has(roll)) return;
    handledRolls.add(roll);
    const activity = data?.subject;
    if (!activity) return;
    // Функция «Авто-бой» дождётся этого, прежде чем бросать урон (Щит может превратить попадание в промах)
    shared.track(`attack:${activity.uuid}`, handleAttack(activity, roll).catch(err => console.error(`${MOD} |`, err)));
  });
}

function getActionType(activity) {
  const at = activity.actionType;
  if (typeof at === "string" && /^[mr][sw]ak$/.test(at)) return at;
  const type = activity.attack?.type ?? {};
  return `${type.value === "ranged" ? "r" : "m"}${type.classification === "spell" ? "sak" : "wak"}`;
}

async function handleAttack(activity, roll) {
  if (!setting("enabled")) return;
  if (setting("onlyInCombat") && !game.combat?.started) return;
  const attacker = activity.actor;
  const attackerToken = tokenOf(attacker);
  const actionType = getActionType(activity);
  const jobs = [];
  for (const token of game.user.targets) {
    const actor = token.actor;
    if (!actor || actor === attacker) continue;
    const ac = actor.system.attributes?.ac?.value;
    const hit = roll.isCritical || (!roll.isFumble && (ac == null || roll.total >= ac));
    if (!hit || !canReact(actor)) continue;
    const ctx = {
      type: "attacked", actionType,
      attacker: attackerToken?.name ?? attacker?.name ?? "?",
      target: token.name, item: activity.item?.name ?? "",
      total: roll.total, ac: ac ?? null, isCritical: !!roll.isCritical
    };
    const options = collectReactions(actor, "attacked", ctx);
    if (options.length) jobs.push(requestReaction(token, options, ctx));
  }
  await Promise.all(jobs);
}

/* -------------------------------------------- */
/*  Триггер 2: враг колдует заклинание          */
/* -------------------------------------------- */

function patchActivityUse() {
  const types = CONFIG.DND5E?.activityTypes ?? {};
  const patched = new WeakSet();
  for (const cfg of Object.values(types)) {
    let proto = cfg?.documentClass?.prototype;
    while (proto && !Object.hasOwn(proto, "use")) proto = Object.getPrototypeOf(proto);
    if (!proto || patched.has(proto)) continue;
    patched.add(proto);
    const original = proto.use;
    proto.use = async function (usage = {}, dialog = {}, message = {}) {
      try {
        if (this.item?.type === "spell" && this.activation?.type !== "reaction" && this.actor) {
          if (await handleSpellCast(this)) return undefined;
        }
      } catch (err) { console.error(`${MOD} |`, err); }
      return original.call(this, usage, dialog, message);
    };
  }
  if (!Object.keys(types).length) console.warn(`${MOD} | CONFIG.DND5E.activityTypes не найден — триггер заклинаний отключён.`);
}

/** @returns {Promise<boolean>} true — заклинание прервано. */
async function handleSpellCast(activity) {
  if (!setting("enabled") || !canvas?.ready) return false;
  if (setting("onlyInCombat") && !game.combat?.started) return false;
  const caster = activity.actor;
  const casterToken = tokenOf(caster);
  if (!casterToken) return false;

  const ctx = {
    type: "spellCast", caster: casterToken.name, spell: activity.item.name,
    level: Number(activity.item.system.level) || 0
  };
  const jobs = [];
  for (const token of canvas.tokens.placeables) {
    const actor = token.actor;
    if (!actor || token === casterToken || actor === caster) continue;
    if (setting("hostileOnly") && !areHostile(casterToken, token)) continue;
    if (!canReact(actor)) continue;
    const dist = distance(casterToken, token);
    const options = collectReactions(actor, "spellCast", ctx).filter(o => !o.range || dist <= o.range);
    if (options.length) jobs.push(requestReaction(token, options, ctx));
  }
  if (!jobs.length) return false;

  ui.notifications.info(t("Waiting"));
  const results = await Promise.all(jobs);
  const canceller = results.find(r => r?.accepted && r.effect === "cancel");
  if (!canceller) return false;
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor: caster }),
    content: `<div class="rp-chat rp-cancel"><i class="fa-solid fa-ban"></i> ${t("SpellCancelled", {
      spell: esc(ctx.spell), actor: esc(canceller.actorName), reaction: esc(canceller.itemName)
    })}</div>`
  });
  return true;
}

/* -------------------------------------------- */
/*  Запрос реакции (через сокет)                */
/* -------------------------------------------- */

function requestReaction(token, options, ctx) {
  const actor = token.actor;
  const user = getResponder(actor);
  if (!user) return Promise.resolve(null);
  const payload = {
    action: "prompt", requestId: foundry.utils.randomID(), userId: user.id, fromUserId: game.user.id,
    actorUuid: actor.uuid, tokenName: token.name, options, ctx
  };
  if (user.id === game.user.id) return handlePrompt(payload);
  return new Promise(resolve => {
    const timer = setTimeout(() => { pending.delete(payload.requestId); resolve(null); },
      (setting("timeout") + 120) * 1000);
    pending.set(payload.requestId, result => { clearTimeout(timer); resolve(result); });
    suiteSocket.emit(FEATURE, payload);
  });
}

async function onSocket(data) {
  if (data?.userId !== game.user.id) return;
  if (data.action === "prompt") {
    let result = null;
    try { result = await handlePrompt(data); }
    catch (err) { console.error(`${MOD} |`, err); }
    suiteSocket.emit(FEATURE, { action: "response", requestId: data.requestId, userId: data.fromUserId, result });
  } else if (data.action === "response") {
    const resolve = pending.get(data.requestId);
    pending.delete(data.requestId);
    resolve?.(data.result);
  }
}

async function handlePrompt(data) {
  const actor = await fromUuid(data.actorUuid);
  if (!actor) return null;
  const index = await showPrompt(data);
  if (index == null) return { accepted: false };
  const opt = data.options[index];
  const ok = await executeReaction(actor, opt, data);
  return ok
    ? { accepted: true, effect: opt.effect, itemName: opt.name, actorName: data.tokenName }
    : { accepted: false };
}

/* -------------------------------------------- */
/*  Окно с вопросом                             */
/* -------------------------------------------- */

function contextText(ctx) {
  if (ctx.type === "attacked") {
    if (ctx.isCritical) return t("ContextCrit", { attacker: esc(ctx.attacker), target: esc(ctx.target), item: esc(ctx.item) });
    return t("ContextAttack", {
      attacker: esc(ctx.attacker), target: esc(ctx.target), item: esc(ctx.item),
      total: ctx.total, ac: ctx.ac ?? "?"
    });
  }
  return t("ContextSpell", { caster: esc(ctx.caster), spell: esc(ctx.spell), level: ctx.level });
}

function effectText(opt) {
  const value = esc(opt.value);
  switch (opt.effect) {
    case "acBonus": return t("Effect.acBonus", { value });
    case "reduceDamage": return t("Effect.reduceDamage", { value });
    case "halveDamage": return t("Effect.halveDamage");
    case "cancel": return t("Effect.cancel");
    default: return t("Effect.none");
  }
}

function showPrompt(data) {
  const seconds = setting("timeout");
  const list = data.options.map(o => `
    <li class="rp-option">
      <img src="${esc(o.img)}" alt="">
      <div><strong>${esc(o.name)}</strong><span>${effectText(o)}</span></div>
    </li>`).join("");
  const content = `
    <div class="rp-prompt">
      <p class="rp-context">${contextText(data.ctx)}</p>
      <p class="rp-question">${t("Question", { name: esc(data.tokenName) })}</p>
      <ul class="rp-options">${list}</ul>
      <p class="rp-timer">${t("TimeLeft")} <span>${seconds}</span> ${t("Seconds")}</p>
    </div>`;
  const buttons = data.options.map((o, i) => ({ action: `r${i}`, label: o.name, icon: "fa-solid fa-bolt" }));
  buttons.push({ action: "none", label: t("Decline"), icon: "fa-solid fa-xmark", default: true });

  if (setting("playSound")) {
    try { foundry.audio.AudioHelper.play({ src: "sounds/notify.wav", volume: 0.8, autoplay: true, loop: false }, false); }
    catch { /* ignore */ }
  }

  return new Promise(resolve => {
    let done = false;
    let left = seconds;
    let interval = null;
    const finish = value => {
      if (done) return;
      done = true;
      clearInterval(interval);
      resolve(value);
    };
    const dialog = new foundry.applications.api.DialogV2({
      window: { title: t("Title"), icon: "fa-solid fa-bolt" },
      classes: ["rp-dialog"],
      position: { width: 440 },
      content, buttons, modal: false,
      submit: result => finish(typeof result === "string" && result.startsWith("r") ? Number(result.slice(1)) : null)
    });
    dialog.addEventListener("close", () => finish(null));
    dialog.render({ force: true });
    interval = setInterval(() => {
      left -= 1;
      const span = dialog.element?.querySelector(".rp-timer span");
      if (span) span.textContent = String(Math.max(left, 0));
      if (left <= 0) { finish(null); dialog.close(); }
    }, 1000);
  });
}

/* -------------------------------------------- */
/*  Выполнение реакции                          */
/* -------------------------------------------- */

async function evalFormula(formula, actor) {
  const roll = await new Roll(String(formula || "0"), actor.getRollData()).evaluate();
  return roll;
}

async function executeReaction(actor, opt, data) {
  const item = await fromUuid(opt.itemUuid);
  if (!item) return false;
  const ctx = data.ctx;

  // 1. Использовать предмет/заклинание: расход ячейки/зарядов + карточка в чат
  if (setting("useItem")) {
    const activity = opt.activityId ? item.system.activities?.get(opt.activityId) : null;
    const dialogCfg = { configure: item.type === "spell" };
    let used;
    try {
      used = await shared.during("reaction-use", async () => {
        if (activity) return activity.use({}, dialogCfg, {});
        if (typeof item.use === "function") return item.use({}, dialogCfg, {});
        return true;
      });
    } catch (err) {
      console.error(`${MOD} |`, err);
      used = null;
    }
    if (!used) {
      ui.notifications.warn(t("UseFailed", { name: item.name }));
      return false;
    }
  }

  // 2. Отметить, что реакция в этом раунде потрачена
  if (setting("trackReactions") && game.combat && actor.inCombat) {
    await actor.setFlag(MOD, FK("used"), game.combat.id);
  }

  Hooks.callAll("rpgSuite.reactionUsed", actor, item);

  // 3. Применить эффект
  let outcome = "";
  switch (opt.effect) {
    case "acBonus": {
      const roll = await evalFormula(opt.value || "5", actor);
      const bonus = roll.total;
      const combat = game.combat;
      // Foundry v14: изменения эффекта лежат в system.changes, режим задаётся строкой type.
      // Длительность ведём сами (флаг expiresOnTurnStart), поэтому формат duration не нужен.
      const [eff] = await actor.createEmbeddedDocuments("ActiveEffect", [{
        name: `${item.name} (+${bonus} ${t("AC")})`,
        img: item.img,
        origin: item.uuid,
        system: { changes: [{ key: "system.attributes.ac.bonus", type: "add", value: `+${bonus}` }] },
        flags: { [MOD]: { rp: { expiresOnTurnStart: true } } }
      }]);
      // Вне боя бонус держится один раунд — 6 секунд
      if (!combat && eff) setTimeout(() => { if (actor.effects.has(eff.id)) eff.delete().catch(() => {}); }, 6000);
      if (ctx.type === "attacked") {
        const newAC = (Number(ctx.ac) || 0) + bonus;
        if (ctx.isCritical) outcome = t("Outcome.critStillHits");
        else if (ctx.ac != null && ctx.total < newAC) outcome = t("Outcome.nowMiss", { total: ctx.total, ac: newAC });
        else outcome = t("Outcome.stillHit", { total: ctx.total, ac: newAC });
      } else outcome = t("Outcome.acBonus", { value: bonus });
      break;
    }
    case "reduceDamage": {
      const roll = await evalFormula(opt.value || "0", actor);
      await roll.toMessage({
        speaker: ChatMessage.getSpeaker({ actor }),
        flavor: `${esc(item.name)} — ${t("ReductionFlavor")}`
      });
      await actor.setFlag(MOD, FK("damageMod"), { type: "reduce", value: roll.total, source: item.name });
      outcome = t("Outcome.reduce", { value: roll.total });
      break;
    }
    case "halveDamage":
      await actor.setFlag(MOD, FK("damageMod"), { type: "halve", source: item.name });
      outcome = t("Outcome.halve");
      break;
    case "cancel":
      outcome = t("Outcome.cancel", { spell: esc(ctx.spell ?? "") });
      break;
    default:
      outcome = t("Outcome.manual");
  }

  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content: `<div class="rp-chat"><i class="fa-solid fa-bolt"></i> ${t("Used", {
      name: esc(data.tokenName), reaction: esc(item.name)
    })} ${outcome}</div>`
  });
  return true;
}

/* -------------------------------------------- */
/*  Модификация урона (отражение / уклонение)   */
/* -------------------------------------------- */

const isNonDamage = (type) => type in (CONFIG.DND5E?.healingTypes ?? { healing: 1, temphp: 1 });

Hooks.on("dnd5e.preCalculateDamage", (actor, damages) => {
  const mod = actor?.getFlag?.(MOD, FK("damageMod"));
  if (!mod || !Array.isArray(damages)) return;
  const parts = damages.filter(d => !isNonDamage(d.type) && d.value > 0);
  if (!parts.length) return;
  if (mod.type === "halve") {
    for (const d of parts) d.value = Math.floor(d.value / 2);
  } else if (mod.type === "reduce") {
    let left = Number(mod.value) || 0;
    for (const d of parts) {
      if (left <= 0) break;
      const cut = Math.min(d.value, left);
      d.value -= cut;
      left -= cut;
    }
  }
});

Hooks.on("dnd5e.applyDamage", (actor, amount) => {
  const mod = actor?.getFlag?.(MOD, FK("damageMod"));
  if (!mod || amount < 0 || !actor.isOwner) return;
  actor.unsetFlag(MOD, FK("damageMod"));
  ui.notifications.info(t("DamageModApplied", { name: actor.name, source: mod.source ?? "" }));
});

/* -------------------------------------------- */
/*  Сброс реакции в начале своего хода          */
/* -------------------------------------------- */

async function cleanupActor(actor) {
  if (!actor) return;
  if (actor.getFlag(MOD, FK("used"))) await actor.unsetFlag(MOD, FK("used"));
  if (actor.getFlag(MOD, FK("damageMod"))) await actor.unsetFlag(MOD, FK("damageMod"));
  const ids = actor.effects.filter(e => e.getFlag(MOD, FK("expiresOnTurnStart"))).map(e => e.id);
  if (ids.length) await actor.deleteEmbeddedDocuments("ActiveEffect", ids);
}

Hooks.on("updateCombat", (combat, changed) => {
  if (!game.users.activeGM?.isSelf) return;
  if (!("turn" in changed || "round" in changed)) return;
  cleanupActor(combat.combatant?.actor).catch(err => console.error(`${MOD} |`, err));
});

Hooks.on("deleteCombat", combat => {
  if (!game.users.activeGM?.isSelf) return;
  for (const c of combat.combatants) cleanupActor(c.actor).catch(err => console.error(`${MOD} |`, err));
});

/* -------------------------------------------- */
/*  Окно настройки реакции у предмета           */
/* -------------------------------------------- */

async function configureItem(item) {
  if (!item?.isOwner) return;
  const cur = item.getFlag(MOD, FK("config")) ?? {};
  const preset = findPreset(item);
  const autoLabel = preset
    ? t("Config.autoPreset", { trigger: t(`Trigger.${preset.trigger}`), effect: t(`EffectName.${preset.effect}`) })
    : (getReactionActivity(item) ? t("Config.autoGeneric") : t("Config.autoNone"));

  const opt = (value, label, selected) => `<option value="${value}" ${selected ? "selected" : ""}>${label}</option>`;
  const trig = cur.trigger ?? "auto";
  const triggerSel = [
    opt("auto", autoLabel, trig === "auto"),
    ...TRIGGERS.map(k => opt(k, t(`Trigger.${k}`), trig === k)),
    opt("disabled", t("Trigger.disabled"), trig === "disabled")
  ].join("");
  const effectSel = EFFECTS.map(k => opt(k, t(`EffectName.${k}`), (cur.effect ?? "none") === k)).join("");
  const types = cur.attackTypes ?? [];
  const typeBoxes = ATTACK_TYPES.map(k => `
    <label class="rp-check"><input type="checkbox" name="at_${k}" ${types.includes(k) ? "checked" : ""}> ${t(`AttackType.${k}`)}</label>`).join("");

  const content = `
    <div class="rp-config">
      <p class="hint">${t("Config.hint")}</p>
      <div class="form-group"><label>${t("Config.trigger")}</label><select name="trigger">${triggerSel}</select></div>
      <div class="form-group"><label>${t("Config.effect")}</label><select name="effect">${effectSel}</select></div>
      <div class="form-group"><label>${t("Config.value")}</label>
        <input type="text" name="value" value="${esc(cur.value ?? "")}" placeholder="5 / 1d10 + @abilities.dex.mod"></div>
      <div class="form-group"><label>${t("Config.attackTypes")}</label><div class="rp-checks">${typeBoxes}</div></div>
      <div class="form-group"><label>${t("Config.range")}</label>
        <input type="number" name="range" value="${Number(cur.range) || 0}" min="0" step="5"></div>
    </div>`;

  const data = await foundry.applications.api.DialogV2.input({
    window: { title: `${t("Config.title")}: ${item.name}`, icon: "fa-solid fa-bolt" },
    position: { width: 480 },
    content,
    ok: { label: t("Config.save"), icon: "fa-solid fa-floppy-disk" },
    rejectClose: false
  });
  if (!data) return;
  await item.setFlag(MOD, FK("config"), {
    trigger: data.trigger, effect: data.effect, value: String(data.value ?? "").trim(),
    attackTypes: ATTACK_TYPES.filter(k => data[`at_${k}`]),
    range: Number(data.range) || 0
  });
  ui.notifications.info(t("Config.saved", { name: item.name }));
}

// Кнопка в заголовке листа предмета (ApplicationV2)
Hooks.on("getHeaderControlsApplicationV2", (app, controls) => {
  const doc = app.document;
  if (!(doc instanceof Item) || !doc.isOwner || !doc.actor && !game.user.isGM) return;
  if (controls.some(c => c.action === "rpConfigure")) return;
  app.options.actions ??= {};
  app.options.actions.rpConfigure = function () { configureItem(this.document); };
  controls.push({ action: "rpConfigure", icon: "fa-solid fa-bolt", label: t("Config.title"), onClick: () => configureItem(doc) });
});

// Кнопка в заголовке листа предмета (старые листы ApplicationV1)
Hooks.on("getItemSheetHeaderButtons", (app, buttons) => {
  const doc = app.document ?? app.item;
  if (!doc?.isOwner) return;
  buttons.unshift({ label: t("Config.short"), class: "rp-configure", icon: "fa-solid fa-bolt", onclick: () => configureItem(doc) });
});
