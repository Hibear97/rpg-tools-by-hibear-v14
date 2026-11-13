/**
 * Валюты.
 *  - standard: обычные монеты D&D 5e (пм, зм, эм, см, мм);
 *  - gold:     «только золото» — все цены и кошельки показываются в золотых. Цены предметов НЕ переписываются
 *              в базе: пересчёт делается только в памяти при подготовке предмета, поэтому при выключении режима
 *              (после перезагрузки) всё возвращается как было;
 *  - custom:   свои валюты мастера (хранятся во флагах персонажа), можно вместе со стандартными.
 *
 * Внутри все суммы считаются в медных монетах (1 зм = 100 мм).
 */
import { MODULE_ID, setting, esc } from "./core.js";

export const STANDARD = [
  { key: "pp", name: "Платиновые", abbr: "пм", cp: 1000, store: "system", color: "#d8e4ec" },
  { key: "gp", name: "Золотые",    abbr: "зм", cp: 100,  store: "system", color: "#f0c040" },
  { key: "ep", name: "Электрумовые", abbr: "эм", cp: 50, store: "system", color: "#b9d4a0" },
  { key: "sp", name: "Серебряные", abbr: "см", cp: 10,   store: "system", color: "#c8c8c8" },
  { key: "cp", name: "Медные",     abbr: "мм", cp: 1,    store: "system", color: "#c87a3c" }
];
const STD = Object.fromEntries(STANDARD.map((d) => [d.key, d]));

export const mode = () => setting("currencyMode");
export const goldOnly = () => mode() === "gold";

function customDenoms() {
  const list = setting("customCurrencies") ?? [];
  return list
    .filter((c) => c?.key && Number(c.rate) > 0)
    .map((c) => ({
      key: String(c.key), name: c.name || c.key, abbr: c.abbr || c.key,
      cp: Math.max(1, Math.round(Number(c.rate) * 100)), store: "flag", img: c.img || "", color: c.color || "#f0c040"
    }));
}

/** Монеты, которые реально лежат у персонажей в текущем режиме (по убыванию номинала). */
export function storageDenoms() {
  const list = mode() === "custom"
    ? [...(setting("customKeepStandard") ? STANDARD : []), ...customDenoms()]
    : [...STANDARD];
  return list.sort((a, b) => b.cp - a.cp);
}

/** Монеты, которыми выдаётся сдача и доход. */
function receiveDenoms() {
  if (mode() === "custom") return storageDenoms();
  return [STD.gp, STD.sp, STD.cp];
}

export function getAmount(actor, d) {
  if (d.store === "system") return Number(actor?.system?.currency?.[d.key]) || 0;
  return Number(actor?.getFlag?.(MODULE_ID, `pt.currency.${d.key}`)) || 0;
}

export function walletAmounts(actor) {
  return Object.fromEntries(storageDenoms().map((d) => [d.key, getAmount(actor, d)]));
}

/** Всё состояние персонажа в медяках. */
export function walletCp(actor) {
  return storageDenoms().reduce((s, d) => s + getAmount(actor, d) * d.cp, 0);
}

function buildUpdate(amounts) {
  const upd = {};
  for (const d of storageDenoms()) {
    if (!(d.key in amounts)) continue;
    const v = Math.max(0, Math.floor(amounts[d.key]));
    if (d.store === "system") upd[`system.currency.${d.key}`] = v;
    else upd[`flags.${MODULE_ID}.pt.currency.${d.key}`] = v;
  }
  return upd;
}

function distribute(amounts, value) {
  for (const d of receiveDenoms()) {
    if (value <= 0) break;
    const n = Math.floor(value / d.cp);
    if (n > 0) { amounts[d.key] = (amounts[d.key] ?? 0) + n; value -= n * d.cp; }
  }
  return value; // остаток, который не выразить монетами (только для своих валют без мелочи)
}

/** Списать сумму (с выдачей сдачи). Бросает ошибку, если не хватает. */
export async function pay(actor, cost) {
  cost = Math.max(0, Math.round(cost));
  if (!cost) return;
  if (walletCp(actor) < cost) throw new Error(`У «${actor.name}» не хватает денег (нужно ${formatCp(cost)}).`);
  const amounts = walletAmounts(actor);
  const asc = [...storageDenoms()].sort((a, b) => a.cp - b.cp);
  let remaining = cost;
  for (const d of asc) {
    if (remaining <= 0) break;
    const take = Math.min(amounts[d.key], Math.ceil(remaining / d.cp));
    amounts[d.key] -= take;
    remaining -= take * d.cp;
  }
  if (remaining < 0) distribute(amounts, -remaining);
  await actor.update(buildUpdate(amounts));
}

/** Начислить сумму. */
export async function receive(actor, value) {
  value = Math.max(0, Math.round(value));
  if (!value) return;
  const amounts = walletAmounts(actor);
  distribute(amounts, value);
  await actor.update(buildUpdate(amounts));
}

/** Передать конкретные монеты { key: кол-во } (без размена). */
export async function moveCoins(from, to, coins) {
  const denoms = storageDenoms();
  const a = walletAmounts(from), b = walletAmounts(to);
  for (const d of denoms) {
    const n = Math.max(0, Math.floor(Number(coins?.[d.key]) || 0));
    if (!n) continue;
    if (a[d.key] < n) throw new Error(`У «${from.name}» нет ${n} ${d.abbr}.`);
    a[d.key] -= n; b[d.key] += n;
  }
  await from.update(buildUpdate(a));
  await to.update(buildUpdate(b));
}

/** Стоимость набора монет в медяках. */
export function coinsCp(coins) {
  return storageDenoms().reduce((s, d) => s + (Math.max(0, Number(coins?.[d.key]) || 0)) * d.cp, 0);
}

/* -------------------------------------------- */
/*  Цены предметов                              */
/* -------------------------------------------- */

/** Цена за 1 штуку в медяках (по данным предмета, без наценок). */
export function itemPriceCp(itemOrData) {
  const p = itemOrData?.system?.price;
  let value = 0, denom = "gp";
  if (typeof p === "number") value = p;
  else if (p && typeof p === "object") { value = Number(p.value) || 0; denom = p.denomination || "gp"; }
  return Math.round(value * (STD[denom]?.cp ?? 100));
}

/* -------------------------------------------- */
/*  Отображение                                 */
/* -------------------------------------------- */

const num = (n) => Number(n.toFixed(2)).toLocaleString("ru-RU", { maximumFractionDigits: 2 });

/** Сумма в медяках → текст в текущем режиме. */
export function formatCp(cp) {
  cp = Math.max(0, Math.round(cp));
  if (goldOnly()) return `${num(cp / 100)} зм`;
  const denoms = mode() === "custom" ? storageDenoms() : [STD.gp, STD.sp, STD.cp];
  if (!denoms.length) return `${num(cp / 100)} зм`;
  const parts = [];
  let rest = cp;
  for (const d of denoms) {
    const n = Math.floor(rest / d.cp);
    if (n > 0) { parts.push(`${n.toLocaleString("ru-RU")} ${d.abbr}`); rest -= n * d.cp; }
  }
  if (!parts.length) return `0 ${denoms[0].abbr}`;
  return parts.join(" ");
}

export function priceHTML(cp) {
  return `<span class="rpp-price"><i class="fa-solid fa-coins"></i> ${esc(formatCp(cp))}</span>`;
}

/** Кошелёк персонажа одной строкой. */
export function walletHTML(actor) {
  if (!actor) return "";
  if (goldOnly()) return `<span class="rpp-coin" style="--coin:#f0c040"><i class="fa-solid fa-coins"></i> ${esc(formatCp(walletCp(actor)))}</span>`;
  return storageDenoms().map((d) => {
    const n = getAmount(actor, d);
    const icon = d.img ? `<img src="${esc(d.img)}" alt="">` : `<i class="fa-solid fa-coins"></i>`;
    return `<span class="rpp-coin" style="--coin:${d.color}" data-tooltip="${esc(d.name)}">${icon} ${n} ${esc(d.abbr)}</span>`;
  }).join("");
}

/** Поля ввода монет (для обмена и контейнеров). values — {key: n} или {__cp: n} в режиме золота. */
export function coinInputsHTML(values = {}, { disabled = false } = {}) {
  const dis = disabled ? "disabled" : "";
  if (goldOnly()) {
    const v = values.__cp ? Number((values.__cp / 100).toFixed(2)) : 0;
    return `<label class="rpp-coin-input" style="--coin:#f0c040"><i class="fa-solid fa-coins"></i>
      <input type="number" min="0" step="0.01" name="__gold" value="${v}" ${dis}> зм</label>`;
  }
  return storageDenoms().map((d) => `
    <label class="rpp-coin-input" style="--coin:${d.color}" data-tooltip="${esc(d.name)}">
      ${d.img ? `<img src="${esc(d.img)}" alt="">` : `<i class="fa-solid fa-coins"></i>`}
      <input type="number" min="0" step="1" name="coin-${esc(d.key)}" value="${Number(values[d.key]) || 0}" ${dis}> ${esc(d.abbr)}
    </label>`).join("");
}

/** Прочитать поля ввода монет из элемента. */
export function readCoinInputs(root) {
  if (goldOnly()) {
    const v = Number(root.querySelector("input[name=__gold]")?.value) || 0;
    return { __cp: Math.max(0, Math.round(v * 100)) };
  }
  const out = {};
  for (const d of storageDenoms()) {
    const v = Number(root.querySelector(`input[name="coin-${d.key}"]`)?.value) || 0;
    if (v > 0) out[d.key] = Math.floor(v);
  }
  return out;
}

/** Есть ли в наборе хоть что-то. */
export const coinsEmpty = (coins) => !coins || Object.values(coins).every((v) => !Number(v));

/** Передать «набор монет» (поддерживает {__cp} режима золота). */
export async function transferCoins(from, to, coins) {
  if (coinsEmpty(coins)) return;
  if (coins.__cp != null) { await pay(from, coins.__cp); await receive(to, coins.__cp); }
  else await moveCoins(from, to, coins);
}

/** Набор монет → текст. */
export function coinsText(coins) {
  if (coinsEmpty(coins)) return "";
  if (coins.__cp != null) return formatCp(coins.__cp);
  return storageDenoms().filter((d) => Number(coins[d.key]) > 0).map((d) => `${coins[d.key]} ${d.abbr}`).join(" ");
}

/* -------------------------------------------- */
/*  Режим «только золото»: пересчёт цен в памяти */
/* -------------------------------------------- */

let patched = false;
export function patchGoldPrices() {
  if (patched || !goldOnly()) return;
  const Cls = CONFIG.Item.documentClass;
  const orig = Cls.prototype.prepareDerivedData;
  Cls.prototype.prepareDerivedData = function (...args) {
    const r = orig.apply(this, args);
    try {
      const p = this.system?.price;
      if (p && typeof p === "object" && p.denomination && p.denomination !== "gp" && STD[p.denomination]) {
        p.value = Number(((Number(p.value) || 0) * STD[p.denomination].cp / 100).toFixed(2));
        p.denomination = "gp";
      }
    } catch (e) { /* не мешаем системе */ }
    return r;
  };
  patched = true;
}
