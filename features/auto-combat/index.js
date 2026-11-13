/**
 * Auto Combat 5e
 * Foundry VTT v12/v13, система dnd5e 4.x / 5.x
 *
 * 1) Атака по цели: попадание считается по КД цели, после броска урона
 *    урон (с учётом сопротивлений/иммунитетов) списывается автоматически.
 * 2) Способности со спасброском (конусы, AoE): все токены в шаблоне
 *    (или выбранные цели, если шаблона нет) получают запрос на спасбросок
 *    в чате. Монстры кидают автоматически. При провале — полный урон,
 *    при успехе — половина / ничего (как указано в способности).
 */

import { SUITE_ID } from "../../core/constants.js";
import { suiteSocket } from "../../core/socket.js";
import { shared } from "../../core/shared.js";
import { createFeatureHooks } from "../../core/feature-hooks.js";

/** Функция «Авто-бой» внутри RPG Suite.
 *  Настройки: "rpg-tools-by-hibear.ac-*", флаги сообщений: flags["rpg-tools-by-hibear"].ac.*, сокет: suiteSocket "combat". */
const MOD = SUITE_ID;
const FEATURE = "combat";
const SK = (k) => `ac-${k}`;
const FLAG = (k) => `ac.${k}`;
const Hooks = createFeatureHooks();

export function setup() {
  Hooks.activate();
}

const TEN_MIN = 10 * 60 * 1000;

/* ------------------------------------------------------------------ */
/*  Утилиты                                                            */
/* ------------------------------------------------------------------ */

const setting = (key) => game.settings.get(MOD, SK(key));
const isActiveGM = () => (game.users.activeGM ? game.users.activeGM.isSelf : game.user.isGM);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const authorId = (message) => message.author?.id ?? message.user?.id;
/* dnd5e 5.3 хранит данные броска во флагах, dnd5e 6.x — в типе сообщения и message.system.
 * Читаем оба варианта, чтобы работало на любой системе под Foundry v14. */
/** В Foundry v14 «режим броска» стал «режимом видимости сообщения» (core.messageMode) */
const currentRollMode = () => {
  try { return game.settings.get("core", "messageMode"); } catch (e) { /* v13-совместимый мир */ }
  try { return game.settings.get("core", "rollMode"); } catch (e) { return undefined; }
};
const ROLL_TYPES = new Set(["attack", "damage", "healing"]);
const isDnd6 = () => foundry.utils.isNewerVersion(game.system?.version ?? "0", "5.99");
const rollType = (message) =>
  message.getFlag("dnd5e", "roll")?.type ?? (ROLL_TYPES.has(message.type) ? message.type : undefined);
const activityUuidOf = (message) =>
  message.getFlag("dnd5e", "activity")?.uuid ?? message.system?.activity?.uuid;
const originOf = (message) => {
  const flag = message.getFlag("dnd5e", "originatingMessage");
  if (flag) return flag;
  const o = message.system?.origin;
  return typeof o === "string" ? o : o?.id ?? null;
};
/** Цели броска: { uuid (актёр), ac, name, img, token } — одинаково для dnd5e 5.3 и 6.x */
const targetsOf = (message) => {
  const list = message.getFlag("dnd5e", "targets") ?? message.system?.targets ?? [];
  return Array.from(list, (t) => ({ ...t, uuid: t.uuid ?? t.actor ?? t.token, ac: t.ac ?? null }));
};
/** Данные сообщения, которые связывают бросок урона с исходной карточкой */
const originMessageData = (id) => (!id ? {} : isDnd6()
  ? { data: { system: { origin: id } } }
  : { data: { flags: { dnd5e: { originatingMessage: id } } } });

// Все операции ГМа выполняются строго по очереди, чтобы не было гонок при обновлении карточек.
let gmQueue = Promise.resolve();
function enqueue(fn) {
  gmQueue = gmQueue.then(fn).catch((err) => console.error(`${MOD} |`, err));
  return gmQueue;
}

async function resolveActivity(message) {
  try {
    const a = message.getAssociatedActivity?.();
    if (a) return a;
  } catch (e) { /* ignore */ }
  const uuid = activityUuidOf(message);
  return uuid ? await fromUuid(uuid) : null;
}

/** Цель из флагов dnd5e может быть uuid актёра или токена — приводим к актёру. */
async function actorFromUuid(uuid) {
  const doc = uuid ? await fromUuid(uuid) : null;
  if (!doc) return null;
  if (doc.documentName === "Token") return doc.actor;
  return doc.documentName === "Actor" ? doc : doc.actor ?? null;
}

function abilityLabel(key) {
  return CONFIG.DND5E?.abilities?.[key]?.label ?? key?.toUpperCase() ?? "?";
}

function damageTypeLabel(key) {
  const t = CONFIG.DND5E?.damageTypes?.[key] ?? CONFIG.DND5E?.healingTypes?.[key];
  return t?.label ?? key ?? "";
}

function describeDamages(damages) {
  return damages.map((d) => `${d.value} ${damageTypeLabel(d.type)}`.trim()).join(" + ");
}

/** Броски урона → формат DamageDescription для actor.applyDamage (учитывает сопротивления). */
function buildDamages(rolls) {
  return (rolls ?? [])
    .filter((r) => Number.isFinite(r.total))
    .map((r) => ({
      value: r.total,
      type: r.options?.type ?? r.options?.types?.[0] ?? "",
      properties: Array.from(r.options?.properties ?? [])
    }));
}

function emitToGM(data) {
  if (isActiveGM()) return enqueue(() => gmHandleSocket(data));
  if (!game.users.activeGM) {
    ui.notifications.warn("Авто-бой: нет ГМа онлайн — урон не будет применён автоматически.");
    return;
  }
  suiteSocket.emit(FEATURE, data);
}

/* ------------------------------------------------------------------ */
/*  Настройки                                                          */
/* ------------------------------------------------------------------ */

Hooks.once("init", () => {
  const reg = (key, data) => game.settings.register(MOD, SK(key), { config: true, ...data, name: `Авто-бой · ${data.name}` });

  reg("attacks", {
    name: "Авто-урон по атакам",
    hint: "После броска урона урон автоматически списывается с целей, по которым атака попала (по КД).",
    scope: "world", type: Boolean, default: true
  });
  reg("saves", {
    name: "Авто-спасброски для AoE/конусов",
    hint: "Все в шаблоне (или выбранные цели) получают запрос на спасбросок; провалившие получают урон автоматически.",
    scope: "world", type: Boolean, default: true
  });
  reg("damageOnly", {
    name: "Урон/лечение без атаки",
    hint: "Способности только с уроном или лечением (например, Волшебная стрела, Лечение ран) применяются ко всем выбранным целям.",
    scope: "world", type: Boolean, default: true
  });
  reg("autoNpcSaves", {
    name: "Монстры кидают спасброски сами",
    hint: "Если у цели нет игрока-владельца онлайн, спасбросок бросается автоматически.",
    scope: "world", type: Boolean, default: true
  });
  reg("npcSaveRollMode", {
    name: "Видимость спасбросков монстров",
    scope: "world", type: String, default: "gmroll",
    choices: { publicroll: "Публично", gmroll: "Только ГМу", blindroll: "Вслепую" }
  });
  reg("excludeCaster", {
    name: "Не задевать заклинателя шаблоном",
    hint: "Токен того, кто применил способность, не попадает в свой же шаблон.",
    scope: "world", type: Boolean, default: true
  });
  reg("summaryMode", {
    name: "Сводка об уроне в чате",
    hint: "Сообщение со списком нанесённого урона и кнопкой «Отменить» (кнопка видна только ГМу).",
    scope: "world", type: String, default: "gm",
    choices: { gm: "ГМу и атакующему", public: "Всем", none: "Не показывать" }
  });
  reg("gmReport", {
    name: "Отчёт мастеру о бросках",
    hint: "Шёпотом мастеру в чат: кто бросил атаку, сколько выпало и какой КД у цели; кто бросил спасбросок, сколько выпало и какая СЛ. Игроки эти сообщения не видят.",
    scope: "world", type: Boolean, default: true
  });
  reg("autoRollDamage", {
    name: "Автоматически бросать урон",
    hint: "После попадания атакой или применения AoE урон бросается сам, без нажатия кнопки «Урон».",
    scope: "client", type: Boolean, default: true
  });
});

Hooks.once("ready", () => {
  suiteSocket.on(FEATURE, (data) => {
    if (!isActiveGM()) return;
    enqueue(() => gmHandleSocket(data));
  });
  console.log(`${MOD} | ready`);
});

/* ------------------------------------------------------------------ */
/*  Клиент игрока: AoE / спасброски                                   */
/* ------------------------------------------------------------------ */

Hooks.on("dnd5e.postUseActivity", async (activity, usageConfig, results) => {
  try {
    if (!setting("saves") || activity?.type !== "save") return;
    // Способность применена через окно «Реакции» — карточку спасбросков не создаём, это решает мастер
    if (shared.busy("reaction-use")) return;

    const usageMessage = results?.message;
    const templates = results?.templates ?? [];

    let tokens = [];
    if (templates.length) {
      for (const t of templates) tokens.push(...(await getTokensInArea(t)));
    } else {
      tokens = Array.from(game.user.targets);
    }

    // Убираем дубликаты и заклинателя
    const casterTokenIds = new Set((activity.actor?.getActiveTokens?.() ?? []).map((t) => t.id));
    const seen = new Set();
    tokens = tokens.filter((t) => {
      if (!t?.actor || seen.has(t.document.uuid)) return false;
      seen.add(t.document.uuid);
      return !(setting("excludeCaster") && casterTokenIds.has(t.id));
    });

    if (!tokens.length) {
      ui.notifications.info("Авто-бой: в области нет целей.");
      return;
    }

    const abilities = Array.from(activity.save?.ability ?? []);
    const hasDamage = (activity.damage?.parts?.length ?? 0) > 0;

    emitToGM({
      action: "saveRequest",
      originMessageId: usageMessage?.id ?? null,
      activityUuid: activity.uuid,
      userId: game.user.id,
      title: activity.item?.name ?? activity.name,
      ability: abilities[0] ?? "dex",
      dc: activity.save?.dc?.value ?? 10,
      onSave: activity.damage?.onSave ?? "half",
      hasDamage,
      targets: tokens.map((t) => ({
        tokenUuid: t.document.uuid,
        name: t.name,
        img: t.document.texture?.src ?? t.actor.img
      }))
    });

    if (hasDamage && setting("autoRollDamage")) {
      await autoRollDamage(activity, usageMessage?.id, false);
    }
  } catch (err) {
    console.error(`${MOD} | postUseActivity`, err);
  }
});

/**
 * Токены внутри области заклинания. В Foundry v14 шаблоны стали Регионами (RegionDocument):
 * dnd5e 6.x возвращает регионы, dnd5e 5.3 — объекты шаблона. Поддерживаем оба варианта.
 */
async function getTokensInArea(area) {
  const doc = area?.document ?? area;
  if (doc?.documentName === "Region") return getTokensInRegion(doc);
  return getTokensInTemplate(doc);
}

/** Ждём, пока регион появится на канвасе, и собираем токены, которые в него попадают. */
async function getTokensInRegion(regionDoc) {
  for (let i = 0; i < 40; i++) {
    if (regionDoc.object || regionDoc.tokens?.size) break;
    await sleep(50);
  }
  const elevationOf = (t) => t.document.elevation ?? 0;
  const inside = (t, p) => {
    const point = { x: p.x, y: p.y, elevation: elevationOf(t) };
    try { if (typeof regionDoc.testPoint === "function") return regionDoc.testPoint(point); } catch (e) { /* другой API */ }
    try { if (typeof regionDoc.object?.testPoint === "function") return regionDoc.object.testPoint(point, point.elevation); } catch (e) { /* ignore */ }
    try { return !!regionDoc.polygonTree?.testPoint?.(point); } catch (e) { return false; }
  };
  const fromSet = new Set(Array.from(regionDoc.tokens ?? [], (td) => td.id));
  return canvas.tokens.placeables.filter((t) => {
    if (!t.actor) return false;
    if (t.document.hidden && !game.user.isGM) return false;
    if (fromSet.has(t.id)) return true;
    return tokenTestPoints(t).some((p) => inside(t, p));
  });
}

/** Ждём, пока шаблон появится на канвасе, и собираем токены внутри (dnd5e 5.3). */
async function getTokensInTemplate(templateDoc) {
  if (!templateDoc) return [];
  let obj = null;
  for (let i = 0; i < 40; i++) {
    obj = templateDoc.object ?? canvas.templates?.get(templateDoc.id);
    if (obj?.shape) break;
    await sleep(50);
  }
  if (!obj?.shape) return [];
  const { x: ox, y: oy } = templateDoc;
  return canvas.tokens.placeables.filter((t) => {
    if (!t.actor) return false;
    if (t.document.hidden && !game.user.isGM) return false;
    return tokenTestPoints(t).some((p) => obj.shape.contains(p.x - ox, p.y - oy));
  });
}

/** Центр токена + центры всех клеток, которые он занимает (для крупных существ). */
function tokenTestPoints(token) {
  const points = [token.center];
  try {
    if (canvas.grid.type !== CONST.GRID_TYPES.GRIDLESS && token.document.getOccupiedGridSpaceOffsets) {
      for (const o of token.document.getOccupiedGridSpaceOffsets()) points.push(canvas.grid.getCenterPoint(o));
    }
  } catch (e) { /* старые версии API — хватит центра */ }
  return points;
}

async function autoRollDamage(activity, originMessageId, isCritical) {
  if (typeof activity?.rollDamage !== "function") return;
  await sleep(400); // даём ГМу успеть создать карточку
  const message = originMessageData(originMessageId);
  try {
    await activity.rollDamage({ isCritical }, { configure: false }, message);
  } catch (err) {
    console.warn(`${MOD} | автобросок урона не удался`, err);
  }
}

/* ------------------------------------------------------------------ */
/*  Обработка сообщений чата                                           */
/* ------------------------------------------------------------------ */

const processed = new Set();

Hooks.on("createChatMessage", (message, options, userId) => {
  const type = rollType(message);
  if (!type) return;

  // Клиент атакующего: автоматический бросок урона после попадания
  if (type === "attack" && userId === game.user.id) maybeAutoRollAfterAttack(message);

  // ГМ: подсчёт попаданий и применение урона
  if (!isActiveGM() || processed.has(message.id)) return;
  processed.add(message.id);
  if (type === "attack") enqueue(() => gmHandleAttack(message));
  else if (type === "damage" || type === "healing") enqueue(() => gmHandleDamage(message, type));
});

function attackHits(roll, ac) {
  if (roll.isFumble) return false;
  if (roll.isCritical) return true;
  return ac == null || roll.total >= ac;
}

async function maybeAutoRollAfterAttack(message) {
  try {
    if (!setting("attacks") || !setting("autoRollDamage")) return;
    const roll = message.rolls?.[0];
    const targets = targetsOf(message);
    if (!roll || !targets.length) return;
    if (!targets.some((t) => attackHits(roll, t.ac))) return;
    const activity = await resolveActivity(message);
    if (!activity?.damage?.parts?.length) return;
    // Функция «Реакции»: ждём, пока цели решат, использовать ли Щит и т.п., затем проверяем КД ещё раз
    await sleep(150);
    if (shared.has(`attack:${activity.uuid}`)) {
      await shared.wait(`attack:${activity.uuid}`);
      let stillHits = false;
      for (const t of targets) {
        const actor = await actorFromUuid(t.uuid);
        if (attackHits(roll, actor?.system?.attributes?.ac?.value ?? t.ac)) { stillHits = true; break; }
      }
      if (!stillHits) return;
    }
    await autoRollDamage(activity, originOf(message), !!roll.isCritical);
  } catch (err) {
    console.error(`${MOD} | auto damage`, err);
  }
}

/* ---------- ГМ: атаки ---------- */

const attackRecords = new Map(); // ключ: id исходной карточки ИЛИ activityUuid|userId
const orphanDamage = new Map(); // урон, пришедший раньше карточки спасбросков

async function gmHandleAttack(message) {
  if (!setting("attacks")) return;
  const roll = message.rolls?.[0];
  const targets = targetsOf(message);
  if (!roll) return;
  if (!targets.length) {
    // Цель не выбрана — КД сравнить не с чем, но мастеру всё равно покажем, сколько выпало
    if (setting("gmReport")) {
      const attacker = ChatMessage.getSpeakerActor?.(message.speaker)?.name ?? message.speaker?.alias ?? "?";
      const nat = naturalD20(roll);
      await gmReport(`🎯 Атака: ${esc(attacker)}`,
        `<p class="ac5e-report-roll">Выпало <b>${roll.total}</b>${nat != null ? ` <span class="ac5e-dim">(к20: ${nat})</span>` : ""}</p>
         <p class="ac5e-dim">Цель не выбрана (клавиша T на токене врага) — КД сравнить не с чем.</p>`);
    }
    return;
  }

  const results = [];
  for (const t of targets) {
    const actor = await actorFromUuid(t.uuid);
    if (!actor) continue;
    const ac = actor.system?.attributes?.ac?.value ?? t.ac;
    const hit = attackHits(roll, ac);
    results.push({ actorUuid: actor.uuid, name: t.name ?? actor.name, ac, hit, crit: hit && !!roll.isCritical });
  }

  if (setting("gmReport") && results.length) {
    const activity = await resolveActivity(message).catch(() => null);
    const attacker = ChatMessage.getSpeakerActor?.(message.speaker)?.name ?? message.speaker?.alias ?? message.alias ?? "?";
    const weapon = activity?.item?.name ?? activity?.name ?? "";
    const nat = naturalD20(roll);
    const rows = results.map((r) => {
      let verdict;
      if (roll.isFumble) verdict = `<span class="ac5e-miss">промах (выпала 1)</span>`;
      else if (r.crit) verdict = `<span class="ac5e-dmg">КРИТ!</span>`;
      else verdict = r.hit ? `<span class="ac5e-dmg">попадание</span>` : `<span class="ac5e-miss">промах</span>`;
      return `<li><span class="ac5e-name">${esc(r.name)}</span> КД <b>${r.ac ?? "?"}</b> — ${verdict}</li>`;
    }).join("");
    await gmReport(
      `🎯 Атака: ${esc(attacker)}${weapon ? ` — ${esc(weapon)}` : ""}`,
      `<p class="ac5e-report-roll">Выпало <b>${roll.total}</b>${nat != null ? ` <span class="ac5e-dim">(к20: ${nat})</span>` : ""}</p><ul>${rows}</ul>`
    );
  }

  const keys = [`${activityUuidOf(message)}|${authorId(message)}`];
  if (originOf(message)) keys.push(originOf(message));
  const record = { keys, time: Date.now(), results, total: roll.total,
    isCritical: !!roll.isCritical, isFumble: !!roll.isFumble };
  for (const k of keys) attackRecords.set(k, record);
}

/* ---------- ГМ: урон ---------- */

async function gmHandleDamage(message, type) {
  const damages = buildDamages(message.rolls);
  if (!damages.length) return;

  const origin = originOf(message);
  const activityUuid = activityUuidOf(message);
  const userId = authorId(message);
  const activityKey = `${activityUuid}|${userId}`;
  const activity = await resolveActivity(message);

  // 1. Урон для карточки спасбросков
  if (setting("saves") && type === "damage") {
    const card = findSaveCard(origin, activityUuid, userId);
    if (card) return gmAttachDamageToCard(card, damages);
    if (activity?.type === "save") {
      const entry = { damages, time: Date.now() };
      orphanDamage.set(activityKey, entry);
      if (origin) orphanDamage.set(origin, entry);
      return;
    }
  }

  // 2. Урон после атаки — только по тем, в кого попали
  const record = (origin && attackRecords.get(origin)) ?? attackRecords.get(activityKey);
  if (record && Date.now() - record.time < TEN_MIN && setting("attacks") && type === "damage") {
    for (const k of record.keys) attackRecords.delete(k);
    // КД мог измениться после броска атаки (реакция «Щит» и т.п.) — пересчитываем попадания
    const rollLike = { total: record.total, isCritical: record.isCritical, isFumble: record.isFumble };
    for (const r of record.results) {
      const a = await fromUuid(r.actorUuid);
      const ac = a?.system?.attributes?.ac?.value ?? r.ac;
      r.hit = attackHits(rollLike, ac);
      r.crit = r.hit && !!record.isCritical;
    }
    const hits = record.results.filter((r) => r.hit);
    const misses = record.results.filter((r) => !r.hit);
    const applied = [];
    for (const h of hits) {
      const actor = await fromUuid(h.actorUuid);
      if (actor) applied.push(await applyDamageTo(actor, damages, 1, h.crit ? "крит!" : null));
    }
    for (const m of misses) applied.push({ name: m.name, note: "промах", delta: 0 });
    return postSummary(activity, damages, applied, userId);
  }

  // 3. Урон/лечение без атаки и спасброска — по выбранным целям
  if (setting("damageOnly") && ["damage", "heal"].includes(activity?.type)) {
    const targets = targetsOf(message);
    if (!targets.length) return;
    const applied = [];
    for (const t of targets) {
      const actor = await actorFromUuid(t.uuid);
      if (actor) applied.push(await applyDamageTo(actor, damages, 1));
    }
    return postSummary(activity, damages, applied, userId);
  }
}

/** Применение урона с сохранением HP «до» для кнопки отмены. */
async function applyDamageTo(actor, damages, multiplier, note = null) {
  const hp = actor.system?.attributes?.hp ?? {};
  const before = { value: hp.value ?? 0, temp: hp.temp ?? 0 };
  try {
    await actor.applyDamage(damages, { multiplier });
  } catch (err) {
    // Фолбэк для старых версий системы: просто число
    const total = damages.reduce((s, d) => s + d.value, 0);
    await actor.applyDamage(total, multiplier);
  }
  const hpAfter = actor.system?.attributes?.hp ?? {};
  const delta = (before.value + before.temp) - ((hpAfter.value ?? 0) + (hpAfter.temp ?? 0));
  return { uuid: actor.uuid, name: actor.name, before, delta, note };
}

async function postSummary(activity, damages, applied, attackerId) {
  const mode = setting("summaryMode");
  if (mode === "none" || !applied.length) return;

  const rows = applied.map((a) => {
    let value;
    if (a.note === "промах") value = `<span class="ac5e-miss">промах</span>`;
    else if (a.delta > 0) value = `<span class="ac5e-dmg">−${a.delta} HP</span>`;
    else if (a.delta < 0) value = `<span class="ac5e-heal">+${-a.delta} HP</span>`;
    else value = `<span class="ac5e-zero">без урона</span>`;
    const extra = a.note && a.note !== "промах" ? ` <em>(${esc(a.note)})</em>` : "";
    return `<li><span class="ac5e-name">${esc(a.name)}</span>${extra} ${value}</li>`;
  }).join("");

  const undo = applied.filter((a) => a.uuid).map((a) => ({ uuid: a.uuid, ...a.before }));
  const content = `
    <div class="ac5e-card ac5e-summary">
      <header>⚔ ${esc(activity?.item?.name ?? activity?.name ?? "Урон")}: ${esc(describeDamages(damages))}</header>
      <ul>${rows}</ul>
      ${undo.length ? `<button type="button" class="ac5e-undo" data-ac5e-action="undo">Отменить урон</button>` : ""}
    </div>`;

  const data = {
    content,
    speaker: { alias: "Auto Combat" },
    flags: { [MOD]: { ac: { undo, undone: false } } }
  };
  if (mode === "gm") {
    data.whisper = [...new Set([...game.users.filter((u) => u.isGM).map((u) => u.id), attackerId].filter(Boolean))];
  }
  await ChatMessage.create(data);
}

/* ------------------------------------------------------------------ */
/*  ГМ: карточка спасбросков                                           */
/* ------------------------------------------------------------------ */

async function gmHandleSocket(data) {
  switch (data?.action) {
    case "saveRequest": return gmCreateSaveCard(data);
    case "saveResult": return gmApplySaveResult(data);
  }
}

function findSaveCard(origin, activityUuid, userId) {
  const recent = game.messages.contents.slice(-100).reverse();
  return recent.find((m) => {
    const s = m.getFlag(MOD, FLAG("saveCard"));
    if (!s || s.damages) return false;
    if (origin && s.originMessageId === origin) return true;
    return s.activityUuid === activityUuid && s.userId === userId && Date.now() - s.time < TEN_MIN;
  }) ?? null;
}

async function gmCreateSaveCard(req) {
  const targets = [];
  for (const t of req.targets) {
    const tokenDoc = await fromUuid(t.tokenUuid);
    const actor = tokenDoc?.actor;
    if (!actor) continue;
    const hasActivePlayer = game.users.some((u) => !u.isGM && u.active && actor.testUserPermission(u, "OWNER"));
    targets.push({
      tokenUuid: t.tokenUuid,
      actorUuid: actor.uuid,
      name: t.name ?? tokenDoc.name,
      img: t.img,
      isPlayer: hasActivePlayer,
      status: "pending", // pending | success | fail
      total: null,
      applied: false,
      delta: null
    });
  }
  if (!targets.length) return;

  const state = {
    originMessageId: req.originMessageId,
    activityUuid: req.activityUuid,
    userId: req.userId,
    title: req.title,
    ability: req.ability,
    dc: req.dc,
    onSave: req.onSave,
    hasDamage: req.hasDamage,
    damages: null,
    time: Date.now(),
    targets
  };

  // Урон мог прийти раньше карточки
  const orphanKey = [req.originMessageId, `${req.activityUuid}|${req.userId}`].find((k) => k && orphanDamage.has(k));
  if (orphanKey) {
    const o = orphanDamage.get(orphanKey);
    if (Date.now() - o.time < TEN_MIN) state.damages = o.damages;
    orphanDamage.delete(req.originMessageId);
    orphanDamage.delete(`${req.activityUuid}|${req.userId}`);
  }

  const activity = await fromUuid(req.activityUuid).catch(() => null);
  const message = await ChatMessage.create({
    content: renderSaveCard(state),
    speaker: ChatMessage.getSpeaker({ actor: activity?.actor }),
    flags: { [MOD]: { ac: { saveCard: state } } }
  });

  // Монстры (и персонажи без игрока онлайн) кидают сами
  if (setting("autoNpcSaves")) {
    for (const t of state.targets) {
      if (t.isPlayer) continue;
      const actor = await fromUuid(t.actorUuid);
      const total = actor ? await rollSave(actor, state.ability, state.dc, setting("npcSaveRollMode")) : null;
      if (total != null) setSaveResult(t, total, state.dc);
    }
    await reportSaves(state, state.targets.filter((t) => !t.isPlayer));
  }
  await resolveAndUpdate(message, state);
}

async function gmAttachDamageToCard(message, damages) {
  const state = foundry.utils.deepClone(message.getFlag(MOD, FLAG("saveCard")));
  state.damages = damages;
  await resolveAndUpdate(message, state);
}

async function gmApplySaveResult({ messageId, tokenUuid, total }) {
  const message = game.messages.get(messageId);
  const state = foundry.utils.deepClone(message?.getFlag(MOD, FLAG("saveCard")));
  if (!state) return;
  const t = state.targets.find((x) => x.tokenUuid === tokenUuid);
  if (!t || t.status !== "pending") return;
  setSaveResult(t, total, state.dc);
  await reportSaves(state, [t]);
  await resolveAndUpdate(message, state);
}

/* ---------- ГМ: отчёт о бросках (шёпотом мастерам) ---------- */

/** Число на к20 (без модификаторов), если его можно достать из броска */
function naturalD20(roll) {
  const die = roll?.dice?.find?.((d) => d.faces === 20);
  return die ? die.total : null;
}

async function gmReport(header, body) {
  const gms = game.users.filter((u) => u.isGM).map((u) => u.id);
  if (!gms.length) return;
  await ChatMessage.create({
    content: `<div class="ac5e-card ac5e-report"><header>${header}</header>${body}</div>`,
    speaker: { alias: "Авто-бой" },
    whisper: gms
  });
}

async function reportSaves(state, targets) {
  if (!setting("gmReport")) return;
  const done = targets.filter((t) => t.total != null);
  if (!done.length) return;
  const rows = done.map((t) => {
    const ok = t.status === "success";
    return `<li><span class="ac5e-name">${esc(t.name)}</span> выкинул <b>${t.total}</b> —
      <span class="${ok ? "ac5e-heal" : "ac5e-dmg"}">${ok ? "успех" : "провал"}</span></li>`;
  }).join("");
  await gmReport(
    `🛡 Спасбросок ${esc(abilityLabel(state.ability))} — СЛ <b>${state.dc}</b>${state.title ? ` <span class="ac5e-dim">(${esc(state.title)})</span>` : ""}`,
    `<ul>${rows}</ul>`
  );
}

function setSaveResult(target, total, dc) {
  target.total = total;
  target.status = total >= dc ? "success" : "fail";
}

/** Наносит урон всем, у кого уже есть результат спасброска и известен урон. */
async function resolveAndUpdate(message, state) {
  const applied = [];
  for (const t of state.targets) {
    if (t.applied || t.status === "pending") continue;
    if (!state.hasDamage) { t.applied = true; continue; }
    if (!state.damages) continue;

    const mult = t.status === "fail" ? 1 : ({ half: 0.5, full: 1 }[state.onSave] ?? 0);
    const actor = await fromUuid(t.actorUuid);
    if (actor && mult > 0) {
      const res = await applyDamageTo(actor, state.damages, mult, t.status === "success" ? "успех" : "провал");
      t.delta = res.delta;
      applied.push(res);
    } else {
      t.delta = 0;
      applied.push({ name: t.name, delta: 0, note: "успех" });
    }
    t.applied = true;
  }

  await message.update({
    content: renderSaveCard(state),
    [`flags.${MOD}.ac.saveCard`]: state
  });

  if (applied.length) {
    const activity = await fromUuid(state.activityUuid).catch(() => null);
    await postSummary(activity, state.damages, applied, state.userId);
  }
}

function renderSaveCard(state) {
  const onSaveText = { half: "половина урона", none: "без урона", full: "полный урон" }[state.onSave] ?? "";
  let dmgLine;
  if (!state.hasDamage) dmgLine = "Без урона";
  else if (!state.damages) dmgLine = `<em>Ожидается бросок урона…</em>`;
  else dmgLine = `Урон: <strong>${esc(describeDamages(state.damages))}</strong>`;

  const rows = state.targets.map((t) => {
    let status;
    if (t.status === "pending") {
      status = `<button type="button" class="ac5e-roll" data-ac5e-action="save" data-token-uuid="${esc(t.tokenUuid)}">🎲 Бросить</button>`;
    } else {
      const ok = t.status === "success";
      const dmg = t.applied && t.delta != null ? ` · <span class="ac5e-dmg">${t.delta > 0 ? `−${t.delta} HP` : "0"}</span>` : "";
      status = `<span class="${ok ? "ac5e-ok" : "ac5e-fail"}">${ok ? "Успех" : "Провал"} (${t.total})</span>${dmg}`;
    }
    return `<li class="ac5e-target">
        <img src="${esc(t.img)}" width="28" height="28"/>
        <span class="ac5e-name">${esc(t.name)}</span>
        <span class="ac5e-status">${status}</span>
      </li>`;
  }).join("");

  const anyPending = state.targets.some((t) => t.status === "pending");
  return `
    <div class="ac5e-card ac5e-save-card">
      <header>${esc(state.title)}</header>
      <div class="ac5e-save-info">Спасбросок <strong>${esc(abilityLabel(state.ability))}</strong>, СЛ <strong>${state.dc}</strong>
        ${state.hasDamage ? `<br/>При успехе: ${onSaveText}` : ""}</div>
      <div class="ac5e-save-info">${dmgLine}</div>
      <ul class="ac5e-targets">${rows}</ul>
      ${anyPending ? `<button type="button" class="ac5e-gm-only" data-ac5e-action="save-all">Бросить за всех оставшихся (ГМ)</button>` : ""}
    </div>`;
}

/** Совместимо с dnd5e 4.x/5.x (rollSavingThrow) и старым rollAbilitySave. */
async function rollSave(actor, ability, dc, rollMode) {
  let res;
  try {
    if (typeof actor.rollSavingThrow === "function") {
      res = await actor.rollSavingThrow({ ability, target: dc }, { configure: false }, { rollMode });
    } else if (typeof actor.rollAbilitySave === "function") {
      res = await actor.rollAbilitySave(ability, { fastForward: true, targetValue: dc, rollMode });
    }
  } catch (err) {
    console.error(`${MOD} | save roll`, err);
  }
  const roll = Array.isArray(res) ? res[0] : res;
  return Number.isFinite(roll?.total) ? roll.total : null;
}

/* ------------------------------------------------------------------ */
/*  Кнопки в чате                                                     */
/* ------------------------------------------------------------------ */

function activateCard(message, html) {
  const root = html instanceof HTMLElement ? html : html?.[0];
  if (!root) return;

  // Кнопки бросков видят только владельцы токена и ГМ
  root.querySelectorAll("[data-ac5e-action='save']").forEach((btn) => {
    const actor = fromUuidSync(btn.dataset.tokenUuid)?.actor;
    if (!game.user.isGM && !actor?.isOwner) btn.remove();
  });
  if (!game.user.isGM) root.querySelectorAll(".ac5e-gm-only, .ac5e-undo").forEach((b) => b.remove());
  if (message.getFlag(MOD, FLAG("undone"))) root.querySelectorAll(".ac5e-undo").forEach((b) => b.remove());

  root.querySelectorAll("[data-ac5e-action]").forEach((btn) => {
    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      btn.disabled = true;
      onCardButton(message, btn).finally(() => (btn.disabled = false));
    });
  });
}

async function onCardButton(message, btn) {
  const action = btn.dataset.ac5eAction;
  const state = message.getFlag(MOD, FLAG("saveCard"));

  if (action === "save" && state) {
    const t = state.targets.find((x) => x.tokenUuid === btn.dataset.tokenUuid);
    if (!t || t.status !== "pending") return;
    const actor = await fromUuid(t.actorUuid);
    if (!actor?.isOwner) return ui.notifications.warn("Это не ваш персонаж.");
    const total = await rollSave(actor, state.ability, state.dc, currentRollMode());
    if (total != null) emitToGM({ action: "saveResult", messageId: message.id, tokenUuid: t.tokenUuid, total });
  }

  if (action === "save-all" && state && game.user.isGM) {
    for (const t of state.targets.filter((x) => x.status === "pending")) {
      const actor = await fromUuid(t.actorUuid);
      const total = actor ? await rollSave(actor, state.ability, state.dc, setting("npcSaveRollMode")) : null;
      if (total != null) emitToGM({ action: "saveResult", messageId: message.id, tokenUuid: t.tokenUuid, total });
    }
  }

  if (action === "undo" && game.user.isGM && !message.getFlag(MOD, FLAG("undone"))) {
    for (const u of message.getFlag(MOD, FLAG("undo")) ?? []) {
      const actor = await fromUuid(u.uuid);
      await actor?.update({ "system.attributes.hp.value": u.value, "system.attributes.hp.temp": u.temp });
    }
    await message.update({
      [`flags.${MOD}.ac.undone`]: true,
      content: message.content.replace('class="ac5e-card ac5e-summary"', 'class="ac5e-card ac5e-summary ac5e-undone"')
    });
    ui.notifications.info("Урон отменён.");
  }
}

Hooks.once("init", () => {
  if ((game.release?.generation ?? 12) >= 13) Hooks.on("renderChatMessageHTML", activateCard);
  else Hooks.on("renderChatMessage", activateCard);
});
