import { SUITE_ID } from "./constants.js";
import { HELP, DISCORD_HELP } from "./help.js";

const { ApplicationV2 } = foundry.applications.api;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const t = (k) => game.i18n.localize(k);
const tf = (k, d) => game.i18n.format(k, d);
const M = (k) => t(`RPGSUITE.Manager.${k}`);

/** Название настройки без приставки «Функция · » — в окне функции она лишняя. */
function cleanName(raw) {
  const s = t(raw ?? "");
  const i = s.indexOf(" · ");
  return i >= 0 ? s.slice(i + 3) : s;
}

function fieldKind(cfg) {
  const T = cfg.type;
  const F = foundry.data?.fields ?? {};
  if (T === Boolean || (F.BooleanField && T instanceof F.BooleanField)) return "boolean";
  if (T === Number || (F.NumberField && T instanceof F.NumberField)) return cfg.range ? "range" : "number";
  if (T === String || (F.StringField && T instanceof F.StringField)) {
    if (cfg.choices) return "select";
    if (cfg.filePicker) return "file";
    return "text";
  }
  return null;   // объекты и прочие служебные настройки в окне не показываем
}

/**
 * Центр управления RPG Suite.
 * Слева — список функций с переключателями (мастер), справа — описание выбранной функции и её настройки.
 * Игроки видят описания и свои личные (клиентские) настройки, но не могут включать/выключать функции.
 */
export class FeatureManager extends ApplicationV2 {
  constructor(options = {}) {
    super(options);
    this.selected = options.selected ?? null;
    this.draft = null;            // { [featureId]: boolean } — несохранённые переключатели
    this.values = new Map();      // fullKey → значение — несохранённые настройки
  }

  static DEFAULT_OPTIONS = {
    id: "rpg-suite-manager-{id}",
    tag: "div",
    classes: ["rpg-suite-manager"],
    window: { title: "RPGSUITE.Manager.title", icon: "fa-solid fa-sliders", resizable: true },
    position: { width: 860, height: 640 }
  };

  /* ---------------- данные ---------------- */

  get suite() { return game.rpgSuite; }

  get toggles() {
    this.draft ??= { ...this.suite.enabledMap() };
    return this.draft;
  }

  select(id) {
    this.selected = id;
    this.render();
  }

  statusOf(f) {
    const s = this.suite;
    const saved = s.enabledMap()[f.id];
    const want = this.toggles[f.id];
    const legacy = f.legacyModule && game.modules.get(f.legacyModule)?.active;
    const out = [];
    if (want !== saved) out.push(["pending", want ? M("pendingOn") : M("pendingOff"), "fa-solid fa-rotate"]);
    else if (s.isFailed(f.id)) out.push(["warn", M("failed"), "fa-solid fa-bug"]);
    else if (legacy && saved) out.push(["warn", tf("RPGSUITE.Manager.legacy", { module: game.modules.get(f.legacyModule)?.title ?? f.legacyModule }), "fa-solid fa-triangle-exclamation"]);
    else if (s.isActive(f.id)) out.push(["on", M("running"), "fa-solid fa-circle"]);
    else out.push(["off", M("stopped"), "fa-regular fa-circle"]);
    if (f.system && game.system.id !== f.system) out.push(["warn", M("needsSystem"), "fa-solid fa-triangle-exclamation"]);
    for (const r of f.recommends ?? []) {
      if (!game.modules.get(r)?.active) out.push(["info", tf("RPGSUITE.Manager.recommends", { module: game.modules.get(r)?.title ?? r }), "fa-solid fa-circle-info"]);
    }
    for (const c of f.conflicts ?? []) {
      if (game.modules.get(c)?.active) out.push(["warn", tf("RPGSUITE.Manager.conflict", { module: game.modules.get(c)?.title ?? c }), "fa-solid fa-triangle-exclamation"]);
    }
    return out;
  }

  /** Настройки функции, которые можно показать в окне. */
  settingsOf(f) {
    const prefix = `${f.settingPrefix}-`;
    const list = [];
    for (const cfg of game.settings.settings.values()) {
      if (cfg.namespace !== SUITE_ID || !cfg.key.startsWith(prefix)) continue;
      // config: false прячет настройку, но manager: true показывает её только в центре управления
      if (cfg.config === false && !cfg.manager) continue;
      if ((cfg.scope === "world" || cfg.gmOnly) && !game.user.isGM) continue;
      const kind = fieldKind(cfg);
      if (kind) list.push({ cfg, kind, fullKey: `${cfg.namespace}.${cfg.key}` });
    }
    const menus = [];
    for (const m of game.settings.menus.values()) {
      if (m.namespace !== SUITE_ID || !m.key.startsWith(prefix)) continue;
      if (m.restricted && !game.user.isGM) continue;
      menus.push(m);
    }
    return { list, menus };
  }

  valueOf(item) {
    if (this.values.has(item.fullKey)) return this.values.get(item.fullKey);
    try { return game.settings.get(SUITE_ID, item.cfg.key); } catch { return item.cfg.default; }
  }

  /* ---------------- отрисовка ---------------- */

  async _renderHTML() {
    const features = this.suite.features;
    if (!this.selected || !features.some((f) => f.id === this.selected)) this.selected = features[0]?.id;
    const isGM = game.user.isGM;
    const toggles = this.toggles;

    const nav = features.map((f) => {
      const [cls] = this.statusOf(f)[0];
      const on = !!toggles[f.id];
      return `<li class="rs-nav-item ${f.id === this.selected ? "selected" : ""} ${on ? "checked" : ""}" data-select="${esc(f.id)}">
        <span class="rs-icon"><i class="${esc(f.icon)}"></i></span>
        <span class="rs-nav-text">
          <span class="rs-title">${esc(t(f.title))}</span>
          <span class="rs-dot ${cls}"></span>
        </span>
        ${isGM
          ? `<button type="button" class="rs-switch" data-toggle="${esc(f.id)}" role="switch" aria-checked="${on}" data-tooltip="${esc(M("enabled"))}"></button>`
          : `<span class="rs-switch static" aria-hidden="true"></span>`}
        <button type="button" class="rs-help-btn" data-help="${esc(f.id)}" data-tooltip="${esc(M("howItWorks"))}" aria-label="${esc(M("howItWorks"))}"><i class="fa-solid fa-question"></i></button>
      </li>`;
    }).join("");

    const f = features.find((x) => x.id === this.selected);
    const div = document.createElement("div");
    div.className = "rs-body";
    div.innerHTML = `
      <p class="rs-hint">${esc(isGM ? M("hint") : M("playerHint"))}</p>
      <div class="rs-columns">
        <nav class="rs-nav"><ul>${nav}</ul></nav>
        <section class="rs-pane">${f ? this.#paneHTML(f) : ""}</section>
      </div>
      <footer class="rs-footer">
        ${isGM ? `
          <button type="button" data-rs="all"><i class="fa-solid fa-check-double"></i> ${esc(M("all"))}</button>
          <button type="button" data-rs="none"><i class="fa-regular fa-square"></i> ${esc(M("none"))}</button>
          <span class="rs-note">${esc(M("reloadNote"))}</span>` : `<span class="rs-note"></span>`}
        <button type="button" class="rs-save" data-rs="save"><i class="fa-solid fa-floppy-disk"></i> ${esc(M("save"))}</button>
      </footer>
      <div class="rs-author">RPG-Tools · ${esc(M("author"))}</div>`;
    this.#activate(div);
    return div;
  }

  #paneHTML(f) {
    const status = this.statusOf(f).map(([cls, text, icon]) =>
      `<span class="rs-status ${cls}"><i class="${icon}"></i> ${esc(text)}</span>`).join("");
    const details = t(f.details).split("\n").filter(Boolean).map((l) => `<li>${esc(l)}</li>`).join("");

    let settingsHTML;
    if (!this.suite.isActive(f.id)) {
      settingsHTML = `<p class="rs-muted">${esc(M("offSettings"))}</p>`;
    } else {
      const { list, menus } = this.settingsOf(f);
      const world = list.filter((s) => s.cfg.scope === "world");
      const client = list.filter((s) => s.cfg.scope !== "world");
      const group = (title, items) => items.length
        ? `<h4>${esc(title)}</h4><div class="rs-fields">${items.map((s) => this.#fieldHTML(s)).join("")}</div>` : "";
      const menusHTML = menus.map((m) =>
        `<button type="button" class="rs-menu" data-menu="${esc(m.namespace)}.${esc(m.key)}"><i class="${esc(m.icon ?? "fa-solid fa-gear")}"></i> ${esc(t(m.label ?? m.name))}</button>`).join("");
      settingsHTML = (list.length || menus.length)
        ? `${menusHTML ? `<div class="rs-menus">${menusHTML}</div>` : ""}${group(M("worldSettings"), world)}${group(M("clientSettings"), client)}`
        : `<p class="rs-muted">${esc(M("noSettings"))}</p>`;
    }

    return `
      <header class="rs-pane-head">
        <span class="rs-icon big"><i class="${esc(f.icon)}"></i></span>
        <div class="rs-pane-title">
          <h2>${esc(t(f.title))}</h2>
          <div class="rs-statuses">${status}</div>
        </div>
        <div class="rs-pane-help">
          <button type="button" class="rs-help-main" data-help="${esc(f.id)}"><i class="fa-solid fa-circle-question"></i> ${esc(M("howItWorks"))}</button>
          ${f.id === "portraits" ? `<button type="button" class="rs-help-main discord" data-help="discord"><i class="fa-brands fa-discord"></i> ${esc(M("discordHelp"))}</button>` : ""}
        </div>
      </header>
      <p class="rs-desc">${esc(t(f.description))}</p>
      <h3><i class="fa-solid fa-list-check"></i> ${esc(M("whatItDoes"))}</h3>
      <ul class="rs-details">${details}</ul>
      <h3><i class="fa-solid fa-gear"></i> ${esc(M("settings"))}</h3>
      ${settingsHTML}`;
  }

  #fieldHTML(s) {
    const { cfg, kind, fullKey } = s;
    const v = this.valueOf(s);
    const name = esc(cleanName(cfg.name ?? cfg.key));
    const hint = cfg.hint ? `<p class="hint">${esc(t(cfg.hint))}</p>` : "";
    const k = esc(fullKey);
    let input;
    switch (kind) {
      case "boolean":
        input = `<input type="checkbox" data-setting="${k}" ${v ? "checked" : ""}>`;
        break;
      case "range": {
        const { min, max, step } = cfg.range;
        input = `<div class="rs-range"><input type="range" data-setting="${k}" min="${min}" max="${max}" step="${step}" value="${esc(v)}"><output>${esc(v)}</output></div>`;
        break;
      }
      case "number":
        input = `<input type="number" data-setting="${k}" value="${esc(v)}">`;
        break;
      case "select": {
        const choices = typeof cfg.choices === "function" ? cfg.choices() : cfg.choices;
        input = `<select data-setting="${k}">${Object.entries(choices).map(([cv, cl]) =>
          `<option value="${esc(cv)}" ${String(cv) === String(v) ? "selected" : ""}>${esc(t(cl))}</option>`).join("")}</select>`;
        break;
      }
      case "file":
        input = `<div class="rs-file"><input type="text" data-setting="${k}" value="${esc(v)}">
          <button type="button" data-browse="${k}" data-type="${esc(cfg.filePicker === true ? "any" : cfg.filePicker)}" data-tooltip="${esc(M("browse"))}"><i class="fa-solid fa-file-import"></i></button></div>`;
        break;
      default:
        input = `<input type="text" data-setting="${k}" value="${esc(v)}">`;
    }
    return `<div class="rs-field ${kind}"><label>${name}</label><div class="rs-input">${input}</div>${hint}</div>`;
  }

  _replaceHTML(result, content) {
    const pane = content.querySelector(".rs-pane");
    const scroll = pane?.scrollTop ?? 0;
    content.replaceChildren(result);
    const next = content.querySelector(".rs-pane");
    if (next && this._keepScroll) next.scrollTop = scroll;
    this._keepScroll = false;
  }

  /* ---------------- события ---------------- */

  #activate(root) {
    root.addEventListener("click", (ev) => {
      const help = ev.target.closest("[data-help]");
      if (help) {
        ev.stopPropagation();
        return openHelp(help.dataset.help);
      }
      const tog = ev.target.closest("[data-toggle]");
      if (tog) {
        ev.stopPropagation();
        if (!game.user.isGM) return;
        const id = tog.dataset.toggle;
        this.toggles[id] = !this.toggles[id];
        this.selected = id;
        return this.render();
      }
      const sel = ev.target.closest("[data-select]");
      if (sel) return this.select(sel.dataset.select);

      const menuBtn = ev.target.closest("[data-menu]");
      if (menuBtn) {
        const menu = game.settings.menus.get(menuBtn.dataset.menu);
        if (menu?.type) new menu.type().render({ force: true });
        return;
      }
      const browse = ev.target.closest("[data-browse]");
      if (browse) {
        const input = root.querySelector(`[data-setting="${CSS.escape(browse.dataset.browse)}"]`);
        const FP = foundry.applications?.apps?.FilePicker?.implementation ?? globalThis.FilePicker;
        new FP({
          type: browse.dataset.type || "any",
          current: input?.value ?? "",
          callback: (path) => { if (input) { input.value = path; input.dispatchEvent(new Event("change", { bubbles: true })); } }
        }).render(true);
        return;
      }
      const act = ev.target.closest("[data-rs]")?.dataset.rs;
      if (act === "all" || act === "none") {
        for (const f of this.suite.features) this.toggles[f.id] = act === "all";
        return this.render();
      }
      if (act === "save") return this.#save();
    });

    const onInput = (ev) => {
      const el = ev.target.closest("[data-setting]");
      if (!el) return;
      let value;
      if (el.type === "checkbox") value = el.checked;
      else if (el.type === "range" || el.type === "number") value = Number(el.value);
      else value = el.value;
      this.values.set(el.dataset.setting, value);
      const out = el.parentElement?.querySelector("output");
      if (out) out.textContent = el.value;
    };
    root.addEventListener("input", onInput);
    root.addEventListener("change", onInput);
  }

  async #save() {
    // 1. Настройки функций
    let changed = 0;
    for (const [fullKey, value] of this.values) {
      const cfg = game.settings.settings.get(fullKey);
      if (!cfg) continue;
      if (cfg.scope === "world" && !game.user.isGM) continue;
      let cur;
      try { cur = game.settings.get(cfg.namespace, cfg.key); } catch { cur = undefined; }
      if (cur === value) continue;
      try { await game.settings.set(cfg.namespace, cfg.key, value); changed++; }
      catch (err) { console.error(`${SUITE_ID} | не удалось сохранить ${fullKey}`, err); }
    }
    this.values.clear();

    // 2. Включение/выключение функций (перезагрузит всех)
    if (game.user.isGM) {
      const before = this.suite.enabledMap();
      const map = { ...this.toggles };
      if (this.suite.features.some((f) => before[f.id] !== map[f.id])) {
        await game.settings.set(SUITE_ID, "features", map);   // onChange перезагрузит страницу у всех
        return;
      }
    }
    if (changed) ui.notifications.info(M("saved"));
    this._keepScroll = true;
    this.render();
  }
}

/* ------------------------------------------------------------------ */
/*  Окно «Как это работает?»                                           */
/* ------------------------------------------------------------------ */

const helpWindows = new Map();

/**
 * Открыть подробную инструкцию функции (id из реестра) или «discord» — как запустить Discord-бота.
 * Тексты — в core/help.js.
 */
export function openHelp(id) {
  const open = helpWindows.get(id);
  if (open?.rendered) { open.bringToFront?.(); return open; }
  const app = new HelpWindow({ helpId: id });
  helpWindows.set(id, app);
  app.render({ force: true });
  return app;
}

class HelpWindow extends ApplicationV2 {
  constructor(options = {}) {
    super(options);
    this.helpId = options.helpId;
  }

  static DEFAULT_OPTIONS = {
    id: "rpg-suite-help-{id}",
    tag: "div",
    classes: ["rpg-suite-help"],
    window: { title: "RPGSUITE.Manager.howItWorks", icon: "fa-solid fa-circle-question", resizable: true },
    position: { width: 620, height: 640 }
  };

  get feature() {
    return game.rpgSuite?.features?.find((f) => f.id === this.helpId) ?? null;
  }

  get title() {
    if (this.helpId === "discord") return `${M("discordHelp")}`;
    const f = this.feature;
    return f ? `${M("howItWorks")} — ${t(f.title)}` : M("howItWorks");
  }

  async _renderHTML() {
    const isDiscord = this.helpId === "discord";
    const f = this.feature;
    const body = isDiscord ? DISCORD_HELP : (HELP[this.helpId] ?? `<p>${esc(t(f?.description ?? ""))}</p>`);
    const div = document.createElement("div");
    div.className = "rs-help";
    div.innerHTML = `
      <header class="rs-help-head">
        <span class="rs-icon big"><i class="${isDiscord ? "fa-brands fa-discord" : esc(f?.icon ?? "fa-solid fa-circle-question")}"></i></span>
        <div>
          <h2>${esc(isDiscord ? M("discordHelp") : t(f?.title ?? ""))}</h2>
          ${isDiscord ? "" : `<p class="rs-help-sub">${esc(t(f?.description ?? ""))}</p>`}
        </div>
      </header>
      <article class="rs-help-body">${body}</article>
      ${this.helpId === "portraits" ? `<footer class="rs-help-foot"><button type="button" data-help-open="discord"><i class="fa-brands fa-discord"></i> ${esc(M("discordHelp"))}</button></footer>` : ""}
      ${isDiscord ? `<footer class="rs-help-foot"><button type="button" data-help-open="portraits"><i class="fa-solid fa-microphone-lines"></i> ${esc(M("backToPortraits"))}</button></footer>` : ""}`;
    div.addEventListener("click", (ev) => {
      const b = ev.target.closest("[data-help-open]");
      if (b) openHelp(b.dataset.helpOpen);
    });
    return div;
  }

  _replaceHTML(result, content) {
    content.replaceChildren(result);
  }

  _onRender(context, options) {
    super._onRender?.(context, options);
    const h = this.element?.querySelector(".window-title");
    if (h) h.textContent = this.title;
  }
}
