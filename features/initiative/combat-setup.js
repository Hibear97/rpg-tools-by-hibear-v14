/**
 * «Собрать бой» — окно мастера: все токены активной сцены с галочками → кнопка «В бой».
 * Создаёт бой на сцене (или дополняет текущий), добавляет отмеченных, по желанию бросает инициативу и начинает бой.
 */
import { SUITE_ID } from "../../core/constants.js";

const { ApplicationV2 } = foundry.applications.api;
const FALLBACK_IMG = "icons/svg/mystery-man.svg";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const isVideo = (p) => /\.(webm|mp4|m4v|ogv)$/i.test(p ?? "");

const GROUPS = [
  { id: "players", label: "Персонажи игроков", icon: "fa-user-shield" },
  { id: "friendly", label: "Союзники", icon: "fa-handshake" },
  { id: "neutral", label: "Нейтральные", icon: "fa-circle-half-stroke" },
  { id: "hostile", label: "Враги", icon: "fa-skull" },
  { id: "secret", label: "Скрытые", icon: "fa-user-secret" }
];

function groupOf(tokenDoc) {
  if (tokenDoc.actor?.hasPlayerOwner) return "players";
  const D = CONST.TOKEN_DISPOSITIONS;
  switch (tokenDoc.disposition) {
    case D.FRIENDLY: return "friendly";
    case D.HOSTILE: return "hostile";
    case D.SECRET: return "secret";
    default: return "neutral";
  }
}

function imgOf(tokenDoc) {
  return [tokenDoc.texture?.src, tokenDoc.actor?.img].find((p) => p && !isVideo(p)) ?? FALLBACK_IMG;
}

/** Бой текущей сцены (если уже есть). */
function sceneCombat(scene) {
  return game.combats?.find((c) => c.scene?.id === scene.id || c.scene === scene) ?? null;
}

export class CombatSetupApp extends ApplicationV2 {
  static #instance = null;

  static open() {
    if (!game.user.isGM) return ui.notifications.warn("Собрать бой может только мастер.");
    if (!canvas?.scene) return ui.notifications.warn("Нет активной сцены.");
    if (!this.#instance) this.#instance = new this();
    this.#instance.render({ force: true });
    return this.#instance;
  }

  static DEFAULT_OPTIONS = {
    id: "rpg-suite-combat-setup",
    classes: ["ib-setup"],
    tag: "div",
    window: { title: "Собрать бой", icon: "fa-solid fa-swords", resizable: true },
    position: { width: 560, height: 640 },
    actions: {
      pick: CombatSetupApp.#onPick,
      group: CombatSetupApp.#onGroup,
      fight: CombatSetupApp.#onFight,
      cancel: CombatSetupApp.#onCancel
    }
  };

  constructor(options = {}) {
    super(options);
    /** id токенов, с которых сняли галочку (по умолчанию отмечены все, кроме скрытых и уже участвующих) */
    this.checked = null;
    this.opts = { rollNPC: true, rollAll: false, start: false, skipHidden: true };
  }

  #tokens() {
    const scene = canvas.scene;
    const combat = sceneCombat(scene);
    const inCombat = new Set(combat?.combatants.map((c) => c.tokenId) ?? []);
    return scene.tokens.contents
      .filter((t) => t.actor)
      .map((t) => ({ doc: t, group: groupOf(t), inCombat: inCombat.has(t.id) }))
      .sort((a, b) => a.doc.name.localeCompare(b.doc.name, game.i18n.lang));
  }

  async _renderHTML() {
    const list = this.#tokens();
    if (!this.checked) {
      this.checked = new Set(list.filter((t) => !t.inCombat && t.group !== "neutral" && !(this.opts.skipHidden && t.doc.hidden)).map((t) => t.doc.id));
    }
    const combat = sceneCombat(canvas.scene);
    const sections = GROUPS.map((g) => {
      const rows = list.filter((t) => t.group === g.id);
      if (!rows.length) return "";
      const all = rows.filter((t) => !t.inCombat).every((t) => this.checked.has(t.doc.id));
      return `
        <section class="ib-setup-group" data-group="${g.id}">
          <header>
            <i class="fa-solid ${g.icon}"></i> ${g.label} <small>${rows.length}</small>
            <button type="button" data-action="group" data-group="${g.id}" data-on="${all ? 0 : 1}">${all ? "Снять" : "Все"}</button>
          </header>
          <ul>${rows.map((t) => this.#row(t)).join("")}</ul>
        </section>`;
    }).join("");

    const count = this.checked.size;
    const chk = (k, label) => `<label><input type="checkbox" data-opt="${k}" ${this.opts[k] ? "checked" : ""}> ${label}</label>`;
    return `
      <div class="ib-setup-body">
        <p class="ib-setup-hint">${combat
          ? `<i class="fa-solid fa-circle-info"></i> На сцене уже идёт бой — отмеченные будут <b>добавлены</b> в него.`
          : `<i class="fa-solid fa-circle-info"></i> Отметьте, кто участвует, и нажмите «В бой». Скрытые и нейтральные по умолчанию не отмечены.`}</p>
        <div class="ib-setup-quick">
          <button type="button" data-action="pick" data-mode="all"><i class="fa-solid fa-check-double"></i> Все</button>
          <button type="button" data-action="pick" data-mode="visible"><i class="fa-solid fa-eye"></i> Только видимые</button>
          <button type="button" data-action="pick" data-mode="selected"><i class="fa-solid fa-object-group"></i> Выделенные на карте</button>
          <button type="button" data-action="pick" data-mode="none"><i class="fa-solid fa-xmark"></i> Никого</button>
        </div>
        <div class="ib-setup-list">${sections || `<p class="ib-setup-empty">На сцене нет токенов с персонажами.</p>`}</div>
        <div class="ib-setup-opts">
          ${chk("rollNPC", "Сразу бросить инициативу за NPC")}
          ${chk("rollAll", "Бросить инициативу за всех (и за игроков)")}
          ${chk("start", "Сразу начать бой (1-й раунд)")}
        </div>
        <footer class="ib-setup-footer">
          <button type="button" data-action="cancel"><i class="fa-solid fa-xmark"></i> Отмена</button>
          <button type="button" class="ib-setup-go" data-action="fight" ${count ? "" : "disabled"}>
            <i class="fa-solid fa-swords"></i> В бой <span class="ib-setup-count">${count}</span>
          </button>
        </footer>
      </div>`;
  }

  #row({ doc, group, inCombat }) {
    const hp = doc.actor?.system?.attributes?.hp;
    const hpText = hp && Number.isFinite(hp.max) && hp.max > 0 ? `${hp.value ?? 0}/${hp.max}` : "";
    const on = inCombat || this.checked.has(doc.id);
    return `
      <li class="${group} ${inCombat ? "in-combat" : ""} ${doc.hidden ? "is-hidden" : ""}">
        <label>
          <input type="checkbox" data-token="${doc.id}" ${on ? "checked" : ""} ${inCombat ? "disabled" : ""}>
          <img src="${esc(imgOf(doc))}" alt="">
          <span class="name">${esc(doc.name)}${doc.hidden ? ` <i class="fa-solid fa-eye-slash" data-tooltip="Скрыт от игроков"></i>` : ""}</span>
          ${inCombat ? `<em>уже в бою</em>` : hpText ? `<small><i class="fa-solid fa-heart"></i> ${hpText}</small>` : ""}
        </label>
      </li>`;
  }

  _replaceHTML(result, content) {
    content.innerHTML = result;
  }

  _onRender() {
    const root = this.element;
    root.querySelectorAll("input[data-token]").forEach((cb) => cb.addEventListener("change", () => {
      if (cb.checked) this.checked.add(cb.dataset.token);
      else this.checked.delete(cb.dataset.token);
      root.querySelector(".ib-setup-count").textContent = this.checked.size;
      root.querySelector(".ib-setup-go").disabled = !this.checked.size;
    }));
    root.querySelectorAll("input[data-opt]").forEach((cb) => cb.addEventListener("change", () => {
      this.opts[cb.dataset.opt] = cb.checked;
    }));
    // двойной клик по строке — показать токен на карте
    root.querySelectorAll("li label").forEach((l) => l.addEventListener("dblclick", (ev) => {
      ev.preventDefault();
      const id = l.querySelector("input")?.dataset.token;
      const t = canvas.tokens.get(id);
      if (t) canvas.animatePan({ x: t.center.x, y: t.center.y, duration: 250 });
    }));
  }

  async close(options) {
    this.checked = null;
    return super.close(options);
  }

  static #onPick(_ev, target) {
    const list = this.#tokens().filter((t) => !t.inCombat);
    const mode = target.dataset.mode;
    const controlled = new Set(canvas.tokens.controlled.map((t) => t.id));
    const pick = {
      all: () => true,
      visible: (t) => !t.doc.hidden,
      selected: (t) => controlled.has(t.doc.id),
      none: () => false
    }[mode] ?? (() => false);
    if (mode === "selected" && !controlled.size) ui.notifications.info("На карте ничего не выделено.");
    this.checked = new Set(list.filter(pick).map((t) => t.doc.id));
    this.render();
  }

  static #onGroup(_ev, target) {
    const on = target.dataset.on === "1";
    for (const t of this.#tokens()) {
      if (t.group !== target.dataset.group || t.inCombat) continue;
      if (on) this.checked.add(t.doc.id); else this.checked.delete(t.doc.id);
    }
    this.render();
  }

  static #onCancel() { this.close(); }

  static async #onFight(_ev, target) {
    const scene = canvas.scene;
    const docs = [...this.checked].map((id) => scene.tokens.get(id)).filter(Boolean);
    if (!docs.length) return ui.notifications.warn("Никто не отмечен.");
    target.disabled = true;
    try {
      let combat = sceneCombat(scene);
      if (!combat) {
        const Cls = getDocumentClass("Combat");
        combat = await Cls.create({ scene: scene.id, active: true });
      } else if (!combat.active) await combat.activate();
      const have = new Set(combat.combatants.map((c) => c.tokenId));
      const data = docs.filter((d) => !have.has(d.id)).map((d) => ({
        tokenId: d.id, sceneId: scene.id, actorId: d.actorId, hidden: d.hidden
      }));
      if (data.length) await combat.createEmbeddedDocuments("Combatant", data);

      if (this.opts.rollAll) await combat.rollAll();
      else if (this.opts.rollNPC) await combat.rollNPC();
      if (this.opts.start && !combat.started) await combat.startCombat();

      ui.notifications.info(`В бою: ${combat.combatants.size}.`);
      ui.combat?.render?.();
      this.close();
    } catch (err) {
      console.error(`${SUITE_ID} | combat setup`, err);
      ui.notifications.error(`Не удалось собрать бой: ${err.message}`);
      target.disabled = false;
    }
  }
}

export const openCombatSetup = () => CombatSetupApp.open();
