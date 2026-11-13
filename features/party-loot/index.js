/**
 * Party Loot Roll — награда партии после боя (Foundry VTT v13, dnd5e)
 *
 * 1. Мастер завершает бой → в чат (только мастеру) приходит карточка с кнопкой «Наградить игроков».
 * 2. В окне награды мастер перетаскивает предметы из компендиумов/сайдбара, вводит золото,
 *    отмечает участников и подтверждает.
 * 3. Золото делится поровну (с округлением вниз) и сразу зачисляется персонажам.
 * 4. За каждый предмет у каждого игрока появляется окно в стиле WoW с таймером:
 *    «Нужно» / «На продажу» / «Не нужно». «Нужно» важнее «На продажу»; среди равных — бросок d100.
 */

import { SUITE_ID } from "../../core/constants.js";
import { suiteSocket } from "../../core/socket.js";
import { createFeatureHooks } from "../../core/feature-hooks.js";

/** Функция «Награда партии» внутри RPG Suite.
 *  Настройки: "rpg-tools-by-hibear.loot-*", флаги: flags["rpg-tools-by-hibear"].loot.*, сокет: suiteSocket "loot". */
const MODULE_ID = SUITE_ID;
const FEATURE = "loot";
const SK = (k) => `loot-${k}`;
const Hooks = createFeatureHooks();

/** API для макросов: game.rpgSuite.api.loot.openReward() */
export const api = { openReward: (ids) => openReward(ids) };

export function setup() {
  Hooks.activate();
}
const { ApplicationV2, DialogV2 } = foundry.applications.api;

const esc = (s) => Handlebars.escapeExpression(String(s ?? ""));

const RARITY = {
  common:    { label: "Обычный",      color: "#ffffff" },
  uncommon:  { label: "Необычный",    color: "#1eff00" },
  rare:      { label: "Редкий",       color: "#0070dd" },
  veryRare:  { label: "Очень редкий", color: "#a335ee" },
  legendary: { label: "Легендарный",  color: "#ff8000" },
  artifact:  { label: "Артефакт",     color: "#e6cc80" }
};
const rarityOf = (r) => RARITY[r] ?? { label: "", color: "#9d9d9d" };

const CHOICES = {
  need:  { label: "Нужно",      icon: "fa-solid fa-dice-d20", rank: 2 },
  greed: { label: "На продажу", icon: "fa-solid fa-coins",    rank: 1 },
  pass:  { label: "Не нужно",   icon: "fa-solid fa-xmark",    rank: 0 }
};

/* -------------------------------------------- */
/*  Helpers                                     */
/* -------------------------------------------- */

function getDragData(event) {
  const TE = foundry.applications?.ux?.TextEditor?.implementation ?? globalThis.TextEditor;
  try { return TE.getDragEventData(event); } catch { return null; }
}

/** Персонажи игроков, участвовавшие в бою (базовые актёры, без дублей). */
function partyFromCombat(combat) {
  const ids = new Set();
  for (const c of combat.combatants ?? []) {
    const actor = game.actors.get(c.actorId);
    if (actor?.hasPlayerOwner && actor.type === "character") ids.add(actor.id);
  }
  return [...ids];
}

/** Партия по умолчанию: выделенные токены игроков, иначе назначенные игрокам персонажи. */
function defaultParty() {
  const fromTokens = (canvas?.tokens?.controlled ?? [])
    .map((t) => t.actor && game.actors.get(t.actor.id))
    .filter((a) => a?.hasPlayerOwner);
  if (fromTokens.length) return [...new Set(fromTokens.map((a) => a.id))];
  return [...new Set(game.users.filter((u) => !u.isGM && u.character).map((u) => u.character.id))];
}

/** Активный игрок, управляющий актёром (null → решает мастер). */
function findUserForActor(actor) {
  const active = game.users.filter((u) => u.active && !u.isGM);
  return active.find((u) => u.character?.id === actor.id)
    ?? active.find((u) => actor.testUserPermission(u, "OWNER"))
    ?? null;
}

function itemTypeLabel(item) {
  const key = CONFIG.Item.typeLabels?.[item.type];
  return key ? game.i18n.localize(key) : item.type;
}

async function rollD100() {
  const r = await new Roll("1d100").evaluate();
  return r.total;
}

async function giveItem(entry, actor) {
  const src = await fromUuid(entry.uuid);
  if (!src) {
    ui.notifications.error(`Награда партии: предмет «${entry.name}» не найден (${entry.uuid}).`);
    return false;
  }
  const data = src.toObject();
  delete data._id;
  if (data.system && "quantity" in data.system) data.system.quantity = 1;
  await actor.createEmbeddedDocuments("Item", [data]);
  return true;
}

function openReward(actorIds) {
  if (!game.user.isGM) return ui.notifications.warn("Награду выдаёт только мастер.");
  return new RewardApp(actorIds ?? defaultParty()).render(true);
}

/* -------------------------------------------- */
/*  Окно мастера: «Наградить игроков»           */
/* -------------------------------------------- */

/** Персонажи игроков на текущей сцене: [{ id актёра, name, img токена }] без повторов */
function scenePCs() {
  const out = new Map();
  for (const td of canvas?.scene?.tokens ?? []) {
    const actor = td.actor && game.actors.get(td.actor.id);
    if (!actor?.hasPlayerOwner || out.has(actor.id)) continue;
    out.set(actor.id, { id: actor.id, name: td.name ?? actor.name, img: td.texture?.src || actor.img, tokenId: td.id });
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang));
}

class RewardApp extends ApplicationV2 {
  static instances = new Set();

  constructor(actorIds = [], options = {}) {
    super(options);
    // Участники = персонажи игроков на сцене (галочки) + те, кого передали/перетащили, но их нет на сцене.
    // Отмечены сразу: участники боя (или выделенные/назначенные игрокам персонажи, если окно открыто вручную).
    this.selected = new Set(actorIds.filter((id) => game.actors.get(id)));
    this.extra = [...this.selected];   // кто может отсутствовать на сцене
    this.loot = [];
    this.gold = 0;
  }

  /** Строки списка участников */
  get participants() {
    const onScene = scenePCs();
    const ids = new Set(onScene.map((p) => p.id));
    const rows = onScene.map((p) => ({ ...p, onScene: true, selected: this.selected.has(p.id) }));
    for (const id of this.extra) {
      if (ids.has(id)) continue;
      const a = game.actors.get(id);
      if (a) rows.push({ id, name: a.name, img: a.img, onScene: false, selected: this.selected.has(id) });
    }
    return rows;
  }

  _onFirstRender(context, options) {
    super._onFirstRender?.(context, options);
    RewardApp.instances.add(this);
  }

  _onClose(options) {
    super._onClose?.(options);
    RewardApp.instances.delete(this);
  }

  static DEFAULT_OPTIONS = {
    classes: ["plr-reward"],
    window: { title: "Наградить игроков", icon: "fa-solid fa-sack-dollar", resizable: true },
    position: { width: 580, height: "auto" },
    actions: {
      removeLoot: RewardApp.#onRemoveLoot,
      duplicateLoot: RewardApp.#onDuplicateLoot,
      toggleActor: RewardApp.#onToggleActor,
      removeActor: RewardApp.#onRemoveActor,
      selectControlled: RewardApp.#onSelectControlled,
      selectAll: RewardApp.#onSelectAll,
      selectNone: RewardApp.#onSelectNone,
      inspect: RewardApp.#onInspect,
      confirm: RewardApp.#onConfirm,
      cancel: RewardApp.#onCancel
    }
  };

  get #selectedActors() {
    return this.participants
      .filter((p) => p.selected)
      .map((p) => game.actors.get(p.id))
      .filter(Boolean);
  }

  #ownerNote(actor) {
    const user = findUserForActor(actor);
    if (user) return esc(user.name);
    const owner = game.users.find((u) => !u.isGM && (u.character?.id === actor.id || actor.testUserPermission(u, "OWNER")));
    return `${owner ? `${esc(owner.name)} · ` : ""}не в сети`;
  }

  #shareText() {
    const n = this.#selectedActors.length;
    const gold = Math.max(0, Math.floor(Number(this.gold) || 0));
    if (!n) return "Нет выбранных участников";
    const share = Math.floor(gold / n);
    const rest = gold - share * n;
    return `Каждому: <b>${share} зм</b> × ${n}` + (rest ? ` <span class="plr-rest">(остаток ${rest} зм не делится)</span>` : "");
  }

  async _renderHTML() {
    const rows = this.participants;
    const actorRows = rows.length
      ? rows.map((p) => {
        const actor = game.actors.get(p.id);
        const note = p.onScene ? this.#ownerNote(actor) : "нет на сцене";
        return `
        <li class="plr-actor ${p.selected ? "" : "off"}">
          <label>
            <input type="checkbox" data-action="toggleActor" data-id="${p.id}" ${p.selected ? "checked" : ""}>
            <img src="${esc(p.img)}" alt="">
            <span class="name">${esc(p.name)}</span>
            <small class="note" data-tooltip="${note}">${note}</small>
          </label>
          ${p.onScene ? "" : `<a class="plr-icon" data-action="removeActor" data-id="${p.id}" data-tooltip="Убрать из списка"><i class="fa-solid fa-trash"></i></a>`}
        </li>`;
      }).join("")
      : `<li class="plr-empty">На сцене нет персонажей игроков — перетащите их сюда из сайдбара</li>`;
    const nSel = rows.filter((p) => p.selected).length;

    const lootRows = this.loot.length
      ? this.loot.map((l) => {
        const r = rarityOf(l.rarity);
        return `
        <li class="plr-loot" style="--rarity:${r.color}">
          <img src="${esc(l.img)}" alt="" data-action="inspect" data-key="${l.key}" data-tooltip="Открыть предмет">
          <div class="info">
            <span class="name">${esc(l.name)}</span>
            <span class="meta">${esc([r.label, l.typeLabel].filter(Boolean).join(" · "))}</span>
          </div>
          <a class="plr-icon" data-action="duplicateLoot" data-key="${l.key}" data-tooltip="Ещё один такой"><i class="fa-solid fa-clone"></i></a>
          <a class="plr-icon" data-action="removeLoot" data-key="${l.key}" data-tooltip="Убрать"><i class="fa-solid fa-trash"></i></a>
        </li>`;
      }).join("")
      : "";

    return `
      <section class="plr-section">
        <h3><i class="fa-solid fa-users"></i> Кому награда <span class="plr-count">${nSel} из ${rows.length}</span></h3>
        <ul class="plr-actors plr-drop-actors">${actorRows}</ul>
        <div class="plr-select-row">
          <button type="button" data-action="selectControlled"><i class="fa-solid fa-object-group"></i> Выделенные на карте</button>
          <button type="button" data-action="selectAll"><i class="fa-solid fa-users"></i> Все персонажи игроков</button>
          <button type="button" data-action="selectNone"><i class="fa-regular fa-square"></i> Снять</button>
        </div>
      </section>

      <section class="plr-section">
        <h3><i class="fa-solid fa-gem"></i> Предметы</h3>
        <div class="plr-drop">
          <ul class="plr-loot-list">${lootRows}</ul>
          <div class="plr-drop-hint"><i class="fa-solid fa-hand-holding-hand"></i>
            Перетащите предметы из компендиума, сайдбара или инвентаря</div>
        </div>
      </section>

      <section class="plr-section plr-gold">
        <h3><i class="fa-solid fa-coins"></i> Золото</h3>
        <div class="plr-gold-row">
          <input type="number" min="0" step="1" name="gold" value="${Number(this.gold) || 0}">
          <span class="plr-unit">зм</span>
          <span class="plr-share">${this.#shareText()}</span>
        </div>
      </section>

      <footer class="plr-footer">
        <button type="button" data-action="cancel"><i class="fa-solid fa-xmark"></i> Отмена</button>
        <button type="button" class="plr-confirm" data-action="confirm"><i class="fa-solid fa-check"></i> Выдать награду</button>
      </footer>`;
  }

  _replaceHTML(result, content) {
    content.innerHTML = result;

    const gold = content.querySelector("input[name=gold]");
    gold.addEventListener("input", () => {
      this.gold = gold.value;
      content.querySelector(".plr-share").innerHTML = this.#shareText();
    });

    for (const zone of content.querySelectorAll(".plr-drop, .plr-drop-actors")) {
      zone.addEventListener("dragover", (ev) => { ev.preventDefault(); zone.classList.add("hover"); });
      zone.addEventListener("dragleave", () => zone.classList.remove("hover"));
      zone.addEventListener("drop", (ev) => { zone.classList.remove("hover"); this.#onDrop(ev); });
    }
  }

  async #onDrop(event) {
    event.preventDefault();
    const data = getDragData(event);
    if (!data) return;

    if (data.type === "Item") {
      const item = data.uuid ? await fromUuid(data.uuid) : null;
      if (!item) return ui.notifications.warn("Не удалось прочитать предмет.");
      this.loot.push({
        key: foundry.utils.randomID(),
        uuid: item.uuid,
        name: item.name,
        img: item.img,
        rarity: item.system?.rarity ?? "",
        typeLabel: itemTypeLabel(item)
      });
      return this.render();
    }

    if (data.type === "Actor") {
      const dropped = data.uuid ? await fromUuid(data.uuid) : null;
      const actor = dropped && game.actors.get(dropped.id);
      if (!actor) return;
      if (!this.extra.includes(actor.id)) this.extra.push(actor.id);
      this.selected.add(actor.id);
      return this.render();
    }

    ui.notifications.warn("Сюда можно перетащить только предметы или персонажей.");
  }

  static #onRemoveLoot(event, target) {
    this.loot = this.loot.filter((l) => l.key !== target.dataset.key);
    this.render();
  }

  static #onDuplicateLoot(event, target) {
    const src = this.loot.find((l) => l.key === target.dataset.key);
    if (src) this.loot.push({ ...src, key: foundry.utils.randomID() });
    this.render();
  }

  static async #onInspect(event, target) {
    const l = this.loot.find((x) => x.key === target.dataset.key);
    const item = l && await fromUuid(l.uuid);
    item?.sheet?.render(true);
  }

  static #onToggleActor(event, target) {
    if (target.checked) this.selected.add(target.dataset.id);
    else this.selected.delete(target.dataset.id);
    this.render();
  }

  static #onRemoveActor(event, target) {
    this.extra = this.extra.filter((id) => id !== target.dataset.id);
    this.selected.delete(target.dataset.id);
    this.render();
  }

  static #onSelectControlled() {
    const ids = (canvas?.tokens?.controlled ?? []).map((t) => t.actor && game.actors.get(t.actor.id)).filter((a) => a?.hasPlayerOwner).map((a) => a.id);
    if (!ids.length) ui.notifications.info("На карте не выделено ни одного токена персонажа игрока.");
    this.selected = new Set(ids);
    for (const id of ids) if (!this.extra.includes(id)) this.extra.push(id);
    this.render();
  }

  static #onSelectAll() {
    this.selected = new Set(this.participants.map((p) => p.id));
    this.render();
  }

  static #onSelectNone() {
    this.selected = new Set();
    this.render();
  }

  static #onCancel() { this.close(); }

  static async #onConfirm() {
    const actors = this.#selectedActors;
    if (!actors.length) return ui.notifications.warn("Выберите хотя бы одного участника.");
    const gold = Math.max(0, Math.floor(Number(this.gold) || 0));
    if (!gold && !this.loot.length) return ui.notifications.warn("Награда пуста.");

    const share = Math.floor(gold / actors.length);
    const rest = gold - share * actors.length;

    const ok = await DialogV2.confirm({
      window: { title: "Подтвердить награду" },
      content: `<p>Участников: <b>${actors.length}</b></p>
        <p>Золото: <b>${gold} зм</b> → по <b>${share} зм</b> каждому${rest ? ` (остаток ${rest} зм)` : ""}</p>
        <p>Предметов на розыгрыш: <b>${this.loot.length}</b></p>`,
      rejectClose: false
    });
    if (!ok) return;

    if (share > 0) {
      for (const a of actors) {
        const cur = Number(a.system?.currency?.gp) || 0;
        await a.update({ "system.currency.gp": cur + share });
      }
    }

    const lootList = this.loot.map((l) =>
      `<li style="--rarity:${rarityOf(l.rarity).color}">${esc(l.name)}</li>`).join("");
    await ChatMessage.create({
      speaker: { alias: "Награда партии" },
      content: `<div class="plr-chat">
        <h3><i class="fa-solid fa-trophy"></i> Награда партии</h3>
        ${gold ? `<p><i class="fa-solid fa-coins"></i> <b>${gold} зм</b> разделено поровну: по <b>${share} зм</b> —
          ${actors.map((a) => esc(a.name)).join(", ")}${rest ? `. Остаток: ${rest} зм` : ""}.</p>` : ""}
        ${lootList ? `<p>Разыгрываются предметы:</p><ul class="plr-chat-loot">${lootList}</ul>` : ""}
      </div>`
    });

    const loot = [...this.loot];
    await this.close();
    if (loot.length) LootManager.startRolls(loot, actors);
  }
}

/* -------------------------------------------- */
/*  Розыгрыш предметов (логика на стороне ГМа)  */
/* -------------------------------------------- */

// Окно «Наградить игроков» обновляет список, когда меняются токены на сцене
for (const hook of ["createToken", "deleteToken", "canvasReady", "userConnected"]) {
  Hooks.on(hook, () => { for (const app of RewardApp.instances) if (app.rendered) app.render(); });
}

class LootManager {
  static pending = new Map();

  static get duration() {
    return Math.max(10, Number(game.settings.get(MODULE_ID, SK("rollDuration"))) || 60);
  }

  static startRolls(loot, actors) {
    for (const entry of loot) this.#start(entry, actors);
  }

  static #start(entry, actors) {
    const rollId = foundry.utils.randomID();
    const duration = this.duration;
    const participants = actors.map((a) => {
      const u = findUserForActor(a);
      return { actorId: a.id, actorName: a.name, userId: u?.id ?? null, offline: !u };
    });

    const state = { rollId, entry, participants, choices: {}, resolved: false };
    // Игрок не в сети — сразу «Не нужно»
    for (const p of participants) if (p.offline) state.choices[p.actorId] = "pass";
    this.pending.set(rollId, state);

    const online = participants.filter((p) => !p.offline);
    if (!online.length) return this.resolve(rollId);

    const payload = {
      type: "start",
      rollId,
      duration,
      item: { uuid: entry.uuid, name: entry.name, img: entry.img, rarity: entry.rarity, typeLabel: entry.typeLabel },
      targets: online.map((p) => ({ userId: p.userId, actorId: p.actorId, actorName: p.actorName }))
    };
    suiteSocket.emit(FEATURE, payload);
    handleSocket(payload);

    state.timer = setTimeout(() => this.resolve(rollId), (duration + 2) * 1000);
  }

  static receiveChoice({ rollId, actorId, userId, choice }) {
    const state = this.pending.get(rollId);
    if (!state || state.resolved || !(choice in CHOICES)) return;
    const p = state.participants.find((x) => x.actorId === actorId);
    if (!p || p.userId !== userId) return;
    state.choices[actorId] = choice;
    if (state.participants.every((x) => x.actorId in state.choices)) this.resolve(rollId);
  }

  static async resolve(rollId) {
    const state = this.pending.get(rollId);
    if (!state || state.resolved) return;
    state.resolved = true;
    clearTimeout(state.timer);
    this.pending.delete(rollId);

    const closeMsg = { type: "close", rollId };
    suiteSocket.emit(FEATURE, closeMsg);
    handleSocket(closeMsg);

    const rows = state.participants.map((p) => ({
      ...p,
      choice: state.choices[p.actorId] ?? "pass",
      timedOut: !p.offline && !(p.actorId in state.choices),
      rolls: []
    }));

    const best = Math.max(...rows.map((r) => CHOICES[r.choice].rank));
    let winner = null;
    if (best > 0) {
      let top = rows.filter((r) => CHOICES[r.choice].rank === best);
      for (let guard = 0; guard < 10; guard++) {
        for (const r of top) r.rolls.push(await rollD100());
        const max = Math.max(...top.map((r) => r.rolls.at(-1)));
        top = top.filter((r) => r.rolls.at(-1) === max);
        if (top.length === 1) break;
      }
      winner = top[0];
    }

    let given = false;
    if (winner) {
      const actor = game.actors.get(winner.actorId);
      if (actor) given = await giveItem(state.entry, actor);
    }

    const r = rarityOf(state.entry.rarity);
    const order = rows.sort((a, b) =>
      (CHOICES[b.choice].rank - CHOICES[a.choice].rank) || ((b.rolls.at(-1) ?? 0) - (a.rolls.at(-1) ?? 0)));
    const tableRows = order.map((row) => `
      <tr class="${row === winner ? "win" : ""}">
        <td>${esc(row.actorName)}</td>
        <td class="c-${row.choice}"><i class="${CHOICES[row.choice].icon}"></i> ${CHOICES[row.choice].label}${row.offline ? " (не в сети)" : row.timedOut ? " (время вышло)" : ""}</td>
        <td class="roll">${row.rolls.length ? row.rolls.join(" → ") : "—"}</td>
      </tr>`).join("");

    const verdict = winner
      ? `<p class="plr-verdict"><b>${esc(winner.actorName)}</b> получает предмет
         (${CHOICES[winner.choice].label.toLowerCase()}, бросок ${winner.rolls.at(-1)})${given ? "" : " — <i>не удалось добавить, выдайте вручную</i>"}.</p>`
      : `<p class="plr-verdict">Все отказались — предмет никому не достался.</p>`;

    await ChatMessage.create({
      speaker: { alias: "Розыгрыш добычи" },
      content: `<div class="plr-chat">
        <div class="plr-chat-item" style="--rarity:${r.color}">
          <img src="${esc(state.entry.img)}" alt="">
          <span style="color:${r.color}">${esc(state.entry.name)}</span>
        </div>
        <table class="plr-chat-table"><tbody>${tableRows}</tbody></table>
        ${verdict}
      </div>`
    });
  }
}

/* -------------------------------------------- */
/*  Окно игрока: Нужно / На продажу / Не нужно  */
/* -------------------------------------------- */

/**
 * Всплывающее окно розыгрыша у игрока. Это не окно Foundry, а свой блок в фиксированном контейнере
 * по центру вверху экрана: так оно всегда видно, не уезжает под чат и не ломает раскладку.
 * Несколько предметов складываются стопкой.
 */
class LootRollApp {
  static open = new Map();

  static container() {
    let el = document.getElementById("plr-roll-stack");
    if (!el) {
      el = document.createElement("div");
      el.id = "plr-roll-stack";
      document.body.appendChild(el);
    }
    return el;
  }

  constructor(data, target) {
    this.id = `plr-roll-${data.rollId}-${target.actorId}`;
    this.data = data;
    this.target = target;
    this.sent = false;
    this.element = null;
  }

  static closeRoll(rollId) {
    for (const app of [...LootRollApp.open.values()]) {
      if (app.data.rollId === rollId) { app.sent = true; app.close(); }
    }
  }

  render() {
    if (this.element) return this;
    const it = this.data.item;
    const r = rarityOf(it.rarity);
    const el = document.createElement("div");
    el.className = "plr-roll-frame";
    el.id = this.id;
    el.style.setProperty("--rarity", r.color);
    el.innerHTML = `
        <div class="plr-roll-top">
          <img class="plr-roll-icon" src="${esc(it.img)}" alt="" data-act="inspect" data-tooltip="Посмотреть предмет">
          <div class="plr-roll-info">
            <div class="plr-roll-name">${esc(it.name)}</div>
            <div class="plr-roll-meta">${esc([r.label, it.typeLabel].filter(Boolean).join(" · "))}</div>
            <div class="plr-roll-for">для: ${esc(this.target.actorName)}</div>
          </div>
          <div class="plr-roll-buttons">
            ${Object.entries(CHOICES).map(([k, c]) => `
              <button type="button" class="plr-btn plr-btn-${k}" data-act="choose" data-choice="${k}" data-tooltip="${c.label}">
                <i class="${c.icon}"></i>
              </button>`).join("")}
          </div>
        </div>
        <div class="plr-timer"><div class="plr-timer-bar"></div><span class="plr-timer-text"></span></div>`;
    el.addEventListener("click", (ev) => {
      const b = ev.target.closest("[data-act]");
      if (!b) return;
      if (b.dataset.act === "choose") { this.#send(b.dataset.choice); this.close(); }
      else if (b.dataset.act === "inspect") this.#inspect();
    });
    LootRollApp.container().appendChild(el);
    this.element = el;
    LootRollApp.open.set(this.id, this);

    this._started = Date.now();
    const total = this.data.duration * 1000;
    const bar = el.querySelector(".plr-timer-bar");
    const txt = el.querySelector(".plr-timer-text");
    const tick = () => {
      const left = Math.max(0, total - (Date.now() - this._started));
      bar.style.width = `${(left / total) * 100}%`;
      txt.textContent = `${Math.ceil(left / 1000)} с`;
      if (left <= 0) { this.#send("pass"); this.close(); }
    };
    tick();
    this._interval = setInterval(tick, 100);
    return this;
  }

  close() {
    clearInterval(this._interval);
    LootRollApp.open.delete(this.id);
    const el = this.element;
    this.element = null;
    if (!el) return;
    el.classList.add("closing");
    setTimeout(() => el.remove(), 200);
  }

  #send(choice) {
    if (this.sent) return;
    this.sent = true;
    const msg = { type: "choice", rollId: this.data.rollId, actorId: this.target.actorId, userId: game.user.id, choice };
    suiteSocket.emit(FEATURE, msg);
    if (game.user.isGM) LootManager.receiveChoice(msg);
  }

  async #inspect() {
    try { (await fromUuid(this.data.item.uuid))?.sheet?.render(true); }
    catch { ui.notifications.warn("Нет доступа к этому предмету."); }
  }
}

/* -------------------------------------------- */
/*  Сокет                                       */
/* -------------------------------------------- */

function handleSocket(data) {
  switch (data?.type) {
    case "start":
      for (const t of data.targets) {
        if (t.userId === game.user.id) new LootRollApp(data, t).render();
      }
      break;
    case "choice":
      if (game.user.isGM) LootManager.receiveChoice(data);
      break;
    case "close":
      LootRollApp.closeRoll(data.rollId);
      break;
  }
}

/* -------------------------------------------- */
/*  Хуки                                        */
/* -------------------------------------------- */

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, SK("rollDuration"), {
    name: "Награда партии · Время на выбор (сек)",
    hint: "Сколько секунд у игрока на «Нужно / На продажу / Не нужно». По истечении — «Не нужно».",
    scope: "world", config: true, type: Number, default: 60
  });
  game.settings.register(MODULE_ID, SK("promptAfterCombat"), {
    name: "Награда партии · Предлагать награду после боя",
    hint: "После завершения боя мастеру приходит карточка с кнопкой «Наградить игроков».",
    scope: "world", config: true, type: Boolean, default: true
  });
  game.settings.register(MODULE_ID, SK("autoOpen"), {
    name: "Награда партии · Сразу открывать окно награды",
    hint: "Вместо карточки в чате сразу открывать окно награды после боя.",
    scope: "world", config: true, type: Boolean, default: false
  });
});

Hooks.once("ready", () => {
  suiteSocket.on(FEATURE, handleSocket);
});

/* Маленькая кнопка «Наградить игроков» для мастера: панель инструментов токенов слева */
Hooks.on("getSceneControlButtons", (controls) => {
  if (!game.user?.isGM) return;
  const tokens = controls.tokens ?? controls.token;
  if (!tokens?.tools) return;
  tokens.tools.partyLootReward = {
    name: "partyLootReward",
    title: "Наградить игроков",
    icon: "fa-solid fa-sack-dollar",
    order: Object.keys(tokens.tools).length + 1,
    button: true,
    visible: true,
    onChange: () => openReward()
  };
});

/* Та же кнопка в шапке трекера боя */
Hooks.on("renderCombatTracker", (app, html) => {
  if (!game.user.isGM) return;
  const root = html instanceof HTMLElement ? html : html?.[0];
  if (!root || root.querySelector(".plr-tracker-btn")) return;
  const header = root.querySelector(".combat-tracker-header") ?? root.querySelector("header");
  if (!header) return;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "plr-tracker-btn";
  btn.dataset.tooltip = "Наградить игроков";
  btn.innerHTML = '<i class="fa-solid fa-sack-dollar"></i> Наградить';
  btn.addEventListener("click", (ev) => {
    ev.preventDefault();
    const ids = app.viewed ? partyFromCombat(app.viewed) : [];
    openReward(ids.length ? ids : undefined);
  });
  header.append(btn);
});

Hooks.on("deleteCombat", (combat, options, userId) => {
  if (!game.user.isGM || userId !== game.user.id) return;
  if (!game.settings.get(MODULE_ID, SK("promptAfterCombat"))) return;
  const actorIds = partyFromCombat(combat);
  if (!actorIds.length) return;

  if (game.settings.get(MODULE_ID, SK("autoOpen"))) return openReward(actorIds);

  const names = actorIds.map((id) => esc(game.actors.get(id)?.name)).join(", ");
  ChatMessage.create({
    speaker: { alias: "Награда партии" },
    whisper: game.users.filter((u) => u.isGM).map((u) => u.id),
    flags: { [MODULE_ID]: { loot: { actorIds } } },
    content: `<div class="plr-chat plr-chat-prompt">
      <h3><i class="fa-solid fa-flag-checkered"></i> Бой окончен</h3>
      <p>Участники: ${names}</p>
      <button type="button" class="plr-open-btn"><i class="fa-solid fa-sack-dollar"></i> Наградить игроков</button>
    </div>`
  });
});

Hooks.on("renderChatMessageHTML", (message, html) => {
  const btn = html.querySelector(".plr-open-btn");
  if (!btn) return;
  if (!game.user.isGM) return btn.remove();
  btn.addEventListener("click", (ev) => {
    ev.preventDefault();
    openReward(message.getFlag(MODULE_ID, "loot.actorIds") ?? defaultParty());
  });
});
