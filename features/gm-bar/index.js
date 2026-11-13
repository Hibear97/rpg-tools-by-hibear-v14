import { SUITE_ID } from "../../core/constants.js";
import { createFeatureHooks } from "../../core/feature-hooks.js";

/**
 * Функция «Панель мастера» — свободная панель ячеек только для ГМа.
 *
 *  - отдельное окно поверх сцены, его можно перетаскивать, сворачивать и закреплять;
 *  - сетка ячеек настраивается: строки × столбцы (по умолчанию 2 × 6 = 12) и число страниц;
 *  - в ячейки перетаскиваются макросы, способности и предметы (в том числе с листов монстров),
 *    активности dnd5e, таблицы, журналы, персонажи, сцены, плейлисты и звуки;
 *  - панель не зависит от выбранного токена и от UI-интерфейса: способность монстра в ячейке
 *    всегда применяется от этого монстра, какой бы токен ни был выделен;
 *  - содержимое хранится у пользователя-мастера (flags.rpg-tools-by-hibear.gmb.pages), поэтому одинаково
 *    в любом браузере; положение окна и размеры — в настройках этого компьютера.
 *
 * Настройки: "rpg-tools-by-hibear.gmb-*".
 */
const MOD = SUITE_ID;
const SK = (k) => `gmb-${k}`;
const FLAG = "gmb.pages";
const Hooks = createFeatureHooks();

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const setting = (k) => game.settings.get(MOD, SK(k));
const setSetting = (k, v) => game.settings.set(MOD, SK(k), v);

const state = {
  el: null,
  page: 0,
  menu: null,
  saveTimer: null
};

/** API для макросов: game.rpgSuite.api.gmbar.toggle() */
export const api = {
  toggle: () => toggle(),
  show: () => toggle(true),
  hide: () => toggle(false),
  setPage: (n) => setPage(n)
};

export function setup() {
  registerSettings();
  Hooks.activate();
}

/* ------------------------------------------------------------------ */
/*  Настройки                                                          */
/* ------------------------------------------------------------------ */

function registerSettings() {
  // manager: true — показывать в центре управления; gmOnly — только мастеру. В стандартном окне настроек Foundry не видны.
  const reg = (key, data) => game.settings.register(MOD, SK(key), {
    scope: "client", config: false, manager: true, gmOnly: true,
    ...data, onChange: data.onChange ?? (() => render())
  });
  reg("rows", {
    name: "Строк", hint: "Сколько рядов ячеек на одной странице.",
    type: Number, default: 2, range: { min: 1, max: 6, step: 1 }
  });
  reg("cols", {
    name: "Ячеек в ряду", hint: "Сколько ячеек в одном ряду. 2 ряда × 6 ячеек = 12 ячеек на странице.",
    type: Number, default: 6, range: { min: 1, max: 12, step: 1 }
  });
  reg("pages", {
    name: "Страниц", hint: "Сколько страниц можно перелистывать (стрелками в заголовке или колесом мыши над панелью).",
    type: Number, default: 5, range: { min: 1, max: 10, step: 1 }
  });
  reg("slotSize", {
    name: "Размер ячейки (px)", hint: "Размер одной ячейки панели.",
    type: Number, default: 48, range: { min: 32, max: 80, step: 2 }
  });
  reg("opacity", {
    name: "Прозрачность фона", hint: "Насколько плотный фон у панели (ячейки остаются непрозрачными).",
    type: Number, default: 0.9, range: { min: 0.3, max: 1, step: 0.05 }
  });
  reg("showLabels", {
    name: "Подписи под ячейками", hint: "Показывать короткое название под каждой ячейкой.",
    type: Boolean, default: false
  });
  reg("visible", { name: "Показывать панель", type: Boolean, default: true, manager: false, onChange: () => render() });
  reg("collapsed", { type: Boolean, default: false, manager: false, onChange: () => {} });
  reg("locked", { type: Boolean, default: false, manager: false, onChange: () => {} });
  reg("position", { type: Object, default: {}, manager: false, onChange: () => {} });
  reg("page", { type: Number, default: 0, manager: false, onChange: () => {} });

  game.keybindings.register(MOD, "gmb-toggle", {
    name: "Панель мастера: показать / скрыть",
    editable: [{ key: "KeyG", modifiers: ["Shift"] }],
    restricted: true,
    onDown: () => { toggle(); return true; }
  });
}

/* ------------------------------------------------------------------ */
/*  Хуки                                                               */
/* ------------------------------------------------------------------ */

Hooks.once("ready", () => {
  if (!game.user.isGM) return;
  state.page = Math.min(setting("page") ?? 0, setting("pages") - 1);
  render();
  window.addEventListener("resize", () => clampToScreen());
});

// Кнопка на левой панели инструментов (только у мастера)
Hooks.on("getSceneControlButtons", (controls) => {
  if (!game.user?.isGM) return;
  const tokens = controls.tokens ?? controls.token;
  if (!tokens?.tools) return;
  tokens.tools.rpgtGmBar = {
    name: "rpgtGmBar",
    title: "Панель мастера (Shift+G)",
    icon: "fa-solid fa-toolbox",
    order: 901,
    button: true,
    visible: true,
    onChange: () => toggle()
  };
});

// Перерисовать ячейки, когда меняются документы в них (название, картинка, заряды)
const refreshSoon = foundry.utils.debounce(() => renderSlots(), 150);
for (const hook of ["updateMacro", "deleteMacro", "updateItem", "deleteItem", "updateActor", "deleteActor",
  "updateRollTable", "updateJournalEntry", "updateScene", "updatePlaylist", "updatePlaylistSound"]) {
  Hooks.on(hook, () => { if (state.el) refreshSoon(); });
}
Hooks.on("updateUser", (user, changes) => {
  if (user.id === game.user.id && foundry.utils.hasProperty(changes, `flags.${MOD}.gmb`) && state.el) renderSlots();
});

/* ------------------------------------------------------------------ */
/*  Данные                                                             */
/* ------------------------------------------------------------------ */

const perPage = () => Math.max(1, setting("rows") * setting("cols"));

function allPages() {
  const raw = game.user.getFlag(MOD, FLAG);
  return Array.isArray(raw) ? raw.map((p) => (Array.isArray(p) ? p : [])) : [];
}

function getSlot(page, index) {
  return allPages()[page]?.[index] ?? null;
}

async function setSlot(page, index, value) {
  const pages = allPages();
  while (pages.length <= page) pages.push([]);
  const arr = pages[page];
  while (arr.length <= index) arr.push(null);
  arr[index] = value;
  await game.user.setFlag(MOD, FLAG, pages);
}

async function swapSlots(a, b) {
  const pages = allPages();
  for (const { page, index } of [a, b]) {
    while (pages.length <= page) pages.push([]);
    while (pages[page].length <= index) pages[page].push(null);
  }
  const tmp = pages[a.page][a.index] ?? null;
  pages[a.page][a.index] = pages[b.page][b.index] ?? null;
  pages[b.page][b.index] = tmp;
  await game.user.setFlag(MOD, FLAG, pages);
}

/** Данные перетаскивания → запись ячейки { uuid, type, name, img } */
async function entryFromDrop(data) {
  if (!data) return null;
  let uuid = data.uuid;
  if (!uuid && data.type && data.id) uuid = `${data.type}.${data.id}`;
  if (!uuid) return null;
  const doc = await fromUuid(uuid).catch(() => null);
  if (!doc) return null;
  const type = data.type === "Activity" || doc.documentName === "Activity" || doc.constructor?.name?.endsWith?.("Activity")
    ? "Activity" : (doc.documentName ?? data.type);
  const item = type === "Activity" ? doc.item : null;
  const actor = type === "Activity" ? doc.actor : doc.actor ?? doc.parent?.actor ?? null;
  const name = type === "Activity" ? `${item?.name ?? ""}: ${doc.name}` : doc.name;
  const img = doc.img ?? item?.img ?? doc.thumb ?? doc.texture?.src ?? "icons/svg/book.svg";
  return { uuid, type, name, img, actor: actor?.name ?? null };
}

/* ------------------------------------------------------------------ */
/*  Действие ячейки                                                    */
/* ------------------------------------------------------------------ */

async function activate(entry, event) {
  const doc = await fromUuid(entry.uuid).catch(() => null);
  if (!doc) return ui.notifications.warn(`Панель мастера: «${entry.name}» больше не существует. Правый клик → «Очистить».`);
  try {
    if (event?.shiftKey) return openSheet(doc);
    switch (entry.type) {
      case "Macro":
        return doc.execute();
      case "Activity":
        return doc.use({ event });
      case "Item":
        return useItem(doc, event);
      case "RollTable":
        return doc.draw();
      case "Scene":
        return doc.view();
      case "Playlist":
        return doc.playing ? doc.stopAll() : doc.playAll();
      case "PlaylistSound":
        return doc.playing
          ? doc.parent.stopSound(doc)
          : doc.parent.playSound(doc);
      default:
        return openSheet(doc);
    }
  } catch (err) {
    console.error(`${MOD} | gm-bar`, err);
    ui.notifications.error(`Панель мастера: не получилось выполнить «${entry.name}». Подробности в консоли (F12).`);
  }
}

/**
 * Предмет / способность. Если он принадлежит персонажу или монстру — применяется от него, независимо от
 * выделенного токена. Если это предмет из мира или компендиума — ищем такой же у выделенного токена.
 */
async function useItem(item, event) {
  let target = item;
  if (!item.actor) {
    const actor = canvas?.tokens?.controlled?.[0]?.actor;
    target = actor?.items?.getName?.(item.name) ?? null;
    if (!target) {
      ui.notifications.info(`«${item.name}» не принадлежит ни одному персонажу — открываю лист. Перетащите способность с листа нужного существа, чтобы применять её одним кликом.`);
      return openSheet(item);
    }
  }
  if (typeof target.use === "function") return target.use({ event });
  return openSheet(target);
}

function openSheet(doc) {
  if (doc.sheet) return doc.sheet.render(true);
  if (doc.item?.sheet) return doc.item.sheet.render(true);
}

/* ------------------------------------------------------------------ */
/*  Отрисовка                                                          */
/* ------------------------------------------------------------------ */

function toggle(force) {
  if (!game.user.isGM) return;
  const next = force ?? !setting("visible");
  setSetting("visible", next);
}

function setPage(n) {
  const pages = setting("pages");
  state.page = ((n % pages) + pages) % pages;
  setSetting("page", state.page);
  renderSlots();
}

function render() {
  if (!game.user?.isGM) return;
  if (!setting("visible")) {
    state.el?.remove();
    state.el = null;
    closeMenu();
    return;
  }
  if (state.page >= setting("pages")) state.page = setting("pages") - 1;
  if (!state.el) build();
  applyLayout();
  renderSlots();
}

function build() {
  const el = document.createElement("section");
  el.id = "rpgt-gmbar";
  el.innerHTML = `
    <header class="gmb-head">
      <i class="fa-solid fa-grip-vertical gmb-grip"></i>
      <span class="gmb-title">Панель мастера</span>
      <span class="gmb-pager">
        <button type="button" data-gmb="prev" data-tooltip="Предыдущая страница"><i class="fa-solid fa-chevron-left"></i></button>
        <span class="gmb-page"></span>
        <button type="button" data-gmb="next" data-tooltip="Следующая страница"><i class="fa-solid fa-chevron-right"></i></button>
      </span>
      <button type="button" data-gmb="lock" class="gmb-lock"></button>
      <button type="button" data-gmb="settings" data-tooltip="Настройки панели"><i class="fa-solid fa-gear"></i></button>
      <button type="button" data-gmb="collapse" class="gmb-collapse"></button>
      <button type="button" data-gmb="close" data-tooltip="Скрыть (Shift+G)"><i class="fa-solid fa-xmark"></i></button>
    </header>
    <div class="gmb-grid"></div>`;
  document.body.appendChild(el);
  state.el = el;

  el.querySelector(".gmb-head").addEventListener("pointerdown", startDrag);
  el.addEventListener("click", onClick);
  el.addEventListener("contextmenu", onContext);
  el.addEventListener("wheel", (ev) => {
    if (!ev.target.closest(".gmb-grid, .gmb-pager")) return;
    ev.preventDefault();
    setPage(state.page + (ev.deltaY > 0 ? 1 : -1));
  }, { passive: false });

  const grid = el.querySelector(".gmb-grid");
  grid.addEventListener("dragstart", onDragStart);
  grid.addEventListener("dragover", (ev) => {
    const slot = ev.target.closest(".gmb-slot");
    if (!slot) return;
    ev.preventDefault();
    slot.classList.add("drop");
  });
  grid.addEventListener("dragleave", (ev) => ev.target.closest(".gmb-slot")?.classList.remove("drop"));
  grid.addEventListener("drop", onDrop);
  // Перетаскивание по ячейкам на страницу: навели на стрелку — страница листается
  for (const dir of ["prev", "next"]) {
    el.querySelector(`[data-gmb="${dir}"]`).addEventListener("dragenter", () => setPage(state.page + (dir === "next" ? 1 : -1)));
  }

  const pos = setting("position") ?? {};
  // по умолчанию — слева сверху, чтобы не закрывать полосу инициативы по центру
  el.style.left = `${pos.left ?? 110}px`;
  el.style.top = `${pos.top ?? 170}px`;
  requestAnimationFrame(() => clampToScreen());
}

function applyLayout() {
  const el = state.el;
  if (!el) return;
  el.style.setProperty("--gmb-cols", setting("cols"));
  el.style.setProperty("--gmb-size", `${setting("slotSize")}px`);
  el.style.setProperty("--gmb-alpha", setting("opacity"));
  el.classList.toggle("collapsed", !!setting("collapsed"));
  el.classList.toggle("locked", !!setting("locked"));
  el.classList.toggle("labels", !!setting("showLabels"));
  const lock = el.querySelector(".gmb-lock");
  lock.innerHTML = `<i class="fa-solid ${setting("locked") ? "fa-lock" : "fa-lock-open"}"></i>`;
  lock.dataset.tooltip = setting("locked") ? "Панель закреплена — нажмите, чтобы двигать и менять ячейки" : "Закрепить панель (нельзя двигать и случайно менять ячейки)";
  const col = el.querySelector(".gmb-collapse");
  col.innerHTML = `<i class="fa-solid ${setting("collapsed") ? "fa-window-maximize" : "fa-window-minimize"}"></i>`;
  col.dataset.tooltip = setting("collapsed") ? "Развернуть" : "Свернуть";
}

function usesLabel(doc) {
  const uses = doc?.system?.uses;
  if (uses?.max) return `${uses.value ?? 0}/${uses.max}`;
  const q = doc?.system?.quantity;
  if (doc?.documentName === "Item" && q > 1) return `×${q}`;
  return "";
}

function renderSlots() {
  const el = state.el;
  if (!el) return;
  const pages = setting("pages");
  el.querySelector(".gmb-page").textContent = `${state.page + 1} / ${pages}`;
  el.querySelector(".gmb-pager").classList.toggle("single", pages <= 1);
  const n = perPage();
  const page = allPages()[state.page] ?? [];
  let html = "";
  for (let i = 0; i < n; i++) {
    const entry = page[i];
    if (!entry) {
      html += `<div class="gmb-slot empty" data-index="${i}"></div>`;
      continue;
    }
    const doc = fromUuidSync(entry.uuid, { strict: false });
    const missing = !doc;
    const name = doc?.name && entry.type !== "Activity" ? doc.name : entry.name;
    const img = (entry.type !== "Activity" && doc?.img) || entry.img;
    const owner = entry.actor ? ` — ${entry.actor}` : "";
    const badge = usesLabel(entry.type === "Activity" ? doc?.item : doc);
    html += `<div class="gmb-slot ${missing ? "missing" : ""}" data-index="${i}" draggable="true"
        data-tooltip="${esc(name + owner)}<br><span class='gmb-tip'>${esc(typeLabel(entry.type))} · клик — применить, Shift+клик — открыть, ПКМ — меню</span>">
        <img src="${esc(img)}" alt="">
        ${badge ? `<span class="gmb-badge">${esc(badge)}</span>` : ""}
        <span class="gmb-label">${esc(name)}</span>
      </div>`;
  }
  el.querySelector(".gmb-grid").innerHTML = html;
}

function typeLabel(type) {
  return ({
    Macro: "Макрос", Item: "Предмет / способность", Activity: "Действие способности", RollTable: "Таблица",
    JournalEntry: "Журнал", JournalEntryPage: "Страница журнала", Actor: "Персонаж", Scene: "Сцена",
    Playlist: "Плейлист", PlaylistSound: "Звук", Cards: "Колода"
  })[type] ?? type;
}

/* ------------------------------------------------------------------ */
/*  События                                                            */
/* ------------------------------------------------------------------ */

function onClick(ev) {
  closeMenu();
  const btn = ev.target.closest("[data-gmb]");
  if (btn) {
    switch (btn.dataset.gmb) {
      case "prev": return setPage(state.page - 1);
      case "next": return setPage(state.page + 1);
      case "lock": return setSetting("locked", !setting("locked")).then(applyLayout);
      case "collapse": return setSetting("collapsed", !setting("collapsed")).then(() => { applyLayout(); clampToScreen(); });
      case "settings": return game.rpgSuite?.openManager?.("gmbar");
      case "close": return toggle(false);
    }
  }
  const slot = ev.target.closest(".gmb-slot");
  if (!slot || slot.classList.contains("empty")) return;
  const entry = getSlot(state.page, Number(slot.dataset.index));
  if (entry) activate(entry, ev);
}

function onContext(ev) {
  const slot = ev.target.closest(".gmb-slot");
  if (!slot) return;
  ev.preventDefault();
  const index = Number(slot.dataset.index);
  const entry = getSlot(state.page, index);
  closeMenu();
  if (!entry) return;
  const menu = document.createElement("div");
  menu.className = "gmb-menu";
  menu.innerHTML = `
    <div class="gmb-menu-title">${esc(entry.name)}</div>
    <button type="button" data-m="use"><i class="fa-solid fa-play"></i> Применить</button>
    <button type="button" data-m="open"><i class="fa-solid fa-book-open"></i> Открыть</button>
    ${setting("locked") ? "" : `<button type="button" data-m="clear"><i class="fa-solid fa-trash"></i> Очистить ячейку</button>`}`;
  document.body.appendChild(menu);
  menu.style.left = `${Math.min(ev.clientX, window.innerWidth - 200)}px`;
  menu.style.top = `${Math.min(ev.clientY, window.innerHeight - 140)}px`;
  menu.addEventListener("click", async (e) => {
    const m = e.target.closest("[data-m]")?.dataset.m;
    closeMenu();
    if (m === "use") activate(entry, e);
    else if (m === "open") { const d = await fromUuid(entry.uuid).catch(() => null); if (d) openSheet(d); }
    else if (m === "clear") setSlot(state.page, index, null);
  });
  state.menu = menu;
  setTimeout(() => document.addEventListener("pointerdown", outsideMenu, { once: true }), 0);
}

function outsideMenu(ev) {
  if (state.menu && !state.menu.contains(ev.target)) closeMenu();
  else if (state.menu) document.addEventListener("pointerdown", outsideMenu, { once: true });
}

function closeMenu() {
  state.menu?.remove();
  state.menu = null;
}

function onDragStart(ev) {
  const slot = ev.target.closest(".gmb-slot");
  const entry = slot && getSlot(state.page, Number(slot.dataset.index));
  if (!entry) return ev.preventDefault();
  // Данные как у обычного документа Foundry — ячейку можно бросить и на холст / в стандартную панель макросов
  ev.dataTransfer.setData("text/plain", JSON.stringify({
    type: entry.type, uuid: entry.uuid,
    rpgtGmb: { page: state.page, index: Number(slot.dataset.index) }
  }));
}

async function onDrop(ev) {
  const slot = ev.target.closest(".gmb-slot");
  if (!slot) return;
  ev.preventDefault();
  slot.classList.remove("drop");
  if (setting("locked")) return ui.notifications.info("Панель мастера закреплена — снимите замок, чтобы менять ячейки.");
  const index = Number(slot.dataset.index);
  let data;
  try {
    const TE = foundry.applications?.ux?.TextEditor?.implementation ?? globalThis.TextEditor;
    data = TE?.getDragEventData ? TE.getDragEventData(ev) : JSON.parse(ev.dataTransfer.getData("text/plain"));
  } catch { return; }
  if (data?.rpgtGmb) {
    // Перестановка внутри панели (в том числе на другую страницу)
    return swapSlots(data.rpgtGmb, { page: state.page, index });
  }
  const entry = await entryFromDrop(data);
  if (!entry) return ui.notifications.warn("Панель мастера: сюда можно перетащить макрос, способность, предмет, таблицу, журнал, персонажа, сцену или звук.");
  await setSlot(state.page, index, entry);
}

/* ------------------------------------------------------------------ */
/*  Перетаскивание окна                                                */
/* ------------------------------------------------------------------ */

function startDrag(ev) {
  if (ev.button !== 0 || ev.target.closest("button") || setting("locked")) return;
  const el = state.el;
  const r = el.getBoundingClientRect();
  const dx = ev.clientX - r.left;
  const dy = ev.clientY - r.top;
  el.classList.add("dragging");
  const move = (e) => {
    el.style.left = `${e.clientX - dx}px`;
    el.style.top = `${e.clientY - dy}px`;
    clampToScreen(false);
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    el.classList.remove("dragging");
    savePosition();
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

function clampToScreen(save = true) {
  const el = state.el;
  if (!el) return;
  const r = el.getBoundingClientRect();
  const left = Math.min(Math.max(0, r.left), Math.max(0, window.innerWidth - r.width));
  const top = Math.min(Math.max(0, r.top), Math.max(0, window.innerHeight - 30));
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
  if (save) savePosition();
}

function savePosition() {
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => {
    if (!state.el) return;
    setSetting("position", { left: parseInt(state.el.style.left), top: parseInt(state.el.style.top) });
  }, 300);
}
