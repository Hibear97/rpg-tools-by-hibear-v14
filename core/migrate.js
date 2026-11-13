import { SUITE_ID, OLD_SUITE_ID } from "./constants.js";

/**
 * Перенос данных из старых отдельных модулей, чтобы не пришлось заново настраивать
 * портреты, избранное, свою панель, цвета кубиков, настройки реакций у предметов и т.д.
 * Старые данные не удаляются. Каждая версия переноса выполняется один раз.
 *
 *  module       — id старого модуля
 *  flagPrefix   — куда переносятся флаги: flags["rpg-tools-by-hibear"][flagPrefix]
 *  settingPrefix— куда переносятся настройки: "rpg-tools-by-hibear.<settingPrefix>-<ключ>"
 *  paths        — старые пути к файлам модуля → новые (например, звуки по умолчанию)
 */
const LEGACY = [
  { module: "voice-portraits", flagPrefix: "vp", settingPrefix: "vp" },
  { module: "bg3-style-hud", flagPrefix: "hud", settingPrefix: "hud" },
  { module: "auto-combat-5e", flagPrefix: "ac", settingPrefix: "ac" },
  { module: "bg3-roll-requests", flagPrefix: "rr", settingPrefix: "rr",
    paths: { "modules/bg3-roll-requests/": `modules/${SUITE_ID}/features/roll-requests/` } },
  { module: "party-loot-roll", flagPrefix: "loot", settingPrefix: "loot" },
  { module: "reaction-prompts", flagPrefix: "rp", settingPrefix: "rp" },
  { module: "simple-3d-dice", flagPrefix: "dice", settingPrefix: "dice" },
  // 3.6: ещё восемь модулей
  { module: "calendar-tool", settingPrefix: "cal", noFlags: true },
  // календарь, встроенный раньше вручную по README (import "./calendar/calendar.mjs") — его настройки уже лежали под rpg-suite
  { module: OLD_SUITE_ID, settingPrefix: "cal", noFlags: true },
  { module: "dnd-vision-5e-tool", flagPrefix: "vis", settingPrefix: "vis" },
  { module: "gm-whisper", flagPrefix: "gmw", settingPrefix: "gmw" },
  { module: "initiative-bar-tool", settingPrefix: "ib", noFlags: true },
  { module: "lockpicking-tool", flagPrefix: "lp", settingPrefix: "lp" },
  { module: "mannequin-tool", flagPrefix: "mq", settingPrefix: "mq" },
  { module: "piles-tool", flagPrefix: "pt", settingPrefix: "pt" },
  { module: "sketch-notebook", flagPrefix: "nb", settingPrefix: "nb" }
];
// 4: модуль переименован rpg-suite → rpg-tools-by-hibear: переносим его собственные настройки и флаги
const VERSION = 4;
const OLD_PATH = `modules/${OLD_SUITE_ID}/`;
const NEW_PATH = `modules/${SUITE_ID}/`;

/** Пути к файлам прежней папки модуля → новая папка (рекурсивно по объектам и массивам) */
function fixSuitePaths(v) {
  if (typeof v === "string") return v.startsWith(OLD_PATH) ? NEW_PATH + v.slice(OLD_PATH.length) : v;
  if (Array.isArray(v)) return v.map(fixSuitePaths);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fixSuitePaths(x)]));
  return v;
}
const CLIENT_MARKER = `${SUITE_ID}.migratedClient.v${VERSION}`;

const parse = (v) => {
  if (typeof v !== "string") return v;
  try { return JSON.parse(v); } catch { return v; }
};

function fixPaths(l, value) {
  if (!l.paths || typeof value !== "string") return value;
  for (const [from, to] of Object.entries(l.paths)) if (value.startsWith(from)) return to + value.slice(from.length);
  return value;
}

/** Флаги старых модулей у документа → объект обновления (пустой, если переносить нечего). */
function flagUpdate(doc) {
  const update = {};
  // флаги прежней версии этого же модуля (rpg-suite) — целиком, по разделам функций
  const prev = doc.flags?.[OLD_SUITE_ID];
  if (prev && typeof prev === "object") {
    for (const [k, v] of Object.entries(prev)) {
      if (doc.flags?.[SUITE_ID] && k in doc.flags[SUITE_ID]) continue;
      update[`flags.${SUITE_ID}.${k}`] = fixSuitePaths(v);
    }
  }
  for (const l of LEGACY) {
    if (l.noFlags || !l.flagPrefix || l.module === OLD_SUITE_ID) continue;
    const old = doc.flags?.[l.module];
    if (!old || typeof old !== "object") continue;
    // уже перенесено прежней версией — тогда оно приедет из флагов rpg-suite выше
    if (prev?.[l.flagPrefix] !== undefined) continue;
    const cur = doc.flags?.[SUITE_ID]?.[l.flagPrefix];
    for (const [k, v] of Object.entries(old)) {
      if (cur && k in cur) continue;
      update[`flags.${SUITE_ID}.${l.flagPrefix}.${k}`] = v;
    }
  }
  return update;
}

export async function migrateLegacy() {
  migrateClientSettings();
  if (!game.user.isGM || game.users.activeGM?.id !== game.user.id) return;
  if ((game.settings.get(SUITE_ID, "migrated") ?? 0) >= VERSION) return;

  let docs = 0;
  const tryUpdate = async (doc, update) => {
    if (!Object.keys(update).length) return;
    try { await doc.update(update); docs++; } catch (err) { console.warn(`${SUITE_ID} | migrate ${doc.uuid}`, err); }
  };

  // Пользователи (цвет кубиков, портреты, своя панель), персонажи, предметы мира и предметы персонажей (настройки реакций)
  for (const doc of [...game.users, ...game.actors, ...game.items]) await tryUpdate(doc, flagUpdate(doc));
  for (const actor of game.actors) {
    const updates = [];
    for (const item of actor.items) {
      const u = flagUpdate(item);
      if (Object.keys(u).length) updates.push({ _id: item.id, ...u });
    }
    if (!updates.length) continue;
    try { await actor.updateEmbeddedDocuments("Item", updates); docs += updates.length; }
    catch (err) { console.warn(`${SUITE_ID} | migrate items ${actor.uuid}`, err); }
  }

  // Сцены: факелы на токенах, сундуки на тайлах, КС взлома у дверей и токенов Item Piles
  for (const scene of game.scenes) {
    for (const [collection, type] of [["tokens", "Token"], ["tiles", "Tile"], ["walls", "Wall"]]) {
      const updates = [];
      for (const d of scene[collection] ?? []) {
        const u = flagUpdate(d);
        if (Object.keys(u).length) updates.push({ _id: d.id, ...u });
      }
      if (!updates.length) continue;
      try { await scene.updateEmbeddedDocuments(type, updates); docs += updates.length; }
      catch (err) { console.warn(`${SUITE_ID} | migrate ${type} ${scene.uuid}`, err); }
    }
  }

  // Сообщения чата (карточки авто-боя, награды, зарисовки) — только те, где есть флаги прежней версии
  const msgUpdates = [];
  for (const m of game.messages ?? []) {
    if (!m.flags?.[OLD_SUITE_ID]) continue;
    const u = flagUpdate(m);
    if (Object.keys(u).length) msgUpdates.push({ _id: m.id, ...u });
  }
  if (msgUpdates.length) {
    try { await getDocumentClass("ChatMessage").updateDocuments(msgUpdates); docs += msgUpdates.length; }
    catch (err) { console.warn(`${SUITE_ID} | migrate messages`, err); }
  }

  // Настройки мира
  let settings = 0;
  const world = game.settings.storage?.get?.("world");
  // сначала — собственные настройки прежней версии (rpg-suite.<ключ> → тот же ключ)
  let oldFeatures;
  for (const [fullKey, cfg] of game.settings.settings) {
    if (cfg.namespace !== SUITE_ID || cfg.scope !== "world" || cfg.key === "migrated") continue;
    const oldDoc = world?.find?.((s) => s.key === `${OLD_SUITE_ID}.${cfg.key}`);
    if (!oldDoc || world.find((s) => s.key === fullKey)) continue;
    const value = fixSuitePaths(parse(oldDoc.value));
    if (cfg.key === "features") { oldFeatures = value; continue; }   // в самом конце: смена переключателей перезагружает страницу
    try { await game.settings.set(SUITE_ID, cfg.key, value); settings++; } catch {}
  }
  for (const l of LEGACY) {
    for (const [fullKey, cfg] of game.settings.settings) {
      if (cfg.namespace !== SUITE_ID || cfg.scope !== "world" || !cfg.key.startsWith(`${l.settingPrefix}-`)) continue;
      const oldKey = `${l.module}.${cfg.key.slice(l.settingPrefix.length + 1)}`;
      const oldDoc = world?.find?.((s) => s.key === oldKey);
      if (!oldDoc) continue;
      if (world.find((s) => s.key === fullKey)) continue;   // уже задано в новом модуле
      try { await game.settings.set(SUITE_ID, cfg.key, fixPaths(l, parse(oldDoc.value))); settings++; } catch {}
    }
  }

  await game.settings.set(SUITE_ID, "migrated", VERSION);
  if (docs || settings) ui.notifications.info(game.i18n.format("RPGSUITE.Migrated", { docs, settings }));
  if (oldFeatures && typeof oldFeatures === "object") {
    try { await game.settings.set(SUITE_ID, "features", oldFeatures); } catch {}
  }
}

/** Клиентские настройки (хранятся в браузере каждого игрока) */
function migrateClientSettings() {
  try {
    if (localStorage.getItem(CLIENT_MARKER)) return;
    // клиентские настройки прежней версии (rpg-suite.<ключ>)
    for (const [fullKey, cfg] of game.settings.settings) {
      if (cfg.namespace !== SUITE_ID || cfg.scope !== "client") continue;
      const old = localStorage.getItem(`${OLD_SUITE_ID}.${cfg.key}`);
      if (old === null || localStorage.getItem(fullKey) !== null) continue;
      game.settings.set(SUITE_ID, cfg.key, fixSuitePaths(parse(old))).catch(() => {});
    }
    for (const l of LEGACY) {
      for (const [fullKey, cfg] of game.settings.settings) {
        if (cfg.namespace !== SUITE_ID || cfg.scope !== "client" || !cfg.key.startsWith(`${l.settingPrefix}-`)) continue;
        const oldKey = `${l.module}.${cfg.key.slice(l.settingPrefix.length + 1)}`;
        const old = localStorage.getItem(oldKey);
        if (old === null || localStorage.getItem(fullKey) !== null) continue;
        game.settings.set(SUITE_ID, cfg.key, fixPaths(l, parse(old))).catch(() => {});
      }
    }
    localStorage.setItem(CLIENT_MARKER, "1");
  } catch (err) {
    console.warn(`${SUITE_ID} | перенос клиентских настроек`, err);
  }
}
