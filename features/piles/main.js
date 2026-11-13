/**
 * Piles tool — сундуки, кучи лута, торговцы и обмен для D&D 5e (Foundry VTT v13).
 */
import { MODULE_ID, setting, initSocket, playerActor, inRange, ownerUserOf, gmTry } from "./core.js";
import { registerSettings, SettingsApp } from "./settings.js";
import { patchGoldPrices, formatCp, walletCp, itemPriceCp } from "./currency.js";
import {
  registerContainerHandlers, interactTile, isContainer, cfgOf, ContainerApp, ContainerConfigApp, tileRect,
  createChestAtCenter, tokenToPile, onDropCanvas
} from "./containers.js";
import { registerMerchantHandlers, isMerchant, MerchantApp, MerchantConfigApp, makeMerchant } from "./merchant.js";
import { registerTradeHandlers, requestTrade, pickPartner } from "./trade.js";
import { createFeatureHooks } from "../../core/feature-hooks.js";

const Hooks = createFeatureHooks();

/** API для макросов: game.rpgSuite.api.piles (и по-старому game.pilesTool) */
export const api = {};

export function setup() {
  Hooks.activate();
}

Hooks.once("init", () => {
  registerSettings();
  patchGoldPrices();
});

Hooks.once("ready", () => {
  initSocket();
  registerContainerHandlers();
  registerMerchantHandlers();
  registerTradeHandlers();

  Object.assign(api, {
    openSettings: () => new SettingsApp().render(true),
    openContainer: (tile) => ContainerApp.open(tile.document ?? tile),
    configureContainer: (tile) => new ContainerConfigApp(tile.document ?? tile).render(true),
    openMerchant: (merchant, buyer) => MerchantApp.open(merchant, buyer ?? playerActor()),
    makeMerchant,
    tokenToPile: (token) => tokenToPile(token.document ?? token),
    trade: (actor) => (actor ? requestTrade(actor) : pickPartner()),
    formatPrice: formatCp, wallet: walletCp, itemPrice: itemPriceCp,
    // для функции «Взлом замков»: найти запертые сундуки рядом и открыть их окно вскрытия
    isContainer: (tileDoc) => isContainer(tileDoc),
    isLockedContainer: (tileDoc) => isContainer(tileDoc) && cfgOf(tileDoc).state === "locked",
    interact: (tileDoc) => interactTile(tileDoc.document ?? tileDoc)
  });
  game.pilesTool = api;
});

/* -------------------------------------------- */
/*  ПКМ по карте                                 */
/* -------------------------------------------- */

let attached = false;
Hooks.on("canvasReady", () => {
  const view = canvas.app?.view ?? canvas.app?.canvas;
  if (!view || attached) return;
  attached = true;
  let down = null;
  view.addEventListener("pointerdown", (e) => { if (e.button === 2) down = { x: e.clientX, y: e.clientY }; });
  view.addEventListener("pointerup", (e) => {
    if (e.button !== 2 || !down) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6;
    down = null;
    if (!moved) onRightClick(e).catch((err) => console.error(MODULE_ID, err));
  });
});

function toCanvas(e) {
  if (canvas.canvasCoordinatesFromClient) return canvas.canvasCoordinatesFromClient({ x: e.clientX, y: e.clientY });
  return canvas.stage.worldTransform.applyInverse(new PIXI.Point(e.clientX, e.clientY));
}

const contains = (d, p) => { const r = tileRect(d); return p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height; };

async function onRightClick(e) {
  if (!canvas.ready || !canvas.tokens?.active) return;
  const p = toCanvas(e);

  const tokens = canvas.tokens.placeables
    .filter((t) => t.visible && !(t.document.hidden && !game.user.isGM) && t.bounds?.contains(p.x, p.y))
    .sort((a, b) => (b.document.elevation - a.document.elevation) || (b.document.sort - a.document.sort));
  const top = tokens[0];

  if (top) {
    if (game.user.isGM || top.actor?.isOwner) return; // обычный HUD токена
    const actor = top.actor;
    if (isMerchant(actor)) {
      if (!inRange(top.bounds, null)) return;
      return MerchantApp.open(actor, playerActor());
    }
    if (actor?.type === "character" && ownerUserOf(actor) && setting("tradeEnabled")) return requestTrade(actor);
  }

  const tiles = canvas.tiles.placeables
    .filter((t) => isContainer(t.document) && (game.user.isGM || !t.document.hidden) && contains(t.document, p))
    .sort((a, b) => (b.document.elevation - a.document.elevation) || (b.document.sort - a.document.sort));
  if (tiles[0]) return interactTile(tiles[0].document);
}

/* -------------------------------------------- */
/*  Бросок предмета на карту                     */
/* -------------------------------------------- */

Hooks.on("dropCanvasData", (cnv, data) => onDropCanvas(cnv, data));

/* -------------------------------------------- */
/*  Обновление открытых окон                      */
/* -------------------------------------------- */

Hooks.on("updateTile", (doc) => ContainerApp.refresh(doc));
Hooks.on("deleteTile", (doc) => ContainerApp.instances.get(doc.uuid)?.close());
Hooks.on("updateActor", (a) => MerchantApp.refreshFor(a));
for (const h of ["createItem", "updateItem", "deleteItem"]) Hooks.on(h, (item) => MerchantApp.refreshFor(item.parent));

/* -------------------------------------------- */
/*  HUD тайла и токена (мастер)                   */
/* -------------------------------------------- */

function hudButton(icon, tooltip, onClick, active = false) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `control-icon rpp-hud ${active ? "active" : ""}`;
  b.dataset.tooltip = tooltip;
  b.innerHTML = `<i class="${icon}"></i>`;
  b.addEventListener("click", (ev) => { ev.preventDefault(); ev.stopPropagation(); onClick(); });
  return b;
}
const asEl = (html) => (html instanceof HTMLElement ? html : html?.[0]);

Hooks.on("renderTileHUD", (hud, html) => {
  if (!game.user.isGM) return;
  const col = asEl(html)?.querySelector(".col.right");
  if (!col) return;
  const doc = hud.document ?? hud.object?.document;
  const on = isContainer(doc);
  col.append(hudButton("fa-solid fa-box", on ? "Настроить контейнер" : "Сделать контейнером", () => new ContainerConfigApp(doc).render(true), on));
  if (on) {
    col.append(hudButton("fa-solid fa-box-open", "Содержимое", () => ContainerApp.open(doc)));
    if (cfgOf(doc).kind !== "pile") {
      const locked = cfgOf(doc).state === "locked";
      col.append(hudButton(locked ? "fa-solid fa-lock" : "fa-solid fa-lock-open", locked ? "Отпереть" : "Запереть",
        async () => { await gmTry("ctState", { tile: doc.uuid, state: locked ? "closed" : "locked" }); hud.render(); }, locked));
    }
  }
});

Hooks.on("renderTokenHUD", (hud, html) => {
  if (!game.user.isGM) return;
  const col = asEl(html)?.querySelector(".col.right");
  const doc = hud.document ?? hud.object?.document;
  const actor = doc?.actor;
  if (!col || !actor || actor.type === "character" && actor.hasPlayerOwner) return;
  const m = isMerchant(actor);
  col.append(hudButton("fa-solid fa-store", m ? "Лавка (ПКМ — настройка)" : "Сделать торговцем",
    () => (m ? MerchantApp.open(actor, playerActor()) : makeMerchant(actor)), m));
  if (m) col.lastElementChild.addEventListener("contextmenu", (ev) => { ev.preventDefault(); new MerchantConfigApp(actor).render(true); });
  col.append(hudButton("fa-solid fa-sack", "Превратить в кучу лута", () => tokenToPile(doc)));
});

/* -------------------------------------------- */
/*  Панель инструментов                          */
/* -------------------------------------------- */

Hooks.on("getSceneControlButtons", (controls) => {
  const add = (group, tool) => {
    const g = controls[group] ?? (Array.isArray(controls) ? controls.find((c) => c.name === group) : null);
    if (!g) return;
    if (Array.isArray(g.tools)) g.tools.push(tool);
    else g.tools[tool.name] = tool;
  };
  if (game.user.isGM) {
    add("tiles", {
      name: "pilesToolChest", title: "Поставить сундук", icon: "fa-solid fa-box", order: 90,
      button: true, visible: true, onChange: () => createChestAtCenter()
    });
  } else {
    add("tokens", {
      name: "pilesToolTrade", title: "Обмен с игроком", icon: "fa-solid fa-handshake", order: 90,
      button: true, visible: true, onChange: () => pickPartner()
    });
  }
});

/* -------------------------------------------- */
/*  Контекстное меню актёров в сайдбаре           */
/* -------------------------------------------- */

function actorMenu(app, options) {
  const idOf = (li) => {
    const el = li instanceof HTMLElement ? li : li?.[0];
    return el?.dataset?.entryId ?? el?.dataset?.documentId;
  };
  options.push({
    name: "Сделать торговцем",
    icon: `<i class="fa-solid fa-store"></i>`,
    condition: () => game.user.isGM,
    callback: (li) => { const a = game.actors.get(idOf(li)); if (a) makeMerchant(a); }
  });
}
Hooks.on("getActorContextOptions", actorMenu);
Hooks.on("getActorDirectoryEntryContext", actorMenu);
