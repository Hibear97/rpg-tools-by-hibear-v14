/**
 * D&D Vision 5e Tool — источники света для D&D 5e (дополнение к Vision 5e).
 * Foundry VTT v12–v13, система dnd5e.
 */

import { SUITE_ID } from "../../core/constants.js";
import { createFeatureHooks } from "../../core/feature-hooks.js";

/** Функция «Свет и факелы» внутри RPG-Tools.
 *  Настройки: "rpg-tools-by-hibear.vis-*", флаги: flags["rpg-tools-by-hibear"].vis.* (на предметах и токенах). */
const ID = SUITE_ID;
const Hooks = createFeatureHooks();

/** API для макросов: game.rpgSuite.api.light.light(token.document, "torch") */
export const api = {};

export function setup() {
  Hooks.activate();
}
const HOUR = 3600;
const BADGE = Symbol("dndVision5eToolBadge");

/* -------------------------------------------- */
/*  Источники света (D&D 2024)                  */
/* -------------------------------------------- */

// bright — яркий свет (фт), dim — общий радиус тусклого (яркий + доп. тусклый)
const SOURCES = {
  candle: {
    label: "Свеча", bright: 5, dim: 10, duration: 1 * HOUR, fuel: "self",
    icon: "fa-solid fa-fire-flame-simple",
    color: "#ffb46b", animation: { type: "torch", speed: 3, intensity: 2 },
    match: [/candle/i, /свеч/i]
  },
  torch: {
    label: "Факел", bright: 20, dim: 40, duration: 1 * HOUR, fuel: "self",
    icon: "fa-solid fa-fire-flame-curved",
    color: "#ff8a2a", animation: { type: "flame", speed: 4, intensity: 4 },
    match: [/torch/i, /факел/i]
  },
  lamp: {
    label: "Лампа", bright: 15, dim: 45, duration: 6 * HOUR, fuel: "oil",
    icon: "fa-solid fa-oil-can",
    color: "#ffc070", animation: { type: "torch", speed: 2, intensity: 1 },
    match: [/\blamp\b/i, /лампа/i]
  },
  hooded: {
    label: "Фонарь с колпаком", bright: 30, dim: 60, duration: 6 * HOUR, fuel: "oil",
    icon: "fa-solid fa-lightbulb",
    color: "#ffd08a", animation: { type: "torch", speed: 2, intensity: 1 },
    match: [/hooded/i, /колпак/i, /^lantern$/i, /^фонарь$/i]
  },
  bullseye: {
    label: "Направленный фонарь", bright: 60, dim: 120, angle: 60, duration: 6 * HOUR, fuel: "oil",
    icon: "fa-solid fa-bullseye",
    color: "#ffe2a0", animation: { type: "torch", speed: 1, intensity: 1 },
    match: [/bullseye/i, /направлен/i]
  }
};

// Порядок проверки названий важен: сначала фонари, потом лампа и т.д.
const MATCH_ORDER = ["bullseye", "hooded", "lamp", "torch", "candle"];
const MENU_ORDER = ["torch", "candle", "lamp", "hooded", "bullseye"];
const PHYSICAL_TYPES = new Set(["weapon", "equipment", "consumable", "tool", "loot", "container"]);

/* -------------------------------------------- */
/*  Вспомогательные функции                     */
/* -------------------------------------------- */

const setting = key => game.settings.get(ID, `vis-${key}`);

function qty(item) {
  const q = Number(item?.system?.quantity);
  return Number.isFinite(q) ? q : 1;
}

function sourceOf(item) {
  const forced = item.getFlag?.(ID, "vis.source");
  if (forced && SOURCES[forced]) return forced;
  if (!PHYSICAL_TYPES.has(item.type)) return null;
  const name = item.name.toLowerCase().trim();
  for (const key of MATCH_ORDER) {
    if (SOURCES[key].match.some(r => r.test(name))) return key;
  }
  return null;
}

function isOil(item) {
  if (item.getFlag?.(ID, "vis.oil")) return true;
  if (!PHYSICAL_TYPES.has(item.type)) return false;
  const n = item.name.toLowerCase().trim();
  return /^(a )?(flask of )?(lamp )?oil( \(flask\)|, flask)?$/.test(n)
    || /^(фляга|флакон|бутыль|бутылка|фляжка) (лампового )?масла$/.test(n)
    || /^(ламповое )?масло( \(фляга\)|, фляга)?$/.test(n);
}

function findOil(actor) {
  return actor?.items.find(i => isOil(i) && qty(i) > 0) ?? null;
}

function findSourceItem(actor, key) {
  if (!actor) return null;
  const items = actor.items.filter(i => sourceOf(i) === key);
  return items.find(i => (i.getFlag(ID, "vis.fuel") ?? 0) > 0)
    ?? items.find(i => qty(i) > 0)
    ?? items[0]
    ?? null;
}

/** Можно ли зажечь источник key, и что показать в меню. */
function sourceStatus(actor, key) {
  const s = SOURCES[key];
  const item = findSourceItem(actor, key);
  if (!item) return { ok: false, item: null, text: "нет в инвентаре" };
  const fuel = item.getFlag(ID, "vis.fuel") ?? 0;
  if (fuel > 0) return { ok: true, item, text: `осталось ${fmt(fuel)}` };
  if (!setting("consumeItems")) return { ok: true, item, text: "есть" };
  if (s.fuel === "self") {
    const q = qty(item);
    return q > 0
      ? { ok: true, item, text: `в рюкзаке: ${q} шт.` }
      : { ok: false, item, text: "закончились" };
  }
  if (qty(item) <= 0) return { ok: false, item, text: "нет в инвентаре" };
  const oil = findOil(actor);
  return oil
    ? { ok: true, item, text: `масла: ${qty(oil)} фл.` }
    : { ok: false, item, text: "нет масла" };
}

function fmt(seconds) {
  const totalMin = Math.max(0, Math.ceil(seconds / 60));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h && m) return `${h} ч ${m} мин`;
  if (h) return `${h} ч`;
  return `${m} мин`;
}

function getActive(tokenDoc) {
  return tokenDoc?.getFlag(ID, "vis.active") ?? null;
}

function elapsed(active) {
  switch (setting("timeMode")) {
    case "game": return game.time.worldTime - active.startWorld;
    case "real": return (Date.now() - active.startReal) / 1000;
    default: return 0;
  }
}

function remaining(active) {
  return Math.max(0, active.fuel - elapsed(active));
}

function lightData(s) {
  return {
    bright: s.bright,
    dim: s.dim,
    angle: s.angle ?? 360,
    color: s.color,
    alpha: 0.35,
    attenuation: 0.5,
    luminosity: 0.5,
    coloration: 1,
    animation: { ...s.animation, reverse: false }
  };
}

async function chat(tokenDoc, text) {
  if (!setting("chatMessages")) return;
  await ChatMessage.create({
    content: `<p>${text}</p>`,
    speaker: ChatMessage.getSpeaker({ token: tokenDoc })
  });
}

function rerenderHUD(token) {
  const hud = canvas.tokens?.hud;
  if (hud?.object === token && hud.rendered) hud.render();
}

/* -------------------------------------------- */
/*  Зажечь / потушить                           */
/* -------------------------------------------- */

async function light(tokenDoc, key) {
  const s = SOURCES[key];
  if (!s) throw new Error(`${ID} | неизвестный источник: ${key}`);
  const actor = tokenDoc.actor;
  const free = game.user.isGM || !setting("requireItem");
  const st = sourceStatus(actor, key);

  if (!st.ok && !free) {
    ui.notifications.warn(`${s.label}: ${st.text}.`);
    return false;
  }

  if (getActive(tokenDoc)) await extinguish(tokenDoc, { silent: true });

  let fuel = s.duration;
  let itemId = null;

  if (st.ok && st.item) {
    const item = st.item;
    itemId = item.id;
    const stored = item.getFlag(ID, "vis.fuel") ?? 0;
    const update = { [`flags.${ID}.vis.fuel`]: 0 };
    if (stored > 0) {
      fuel = stored;
    } else if (setting("consumeItems")) {
      if (s.fuel === "self") update["system.quantity"] = Math.max(0, qty(item) - 1);
      else {
        const oil = findOil(actor);
        if (oil) await oil.update({ "system.quantity": Math.max(0, qty(oil) - 1) });
      }
    }
    await item.update(update);
  }

  const saved = foundry.utils.deepClone(tokenDoc._source.light);
  await tokenDoc.update({
    light: lightData(s),
    [`flags.${ID}.vis.active`]: {
      key, itemId, fuel,
      startWorld: game.time.worldTime,
      startReal: Date.now()
    },
    [`flags.${ID}.vis.saved`]: saved
  });

  const extra = s.dim - s.bright;
  const shape = s.angle ? `конус ${s.bright} фт` : `${s.bright} фт`;
  await chat(tokenDoc, `<b>${tokenDoc.name}</b> зажигает: <b>${s.label.toLowerCase()}</b> `
    + `(яркий свет ${shape}, тусклый ещё +${extra} фт; гореть будет ${fmt(fuel)}).`);
  return true;
}

const pending = new Set();

async function extinguish(tokenDoc, { burnedOut = false, silent = false } = {}) {
  const active = getActive(tokenDoc);
  if (!active || pending.has(tokenDoc.uuid)) return false;
  pending.add(tokenDoc.uuid);
  try {
    const s = SOURCES[active.key];
    const left = burnedOut ? 0 : remaining(active);
    const saved = tokenDoc.getFlag(ID, "vis.saved");
    const update = {
      [`flags.${ID}.vis.-=active`]: null,
      [`flags.${ID}.vis.-=saved`]: null
    };
    if (saved) update.light = saved;
    else update.light = { bright: 0, dim: 0, angle: 360, animation: { type: null } };
    await tokenDoc.update(update);

    const item = active.itemId ? tokenDoc.actor?.items.get(active.itemId) : null;
    if (item) await item.setFlag(ID, "vis.fuel", Math.floor(left));

    if (!silent) {
      if (burnedOut) await chat(tokenDoc, `У <b>${tokenDoc.name}</b> догорел источник света: ${s?.label.toLowerCase() ?? "свет"}.`);
      else await chat(tokenDoc, `<b>${tokenDoc.name}</b> гасит: ${s?.label.toLowerCase() ?? "свет"} (осталось ${fmt(left)}).`);
    }
    return true;
  } finally {
    pending.delete(tokenDoc.uuid);
  }
}

/** Проверка догоревших источников — выполняет только активный ГМ. */
function checkExpired() {
  if (!game.users.activeGM?.isSelf) return;
  if (setting("timeMode") === "none") return;
  for (const scene of game.scenes) {
    for (const tokenDoc of scene.tokens) {
      const active = getActive(tokenDoc);
      if (active && remaining(active) <= 0) extinguish(tokenDoc, { burnedOut: true });
    }
  }
}

/* -------------------------------------------- */
/*  Меню выбора                                 */
/* -------------------------------------------- */

async function openMenu(token) {
  const tokenDoc = token.document;
  const actor = tokenDoc.actor;
  const active = getActive(tokenDoc);
  const free = game.user.isGM || !setting("requireItem");
  const buttons = [];

  if (active) {
    buttons.push({
      action: "off",
      label: `Потушить: ${SOURCES[active.key]?.label ?? "свет"} (осталось ${fmt(remaining(active))})`,
      icon: "fa-solid fa-wind"
    });
  }

  for (const key of MENU_ORDER) {
    const s = SOURCES[key];
    const st = sourceStatus(actor, key);
    if (!st.ok && !free) continue;
    const note = st.ok ? st.text : `${st.text} — без расхода`;
    buttons.push({ action: key, label: `${s.label} — ${note}`, icon: s.icon });
  }

  const hasChoices = buttons.length > 0;
  buttons.push({ action: "cancel", label: "Отмена", icon: "fa-solid fa-xmark" });

  const content = hasChoices
    ? `<p class="torchlight-info">Что достаёт <b>${tokenDoc.name}</b>?</p>`
    : `<p class="torchlight-info">В инвентаре <b>${tokenDoc.name}</b> нет источников света `
      + `(факела, свечи, лампы или фонаря) или для них нет масла.</p>`;

  const result = await foundry.applications.api.DialogV2.wait({
    window: { title: "Источник света", icon: "fa-solid fa-fire-flame-curved" },
    classes: ["torchlight-dialog"],
    content,
    buttons,
    rejectClose: false
  });

  if (!result || result === "cancel") return;
  if (result === "off") await extinguish(tokenDoc);
  else await light(tokenDoc, result);
  rerenderHUD(token);
}

/* -------------------------------------------- */
/*  Анимированный значок у токена               */
/* -------------------------------------------- */

function teardrop(g, w, h, sway) {
  g.moveTo(0, 0);
  g.bezierCurveTo(-w * 1.4, -h * 0.05, -w * 0.7 + sway * 0.4, -h * 0.6, sway, -h);
  g.bezierCurveTo(w * 0.7 + sway * 0.4, -h * 0.6, w * 1.4, -h * 0.05, 0, 0);
}

const FLAME_LAYERS = [
  [0xff5a00, 0.9, 1],
  [0xffa000, 0.95, 0.72],
  [0xfff2a8, 1, 0.42]
];

class LightBadge extends PIXI.Container {
  constructor(key) {
    super();
    this.key = key;
    this.eventMode = "none";
    this.t = Math.random() * 10;
    this.particles = [];

    // Позиция и масштаб пламени для каждого предмета
    this.flamePos = {
      torch: { x: 0, y: -12, k: 1, embers: true },
      candle: { x: 0, y: -9, k: 0.6, embers: false },
      lamp: { x: 34, y: 4, k: 0.6, embers: false },
      hooded: { x: 0, y: 10, k: 0.55, embers: false },
      bullseye: null
    }[key];

    this.bg = this.addChild(new PIXI.Graphics());
    this.glow = this.addChild(new PIXI.Graphics());
    this.beam = this.addChild(new PIXI.Graphics());
    this.body = this.addChild(new PIXI.Graphics());
    this.flame = this.addChild(new PIXI.Graphics());
    this.front = this.addChild(new PIXI.Graphics());
    this.sparks = this.addChild(new PIXI.Graphics());

    this.drawStatic();
    this._tick = () => this.animate(Math.min(0.1, (canvas.app?.ticker.deltaMS ?? 16) / 1000));
    canvas.app.ticker.add(this._tick);
    this.animate(0);
  }

  destroy(options) {
    canvas.app?.ticker.remove(this._tick);
    super.destroy(options);
  }

  drawStatic() {
    const bg = this.bg;
    bg.lineStyle(4, 0xffa94d, 0.9);
    bg.beginFill(0x1b130c, 0.75);
    bg.drawCircle(0, 0, 50);
    bg.endFill();

    const g = this.body;
    const f = this.front;
    switch (this.key) {
      case "torch":
        g.beginFill(0x7a4a22).drawRoundedRect(-5, -6, 10, 46, 3).endFill();
        g.beginFill(0x4a3020).drawRoundedRect(-8, -14, 16, 13, 3).endFill();
        g.lineStyle(1.5, 0x2a1a10);
        g.moveTo(-8, -10).lineTo(8, -7);
        g.moveTo(-8, -5).lineTo(8, -2);
        break;
      case "candle":
        g.beginFill(0xb08d57).drawEllipse(0, 38, 24, 6).endFill();
        g.beginFill(0xf3ead2).drawRoundedRect(-8, -6, 16, 44, 3).endFill();
        g.beginFill(0xffffff, 0.5).drawRect(-5, -4, 3, 38).endFill();
        g.lineStyle(2, 0x222222).moveTo(0, -6).lineTo(0, -10);
        break;
      case "lamp":
        g.beginFill(0xc9962c).drawPolygon([16, 14, 34, 4, 38, 9, 22, 26]).endFill();
        g.beginFill(0xd8a63a).drawEllipse(-2, 22, 28, 13).endFill();
        g.beginFill(0xa77a20).drawRect(-12, 32, 22, 6).endFill();
        g.lineStyle(4, 0xa77a20);
        g.moveTo(-28, 16).bezierCurveTo(-44, 14, -44, 32, -26, 28);
        break;
      case "hooded":
        g.lineStyle(3, 0x666666).drawCircle(0, -36, 6);
        g.lineStyle(0);
        g.beginFill(0x3a3a3a).drawPolygon([-16, -24, 16, -24, 10, -31, -10, -31]).endFill();
        g.beginFill(0xffd27a, 0.3).drawRect(-14, -24, 28, 44).endFill();
        f.lineStyle(3, 0x3a3a3a).drawRect(-14, -24, 28, 44);
        f.lineStyle(0).beginFill(0x3a3a3a).drawRect(-17, 20, 34, 8).endFill();
        break;
      case "bullseye":
        g.beginFill(0x8a6a3a).drawRect(-30, -12, 40, 26).endFill();
        g.beginFill(0x6a4f2a).drawRect(-35, -15, 7, 32).endFill();
        g.beginFill(0x6a4f2a).drawRect(-18, -22, 10, 10).endFill();
        g.lineStyle(2, 0x6a4f2a).moveTo(-26, -12).bezierCurveTo(-26, -34, 2, -34, 2, -12);
        g.lineStyle(0).beginFill(0xfff1b0).drawEllipse(12, 1, 6, 14).endFill();
        break;
    }
  }

  animate(dt) {
    this.t += dt;
    const t = this.t;
    const flick = 1 + 0.12 * Math.sin(t * 13) + 0.07 * Math.sin(t * 29 + 1.3) + 0.05 * (Math.random() - 0.5);
    const sway = 3 * Math.sin(t * 6) + 1.5 * Math.sin(t * 17);
    const p = this.flamePos;

    // Свечение
    const glow = this.glow;
    glow.clear();
    if (p) {
      glow.beginFill(0xffa040, 0.16 * flick).drawCircle(p.x, p.y - 12 * p.k, 34 * p.k * flick).endFill();
      glow.beginFill(0xffc070, 0.12 * flick).drawCircle(p.x, p.y - 10 * p.k, 22 * p.k * flick).endFill();
    } else {
      glow.beginFill(0xffd080, 0.12 * flick).drawCircle(10, 0, 26 * flick).endFill();
    }

    // Луч направленного фонаря
    const beam = this.beam;
    beam.clear();
    if (this.key === "bullseye") {
      beam.beginFill(0xffe9a0, 0.22 + 0.1 * Math.sin(t * 4) + 0.04 * (Math.random() - 0.5));
      beam.drawPolygon([14, -10, 14, 12, 48, 30, 48, -28]);
      beam.endFill();
    }

    // Пламя
    const fl = this.flame;
    fl.clear();
    if (p) {
      fl.position.set(p.x, p.y);
      fl.scale.set(p.k);
      for (const [color, alpha, k] of FLAME_LAYERS) {
        fl.beginFill(color, alpha);
        teardrop(fl, 13 * k, 34 * k * flick, sway * k);
        fl.endFill();
      }
    }

    // Искры факела
    const sp = this.sparks;
    sp.clear();
    if (p?.embers) {
      if (Math.random() < dt * 6) {
        this.particles.push({
          x: p.x + (Math.random() * 8 - 4), y: p.y - 18,
          vx: (Math.random() - 0.5) * 14, vy: -(25 + Math.random() * 25),
          life: 0, max: 0.6 + Math.random() * 0.7
        });
      }
      this.particles = this.particles.filter(e => {
        e.life += dt;
        e.x += e.vx * dt + Math.sin((t + e.max) * 9) * 0.3;
        e.y += e.vy * dt;
        if (e.life >= e.max || Math.hypot(e.x, e.y) > 46) return false;
        sp.beginFill(0xffc060, 1 - e.life / e.max).drawCircle(e.x, e.y, 1.6).endFill();
        return true;
      });
    }
  }
}

function syncBadge(token) {
  if (!token || token.destroyed || !canvas.ready) return;
  const active = getActive(token.document);
  const want = active && setting("showIcon") ? active.key : null;
  let badge = token[BADGE];

  if (badge && (badge.destroyed || badge.key !== want)) {
    if (!badge.destroyed) badge.destroy({ children: true });
    badge = token[BADGE] = null;
  }
  if (!want) return;
  if (!badge) badge = token[BADGE] = token.addChild(new LightBadge(want));

  const size = Math.min(token.w, token.h) * setting("iconScale");
  badge.scale.set(size / 100);
  badge.position.set(token.w - size * 0.3, size * 0.3);
}

function syncAllBadges() {
  for (const t of canvas.tokens?.placeables ?? []) syncBadge(t);
}

/* -------------------------------------------- */
/*  Хуки                                        */
/* -------------------------------------------- */

Hooks.once("init", () => {
  game.settings.register(ID, "vis-timeMode", {
    name: "Свет и факелы · Отсчёт времени горения",
    hint: "Игровое время двигается, когда ГМ или модули-календари продвигают время мира. "
      + "Реальное — по часам. «Не учитывать» — свет горит, пока его не потушат.",
    scope: "world", config: true, type: String, default: "game",
    choices: {
      game: "Игровое время",
      real: "Реальное время",
      none: "Не учитывать"
    }
  });
  game.settings.register(ID, "vis-consumeItems", {
    name: "Свет и факелы · Расходовать факелы, свечи и масло",
    hint: "При зажигании новой штуки отнимается 1 факел/свеча или 1 фляга масла для ламп и фонарей. "
      + "Недогоревший остаток запоминается на предмете.",
    scope: "world", config: true, type: Boolean, default: true
  });
  game.settings.register(ID, "vis-requireItem", {
    name: "Свет и факелы · Требовать предмет в инвентаре",
    hint: "Если выключено, игроки могут зажигать свет без предметов. ГМ может всегда.",
    scope: "world", config: true, type: Boolean, default: true
  });
  game.settings.register(ID, "vis-chatMessages", {
    name: "Свет и факелы · Сообщения в чат",
    scope: "world", config: true, type: Boolean, default: true
  });
  game.settings.register(ID, "vis-showIcon", {
    name: "Свет и факелы · Показывать значок источника у токена",
    scope: "client", config: true, type: Boolean, default: true,
    onChange: () => syncAllBadges()
  });
  game.settings.register(ID, "vis-iconScale", {
    name: "Свет и факелы · Размер значка (доля от размера токена)",
    scope: "client", config: true, type: Number, default: 0.4,
    range: { min: 0.2, max: 0.8, step: 0.05 },
    onChange: () => syncAllBadges()
  });

  game.keybindings.register(ID, "vis-toggle", {
    name: "Свет и факелы · Источник света: открыть меню / потушить",
    hint: "Для выделенного токена: если свет горит — тушит, иначе открывает меню.",
    editable: [{ key: "KeyL", modifiers: ["Shift"] }],
    onDown: () => {
      const token = canvas.tokens?.controlled[0];
      if (!token?.isOwner) return false;
      if (getActive(token.document)) extinguish(token.document).then(() => rerenderHUD(token));
      else openMenu(token);
      return true;
    }
  });
});

Hooks.once("ready", () => {
  Object.assign(api, { SOURCES, light, extinguish, openMenu, getActive, remaining });
  if (!game.modules.get("vision-5e")?.active && game.user.isGM) {
    ui.notifications.warn("RPG-Tools · Свет и факелы: модуль Vision 5e не включён — зрение и обнаружение работать не будут.");
  }
  Hooks.on("updateWorldTime", () => checkExpired());
  setInterval(checkExpired, 15000);
  checkExpired();
});

Hooks.on("renderTokenHUD", (hud, html) => {
  const root = html instanceof HTMLElement ? html : html?.[0];
  const col = root?.querySelector(".col.left");
  const token = hud.object;
  if (!col || !token?.isOwner) return;

  const active = getActive(token.document);
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `control-icon torchlight-hud${active ? " active" : ""}`;
  btn.dataset.tooltip = active
    ? `${SOURCES[active.key]?.label}: осталось ${fmt(remaining(active))} (ПКМ — потушить)`
    : "Достать источник света";
  btn.innerHTML = `<i class="fa-solid fa-fire-flame-curved"></i>`;
  btn.addEventListener("click", ev => {
    ev.preventDefault();
    ev.stopPropagation();
    openMenu(token);
  });
  btn.addEventListener("contextmenu", ev => {
    ev.preventDefault();
    ev.stopPropagation();
    if (getActive(token.document)) extinguish(token.document).then(() => rerenderHUD(token));
  });
  col.append(btn);
});

Hooks.on("drawToken", token => syncBadge(token));
Hooks.on("refreshToken", token => syncBadge(token));
Hooks.on("updateToken", (doc, changes) => {
  if (foundry.utils.hasProperty(changes, `flags.${ID}.vis`) || foundry.utils.hasProperty(changes, `flags.${ID}.-=vis`)) {
    syncBadge(doc.object);
  }
});
Hooks.on("canvasReady", () => syncAllBadges());
