/**
 * Sketch Notebook — личный блокнот с зарисовками для Foundry VTT (v12–v13).
 * Автор: Hibear
 */

import { SUITE_ID } from "../../core/constants.js";
import { createFeatureHooks } from "../../core/feature-hooks.js";

/** Функция «Блокнот с зарисовками» внутри RPG-Tools.
 *  Настройки: "rpg-tools-by-hibear.nb-*", заметки: user.flags["rpg-tools-by-hibear"].nb.notes,
 *  зарисовки в чате: message.flags["rpg-tools-by-hibear"].nb.sketch. Файлы рисунков — worlds/<мир>/sketch-notebook/ */
const MODULE_ID = SUITE_ID;
const Hooks = createFeatureHooks();

/** API для макросов: game.rpgSuite.api.notebook.toggle() */
export const api = {};

export function setup() {
  Hooks.activate();
}
const FLAG_NOTES = "notes";
const CANVAS_W = 1200;
const CANVAS_H = 800;
const UNDO_LIMIT = 25;

const { ApplicationV2, DialogV2 } = foundry.applications.api;

/* -------------------------------------------- */
/*  Утилиты                                     */
/* -------------------------------------------- */

const L = (key, data) =>
  data ? game.i18n.format(`SKETCHNB.${key}`, data) : game.i18n.localize(`SKETCHNB.${key}`);

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const isV13 = () => (game.release?.generation ?? 12) >= 13;

function fmtDate(ts) {
  try {
    return new Date(ts).toLocaleString(game.i18n.lang, {
      day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit"
    });
  } catch {
    return new Date(ts).toLocaleString();
  }
}

function canSketch() {
  return game.user.isGM || game.settings.get(MODULE_ID, "nb-playersCanSketch");
}

function makeNote(data = {}) {
  const now = Date.now();
  return {
    id: foundry.utils.randomID(),
    type: "text",
    title: "",
    content: "",
    img: null,
    created: now,
    updated: now,
    ...data
  };
}

function showImage(src, title = "") {
  if (isV13()) {
    new foundry.applications.apps.ImagePopout({ src, window: { title } }).render({ force: true });
  } else {
    new ImagePopout(src, { title }).render(true);
  }
}

async function confirmDialog(title, content) {
  try {
    return await DialogV2.confirm({
      window: { title },
      content: `<p>${content}</p>`,
      rejectClose: false,
      modal: true
    });
  } catch {
    return false;
  }
}

/* -------------------------------------------- */
/*  Хранилище заметок (флаги пользователя)       */
/* -------------------------------------------- */

function getNotes() {
  return foundry.utils.deepClone(game.user.getFlag(MODULE_ID, `nb.${FLAG_NOTES}`) ?? []);
}

let saveQueue = Promise.resolve();
function saveNotes(notes) {
  const snapshot = foundry.utils.deepClone(notes);
  saveQueue = saveQueue
    .then(() => game.user.setFlag(MODULE_ID, `nb.${FLAG_NOTES}`, snapshot))
    .catch((err) => console.error(`${MODULE_ID} | Ошибка сохранения заметок`, err));
  return saveQueue;
}

let notebookApp = null;

async function addNote(note, { select = false } = {}) {
  if (notebookApp?.rendered) {
    notebookApp.notes.unshift(note);
    if (select) notebookApp.selectedId = note.id;
    await saveNotes(notebookApp.notes);
    notebookApp.render();
  } else {
    const notes = getNotes();
    notes.unshift(note);
    await saveNotes(notes);
    if (notebookApp && select) notebookApp.selectedId = note.id;
  }
}

async function updateNote(id, changes) {
  const apply = (notes) => {
    const n = notes.find((x) => x.id === id);
    if (n) Object.assign(n, changes, { updated: Date.now() });
    return !!n;
  };
  if (notebookApp?.rendered) {
    if (!apply(notebookApp.notes)) return addNote(makeNote({ type: "drawing", ...changes }), { select: true });
    notebookApp.selectedId = id;
    await saveNotes(notebookApp.notes);
    notebookApp.render();
  } else {
    const notes = getNotes();
    if (!apply(notes)) return addNote(makeNote({ type: "drawing", ...changes }));
    await saveNotes(notes);
  }
}

/* -------------------------------------------- */
/*  Загрузка изображений и чат                   */
/* -------------------------------------------- */

function getFilePicker() {
  return foundry.applications?.apps?.FilePicker?.implementation ?? globalThis.FilePicker;
}

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

async function storeImage(blob, filename) {
  const FP = getFilePicker();
  const dir = `worlds/${game.world.id}/sketch-notebook`;
  try {
    if (!game.user.can("FILES_UPLOAD")) throw new Error("FILES_UPLOAD permission missing");
    try {
      await FP.browse("data", dir);
    } catch {
      await FP.createDirectory("data", dir).catch(() => {});
    }
    const file = new File([blob], filename, { type: blob.type });
    const res = await FP.upload("data", dir, file, {}, { notify: false });
    if (res?.path) return res.path;
    throw new Error("Upload returned no path");
  } catch (err) {
    console.warn(`${MODULE_ID} | Загрузка файла не удалась, сохраняю как data URL`, err);
    ui.notifications.warn(L("Notify.UploadFallback"));
    return blobToDataURL(blob);
  }
}

async function postSketchToChat({ title, img, caption = "" }) {
  const content = `
    <div class="snb-chat-card">
      ${title ? `<h3 class="snb-chat-title"><i class="fas fa-feather-pointed"></i> ${esc(title)}</h3>` : ""}
      <img class="snb-chat-img" src="${esc(img)}" alt="${esc(title)}">
      ${caption ? `<p class="snb-chat-caption">${esc(caption).replace(/\n/g, "<br>")}</p>` : ""}
      <button type="button" class="snb-chat-save" data-snb-save="1">
        <i class="fas fa-book-open"></i> ${L("Chat.SaveToNotebook")}
      </button>
    </div>`;
  return ChatMessage.create({
    content,
    speaker: ChatMessage.getSpeaker({ user: game.user }),
    flags: { [MODULE_ID]: { nb: { sketch: { title, img, caption } } } }
  });
}

function bindChatMessage(message, html) {
  const el = html instanceof HTMLElement ? html : html?.[0];
  const card = el?.querySelector?.(".snb-chat-card");
  if (!card) return;
  // зарисовки, отправленные ещё отдельным модулем, лежат под старым id
  const data = message.getFlag(MODULE_ID, "nb.sketch") ?? message.flags?.["sketch-notebook"]?.sketch ?? {};
  const imgEl = card.querySelector(".snb-chat-img");
  imgEl?.addEventListener("click", (ev) => {
    ev.preventDefault();
    showImage(data.img ?? imgEl.src, data.title ?? "");
  });
  card.querySelector("[data-snb-save]")?.addEventListener("click", async (ev) => {
    ev.preventDefault();
    const btn = ev.currentTarget;
    btn.disabled = true;
    await addNote(makeNote({
      type: "drawing",
      title: data.title ?? "",
      img: data.img ?? imgEl?.getAttribute("src"),
      content: data.caption ?? ""
    }));
    ui.notifications.info(L("Notify.SavedFromChat"));
    btn.disabled = false;
  });
}

/* -------------------------------------------- */
/*  Окно блокнота                                */
/* -------------------------------------------- */

class NotebookApp extends ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: "sketch-notebook",
    classes: ["sketch-notebook-app"],
    tag: "div",
    window: { title: "SKETCHNB.Notebook.Title", icon: "fas fa-book-open", resizable: true },
    position: { width: 940, height: 660 },
    actions: {
      newNote: NotebookApp._onNewNote,
      newSketch: NotebookApp._onNewSketch,
      selectNote: NotebookApp._onSelectNote,
      deleteNote: NotebookApp._onDeleteNote,
      sendToChat: NotebookApp._onSendToChat,
      editSketch: NotebookApp._onEditSketch,
      zoomImage: NotebookApp._onZoomImage
    }
  };

  constructor(options = {}) {
    super(options);
    this.notes = getNotes();
    this.selectedId = this.notes[0]?.id ?? null;
    this.filter = "";
    this._debouncedSave = foundry.utils.debounce(() => saveNotes(this.notes), 500);
  }

  get selected() {
    return this.notes.find((n) => n.id === this.selectedId) ?? null;
  }

  /* ----- Рендер ----- */

  async _renderHTML(_context, _options) {
    const gm = canSketch();
    const items = this.notes.map((n) => {
      const icon = n.type === "drawing" ? "fa-image" : "fa-feather";
      const active = n.id === this.selectedId ? "active" : "";
      const hidden = this._matches(n) ? "" : "hidden";
      return `
        <li class="snb-item ${active}" data-action="selectNote" data-note-id="${n.id}" ${hidden}>
          <i class="fas ${icon} snb-item-icon"></i>
          <div class="snb-item-text">
            <span class="snb-item-title">${esc(n.title) || `<em>${L("Notebook.Untitled")}</em>`}</span>
            <span class="snb-item-date">${fmtDate(n.updated)}</span>
          </div>
        </li>`;
    }).join("");

    return `
      <div class="snb-book">
        <aside class="snb-page snb-left">
          <header class="snb-left-header">
            <h2><i class="fas fa-book-open"></i> ${L("Notebook.Heading")}</h2>
            <span class="snb-count">${L("Notebook.Count", { count: this.notes.length })}</span>
          </header>
          <div class="snb-actions">
            <button type="button" data-action="newNote"><i class="fas fa-plus"></i> ${L("Notebook.NewNote")}</button>
            ${gm ? `<button type="button" class="snb-sketch-btn" data-action="newSketch"><i class="fas fa-paintbrush"></i> ${L("Notebook.NewSketch")}</button>` : ""}
          </div>
          <input type="search" class="snb-search" placeholder="${L("Notebook.Search")}" value="${esc(this.filter)}">
          <ol class="snb-list">
            ${items || `<li class="snb-list-empty">${L("Notebook.NoNotes")}</li>`}
          </ol>
        </aside>
        <div class="snb-spine"></div>
        <section class="snb-page snb-right">
          ${this._renderEditor(gm)}
        </section>
      </div>`;
  }

  _renderEditor(gm) {
    const n = this.selected;
    if (!n) {
      return `<div class="snb-empty"><i class="fas fa-feather-pointed"></i><p>${L("Notebook.Empty")}</p></div>`;
    }
    const meta = `
      <div class="snb-meta">
        ${L("Notebook.Created")}: ${fmtDate(n.created)} · ${L("Notebook.Updated")}: <span class="snb-updated">${fmtDate(n.updated)}</span>
      </div>`;
    const title = `<input type="text" class="snb-title-input" value="${esc(n.title)}" placeholder="${L("Notebook.TitlePlaceholder")}">`;
    const del = `<button type="button" class="snb-danger" data-action="deleteNote"><i class="fas fa-trash"></i> ${L("Notebook.Delete")}</button>`;

    if (n.type === "drawing") {
      return `
        <div class="snb-editor snb-editor-drawing">
          ${title}${meta}
          <div class="snb-drawing">
            <img src="${esc(n.img)}" alt="${esc(n.title)}" data-action="zoomImage">
          </div>
          <textarea class="snb-content snb-caption" placeholder="${L("Notebook.CaptionPlaceholder")}">${esc(n.content)}</textarea>
          <footer class="snb-editor-footer">
            <button type="button" data-action="sendToChat"><i class="fas fa-comment"></i> ${L("Notebook.SendToChat")}</button>
            ${gm ? `<button type="button" data-action="editSketch"><i class="fas fa-paintbrush"></i> ${L("Notebook.EditSketch")}</button>` : ""}
            <span class="snb-spacer"></span>
            ${del}
          </footer>
        </div>`;
    }

    return `
      <div class="snb-editor snb-editor-text">
        ${title}${meta}
        <textarea class="snb-content snb-lined" placeholder="${L("Notebook.ContentPlaceholder")}">${esc(n.content)}</textarea>
        <footer class="snb-editor-footer">
          <span class="snb-spacer"></span>
          ${del}
        </footer>
      </div>`;
  }

  _replaceHTML(result, content, _options) {
    content.innerHTML = result;
  }

  _onRender(_context, _options) {
    const root = this.element;

    root.querySelector(".snb-search")?.addEventListener("input", (ev) => {
      this.filter = ev.currentTarget.value;
      for (const li of root.querySelectorAll(".snb-item")) {
        const n = this.notes.find((x) => x.id === li.dataset.noteId);
        li.hidden = !(n && this._matches(n));
      }
    });

    const n = this.selected;
    if (!n) return;

    const titleInput = root.querySelector(".snb-title-input");
    const contentInput = root.querySelector(".snb-content");
    const listTitle = root.querySelector(`.snb-item[data-note-id="${n.id}"] .snb-item-title`);
    const listDate = root.querySelector(`.snb-item[data-note-id="${n.id}"] .snb-item-date`);
    const updatedEl = root.querySelector(".snb-updated");

    const touch = () => {
      n.updated = Date.now();
      const d = fmtDate(n.updated);
      if (listDate) listDate.textContent = d;
      if (updatedEl) updatedEl.textContent = d;
      this._debouncedSave();
    };

    titleInput?.addEventListener("input", (ev) => {
      n.title = ev.currentTarget.value;
      if (listTitle) listTitle.innerHTML = esc(n.title) || `<em>${L("Notebook.Untitled")}</em>`;
      touch();
    });
    contentInput?.addEventListener("input", (ev) => {
      n.content = ev.currentTarget.value;
      touch();
    });

    if (this._focusTitle) {
      this._focusTitle = false;
      titleInput?.focus();
    }
  }

  _matches(n) {
    const f = this.filter.trim().toLowerCase();
    if (!f) return true;
    return `${n.title} ${n.content}`.toLowerCase().includes(f);
  }

  async close(options = {}) {
    await saveNotes(this.notes);
    return super.close(options);
  }

  /* ----- Действия ----- */

  static async _onNewNote() {
    const note = makeNote({ type: "text" });
    this.notes.unshift(note);
    this.selectedId = note.id;
    this.filter = "";
    this._focusTitle = true;
    saveNotes(this.notes);
    this.render();
  }

  static _onNewSketch() {
    if (!canSketch()) return;
    new SketchApp().render({ force: true });
  }

  static _onSelectNote(_event, target) {
    const id = target.dataset.noteId;
    if (!id || id === this.selectedId) return;
    saveNotes(this.notes);
    this.selectedId = id;
    this.render();
  }

  static async _onDeleteNote() {
    const n = this.selected;
    if (!n) return;
    const ok = await confirmDialog(
      L("Notebook.DeleteTitle"),
      L("Notebook.DeleteContent", { title: esc(n.title || L("Notebook.Untitled")) })
    );
    if (!ok) return;
    const idx = this.notes.findIndex((x) => x.id === n.id);
    this.notes.splice(idx, 1);
    this.selectedId = this.notes[Math.min(idx, this.notes.length - 1)]?.id ?? null;
    await saveNotes(this.notes);
    this.render();
  }

  static async _onSendToChat() {
    const n = this.selected;
    if (!n?.img) return;
    await postSketchToChat({ title: n.title, img: n.img, caption: n.content });
    ui.notifications.info(L("Notify.Sent"));
  }

  static _onEditSketch() {
    const n = this.selected;
    if (!n?.img || !canSketch()) return;
    new SketchApp({ noteId: n.id, img: n.img, title: n.title, caption: n.content }).render({ force: true });
  }

  static _onZoomImage() {
    const n = this.selected;
    if (n?.img) showImage(n.img, n.title);
  }
}

/* -------------------------------------------- */
/*  Окно рисования                               */
/* -------------------------------------------- */

const BRUSHES = {
  brush:       { icon: "fa-paintbrush",  mode: "path",  alpha: 1,    width: (s) => s },
  marker:      { icon: "fa-highlighter", mode: "path",  alpha: 0.45, width: (s) => s * 1.8, cap: "square" },
  pencil:      { icon: "fa-pencil",      mode: "stamp", alpha: 0.9,  width: (s) => Math.max(1.5, s * 0.5) },
  calligraphy: { icon: "fa-pen-nib",     mode: "stamp", alpha: 1,    width: (s) => Math.max(2, s * 1.4) },
  spray:       { icon: "fa-spray-can",   mode: "stamp", alpha: 1,    width: (s) => Math.max(6, s * 2.5), continuous: true },
  eraser:      { icon: "fa-eraser",      mode: "path",  alpha: 1,    width: (s) => s * 1.5, erase: true }
};

const PALETTE = [
  "#1b1b1b", "#ffffff", "#7a7a7a", "#7b4a2a",
  "#c0392b", "#e67e22", "#f1c40f", "#27ae60",
  "#16a085", "#2e86de", "#8e44ad", "#e84393"
];

const BACKGROUNDS = { parchment: "#f3e6c4", white: "#ffffff", dark: "#26221e", transparent: null };

class SketchApp extends ApplicationV2 {
  static DEFAULT_OPTIONS = {
    classes: ["sketch-notebook-sketch"],
    tag: "div",
    window: { title: "SKETCHNB.Sketch.Title", icon: "fas fa-paintbrush", resizable: true },
    position: { width: 1060, height: 780 },
    actions: {
      pickBrush: SketchApp._onPickBrush,
      pickColor: SketchApp._onPickColor,
      undo: SketchApp._onUndo,
      redo: SketchApp._onRedo,
      clear: SketchApp._onClear,
      finish: SketchApp._onFinish
    }
  };

  /**
   * @param {object} sketch  {noteId, img, title, caption} — для редактирования существующего рисунка
   */
  constructor(sketch = {}, options = {}) {
    super(options);
    this.sketch = sketch;
    this.tool = {
      brush: "brush",
      color: PALETTE[0],
      size: 8,
      opacity: 1,
      bg: sketch.img ? "transparent" : "parchment"
    };
    this.undoStack = [];
    this.redoStack = [];
    this.active = null;
    this.dirty = false;
    this._finished = false;
    this._busy = false;
    this._raf = null;
  }

  async _renderHTML() {
    const brushes = Object.entries(BRUSHES).map(([key, b]) => `
      <button type="button" class="snb-brush ${key === this.tool.brush ? "active" : ""}"
              data-action="pickBrush" data-brush="${key}" data-tooltip="${L(`Brush.${key}`)}">
        <i class="fas ${b.icon}"></i><span>${L(`Brush.${key}`)}</span>
      </button>`).join("");

    const swatches = PALETTE.map((c) => `
      <button type="button" class="snb-swatch ${c === this.tool.color ? "active" : ""}"
              data-action="pickColor" data-color="${c}" style="--swatch:${c}" aria-label="${c}"></button>`).join("");

    const bgOptions = Object.keys(BACKGROUNDS).map((k) =>
      `<option value="${k}" ${k === this.tool.bg ? "selected" : ""}>${L(`Sketch.Bg.${k}`)}</option>`).join("");

    return `
      <div class="snb-sketch">
        <aside class="snb-tools">
          <h4>${L("Sketch.Brushes")}</h4>
          <div class="snb-brushes">${brushes}</div>

          <h4>${L("Sketch.Color")}</h4>
          <div class="snb-swatches">
            ${swatches}
            <label class="snb-custom-color" data-tooltip="${L("Sketch.CustomColor")}">
              <input type="color" class="snb-color-input" value="${this.tool.color}">
              <i class="fas fa-eye-dropper"></i>
            </label>
          </div>

          <h4>${L("Sketch.Size")} <span class="snb-size-val">${this.tool.size}</span></h4>
          <div class="snb-size-row">
            <input type="range" class="snb-size" min="1" max="80" step="1" value="${this.tool.size}">
            <div class="snb-size-preview"><span></span></div>
          </div>

          <h4>${L("Sketch.Opacity")} <span class="snb-opacity-val">${Math.round(this.tool.opacity * 100)}%</span></h4>
          <input type="range" class="snb-opacity" min="5" max="100" step="5" value="${Math.round(this.tool.opacity * 100)}">

          <h4>${L("Sketch.Background")}</h4>
          <select class="snb-bg">${bgOptions}</select>

          <div class="snb-history">
            <button type="button" data-action="undo" class="snb-undo" data-tooltip="${L("Sketch.Undo")}" disabled><i class="fas fa-rotate-left"></i></button>
            <button type="button" data-action="redo" class="snb-redo" data-tooltip="${L("Sketch.Redo")}" disabled><i class="fas fa-rotate-right"></i></button>
            <button type="button" data-action="clear" class="snb-clear" data-tooltip="${L("Sketch.Clear")}"><i class="fas fa-trash"></i></button>
          </div>
        </aside>

        <section class="snb-workspace">
          <div class="snb-stage">
            <div class="snb-canvas-wrap" data-bg="${this.tool.bg}">
              <canvas class="snb-main" width="${CANVAS_W}" height="${CANVAS_H}"></canvas>
              <canvas class="snb-stroke" width="${CANVAS_W}" height="${CANVAS_H}"></canvas>
              <div class="snb-cursor"></div>
            </div>
          </div>
          <footer class="snb-sketch-footer">
            <div class="snb-sketch-fields">
              <input type="text" class="snb-sketch-title" placeholder="${L("Sketch.TitlePlaceholder")}" value="${esc(this.sketch.title ?? "")}">
              <input type="text" class="snb-sketch-caption" placeholder="${L("Sketch.CaptionPlaceholder")}" value="${esc(this.sketch.caption ?? "")}">
            </div>
            <div class="snb-sketch-buttons">
              <button type="button" class="snb-finish" data-action="finish" data-mode="save"><i class="fas fa-book"></i> ${L("Sketch.Save")}</button>
              <button type="button" class="snb-finish snb-primary" data-action="finish" data-mode="saveChat"><i class="fas fa-book"></i><i class="fas fa-comment"></i> ${L("Sketch.SaveAndChat")}</button>
              <button type="button" class="snb-finish" data-action="finish" data-mode="chat"><i class="fas fa-comment"></i> ${L("Sketch.ChatOnly")}</button>
            </div>
          </footer>
        </section>
      </div>`;
  }

  _replaceHTML(result, content) {
    content.innerHTML = result;
  }

  _onRender() {
    const root = this.element;
    this.main = root.querySelector(".snb-main");
    this.stroke = root.querySelector(".snb-stroke");
    this.mctx = this.main.getContext("2d");
    this.sctx = this.stroke.getContext("2d");
    this.wrap = root.querySelector(".snb-canvas-wrap");
    this.stage = root.querySelector(".snb-stage");
    this.cursor = root.querySelector(".snb-cursor");

    // Холст
    this.stroke.addEventListener("pointerdown", (ev) => this._onDown(ev));
    this.stroke.addEventListener("pointermove", (ev) => this._onMove(ev));
    this.stroke.addEventListener("pointerup", (ev) => this._onUp(ev));
    this.stroke.addEventListener("pointercancel", (ev) => this._onUp(ev));
    this.stroke.addEventListener("pointerenter", () => this.cursor.classList.add("visible"));
    this.stroke.addEventListener("pointerleave", () => this.cursor.classList.remove("visible"));
    this.stroke.addEventListener("contextmenu", (ev) => ev.preventDefault());

    // Панель инструментов
    root.querySelector(".snb-size").addEventListener("input", (ev) => {
      this.tool.size = Number(ev.currentTarget.value);
      this._syncToolUI();
    });
    root.querySelector(".snb-opacity").addEventListener("input", (ev) => {
      this.tool.opacity = Number(ev.currentTarget.value) / 100;
      this._syncToolUI();
    });
    root.querySelector(".snb-color-input").addEventListener("input", (ev) => {
      this.tool.color = ev.currentTarget.value;
      if (this.tool.brush === "eraser") this.tool.brush = "brush";
      this._syncToolUI();
    });
    root.querySelector(".snb-bg").addEventListener("change", (ev) => {
      this.tool.bg = ev.currentTarget.value;
      this.wrap.dataset.bg = this.tool.bg;
    });

    // Подгонка размера холста под окно
    this._ro = new ResizeObserver(() => this._fit());
    this._ro.observe(this.stage);
    this._fit();
    this._syncToolUI();

    // Редактирование существующего рисунка
    if (this.sketch.img) {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        const s = Math.min(CANVAS_W / img.width, CANVAS_H / img.height);
        const w = img.width * s, h = img.height * s;
        this.mctx.drawImage(img, (CANVAS_W - w) / 2, (CANVAS_H - h) / 2, w, h);
      };
      img.src = this.sketch.img;
    }
  }

  _fit() {
    if (!this.stage) return;
    const w = this.stage.clientWidth, h = this.stage.clientHeight;
    if (!w || !h) return;
    const scale = Math.min(w / CANVAS_W, h / CANVAS_H);
    this.wrap.style.width = `${Math.floor(CANVAS_W * scale)}px`;
    this.wrap.style.height = `${Math.floor(CANVAS_H * scale)}px`;
    this._updateCursorSize();
  }

  _syncToolUI() {
    const root = this.element;
    if (!root) return;
    root.querySelectorAll(".snb-brush").forEach((b) => b.classList.toggle("active", b.dataset.brush === this.tool.brush));
    root.querySelectorAll(".snb-swatch").forEach((b) => b.classList.toggle("active", b.dataset.color === this.tool.color));
    root.querySelector(".snb-color-input").value = this.tool.color;
    root.querySelector(".snb-size-val").textContent = this.tool.size;
    root.querySelector(".snb-opacity-val").textContent = `${Math.round(this.tool.opacity * 100)}%`;
    const prev = root.querySelector(".snb-size-preview span");
    const d = Math.min(40, Math.max(2, this.tool.size));
    prev.style.width = prev.style.height = `${d}px`;
    prev.style.background = this.tool.brush === "eraser" ? "transparent" : this.tool.color;
    prev.style.opacity = this.tool.brush === "eraser" ? 1 : this.tool.opacity * BRUSHES[this.tool.brush].alpha;
    prev.classList.toggle("eraser", this.tool.brush === "eraser");
    this._updateCursorSize();
  }

  _updateCursorSize() {
    if (!this.cursor || !this.wrap) return;
    const scale = this.wrap.clientWidth / CANVAS_W || 1;
    const d = Math.max(4, BRUSHES[this.tool.brush].width(this.tool.size) * scale);
    this.cursor.style.width = this.cursor.style.height = `${d}px`;
    this.cursor.classList.toggle("square", this.tool.brush === "marker");
  }

  _syncHistoryUI() {
    const root = this.element;
    if (!root) return;
    root.querySelector(".snb-undo").disabled = !this.undoStack.length;
    root.querySelector(".snb-redo").disabled = !this.redoStack.length;
  }

  /* ----- Рисование ----- */

  _pt(ev) {
    const r = this.stroke.getBoundingClientRect();
    return {
      x: ((ev.clientX - r.left) * CANVAS_W) / r.width,
      y: ((ev.clientY - r.top) * CANVAS_H) / r.height
    };
  }

  _moveCursor(ev) {
    const r = this.wrap.getBoundingClientRect();
    this.cursor.style.left = `${ev.clientX - r.left}px`;
    this.cursor.style.top = `${ev.clientY - r.top}px`;
  }

  _onDown(ev) {
    if (ev.pointerType === "mouse" && ev.button !== 0) return;
    if (this._busy) return;
    ev.preventDefault();
    this.stroke.setPointerCapture(ev.pointerId);
    const brush = BRUSHES[this.tool.brush];
    const p = this._pt(ev);
    this.active = {
      brush,
      pointerId: ev.pointerId,
      color: brush.erase ? "#ffffff" : this.tool.color,
      width: brush.width(this.tool.size),
      points: [p],
      timer: null
    };
    this.stroke.style.opacity = brush.erase ? "0.55" : String(brush.alpha * this.tool.opacity);
    this.sctx.clearRect(0, 0, CANVAS_W, CANVAS_H);

    if (brush.mode === "stamp") {
      this._stampSegment(p, p);
      if (brush.continuous) {
        this.active.timer = setInterval(() => {
          const last = this.active?.points.at(-1);
          if (last) this._stamp(last);
        }, 35);
      }
    } else {
      this._drawPath();
    }
  }

  _onMove(ev) {
    this._moveCursor(ev);
    const a = this.active;
    if (!a || ev.pointerId !== a.pointerId) return;
    const coalesced = ev.getCoalescedEvents?.();
    const events = coalesced?.length ? coalesced : [ev];
    for (const e of events) {
      const p = this._pt(e);
      const last = a.points.at(-1);
      if (Math.hypot(p.x - last.x, p.y - last.y) < 0.8) continue;
      a.points.push(p);
      if (a.brush.mode === "stamp") this._stampSegment(last, p);
    }
    if (a.brush.mode === "path" && !this._raf) {
      this._raf = requestAnimationFrame(() => {
        this._raf = null;
        if (this.active) this._drawPath();
      });
    }
  }

  _onUp(ev) {
    const a = this.active;
    if (!a || ev.pointerId !== a.pointerId) return;
    clearInterval(a.timer);
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
    if (a.brush.mode === "path") this._drawPath();
    this._commit();
    this.active = null;
    try { this.stroke.releasePointerCapture(ev.pointerId); } catch {}
  }

  _drawPath() {
    const { points, width, color, brush } = this.active;
    const ctx = this.sctx;
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
    ctx.lineCap = brush.cap ?? "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = width;

    if (points.length === 1) {
      const p = points[0];
      if (brush.cap === "square") ctx.fillRect(p.x - width / 2, p.y - width / 2, width, width);
      else {
        ctx.beginPath();
        ctx.arc(p.x, p.y, width / 2, 0, Math.PI * 2);
        ctx.fill();
      }
      return;
    }

    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length - 1; i++) {
      const p = points[i], n = points[i + 1];
      ctx.quadraticCurveTo(p.x, p.y, (p.x + n.x) / 2, (p.y + n.y) / 2);
    }
    const last = points.at(-1);
    ctx.lineTo(last.x, last.y);
    ctx.stroke();
  }

  _stampSegment(a, b) {
    const { brush, width, color } = this.active;
    const ctx = this.sctx;
    ctx.fillStyle = color;
    ctx.strokeStyle = color;

    if (this.tool.brush === "calligraphy") {
      const ang = -Math.PI / 4;
      const nx = (Math.cos(ang) * width) / 2, ny = (Math.sin(ang) * width) / 2;
      ctx.beginPath();
      ctx.moveTo(a.x + nx, a.y + ny);
      ctx.lineTo(b.x + nx, b.y + ny);
      ctx.lineTo(b.x - nx, b.y - ny);
      ctx.lineTo(a.x - nx, a.y - ny);
      ctx.closePath();
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.lineCap = "round";
      ctx.beginPath();
      if (a === b) {
        ctx.moveTo(a.x - nx, a.y - ny);
        ctx.lineTo(a.x + nx, a.y + ny);
      } else {
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
      }
      ctx.stroke();
      return;
    }

    const step = brush.continuous ? width * 0.35 : Math.max(1, width * 0.3);
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    const n = Math.max(1, Math.ceil(dist / step));
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      this._stamp({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
  }

  _stamp(p) {
    const { width, color } = this.active;
    const ctx = this.sctx;
    ctx.fillStyle = color;
    const r = width / 2;

    if (this.tool.brush === "pencil") {
      const count = Math.ceil(width * 1.5) + 2;
      for (let i = 0; i < count; i++) {
        const ang = Math.random() * Math.PI * 2;
        const rr = r * Math.sqrt(Math.random());
        ctx.globalAlpha = 0.25 + Math.random() * 0.55;
        ctx.fillRect(p.x + Math.cos(ang) * rr, p.y + Math.sin(ang) * rr, 1.3, 1.3);
      }
      ctx.globalAlpha = 1;
      return;
    }

    if (this.tool.brush === "spray") {
      const count = Math.ceil(width * 0.6) + 3;
      for (let i = 0; i < count; i++) {
        const ang = Math.random() * Math.PI * 2;
        const rr = r * Math.sqrt(Math.random());
        ctx.fillRect(p.x + Math.cos(ang) * rr, p.y + Math.sin(ang) * rr, 1.5, 1.5);
      }
    }
  }

  _commit() {
    const a = this.active;
    this._pushUndo();
    const ctx = this.mctx;
    ctx.save();
    ctx.globalAlpha = a.brush.erase ? 1 : a.brush.alpha * this.tool.opacity;
    ctx.globalCompositeOperation = a.brush.erase ? "destination-out" : "source-over";
    ctx.drawImage(this.stroke, 0, 0);
    ctx.restore();
    this.sctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
    this.dirty = true;
  }

  _pushUndo() {
    this.undoStack.push(this.mctx.getImageData(0, 0, CANVAS_W, CANVAS_H));
    if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
    this.redoStack = [];
    this._syncHistoryUI();
  }

  async _exportBlob() {
    const c = document.createElement("canvas");
    c.width = CANVAS_W;
    c.height = CANVAS_H;
    const ctx = c.getContext("2d");
    const bg = BACKGROUNDS[this.tool.bg];
    if (bg) {
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
    }
    ctx.drawImage(this.main, 0, 0);
    let blob = await new Promise((r) => c.toBlob(r, "image/webp", 0.92));
    if (!blob || blob.type !== "image/webp") blob = await new Promise((r) => c.toBlob(r, "image/png"));
    return blob;
  }

  /* ----- Действия ----- */

  static _onPickBrush(_ev, target) {
    this.tool.brush = target.dataset.brush;
    this._syncToolUI();
  }

  static _onPickColor(_ev, target) {
    this.tool.color = target.dataset.color;
    if (this.tool.brush === "eraser") this.tool.brush = "brush";
    this._syncToolUI();
  }

  static _onUndo() {
    if (!this.undoStack.length) return;
    this.redoStack.push(this.mctx.getImageData(0, 0, CANVAS_W, CANVAS_H));
    this.mctx.putImageData(this.undoStack.pop(), 0, 0);
    this.dirty = true;
    this._syncHistoryUI();
  }

  static _onRedo() {
    if (!this.redoStack.length) return;
    this.undoStack.push(this.mctx.getImageData(0, 0, CANVAS_W, CANVAS_H));
    this.mctx.putImageData(this.redoStack.pop(), 0, 0);
    this.dirty = true;
    this._syncHistoryUI();
  }

  static _onClear() {
    this._pushUndo();
    this.mctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
    this.dirty = true;
  }

  static async _onFinish(_ev, target) {
    if (this._busy) return;
    const mode = target.dataset.mode; // save | saveChat | chat
    const root = this.element;
    const buttons = root.querySelectorAll(".snb-finish");
    this._busy = true;
    buttons.forEach((b) => (b.disabled = true));
    try {
      const title = root.querySelector(".snb-sketch-title").value.trim()
        || L("Sketch.DefaultTitle", { date: fmtDate(Date.now()) });
      const caption = root.querySelector(".snb-sketch-caption").value.trim();
      const blob = await this._exportBlob();
      const ext = blob.type === "image/webp" ? "webp" : "png";
      const img = await storeImage(blob, `sketch-${game.user.id}-${Date.now()}.${ext}`);

      if (mode !== "chat") {
        if (this.sketch.noteId) await updateNote(this.sketch.noteId, { title, img, content: caption });
        else await addNote(makeNote({ type: "drawing", title, img, content: caption }), { select: true });
      }
      if (mode !== "save") await postSketchToChat({ title, img, caption });

      ui.notifications.info(L(mode === "save" ? "Notify.Saved" : mode === "chat" ? "Notify.Sent" : "Notify.SavedAndSent"));
      this._finished = true;
      await this.close({ force: true });
    } catch (err) {
      console.error(`${MODULE_ID} |`, err);
      ui.notifications.error(L("Notify.Error"));
    } finally {
      this._busy = false;
      buttons.forEach((b) => (b.disabled = false));
    }
  }

  async close(options = {}) {
    if (this.dirty && !this._finished && !options.force) {
      const ok = await confirmDialog(L("Sketch.DiscardTitle"), L("Sketch.DiscardContent"));
      if (!ok) return this;
    }
    this._ro?.disconnect();
    clearInterval(this.active?.timer);
    this.undoStack = [];
    this.redoStack = [];
    return super.close(options);
  }
}

/* -------------------------------------------- */
/*  Открытие блокнота и кнопки                   */
/* -------------------------------------------- */

function openNotebook() {
  if (!notebookApp) notebookApp = new NotebookApp();
  else if (!notebookApp.rendered) {
    notebookApp.notes = getNotes();
    if (!notebookApp.notes.some((n) => n.id === notebookApp.selectedId)) {
      notebookApp.selectedId = notebookApp.notes[0]?.id ?? null;
    }
  }
  notebookApp.render({ force: true });
  return notebookApp;
}

function toggleNotebook() {
  if (notebookApp?.rendered) return notebookApp.close();
  return openNotebook();
}

function openSketch() {
  if (!canSketch()) return null;
  return new SketchApp().render({ force: true });
}

function removeFloatingButton() {
  document.getElementById("snb-floating")?.remove();
}

function createFloatingButton() {
  removeFloatingButton();
  if (!game.settings.get(MODULE_ID, "nb-floatingButton")) return;

  const btn = document.createElement("button");
  btn.id = "snb-floating";
  btn.type = "button";
  btn.title = L("Notebook.Open");
  btn.innerHTML = `<i class="fas fa-book-open"></i>`;

  const pos = game.settings.get(MODULE_ID, "nb-floatingPos") ?? {};
  if (Number.isFinite(pos.left) && Number.isFinite(pos.top)) {
    btn.style.left = `${Math.min(pos.left, window.innerWidth - 50)}px`;
    btn.style.top = `${Math.min(pos.top, window.innerHeight - 50)}px`;
    btn.style.bottom = "auto";
  }

  let start = null;
  let dragging = false;
  btn.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return;
    const r = btn.getBoundingClientRect();
    start = { x: ev.clientX, y: ev.clientY, left: r.left, top: r.top };
    dragging = false;
    btn.setPointerCapture(ev.pointerId);
  });
  btn.addEventListener("pointermove", (ev) => {
    if (!start) return;
    const dx = ev.clientX - start.x, dy = ev.clientY - start.y;
    if (!dragging && Math.hypot(dx, dy) < 5) return;
    dragging = true;
    const left = Math.max(0, Math.min(window.innerWidth - btn.offsetWidth, start.left + dx));
    const top = Math.max(0, Math.min(window.innerHeight - btn.offsetHeight, start.top + dy));
    btn.style.left = `${left}px`;
    btn.style.top = `${top}px`;
    btn.style.bottom = "auto";
  });
  btn.addEventListener("pointerup", () => {
    if (!start) return;
    start = null;
    if (dragging) {
      game.settings.set(MODULE_ID, "nb-floatingPos", {
        left: parseFloat(btn.style.left), top: parseFloat(btn.style.top)
      });
    } else {
      toggleNotebook();
    }
    dragging = false;
  });

  document.body.append(btn);
}

/* -------------------------------------------- */
/*  Хуки                                         */
/* -------------------------------------------- */

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "nb-floatingButton", {
    name: "SKETCHNB.Settings.FloatingButton",
    hint: "SKETCHNB.Settings.FloatingButtonHint",
    scope: "client",
    config: true,
    type: Boolean,
    default: true,
    onChange: (v) => (v ? createFloatingButton() : removeFloatingButton())
  });

  game.settings.register(MODULE_ID, "nb-playersCanSketch", {
    name: "SKETCHNB.Settings.PlayersCanSketch",
    hint: "SKETCHNB.Settings.PlayersCanSketchHint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
    onChange: () => notebookApp?.rendered && notebookApp.render()
  });

  game.settings.register(MODULE_ID, "nb-floatingPos", {
    scope: "client",
    config: false,
    type: Object,
    default: {}
  });

  game.keybindings.register(MODULE_ID, "nb-toggle", {
    name: "SKETCHNB.Settings.Keybinding",
    editable: [{ key: "KeyB", modifiers: ["Shift"] }],
    onDown: () => {
      toggleNotebook();
      return true;
    }
  });

  Object.assign(api, { open: openNotebook, toggle: toggleNotebook, sketch: openSketch, addNote, makeNote });
});

Hooks.once("ready", () => {
  createFloatingButton();
});

// Кнопка в панели инструментов «Токены» (слева)
Hooks.on("getSceneControlButtons", (controls) => {
  const tool = {
    name: "sketch-notebook",
    title: "SKETCHNB.Notebook.Open",
    icon: "fas fa-book-open",
    button: true,
    visible: true
  };
  if (Array.isArray(controls)) {
    // v12
    const tc = controls.find((c) => c.name === "token");
    tc?.tools.push({ ...tool, onClick: () => toggleNotebook() });
  } else {
    // v13
    const tc = controls.tokens;
    if (tc?.tools) {
      tc.tools["sketch-notebook"] = {
        ...tool,
        order: Object.keys(tc.tools).length + 1,
        onChange: () => toggleNotebook()
      };
    }
  }
});

// Кликабельные рисунки и кнопка «В мой блокнот» в чате
Hooks.once("setup", () => {
  if (isV13()) Hooks.on("renderChatMessageHTML", (message, html) => bindChatMessage(message, html));
  else Hooks.on("renderChatMessage", (message, html) => bindChatMessage(message, html));
});
