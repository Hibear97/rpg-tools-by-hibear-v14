/**
 * Calendar Tool by Hibear — календарь, время суток, погода и локация
 * Foundry VTT v13
 *
 * Самодостаточная фича: id модуля определяется автоматически по пути файла,
 * поэтому папку calendar/ можно положить внутрь любого модуля (например RPG-Tools)
 * и подключить одной строкой:  import "./calendar/calendar.mjs";
 *
 * Источник правды для времени — стандартное game.time.worldTime (секунды),
 * поэтому всё совместимо с другими модулями, которые читают игровое время.
 */

/* ------------------------------------------------------------------ */
/*  Базовые константы                                                  */
/* ------------------------------------------------------------------ */

import { SUITE_ID } from "../../core/constants.js";
import { createFeatureHooks } from "../../core/feature-hooks.js";

/** Функция «Календарь и погода» внутри RPG-Tools. Настройки: "rpg-tools-by-hibear.cal-rtc*".
 *  Стили подключаются через module.json (features/calendar/calendar.css). */
const MODULE_ID = SUITE_ID;
const Hooks = createFeatureHooks();

/** API для макросов: game.rpgSuite.api.calendar (то же, что глобальный RPGCalendar) */
export const api = {};

export function setup() {
  Hooks.activate();
}

const K = {
  enabled: "cal-rtcEnabled",
  players: "cal-rtcPlayersVisible",
  cal: "cal-rtcCalendar",
  clock: "cal-rtcClock",
  weather: "cal-rtcWeather",
  pos: "cal-rtcWidgetPos",
  collapsed: "cal-rtcCollapsed",
  location: "cal-rtcLocation"
};

const SEASONS = { winter: "Зима", spring: "Весна", summer: "Лето", autumn: "Осень" };
const SEASON_ALIASES = {
  winter: "winter", зима: "winter", з: "winter",
  spring: "spring", весна: "spring", в: "spring",
  summer: "summer", лето: "summer", л: "summer",
  autumn: "autumn", fall: "autumn", осень: "autumn", о: "autumn"
};

const WEATHER = {
  clear:    { label: "Ясно",                  icon: "clear" },
  partly:   { label: "Переменная облачность", icon: "partly" },
  cloudy:   { label: "Пасмурно",              icon: "cloudy" },
  fog:      { label: "Туман",                 icon: "fog" },
  windy:    { label: "Ветрено",               icon: "windy" },
  rain:     { label: "Дождь",                 icon: "rain" },
  storm:    { label: "Гроза",                 icon: "storm" },
  snow:     { label: "Снег",                  icon: "snow" },
  blizzard: { label: "Метель",                icon: "blizzard" }
};
const WIND = ["Штиль", "Лёгкий ветер", "Сильный ветер", "Ураганный ветер"];

const PERIODS = {
  night:   "Ночь",
  dawn:    "Рассвет",
  morning: "Утро",
  day:     "День",
  evening: "Вечер",
  dusk:    "Закат"
};

const MOON_PHASES = [
  "Новолуние", "Растущий серп", "Первая четверть", "Растущая луна",
  "Полнолуние", "Убывающая луна", "Последняя четверть", "Убывающий серп"
];

/** Климаты для автогенерации: temps[season] = [днём, ночью] °C, weights[season] = веса типов погоды */
const CLIMATES = {
  temperate: {
    label: "Умеренный",
    temps: { winter: [-3, -10], spring: [13, 3], summer: [25, 14], autumn: [11, 3] },
    weights: {
      winter: { clear: 3, partly: 3, cloudy: 4, fog: 2, windy: 2, snow: 4, blizzard: 1, rain: 0.5 },
      spring: { clear: 4, partly: 4, cloudy: 3, fog: 2, windy: 2, rain: 4, storm: 1 },
      summer: { clear: 6, partly: 4, cloudy: 2, fog: 0.5, windy: 1, rain: 2, storm: 2 },
      autumn: { clear: 3, partly: 3, cloudy: 4, fog: 3, windy: 3, rain: 4, storm: 0.5, snow: 0.5 }
    }
  },
  cold: {
    label: "Северный / горы",
    temps: { winter: [-15, -27], spring: [0, -9], summer: [14, 4], autumn: [-1, -9] },
    weights: {
      winter: { clear: 3, partly: 2, cloudy: 3, fog: 1, windy: 3, snow: 5, blizzard: 3 },
      spring: { clear: 3, partly: 3, cloudy: 3, fog: 2, windy: 3, snow: 3, rain: 1, blizzard: 1 },
      summer: { clear: 4, partly: 4, cloudy: 3, fog: 2, windy: 2, rain: 3, storm: 1 },
      autumn: { clear: 2, partly: 3, cloudy: 4, fog: 2, windy: 3, rain: 2, snow: 3, blizzard: 1 }
    }
  },
  desert: {
    label: "Пустыня",
    temps: { winter: [18, 3], spring: [30, 14], summer: [42, 24], autumn: [30, 14] },
    weights: {
      winter: { clear: 7, partly: 3, cloudy: 1, windy: 3, rain: 0.5 },
      spring: { clear: 8, partly: 2, windy: 4, storm: 0.3 },
      summer: { clear: 10, partly: 1, windy: 4 },
      autumn: { clear: 8, partly: 2, windy: 3, rain: 0.3 }
    }
  },
  tropical: {
    label: "Тропики",
    temps: { winter: [27, 20], spring: [29, 22], summer: [31, 24], autumn: [29, 22] },
    weights: {
      winter: { clear: 5, partly: 4, cloudy: 2, rain: 2, storm: 1, windy: 1 },
      spring: { clear: 3, partly: 4, cloudy: 3, rain: 4, storm: 2, fog: 1 },
      summer: { clear: 2, partly: 3, cloudy: 3, rain: 5, storm: 4, windy: 1 },
      autumn: { clear: 3, partly: 4, cloudy: 3, rain: 4, storm: 2, windy: 1 }
    }
  },
  coastal: {
    label: "Побережье",
    temps: { winter: [5, -1], spring: [13, 6], summer: [22, 15], autumn: [14, 8] },
    weights: {
      winter: { clear: 2, partly: 3, cloudy: 4, fog: 3, windy: 4, rain: 3, storm: 1, snow: 1 },
      spring: { clear: 3, partly: 4, cloudy: 3, fog: 3, windy: 3, rain: 3, storm: 1 },
      summer: { clear: 5, partly: 4, cloudy: 2, fog: 2, windy: 2, rain: 2, storm: 1 },
      autumn: { clear: 2, partly: 3, cloudy: 4, fog: 3, windy: 4, rain: 4, storm: 2 }
    }
  }
};

const PRESETS = {
  harptos: {
    label: "Харптос (Забытые Королевства)",
    months: [
      ["Хаммер (Глубокозимье)", 30, "winter"], ["Середина зимы", 1, "winter"],
      ["Алтуриак (Коготь зимы)", 30, "winter"], ["Чес (Коготь закатов)", 30, "spring"],
      ["Тарсах (Коготь бурь)", 30, "spring"], ["Зеленотравье", 1, "spring"],
      ["Миртул (Таяние)", 30, "spring"], ["Киторн (Время цветов)", 30, "summer"],
      ["Флеймрул (Летний прилив)", 30, "summer"], ["Середина лета", 1, "summer"],
      ["Элеасис (Высокое солнце)", 30, "summer"], ["Элейнт (Увядание)", 30, "autumn"],
      ["Праздник урожая", 1, "autumn"], ["Марпенот (Листопад)", 30, "autumn"],
      ["Уктар (Гниение)", 30, "autumn"], ["Праздник Луны", 1, "autumn"],
      ["Найтал (Нисхождение)", 30, "winter"]
    ],
    weekdays: ["Первый день", "Второй день", "Третий день", "Четвёртый день", "Пятый день",
      "Шестой день", "Седьмой день", "Восьмой день", "Девятый день", "Десятый день"],
    hoursPerDay: 24, minutesPerHour: 60, startYear: 1492, era: "DR", moonCycle: 30
  },
  gregorian: {
    label: "Григорианский",
    months: [
      ["Январь", 31, "winter"], ["Февраль", 28, "winter"], ["Март", 31, "spring"],
      ["Апрель", 30, "spring"], ["Май", 31, "spring"], ["Июнь", 30, "summer"],
      ["Июль", 31, "summer"], ["Август", 31, "summer"], ["Сентябрь", 30, "autumn"],
      ["Октябрь", 31, "autumn"], ["Ноябрь", 30, "autumn"], ["Декабрь", 31, "winter"]
    ],
    weekdays: ["Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота", "Воскресенье"],
    hoursPerDay: 24, minutesPerHour: 60, startYear: 1000, era: "г.", moonCycle: 29.5
  },
  simple: {
    label: "Простой (12 × 30 дней)",
    months: Array.from({ length: 12 }, (_, i) => [`Месяц ${i + 1}`, 30, ["winter", "winter", "spring", "spring", "spring", "summer", "summer", "summer", "autumn", "autumn", "autumn", "winter"][i]]),
    weekdays: ["День Солнца", "День Луны", "День Огня", "День Воды", "День Леса", "День Камня", "День Звёзд"],
    hoursPerDay: 24, minutesPerHour: 60, startYear: 1, era: "г.", moonCycle: 28
  }
};

const DEFAULT_CAL = (() => {
  const p = PRESETS.gregorian;
  return {
    preset: "gregorian",
    months: p.months.map(([name, days, season]) => ({ name, days, season })),
    weekdays: [...p.weekdays],
    hoursPerDay: 24, minutesPerHour: 60,
    startYear: p.startYear, era: p.era, weekdayOffset: 0,
    sunrise: 6, sunset: 20,
    moonCycle: p.moonCycle, moonOffset: 0,
    syncDarkness: false, maxDarkness: 0.85
  };
})();

const DEFAULT_CLOCK = {
  running: false,
  realAmount: 1, realUnit: "min",
  gameAmount: 5, gameUnit: "min",
  pauseWithGame: true, pauseInCombat: true,
  tickSeconds: 5
};

function monthRowHTML(m) {
  const seasons = Object.entries(SEASONS).map(([k, v]) => `<option value="${k}" ${k === m.season ? "selected" : ""}>${v}</option>`).join("");
  return `<div class="rtc-month">
    <input type="text" data-m="name" value="${esc(m.name)}" placeholder="Название">
    <input type="number" data-m="days" min="1" value="${m.days}" title="Дней в месяце">
    <select data-m="season">${seasons}</select>
    <button type="button" data-mact="up" title="Выше"><i class="fa-solid fa-arrow-up"></i></button>
    <button type="button" data-mact="down" title="Ниже"><i class="fa-solid fa-arrow-down"></i></button>
    <button type="button" data-mact="del" title="Удалить"><i class="fa-solid fa-trash"></i></button>
  </div>`;
}

const DEFAULT_LOCATION = { name: "", region: "", recent: [], announce: true, autoScene: false };

const DEFAULT_WEATHER = {
  type: "clear", wind: 1, high: 18, low: 8,
  unit: "C", climate: "temperate",
  auto: true, announce: true, day: null
};

/* ------------------------------------------------------------------ */
/*  Утилиты                                                            */
/* ------------------------------------------------------------------ */

const mod = (n, m) => ((n % m) + m) % m;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const pad = n => String(n).padStart(2, "0");
const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function weightedPick(weights) {
  const entries = Object.entries(weights).filter(([, w]) => w > 0);
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let r = Math.random() * total;
  for (const [k, w] of entries) { if ((r -= w) <= 0) return k; }
  return entries[0]?.[0] ?? "clear";
}

const getSetting = key => game.settings.get(MODULE_ID, key);
const setSetting = (key, v) => game.settings.set(MODULE_ID, key, v);
const isActiveGM = () => game.user.isGM && (game.users.activeGM?.id ?? game.user.id) === game.user.id;

/* ------------------------------------------------------------------ */
/*  Модель календаря                                                   */
/* ------------------------------------------------------------------ */

function normalizeCal(raw) {
  const c = foundry.utils.mergeObject(foundry.utils.deepClone(DEFAULT_CAL), raw ?? {}, { inplace: false });
  c.months = (Array.isArray(raw?.months) && raw.months.length ? raw.months : DEFAULT_CAL.months)
    .map(m => ({ name: String(m.name || "?"), days: Math.max(1, Math.round(num(m.days, 30))), season: SEASONS[m.season] ? m.season : "summer" }));
  c.weekdays = (Array.isArray(raw?.weekdays) && raw.weekdays.length ? raw.weekdays : DEFAULT_CAL.weekdays).map(String);
  c.hoursPerDay = clamp(Math.round(num(c.hoursPerDay, 24)), 1, 100);
  c.minutesPerHour = clamp(Math.round(num(c.minutesPerHour, 60)), 1, 1000);
  c.sunrise = clamp(num(c.sunrise, 6), 0, c.hoursPerDay);
  c.sunset = clamp(num(c.sunset, 20), c.sunrise + 0.5, c.hoursPerDay);
  c.moonCycle = Math.max(1, num(c.moonCycle, 30));
  c.maxDarkness = clamp(num(c.maxDarkness, 0.85), 0, 1);
  return c;
}

const getCal = () => normalizeCal(getSetting(K.cal));
const getClock = () => ({ ...DEFAULT_CLOCK, ...getSetting(K.clock) });
const getWeather = () => ({ ...DEFAULT_WEATHER, ...getSetting(K.weather) });
const getLocation = () => ({ ...DEFAULT_LOCATION, ...getSetting(K.location) });

/** Установить локацию партии (только ГМ). Пустое имя — скрыть. */
async function setLocation(name, region = "", { announce } = {}) {
  if (!game.user.isGM) return;
  const prev = getLocation();
  name = String(name ?? "").trim();
  region = String(region ?? "").trim();
  if (name === prev.name && region === prev.region) return;
  const recent = name
    ? [{ name, region }, ...prev.recent.filter(r => !(r.name === name && r.region === region))].slice(0, 12)
    : prev.recent;
  await setSetting(K.location, { ...prev, name, region, recent });
  if (name && (announce ?? prev.announce)) announceLocation(name, region);
}

function announceLocation(name, region) {
  const d = decompose(game.time.worldTime);
  const content = `<div class="rtc-chat rtc-chat-loc">
    <div class="rtc-chat-pin"><i class="fa-solid fa-location-dot"></i></div>
    <div class="rtc-chat-text">
      <div class="rtc-chat-date">${esc(d.weekday)}, ${esc(formatDate(d))} · ${pad(d.hour)}:${pad(d.minute)}</div>
      <div class="rtc-chat-title">${esc(name)}</div>
      ${region ? `<div>${esc(region)}</div>` : ""}
    </div></div>`;
  ChatMessage.create({ content, speaker: { alias: "Локация" } });
}

const secPerHour = cal => cal.minutesPerHour * 60;
const secPerDay = cal => cal.hoursPerDay * secPerHour(cal);
const daysPerYear = cal => cal.months.reduce((s, m) => s + m.days, 0);

/** worldTime (сек) → дата/время */
function decompose(t, cal = getCal()) {
  const spd = secPerDay(cal), sph = secPerHour(cal), dpy = daysPerYear(cal);
  const totalDays = Math.floor(t / spd);
  const secOfDay = t - totalDays * spd;
  const hour = Math.floor(secOfDay / sph);
  const minute = Math.floor((secOfDay - hour * sph) / 60);
  const yearIdx = Math.floor(totalDays / dpy);
  let rest = totalDays - yearIdx * dpy;
  let monthIndex = 0;
  while (monthIndex < cal.months.length - 1 && rest >= cal.months[monthIndex].days) {
    rest -= cal.months[monthIndex].days; monthIndex++;
  }
  const hourFloat = secOfDay / sph;
  const moonPhase = mod(totalDays + cal.moonOffset + secOfDay / spd, cal.moonCycle) / cal.moonCycle;
  return {
    year: cal.startYear + yearIdx, monthIndex, month: cal.months[monthIndex],
    day: rest + 1, hour, minute, hourFloat, totalDays,
    weekday: cal.weekdays[mod(totalDays + cal.weekdayOffset, cal.weekdays.length)],
    moonPhase, moonName: MOON_PHASES[Math.round(moonPhase * 8) % 8]
  };
}

/** дата/время → worldTime (сек) */
function compose(cal, { year, monthIndex, day, hour, minute }) {
  let days = (year - cal.startYear) * daysPerYear(cal);
  for (let i = 0; i < monthIndex; i++) days += cal.months[i].days;
  days += day - 1;
  return days * secPerDay(cal) + hour * secPerHour(cal) + minute * 60;
}

function periodOf(h, cal) {
  const S = cal.sunrise, E = cal.sunset, noon = (S + E) / 2;
  if (h >= S - 1 && h < S + 1) return "dawn";
  if (h >= S + 1 && h < noon - 1) return "morning";
  if (h >= noon - 1 && h < E - 3) return "day";
  if (h >= E - 3 && h < E - 1) return "evening";
  if (h >= E - 1 && h < E + 1) return "dusk";
  return "night";
}
const isNightHour = (h, cal) => h < cal.sunrise || h >= cal.sunset;

/** Затемнение сцены 0..1 по времени суток (+ поправка на облачность) */
function darknessAt(h, cal, weatherType) {
  const S = cal.sunrise, E = cal.sunset, max = cal.maxDarkness;
  let d;
  if (h >= S + 1 && h < E - 1) d = 0;
  else if (h >= S - 1 && h < S + 1) d = max * (1 - (h - (S - 1)) / 2);
  else if (h >= E - 1 && h < E + 1) d = max * ((h - (E - 1)) / 2);
  else d = max;
  const extra = { cloudy: 0.1, rain: 0.15, fog: 0.1, storm: 0.25, snow: 0.1, blizzard: 0.25 }[weatherType] ?? 0;
  return clamp(Math.round((d + extra * (1 - d / Math.max(max, 0.01))) * 100) / 100, 0, 1);
}

/** Текущая температура: минимум на рассвете, максимум ближе к вечеру */
function tempAt(h, cal, w) {
  const H = cal.hoursPerDay, S = cal.sunrise, P = S + (cal.sunset - S) * 0.65;
  let f;
  if (h >= S && h <= P) f = (1 - Math.cos(Math.PI * (h - S) / (P - S))) / 2;
  else f = (1 + Math.cos(Math.PI * mod(h - P, H) / (H - (P - S)))) / 2;
  return w.low + (w.high - w.low) * f;
}
const fmtTemp = (c, unit) => `${Math.round(unit === "F" ? c * 9 / 5 + 32 : c)}°${unit === "F" ? "F" : "C"}`;
const tempClass = c => c <= -10 ? "freezing" : c <= 0 ? "cold" : c <= 12 ? "cool" : c <= 24 ? "warm" : c <= 32 ? "hot" : "scorching";

function formatDate(d) {
  const cal = getCal();
  const era = cal.era ? ` ${cal.era}` : "";
  if (d.month.days === 1) return `${d.month.name}, ${d.year}${era}`;
  return `${d.day} ${d.month.name}, ${d.year}${era}`;
}

/* ------------------------------------------------------------------ */
/*  Конвертер реального времени в игровое                              */
/* ------------------------------------------------------------------ */

const REAL_UNITS = { sec: ["сек", 1], min: ["мин", 60], hour: ["ч", 3600] };
const GAME_UNITS = { min: "мин", hour: "ч", day: "сут" };

function gameUnitSec(unit, cal) {
  if (unit === "hour") return secPerHour(cal);
  if (unit === "day") return secPerDay(cal);
  return 60;
}
/** Сколько игровых секунд проходит за 1 реальную секунду */
function clockRate(clock = getClock(), cal = getCal()) {
  const real = num(clock.realAmount, 1) * (REAL_UNITS[clock.realUnit]?.[1] ?? 60);
  const game = num(clock.gameAmount, 1) * gameUnitSec(clock.gameUnit, cal);
  return real > 0 ? game / real : 0;
}
function fmtRealDuration(sec) {
  if (!Number.isFinite(sec)) return "∞";
  if (sec < 60) return `${+sec.toFixed(1)} сек`;
  if (sec < 3600) { const m = Math.floor(sec / 60), s = Math.round(sec % 60); return s ? `${m} мин ${s} сек` : `${m} мин`; }
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  return m ? `${h} ч ${m} мин` : `${h} ч`;
}
function fmtGameDuration(sec, cal) {
  const spd = secPerDay(cal), sph = secPerHour(cal);
  const d = Math.floor(sec / spd); sec -= d * spd;
  const h = Math.floor(sec / sph); sec -= h * sph;
  const m = Math.round(sec / 60);
  const parts = [];
  if (d) parts.push(`${d} сут`);
  if (h) parts.push(`${h} ч`);
  if (m || !parts.length) parts.push(`${m} мин`);
  return parts.join(" ");
}
const fmtRate = r => r >= 10 ? `×${Math.round(r)}` : `×${+r.toFixed(1)}`;

/* ------------------------------------------------------------------ */
/*  Погода: генерация                                                  */
/* ------------------------------------------------------------------ */

function generateWeather(prev, climateKey, season) {
  const c = CLIMATES[climateKey] ?? CLIMATES.temperate;
  const weights = c.weights[season] ?? c.weights.summer;
  let type = (prev?.type && weights[prev.type] > 0 && Math.random() < 0.35) ? prev.type : weightedPick(weights);
  const [hi, lo] = c.temps[season] ?? c.temps.summer;
  const shift = (Math.random() * 2 - 1) * 4;
  let high = hi + shift + (Math.random() * 2 - 1) * 1.5;
  let low = lo + shift + (Math.random() * 2 - 1) * 1.5;
  if (["cloudy", "rain", "fog", "snow"].includes(type)) { high -= 2; low += 1; }
  if (["storm", "blizzard"].includes(type)) high -= 3;
  if (type === "clear") { high += 1; low -= 1; }
  high = Math.round(high); low = Math.round(low);
  if (low > high) [low, high] = [high, low];
  if (type === "rain" && high <= 1) type = "snow";
  if (type === "storm" && high <= 1) type = "blizzard";
  if (type === "snow" && low >= 3) type = "rain";
  if (type === "blizzard" && low >= 3) type = "storm";
  const [a, b] = { storm: [2, 3], blizzard: [3, 3], windy: [2, 3], rain: [0, 2], cloudy: [0, 2], fog: [0, 0] }[type] ?? [0, 1];
  const wind = a + Math.floor(Math.random() * (b - a + 1));
  return { type, wind, high, low };
}

/* ------------------------------------------------------------------ */
/*  SVG-иконки погоды                                                  */
/* ------------------------------------------------------------------ */

const CLOUD_PATH = "M12 26 H36 A8 8 0 0 0 37.5 10.2 A11 11 0 0 0 16.5 8.5 A9 9 0 0 0 12 26 Z";

function svgSun(cx, cy, r) {
  const rays = Array.from({ length: 8 }, (_, i) => {
    const a = i * Math.PI / 4, c = Math.cos(a), s = Math.sin(a);
    return `<line x1="${(cx + c * (r + 3)).toFixed(2)}" y1="${(cy + s * (r + 3)).toFixed(2)}" x2="${(cx + c * (r + 8)).toFixed(2)}" y2="${(cy + s * (r + 8)).toFixed(2)}"/>`;
  }).join("");
  return `<g class="rtc-sun"><g class="rtc-rays" stroke="#FFC93C" stroke-width="2.6" stroke-linecap="round">${rays}</g>
    <circle class="rtc-sun-core" cx="${cx}" cy="${cy}" r="${r}" fill="#FFC93C"/>
    <circle cx="${cx - r * 0.3}" cy="${cy - r * 0.3}" r="${r * 0.45}" fill="#FFE08A" opacity=".7"/></g>`;
}

function moonPath(cx, cy, r, p) {
  const waxing = p < 0.5;
  const k = Math.cos(2 * Math.PI * p);
  const rx = Math.max(0.01, Math.abs(k) * r);
  const outer = waxing ? 1 : 0;
  const term = k > 0 ? 1 - outer : outer;
  return `M${cx} ${cy - r} A${r} ${r} 0 0 ${outer} ${cx} ${cy + r} A${rx.toFixed(2)} ${r} 0 0 ${term} ${cx} ${cy - r} Z`;
}

function svgMoon(cx, cy, r, phase) {
  return `<g class="rtc-moon">
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="#2a3352" stroke="#8b9ac4" stroke-width=".7" opacity=".85"/>
    <path d="${moonPath(cx, cy, r, phase)}" fill="#F3EFD8"/>
    <circle cx="${cx + r * 0.25}" cy="${cy - r * 0.2}" r="${r * 0.14}" fill="#000" opacity=".06"/>
    <circle cx="${cx - r * 0.2}" cy="${cy + r * 0.35}" r="${r * 0.1}" fill="#000" opacity=".06"/></g>`;
}

function svgStars() {
  const pts = [[8, 10, 1.2], [54, 8, 1], [50, 22, 1.4], [12, 30, 0.9], [58, 40, 1.1], [6, 50, 1]];
  return pts.map(([x, y, r], i) => `<circle class="rtc-star" style="animation-delay:${i * 0.45}s" cx="${x}" cy="${y}" r="${r}" fill="#fff"/>`).join("");
}

function svgCloud(x, y, s, color, cls = "") {
  return `<g transform="translate(${x} ${y}) scale(${s})"><g class="rtc-cloud ${cls}">
    <path d="${CLOUD_PATH}" fill="${color}"/>
    <path d="M14 25 H35" stroke="#000" stroke-opacity=".08" stroke-width="2" stroke-linecap="round"/></g></g>`;
}

function svgRain(xs, y0, heavy = false) {
  return `<g class="rtc-rain" stroke="#6EC1FF" stroke-width="${heavy ? 2.2 : 1.8}" stroke-linecap="round">` +
    xs.map((x, i) => `<line class="rtc-drop" style="animation-delay:${(i * 0.17).toFixed(2)}s" x1="${x}" y1="${y0}" x2="${x - 2}" y2="${y0 + 6}"/>`).join("") + `</g>`;
}

function svgSnow(xs, y0) {
  return `<g class="rtc-snow" fill="#fff">` +
    xs.map((x, i) => `<circle class="rtc-flake" style="animation-delay:${(i * 0.4).toFixed(2)}s" cx="${x}" cy="${y0 + (i % 2) * 4}" r="${i % 2 ? 1.6 : 2}"/>`).join("") + `</g>`;
}

function svgBolt() {
  return `<polygon class="rtc-bolt" points="34,32 26,46 32,46 28,58 40,42 34,42 38,32" fill="#FFE14D" stroke="#F5B800" stroke-width=".8" stroke-linejoin="round"/>`;
}

function svgWind(scale = 1, x = 0, y = 0, width = 3) {
  const paths = ["M6 24 H38 a7 7 0 1 0 -7 -7", "M4 34 H48 a7 7 0 1 1 -7 7", "M10 44 H30"];
  const trail = paths.map(d => `<path d="${d}"/>`).join("");
  const gusts = paths.map((d, i) => `<path class="rtc-gust g${i + 1}" d="${d}"/>`).join("");
  return `<g transform="translate(${x} ${y}) scale(${scale})"><g class="rtc-wind" fill="none" stroke-width="${width}" stroke-linecap="round">
    <g stroke="#DDEBFA" opacity=".55">${trail}</g><g stroke="#FFFFFF">${gusts}</g></g></g>`;
}

function svgFog() {
  return `<g class="rtc-fog" stroke="#E3E8EF" stroke-width="3" stroke-linecap="round">
    <line class="rtc-fogline f1" x1="10" y1="40" x2="54" y2="40"/>
    <line class="rtc-fogline f2" x1="6" y1="48" x2="46" y2="48"/>
    <line class="rtc-fogline f3" x1="16" y1="56" x2="58" y2="56"/></g>`;
}

/** Главная функция иконки: тип погоды + ночь/день + ветер + фаза луны */
function weatherSVG({ type = "clear", night = false, wind = 0, phase = 0.5, cls = "" } = {}) {
  const light = night ? "#AEB8CC" : "#F4F7FB";
  const mid = night ? "#7E89A3" : "#C9D2DF";
  const dark = night ? "#4E5770" : "#7D879C";
  let body = "";
  const celestial = (cx, cy, r) => night ? svgMoon(cx, cy, r, phase) : svgSun(cx, cy, r);
  switch (type) {
    case "clear":
      body = night ? svgStars() + svgMoon(32, 32, 15, phase) : svgSun(32, 32, 12);
      break;
    case "partly":
      body = (night ? svgStars() : "") + celestial(24, 22, night ? 11 : 9) + svgCloud(16, 30, 0.95, light);
      break;
    case "cloudy":
      body = svgCloud(2, 12, 0.8, mid, "slow") + svgCloud(13, 26, 1, light);
      break;
    case "fog":
      body = svgCloud(10, 6, 0.85, mid, "slow") + svgFog();
      break;
    case "windy":
      body = (night ? svgMoon(48, 14, 8, phase) : svgSun(48, 14, 6)) + svgWind(1, 0, 6);
      break;
    case "rain":
      body = svgCloud(8, 6, 1, mid) + svgRain([20, 28, 36, 44, 52], 40);
      break;
    case "storm":
      body = svgCloud(8, 4, 1, dark) + svgRain([18, 46, 54], 38, true) + svgBolt();
      break;
    case "snow":
      body = svgCloud(8, 6, 1, light) + svgSnow([18, 26, 34, 42, 50], 40);
      break;
    case "blizzard":
      body = svgCloud(8, 4, 1, mid) + svgSnow([16, 24, 32, 40, 48, 56], 38) + svgWind(0.55, 4, 30, 4.5);
      break;
  }
  if (wind >= 2 && !["windy", "blizzard"].includes(type)) body += svgWind(0.5, 0, 38, 5);
  return `<svg class="rtc-svg ${cls}" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">${body}</svg>`;
}

/* ------------------------------------------------------------------ */
/*  Виджет на экране                                                   */
/* ------------------------------------------------------------------ */

class CalendarWidget {
  el = null;
  iconKey = null;

  mount() {
    if (this.el) return;
    const el = document.createElement("div");
    el.id = "rtc-widget";
    el.className = "rtc-widget";
    el.innerHTML = `
      <header class="rtc-header">
        <span class="rtc-weekday" data-f="weekday"></span>
        <span class="rtc-run" data-f="run"></span>
        <a class="rtc-hbtn" data-a="collapse" data-tooltip="Свернуть / развернуть"><i class="fa-solid fa-chevron-up"></i></a>
      </header>
      <section class="rtc-sky">
        <div class="rtc-fx"></div>
        <div class="rtc-icon" data-f="icon"></div>
        <div class="rtc-clock">
          <div class="rtc-time" data-f="time"></div>
          <div class="rtc-period" data-f="period"></div>
        </div>
        <div class="rtc-temp" data-f="temp"></div>
      </section>
      <section class="rtc-location" data-f="location"></section>
      <section class="rtc-body">
        <div class="rtc-date" data-f="date"></div>
        <div class="rtc-weather" data-f="weather"></div>
        <div class="rtc-daybar"><div class="rtc-daybar-track" data-f="track"></div><div class="rtc-daybar-mark" data-f="mark"></div></div>
      </section>
      ${game.user.isGM ? `
      <footer class="rtc-gm">
        <a data-a="adv" data-sec="-hour" data-tooltip="Назад на 1 час"><i class="fa-solid fa-backward"></i></a>
        <a data-a="adv" data-sec="-10m" data-tooltip="Назад на 10 минут"><i class="fa-solid fa-backward-step"></i></a>
        <a data-a="toggle" class="rtc-play" data-tooltip="Запустить / остановить ход времени"><i class="fa-solid fa-play"></i></a>
        <a data-a="adv" data-sec="10m" data-tooltip="Вперёд на 10 минут"><i class="fa-solid fa-forward-step"></i></a>
        <a data-a="adv" data-sec="hour" data-tooltip="Вперёд на 1 час"><i class="fa-solid fa-forward"></i></a>
        <a data-a="adv" data-sec="rest" data-tooltip="Длинный отдых: +8 часов"><i class="fa-solid fa-bed"></i></a>
        <a data-a="adv" data-sec="day" data-tooltip="Вперёд на сутки"><i class="fa-solid fa-calendar-plus"></i></a>
        <span class="rtc-sep"></span>
        <a data-a="weather" data-tooltip="Погода"><i class="fa-solid fa-cloud-sun-rain"></i></a>
        <a data-a="config" data-tooltip="Настройки календаря и времени"><i class="fa-solid fa-gear"></i></a>
      </footer>` : ""}`;
    document.body.appendChild(el);
    this.el = el;
    this.#restorePosition();
    this.#bind();
    this.setCollapsed(game.settings.get(MODULE_ID, K.collapsed), false);
    this.render();
  }

  unmount() { this.el?.remove(); this.el = null; this.iconKey = null; }

  setCollapsed(v, save = true) {
    this.el?.classList.toggle("collapsed", !!v);
    if (save) game.settings.set(MODULE_ID, K.collapsed, !!v);
  }

  #f(name) { return this.el.querySelector(`[data-f="${name}"]`); }

  render() {
    if (!this.el) return;
    const cal = getCal(), w = getWeather(), clock = getClock();
    const d = decompose(game.time.worldTime, cal);
    const night = isNightHour(d.hourFloat, cal);
    const period = periodOf(d.hourFloat, cal);
    const tC = tempAt(d.hourFloat, cal, w);
    const phaseIdx = Math.round(d.moonPhase * 8) % 8;

    this.el.dataset.period = period;
    this.el.dataset.weather = w.type;
    this.el.classList.toggle("night", night);

    const key = `${w.type}|${night}|${w.wind >= 2}|${phaseIdx}`;
    if (key !== this.iconKey) {
      this.iconKey = key;
      this.#f("icon").innerHTML = weatherSVG({ type: w.type, night, wind: w.wind, phase: phaseIdx / 8 });
    }

    this.#f("time").textContent = `${pad(d.hour)}:${pad(d.minute)}`;
    this.#f("period").textContent = night ? `${PERIODS[period]} · ${d.moonName}` : `${PERIODS[period]} · ${SEASONS[d.month.season]}`;
    const temp = this.#f("temp");
    temp.textContent = fmtTemp(tC, w.unit);
    temp.dataset.t = tempClass(tC);
    this.#f("weekday").textContent = d.weekday;
    this.#f("date").textContent = formatDate(d);
    this.renderLocation();
    this.#f("weather").innerHTML = `<i class="fa-solid fa-cloud-sun"></i> ${esc(WEATHER[w.type]?.label ?? w.type)} · <i class="fa-solid fa-wind"></i> ${esc(WIND[w.wind] ?? "")}`;

    // Полоса суток
    const H = cal.hoursPerDay, P = h => `${clamp(h / H * 100, 0, 100).toFixed(2)}%`;
    const S = cal.sunrise, E = cal.sunset;
    this.#f("track").style.background = `linear-gradient(90deg, #0d1330 0%, #18214a ${P(S - 1.5)}, #e98b5f ${P(S)}, #7ec3ff ${P(S + 1.5)}, #8fd0ff ${P((S + E) / 2)}, #7ec3ff ${P(E - 1.5)}, #e0775f ${P(E)}, #18214a ${P(E + 1.5)}, #0d1330 100%)`;
    const mark = this.#f("mark");
    mark.style.left = P(d.hourFloat);
    mark.classList.toggle("moon", night);

    // Статус хода времени
    const run = this.#f("run");
    const rate = clockRate(clock, cal);
    const blocked = clock.running && ((clock.pauseWithGame && game.paused) || (clock.pauseInCombat && game.combat?.started));
    run.className = `rtc-run ${clock.running ? (blocked ? "held" : "on") : "off"}`;
    run.innerHTML = clock.running
      ? (blocked ? `<i class="fa-solid fa-pause"></i> ${game.combat?.started && clock.pauseInCombat ? "бой" : "пауза"}` : `<i class="fa-solid fa-play"></i> ${fmtRate(rate)}`)
      : `<i class="fa-solid fa-stop"></i> стоп`;
    run.dataset.tooltip = clock.running
      ? `Время идёт: ${clock.realAmount} ${REAL_UNITS[clock.realUnit]?.[0]} реальных = ${clock.gameAmount} ${GAME_UNITS[clock.gameUnit]} игровых`
      : "Время остановлено (ГМ двигает вручную)";
    const play = this.el.querySelector(".rtc-play i");
    if (play) play.className = clock.running ? "fa-solid fa-pause" : "fa-solid fa-play";
  }

  renderLocation() {
    if (!this.el) return;
    const box = this.#f("location");
    if (!box || box.classList.contains("editing")) return;
    const loc = getLocation();
    const gm = game.user.isGM;
    box.hidden = !loc.name && !gm;
    box.classList.toggle("empty", !loc.name);
    box.innerHTML = loc.name
      ? `<i class="fa-solid fa-location-dot rtc-pin"></i>
         <div class="rtc-loc-text"><div class="rtc-loc-name">${esc(loc.name)}</div>${loc.region ? `<div class="rtc-loc-region">${esc(loc.region)}</div>` : ""}</div>
         ${gm ? `<a class="rtc-loc-edit" data-a="loc-edit" data-tooltip="Изменить локацию"><i class="fa-solid fa-pen"></i></a>` : ""}`
      : `<a class="rtc-loc-add" data-a="loc-edit"><i class="fa-solid fa-location-dot"></i> Указать локацию…</a>`;
  }

  editLocation() {
    if (!game.user.isGM) return;
    const box = this.#f("location");
    const loc = getLocation();
    box.hidden = false;
    box.classList.add("editing");
    const listId = "rtc-loc-recent";
    box.innerHTML = `
      <div class="rtc-loc-form">
        <input type="text" name="locName" list="${listId}" placeholder="Название локации (Невервинтер, Таверна «Пьяный дракон»…)" value="${esc(loc.name)}">
        <input type="text" name="locRegion" placeholder="Регион / уточнение (необязательно)" value="${esc(loc.region)}">
        <datalist id="${listId}">${loc.recent.map(r => `<option value="${esc(r.name)}">${esc(r.region)}</option>`).join("")}</datalist>
        <div class="rtc-loc-actions">
          <label data-tooltip="Сообщить игрокам в чат"><input type="checkbox" name="locAnnounce" ${loc.announce ? "checked" : ""}> в чат</label>
          ${canvas?.scene ? `<a data-a="loc-scene" data-tooltip="Взять название текущей сцены"><i class="fa-solid fa-map"></i></a>` : ""}
          <a data-a="loc-clear" data-tooltip="Убрать локацию"><i class="fa-solid fa-eraser"></i></a>
          <a data-a="loc-cancel" data-tooltip="Отмена (Esc)"><i class="fa-solid fa-xmark"></i></a>
          <a data-a="loc-save" class="ok" data-tooltip="Сохранить (Enter)"><i class="fa-solid fa-check"></i></a>
        </div>
      </div>`;
    const name = box.querySelector('[name="locName"]');
    const region = box.querySelector('[name="locRegion"]');
    name.addEventListener("change", () => {
      const hit = loc.recent.find(r => r.name === name.value);
      if (hit && !region.value) region.value = hit.region;
    });
    box.addEventListener("keydown", e => {
      e.stopPropagation();
      if (e.key === "Enter") { e.preventDefault(); this.#saveLocationForm(); }
      if (e.key === "Escape") { e.preventDefault(); this.#closeLocationForm(); }
    });
    name.focus();
    name.select();
  }

  async #saveLocationForm() {
    const box = this.#f("location");
    const name = box.querySelector('[name="locName"]')?.value ?? "";
    const region = box.querySelector('[name="locRegion"]')?.value ?? "";
    const announce = !!box.querySelector('[name="locAnnounce"]')?.checked;
    const prev = getLocation();
    if (prev.announce !== announce) await setSetting(K.location, { ...prev, announce });
    this.#closeLocationForm(false);
    await setLocation(name, region, { announce });
    this.renderLocation();
  }

  #closeLocationForm(render = true) {
    const box = this.#f("location");
    box.classList.remove("editing");
    if (render) this.renderLocation();
  }

  #bind() {
    const el = this.el;
    el.addEventListener("click", ev => {
      const a = ev.target.closest("[data-a]");
      if (!a) return;
      ev.preventDefault();
      const act = a.dataset.a;
      if (act === "collapse") return this.setCollapsed(!el.classList.contains("collapsed"));
      if (!game.user.isGM) return;
      if (act === "toggle") {
        const c = getClock();
        return setSetting(K.clock, { ...c, running: !c.running });
      }
      if (act === "adv") return advanceBy(a.dataset.sec);
      if (act === "weather") return openConfig("weather");
      if (act === "config") return openConfig("time");
      if (act === "loc-edit") return this.editLocation();
      if (act === "loc-save") return this.#saveLocationForm();
      if (act === "loc-cancel") return this.#closeLocationForm();
      if (act === "loc-clear") { this.#closeLocationForm(false); return setLocation("", ""); }
      if (act === "loc-scene") {
        const n = el.querySelector('[name="locName"]');
        if (n && canvas?.scene) n.value = canvas.scene.navName || canvas.scene.name;
      }
    });
    el.querySelector(".rtc-sky").addEventListener("dblclick", () => {
      if (game.user.isGM) openConfig("time");
    });

    // Перетаскивание за шапку
    const header = el.querySelector(".rtc-header");
    header.addEventListener("pointerdown", ev => {
      if (ev.button !== 0 || ev.target.closest("[data-a]")) return;
      ev.preventDefault();
      const rect = el.getBoundingClientRect();
      const dx = ev.clientX - rect.left, dy = ev.clientY - rect.top;
      el.classList.add("dragging");
      const move = e => {
        el.style.left = `${clamp(e.clientX - dx, 0, window.innerWidth - el.offsetWidth)}px`;
        el.style.top = `${clamp(e.clientY - dy, 0, window.innerHeight - 40)}px`;
      };
      const up = () => {
        el.classList.remove("dragging");
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        game.settings.set(MODULE_ID, K.pos, { left: parseInt(el.style.left), top: parseInt(el.style.top) });
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });
  }

  #restorePosition() {
    const pos = game.settings.get(MODULE_ID, K.pos) ?? {};
    const left = Number.isFinite(pos.left) ? pos.left : Math.max(10, window.innerWidth - 640);
    const top = Number.isFinite(pos.top) ? pos.top : 12;
    this.el.style.left = `${clamp(left, 0, window.innerWidth - 120)}px`;
    this.el.style.top = `${clamp(top, 0, window.innerHeight - 40)}px`;
  }
}

const widget = new CalendarWidget();

/* ------------------------------------------------------------------ */
/*  Управление временем (только ГМ)                                    */
/* ------------------------------------------------------------------ */

async function advanceBy(code) {
  const cal = getCal();
  const sph = secPerHour(cal);
  const map = { "10m": 600, "-10m": -600, hour: sph, "-hour": -sph, rest: 8 * sph, day: secPerDay(cal) };
  const delta = map[code] ?? num(code, 0);
  if (delta) await game.time.advance(delta);
}

async function setDateTime(parts) {
  const cal = getCal();
  const target = compose(cal, parts);
  const cur = game.time.worldTime;
  const curMin = Math.floor(cur / 60) * 60;
  if (target !== curMin) await game.time.advance(target - cur);
}

/** Реальное время → игровое. Работает только у активного ГМа. */
const ticker = {
  interval: null, last: 0, sinceFlush: 0, acc: 0,
  start() {
    this.stop();
    this.last = Date.now();
    this.interval = setInterval(() => this.tick(), 1000);
  },
  stop() { if (this.interval) clearInterval(this.interval); this.interval = null; },
  tick() {
    const now = Date.now();
    const dt = (now - this.last) / 1000;
    this.last = now;
    if (!isActiveGM()) return;
    const clock = getClock();
    if (!clock.running) { this.acc = 0; this.sinceFlush = 0; return; }
    if ((clock.pauseWithGame && game.paused) || (clock.pauseInCombat && game.combat?.started)) return;
    this.acc += clockRate(clock) * Math.min(dt, 5);
    this.sinceFlush += dt;
    if (this.sinceFlush >= Math.max(1, num(clock.tickSeconds, 5))) {
      this.sinceFlush = 0;
      const whole = Math.floor(this.acc);
      if (whole > 0) { this.acc -= whole; game.time.advance(whole); }
    }
  }
};

/** Смена дня → автопогода; время суток → затемнение сцены */
let darknessTimer = null;
async function onTimeChanged() {
  widget.render();
  if (!isActiveGM()) return;
  const cal = getCal();
  const d = decompose(game.time.worldTime, cal);
  const w = getWeather();
  if (w.day === null || w.day === undefined) {
    await setSetting(K.weather, { ...w, day: d.totalDays });
  } else if (w.auto && w.day !== d.totalDays) {
    const next = { ...w, ...generateWeather(w, w.climate, d.month.season), day: d.totalDays };
    await setSetting(K.weather, next);
    if (next.announce) announceWeather(next);
  }
  clearTimeout(darknessTimer);
  darknessTimer = setTimeout(syncDarkness, 400);
}

async function syncDarkness() {
  const cal = getCal();
  const scene = canvas?.scene;
  if (!cal.syncDarkness || !scene || !isActiveGM()) return;
  const d = decompose(game.time.worldTime, cal);
  const target = darknessAt(d.hourFloat, cal, getWeather().type);
  const current = scene.environment?.darknessLevel ?? scene.darkness ?? 0;
  if (Math.abs(current - target) < 0.04) return;
  await scene.update({ "environment.darknessLevel": target }, { animateDarkness: 2500 });
}

function announceWeather(w) {
  const cal = getCal();
  const d = decompose(game.time.worldTime, cal);
  const night = isNightHour(d.hourFloat, cal);
  const content = `<div class="rtc-chat">
    <div class="rtc-chat-icon">${weatherSVG({ type: w.type, night, wind: w.wind, phase: Math.round(d.moonPhase * 8) % 8 / 8 })}</div>
    <div class="rtc-chat-text">
      <div class="rtc-chat-date">${esc(d.weekday)}, ${esc(formatDate(d))}</div>
      <div class="rtc-chat-title">${esc(WEATHER[w.type]?.label)}</div>
      <div>${esc(WIND[w.wind])} · днём ${fmtTemp(w.high, w.unit)}, ночью ${fmtTemp(w.low, w.unit)}</div>
    </div></div>`;
  ChatMessage.create({ content, speaker: { alias: "Погода" } });
}

/* ------------------------------------------------------------------ */
/*  Окно настроек ГМа                                                  */
/* ------------------------------------------------------------------ */

let ConfigClass = null;
let configApp = null;

function openConfig(tab = "time") {
  if (!game.user.isGM) return;
  if (configApp?.rendered) { configApp.setTab(tab); configApp.bringToFront?.(); return; }
  configApp = new (getConfigClass())({ tab });
  configApp.render({ force: true });
}

function getConfigClass() {
  if (ConfigClass) return ConfigClass;
  const { ApplicationV2 } = foundry.applications.api;

  ConfigClass = class CalendarConfig extends ApplicationV2 {
    static DEFAULT_OPTIONS = {
      id: "rtc-config",
      classes: ["rtc-config-app"],
      tag: "div",
      window: { title: "Календарь и погода", icon: "fa-solid fa-cloud-sun", resizable: true },
      position: { width: 660, height: 740 }
    };

    constructor(options = {}) {
      super(options);
      this.tab = options.tab ?? "time";
    }

    setTab(tab) {
      this.tab = tab;
      const root = this.element?.querySelector(".rtc-cfg");
      if (!root) return;
      root.querySelectorAll("[data-tab]").forEach(n => n.classList.toggle("active", n.dataset.tab === tab));
    }

    async _renderHTML() {
      const cal = getCal(), clock = getClock(), w = getWeather(), loc = getLocation();
      const d = decompose(game.time.worldTime, cal);
      const opt = (obj, sel) => Object.entries(obj).map(([k, v]) => `<option value="${k}" ${k === sel ? "selected" : ""}>${esc(Array.isArray(v) ? v[0] : (v.label ?? v))}</option>`).join("");
      const monthRows = cal.months.map(m => monthRowHTML(m)).join("");
      const night = isNightHour(d.hourFloat, cal);
      const tiles = Object.entries(WEATHER).map(([k, v]) => `
        <button type="button" class="rtc-tile ${k === w.type ? "active" : ""}" data-weather="${k}">
          ${weatherSVG({ type: k, night, wind: 0, phase: Math.round(d.moonPhase * 8) % 8 / 8 })}<span>${esc(v.label)}</span>
        </button>`).join("");

      return `<div class="rtc-cfg">
        <nav class="rtc-tabs">
          <a data-tab="time" data-nav><i class="fa-solid fa-clock"></i> Время</a>
          <a data-tab="weather" data-nav><i class="fa-solid fa-cloud-sun-rain"></i> Погода</a>
          <a data-tab="calendar" data-nav><i class="fa-solid fa-calendar-days"></i> Календарь</a>
          <a data-tab="sky" data-nav><i class="fa-solid fa-moon"></i> Небо и свет</a>
        </nav>

        <div class="rtc-pane" data-tab="time">
          <h3><i class="fa-solid fa-calendar-check"></i> Текущая дата и время</h3>
          <div class="rtc-row rtc-date-row">
            <label>День <input type="number" name="day" min="1" value="${d.day}"></label>
            <label class="grow">Месяц <select name="month">${cal.months.map((m, i) => `<option value="${i}" ${i === d.monthIndex ? "selected" : ""}>${esc(m.name)}</option>`).join("")}</select></label>
            <label>Год <input type="number" name="year" value="${d.year}"></label>
          </div>
          <div class="rtc-row">
            <label>Час <input type="number" name="hour" min="0" max="${cal.hoursPerDay - 1}" value="${d.hour}"></label>
            <label>Минута <input type="number" name="minute" min="0" max="${cal.minutesPerHour - 1}" value="${d.minute}"></label>
            <div class="rtc-quick">
              <button type="button" data-settime="dawn"><i class="fa-solid fa-sun"></i> Рассвет</button>
              <button type="button" data-settime="noon"><i class="fa-solid fa-sun"></i> Полдень</button>
              <button type="button" data-settime="dusk"><i class="fa-solid fa-cloud-sun"></i> Закат</button>
              <button type="button" data-settime="midnight"><i class="fa-solid fa-moon"></i> Полночь</button>
            </div>
          </div>

          <h3><i class="fa-solid fa-location-dot"></i> Где сейчас партия</h3>
          <div class="rtc-row">
            <label class="grow">Локация <input type="text" name="locName" list="rtc-cfg-recent" placeholder="Например: Фандалин" value="${esc(loc.name)}"></label>
            <label class="grow">Регион / уточнение <input type="text" name="locRegion" placeholder="Например: Побережье Мечей" value="${esc(loc.region)}"></label>
            <datalist id="rtc-cfg-recent">${loc.recent.map(r => `<option value="${esc(r.name)}">${esc(r.region)}</option>`).join("")}</datalist>
          </div>
          ${loc.recent.length ? `<div class="rtc-presets rtc-recent">${loc.recent.map(r => `<button type="button" data-recent="${esc(r.name)}" data-region="${esc(r.region)}" data-tooltip="${esc(r.region)}"><i class="fa-solid fa-location-dot"></i> ${esc(r.name)}</button>`).join("")}</div>` : ""}
          <div class="rtc-row">
            <label class="rtc-check"><input type="checkbox" name="locAnnounce" ${loc.announce ? "checked" : ""}> Сообщать о смене локации в чат</label>
            <label class="rtc-check"><input type="checkbox" name="locAutoScene" ${loc.autoScene ? "checked" : ""}> Брать название сцены при её активации</label>
          </div>

          <h3><i class="fa-solid fa-hourglass-half"></i> Конвертер: реальное время → игровое</h3>
          <label class="rtc-check"><input type="checkbox" name="running" ${clock.running ? "checked" : ""}> Время в игре идёт само по реальным часам</label>
          <div class="rtc-row rtc-conv">
            <input type="number" name="realAmount" min="0.1" step="0.1" value="${clock.realAmount}">
            <select name="realUnit">${opt(REAL_UNITS, clock.realUnit)}</select>
            <span class="rtc-eq">реального&nbsp;=</span>
            <input type="number" name="gameAmount" min="0.1" step="0.1" value="${clock.gameAmount}">
            <select name="gameUnit">${opt(GAME_UNITS, clock.gameUnit)}</select>
            <span class="rtc-eq">игрового</span>
          </div>
          <div class="rtc-presets">
            <button type="button" data-conv="1,sec,1,min">1:1 реальное</button>
            <button type="button" data-conv="1,min,5,min">1 мин = 5 мин</button>
            <button type="button" data-conv="1,min,10,min">1 мин = 10 мин</button>
            <button type="button" data-conv="10,min,1,hour">10 мин = 1 час</button>
            <button type="button" data-conv="1,min,1,hour">1 мин = 1 час</button>
            <button type="button" data-conv="1,hour,1,day">1 час = сутки</button>
          </div>
          <div class="rtc-preview" data-preview></div>
          <div class="rtc-row">
            <label class="rtc-check"><input type="checkbox" name="pauseWithGame" ${clock.pauseWithGame ? "checked" : ""}> Стоять на паузе игры</label>
            <label class="rtc-check"><input type="checkbox" name="pauseInCombat" ${clock.pauseInCombat ? "checked" : ""}> Стоять во время боя</label>
          </div>
          <label class="rtc-inline">Синхронизировать с игроками каждые <input type="number" name="tickSeconds" min="1" max="60" value="${clock.tickSeconds}"> сек реального времени</label>
        </div>

        <div class="rtc-pane" data-tab="weather">
          <h3><i class="fa-solid fa-cloud-sun-rain"></i> Погода сейчас</h3>
          <input type="hidden" name="wtype" value="${w.type}">
          <div class="rtc-tiles ${night ? "night" : ""}">${tiles}</div>
          <div class="rtc-row">
            <label class="grow">Ветер <span class="rtc-wind-label" data-windlabel>${esc(WIND[w.wind])}</span>
              <input type="range" name="wind" min="0" max="3" step="1" value="${w.wind}"></label>
          </div>
          <div class="rtc-row">
            <label>Днём, °C <input type="number" name="high" value="${w.high}"></label>
            <label>Ночью, °C <input type="number" name="low" value="${w.low}"></label>
            <label>Показывать в <select name="unit"><option value="C" ${w.unit === "C" ? "selected" : ""}>°C</option><option value="F" ${w.unit === "F" ? "selected" : ""}>°F</option></select></label>
          </div>
          <h3><i class="fa-solid fa-dice"></i> Автопогода</h3>
          <div class="rtc-row">
            <label class="grow">Климат <select name="climate">${opt(CLIMATES, w.climate)}</select></label>
            <button type="button" class="rtc-btn" data-randomize><i class="fa-solid fa-shuffle"></i> Случайная погода</button>
          </div>
          <label class="rtc-check"><input type="checkbox" name="auto" ${w.auto ? "checked" : ""}> Менять погоду автоматически при наступлении нового дня (по климату и сезону)</label>
          <label class="rtc-check"><input type="checkbox" name="announce" ${w.announce ? "checked" : ""}> Сообщать о смене погоды в чат</label>
          <p class="rtc-hint">Текущий сезон: <b>${SEASONS[d.month.season]}</b>. Температура в виджете плавно меняется в течение суток между «ночью» и «днём».</p>
        </div>

        <div class="rtc-pane" data-tab="calendar">
          <h3><i class="fa-solid fa-book"></i> Готовый календарь</h3>
          <div class="rtc-row">
            <select name="preset" class="grow">${opt(PRESETS, cal.preset)}<option value="custom" ${cal.preset === "custom" ? "selected" : ""}>Свой</option></select>
            <button type="button" class="rtc-btn" data-applypreset><i class="fa-solid fa-wand-magic-sparkles"></i> Подставить</button>
          </div>
          <h3><i class="fa-solid fa-list"></i> Месяцы <small>название, число дней и сезон; порядок — стрелками</small></h3>
          <div class="rtc-months" data-months>${monthRows}</div>
          <div class="rtc-addmonth">
            <span class="rtc-addmonth-title"><i class="fa-solid fa-plus"></i> Добавить свой месяц</span>
            <input type="text" data-newmonth="name" placeholder="Название, например «Месяц Льда»">
            <input type="number" data-newmonth="days" min="1" value="30" title="Дней">
            <select data-newmonth="season">${opt(SEASONS, "winter")}</select>
            <select data-newmonth="pos" title="Куда вставить"><option value="end">в конец</option><option value="start">в начало</option></select>
            <button type="button" class="rtc-btn" data-addmonth><i class="fa-solid fa-plus"></i> Добавить</button>
          </div>
          <p class="rtc-hint">Чтобы играть по своему календарю: выберите «Свой» или очистите список кнопкой <button type="button" class="rtc-btn rtc-mini" data-clearmonths><i class="fa-solid fa-eraser"></i> Очистить месяцы</button> и добавьте месяцы по одному.</p>
          <h3><i class="fa-solid fa-calendar-week"></i> Дни недели <small>через запятую</small></h3>
          <textarea name="weekdays" rows="2">${esc(cal.weekdays.join(", "))}</textarea>
          <div class="rtc-row">
            <label>Часов в сутках <input type="number" name="hoursPerDay" min="1" value="${cal.hoursPerDay}"></label>
            <label>Минут в часе <input type="number" name="minutesPerHour" min="1" value="${cal.minutesPerHour}"></label>
            <label>Первый год <input type="number" name="startYear" value="${cal.startYear}"></label>
            <label>Эра <input type="text" name="era" value="${esc(cal.era)}"></label>
            <label>Сдвиг недели <input type="number" name="weekdayOffset" value="${cal.weekdayOffset}"></label>
          </div>
          <p class="rtc-hint">После изменения месяцев дата из вкладки «Время» будет установлена заново под новый календарь.</p>
        </div>

        <div class="rtc-pane" data-tab="sky">
          <h3><i class="fa-solid fa-sun"></i> Солнце</h3>
          <div class="rtc-row">
            <label>Восход, ч <input type="number" step="0.25" name="sunrise" value="${cal.sunrise}"></label>
            <label>Закат, ч <input type="number" step="0.25" name="sunset" value="${cal.sunset}"></label>
          </div>
          <h3><i class="fa-solid fa-moon"></i> Луна</h3>
          <div class="rtc-row">
            <label>Цикл, дней <input type="number" step="0.1" name="moonCycle" value="${cal.moonCycle}"></label>
            <label>Сдвиг фазы, дней <input type="number" step="0.5" name="moonOffset" value="${cal.moonOffset}"></label>
            <div class="rtc-moonnow">${weatherSVG({ type: "clear", night: true, phase: d.moonPhase })}<span>${esc(d.moonName)}</span></div>
          </div>
          <h3><i class="fa-solid fa-circle-half-stroke"></i> Освещение сцены</h3>
          <label class="rtc-check"><input type="checkbox" name="syncDarkness" ${cal.syncDarkness ? "checked" : ""}> Менять затемнение активной сцены по времени суток и погоде</label>
          <label class="rtc-inline">Максимальная темнота ночью <input type="range" name="maxDarkness" min="0" max="1" step="0.05" value="${cal.maxDarkness}"> <b data-darklabel>${Math.round(cal.maxDarkness * 100)}%</b></label>
        </div>

        <footer class="rtc-cfg-footer">
          <button type="button" class="rtc-btn" data-save="close"><i class="fa-solid fa-check"></i> Сохранить и закрыть</button>
          <button type="button" class="rtc-btn primary" data-save><i class="fa-solid fa-floppy-disk"></i> Применить</button>
        </footer>
      </div>`;
    }

    _replaceHTML(result, content) {
      content.innerHTML = result;
      this.#activate(content);
    }

    #activate(root) {
      const $ = sel => root.querySelector(sel);
      const field = name => root.querySelector(`[name="${name}"]`);
      this.setTab(this.tab);

      root.querySelectorAll("[data-nav]").forEach(a => a.addEventListener("click", () => this.setTab(a.dataset.tab)));
      root.querySelectorAll("[data-recent]").forEach(b => b.addEventListener("click", () => {
        field("locName").value = b.dataset.recent;
        field("locRegion").value = b.dataset.region;
      }));

      // превью конвертера
      const updatePreview = () => {
        const cal = getCal();
        const clock = {
          realAmount: num(field("realAmount").value, 1), realUnit: field("realUnit").value,
          gameAmount: num(field("gameAmount").value, 1), gameUnit: field("gameUnit").value
        };
        const rate = clockRate(clock, cal);
        $("[data-preview]").innerHTML = rate > 0 ? `
          <div><i class="fa-solid fa-gauge-high"></i> Скорость: <b>${fmtRate(rate)}</b> к реальному времени</div>
          <div><i class="fa-solid fa-hourglass-start"></i> Игровой час проходит за <b>${fmtRealDuration(secPerHour(cal) / rate)}</b> реального</div>
          <div><i class="fa-solid fa-sun"></i> Игровые сутки — за <b>${fmtRealDuration(secPerDay(cal) / rate)}</b> реального</div>
          <div><i class="fa-solid fa-dice-d20"></i> 10 минут реального = <b>${fmtGameDuration(600 * rate, cal)}</b> в игре, 4-часовая сессия = <b>${fmtGameDuration(14400 * rate, cal)}</b></div>`
          : `<div>Укажите значения больше нуля</div>`;
      };
      ["realAmount", "realUnit", "gameAmount", "gameUnit"].forEach(n => field(n).addEventListener("input", updatePreview));
      root.querySelectorAll("[data-conv]").forEach(b => b.addEventListener("click", () => {
        const [ra, ru, ga, gu] = b.dataset.conv.split(",");
        field("realAmount").value = ra; field("realUnit").value = ru;
        field("gameAmount").value = ga; field("gameUnit").value = gu;
        updatePreview();
      }));
      updatePreview();

      // быстрые кнопки времени
      root.querySelectorAll("[data-settime]").forEach(b => b.addEventListener("click", () => {
        const S = num(field("sunrise").value, 6), E = num(field("sunset").value, 20), H = num(field("hoursPerDay").value, 24);
        const h = { dawn: S, noon: (S + E) / 2, dusk: E, midnight: 0 }[b.dataset.settime];
        field("hour").value = Math.floor(h) % H;
        field("minute").value = Math.round((h % 1) * num(field("minutesPerHour").value, 60));
      }));

      // погода
      root.querySelectorAll("[data-weather]").forEach(t => t.addEventListener("click", () => {
        root.querySelectorAll("[data-weather]").forEach(x => x.classList.toggle("active", x === t));
        field("wtype").value = t.dataset.weather;
      }));
      field("wind").addEventListener("input", e => { $("[data-windlabel]").textContent = WIND[e.target.value]; });
      $("[data-randomize]").addEventListener("click", () => {
        const cal = getCal();
        const season = cal.months[num(field("month").value, 0)]?.season ?? "summer";
        const g = generateWeather({ type: field("wtype").value }, field("climate").value, season);
        field("wtype").value = g.type;
        root.querySelectorAll("[data-weather]").forEach(x => x.classList.toggle("active", x.dataset.weather === g.type));
        field("wind").value = g.wind; $("[data-windlabel]").textContent = WIND[g.wind];
        field("high").value = g.high; field("low").value = g.low;
      });

      // календарь
      $("[data-applypreset]").addEventListener("click", () => {
        const p = PRESETS[field("preset").value];
        if (!p) return;
        $("[data-months]").innerHTML = p.months.map(([name, days, season]) => monthRowHTML({ name, days, season })).join("");
        field("weekdays").value = p.weekdays.join(", ");
        field("hoursPerDay").value = p.hoursPerDay;
        field("minutesPerHour").value = p.minutesPerHour;
        field("startYear").value = p.startYear;
        field("era").value = p.era;
        field("moonCycle").value = p.moonCycle;
        field("year").value = p.startYear;
      });
      const monthsBox = $("[data-months]");
      const markCustom = () => { field("preset").value = "custom"; };
      monthsBox.addEventListener("click", ev => {
        const btn = ev.target.closest("[data-mact]");
        if (!btn) return;
        const row = btn.closest(".rtc-month");
        const act = btn.dataset.mact;
        if (act === "del") {
          if (monthsBox.children.length <= 1) return ui.notifications.warn("Нужен хотя бы один месяц");
          row.remove();
        } else if (act === "up" && row.previousElementSibling) row.parentNode.insertBefore(row, row.previousElementSibling);
        else if (act === "down" && row.nextElementSibling) row.parentNode.insertBefore(row.nextElementSibling, row);
        markCustom();
      });
      monthsBox.addEventListener("input", markCustom);
      $("[data-addmonth]").addEventListener("click", () => {
        const nf = k => $(`[data-newmonth="${k}"]`);
        const name = nf("name").value.trim();
        if (!name) { nf("name").focus(); return ui.notifications.warn("Введите название месяца"); }
        const html = monthRowHTML({ name, days: Math.max(1, Math.round(num(nf("days").value, 30))), season: nf("season").value });
        monthsBox.insertAdjacentHTML(nf("pos").value === "start" ? "afterbegin" : "beforeend", html);
        nf("name").value = "";
        markCustom();
      });
      $("[data-clearmonths]").addEventListener("click", () => {
        monthsBox.innerHTML = "";
        markCustom();
        ui.notifications.info("Список месяцев очищен — добавьте свои месяцы и нажмите «Сохранить»");
      });
      field("maxDarkness").addEventListener("input", e => { $("[data-darklabel]").textContent = `${Math.round(e.target.value * 100)}%`; });

      root.querySelectorAll("[data-save]").forEach(b => b.addEventListener("click", async () => {
        try {
          await this.#save(root);
          ui.notifications.info("Календарь: сохранено");
          if (b.dataset.save === "close") this.close();
          else this.render();
        } catch (err) {
          console.error(err);
          ui.notifications.error(`Не удалось сохранить: ${err.message}`);
        }
      }));
    }

    async #save(root) {
      const v = name => root.querySelector(`[name="${name}"]`);
      const val = name => v(name)?.value;
      const chk = name => !!v(name)?.checked;

      // календарь
      const months = [...root.querySelectorAll(".rtc-month")].map(row => {
        const q = k => row.querySelector(`[data-m="${k}"]`)?.value;
        const name = String(q("name") ?? "").trim();
        return { name, days: Math.max(1, Math.round(num(q("days"), 30))), season: SEASONS[q("season")] ? q("season") : "summer" };
      }).filter(m => m.name);
      if (!months.length) throw new Error("нужен хотя бы один месяц");
      const weekdays = String(val("weekdays")).split(/[,\n]/).map(s => s.trim()).filter(Boolean);
      const old = getCal();
      const cal = normalizeCal({
        ...old,
        preset: val("preset"),
        months, weekdays: weekdays.length ? weekdays : ["День"],
        hoursPerDay: num(val("hoursPerDay"), 24), minutesPerHour: num(val("minutesPerHour"), 60),
        startYear: Math.round(num(val("startYear"), 1)), era: String(val("era") ?? ""),
        weekdayOffset: Math.round(num(val("weekdayOffset"), 0)),
        sunrise: num(val("sunrise"), 6), sunset: num(val("sunset"), 20),
        moonCycle: num(val("moonCycle"), 30), moonOffset: num(val("moonOffset"), 0),
        syncDarkness: chk("syncDarkness"), maxDarkness: num(val("maxDarkness"), 0.85)
      });
      await setSetting(K.cal, cal);

      // время
      await setSetting(K.clock, {
        running: chk("running"),
        realAmount: Math.max(0.1, num(val("realAmount"), 1)), realUnit: val("realUnit"),
        gameAmount: Math.max(0.1, num(val("gameAmount"), 1)), gameUnit: val("gameUnit"),
        pauseWithGame: chk("pauseWithGame"), pauseInCombat: chk("pauseInCombat"),
        tickSeconds: clamp(Math.round(num(val("tickSeconds"), 5)), 1, 60)
      });

      // дата
      const monthIndex = clamp(Math.round(num(val("month"), 0)), 0, cal.months.length - 1);
      await setDateTime({
        year: Math.round(num(val("year"), cal.startYear)),
        monthIndex,
        day: clamp(Math.round(num(val("day"), 1)), 1, cal.months[monthIndex].days),
        hour: clamp(Math.round(num(val("hour"), 0)), 0, cal.hoursPerDay - 1),
        minute: clamp(Math.round(num(val("minute"), 0)), 0, cal.minutesPerHour - 1)
      });

      // погода
      const prev = getWeather();
      let high = num(val("high"), 18), low = num(val("low"), 8);
      if (low > high) [low, high] = [high, low];
      const w = {
        ...prev,
        type: WEATHER[val("wtype")] ? val("wtype") : "clear",
        wind: clamp(Math.round(num(val("wind"), 0)), 0, 3),
        high, low, unit: val("unit") === "F" ? "F" : "C",
        climate: CLIMATES[val("climate")] ? val("climate") : "temperate",
        auto: chk("auto"), announce: chk("announce"),
        day: decompose(game.time.worldTime, cal).totalDays
      };
      await setSetting(K.weather, w);
      // локация
      const locPrev = getLocation();
      await setSetting(K.location, { ...locPrev, announce: chk("locAnnounce"), autoScene: chk("locAutoScene") });
      await setLocation(val("locName"), val("locRegion"));

      const changed = ["type", "wind", "high", "low"].some(k => prev[k] !== w[k]);
      if (changed && w.announce) announceWeather(w);
      syncDarkness();
    }

    async close(options) {
      configApp = null;
      return super.close(options);
    }
  };
  return ConfigClass;
}

/* ------------------------------------------------------------------ */
/*  Регистрация                                                        */
/* ------------------------------------------------------------------ */

function registerSettings() {
  const refresh = () => widget.render();

  // Включение/выключение теперь делает центр управления RPG-Tools; настройка оставлена для совместимости
  game.settings.register(MODULE_ID, K.enabled, {
    scope: "world", config: false, type: Boolean, default: true
  });
  game.settings.register(MODULE_ID, K.players, {
    name: "Календарь · Показывать игрокам",
    hint: "Если выключено, виджет видит только ГМ.",
    scope: "world", config: true, type: Boolean, default: true, requiresReload: true
  });
  game.settings.register(MODULE_ID, K.cal, { scope: "world", config: false, type: Object, default: DEFAULT_CAL, onChange: () => { widget.iconKey = null; refresh(); } });
  game.settings.register(MODULE_ID, K.clock, { scope: "world", config: false, type: Object, default: DEFAULT_CLOCK, onChange: refresh });
  game.settings.register(MODULE_ID, K.weather, { scope: "world", config: false, type: Object, default: DEFAULT_WEATHER, onChange: refresh });
  game.settings.register(MODULE_ID, K.pos, { scope: "client", config: false, type: Object, default: {} });
  game.settings.register(MODULE_ID, K.collapsed, { scope: "client", config: false, type: Boolean, default: false });
  game.settings.register(MODULE_ID, K.location, { scope: "world", config: false, type: Object, default: DEFAULT_LOCATION, onChange: () => widget.renderLocation() });

  game.settings.registerMenu(MODULE_ID, "cal-rtcMenu", {
    name: "Календарь · Настройки календаря и погоды",
    label: "Открыть настройки",
    hint: "Календарь, скорость времени, погода, восход/закат, луна.",
    icon: "fa-solid fa-cloud-sun",
    type: getConfigClass(),
    restricted: true
  });
}


Hooks.once("init", () => {
  registerSettings();
});

Hooks.once("ready", () => {
  if (game.user.isGM || game.settings.get(MODULE_ID, K.players)) widget.mount();
  ticker.start();
  if (isActiveGM()) onTimeChanged();

  Hooks.on("updateWorldTime", onTimeChanged);
  Hooks.on("pauseGame", () => widget.render());
  Hooks.on("combatStart", () => widget.render());
  Hooks.on("updateCombat", () => widget.render());
  Hooks.on("deleteCombat", () => widget.render());
  Hooks.on("canvasReady", () => { if (isActiveGM()) syncDarkness(); });
  Hooks.on("updateScene", (scene, changes) => {
    if (!changes.active || !isActiveGM() || !getLocation().autoScene) return;
    setLocation(scene.navName || scene.name, getLocation().region);
  });

  Object.assign(api, {
    open: openConfig,
    advance: advanceBy,
    setDateTime,
    now: () => decompose(game.time.worldTime),
    weather: getWeather,
    setWeather: async patch => { const w = { ...getWeather(), ...patch }; await setSetting(K.weather, w); if (w.announce) announceWeather(w); },
    randomWeather: async () => {
      const w = getWeather(), d = decompose(game.time.worldTime);
      const next = { ...w, ...generateWeather(w, w.climate, d.month.season), day: d.totalDays };
      await setSetting(K.weather, next);
      if (next.announce) announceWeather(next);
    },
    start: () => setSetting(K.clock, { ...getClock(), running: true }),
    stop: () => setSetting(K.clock, { ...getClock(), running: false }),
    show: () => widget.mount(),
    hide: () => widget.unmount(),
    location: getLocation,
    setLocation
  });
  globalThis.RPGCalendar = api;
});
