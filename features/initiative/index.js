/**
 * Initiative Bar Tool — трекер инициативы в стиле Baldur's Gate 3 для Foundry VTT (v12–v13).
 * Наведи на свой портрет -> он превращается в d20 -> клик бросает инициативу.
 */

import { SUITE_ID } from "../../core/constants.js";
import { createFeatureHooks } from "../../core/feature-hooks.js";
import { openCombatSetup } from "./combat-setup.js";

/** Функция «Полоса инициативы» внутри RPG-Tools. Настройки: "rpg-tools-by-hibear.ib-*". */
const MODULE_ID = SUITE_ID;
const Hooks = createFeatureHooks();
let bar = null;

/** API для макросов: game.rpgSuite.api.initiative.render() */
export const api = { render: () => bar?.render(), gather: () => openCombatSetup() };

export function setup() {
  Hooks.activate();
}
const FALLBACK_IMG = "icons/svg/mystery-man.svg";

const D20_SVG = `
<svg class="bg3ib-d20" viewBox="0 0 100 100" aria-hidden="true">
  <polygon class="d20-body" points="50,3 91,26.5 91,73.5 50,97 9,73.5 9,26.5"/>
  <polygon class="d20-face" points="50,22 78,70 22,70"/>
  <path class="d20-edges" d="M50,3 L50,22 M9,26.5 L50,22 L91,26.5 M91,26.5 L78,70 L91,73.5 M78,70 L50,97 L22,70 L9,73.5 M9,26.5 L22,70"/>
  <text x="50" y="61">20</text>
</svg>`;

function esc(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function isVideo(path) {
  return /\.(webm|mp4|m4v|ogv)$/i.test(path ?? "");
}

class InitiativeBar {
  constructor() {
    this.element = null;
    this.prevInitiative = new Map(); // combatantId -> initiative (для анимации "только что бросил")
    this.rolling = new Set();        // combatantId, которые сейчас бросают
    this.render = foundry.utils.debounce(() => this._render(), 50);
  }

  /* ---------------- Данные ---------------- */

  get combat() {
    return game.combat ?? null;
  }

  _shouldShow(combat) {
    if (!combat) return false;
    if (!game.user.isGM && !game.settings.get(MODULE_ID, "ib-showToPlayers")) return false;
    return combat.turns.some(c => c.visible);
  }

  _imageFor(c) {
    const src = game.settings.get(MODULE_ID, "ib-imageSource");
    const actorImg = c.actor?.img;
    const tokenImg = c.token?.texture?.src ?? c.img;
    const candidates = src === "token" ? [tokenImg, actorImg, c.img] : [actorImg, tokenImg, c.img];
    return candidates.find(p => p && !isVideo(p)) ?? FALLBACK_IMG;
  }

  _dispositionClass(c) {
    const d = c.token?.disposition;
    const D = CONST.TOKEN_DISPOSITIONS;
    if (d === D.FRIENDLY) return "friendly";
    if (d === D.HOSTILE) return "hostile";
    if (d === D.SECRET) return game.user.isGM ? "secret" : "neutral";
    return "neutral";
  }

  _hpData(c) {
    if (!game.settings.get(MODULE_ID, "ib-showHP")) return null;
    if (!(game.user.isGM || c.isOwner)) return null;
    const hp = c.actor?.system?.attributes?.hp;
    if (!hp || !Number.isFinite(hp.max) || hp.max <= 0) return null;
    const value = Math.max(0, Number(hp.value) || 0);
    const temp = Math.max(0, Number(hp.temp) || 0);
    return {
      pct: Math.min(100, (value / hp.max) * 100),
      tempPct: Math.min(100, (temp / hp.max) * 100),
      label: `${value}${temp ? ` (+${temp})` : ""} / ${hp.max}`
    };
  }

  /* ---------------- Рендер ---------------- */

  _ensureElement() {
    if (this.element) return this.element;
    const el = document.createElement("section");
    el.id = "initiative-bar-tool";
    el.addEventListener("click", this._onClick.bind(this));
    document.body.appendChild(el);
    this.element = el;
    return el;
  }

  _render() {
    const el = this._ensureElement();
    const combat = this.combat;

    el.style.setProperty("--bg3ib-top", `${game.settings.get(MODULE_ID, "ib-topOffset")}px`);
    el.style.setProperty("--bg3ib-size", `${game.settings.get(MODULE_ID, "ib-portraitSize")}px`);

    if (!this._shouldShow(combat)) {
      this.prevInitiative.clear();
      // Мастеру без боя — кнопка «Собрать бой» на месте полосы
      if (game.user.isGM && !combat && game.settings.get(MODULE_ID, "ib-gatherButton")) {
        el.innerHTML = `<button type="button" class="bg3ib-gather" data-action="gather" data-tooltip="Выбрать участников из токенов на сцене">
          <i class="fas fa-swords"></i> ${esc(game.i18n.localize("BG3IB.Gather"))}</button>`;
        el.classList.add("bg3ib-visible", "bg3ib-idle");
      } else el.classList.remove("bg3ib-visible");
      return;
    }
    el.classList.remove("bg3ib-idle");

    const activeId = combat.started ? combat.combatant?.id : null;
    const turns = combat.turns.filter(c => c.visible);
    const loc = (k, d) => d ? game.i18n.format(k, d) : game.i18n.localize(k);

    const cards = turns.map(c => {
      const hasInit = c.initiative !== null && c.initiative !== undefined;
      const canRoll = c.isOwner && !hasInit && !this.rolling.has(c.id);
      const isRolling = this.rolling.has(c.id);
      const justRolled = this.prevInitiative.has(c.id) && this.prevInitiative.get(c.id) == null && hasInit;
      const defeated = c.isDefeated ?? c.defeated;
      const hp = this._hpData(c);

      const classes = [
        "bg3ib-card",
        this._dispositionClass(c),
        c.id === activeId ? "active" : "",
        canRoll ? "can-roll" : "",
        isRolling ? "rolling" : "",
        justRolled ? "just-rolled" : "",
        defeated ? "defeated" : "",
        c.hidden ? "gm-hidden" : "",
        c.isOwner ? "owned" : ""
      ].filter(Boolean).join(" ");

      const tooltip = esc(c.name) + (defeated ? ` — ${esc(loc("BG3IB.Defeated"))}` : "");

      return `
        <div class="${classes}" data-combatant-id="${c.id}" data-tooltip="${tooltip}" data-tooltip-direction="DOWN">
          <div class="bg3ib-frame">
            <img class="bg3ib-portrait" src="${esc(this._imageFor(c))}" alt="${esc(c.name)}" draggable="false">
            ${(canRoll || isRolling) ? `
              <button type="button" class="bg3ib-roll" data-action="roll" aria-label="${esc(loc("BG3IB.RollInitiative"))}">
                ${D20_SVG}
              </button>` : ""}
            ${defeated ? `<i class="bg3ib-skull fas fa-skull"></i>` : ""}
          </div>
          ${hp ? `
            <div class="bg3ib-hp" data-tooltip="${esc(hp.label)}">
              <div class="bg3ib-hp-fill" style="width:${hp.pct}%"></div>
              ${hp.tempPct ? `<div class="bg3ib-hp-temp" style="width:${hp.tempPct}%"></div>` : ""}
            </div>` : ""}
          <div class="bg3ib-init${hasInit ? "" : " empty"}">${hasInit ? esc(c.initiative) : "–"}</div>
        </div>`;
    }).join("");

    el.innerHTML = `
      <div class="bg3ib-header">${esc(combat.started ? loc("BG3IB.Round", { round: combat.round }) : loc("BG3IB.NotStarted"))}</div>
      <div class="bg3ib-track">${cards}</div>
      ${this._controlsHTML(combat)}`;

    el.classList.add("bg3ib-visible");

    // Запоминаем инициативы для анимации следующего рендера
    this.prevInitiative = new Map(turns.map(c => [c.id, c.initiative ?? null]));

    // Держим активного персонажа в поле зрения
    el.querySelector(".bg3ib-card.active")?.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" });
  }

  _controlsHTML(combat) {
    const loc = k => esc(game.i18n.localize(k));
    const btn = (action, icon, label) =>
      `<button type="button" data-action="${action}" data-tooltip="${label}"><i class="fas ${icon}"></i></button>`;

    if (game.user.isGM) {
      if (!combat.started) {
        return `<div class="bg3ib-controls">
          ${btn("gather", "fa-user-plus", loc("BG3IB.AddFighters"))}
          ${btn("rollNPC", "fa-users", loc("BG3IB.RollNPC"))}
          ${btn("rollAll", "fa-dice-d20", loc("BG3IB.RollAll"))}
          <button type="button" class="bg3ib-start" data-action="start">${loc("BG3IB.StartCombat")}</button>
        </div>`;
      }
      return `<div class="bg3ib-controls">
        ${btn("gather", "fa-user-plus", loc("BG3IB.AddFighters"))}
        ${btn("prev", "fa-caret-left", loc("BG3IB.PrevTurn"))}
        ${btn("next", "fa-caret-right", loc("BG3IB.NextTurn"))}
        ${btn("end", "fa-flag-checkered", loc("BG3IB.EndCombat"))}
      </div>`;
    }

    if (combat.started && combat.combatant?.isOwner) {
      return `<div class="bg3ib-controls">
        <button type="button" class="bg3ib-start" data-action="next">${loc("BG3IB.EndTurn")}</button>
      </div>`;
    }
    return "";
  }

  /* ---------------- События ---------------- */

  async _onClick(event) {
    if (event.target.closest("[data-action=gather]")) return openCombatSetup();
    const combat = this.combat;
    if (!combat) return;

    const actionEl = event.target.closest("[data-action]");
    const cardEl = event.target.closest(".bg3ib-card");
    const combatant = cardEl ? combat.combatants.get(cardEl.dataset.combatantId) : null;
    const action = actionEl?.dataset.action;

    try {
      switch (action) {
        case "roll":
          event.stopPropagation();
          return await this._roll(combat, combatant);
        case "rollNPC": return await combat.rollNPC();
        case "rollAll": return await combat.rollAll();
        case "start": return await combat.startCombat();
        case "prev": return await combat.previousTurn();
        case "next": return await combat.nextTurn();
        case "end": return await combat.endCombat();
      }
    } catch (err) {
      console.error(`${MODULE_ID} |`, err);
      ui.notifications.error(err.message);
      return;
    }

    // Клик по портрету без броска — показать токен на карте
    if (combatant) this._panToToken(combatant);
  }

  async _roll(combat, combatant) {
    if (!combatant?.isOwner || this.rolling.has(combatant.id)) return;
    if (combatant.initiative !== null && combatant.initiative !== undefined) return;
    this.rolling.add(combatant.id);
    this._render();
    try {
      await combat.rollInitiative([combatant.id]);
    } finally {
      this.rolling.delete(combatant.id);
      this.render();
    }
  }

  _panToToken(combatant) {
    const token = combatant.token?.object;
    if (!token || !token.visible || !canvas?.ready) return;
    canvas.animatePan({ x: token.center.x, y: token.center.y, duration: 250 });
    if (combatant.isOwner) token.control({ releaseOthers: true });
  }
}

/* ---------------- Регистрация ---------------- */

Hooks.once("init", () => {
  const rerender = () => bar?.render();

  game.settings.register(MODULE_ID, "ib-showToPlayers", {
    name: "BG3IB.Settings.ShowToPlayers.Name",
    hint: "BG3IB.Settings.ShowToPlayers.Hint",
    scope: "world", config: true, type: Boolean, default: true, onChange: rerender
  });
  game.settings.register(MODULE_ID, "ib-gatherButton", {
    name: "BG3IB.Settings.GatherButton.Name",
    hint: "BG3IB.Settings.GatherButton.Hint",
    scope: "client", config: true, type: Boolean, default: true, onChange: rerender
  });
  game.keybindings.register(MODULE_ID, "ib-gather", {
    name: "BG3IB.Gather",
    hint: "BG3IB.GatherHint",
    editable: [],
    restricted: true,
    onDown: () => { openCombatSetup(); return true; }
  });
  game.settings.register(MODULE_ID, "ib-showHP", {
    name: "BG3IB.Settings.ShowHP.Name",
    hint: "BG3IB.Settings.ShowHP.Hint",
    scope: "world", config: true, type: Boolean, default: true, onChange: rerender
  });
  game.settings.register(MODULE_ID, "ib-imageSource", {
    name: "BG3IB.Settings.ImageSource.Name",
    hint: "BG3IB.Settings.ImageSource.Hint",
    scope: "client", config: true, type: String, default: "actor",
    choices: {
      actor: "BG3IB.Settings.ImageSource.Actor",
      token: "BG3IB.Settings.ImageSource.Token"
    },
    onChange: rerender
  });
  game.settings.register(MODULE_ID, "ib-topOffset", {
    name: "BG3IB.Settings.TopOffset.Name",
    hint: "BG3IB.Settings.TopOffset.Hint",
    scope: "client", config: true, type: Number, default: 12,
    range: { min: 0, max: 300, step: 2 }, onChange: rerender
  });
  game.settings.register(MODULE_ID, "ib-portraitSize", {
    name: "BG3IB.Settings.PortraitSize.Name",
    hint: "BG3IB.Settings.PortraitSize.Hint",
    scope: "client", config: true, type: Number, default: 64,
    range: { min: 40, max: 120, step: 4 }, onChange: rerender
  });
});

// Кнопка «Собрать бой» на панели токенов (слева), только мастеру
Hooks.on("getSceneControlButtons", (controls) => {
  if (!game.user.isGM) return;
  const tool = { name: "rpg-suite-gather", title: "BG3IB.Gather", icon: "fas fa-swords", button: true, visible: true };
  if (Array.isArray(controls)) {
    controls.find((c) => c.name === "token")?.tools.push({ ...tool, onClick: () => openCombatSetup() });
  } else if (controls.tokens?.tools) {
    controls.tokens.tools[tool.name] = { ...tool, order: Object.keys(controls.tokens.tools).length + 1, onChange: () => openCombatSetup() };
  }
});

Hooks.once("ready", () => {
  bar = new InitiativeBar();

  const rerender = () => bar.render();
  for (const hook of [
    "createCombat", "updateCombat", "deleteCombat",
    "createCombatant", "updateCombatant", "deleteCombatant",
    "updateActor", "updateToken", "canvasReady"
  ]) Hooks.on(hook, rerender);

  bar.render();
});
