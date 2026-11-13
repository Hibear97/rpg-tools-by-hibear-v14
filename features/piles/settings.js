/**
 * Настройки модуля и окно «Настройки Piles tool» в стиле Центра управления RPG-Tools.
 */
import { MODULE_ID, MODULE_TITLE, RppApp, DialogV2, esc } from "./core.js";

const SECTIONS = [
  {
    id: "currency", title: "Валюта", icon: "fa-solid fa-coins",
    desc: "Какими деньгами платят в лавках, контейнерах и при обмене. Цены предметов в базе никогда не переписываются — "
      + "в режиме «Только золото» они пересчитываются на лету, поэтому при выключении режима всё возвращается как было.",
    fields: ["currencyMode", "customKeepStandard"], currencyEditor: true
  },
  {
    id: "containers", title: "Контейнеры", icon: "fa-solid fa-box",
    desc: "Сундуки, бочки и прочие тайлы-контейнеры. Игрок подходит и жмёт ПКМ: заперто — бросок на вскрытие, закрыто — открывается.",
    fields: ["interactRange", "lockpickNames", "lockpickBreak", "chestImage"]
  },
  {
    id: "piles", title: "Кучи лута", icon: "fa-solid fa-sack",
    desc: "Предмет, брошенный из инвентаря на карту, превращается в кучу. Мастер может превратить токен (например, мёртвого монстра) в кучу.",
    fields: ["pileDrop", "pileDeleteEmpty", "pileImage"]
  },
  {
    id: "merchants", title: "Торговцы", icon: "fa-solid fa-store",
    desc: "Значения по умолчанию для новых торговцев. У каждого торговца их можно поменять в его настройках.",
    fields: ["buyMult", "sellMult", "tradeChat"]
  },
  {
    id: "trade", title: "Обмен", icon: "fa-solid fa-handshake",
    desc: "Обмен между игроками как в World of Warcraft: ячейки, монеты, обмен проходит только когда оба нажали «Обмен».",
    fields: ["tradeEnabled", "tradeSlots"]
  }
];

const DEFS = {
  currencyMode: {
    name: "Режим валюты", type: String, default: "standard", requiresReload: true,
    choices: { standard: "Стандартные монеты D&D (пм, зм, эм, см, мм)", gold: "Только золото", custom: "Свои валюты" },
    hint: "«Только золото»: все цены и кошельки показываются в золотых. После смены режима мир перезагрузится."
  },
  customKeepStandard: { name: "Оставить стандартные монеты", type: Boolean, default: true,
    hint: "Для режима «Свои валюты»: использовать монеты D&D вместе со своими." },
  customCurrencies: { name: "Свои валюты", type: Array, default: [
    { key: "crown", name: "Крона", abbr: "кр", rate: 1, color: "#f0c040", img: "" }
  ] },
  interactRange: { name: "Дистанция взаимодействия (клеток)", type: Number, default: 1,
    hint: "Насколько близко надо подойти к сундуку или торговцу. 0 — без ограничения." },
  lockpickNames: { name: "Названия отмычек", type: String, default: "отмычк, lockpick",
    hint: "Через запятую. Предмет, в названии которого есть одно из слов, считается отмычкой. Воровские инструменты находятся сами." },
  lockpickBreak: { name: "Отмычка ломается при провале", type: Boolean, default: true,
    hint: "Воровские инструменты не ломаются никогда." },
  chestImage: { name: "Картинка нового сундука", type: String, default: "icons/svg/chest.svg", file: "image" },
  pileDrop: { name: "Игроки могут бросать предметы на карту", type: Boolean, default: true },
  pileDeleteEmpty: { name: "Удалять пустую кучу", type: Boolean, default: true },
  pileImage: { name: "Картинка кучи", type: String, default: "icons/svg/item-bag.svg", file: "image" },
  buyMult: { name: "Наценка торговца", type: Number, default: 1, hint: "1 — по цене из книги." },
  sellMult: { name: "Цена скупки", type: Number, default: 0.5, hint: "0.5 — торговец платит половину." },
  tradeChat: { name: "Сообщения о сделках в чат", type: Boolean, default: true, hint: "Шёпотом покупателю и мастеру." },
  tradeEnabled: { name: "Обмен между игроками", type: Boolean, default: true },
  tradeSlots: { name: "Ячеек для обмена", type: Number, default: 6, range: { min: 1, max: 12, step: 1 } }
};

export function registerSettings() {
  for (const [key, d] of Object.entries(DEFS)) {
    game.settings.register(MODULE_ID, `pt-${key}`, {
      name: `Сундуки и торговцы · ${d.name}`, hint: d.hint, scope: "world", config: false, type: d.type, default: d.default,
      choices: d.choices, range: d.range, requiresReload: d.requiresReload ?? false
    });
  }
  game.settings.registerMenu(MODULE_ID, "pt-manager", {
    name: "Сундуки и торговцы · Настройки",
    label: "Открыть настройки",
    hint: "Валюта, контейнеры, кучи лута, торговцы и обмен.",
    icon: "fa-solid fa-sack-dollar",
    type: SettingsApp,
    restricted: true
  });
}

export class SettingsApp extends RppApp {
  constructor(options = {}) {
    super(options);
    this.section = "currency";
    this.draft = Object.fromEntries(Object.keys(DEFS).map((k) => [k, foundry.utils.deepClone(game.settings.get(MODULE_ID, `pt-${k}`))]));
  }

  static DEFAULT_OPTIONS = {
    id: "rpp-settings",
    classes: ["rpp-window", "rpp-manager"],
    window: { title: "Сундуки, торговцы и обмен — настройки", icon: "fa-solid fa-sack-dollar", resizable: true },
    position: { width: 820, height: 600 },
    actions: {
      section: SettingsApp.#onSection, save: SettingsApp.#onSave, pick: SettingsApp.#onPick,
      addCur: SettingsApp.#onAddCur, delCur: SettingsApp.#onDelCur, reset: SettingsApp.#onReset
    }
  };

  #field(key) {
    const d = DEFS[key], v = this.draft[key];
    let input;
    if (d.type === Boolean) input = `<input type="checkbox" name="${key}" ${v ? "checked" : ""}>`;
    else if (d.choices) input = `<select name="${key}">${Object.entries(d.choices).map(([k, l]) =>
      `<option value="${k}" ${k === v ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
    else if (d.file) input = `<div class="rpp-file"><input type="text" name="${key}" value="${esc(v)}">
      <button type="button" data-action="pick" data-target="${key}" data-type="${d.file}"><i class="fa-solid fa-file-import"></i></button></div>`;
    else if (d.type === Number) input = `<input type="number" name="${key}" value="${v}" step="${d.range?.step ?? "any"}" ${d.range ? `min="${d.range.min}" max="${d.range.max}"` : ""}>`;
    else input = `<input type="text" name="${key}" value="${esc(v)}">`;
    return `<div class="rpp-field ${d.type === Boolean ? "boolean" : ""}"><label>${esc(d.name)}</label><div class="rpp-input">${input}</div>
      ${d.hint ? `<p class="hint">${esc(d.hint)}</p>` : ""}</div>`;
  }

  #currencyEditor() {
    const rows = (this.draft.customCurrencies ?? []).map((c, i) => `
      <tr data-index="${i}">
        <td><input type="text" data-cur="key" value="${esc(c.key)}" placeholder="crown"></td>
        <td><input type="text" data-cur="name" value="${esc(c.name)}" placeholder="Крона"></td>
        <td><input type="text" data-cur="abbr" value="${esc(c.abbr)}" placeholder="кр"></td>
        <td><input type="number" data-cur="rate" value="${c.rate}" step="any" min="0"></td>
        <td><input type="color" data-cur="color" value="${esc(c.color || "#f0c040")}"></td>
        <td><div class="rpp-file"><input type="text" data-cur="img" value="${esc(c.img)}">
          <button type="button" data-action="pick" data-cur-index="${i}" data-type="image"><i class="fa-solid fa-file-import"></i></button></div></td>
        <td><a data-action="delCur" data-index="${i}"><i class="fa-solid fa-trash"></i></a></td>
      </tr>`).join("");
    return `
      <h3><i class="fa-solid fa-coins"></i> Свои валюты</h3>
      <p class="rpp-hint">Работают в режиме «Свои валюты». «Курс» — сколько золотых стоит одна монета (0.1 = как серебряная, 10 = как платиновая).
        Монеты хранятся у персонажей отдельно и видны в окнах лавки и обмена.</p>
      <table class="rpp-items-table rpp-cur-table">
        <thead><tr><th>Ключ</th><th>Название</th><th>Сокр.</th><th>Курс (зм)</th><th>Цвет</th><th>Иконка</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="rpp-row"><span></span><button type="button" data-action="addCur"><i class="fa-solid fa-plus"></i> Добавить валюту</button></div>`;
  }

  async _html() {
    const sec = SECTIONS.find((s) => s.id === this.section);
    const nav = SECTIONS.map((s) => `
      <li class="rs-nav-item checked ${s.id === this.section ? "selected" : ""}" data-action="section" data-id="${s.id}">
        <span class="rs-icon"><i class="${s.icon}"></i></span>
        <span class="rs-nav-text"><span class="rs-title">${esc(s.title)}</span></span>
      </li>`).join("");
    return `
      <div class="rs-body">
        <p class="rs-hint">Модуль добычи, торговли и обмена для D&D 5e. Работает отдельно от RPG-Tools, но выглядит так же.</p>
        <div class="rs-columns">
          <nav class="rs-nav"><ul>${nav}</ul></nav>
          <section class="rs-pane">
            <div class="rs-pane-head"><span class="rs-icon big"><i class="${sec.icon}"></i></span><h2>${esc(sec.title)}</h2></div>
            <p class="rs-desc">${esc(sec.desc)}</p>
            <h3><i class="fa-solid fa-sliders"></i> Настройки</h3>
            <div class="rs-fields">${sec.fields.map((k) => this.#field(k)).join("")}</div>
            ${sec.currencyEditor ? this.#currencyEditor() : ""}
          </section>
        </div>
        <footer class="rs-footer">
          <button type="button" data-action="reset"><i class="fa-solid fa-rotate-left"></i> По умолчанию</button>
          <span class="rs-note">Изменения применяются после «Сохранить».</span>
          <button type="button" class="rs-save rpp-confirm" data-action="save"><i class="fa-solid fa-floppy-disk"></i> Сохранить</button>
        </footer>
        <div class="rs-author">${MODULE_TITLE}</div>
      </div>`;
  }

  /** Считать поля текущего раздела в черновик. */
  #collect() {
    const root = this.element;
    if (!root) return;
    for (const key of Object.keys(DEFS)) {
      const el = root.querySelector(`[name="${key}"]`);
      if (!el) continue;
      const d = DEFS[key];
      this.draft[key] = d.type === Boolean ? el.checked : d.type === Number ? Number(el.value) : el.value;
    }
    const rows = root.querySelectorAll(".rpp-cur-table tbody tr");
    if (rows.length || this.section === "currency") {
      this.draft.customCurrencies = [...rows].map((tr) => {
        const o = {};
        for (const inp of tr.querySelectorAll("[data-cur]")) o[inp.dataset.cur] = inp.dataset.cur === "rate" ? Number(inp.value) : inp.value.trim();
        return o;
      });
    }
  }

  static #onSection(event, target) { this.#collect(); this.section = target.dataset.id; this.render(); }
  static #onAddCur() {
    this.#collect();
    this.draft.customCurrencies.push({ key: `cur${this.draft.customCurrencies.length + 1}`, name: "", abbr: "", rate: 1, color: "#f0c040", img: "" });
    this.render();
  }
  static #onDelCur(event, target) { this.#collect(); this.draft.customCurrencies.splice(Number(target.dataset.index), 1); this.render(); }

  static #onPick(event, target) {
    const input = target.dataset.curIndex != null
      ? target.closest("tr").querySelector("[data-cur=img]")
      : this.element.querySelector(`[name="${target.dataset.target}"]`);
    const FP = foundry.applications?.apps?.FilePicker?.implementation ?? globalThis.FilePicker;
    const fp = new FP({ type: target.dataset.type, current: input.value, callback: (p) => { input.value = p; } });
    fp.browse ? fp.browse() : fp.render(true);
  }

  static async #onReset() {
    const ok = await DialogV2.confirm({ window: { title: "Сбросить настройки?" }, content: "<p>Вернуть все настройки сундуков, торговцев и обмена по умолчанию?</p>", rejectClose: false });
    if (!ok) return;
    for (const [k, d] of Object.entries(DEFS)) this.draft[k] = foundry.utils.deepClone(d.default);
    this.render();
  }

  static async #onSave() {
    this.#collect();
    const keys = new Set();
    for (const c of this.draft.customCurrencies) {
      c.key = String(c.key || "").replace(/[^a-zA-Z0-9_]/g, "");
      if (!c.key || keys.has(c.key) || ["pp", "gp", "ep", "sp", "cp"].includes(c.key)) {
        return ui.notifications.warn("У каждой валюты должен быть свой ключ латиницей (не pp/gp/ep/sp/cp).");
      }
      keys.add(c.key);
    }
    const reload = this.draft.currencyMode !== game.settings.get(MODULE_ID, "pt-currencyMode");
    for (const [k, v] of Object.entries(this.draft)) {
      if (k === "currencyMode") continue;
      await game.settings.set(MODULE_ID, `pt-${k}`, v);
    }
    ui.notifications.info("Настройки сундуков и торговцев сохранены.");
    this.close();
    if (reload) {
      await game.settings.set(MODULE_ID, "pt-currencyMode", this.draft.currencyMode);
      const SC = foundry.applications?.settings?.SettingsConfig ?? globalThis.SettingsConfig;
      if (SC?.reloadConfirm) await SC.reloadConfirm({ world: true });
      else {
        const ok = await DialogV2.confirm({ window: { title: "Перезагрузка" }, content: "<p>Режим валюты изменён. Перезагрузить?</p>", rejectClose: false });
        if (ok) foundry.utils.debouncedReload?.() ?? window.location.reload();
      }
    }
  }
}
