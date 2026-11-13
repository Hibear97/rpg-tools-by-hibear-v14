/**
 * Mannequin Tool — RPG-Tools by Hibear
 * MMORPG-style equipment mannequin for dnd5e (Foundry VTT v12–v13).
 */

import { SUITE_ID } from "../../core/constants.js";
import { createFeatureHooks } from "../../core/feature-hooks.js";

/** Функция «Манекен экипировки» внутри RPG-Tools.
 *  MOD остаётся "mannequin-tool" — это CSS-класс окна и приставка переводов.
 *  Настройки: "rpg-tools-by-hibear.mq-*", слоты предметов: item.flags["rpg-tools-by-hibear"].mq.slot */
const MOD = "mannequin-tool";
const NS = SUITE_ID;
const TEMPLATE = `modules/${SUITE_ID}/features/mannequin/templates/mannequin.hbs`;
const Hooks = createFeatureHooks();

/** API для макросов: game.rpgSuite.api.mannequin.toggle() */
export const api = {};

export function setup() {
  Hooks.activate();
}
const INIT = Symbol(`${MOD}-init`);

/* -------------------------------------------- */
/*  Slot definitions                            */
/* -------------------------------------------- */

const SLOT_ICONS = {
  head: "fa-hat-wizard",
  neck: "fa-gem",
  shoulders: "fa-user-shield",
  back: "fa-vest",
  chest: "fa-shirt",
  wrists: "fa-hand-fist",
  hands: "fa-mitten",
  waist: "fa-grip-lines",
  legs: "fa-socks",
  feet: "fa-shoe-prints",
  ring1: "fa-ring",
  ring2: "fa-ring",
  mainhand: "fa-khanda",
  offhand: "fa-shield-halved",
  ranged: "fa-crosshairs",
  trinket1: "fa-ankh",
  trinket2: "fa-feather",
  trinket3: "fa-scroll",
  trinket4: "fa-hourglass-half"
};

const LEFT = ["head", "neck", "shoulders", "back", "chest", "wrists"];
const RIGHT = ["hands", "waist", "legs", "feet", "ring1", "ring2"];
const WEAPONS = ["mainhand", "offhand", "ranged"];
const RELICS = ["trinket1", "trinket2", "trinket3", "trinket4"];
const RINGS = ["ring1", "ring2"];
const ALL_SLOTS = [...LEFT, ...RIGHT, ...WEAPONS, ...RELICS];

/** Keyword → slot group (checked in order, on lower-cased name + base item). */
const KEYWORDS = [
  ["shoulders", ["pauldron", "spaulder", "shoulder", "epaulet", "наплеч", "эполет", "оплечь"]],
  ["head", ["helm", "hat ", "hat of", "hood", "crown", "circlet", "diadem", "tiara", "headband", "goggles",
    "mask", "eyes of", "lenses", "шлем", "шапк", "шляп", "капюшон", "корон", "венец", "обруч", "диадем",
    "тиар", "маск", "очки", "линз", "налобн"]],
  ["neck", ["amulet", "necklace", "periapt", "medallion", "pendant", "talisman", "scarab", "brooch", "torc",
    "choker", "амулет", "ожерел", "кулон", "медальон", "талисман", "подвеск", "брошь", "скараб", "колье"]],
  ["back", ["cloak", "cape", "mantle", "wings", "плащ", "накидк", "крыл", "пелерин"]],
  ["wrists", ["bracer", "bracelet", "armband", "vambrace", "наруч", "браслет"]],
  ["hands", ["glove", "gauntlet", "mitten", "перчат", "рукавиц"]],
  ["waist", ["belt", "girdle", "sash", "пояс", "кушак"]],
  ["legs", ["greave", "legging", "pants", "trousers", "breeches", "kilt", "поножи", "штан", "брюк", "леггин"]],
  ["feet", ["boot", "slipper", "shoe", "sandal", "сапог", "сапож", "ботин", "туфл", "обув", "сандал", "башмак", "тапоч"]],
  ["ring", [/\bring\b/, "кольц", "перстен", "печатк"]],
  ["chest", ["robe", "vest", "tunic", "shirt", "armor", "armour", "coat", "doublet", "мантия", "мантию", "роба",
    "одеяни", "рубах", "рубаш", "жилет", "туник", "доспех", "кирас", "нагрудник", "куртк", "камзол"]]
];

/* -------------------------------------------- */
/*  Helpers                                     */
/* -------------------------------------------- */

const t = (key, data) => data ? game.i18n.format(`${MOD}.${key}`, data) : game.i18n.localize(`${MOD}.${key}`);
const setting = key => game.settings.get(NS, `mq-${key}`);
const getEl = app => {
  const el = app?.element;
  if (!el) return null;
  return el instanceof HTMLElement ? el : el[0] ?? null;
};
const slotPath = `flags.${NS}.mq.slot`;
const prefPath = `flags.${NS}.mq.preferred`;

function isSupported(actor) {
  if (!(actor instanceof Actor)) return false;
  if (actor.type === "character") return true;
  return actor.type === "npc" && setting("showNpc");
}

function itemSubtype(item) {
  const s = item.system ?? {};
  return s.type?.value ?? s.weaponType ?? s.armor?.type ?? "";
}

/** Returns: "weapon" | "shield" | "body" | "ring" | "accessory" | null */
function getCategory(item) {
  const sub = itemSubtype(item);
  if (item.type === "weapon") {
    if (["natural", "siege"].includes(sub)) return null;
    return "weapon";
  }
  if (item.type === "equipment") {
    if (["vehicle", "natural"].includes(sub)) return null;
    if (sub === "shield") return "shield";
    if (["light", "medium", "heavy"].includes(sub)) return "body";
    if (sub === "ring") return "ring";
    return "accessory";
  }
  return null;
}

function isTwoHanded(item) {
  const p = item?.system?.properties;
  if (!p) return false;
  if (p instanceof Set) return p.has("two");
  if (Array.isArray(p)) return p.includes("two");
  return !!p.two;
}

function isRangedWeapon(item) {
  return item.type === "weapon" && /R$/.test(itemSubtype(item));
}

function keywordGroup(item) {
  const base = item.system?.type?.baseItem ?? "";
  const text = ` ${item.name} ${base} `.toLowerCase();
  for (const [group, words] of KEYWORDS) {
    if (words.some(w => (w instanceof RegExp ? w.test(text) : text.includes(w)))) return group;
  }
  return null;
}

/** Slots where the item may be placed at all. */
function allowedSlots(item) {
  switch (getCategory(item)) {
    case "weapon": return isTwoHanded(item) ? ["mainhand", "ranged"] : [...WEAPONS];
    case "shield": return ["offhand"];
    case "body": return ["chest"];
    case "ring": return [...RINGS, ...RELICS];
    case "accessory": return [...LEFT, ...RIGHT, "offhand", ...RELICS];
    default: return [];
  }
}

/** Slots the item goes into automatically, in priority order. */
function candidateSlots(item) {
  switch (getCategory(item)) {
    case "weapon":
      if (isRangedWeapon(item)) return ["ranged", "mainhand", "offhand"].filter(s => allowedSlots(item).includes(s));
      return isTwoHanded(item) ? ["mainhand"] : ["mainhand", "offhand"];
    case "shield": return ["offhand"];
    case "body": return ["chest"];
    case "ring": return [...RINGS];
    case "accessory": {
      const g = keywordGroup(item);
      if (g === "ring") return [...RINGS];
      if (g) return [g];
      return [...RELICS];
    }
    default: return [];
  }
}

function getEquipState(actor) {
  const slots = {};
  const loose = [];
  for (const item of actor.items) {
    if (!getCategory(item) || !item.system?.equipped) continue;
    const s = item.flags?.[NS]?.mq?.slot;
    if (s && SLOT_ICONS[s] && !slots[s]) slots[s] = item;
    else loose.push(item);
  }
  return { slots, loose };
}

/**
 * Decide where an item should go.
 * @returns {{slot: string|null, displace: Item[]}}
 */
function resolveSlot(actor, item, { replace = true, slots } = {}) {
  const occ = { ...(slots ?? getEquipState(actor).slots) };
  for (const [k, v] of Object.entries(occ)) if (v.id === item.id) delete occ[k];

  let cands = candidateSlots(item);
  const pref = item.flags?.[NS]?.mq?.preferred;
  if (pref && allowedSlots(item).includes(pref)) cands = [pref, ...cands.filter(s => s !== pref)];
  if (!cands.length) return { slot: null, displace: [] };

  const twoH = isTwoHanded(item);
  const blockedBy2H = s => s === "offhand" && occ.mainhand && isTwoHanded(occ.mainhand);
  const isFree = s => !occ[s] && !blockedBy2H(s) && !(s === "mainhand" && twoH && occ.offhand);

  const slot = cands.find(isFree) ?? (replace ? cands[0] : null);
  const displace = new Set();
  if (slot) {
    if (occ[slot]) displace.add(occ[slot]);
    if (slot === "mainhand" && twoH && occ.offhand) displace.add(occ.offhand);
    if (blockedBy2H(slot)) displace.add(occ.mainhand);
  }
  return { slot, displace: [...displace] };
}

function notifyRemoved(items) {
  if (!setting("notify")) return;
  for (const i of items) ui.notifications.info(t("notify.removed", { name: i.name }));
}

/** Manual placement (drag & drop on the doll). */
async function equipToSlot(actor, item, slot, { fromSlot = null, bypass = false } = {}) {
  if (!actor.isOwner) return ui.notifications.warn(t("notify.noPermission"));
  if (!getCategory(item)) return ui.notifications.warn(t("notify.notEquippable", { name: item.name }));
  if (!bypass && !allowedSlots(item).includes(slot)) {
    return ui.notifications.warn(t("notify.wrongSlot", { name: item.name, slot: t(`slots.${slot}`) }));
  }
  if (fromSlot === slot && item.system.equipped) return;

  const { slots: occ } = getEquipState(actor);
  for (const [k, v] of Object.entries(occ)) if (v.id === item.id) delete occ[k];

  const updates = [];
  const removed = [];
  const unequip = it => {
    if (!it || updates.some(u => u._id === it.id)) return;
    updates.push({ _id: it.id, "system.equipped": false, [slotPath]: null });
    removed.push(it);
  };

  const occupant = occ[slot];
  if (occupant) {
    if (fromSlot && allowedSlots(occupant).includes(fromSlot)) {
      updates.push({ _id: occupant.id, [slotPath]: fromSlot, [prefPath]: fromSlot });
    } else unequip(occupant);
  }
  if (slot === "mainhand" && isTwoHanded(item) && occ.offhand && occ.offhand !== occupant) unequip(occ.offhand);
  if (slot === "offhand" && occ.mainhand && isTwoHanded(occ.mainhand)) unequip(occ.mainhand);

  updates.push({ _id: item.id, "system.equipped": true, [slotPath]: slot, [prefPath]: slot });
  await actor.updateEmbeddedDocuments("Item", updates, { mannequinTool: { manual: true } });
  notifyRemoved(removed);
}

/** Give a slot to equipped items that have none (first open, old data, etc.). */
async function syncActor(actor) {
  if (!actor.isOwner || !setting("autoAssign")) return;
  const { slots, loose } = getEquipState(actor);
  const occ = { ...slots };
  const updates = [];
  for (const item of loose) {
    const { slot } = resolveSlot(actor, item, { replace: false, slots: occ });
    if (!slot) continue;
    occ[slot] = item;
    updates.push({ _id: item.id, [slotPath]: slot });
  }
  if (updates.length) await actor.updateEmbeddedDocuments("Item", updates, { mannequinTool: { manual: true } });
}

/* -------------------------------------------- */
/*  The Mannequin window                        */
/* -------------------------------------------- */

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const DOLLS = new Map();

class Mannequin extends HandlebarsApplicationMixin(ApplicationV2) {
  constructor({ actor, sheet, ...options } = {}) {
    options.id = `${MOD}-${actor.uuid.replaceAll(".", "-")}`;
    super(options);
    this.actor = actor;
    this.sheet = sheet ?? null;
    this._observer = null;
    this._lastZ = null;
  }

  static DEFAULT_OPTIONS = {
    classes: [MOD],
    tag: "section",
    window: { icon: "fa-solid fa-user-shield", resizable: false, minimizable: true },
    position: { width: 400, height: "auto" },
    actions: {
      openItem: Mannequin.#onOpenItem
    }
  };

  static PARTS = { body: { template: TEMPLATE } };

  get title() {
    return t("title", { name: this.actor.name });
  }

  _itemContext(item) {
    const rich = setting("richTooltips") && game.system.id === "dnd5e";
    const rarity = String(item.system?.rarity ?? "").toLowerCase().replace(/\s+/g, "") || "none";
    return {
      id: item.id,
      name: item.name,
      img: item.img,
      rarity,
      attuned: !!(item.system?.attuned ?? item.system?.attunement === 2),
      rich,
      tooltip: rich
        ? `<section class="loading" data-uuid="${item.uuid}"><i class="fas fa-spinner fa-spin-pulse"></i></section>`
        : item.name
    };
  }

  async _prepareContext() {
    const actor = this.actor;
    const { slots, loose } = getEquipState(actor);
    const mk = key => {
      const item = slots[key];
      const ghost = key === "offhand" && !item && slots.mainhand && isTwoHanded(slots.mainhand) ? slots.mainhand : null;
      return {
        key,
        label: t(`slots.${key}`),
        icon: SLOT_ICONS[key],
        item: item ? this._itemContext(item) : null,
        ghost: ghost ? this._itemContext(ghost) : null
      };
    };

    const attr = actor.system?.attributes ?? {};
    const hp = attr.hp ?? {};
    const hpMax = Number(hp.max ?? hp.effectiveMax ?? 0) || 0;
    const hpVal = Number(hp.value ?? 0) || 0;
    const portrait = setting("portraitSource") === "token"
      ? (actor.token?.texture?.src ?? actor.prototypeToken?.texture?.src ?? actor.img)
      : actor.img;

    return {
      canEdit: actor.isOwner,
      name: actor.name,
      portrait,
      left: LEFT.map(mk),
      right: RIGHT.map(mk),
      weapons: WEAPONS.map(mk),
      relics: RELICS.map(mk),
      loose: loose.map(i => this._itemContext(i)),
      ac: attr.ac?.value ?? "—",
      hp: { value: hpVal, max: hpMax, pct: hpMax ? Math.min(100, Math.max(0, Math.round(hpVal / hpMax * 100))) : 0 },
      attune: attr.attunement ? { value: attr.attunement.value ?? 0, max: attr.attunement.max ?? 3 } : null,
      labels: {
        weapons: t("ui.weapons"),
        relics: t("ui.relics"),
        loose: t("ui.loose"),
        ac: t("ui.ac"),
        hp: t("ui.hp"),
        attune: t("ui.attune"),
        hint: t("ui.hint")
      }
    };
  }

  _onFirstRender(context, options) {
    super._onFirstRender?.(context, options);
    DOLLS.set(this.actor.uuid, this);
    this.attachSheet(this.sheet);
    syncActor(this.actor);
  }

  _onRender(context, options) {
    super._onRender?.(context, options);
    const root = this.element;

    root.querySelectorAll(".hpd-slot").forEach(el => {
      el.addEventListener("contextmenu", ev => this.#onUnequip(ev, el));
      el.addEventListener("dragstart", ev => this.#onDragStart(ev, el));
      el.addEventListener("dragover", ev => { ev.preventDefault(); el.classList.add("drag-over"); });
      el.addEventListener("dragleave", () => el.classList.remove("drag-over"));
      el.addEventListener("drop", ev => { el.classList.remove("drag-over"); this.#onDrop(ev, el.dataset.slot); });
    });
    root.querySelectorAll(".hpd-loose .hpd-chip").forEach(el => {
      el.addEventListener("contextmenu", ev => this.#onUnequip(ev, el));
      el.addEventListener("dragstart", ev => this.#onDragStart(ev, el));
    });
    const portrait = root.querySelector(".hpd-portrait");
    portrait?.addEventListener("dragover", ev => { ev.preventDefault(); portrait.classList.add("drag-over"); });
    portrait?.addEventListener("dragleave", () => portrait.classList.remove("drag-over"));
    portrait?.addEventListener("drop", ev => { portrait.classList.remove("drag-over"); this.#onDrop(ev, null); });

    if (options.isFirstRender) requestAnimationFrame(() => this.reposition());
  }

  _onClose(options) {
    super._onClose?.(options);
    this._observer?.disconnect();
    this._observer = null;
    if (DOLLS.get(this.actor.uuid) === this) DOLLS.delete(this.actor.uuid);
  }

  /* ---------- sheet following ---------- */

  attachSheet(sheet) {
    this._observer?.disconnect();
    this.sheet = sheet ?? null;
    const el = getEl(sheet);
    if (!el) return;
    this._observer = new MutationObserver(() => this.#onSheetMutate());
    this._observer.observe(el, { attributes: true, attributeFilter: ["style", "class"] });
  }

  #onSheetMutate() {
    const el = getEl(this.sheet);
    if (!el || !this.rendered) return;
    const min = el.classList.contains("minimized");
    if (min && !this.minimized) this.minimize();
    else if (!min && this.minimized) this.maximize();
    const z = el.style.zIndex;
    if (z && z !== this._lastZ) {
      this._lastZ = z;
      const mine = Number(this.element?.style.zIndex || 0);
      if (mine < Number(z)) this.bringToFront?.();
    }
    this.reposition();
  }

  reposition() {
    if (!this.rendered || !setting("followSheet")) return;
    const el = getEl(this.sheet);
    if (!el?.isConnected || el.classList.contains("minimized")) return;
    const r = el.getBoundingClientRect();
    const w = this.element?.offsetWidth || this.position.width || 400;
    const gap = 6;
    let left = setting("side") === "right" ? r.right + gap : r.left - w - gap;
    if (left < 0) left = r.right + gap;
    if (left + w > window.innerWidth) left = Math.max(0, r.left - w - gap);
    const top = Math.max(0, Math.round(r.top));
    if (Math.round(this.position.left) === Math.round(left) && Math.round(this.position.top) === top) return;
    this.setPosition({ left: Math.round(left), top });
  }

  /* ---------- interactions ---------- */

  static #onOpenItem(event, target) {
    const item = this.actor.items.get(target.dataset.itemId);
    item?.sheet?.render(true);
  }

  async #onUnequip(event, el) {
    event.preventDefault();
    if (!this.actor.isOwner) return;
    const item = this.actor.items.get(el.dataset.itemId);
    if (!item || el.classList.contains("ghost-only")) return;
    await item.update({ "system.equipped": false });
  }

  #onDragStart(event, el) {
    const item = this.actor.items.get(el.dataset.itemId);
    if (!item) return event.preventDefault();
    const data = { ...item.toDragData(), hibearSlot: el.dataset.slot ?? null };
    event.dataTransfer.setData("text/plain", JSON.stringify(data));
    const img = el.querySelector("img");
    if (img) event.dataTransfer.setDragImage(img, 20, 20);
  }

  async #onDrop(event, slot) {
    event.preventDefault();
    event.stopPropagation();
    const TE = foundry.applications?.ux?.TextEditor?.implementation ?? globalThis.TextEditor;
    const data = TE.getDragEventData(event);
    if (data?.type !== "Item") return;
    if (!this.actor.isOwner) return ui.notifications.warn(t("notify.noPermission"));

    let item = await Item.implementation.fromDropData(data);
    if (!item) return;
    if (!getCategory(item)) return ui.notifications.warn(t("notify.notEquippable", { name: item.name }));

    // Item from a compendium / directory / another actor → copy it onto this actor first
    if (item.parent?.uuid !== this.actor.uuid) {
      const obj = item.toObject();
      foundry.utils.setProperty(obj, "system.equipped", false);
      foundry.utils.setProperty(obj, slotPath, null);
      [item] = await this.actor.createEmbeddedDocuments("Item", [obj]);
      if (!item) return;
    }

    if (!slot) {
      if (item.system.equipped) return;
      const { slot: auto } = resolveSlot(this.actor, item, { replace: setting("replaceOccupied") });
      if (!auto) return ui.notifications.warn(t("notify.noFreeSlot", { name: item.name }));
      slot = auto;
    }
    await equipToSlot(this.actor, item, slot, {
      fromSlot: data.hibearSlot ?? null,
      bypass: event.shiftKey && game.user.isGM
    });
  }
}

/* -------------------------------------------- */
/*  Open / close / toggle                       */
/* -------------------------------------------- */

function openDoll(actor, sheet = null) {
  if (!actor) return null;
  let doll = DOLLS.get(actor.uuid);
  if (doll) {
    if (sheet && doll.sheet !== sheet) doll.attachSheet(sheet);
    doll.render({ force: true });
    doll.reposition();
    return doll;
  }
  doll = new Mannequin({ actor, sheet });
  doll.render({ force: true });
  return doll;
}

function toggleDoll(actor, sheet = null) {
  const doll = DOLLS.get(actor.uuid);
  if (doll?.rendered) return doll.close();
  return openDoll(actor, sheet);
}

function injectHeaderButton(sheet, actor) {
  const el = getEl(sheet);
  const header = el?.querySelector(".window-header");
  if (!header || header.querySelector(".hpd-toggle")) return;
  const isV2 = sheet instanceof ApplicationV2;
  let btn;
  if (isV2) {
    btn = document.createElement("button");
    btn.type = "button";
    btn.className = "header-control icon fa-solid fa-user-shield hpd-toggle";
  } else {
    btn = document.createElement("a");
    btn.className = "header-button control hpd-toggle";
    btn.innerHTML = `<i class="fas fa-user-shield"></i>`;
  }
  btn.dataset.tooltip = t("ui.toggle");
  btn.setAttribute("aria-label", t("ui.toggle"));
  btn.addEventListener("pointerdown", ev => ev.stopPropagation());
  btn.addEventListener("click", ev => {
    ev.preventDefault();
    ev.stopPropagation();
    toggleDoll(actor, sheet);
  });
  const close = header.querySelector('[data-action="close"], .close');
  if (close) header.insertBefore(btn, close);
  else header.appendChild(btn);
}

function onSheetRender(sheet) {
  const actor = sheet.actor ?? sheet.document;
  if (!isSupported(actor)) return;
  injectHeaderButton(sheet, actor);
  if (!sheet[INIT]) {
    sheet[INIT] = true;
    if (setting("autoOpen")) openDoll(actor, sheet);
  } else {
    const doll = DOLLS.get(actor.uuid);
    if (doll && doll.sheet === sheet) doll.reposition();
  }
}

function onSheetClose(sheet) {
  sheet[INIT] = false;
  const actor = sheet.actor ?? sheet.document;
  if (!actor) return;
  const doll = DOLLS.get(actor.uuid);
  if (doll && (doll.sheet === sheet || !doll.sheet)) doll.close();
}

/* -------------------------------------------- */
/*  Hooks                                       */
/* -------------------------------------------- */

const PENDING = new Map(); // item.uuid → {items, time}

Hooks.once("init", () => {
  const reg = (key, data) => game.settings.register(NS, `mq-${key}`, {
    name: `${MOD}.settings.${key}.name`,
    hint: `${MOD}.settings.${key}.hint`,
    config: true,
    ...data
  });

  reg("autoOpen", { scope: "client", type: Boolean, default: true });
  reg("followSheet", { scope: "client", type: Boolean, default: true });
  reg("side", {
    scope: "client", type: String, default: "left",
    choices: { left: `${MOD}.settings.side.left`, right: `${MOD}.settings.side.right` }
  });
  reg("portraitSource", {
    scope: "client", type: String, default: "actor",
    choices: { actor: `${MOD}.settings.portraitSource.actor`, token: `${MOD}.settings.portraitSource.token` },
    onChange: () => DOLLS.forEach(d => d.render())
  });
  reg("richTooltips", { scope: "client", type: Boolean, default: true, onChange: () => DOLLS.forEach(d => d.render()) });
  reg("notify", { scope: "client", type: Boolean, default: true });
  reg("autoAssign", { scope: "world", type: Boolean, default: true });
  reg("replaceOccupied", { scope: "world", type: Boolean, default: true });
  reg("showNpc", { scope: "world", type: Boolean, default: false });

  const loader = foundry.applications?.handlebars?.loadTemplates ?? globalThis.loadTemplates;
  loader([TEMPLATE]);

  Object.assign(api, {
    Mannequin,
    open: (actor = canvas?.tokens?.controlled[0]?.actor ?? game.user.character) => openDoll(actor, actor?.sheet?.rendered ? actor.sheet : null),
    toggle: (actor = canvas?.tokens?.controlled[0]?.actor ?? game.user.character) => actor && toggleDoll(actor, actor.sheet?.rendered ? actor.sheet : null),
    resolveSlot,
    equipToSlot,
    candidateSlots,
    allowedSlots
  });
});

// Sheets (AppV1 and AppV2 variants of the dnd5e character sheet)
Hooks.on("renderActorSheet", app => onSheetRender(app));
Hooks.on("renderActorSheetV2", app => onSheetRender(app));
Hooks.on("closeActorSheet", app => onSheetClose(app));
Hooks.on("closeActorSheetV2", app => onSheetClose(app));

// Equip / unequip → put into or free a slot
Hooks.on("preUpdateItem", (item, changes, options) => {
  if (options?.mannequinTool?.manual) return;
  const actor = item.parent;
  if (!isSupported(actor) || !getCategory(item)) return;
  let eq = foundry.utils.getProperty(changes, "system.equipped");
  if (eq === undefined) eq = changes["system.equipped"];
  if (eq === undefined) return;

  if (!eq) {
    foundry.utils.setProperty(changes, slotPath, null);
    return;
  }
  if (!setting("autoAssign")) return;
  if (item.system?.equipped && SLOT_ICONS[item.flags?.[NS]?.mq?.slot]) return; // already placed
  const { slot, displace } = resolveSlot(actor, item, { replace: setting("replaceOccupied") });
  foundry.utils.setProperty(changes, slotPath, slot);
  if (displace.length) PENDING.set(item.uuid, { items: displace, time: Date.now() });
});

Hooks.on("updateItem", async (item, changes, options, userId) => {
  if (userId !== game.user.id) return;
  const pending = PENDING.get(item.uuid);
  if (pending) {
    PENDING.delete(item.uuid);
    if (Date.now() - pending.time < 10000 && item.system?.equipped) {
      const actor = item.parent;
      const list = pending.items.filter(i => actor.items.has(i.id) && i.id !== item.id);
      if (list.length) {
        await actor.updateEmbeddedDocuments("Item",
          list.map(i => ({ _id: i.id, "system.equipped": false, [slotPath]: null })),
          { mannequinTool: { manual: true } });
        notifyRemoved(list);
      }
    }
  }
});

Hooks.on("preCreateItem", item => {
  const actor = item.parent;
  if (!isSupported(actor) || !getCategory(item)) return;
  if (!item.system?.equipped) {
    if (item.flags?.[NS]?.mq?.slot) item.updateSource({ [slotPath]: null });
    return;
  }
  if (!setting("autoAssign")) return;
  const { slot } = resolveSlot(actor, item, { replace: false });
  item.updateSource({ [slotPath]: slot });
});

// Live refresh
const refresh = foundry.utils.debounce(uuid => {
  const doll = DOLLS.get(uuid);
  if (doll?.rendered) doll.render({ window: { title: doll.title } });
}, 60);
const refreshForItem = item => item?.parent && DOLLS.has(item.parent.uuid) && refresh(item.parent.uuid);
Hooks.on("updateItem", refreshForItem);
Hooks.on("createItem", refreshForItem);
Hooks.on("deleteItem", refreshForItem);
Hooks.on("updateActor", actor => DOLLS.has(actor.uuid) && refresh(actor.uuid));
