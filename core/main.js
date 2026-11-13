/**
 * RPG Suite — ядро общего модуля.
 *
 * Каждая функция (бывший отдельный модуль) лежит в features/<папка> и экспортирует setup().
 * Ядро вызывает setup() только у включённых функций, во время init, поэтому выключенная функция
 * вообще не загружает свои хуки, настройки и интерфейс.
 *
 * Правила, чтобы функции не конфликтовали:
 *  - настройки:  game.settings.register(SUITE_ID, "<префикс>-<ключ>")
 *  - флаги:      doc.getFlag(SUITE_ID, "<префикс>.<ключ>")
 *  - сокет:      suiteSocket.emit("<id функции>", data) / suiteSocket.on("<id функции>", fn)
 *  - хуки:       const Hooks = createFeatureHooks() — подписки включаются только у запущенной функции
 *  - связь:      shared (core/shared.js) и свои хуки "rpgSuite.*" — функции не импортируют друг друга
 *  - CSS:        свои id/классы с префиксом, глобальные правки только через класс на <body>
 */

import { SUITE_ID, SUITE_TITLE, OLD_SUITE_ID } from "./constants.js";
import { suiteSocket } from "./socket.js";
import { shared } from "./shared.js";
import { FeatureManager, openHelp } from "./manager.js";
import { migrateLegacy } from "./migrate.js";
import * as hud from "../features/hud/index.js";
import * as portraits from "../features/voice-portraits/scripts/main.js";
import * as combat from "../features/auto-combat/index.js";
import * as rolls from "../features/roll-requests/index.js";
import * as loot from "../features/party-loot/index.js";
import * as reactions from "../features/reactions/index.js";
import * as dice from "../features/dice/index.js";
import * as gmbar from "../features/gm-bar/index.js";
import * as calendar from "../features/calendar/index.js";
import * as light from "../features/light/index.js";
import * as whisper from "../features/whisper/index.js";
import * as initiative from "../features/initiative/index.js";
import * as lockpick from "../features/lockpick/index.js";
import * as mannequin from "../features/mannequin/index.js";
import * as piles from "../features/piles/main.js";
import * as notebook from "../features/notebook/index.js";

/**
 * Реестр функций. Новую функцию добавляем сюда.
 *  settingPrefix — приставка её настроек (по ней центр управления находит настройки функции)
 *  legacyModule  — старый отдельный модуль: если он включён, функция не запускается (чтобы не было двух копий)
 *  conflicts     — сторонние модули, которые делают то же самое (только предупреждение)
 *  system        — нужна определённая игровая система
 */
export const FEATURES = [
  {
    id: "hud", icon: "fa-solid fa-gamepad", settingPrefix: "hud",
    legacyModule: "bg3-style-hud", system: "dnd5e", defaultEnabled: true,
    setup: hud.setup
  },
  {
    id: "portraits", icon: "fa-solid fa-microphone-lines", settingPrefix: "vp",
    legacyModule: "voice-portraits", defaultEnabled: true,
    setup: portraits.setup
  },
  {
    id: "combat", icon: "fa-solid fa-swords", settingPrefix: "ac",
    legacyModule: "auto-combat-5e", conflicts: ["midi-qol"], system: "dnd5e", defaultEnabled: true,
    setup: combat.setup
  },
  {
    id: "rolls", icon: "fa-solid fa-dice-d20", settingPrefix: "rr",
    legacyModule: "bg3-roll-requests", defaultEnabled: true,
    setup: rolls.setup, api: rolls.api
  },
  {
    id: "loot", icon: "fa-solid fa-sack-dollar", settingPrefix: "loot",
    legacyModule: "party-loot-roll", system: "dnd5e", defaultEnabled: true,
    setup: loot.setup, api: loot.api
  },
  {
    id: "reactions", icon: "fa-solid fa-bolt", settingPrefix: "rp",
    legacyModule: "reaction-prompts", system: "dnd5e", defaultEnabled: true,
    setup: reactions.setup, api: reactions.api
  },
  {
    id: "dice", icon: "fa-solid fa-cube", settingPrefix: "dice",
    legacyModule: "simple-3d-dice", conflicts: ["dice-so-nice"], defaultEnabled: true,
    setup: dice.setup, api: dice.api
  },
  {
    id: "gmbar", icon: "fa-solid fa-toolbox", settingPrefix: "gmb", gmOnly: true, defaultEnabled: true,
    setup: gmbar.setup, api: gmbar.api
  },
  {
    id: "initiative", icon: "fa-solid fa-people-line", settingPrefix: "ib",
    legacyModule: "initiative-bar-tool", defaultEnabled: true,
    setup: initiative.setup, api: initiative.api
  },
  {
    id: "calendar", icon: "fa-solid fa-cloud-sun", settingPrefix: "cal",
    legacyModule: "calendar-tool", defaultEnabled: true,
    setup: calendar.setup, api: calendar.api
  },
  {
    id: "light", icon: "fa-solid fa-fire-flame-curved", settingPrefix: "vis",
    legacyModule: "dnd-vision-5e-tool", recommends: ["vision-5e"], system: "dnd5e", defaultEnabled: true,
    setup: light.setup, api: light.api
  },
  {
    id: "lockpick", icon: "fa-solid fa-key", settingPrefix: "lp",
    legacyModule: "lockpicking-tool", system: "dnd5e", defaultEnabled: true,
    setup: lockpick.setup, api: lockpick.api
  },
  {
    id: "piles", icon: "fa-solid fa-box-open", settingPrefix: "pt",
    legacyModule: "piles-tool", conflicts: ["item-piles"], system: "dnd5e", defaultEnabled: true,
    setup: piles.setup, api: piles.api
  },
  {
    id: "mannequin", icon: "fa-solid fa-user-shield", settingPrefix: "mq",
    legacyModule: "mannequin-tool", system: "dnd5e", defaultEnabled: true,
    setup: mannequin.setup, api: mannequin.api
  },
  {
    id: "whisper", icon: "fa-solid fa-comment-dots", settingPrefix: "gmw",
    legacyModule: "gm-whisper", defaultEnabled: true,
    setup: whisper.setup, api: whisper.api
  },
  {
    id: "notebook", icon: "fa-solid fa-book-open", settingPrefix: "nb",
    legacyModule: "sketch-notebook", defaultEnabled: true,
    setup: notebook.setup, api: notebook.api
  }
].map((f) => ({
  title: `RPGSUITE.Features.${f.id}.title`,
  description: `RPGSUITE.Features.${f.id}.description`,
  details: `RPGSUITE.Features.${f.id}.details`,
  conflicts: [],
  recommends: [],
  ...f
}));

const active = new Set();
const failed = new Set();

/** Значение мировой настройки прежнего модуля rpg-suite (до переноса), прямо из базы мира */
function oldWorldSetting(key) {
  try {
    const doc = game.settings.storage.get("world")?.find?.((s) => s.key === `${OLD_SUITE_ID}.${key}`);
    if (!doc) return undefined;
    return typeof doc.value === "string" ? JSON.parse(doc.value) : doc.value;
  } catch { return undefined; }
}

function enabledMap() {
  const has = !!game.settings.storage.get("world")?.find?.((s) => s.key === `${SUITE_ID}.features`);
  // до переноса берём переключатели прежней версии, чтобы после переименования включилось то же самое
  const stored = (has ? game.settings.get(SUITE_ID, "features") : oldWorldSetting("features")) ?? {};
  return Object.fromEntries(FEATURES.map((f) => [f.id, stored[f.id] ?? f.defaultEnabled]));
}

let managerApp = null;

/** Публичное API: game.rpgSuite */
const api = {
  id: SUITE_ID,
  features: FEATURES,
  socket: suiteSocket,
  shared,
  /** API отдельных функций (заполняется только для запущенных): api.rolls, api.loot, api.reactions, api.dice */
  api: {},
  /** Функция реально запущена в этом клиенте */
  isActive: (id) => active.has(id),
  /** Функция упала при запуске */
  isFailed: (id) => failed.has(id),
  /** Функция включена мастером (может требовать перезагрузку) */
  isEnabled: (id) => !!enabledMap()[id],
  enabledMap,
  async setEnabled(map) {
    if (!game.user.isGM) return;
    await game.settings.set(SUITE_ID, "features", { ...enabledMap(), ...map });
  },
  /** Открыть центр управления (можно передать id функции, чтобы сразу её выбрать) */
  /** Открыть «Как это работает?» для функции (или "discord" — инструкция по Discord-боту) */
  openHelp: (id) => openHelp(id),
  openManager(featureId) {
    if (managerApp?.rendered) {
      if (featureId) managerApp.select(featureId);
      managerApp.bringToFront?.();
      return managerApp;
    }
    managerApp = new FeatureManager({ selected: featureId });
    managerApp.render({ force: true });
    return managerApp;
  }
};

Hooks.once("init", () => {
  game.settings.register(SUITE_ID, "features", {
    scope: "world", config: false, type: Object, default: {},
    onChange: () => {
      ui.notifications?.info(game.i18n.localize("RPGSUITE.Reloading"));
      setTimeout(() => window.location.reload(), 800);
    }
  });
  game.settings.register(SUITE_ID, "migrated", { scope: "world", config: false, type: Number, default: 0 });
  game.settings.registerMenu(SUITE_ID, "manager", {
    name: "RPGSUITE.Manager.menuName",
    label: "RPGSUITE.Manager.menuLabel",
    hint: "RPGSUITE.Manager.menuHint",
    icon: "fa-solid fa-sliders",
    type: FeatureManager,
    restricted: false
  });
  game.keybindings.register(SUITE_ID, "core-openManager", {
    name: "RPGSUITE.Manager.keybind",
    editable: [{ key: "KeyM", modifiers: ["Shift"] }],
    onDown: () => { api.openManager(); return true; }
  });

  game.rpgSuite = api;
  const mod = game.modules.get(SUITE_ID);
  if (mod) mod.api = api;

  // Прежняя версия (папка rpg-suite) ещё включена — не запускаемся, иначе будет две копии всего
  if (game.modules.get(OLD_SUITE_ID)?.active) {
    console.warn(`${SUITE_TITLE} | включена старая версия модуля (rpg-suite) — функции не запущены`);
    Hooks.once("ready", () => ui.notifications.error(game.i18n.localize("RPGSUITE.OldVersionActive"), { permanent: true }));
    return;
  }

  const enabled = enabledMap();
  for (const f of FEATURES) {
    if (!enabled[f.id]) continue;
    // Старый отдельный модуль ещё включён — не запускаем копию, чтобы не было двух одинаковых интерфейсов
    if (f.legacyModule && game.modules.get(f.legacyModule)?.active) {
      console.warn(`${SUITE_ID} | функция «${f.id}» пропущена: включён старый модуль ${f.legacyModule}`);
      continue;
    }
    try {
      f.setup({ suite: api, socket: suiteSocket, shared });
      active.add(f.id);
      if (f.api) api.api[f.id] = f.api;
    } catch (err) {
      failed.add(f.id);
      console.error(`${SUITE_ID} | ошибка запуска функции «${f.id}»`, err);
    }
  }
  console.log(`${SUITE_TITLE} | функции: ${[...active].join(", ") || "нет"}`);
});

Hooks.once("ready", async () => {
  if (game.user.isGM) {
    const legacy = FEATURES.filter((f) => f.legacyModule && game.modules.get(f.legacyModule)?.active);
    if (legacy.length) {
      ui.notifications.warn(game.i18n.format("RPGSUITE.LegacyActive", {
        modules: legacy.map((f) => game.modules.get(f.legacyModule)?.title ?? f.legacyModule).join(", ")
      }), { permanent: true });
    }
    for (const f of FEATURES) {
      if (!active.has(f.id)) continue;
      for (const c of f.conflicts) {
        if (!game.modules.get(c)?.active) continue;
        ui.notifications.warn(`${SUITE_TITLE}: ${game.i18n.localize(f.title)} — ${game.i18n.format("RPGSUITE.Manager.conflict", { module: game.modules.get(c)?.title ?? c })}`);
      }
    }
  }
  try { await migrateLegacy(); } catch (err) { console.warn(`${SUITE_ID} | перенос данных`, err); }
});

/* Кнопка центра управления на левой панели инструментов (у всех: мастер управляет, игроки смотрят описания и свои настройки) */
Hooks.on("getSceneControlButtons", (controls) => {
  const tokens = controls.tokens ?? controls.token;
  if (!tokens?.tools) return;
  tokens.tools.rpgSuiteManager = {
    name: "rpgSuiteManager",
    title: "RPGSUITE.Manager.toolTitle",
    icon: "fa-solid fa-sliders",
    order: 900,
    button: true,
    visible: true,
    onChange: () => api.openManager()
  };
});

/* Кнопка центра управления вверху вкладки «Настройки» сайдбара */
Hooks.on("renderSettings", (app, html) => {
  const root = html instanceof HTMLElement ? html : html?.[0];
  if (!root || root.querySelector(".rpg-suite-open")) return;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "rpg-suite-open";
  btn.innerHTML = `<i class="fa-solid fa-sliders"></i> ${game.i18n.localize("RPGSUITE.Manager.menuLabel")}`;
  btn.addEventListener("click", () => api.openManager());
  const target = root.querySelector("section.settings, #settings-game, .settings") ?? root;
  target.prepend(btn);
});
