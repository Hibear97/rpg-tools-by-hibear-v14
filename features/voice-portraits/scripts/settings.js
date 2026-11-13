import { MODULE_ID, EMOTIONS } from "./constants.js";

const KEY = key => `vp-${key}`;   // все настройки функции — с префиксом vp-
export const getSetting = key => game.settings.get(MODULE_ID, KEY(key));
export const setSetting = (key, value) => game.settings.set(MODULE_ID, KEY(key), value);

const rerender = () => game.voicePortraits?.bar?.render();

export function registerSettings() {
  const reg = (key, data) => game.settings.register(MODULE_ID, KEY(key), data.name ? { ...data, name: `Голосовые портреты · ${data.name}` } : data);

  // ---------- Мир (настраивает ГМ) ----------
  reg("voiceSource", {
    name: "Источник голоса",
    hint: "«Foundry» — голосовой чат встроен в Foundry (Настройки → Аудио/видео). «Внешний» — вы общаетесь в Discord и т.п., а модуль слушает ваш микрофон только для анимации портретов (звук никуда не передаётся). Нужно перезагрузить страницу.",
    scope: "world", config: true, type: String, default: "foundry",
    choices: { foundry: "Foundry (встроенный голосовой чат)", external: "Внешний (Discord и т.п.)" },
    requiresReload: true
  });
  reg("showGM", {
    name: "Показывать портрет ГМа", scope: "world", config: true, type: Boolean, default: true, onChange: rerender
  });
  reg("showOffline", {
    name: "Показывать отключившихся игроков",
    hint: "Портреты игроков не в сети будут серыми.",
    scope: "world", config: true, type: Boolean, default: false, onChange: rerender
  });
  reg("bubbles", {
    name: "Облачка чата над портретами",
    hint: "Сообщения игроков в чате показываются облачком у их портрета.",
    scope: "world", config: true, type: Boolean, default: true
  });
  reg("bubbleRolls", {
    name: "Облачка для бросков",
    hint: "Показывать в облачке результат броска (🎲 итог).",
    scope: "world", config: true, type: Boolean, default: false
  });
  reg("hideCanvasBubbles", {
    name: "Убрать облачка над токенами персонажей игроков",
    hint: "Облачки над токенами, которыми владеют игроки, не показываются (они уже есть у портретов). Облачка NPC от ГМа остаются на поле.",
    scope: "world", config: true, type: Boolean, default: true
  });
  reg("portraitSizePreset", {
    name: "Размер портретов",
    hint: "Размер портретов у всех игроков: и на отдельной панели, и в колонке слева, когда портреты встроены в UI-интерфейс. Маленький — компактно, Большой — крупные портреты.",
    scope: "world", config: true, type: String, default: "medium",
    choices: { small: "Маленький", medium: "Средний", large: "Большой" },
    onChange: rerender
  });
  reg("discordBridge", {
    name: "Discord-бот: включить",
    hint: "Портреты игроков, у которых указан ник в Discord, реагируют только когда Discord реально передаёт их голос (учитывается режим рации и мут). Нужно запустить бота на компьютере мастера — см. README.",
    scope: "world", config: true, type: Boolean, default: false,
    onChange: () => game.voicePortraits?.discord?.restart()
  });
  reg("discordBridgeUrl", {
    name: "Discord-бот: адрес",
    hint: "Адрес бота, к которому подключается браузер мастера. Обычно не нужно менять.",
    scope: "world", config: true, type: String, default: "ws://127.0.0.1:30500",
    onChange: () => game.voicePortraits?.discord?.restart()
  });
  reg("discordShoutDb", {
    name: "Discord-бот: порог крика (дБ)",
    hint: "Громкость в Discord, начиная с которой портрет «кричит». Чем ближе к 0, тем громче надо кричать.",
    scope: "world", config: true, type: Number, range: { min: -40, max: 0, step: 1 }, default: -12
  });
  reg("discordAskUnknown", {
    name: "Discord-бот: спрашивать про незнакомые голоса",
    hint: "Если в Discord говорит человек, не привязанный ни к одному пользователю Foundry, мастер один раз увидит окно «Кто это?» и сможет привязать его в один клик, не вписывая ник вручную. Выключите, если привязываете ники сами (ПКМ по портрету → «Настроить портрет…»).",
    scope: "world", config: true, type: Boolean, default: true
  });
  reg("discordIgnored", { scope: "world", config: false, type: Array, default: [] });
  reg("setupPrompted", { scope: "world", config: false, type: Boolean, default: false });

  // ---------- Клиент (у каждого свои) ----------
  reg("hideCameraDock", {
    name: "Скрыть стандартные окна камер Foundry",
    hint: "Голос продолжит работать, просто вместо стандартных окошек будут портреты.",
    scope: "client", config: true, type: Boolean, default: true,
    onChange: v => document.body.classList.toggle("vp-hide-cameras", v)
  });
  reg("speakThreshold", {
    name: "Порог речи (дБ)",
    hint: "Тише этого уровня — молчит. Удобнее подобрать в окне «Настроить портрет» (там есть индикатор микрофона).",
    scope: "client", config: true, type: Number, range: { min: -80, max: -10, step: 1 }, default: -48
  });
  reg("shoutThreshold", {
    name: "Порог крика (дБ)",
    hint: "Громче этого уровня — портрет «кричит».",
    scope: "client", config: true, type: Number, range: { min: -50, max: 0, step: 1 }, default: -16
  });
  reg("barPosition", { scope: "client", config: false, type: Object, default: {} });
  reg("discordPromptOff", { scope: "client", config: false, type: Boolean, default: false });
  reg("externalMuted", { scope: "client", config: false, type: Boolean, default: false });
}

export function registerKeybindings() {
  for ( const emo of EMOTIONS ) {
    game.keybindings.register(MODULE_ID, `vp-emotion-${emo.id}`, {
      name: `Голосовые портреты · Эмоция: ${emo.label}`,
      editable: [],
      onDown: () => { game.voicePortraits?.setEmotion(game.user, emo.id); return true; }
    });
  }
  game.keybindings.register(MODULE_ID, "vp-toggle-mute", {
    name: "Микрофон вкл/выкл (Голосовые портреты)",
    editable: [],
    onDown: () => { game.voicePortraits?.voice.toggleMute(); return true; }
  });
}
