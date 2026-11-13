import { SUITE_ID } from "../../../core/constants.js";

/** Функция «Голосовые портреты» внутри общего модуля RPG Suite.
 *  Флаги: <doc>.flags["rpg-tools-by-hibear"].vp.*, настройки: "rpg-tools-by-hibear.vp-*", сокет: функция "vp". */
export const MODULE_ID = SUITE_ID;
export const FEATURE_ID = "vp";

/** Состояния голоса */
export const VOICE = { SILENT: 0, TALK: 1, LOUD: 2 };

/** Эмоции, доступные по правому клику (neutral = основной портрет) */
export const EMOTIONS = [
  { id: "neutral",   label: "Обычное",   icon: "fa-face-meh" },
  { id: "happy",     label: "Радость",   icon: "fa-face-laugh-beam" },
  { id: "sad",       label: "Грусть",    icon: "fa-face-sad-tear" },
  { id: "angry",     label: "Злость",    icon: "fa-face-angry" },
  { id: "surprised", label: "Удивление", icon: "fa-face-surprise" },
  { id: "scared",    label: "Страх",     icon: "fa-face-grimace" },
  { id: "hurt",      label: "Ранен",     icon: "fa-face-tired" },
  { id: "contempt",  label: "Презрение", icon: "fa-face-rolling-eyes" }
];

/** Слоты изображений, которые зависят от голоса */
export const VOICE_SLOTS = [
  { id: "talking",  label: "Говорит",  hint: "например, с открытым ртом" },
  { id: "shouting", label: "Кричит",   hint: "при повышении голоса" }
];

export const DEFAULT_CONFIG = {
  mode: "voice",       // "voice" — реагирует на голос, "static" — статичный портрет
  displayName: "",     // пусто = имя персонажа
  ring: true,          // подсветка рамки, когда говорит
  images: {}           // { neutral, talking, shouting, happy, ... }
};

export const FALLBACK_IMG = "icons/svg/mystery-man.svg";

/** Размеры портретов (настройка мастера) */
/** Размер портретов на отдельной панели: средний — прежний размер, большой ×1.5, маленький ×0.5 */
export const SIZES = { small: 66, medium: 132, large: 198 };
