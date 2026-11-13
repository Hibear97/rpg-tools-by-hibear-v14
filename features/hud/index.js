/**
 * BG3 Style HUD — Foundry VTT v13, система dnd5e.
 * Нижняя панель в стиле Baldur's Gate 3 + микроменю в стиле World of Warcraft.
 */

import { registerVoiceSettings, initVoiceBridge, afterRender, applyDock } from "./voice-bridge.js";
import { SUITE_ID } from "../../core/constants.js";

/** Функция «BG3-интерфейс» внутри общего модуля RPG Suite.
 *  Настройки: "rpg-tools-by-hibear.hud-*", флаги: <doc>.flags["rpg-tools-by-hibear"].hud.* */
const MOD = SUITE_ID;
const SKEY = (k) => `hud-${k}`;
const ROMAN = ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX"];
const GRID_SLOTS = 24; // 2 ряда по 12
const CUSTOM_SLOTS = 36; // свободная панель: 3 ряда по 12 (прокрутка)

/* Известные классовые ресурсы: идентификатор dnd5e (system.identifier) или имя предмета (EN/RU). */
const RESOURCE_DEFS = [
  { key: "rage", ids: ["rage"], re: /^(rage|ярость)$/i, color: "#d9412e", icon: "fa-solid fa-fire" },
  { key: "wildShape", ids: ["wild-shape"], re: /(wild\s*shape|дикий\s*облик|дикая\s*форма|смена\s*формы|звериный\s*облик)/i, color: "#3fae5a", icon: "fa-solid fa-paw" },
  { key: "ki", ids: ["ki", "ki-points", "focus", "focus-points", "monks-focus"], re: /(^ki$|ki\s*points|focus\s*points|очки\s*ци|^ци$|очки\s*концентрации|фокус)/i, color: "#3b8fd9", icon: "fa-solid fa-yin-yang" },
  { key: "bardic", ids: ["bardic-inspiration"], re: /(bardic\s*inspiration|вдохновение\s*барда|бардовское\s*вдохновение)/i, color: "#a05ad6", icon: "fa-solid fa-music" },
  { key: "channel", ids: ["channel-divinity"], re: /(channel\s*divinity|божественный\s*канал|проведение\s*божественности)/i, color: "#f0c43a", icon: "fa-solid fa-sun" },
  { key: "sorcery", ids: ["sorcery-points", "font-of-magic"], re: /(sorcery\s*points|font\s*of\s*magic|очки\s*чародейства|источник\s*магии)/i, color: "#e2589b", icon: "fa-solid fa-wand-sparkles" },
  { key: "actionSurge", ids: ["action-surge"], re: /(action\s*surge|всплеск\s*действий)/i, color: "#e6862b", icon: "fa-solid fa-bolt" },
  { key: "secondWind", ids: ["second-wind"], re: /(second\s*wind|второе\s*дыхание)/i, color: "#22a88f", icon: "fa-solid fa-wind" },
  { key: "layOnHands", ids: ["lay-on-hands"], re: /(lay\s*on\s*hands|наложение\s*рук|возложение\s*рук)/i, color: "#f2a33a", icon: "fa-solid fa-hand-holding-heart" },
  { key: "superiority", ids: ["superiority-dice", "combat-superiority"], re: /(superiority\s*dice|кости\s*превосходства)/i, color: "#d0662c", icon: "fa-solid fa-dice-d6" },
  { key: "arcaneRecovery", ids: ["arcane-recovery"], re: /(arcane\s*recovery|магическое\s*восстановление|арканное\s*восстановление)/i, color: "#5b7fe0", icon: "fa-solid fa-book-sparkles" }
];

/* Запасной список вкладок сайдбара, если не удалось прочитать их из DOM. */
const FALLBACK_TABS = [
  ["chat", "fa-solid fa-comments", "SIDEBAR.TabChat"],
  ["combat", "fa-solid fa-swords", "SIDEBAR.TabCombat"],
  ["scenes", "fa-solid fa-map", "SIDEBAR.TabScenes"],
  ["actors", "fa-solid fa-users", "SIDEBAR.TabActors"],
  ["items", "fa-solid fa-suitcase", "SIDEBAR.TabItems"],
  ["journal", "fa-solid fa-book-open", "SIDEBAR.TabJournal"],
  ["tables", "fa-solid fa-table-list", "SIDEBAR.TabTables"],
  ["cards", "fa-solid fa-cards", "SIDEBAR.TabCards"],
  ["macros", "fa-solid fa-code", "SIDEBAR.TabMacros"],
  ["playlists", "fa-solid fa-music", "SIDEBAR.TabPlaylists"],
  ["compendium", "fa-solid fa-book-atlas", "SIDEBAR.TabCompendium"],
  ["settings", "fa-solid fa-gears", "SIDEBAR.TabSettings"]
];

const state = {
  tab: null,          // выбранная вкладка скиллбара
  unread: 0,          // непрочитанные сообщения чата
  hidden: false,      // скрыто хоткеем
  root: null,
  micro: null,
  observer: null
};

/* ------------------------------------------------------------------ */
/*  Утилиты                                                            */
/* ------------------------------------------------------------------ */

const L = (k) => game.i18n.localize(`BG3HUD.${k}`);
const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function setting(key) {
  try { return game.settings.get(MOD, SKEY(key)); } catch { return undefined; }
}

function getActor() {
  const token = canvas?.tokens?.controlled?.[0];
  if (token?.actor?.isOwner) return token.actor;
  return game.user?.character ?? null;
}

function sameActor(a, b) {
  if (!a || !b) return false;
  return a === b || (a.uuid && a.uuid === b.uuid);
}

function isRelevant(doc) {
  const actor = getActor();
  if (!actor || !doc) return false;
  return sameActor(doc, actor) || sameActor(doc.parent, actor) || sameActor(doc.actor, actor);
}

function firstActivity(item) {
  const acts = item?.system?.activities;
  if (!acts || !acts.size) return null;
  return acts.contents?.[0] ?? acts.values?.().next().value ?? null;
}

function activationType(item) {
  const act = firstActivity(item);
  if (act) return act.activation?.type || "";
  return item?.system?.activation?.type || "";
}

function activationLabel(type) {
  if (!type) return "";
  const cfg = CONFIG.DND5E?.activityActivationTypes?.[type] ?? CONFIG.DND5E?.abilityActivationTypes?.[type];
  if (!cfg) return type;
  return game.i18n.localize(typeof cfg === "string" ? cfg : (cfg.label ?? type));
}

function getUses(item) {
  const u = item?.system?.uses;
  if (!u) return null;
  const max = Number(u.max) || 0;
  if (max <= 0) return null;
  const value = u.value !== undefined && u.value !== null ? Number(u.value) : max - (Number(u.spent) || 0);
  return { value: clamp(value, 0, max), max };
}

async function setUses(item, value) {
  const u = getUses(item);
  if (!u) return;
  value = clamp(value, 0, u.max);
  const src = item._source?.system?.uses ?? {};
  if ("spent" in src) return item.update({ "system.uses.spent": u.max - value });
  return item.update({ "system.uses.value": value });
}

function spellMethod(item) {
  return item.system?.method ?? item.system?.preparation?.mode ?? "";
}

function isPrepared(item) {
  const s = item.system ?? {};
  if ((s.level ?? 0) === 0) return true;
  const m = spellMethod(item);
  if (["always", "innate", "atwill", "pact"].includes(m)) return true;
  if (typeof s.prepared === "number") return s.prepared > 0;
  if (typeof s.prepared === "boolean") return s.prepared;
  if (s.preparation && "prepared" in s.preparation) return !!s.preparation.prepared;
  return true;
}

function spellCastable(actor, item) {
  const lvl = item.system?.level ?? 0;
  if (lvl === 0) return true;
  const m = spellMethod(item);
  if (["innate", "atwill", "ritual"].includes(m)) {
    const u = getUses(item);
    return !u || u.value > 0;
  }
  const sp = actor.system?.spells ?? {};
  for (let l = lvl; l <= 9; l++) if ((Number(sp[`spell${l}`]?.value) || 0) > 0) return true;
  if ((Number(sp.pact?.value) || 0) > 0 && (Number(sp.pact?.level) || 0) >= lvl) return true;
  return false;
}

function categorize(item) {
  const act = activationType(item);
  switch (item.type) {
    case "weapon": return item.system?.equipped === false ? null : "attack";
    case "spell": return "spell";
    case "feat": return act && act !== "none" ? "feature" : null;
    case "consumable": return (Number(item.system?.quantity ?? 1) > 0) ? "item" : null;
    case "equipment":
    case "tool":
    case "loot": return act && act !== "none" ? "item" : null;
    default: return null;
  }
}

/* ------------------------------------------------------------------ */
/*  Экономия действий (действие / бонус / реакция / шаги)             */
/*  Хранится во флаге combatant, сбрасывается в начале его хода.       */
/* ------------------------------------------------------------------ */

function combatantFor(actor, combat = game.combat) {
  if (!actor || !combat) return null;
  const tokenId = actor.isToken ? actor.token?.id : null;
  return combat.combatants.find((c) => (tokenId ? c.tokenId === tokenId : c.actorId === actor.id)) ?? null;
}

function getEcon(actor) {
  const combat = game.combat;
  if (!combat?.started) return null;
  const cb = combatantFor(actor, combat);
  if (!cb) return null;
  const isTurn = combat.combatant?.id === cb.id;
  const key = `${combat.round}-${combat.turn}`;
  const f = cb.getFlag?.(MOD, "hud.econ") ?? {};
  const fresh = isTurn && f.key !== key;
  const base = fresh ? {} : f;
  return {
    cb, isTurn, key: isTurn ? key : (f.key ?? null),
    action: !!base.action, bonus: !!base.bonus, reaction: !!base.reaction,
    moved: Number(base.moved) || 0, dash: !!base.dash
  };
}

async function patchEcon(actor, patch) {
  const st = getEcon(actor);
  if (!st || !st.cb.isOwner) return;
  const data = { key: st.key, action: st.action, bonus: st.bonus, reaction: st.reaction, moved: st.moved, dash: st.dash };
  const next = typeof patch === "function" ? patch(data) : { ...data, ...patch };
  return st.cb.setFlag(MOD, "hud.econ", next);
}

function markActivation(actor, type, name = "") {
  if (!actor || !type) return;
  const map = { action: "action", bonus: "bonus", reaction: "reaction" };
  const key = map[type];
  if (!key) return;
  const st = getEcon(actor);
  if (!st) return;
  if (key !== "reaction" && !st.isTurn) return;
  const isDash = /(^dash$|рывок)/i.test(name);
  patchEcon(actor, (d) => ({ ...d, [key]: true, dash: d.dash || isDash }));
}

/* ------------------------------------------------------------------ */
/*  Построение HTML                                                     */
/* ------------------------------------------------------------------ */

function buildEffects(actor) {
  const effects = (actor.appliedEffects ?? actor.effects?.contents ?? [])
    .filter((e) => e.img && !e.disabled && !e.isSuppressed)
    .slice(0, 14);
  if (!effects.length) return "";
  return `<div class="bg3-effects">${effects.map((e) =>
    `<img src="${esc(e.img)}" data-tooltip="${esc(e.name)}" data-tooltip-direction="UP">`).join("")}</div>`;
}

function buildEcon(actor, st) {
  const idle = st ? "" : "idle";
  const pip = (key, shape, label) =>
    `<div class="bg3-econ-pip ${shape} ${st?.[key] ? "used" : ""} ${idle}" data-action="econ" data-key="${key}"
      data-tooltip="${esc(label)}${st ? " — " + esc(L("EconHint")) : ""}" data-tooltip-direction="UP"></div>`;
  return `<div class="bg3-econ">
    ${pip("action", "circle", L("Action"))}
    ${pip("bonus", "triangle", L("Bonus"))}
    ${pip("reaction", "diamond", L("Reaction"))}
  </div>`;
}

function buildMovement(actor, st) {
  const mv = actor.system?.attributes?.movement ?? {};
  const speed = Number(mv.walk) || 0;
  if (!speed) return "";
  const units = mv.units || canvas?.scene?.grid?.units || "ft";
  const step = Number(canvas?.scene?.grid?.distance) || 5;
  const total = speed * (st?.dash ? 2 : 1);
  const moved = st?.moved ?? 0;
  const left = Math.max(total - moved, 0);
  const count = clamp(Math.round(total / step), 1, 24);
  const filled = clamp(Math.floor(left / step + 1e-6), 0, count);
  const pips = Array.from({ length: count }, (_, i) => `<span class="mv-pip ${i < filled ? "on" : ""}"></span>`).join("");
  const fmt = (n) => Math.round(n * 10) / 10;
  return `<div class="bg3-move ${st?.dash ? "dash" : ""} ${st ? "" : "idle"}" data-action="move"
      data-tooltip="${esc(L("Movement"))}${st ? " — " + esc(L("MoveHint")) : ""}" data-tooltip-direction="UP">
    <i class="fa-solid fa-shoe-prints"></i>
    <div class="mv-pips">${pips}</div>
    <span class="mv-label">${fmt(left)}/${fmt(total)} ${esc(units)}${st?.dash ? ` <b>${esc(L("Dash"))}</b>` : ""}</span>
  </div>`;
}

function buildSlots(actor) {
  const sp = actor.system?.spells ?? {};
  const groups = [];
  for (let l = 1; l <= 9; l++) {
    const s = sp[`spell${l}`];
    const max = Number(s?.max) || 0;
    if (max > 0) groups.push({ path: `spell${l}`, label: ROMAN[l], value: Number(s.value) || 0, max, cls: "" });
  }
  const pact = sp.pact;
  if ((Number(pact?.max) || 0) > 0) {
    groups.push({ path: "pact", label: `${L("Pact")} ${ROMAN[Number(pact.level) || 0] ?? ""}`, value: Number(pact.value) || 0, max: Number(pact.max), cls: "pact" });
  }
  if (!groups.length) return ""; // у варвара, воина и т.п. ячеек нет — блок не показываем
  return `<div class="bg3-slots" data-tooltip="${esc(L("SpellSlots"))} — ${esc(L("PipHint"))}" data-tooltip-direction="UP">
    ${groups.map((g) => `<div class="slot-group ${g.cls}">
      <span class="slot-label">${esc(g.label)}</span>
      <div class="slot-pips">${Array.from({ length: Math.min(g.max, 10) }, (_, i) =>
        `<span class="slot-pip ${i < g.value ? "on" : ""}" data-action="slot-pip" data-path="${g.path}" data-index="${i}"></span>`).join("")}</div>
    </div>`).join("")}
  </div>`;
}

function getClassResources(actor) {
  const out = [];
  const showAll = setting("showAllResources");
  for (const item of actor.items) {
    if (item.type !== "feat") continue;
    const u = getUses(item);
    if (!u) continue;
    const ident = item.system?.identifier || item.name?.slugify?.() || "";
    const def = RESOURCE_DEFS.find((d) => d.ids.includes(ident) || d.re.test(item.name ?? ""));
    if (!def && !showAll) continue;
    out.push({ kind: "item", id: item.id, name: item.name, img: item.img, value: u.value, max: u.max, color: def?.color ?? "#c9a35b" });
  }
  // Старые ресурсы листа (primary/secondary/tertiary)
  for (const key of ["primary", "secondary", "tertiary"]) {
    const r = actor.system?.resources?.[key];
    const max = Number(r?.max) || 0;
    if (!r || max <= 0 || !r.label) continue;
    if (out.some((o) => o.name?.toLowerCase() === r.label.toLowerCase())) continue;
    const def = RESOURCE_DEFS.find((d) => d.re.test(r.label));
    out.push({ kind: "legacy", id: key, name: r.label, img: null, icon: def?.icon ?? "fa-solid fa-star", value: Number(r.value) || 0, max, color: def?.color ?? "#c9a35b" });
  }
  return out;
}

function buildResources(actor) {
  const res = getClassResources(actor);
  if (!res.length) return "";
  return `<div class="bg3-classres">${res.map((r) => {
    const icon = r.img ? `<img src="${esc(r.img)}">` : `<i class="${r.icon}"></i>`;
    const body = r.max <= 10
      ? `<div class="res-pips">${Array.from({ length: r.max }, (_, i) =>
          `<span class="res-pip ${i < r.value ? "on" : ""}" data-action="res-pip" data-kind="${r.kind}" data-id="${r.id}" data-index="${i}"></span>`).join("")}</div>`
      : `<span class="res-num">${r.value}/${r.max}</span>`;
    return `<div class="res" style="--res-color:${r.color}">
      <div class="res-icon" data-action="res-use" data-kind="${r.kind}" data-id="${r.id}"
        data-tooltip="${esc(r.name)} ${r.value}/${r.max}${r.kind === "item" ? " — " + esc(L("ResHint")) : ""}" data-tooltip-direction="UP">${icon}</div>
      ${body}
    </div>`;
  }).join("")}</div>`;
}

function buildPortrait(actor, st) {
  const sys = actor.system ?? {};
  const hp = sys.attributes?.hp ?? {};
  const max = (Number(hp.max) || 0) + (Number(hp.tempmax) || 0);
  const val = Number(hp.value) || 0;
  const temp = Number(hp.temp) || 0;
  const pct = max ? clamp((val / max) * 100, 0, 100) : 0;
  const tpct = max ? clamp((temp / max) * 100, 0, 100 - pct) : 0;
  const ac = sys.attributes?.ac?.value ?? "—";
  const classes = Object.values(actor.classes ?? {}).map((c) => `${c.name} ${c.system?.levels ?? ""}`.trim()).join(" / ");
  const sub = classes || (sys.details?.cr !== undefined ? `CR ${sys.details.cr}` : "");
  const death = sys.attributes?.death;
  const showDeath = actor.type === "character" && val <= 0 && death;
  const deathHtml = showDeath ? `<div class="bg3-death" data-action="death" data-tooltip="${esc(L("DeathSave"))}">
      <span class="ok">${"●".repeat(death.success || 0)}${"○".repeat(3 - (death.success || 0))}</span>
      <i class="fa-solid fa-skull"></i>
      <span class="fail">${"●".repeat(death.failure || 0)}${"○".repeat(3 - (death.failure || 0))}</span>
    </div>` : "";
  const img = actor.img || "icons/svg/mystery-man.svg";
  return `<div class="bg3-portrait-wrap ${st?.isTurn ? "my-turn" : ""}">
    ${sys.attributes?.inspiration ? `<div class="bg3-inspiration" data-tooltip="${esc(L("Inspiration"))}"><i class="fa-solid fa-star"></i></div>` : ""}
    <div class="bg3-portrait" data-action="sheet" data-tooltip="${esc(actor.name)}${sub ? " — " + esc(sub) : ""}">
      <img src="${esc(img)}">
      ${st?.isTurn ? `<div class="turn-banner">${esc(L("YourTurn"))}</div>` : ""}
    </div>
    <div class="bg3-ac" data-tooltip="${esc(L("ArmorClass"))}"><i class="fa-solid fa-shield"></i><span>${esc(ac)}</span></div>
    <div class="bg3-rest">
      <button type="button" data-action="short-rest" data-tooltip="${esc(L("ShortRest"))}"><i class="fa-solid fa-mug-hot"></i></button>
      <button type="button" data-action="long-rest" data-tooltip="${esc(L("LongRest"))}"><i class="fa-solid fa-campground"></i></button>
    </div>
    ${deathHtml}
    <div class="bg3-name">${esc(actor.name)}</div>
    <div class="bg3-hp" data-tooltip="${esc(L("HP"))}">
      <div class="hp-fill" style="width:${pct}%"></div>
      <div class="hp-temp" style="left:${pct}%;width:${tpct}%"></div>
      <span>${val}${temp ? ` (+${temp})` : ""} / ${max}</span>
    </div>
  </div>`;
}

function slotHtml(actor, item, index = null, extra = null) {
  const act = activationType(item);
  const u = getUses(item);
  let disabled = false;
  const badges = [];
  const tt = [item.name];
  if (item.type === "spell") {
    const l = item.system?.level ?? 0;
    disabled = !spellCastable(actor, item);
    if (l) badges.push(`<span class="b-lvl">${ROMAN[l]}</span>`);
    tt.push(l ? `${L("SpellLevel")} ${l}` : L("Cantrip"));
  }
  if (u) {
    if (u.value <= 0) disabled = true;
    badges.push(`<span class="b-cnt">${u.value}</span>`);
    tt.push(`${L("Uses")}: ${u.value}/${u.max}`);
  } else if (item.type === "consumable") {
    const q = Number(item.system?.quantity ?? 1);
    if (q <= 0) disabled = true;
    if (q > 1 || q === 0) badges.push(`<span class="b-cnt">${q}</span>`);
    tt.push(`${L("Quantity")}: ${q}`);
  }
  if (act) tt.splice(1, 0, activationLabel(act));
  const tooltip = tt.filter(Boolean).join(" · ");
  if (extra) {
    return `<div class="bg3-slot act-${esc(act || "none")} ${disabled ? "disabled" : ""}" ${extra}
      data-item-id="${item.id}" data-tooltip="${esc(tooltip)}" data-tooltip-direction="UP">
    <img src="${esc(item.img)}">${badges.join("")}
  </div>`;
  }
  return `<div class="bg3-slot act-${esc(act || "none")} ${disabled ? "disabled" : ""}" draggable="true"
      data-action="use-item" data-item-id="${item.id}" ${index !== null ? `data-index="${index}"` : ""}
      data-tooltip="${esc(tooltip)}" data-tooltip-direction="UP">
    <img src="${esc(item.img)}">${badges.join("")}
  </div>`;
}

function collectItems(actor) {
  const buckets = { attack: [], spell: [], feature: [], item: [] };
  const onlyPrepared = setting("onlyPrepared");
  for (const item of actor.items) {
    const cat = categorize(item);
    if (!cat) continue;
    if (cat === "spell" && onlyPrepared && !isPrepared(item)) continue;
    buckets[cat].push(item);
  }
  const byName = (a, b) => (a.name ?? "").localeCompare(b.name ?? "");
  buckets.attack.sort(byName);
  buckets.spell.sort((a, b) => (a.system.level ?? 0) - (b.system.level ?? 0) || byName(a, b));
  buckets.feature.sort(byName);
  buckets.item.sort(byName);
  return buckets;
}

function favorites(actor) {
  const ids = actor.getFlag?.(MOD, "hud.favorites") ?? [];
  return ids.map((id) => actor.items.get(id)).filter(Boolean);
}

function buildBar(actor) {
  if (playerMode()) return buildPlayerBar(actor);
  const buckets = collectItems(actor);
  const favs = favorites(actor);
  const tabs = ["favorites", "custom", "all", "attack", "spell", "feature", "item"];
  if (!state.tab || !tabs.includes(state.tab)) state.tab = favs.length ? "favorites" : "all";
  if (state.tab === "custom") return buildCustomBar(actor, tabs);
  let list;
  switch (state.tab) {
    case "favorites": list = favs; break;
    case "all": list = [...buckets.attack, ...buckets.spell, ...buckets.feature, ...buckets.item]; break;
    default: list = buckets[state.tab] ?? [];
  }
  const tabHtml = buildTabs(tabs);

  const isFav = state.tab === "favorites";
  const cells = list.map((it, i) => slotHtml(actor, it, isFav ? i : null));
  const total = Math.max(GRID_SLOTS, Math.ceil(cells.length / 12) * 12);
  for (let i = cells.length; i < total; i++) cells.push(`<div class="bg3-slot empty" ${isFav ? `data-index="${i}"` : ""}></div>`);

  return `<div class="bg3-bar ${isFav ? "fav" : ""}">
    <div class="bg3-tabs">${tabHtml}</div>
    <div class="bg3-grid">${cells.join("")}</div>
  </div>`;
}

const TAB_ICONS = {
  favorites: "fa-solid fa-star", custom: "fa-solid fa-scroll", all: "fa-solid fa-border-all", attack: "fa-solid fa-sword",
  spell: "fa-solid fa-hat-wizard", feature: "fa-solid fa-hand-fist", item: "fa-solid fa-flask"
};
const TAB_HINTS = { favorites: "FavHint", custom: "CustomHint" };

function buildTabs(tabs) {
  const html = tabs.map((t) => `<button type="button" class="bg3-tab ${state.tab === t ? "active" : ""} ${t === "custom" ? "tab-custom" : ""}" data-action="tab" data-tab="${t}"
      data-tooltip="${esc(L(`Tabs.${t}`))}${TAB_HINTS[t] ? " — " + esc(L(TAB_HINTS[t])) : ""}" data-tooltip-direction="UP"><i class="${TAB_ICONS[t]}"></i></button>`).join("");
  const extra = state.tab === "custom"
    ? `<button type="button" class="bg3-tab bg3-tab-extra" data-action="custom-import" data-tooltip="${esc(L("Import"))}" data-tooltip-direction="UP"><i class="fa-solid fa-file-import"></i></button>`
    : "";
  return html + extra;
}

/* ------------------------------------------------------------------ */
/*  Свободная панель: макросы, оружие, предметы, умения, таблицы…       */
/*  Хранится у пользователя (как стандартный хотбар Foundry).           */
/* ------------------------------------------------------------------ */

function customBar() {
  const raw = game.user?.getFlag?.(MOD, "hud.customBar");
  const arr = Array.isArray(raw) ? raw.map((x) => x ?? null) : [];
  while (arr.length < CUSTOM_SLOTS) arr.push(null);
  return arr;
}

function saveCustomBar(arr) {
  while (arr.length > CUSTOM_SLOTS && arr[arr.length - 1] == null) arr.pop();
  return game.user.setFlag(MOD, "hud.customBar", arr.map((x) => x ?? null));
}

function resolveSync(uuid) {
  try { return fromUuidSync(uuid, { strict: false }) ?? null; } catch { return null; }
}

function docTypeName(doc) {
  return doc?.documentName ?? doc?.constructor?.documentName ?? doc?.metadata?.name ?? (doc?.activation ? "Activity" : "");
}

function customSlotHtml(actor, uuid, i) {
  if (!uuid) {
    return `<div class="bg3-slot empty custom" data-cindex="${i}" data-action="custom-empty"
      data-tooltip="${esc(L("CustomEmptyHint"))}" data-tooltip-direction="UP"></div>`;
  }
  const doc = resolveSync(uuid);
  if (!doc) {
    return `<div class="bg3-slot custom missing" draggable="true" data-cindex="${i}" data-uuid="${esc(uuid)}" data-action="custom-use"
      data-tooltip="${esc(L("Missing"))}" data-tooltip-direction="UP"><i class="fa-solid fa-question"></i></div>`;
  }
  const type = docTypeName(doc);
  const item = type === "Item" ? doc : (doc.item ?? null);
  const badges = [];
  const tt = [doc.name ?? item?.name ?? "?"];
  let act = "";
  let disabled = false;
  if (item?.system) {
    act = type === "Item" ? activationType(item) : (doc.activation?.type || "");
    const owned = !!item.parent;
    if (item.type === "spell") {
      const l = item.system.level ?? 0;
      if (l) badges.push(`<span class="b-lvl">${ROMAN[l]}</span>`);
      if (owned) disabled = !spellCastable(item.parent, item);
    }
    const u = owned ? getUses(item) : null;
    if (u) {
      if (u.value <= 0) disabled = true;
      badges.push(`<span class="b-cnt">${u.value}</span>`);
      tt.push(`${L("Uses")}: ${u.value}/${u.max}`);
    } else if (owned && item.type === "consumable") {
      const q = Number(item.system.quantity ?? 1);
      if (q <= 0) disabled = true;
      if (q !== 1) badges.push(`<span class="b-cnt">${q}</span>`);
    }
    if (act) tt.splice(1, 0, activationLabel(act));
    if (owned && actor && !sameActor(item.parent, actor)) tt.push(item.parent.name);
  }
  if (type === "Macro") badges.push(`<span class="b-macro"><i class="fa-solid fa-code"></i></span>`);
  const typeLabel = type ? game.i18n.localize(`DOCUMENT.${type}`) : "";
  if (typeLabel && !typeLabel.startsWith("DOCUMENT.")) tt.push(typeLabel);
  const img = doc.img ?? doc.thumb ?? doc.icon ?? item?.img ?? "icons/svg/dice-target.svg";
  return `<div class="bg3-slot custom act-${esc(act || "none")} ${disabled ? "disabled" : ""}" draggable="true"
      data-action="custom-use" data-cindex="${i}" data-uuid="${esc(uuid)}" data-type="${esc(type)}"
      data-tooltip="${esc(tt.filter(Boolean).join(" · "))}" data-tooltip-direction="UP">
    <img src="${esc(img)}">${badges.join("")}
  </div>`;
}

function buildCustomBar(actor, tabs) {
  const arr = customBar();
  const total = Math.max(CUSTOM_SLOTS, Math.ceil(arr.length / 12) * 12);
  const cells = [];
  for (let i = 0; i < total; i++) cells.push(customSlotHtml(actor, arr[i] ?? null, i));
  return `<div class="bg3-bar custom">
    <div class="bg3-tabs">${buildTabs(tabs)}</div>
    <div class="bg3-grid">${cells.join("")}</div>
  </div>`;
}

async function useCustom(uuid, ev) {
  const doc = await fromUuid(uuid).catch(() => null);
  if (!doc) return ui.notifications?.warn(L("Missing"));
  const type = docTypeName(doc);
  const token = canvas?.tokens?.controlled?.[0] ?? null;
  switch (type) {
    case "Macro":
      return doc.execute({ actor: getActor() ?? undefined, token: token ?? undefined, event: ev });
    case "Item":
      if (doc.parent && doc.isOwner && typeof doc.use === "function") return doc.use({ event: ev, legacy: false });
      return doc.sheet?.render(true);
    case "RollTable":
      return doc.draw();
    case "Scene":
      return game.user.isGM ? doc.view() : doc.sheet?.render(true);
    case "JournalEntryPage":
      return doc.parent?.sheet?.render(true, { pageId: doc.id });
    case "PlaylistSound":
      return doc.parent?.playSound?.(doc);
    case "Playlist":
      return doc.playAll?.();
    default:
      if (typeof doc.use === "function") return doc.use({ event: ev, legacy: false }); // Activity и т.п.
      return doc.sheet?.render(true);
  }
}

async function openCustom(uuid) {
  const doc = await fromUuid(uuid).catch(() => null);
  if (!doc) return;
  if (doc.sheet) return doc.sheet.render(true);
  return doc.item?.sheet?.render(true);
}

async function createMacroAt(index) {
  try {
    const type = game.user.can?.("MACRO_SCRIPT") ? "script" : "chat";
    const cls = Macro.implementation ?? Macro;
    const macro = await cls.create({ name: `${L("NewMacro")} ${index + 1}`, type, img: "icons/svg/dice-target.svg", command: "" }, { renderSheet: true });
    if (!macro) return;
    const arr = customBar();
    arr[index] = macro.uuid;
    await saveCustomBar(arr);
  } catch (err) {
    console.error(MOD, err);
    ui.notifications?.warn(L("MacroCreateFail"));
  }
}

async function importCoreHotbar() {
  const arr = customBar();
  const entries = Object.entries(game.user.hotbar ?? {}).sort((a, b) => Number(a[0]) - Number(b[0]));
  let n = 0;
  for (const [slot, id] of entries) {
    const macro = game.macros?.get(id);
    if (!macro || arr.includes(macro.uuid)) continue;
    let idx = Number(slot) - 1;
    if (!(idx >= 0) || arr[idx]) idx = arr.findIndex((x) => !x);
    if (idx < 0) { arr.push(null); idx = arr.length - 1; }
    arr[idx] = macro.uuid;
    n++;
  }
  await saveCustomBar(arr);
  ui.notifications?.info(game.i18n.format("BG3HUD.Imported", { n }));
}

/* ------------------------------------------------------------------ */
/*  Панель игрока: 4 вкладки — Избранное, Атака, Заклинания, Реакции    */
/*  Записи: "i:<id предмета>" или "m:<uuid макроса>".                   */
/*  Хранится у персонажа: flags.rpg-tools-by-hibear.hud.ptab.<вкладка> (позиции), */
/*  hud.premoved.<вкладка> — что игрок убрал с авто-заполняемых вкладок. */
/* ------------------------------------------------------------------ */

const PTABS = ["favorites", "attack", "spell", "reaction"];
const PTAB_ICONS = { favorites: "fa-solid fa-star", attack: "fa-solid fa-sword", spell: "fa-solid fa-hat-wizard", reaction: "fa-solid fa-bolt" };

/** Панель из 4 вкладок — одинаковая у всех: у игроков и у мастера, когда он выделяет токен */
function playerMode() {
  return !!setting("playerTabs");
}

function pLocked() {
  return !!setting("playerLock");
}

/** Что попадает на вкладку автоматически */
function pAutoItems(actor, tab) {
  if (tab === "favorites") return [];
  const onlyPrepared = setting("onlyPrepared");
  const out = [];
  for (const item of actor.items) {
    const act = activationType(item);
    if (tab === "reaction") {
      const anyReaction = [...(item.system?.activities ?? [])].some((a) => a?.activation?.type === "reaction");
      if (act === "reaction" || anyReaction) out.push(item);
      continue;
    }
    if (tab === "spell") {
      if (item.type === "spell" && !(onlyPrepared && !isPrepared(item))) out.push(item);
      continue;
    }
    if (tab === "attack") {
      if (item.type === "spell") continue;
      const isWeapon = item.type === "weapon" && item.system?.equipped !== false;
      const hasAttack = item.type !== "weapon" && [...(item.system?.activities ?? [])].some((a) => a.type === "attack");
      if (isWeapon || hasAttack) out.push(item);
    }
  }
  const byName = (a, b) => (a.name ?? "").localeCompare(b.name ?? "");
  if (tab === "spell") out.sort((a, b) => (a.system.level ?? 0) - (b.system.level ?? 0) || byName(a, b));
  else out.sort(byName);
  return out;
}

function pStored(actor, tab) {
  const v = actor.getFlag(MOD, `hud.ptab.${tab}`);
  if (Array.isArray(v)) return v.map((x) => x ?? null);
  if (tab === "favorites") {
    // старое «Избранное» (список id предметов) — переносим как есть
    return (actor.getFlag(MOD, "hud.favorites") ?? []).filter((id) => actor.items.has(id)).map((id) => `i:${id}`);
  }
  return [];
}

function pRemoved(actor, tab) {
  return actor.getFlag(MOD, `hud.premoved.${tab}`) ?? [];
}

/** Итоговые ячейки вкладки: сохранённые позиции + новые подходящие предметы в свободные места */
function pCells(actor, tab) {
  const cells = pStored(actor, tab).map((e) => (pValid(actor, e) ? e : null));
  if (tab !== "favorites") {
    const removed = new Set(pRemoved(actor, tab));
    for (const item of pAutoItems(actor, tab)) {
      const e = `i:${item.id}`;
      if (cells.includes(e) || removed.has(item.id)) continue;
      const free = cells.indexOf(null);
      if (free >= 0) cells[free] = e; else cells.push(e);
    }
  }
  return cells;
}

function pValid(actor, e) {
  if (!e) return false;
  if (e.startsWith("i:")) return actor.items.has(e.slice(2));
  if (e.startsWith("m:")) return !!fromUuidSync(e.slice(2), { strict: false });
  return false;
}

async function pSave(actor, tab, cells, removedIds = null) {
  while (cells.length && cells.at(-1) == null) cells.pop();
  const upd = { [`flags.${MOD}.hud.ptab.${tab}`]: cells.map((x) => x ?? null) };
  if (removedIds) upd[`flags.${MOD}.hud.premoved.${tab}`] = removedIds;
  return actor.update(upd);
}

async function pRemove(actor, tab, index) {
  const cells = pCells(actor, tab);
  const e = cells[index];
  if (!e) return;
  cells[index] = null;
  let removed = null;
  if (tab !== "favorites" && e.startsWith("i:")) removed = [...new Set([...pRemoved(actor, tab), e.slice(2)])];
  return pSave(actor, tab, cells, removed);
}

async function pPut(actor, tab, entry, index = null) {
  const cells = pCells(actor, tab);
  const existing = cells.indexOf(entry);
  if (index == null) {
    if (existing >= 0) return;   // уже есть на вкладке
    index = cells.indexOf(null);
    if (index < 0) index = cells.length;
  }
  if (existing >= 0 && existing !== index) {
    cells[existing] = cells[index] ?? null;   // поменять местами
  }
  while (cells.length <= index) cells.push(null);
  cells[index] = entry;
  let removed = null;
  if (entry.startsWith("i:") && pRemoved(actor, tab).includes(entry.slice(2))) {
    removed = pRemoved(actor, tab).filter((id) => id !== entry.slice(2));
  }
  return pSave(actor, tab, cells, removed);
}

function pSlotHtml(actor, entry, index) {
  const drag = pLocked() ? "" : `draggable="true"`;
  if (!entry) return `<div class="bg3-slot empty" data-pindex="${index}"></div>`;
  const attrs = `${drag} data-action="p-use" data-pindex="${index}" data-pentry="${esc(entry)}"`;
  if (entry.startsWith("i:")) {
    const item = actor.items.get(entry.slice(2));
    return item ? slotHtml(actor, item, null, attrs) : `<div class="bg3-slot empty" data-pindex="${index}"></div>`;
  }
  const macro = fromUuidSync(entry.slice(2), { strict: false });
  if (!macro) return `<div class="bg3-slot empty" data-pindex="${index}"></div>`;
  return `<div class="bg3-slot act-none macro" ${attrs}
      data-tooltip="${esc(macro.name)} · ${esc(L("PMacro"))}" data-tooltip-direction="UP">
    <img src="${esc(macro.img || "icons/svg/dice-target.svg")}"><span class="b-macro"><i class="fa-solid fa-code"></i></span>
  </div>`;
}

function buildPlayerBar(actor) {
  if (!PTABS.includes(state.tab)) state.tab = "favorites";
  const cells = pCells(actor, state.tab);
  const total = Math.max(GRID_SLOTS, Math.ceil((cells.length + 1) / 12) * 12);
  const html = [];
  for (let i = 0; i < total; i++) html.push(pSlotHtml(actor, cells[i] ?? null, i));
  const tabs = PTABS.map((t) => `<button type="button" class="bg3-tab ${state.tab === t ? "active" : ""}" data-action="tab" data-tab="${t}"
      data-tooltip="${esc(L(`PTabs.${t}`))}" data-tooltip-direction="UP"><i class="${PTAB_ICONS[t]}"></i></button>`).join("");
  const locked = pLocked();
  const lock = `<button type="button" class="bg3-tab bg3-tab-extra bg3-plock ${locked ? "on" : ""}" data-action="p-lock"
      data-tooltip="${esc(L(locked ? "PUnlock" : "PLock"))}" data-tooltip-direction="UP"><i class="fa-solid ${locked ? "fa-lock" : "fa-lock-open"}"></i></button>`;
  return `<div class="bg3-bar player ${locked ? "locked" : ""}">
    <div class="bg3-tabs">${tabs}${lock}</div>
    <div class="bg3-grid">${html.join("")}</div>
  </div>`;
}

/** Действие по записи панели */
async function pUse(actor, entry, ev) {
  if (entry.startsWith("m:")) {
    const macro = await fromUuid(entry.slice(2)).catch(() => null);
    return macro?.execute?.();
  }
  const item = actor.items.get(entry.slice(2));
  return item?.use?.({ event: ev, legacy: false }) ?? item?.roll?.();
}

async function pShowInChat(actor, item) {
  if (typeof item.displayCard === "function") return item.displayCard();
  const TE = foundry.applications?.ux?.TextEditor?.implementation ?? globalThis.TextEditor;
  const desc = await TE.enrichHTML(item.system?.description?.value ?? "", { relativeTo: item, rollData: item.getRollData?.() });
  return ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content: `<div class="bg3-chat-item"><h3><img src="${esc(item.img)}" width="28" height="28" style="vertical-align:middle;border:none"> ${esc(item.name)}</h3>${desc}</div>`
  });
}

async function pDescribe(item) {
  const TE = foundry.applications?.ux?.TextEditor?.implementation ?? globalThis.TextEditor;
  const desc = await TE.enrichHTML(item.system?.description?.value || `<p><em>${esc(L("PNoDesc"))}</em></p>`,
    { relativeTo: item, rollData: item.getRollData?.() });
  const act = activationType(item);
  const meta = [item.type === "spell" ? ((item.system?.level ?? 0) ? `${L("SpellLevel")} ${item.system.level}` : L("Cantrip")) : null,
    act ? activationLabel(act) : null].filter(Boolean).join(" · ");
  return foundry.applications.api.DialogV2.prompt({
    window: { title: item.name, icon: "fa-solid fa-book-open" },
    position: { width: 440 },
    content: `<div class="bg3-desc"><div class="bg3-desc-head"><img src="${esc(item.img)}"><div><b>${esc(item.name)}</b>${meta ? `<br><small>${esc(meta)}</small>` : ""}</div></div>${desc}</div>`,
    ok: { label: L("PClose"), icon: "fa-solid fa-check" },
    rejectClose: false
  });
}

function closeCtx() {
  state.ctx?.remove();
  state.ctx = null;
}

/** Меню по правому клику на ячейке игрока */
function pContext(actor, slot, ev) {
  closeCtx();
  const entry = slot.dataset.pentry;
  const index = Number(slot.dataset.pindex);
  const tab = state.tab;
  const isItem = entry.startsWith("i:");
  const item = isItem ? actor.items.get(entry.slice(2)) : null;
  const name = item?.name ?? fromUuidSync(entry.slice(2), { strict: false })?.name ?? "";
  const inFav = pCells(actor, "favorites").includes(entry);
  const opts = [["use", "fa-solid fa-play", L("PUse")]];
  if (item) {
    opts.push(["chat", "fa-solid fa-comment", L("PChat")]);
    opts.push(["desc", "fa-solid fa-book-open", L("PDesc")]);
    if (tab !== "favorites" && !inFav) opts.push(["fav", "fa-solid fa-star", L("PAddFav")]);
  }
  if (!pLocked()) opts.push(["remove", "fa-solid fa-trash", L("PRemove")]);
  const menu = document.createElement("div");
  menu.className = "bg3-ctx";
  menu.innerHTML = `<div class="bg3-ctx-title">${esc(name)}</div>` +
    opts.map(([k, icon, label]) => `<button type="button" data-ctx="${k}"><i class="${icon}"></i> ${esc(label)}</button>`).join("");
  document.body.appendChild(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(ev.clientX, window.innerWidth - r.width - 6)}px`;
  menu.style.top = `${Math.max(6, ev.clientY - r.height - 6)}px`;
  menu.addEventListener("click", async (e) => {
    const k = e.target.closest("[data-ctx]")?.dataset.ctx;
    if (!k) return;
    closeCtx();
    switch (k) {
      case "use": return pUse(actor, entry, e);
      case "chat": return item && pShowInChat(actor, item);
      case "desc": return item && pDescribe(item);
      case "fav":
        await pPut(actor, "favorites", entry);
        return ui.notifications.info(`${name}: ${L("PAddedFav")}`);
      case "remove": return pRemove(actor, tab, index);
    }
  });
  state.ctx = menu;
  const away = (e) => {
    if (state.ctx && !state.ctx.contains(e.target)) { closeCtx(); document.removeEventListener("pointerdown", away, true); }
  };
  setTimeout(() => document.addEventListener("pointerdown", away, true), 0);
}

/** Сюда игрок перетащил что-то на свою панель */
async function pDrop(actor, data, ev) {
  if (pLocked()) return ui.notifications.info(L("PLockedHint"));
  const cell = ev.target.closest("[data-pindex]");
  const index = cell ? Number(cell.dataset.pindex) : null;
  const tab = state.tab;

  // Ячейка с этой же панели
  if (data.type === "rpgtHudSlot") {
    if (data.tab === tab) {
      if (index == null || index === data.index) return;
      const cells = pCells(actor, tab);
      while (cells.length <= index) cells.push(null);
      const tmp = cells[index] ?? null;
      cells[index] = cells[data.index] ?? null;
      cells[data.index] = tmp;
      return pSave(actor, tab, cells);
    }
    if (data.entry.startsWith("m:") && tab !== "favorites") return ui.notifications.warn(L("PMacroOnlyFav"));
    return pPut(actor, tab, data.entry, index);   // на другую вкладку — копия
  }

  let uuid = data.uuid ?? null;
  if (!uuid && data.type === "Macro" && data.id) uuid = game.macros?.get(data.id)?.uuid ?? null;
  if (!uuid) return;

  if (data.type === "Macro") {
    if (!game.user.isGM && !setting("playerMacros")) return ui.notifications.warn(L("PMacroDenied"));
    const macro = await fromUuid(uuid).catch(() => null);
    if (!macro) return;
    if (macro.canExecute === false || (macro.testUserPermission && !macro.testUserPermission(game.user, "OBSERVER"))) {
      return ui.notifications.warn(L("PMacroDenied"));
    }
    if (tab !== "favorites") {
      state.tab = "favorites";
      return pPut(actor, "favorites", `m:${uuid}`);
    }
    return pPut(actor, tab, `m:${uuid}`, index);
  }

  if (data.type === "Item") {
    const item = await fromUuid(uuid).catch(() => null);
    if (!item || !sameActor(item.parent, actor)) return ui.notifications.warn(L("POnlyOwn"));
    return pPut(actor, tab, `i:${item.id}`, index);
  }
}

function buildEndTurn(actor, st) {
  const combat = game.combat;
  const started = !!combat?.started;
  const cur = combat?.combatant;
  const canEnd = !!(started && cur?.isOwner && (!game.user.isGM || st?.isTurn || !combatantFor(actor, combat)));
  const tip = !started ? L("NotInCombat") : canEnd ? L("EndTurn") : L("NotYourTurn");
  const round = started ? `<div class="round">${esc(L("Round"))} ${combat.round}</div>` : "";
  return `<div class="bg3-endturn-wrap">
    ${round}
    <button type="button" class="bg3-endturn ${canEnd ? "ready" : ""}" data-action="end-turn" ${canEnd ? "" : "disabled"}
      data-tooltip="${esc(tip)}" data-tooltip-direction="UP"><i class="fa-solid fa-hourglass-half"></i></button>
  </div>`;
}

function buildHud(actor) {
  const st = getEcon(actor);
  return `
    <div class="bg3-top">
      ${buildEffects(actor)}
      <div class="bg3-resources">
        ${buildEcon(actor, st)}
        ${buildMovement(actor, st)}
        ${buildSlots(actor)}
        ${buildResources(actor)}
      </div>
    </div>
    <div class="bg3-main">
      ${buildPortrait(actor, st)}
      ${buildBar(actor)}
      ${buildEndTurn(actor, st)}
    </div>`;
}

/* ------------------------------------------------------------------ */
/*  Микроменю (вкладки сайдбара) в стиле WoW                            */
/* ------------------------------------------------------------------ */

function sidebarTabs() {
  const res = [];
  const nav = document.getElementById("sidebar-tabs");
  nav?.querySelectorAll("[data-tab]").forEach((el) => {
    const tab = el.dataset.tab;
    if (!tab || res.some((r) => r.tab === tab)) return;
    const cls = [...el.classList, ...(el.querySelector("i")?.classList ?? [])].filter((c) => c.startsWith("fa"));
    const fb = FALLBACK_TABS.find((f) => f[0] === tab);
    const label = el.dataset.tooltip || el.getAttribute("aria-label") || fb?.[2] || tab;
    res.push({ tab, icon: cls.length ? cls.join(" ") : (fb?.[1] ?? "fa-solid fa-circle"), label: game.i18n.localize(label) });
  });
  if (res.length) return res;
  return FALLBACK_TABS
    .filter(([tab]) => tab !== "scenes" || game.user.isGM)
    .map(([tab, icon, label]) => ({ tab, icon, label: game.i18n.localize(label) }));
}

function sidebarStatus() {
  const sb = ui.sidebar;
  const el = document.getElementById("sidebar");
  const expanded = sb?.expanded ?? (el ? !el.classList.contains("collapsed") : false);
  const active = sb?.tabGroups?.primary ?? sb?.activeTab ?? null;
  return { expanded, active };
}

function setSidebarExpanded(flag) {
  const sb = ui.sidebar;
  if (!sb) return;
  if (flag) {
    if (typeof sb.expand === "function") sb.expand();
    else if (typeof sb.toggleExpanded === "function") sb.toggleExpanded(true);
  } else {
    if (typeof sb.collapse === "function") sb.collapse();
    else if (typeof sb.toggleExpanded === "function") sb.toggleExpanded(false);
  }
}

function openSidebarTab(tab) {
  const { expanded, active } = sidebarStatus();
  if (expanded && active === tab) {
    setSidebarExpanded(false);
  } else {
    try { ui.sidebar.changeTab(tab, "primary"); }
    catch { document.querySelector(`#sidebar-tabs [data-tab="${tab}"]`)?.click(); }
    if (!expanded) setSidebarExpanded(true);
  }
  if (tab === "chat") state.unread = 0;
  setTimeout(renderMicro, 60);
  setTimeout(positionMicro, 350);
}

function renderMicro() {
  if (!state.micro) return;
  const show = setting("enabled") && !state.hidden && setting("hideSidebarTabs");
  state.micro.style.display = show ? "" : "none";
  if (!show) { positionMicro(); return; }
  const { expanded, active } = sidebarStatus();
  if (expanded && active === "chat") state.unread = 0;
  state.micro.innerHTML = sidebarTabs().map(({ tab, icon, label }) => {
    const on = expanded && active === tab;
    const badge = tab === "chat" && state.unread ? `<span class="badge">${state.unread > 99 ? "99+" : state.unread}</span>` : "";
    return `<button type="button" class="micro-btn ${on ? "active" : ""}" data-tab="${esc(tab)}" data-tooltip="${esc(label)}" data-tooltip-direction="UP">
      <i class="${esc(icon)}"></i>${badge}</button>`;
  }).join("");
  positionMicro();
}

/**
 * «Плавающий» чат (когда сайдбар свёрнут) Foundry ставит в правый нижний угол — туда же, где панель и микроменю.
 * Если наши элементы его перекрывают, поднимаем весь блок чата (сообщения + поле ввода) над ними.
 */
function setChatLift(host, px) {
  if (state.chatHost && state.chatHost !== host) state.chatHost.style.removeProperty("transform");
  state.chatHost = host;
  state.chatLift = px;
  if (!host) return;
  if (px) { host.style.transform = `translateY(-${px}px)`; host.style.transition = "transform .2s"; }
  else host.style.removeProperty("transform");
}

function liftFloatingChat() {
  // Видимое поле ввода чата вне сайдбара (в сайдбаре оно никому не мешает)
  const input = [...document.querySelectorAll("#chat-message, textarea.chat-input")].find((el) => {
    if (el.closest("#sidebar")) return false;
    const r = el.getBoundingClientRect();
    return r.width > 4 && r.height > 4;
  });
  if (!input || !document.body.classList.contains("bg3hud-on")) return setChatLift(null, 0);
  const form = input.closest(".chat-form, form") ?? input.parentElement ?? input;
  // Поднимаем весь блок «плавающего» чата (сообщения + ввод), иначе только форму ввода
  const host = input.closest("#chat-notifications") ?? form;
  const lift = state.chatHost === host ? (state.chatLift ?? 0) : 0;
  const r = form.getBoundingClientRect();
  const box = { left: r.left - 40, right: r.right + 40, top: r.top + lift, bottom: r.bottom + lift };
  const obstacles = [state.micro, ...(state.root?.querySelectorAll(".bg3-main > *, .bg3-top > *") ?? [])];
  let top = Infinity;
  for (const el of obstacles) {
    if (!el?.isConnected) continue;
    const o = el.getBoundingClientRect();
    if (o.width < 2 || o.height < 2) continue;
    const overlapX = o.left < box.right && o.right > box.left;
    const overlapY = o.top < box.bottom && o.bottom > box.top;
    if (overlapX && overlapY) top = Math.min(top, o.top);
  }
  const next = top === Infinity ? 0 : Math.ceil(box.bottom - top + 8);
  if (state.chatHost === host && Math.abs(next - lift) < 2) return;
  setChatLift(host, next);
}

function positionMicro() {
  if (!state.micro) return;
  const sb = document.getElementById("sidebar");
  let right = 8;
  if (sb) {
    const r = sb.getBoundingClientRect();
    if (r.width > 4 && r.height > 4) right = Math.max(8, window.innerWidth - r.left + 8);
  }
  document.documentElement.style.setProperty("--bg3-sidebar-w", `${Math.max(0, right - 8)}px`);
  const value = `${Math.round(right)}px`;
  if (state.micro.style.right !== value) state.micro.style.right = value;
  liftFloatingChat();
}

/* ------------------------------------------------------------------ */
/*  DOM и обработчики                                                   */
/* ------------------------------------------------------------------ */

function applyBodyClasses() {
  const on = !!setting("enabled") && !state.hidden;
  document.body.classList.toggle("bg3hud-on", on);
  document.body.classList.toggle("bg3hud-hide-hotbar", on && !!setting("hideHotbar"));
  document.body.classList.toggle("bg3hud-hide-tabs", on && !!setting("hideSidebarTabs"));
  document.documentElement.style.setProperty("--bg3-scale", String(setting("scale") ?? 1));
  applyDock();
}

function ensureDom() {
  if (!state.root) {
    state.root = document.createElement("div");
    state.root.id = "bg3hud";
    document.body.appendChild(state.root);
    state.root.addEventListener("click", onClick);
    state.root.addEventListener("contextmenu", onContext);
    state.root.addEventListener("dragstart", onDragStart);
    state.root.addEventListener("dragover", (ev) => { if (ev.target.closest(".bg3-bar")) ev.preventDefault(); });
    state.root.addEventListener("drop", onDrop);
    state.root.addEventListener("dragover", (ev) => {
      // перетаскивание ячейки на кнопку другой вкладки — вкладка открывается
      const tabBtn = state.pDrag && ev.target.closest('.bg3-bar.player [data-action="tab"]');
      if (tabBtn && tabBtn.dataset.tab !== state.tab) { state.tab = tabBtn.dataset.tab; render(); }
    });
    state.root.addEventListener("dragend", (ev) => {
      const d = state.pDrag;
      state.pDrag = null;
      if (!d || d.handled || pLocked()) return;
      const r = state.root.querySelector(".bg3-bar")?.getBoundingClientRect();
      const inside = r && ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom;
      if (inside || (ev.clientX === 0 && ev.clientY === 0)) return;   // 0,0 — перетаскивание отменили (Esc)
      const actor = getActor();
      if (actor) pRemove(actor, d.tab, d.index);
    });
  }
  if (!state.micro) {
    state.micro = document.createElement("div");
    state.micro.id = "bg3hud-micro";
    document.body.appendChild(state.micro);
    state.micro.addEventListener("click", (ev) => {
      const btn = ev.target.closest("[data-tab]");
      if (btn) openSidebarTab(btn.dataset.tab);
    });
    const sb = document.getElementById("sidebar");
    if (sb && "ResizeObserver" in window) {
      state.observer = new ResizeObserver(() => positionMicro());
      state.observer.observe(sb);
    }
    window.addEventListener("resize", positionMicro);
    // Поле чата появляется/исчезает при сворачивании сайдбара — раз в секунду проверяем, не перекрыли ли его
    state.microTimer ??= setInterval(positionMicro, 1000);
  }
}

function teardownDom() {
  state.root?.remove();
  state.micro?.remove();
  state.observer?.disconnect();
  state.root = state.micro = state.observer = null;
  setChatLift(null, 0);   // вернуть чат на место
  applyBodyClasses();
}

function render() {
  if (!game.ready) return;
  if (!setting("enabled")) { teardownDom(); return; }
  ensureDom();
  applyBodyClasses();
  const actor = getActor();
  state.root.style.display = state.hidden ? "none" : "";
  state.root.classList.toggle("no-actor", !actor);
  state.root.innerHTML = actor ? buildHud(actor) : "";
  requestAnimationFrame(() => liftFloatingChat());
  afterRender(state.root, actor);
  renderMicro();
}

const scheduleRender = foundry.utils.debounce(render, 40);

async function onClick(ev) {
  const el = ev.target.closest("[data-action]");
  if (!el) return;
  const actor = getActor();
  if (!actor) return;
  ev.preventDefault();
  const action = el.dataset.action;
  switch (action) {
    case "use-item": {
      const item = actor.items.get(el.dataset.itemId);
      if (!item) return;
      if (ev.shiftKey && state.tab === "favorites") {
        const ids = (actor.getFlag(MOD, "hud.favorites") ?? []).filter((id) => id !== item.id);
        await actor.setFlag(MOD, "hud.favorites", ids);
        ui.notifications?.info(`${item.name}: ${L("Removed")}`);
        return;
      }
      return item.use?.({ event: ev, legacy: false }) ?? item.roll?.();
    }
    case "p-use":
      return pUse(actor, el.dataset.pentry, ev);
    case "p-lock":
      await game.settings.set(MOD, SKEY("playerLock"), !pLocked());
      return render();
    case "custom-use": {
      if (ev.shiftKey) {
        const arr = customBar();
        arr[Number(el.dataset.cindex)] = null;
        return saveCustomBar(arr);
      }
      return useCustom(el.dataset.uuid, ev);
    }
    case "custom-empty":
      return createMacroAt(Number(el.dataset.cindex));
    case "custom-import":
      return importCoreHotbar();
    case "tab":
      state.tab = el.dataset.tab;
      return render();
    case "econ": {
      const key = el.dataset.key;
      return patchEcon(actor, (d) => ({ ...d, [key]: !d[key] }));
    }
    case "move":
      return patchEcon(actor, (d) => ({ ...d, dash: !d.dash }));
    case "slot-pip": {
      const path = el.dataset.path;
      const idx = Number(el.dataset.index);
      const cur = Number(actor.system.spells?.[path]?.value) || 0;
      const next = idx < cur ? idx : idx + 1;
      return actor.update({ [`system.spells.${path}.value`]: next });
    }
    case "res-pip": {
      const idx = Number(el.dataset.index);
      if (el.dataset.kind === "item") {
        const item = actor.items.get(el.dataset.id);
        const u = getUses(item);
        if (!u) return;
        return setUses(item, idx < u.value ? idx : idx + 1);
      }
      const key = el.dataset.id;
      const cur = Number(actor.system.resources?.[key]?.value) || 0;
      return actor.update({ [`system.resources.${key}.value`]: idx < cur ? idx : idx + 1 });
    }
    case "res-use": {
      if (el.dataset.kind !== "item") return;
      const item = actor.items.get(el.dataset.id);
      return item?.use?.({ event: ev, legacy: false });
    }
    case "sheet":
      return actor.sheet?.render(true);
    case "short-rest":
      return actor.shortRest?.();
    case "long-rest":
      return actor.longRest?.();
    case "death":
      return actor.rollDeathSave?.({ event: ev });
    case "end-turn": {
      const combat = game.combat;
      if (!combat?.started || !combat.combatant?.isOwner) return;
      return combat.nextTurn();
    }
  }
}

function onContext(ev) {
  const actor = getActor();
  if (!actor) return;
  const pslot = ev.target.closest(".bg3-slot[data-pentry]");
  if (pslot) {
    ev.preventDefault();
    return pContext(actor, pslot, ev);
  }
  if (playerMode() && ev.target.closest(".bg3-bar")) return ev.preventDefault();
  const slot = ev.target.closest(".bg3-slot[data-item-id]");
  if (slot) {
    ev.preventDefault();
    return actor.items.get(slot.dataset.itemId)?.sheet?.render(true);
  }
  const cslot = ev.target.closest(".bg3-slot.custom[data-uuid]");
  if (cslot) {
    ev.preventDefault();
    return openCustom(cslot.dataset.uuid);
  }
  const res = ev.target.closest('[data-action="res-use"][data-kind="item"]');
  if (res) {
    ev.preventDefault();
    return actor.items.get(res.dataset.id)?.sheet?.render(true);
  }
  if (ev.target.closest('[data-action="move"]')) {
    ev.preventDefault();
    return patchEcon(actor, (d) => ({ ...d, moved: 0 }));
  }
}

function onDragStart(ev) {
  const pslot = ev.target.closest(".bg3-slot[data-pentry]");
  if (pslot) {
    if (pLocked()) return ev.preventDefault();
    const entry = pslot.dataset.pentry;
    const index = Number(pslot.dataset.pindex);
    // Свой тип данных: на карте, в листах и т.п. такие данные никто не обрабатывает — ничего не создаётся
    ev.dataTransfer.setData("text/plain", JSON.stringify({ type: "rpgtHudSlot", tab: state.tab, index, entry }));
    ev.dataTransfer.effectAllowed = "move";
    state.pDrag = { tab: state.tab, index, entry, handled: false };
    return;
  }
  const cslot = ev.target.closest(".bg3-slot.custom[data-uuid]");
  if (cslot) {
    const data = { type: cslot.dataset.type || "Macro", uuid: cslot.dataset.uuid, bg3custom: true, fromIndex: Number(cslot.dataset.cindex) };
    ev.dataTransfer.setData("text/plain", JSON.stringify(data));
    return;
  }
  const slot = ev.target.closest(".bg3-slot[data-item-id]");
  const actor = getActor();
  if (!slot || !actor) return;
  const item = actor.items.get(slot.dataset.itemId);
  if (!item) return;
  const data = { type: "Item", uuid: item.uuid, bg3hud: true, fromIndex: slot.dataset.index ?? null };
  ev.dataTransfer.setData("text/plain", JSON.stringify(data));
}

async function onDrop(ev) {
  if (state.pDrag) state.pDrag.handled = true;   // бросили на интерфейс — не удалять
  if (!ev.target.closest(".bg3-bar")) return;
  ev.preventDefault();
  const actor = getActor();
  if (!actor) return;
  let data;
  try { data = JSON.parse(ev.dataTransfer.getData("text/plain")); } catch { return; }
  if (!data) return;
  if (playerMode()) return pDrop(actor, data, ev);
  let uuid = data.uuid ?? null;
  if (!uuid && data.type === "Macro" && data.id) uuid = game.macros?.get(data.id)?.uuid ?? null;
  if (!uuid) return;

  // Предмет своего персонажа на обычной вкладке → «Избранное»
  if (state.tab !== "custom" && data.type === "Item" && !data.bg3custom) {
    const item = await fromUuid(uuid).catch(() => null);
    if (item && sameActor(item.parent, actor)) {
      const ids = [...(actor.getFlag(MOD, "hud.favorites") ?? [])].filter((id) => actor.items.has(id));
      const without = ids.filter((id) => id !== item.id);
      const target = ev.target.closest("[data-index]");
      let pos = target && state.tab === "favorites" ? Number(target.dataset.index) : without.length;
      pos = clamp(pos, 0, without.length);
      without.splice(pos, 0, item.id);
      state.tab = "favorites";
      return actor.setFlag(MOD, "hud.favorites", without);
    }
  }

  // Всё остальное (макросы, чужие/мировые предметы, умения, таблицы…) → «Своя панель»
  const arr = customBar();
  const cell = state.tab === "custom" ? ev.target.closest("[data-cindex]") : null;
  let idx = cell ? Number(cell.dataset.cindex) : arr.findIndex((x) => !x);
  if (idx < 0) { arr.push(null); idx = arr.length - 1; }
  const from = data.bg3custom ? Number(data.fromIndex) : arr.indexOf(uuid);
  if (from >= 0 && from !== idx) {
    arr[from] = arr[idx] ?? null; // поменять местами
    arr[idx] = uuid;
  } else {
    arr[idx] = uuid;
  }
  state.tab = "custom";
  await saveCustomBar(arr);
  render();
}

/* ------------------------------------------------------------------ */
/*  Учёт пройденного расстояния                                         */
/* ------------------------------------------------------------------ */

function onPreUpdateToken(doc, changes, options, userId) {
  if (!("x" in changes || "y" in changes)) return;
  if (options.teleport || options.bg3hudIgnore) return;
  const combat = game.combat;
  if (!combat?.started || userId !== game.user.id) return;
  const cb = combat.combatant;
  if (!cb || cb.tokenId !== doc.id) return;
  if (!canvas?.grid || canvas.scene?.id !== doc.parent?.id) return;

  const from = { x: doc.x, y: doc.y };
  let path = [from, { x: changes.x ?? doc.x, y: changes.y ?? doc.y }];
  const mv = options.movement?.[doc.id];
  if (mv?.waypoints?.length) {
    if (mv.waypoints.some((w) => w.action === "displace")) return; // телепорт
    path = [from, ...mv.waypoints.map((w) => ({ x: w.x, y: w.y }))];
  }
  let dist = 0;
  try { dist = canvas.grid.measurePath(path).distance; } catch { dist = 0; }
  if (!dist) return;
  const actor = doc.actor;
  if (!actor) return;
  patchEcon(actor, (d) => ({ ...d, moved: (d.moved || 0) + dist }));
}

/* ------------------------------------------------------------------ */
/*  Инициализация                                                       */
/* ------------------------------------------------------------------ */

/**
 * Запуск функции. Вызывается ядром RPG Suite во время init, только если функция включена.
 */
export function setup() {
  const reg = (key, data) => game.settings.register(MOD, SKEY(key), {
    name: `BG3HUD.Settings.${key}.name`,
    hint: `BG3HUD.Settings.${key}.hint`,
    scope: "client",
    config: true,
    onChange: () => { applyBodyClasses(); scheduleRender(); },
    ...data
  });
  reg("enabled", { type: Boolean, default: true });
  reg("hideHotbar", { type: Boolean, default: true });
  reg("hideSidebarTabs", { type: Boolean, default: true });
  reg("onlyPrepared", { type: Boolean, default: true });
  reg("showAllResources", { type: Boolean, default: false });
  reg("scale", { type: Number, default: 1, range: { min: 0.6, max: 1.5, step: 0.05 } });
  reg("playerTabs", { type: Boolean, default: true, scope: "world" });
  reg("playerMacros", { type: Boolean, default: true, scope: "world" });
  reg("playerLock", { type: Boolean, default: false, config: false });

  registerVoiceSettings();

  game.keybindings?.register(MOD, "hud-toggle", {
    name: "BG3HUD.Keybind.toggle",
    editable: [{ key: "KeyH", modifiers: ["Shift"] }],
    onDown: () => { state.hidden = !state.hidden; applyBodyClasses(); render(); return true; }
  });

Hooks.once("ready", () => {
  if (game.system.id !== "dnd5e") console.warn(`${MOD} | рассчитан на систему dnd5e`);
  render();
  setTimeout(positionMicro, 500);
  initVoiceBridge({
    getActor,
    getRoot: () => state.root,
    isOn: () => !!setting("enabled") && !state.hidden,
    rerender: () => render()
  });
});

// Перерисовка при изменении данных персонажа
for (const hook of ["updateActor", "createItem", "updateItem", "deleteItem", "createActiveEffect", "updateActiveEffect", "deleteActiveEffect"]) {
  Hooks.on(hook, (doc) => { if (isRelevant(doc)) scheduleRender(); });
}
// Бой, выбор токена, сцена, назначение персонажа
for (const hook of ["createCombat", "updateCombat", "deleteCombat", "combatStart", "combatTurn", "combatRound",
  "createCombatant", "updateCombatant", "deleteCombatant", "controlToken", "canvasReady"]) {
  Hooks.on(hook, () => scheduleRender());
}
Hooks.on("updateUser", (user) => { if (user.id === game.user.id) scheduleRender(); });
// Свободная панель: изменения макросов, таблиц и т.п.
for (const hook of ["createMacro", "updateMacro", "deleteMacro", "updateRollTable", "deleteRollTable"]) {
  Hooks.on(hook, () => { if (state.tab === "custom") scheduleRender(); });
}

// Сайдбар → обновить микроменю
for (const hook of ["changeSidebarTab", "collapseSidebar", "renderSidebar", "renderSidebarTab"]) {
  Hooks.on(hook, () => setTimeout(() => { renderMicro(); positionMicro(); }, 50));
}
Hooks.on("createChatMessage", () => {
  const { expanded, active } = sidebarStatus();
  if (!(expanded && active === "chat")) { state.unread++; renderMicro(); }
});

// Авто-отметка действий при использовании умений (dnd5e 4.x/5.x)
Hooks.on("dnd5e.postUseActivity", (activity) => {
  const actor = activity?.actor ?? activity?.item?.actor;
  markActivation(actor, activity?.activation?.type, activity?.item?.name ?? "");
});
// Старые версии dnd5e (3.x)
Hooks.on("dnd5e.useItem", (item) => {
  if (item?.system?.activities) return;
  markActivation(item?.actor, item?.system?.activation?.type, item?.name ?? "");
});

// Функция «Реакции» RPG Suite: персонаж использовал реакцию из окна-запроса → отметить ромбик реакции
Hooks.on("rpgSuite.reactionUsed", (actor) => markActivation(actor, "reaction"));

Hooks.on("preUpdateToken", onPreUpdateToken);

}   // setup
