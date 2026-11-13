/**
 * GM Whisper — Шепот Мастера
 * Foundry VTT v12–v13
 *
 * Хранение: история переписки с каждым игроком лежит во флагах ЕГО документа User:
 *   flags.gm-whisper.history.<msgId> = { id, from, text, ts, group }
 * Прочитанность:
 *   игрок — flags.gm-whisper.lastRead (число, ts) на своём User
 *   ГМ    — flags.gm-whisper.lastRead.<playerId> на своём User
 * Оповещения в реальном времени идут через сокет module.gm-whisper.
 */

import { SUITE_ID } from "../../core/constants.js";
import { suiteSocket } from "../../core/socket.js";
import { createFeatureHooks } from "../../core/feature-hooks.js";

/** Функция «Шёпот мастера» внутри RPG-Tools.
 *  Настройки: "rpg-tools-by-hibear.gmw-*", история: user.flags["rpg-tools-by-hibear"].gmw.*, сокет: suiteSocket "whisper". */
const MOD = SUITE_ID;
const FEATURE = "whisper";
const TOOL = "rpgtWhisper";
const Hooks = createFeatureHooks();

/** API для макросов: game.rpgSuite.api.whisper.open() / .openThread(userId) */
export const api = {};

export function setup() {
  Hooks.activate();
}
const { ApplicationV2, DialogV2 } = foundry.applications.api;

/* -------------------------------------------- */
/*  Утилиты                                     */
/* -------------------------------------------- */

const L = (key, data) =>
  data ? game.i18n.format(`GMWHISPER.${key}`, data) : game.i18n.localize(`GMWHISPER.${key}`);

const ESC_MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC_MAP[c]);
const fmtText = (t) => esc(t).replace(/\n/g, "<br>");
const userColor = (u) => u?.color?.css ?? String(u?.color ?? "#999999");
const avatar = (u) => u?.avatar || "icons/svg/mystery-man.svg";
const displayName = (u) => {
  if (!u) return "???";
  const c = u.character?.name;
  return c ? `${u.name} (${c})` : u.name;
};

function fmtTime(ts) {
  const d = new Date(ts);
  const lang = game.i18n.lang || undefined;
  const time = d.toLocaleTimeString(lang, { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === new Date().toDateString()
    ? time
    : `${d.toLocaleDateString(lang)} ${time}`;
}

/** Заменить содержимое окна, сохранив фокус и курсор в textarea. */
function replaceKeepingFocus(content, result) {
  const active = document.activeElement;
  const hadFocus = active?.tagName === "TEXTAREA" && content.contains(active);
  content.replaceChildren(result);
  if (hadFocus) {
    const ta = content.querySelector("textarea");
    if (ta) {
      ta.focus();
      const n = ta.value.length;
      ta.setSelectionRange(n, n);
    }
  }
}

/* -------------------------------------------- */
/*  Данные переписки                            */
/* -------------------------------------------- */

function getThread(playerId) {
  const raw = game.users.get(playerId)?.getFlag(MOD, "gmw.history") ?? {};
  return Object.values(raw)
    .filter((m) => m?.id)
    .sort((a, b) => a.ts - b.ts);
}

async function appendToThread(playerId, msg) {
  const user = game.users.get(playerId);
  if (!user) return;
  // Запись по ключу id — без гонок при одновременной отправке с двух сторон
  await user.setFlag(MOD, `gmw.history.${msg.id}`, msg);

  const max = game.settings.get(MOD, "gmw-maxHistory");
  const thread = getThread(playerId);
  if (max > 0 && thread.length > max) {
    const update = {};
    for (const m of thread.slice(0, thread.length - max)) {
      update[`flags.${MOD}.gmw.history.-=${m.id}`] = null;
    }
    await user.update(update);
  }
}

function getLastRead(threadId) {
  return game.user.isGM
    ? game.user.getFlag(MOD, `gmw.lastRead.${threadId}`) ?? 0
    : game.user.getFlag(MOD, "gmw.lastRead") ?? 0;
}

/** Сообщение «входящее» для текущего пользователя? */
function isIncoming(msg, threadId) {
  return game.user.isGM ? msg.from === threadId : msg.from !== game.user.id;
}

function unreadCount(threadId) {
  const lr = getLastRead(threadId);
  return getThread(threadId).filter((m) => isIncoming(m, threadId) && m.ts > lr).length;
}

async function markRead(threadId) {
  const latest = getThread(threadId).at(-1)?.ts ?? 0;
  if (latest <= getLastRead(threadId)) return;
  if (game.user.isGM) await game.user.setFlag(MOD, `gmw.lastRead.${threadId}`, latest);
  else await game.user.setFlag(MOD, "gmw.lastRead", latest);
}

/* -------------------------------------------- */
/*  Отправка                                    */
/* -------------------------------------------- */

/** ГМ → один или несколько игроков */
async function gmSend(text, recipientIds) {
  text = text.trim();
  if (!text || !recipientIds.length) return false;
  const group = recipientIds.length > 1 ? [...recipientIds] : null;
  const ts = Date.now();
  for (const pid of recipientIds) {
    await appendToThread(pid, { id: foundry.utils.randomID(), from: game.user.id, text, ts, group });
  }
  suiteSocket.emit(FEATURE, { type: "whisper", from: game.user.id, to: recipientIds });
  return true;
}

/** Игрок → ГМ (в свою же ветку) */
async function playerSend(text) {
  text = text.trim();
  if (!text) return false;
  await appendToThread(game.user.id, {
    id: foundry.utils.randomID(),
    from: game.user.id,
    text,
    ts: Date.now(),
    group: null
  });
  suiteSocket.emit(FEATURE, { type: "reply", from: game.user.id });
  return true;
}

/* -------------------------------------------- */
/*  Звук                                        */
/* -------------------------------------------- */

let audioCtx = null;

function chime(ctx, volume) {
  const now = ctx.currentTime;
  const master = ctx.createGain();
  master.gain.value = volume;
  master.connect(ctx.destination);

  // Два мягких тона
  for (const [freq, t] of [[880, 0], [1318.5, 0.13]]) {
    const o = ctx.createOscillator();
    o.type = "sine";
    o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now + t);
    g.gain.exponentialRampToValueAtTime(0.3, now + t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, now + t + 0.7);
    o.connect(g).connect(master);
    o.start(now + t);
    o.stop(now + t + 0.75);
  }

  // Лёгкое «шшш» — дыхание шепота
  const len = Math.floor(ctx.sampleRate * 0.45);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  const noise = ctx.createBufferSource();
  noise.buffer = buf;
  const bp = ctx.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = 3500;
  bp.Q.value = 0.8;
  const ng = ctx.createGain();
  ng.gain.setValueAtTime(0.0001, now);
  ng.gain.exponentialRampToValueAtTime(0.06, now + 0.12);
  ng.gain.exponentialRampToValueAtTime(0.0001, now + 0.45);
  noise.connect(bp).connect(ng).connect(master);
  noise.start(now);
}

/** Играет ТОЛЬКО локально — его слышит лишь тот, кому пришёл шепот. */
async function playSound() {
  const volume = game.settings.get(MOD, "gmw-volume");
  if (volume <= 0) return;
  const src = game.settings.get(MOD, "gmw-soundPath");
  try {
    if (src) {
      const AH = foundry.audio?.AudioHelper ?? globalThis.AudioHelper;
      await AH.play({ src, volume, autoplay: true, loop: false }, false); // false = не транслировать другим
      return;
    }
    audioCtx ??= new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") await audioCtx.resume();
    chime(audioCtx, volume);
  } catch (err) {
    console.warn(`${MOD} | sound failed`, err);
  }
}

/* -------------------------------------------- */
/*  Иконка-оповещение по центру экрана          */
/* -------------------------------------------- */

const Notifier = {
  counts: new Map(), // threadId -> количество новых
  el: null,

  add(threadId, n = 1) {
    this.counts.set(threadId, (this.counts.get(threadId) ?? 0) + n);
    this.render(true);
  },

  clear(threadId) {
    if (!this.counts.delete(threadId)) return;
    this.render();
  },

  dismiss() {
    this.counts.clear();
    this.render();
  },

  open() {
    const ids = [...this.counts.keys()];
    this.counts.clear();
    this.render();
    ids.forEach((id) => openThread(id));
  },

  render(bump = false) {
    if (!this.counts.size) {
      this.el?.remove();
      this.el = null;
      return;
    }
    if (!this.el) {
      this.el = document.createElement("div");
      this.el.id = "gm-whisper-notify";
      this.el.innerHTML = `
        <div class="gmw-bump">
          <div class="gmw-notify-box">
            <span class="gmw-notify-bubble"><i></i><i></i><i></i></span>
            <span class="gmw-badge"></span>
          </div>
        </div>
        <div class="gmw-notify-label"></div>`;
      this.el.addEventListener("click", (ev) => {
        ev.preventDefault();
        this.open();
      });
      this.el.addEventListener("contextmenu", (ev) => {
        ev.preventDefault();
        this.dismiss();
      });
      document.body.append(this.el);
    }

    const total = [...this.counts.values()].reduce((a, b) => a + b, 0);
    let label;
    if (!game.user.isGM) label = L("NotifyPlayer");
    else if (this.counts.size === 1) {
      label = L("NotifyGMOne", { name: game.users.get([...this.counts.keys()][0])?.name ?? "???" });
    } else label = L("NotifyGMMany", { n: total });

    this.el.title = L("NotifyHint");
    this.el.classList.toggle("shake", game.settings.get(MOD, "gmw-shake"));
    this.el.querySelector(".gmw-notify-label").textContent = label;
    const badge = this.el.querySelector(".gmw-badge");
    badge.textContent = total > 99 ? "99+" : String(total);
    badge.hidden = total < 1;

    if (bump) {
      const b = this.el.querySelector(".gmw-bump");
      b.classList.remove("bumping");
      void b.offsetWidth; // перезапуск анимации
      b.classList.add("bumping");
    }
  }
};

/* -------------------------------------------- */
/*  Окно ГМа: выбор игроков + текст             */
/* -------------------------------------------- */

class WhisperComposer extends ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: "gm-whisper-composer",
    classes: ["gm-whisper", "gmw-composer"],
    window: { title: "GMWHISPER.ComposerTitle", icon: "gmw-icon", resizable: true },
    position: { width: 400, height: "auto" },
    actions: {
      send: WhisperComposer.#onSend,
      toggleAll: WhisperComposer.#onToggleAll,
      openThread: WhisperComposer.#onOpenThread
    }
  };

  selected = new Set();
  draft = "";
  _sending = false;

  async _renderHTML() {
    const players = game.users.filter((u) => !u.isGM);
    const online = players.filter((u) => u.active);
    for (const id of [...this.selected]) if (!game.users.get(id)?.active) this.selected.delete(id);

    const rows = online
      .map(
        (u) => `
      <li>
        <label class="gmw-player" style="--gmw-user-color:${esc(userColor(u))}">
          <input type="checkbox" name="recipient" value="${u.id}" ${this.selected.has(u.id) ? "checked" : ""}>
          <img class="gmw-avatar" src="${esc(avatar(u))}" alt="">
          <span class="gmw-name">${esc(displayName(u))}</span>
        </label>
      </li>`
      )
      .join("");

    const threads = players
      .map((u) => {
        const n = unreadCount(u.id);
        return `
        <li>
          <button type="button" class="gmw-thread" data-action="openThread" data-user-id="${u.id}">
            <span class="gmw-status ${u.active ? "on" : "off"}" title="${L(u.active ? "Online" : "Offline")}"></span>
            <span class="gmw-name">${esc(displayName(u))}</span>
            ${n ? `<span class="gmw-unread">${n}</span>` : ""}
            <i class="fa-solid fa-comments"></i>
          </button>
        </li>`;
      })
      .join("");

    const el = document.createElement("div");
    el.className = "gmw-root";
    el.innerHTML = `
      <section class="gmw-section">
        <header class="gmw-section-head">
          <span>${L("OnlinePlayers")} (${online.length})</span>
          ${online.length ? `<button type="button" class="gmw-small" data-action="toggleAll">${L("SelectAll")}</button>` : ""}
        </header>
        ${online.length ? `<ul class="gmw-players">${rows}</ul>` : `<p class="gmw-empty">${L("NoPlayersOnline")}</p>`}
      </section>
      <section class="gmw-section">
        <textarea class="gmw-text" placeholder="${esc(L("Placeholder"))}">${esc(this.draft)}</textarea>
        <button type="button" class="gmw-send" data-action="send">
          <span class="gmw-icon"></span> ${L("Send")}
        </button>
      </section>
      <section class="gmw-section">
        <header class="gmw-section-head"><span>${L("Threads")}</span></header>
        ${players.length ? `<ul class="gmw-threads">${threads}</ul>` : `<p class="gmw-empty">${L("NoPlayers")}</p>`}
      </section>`;
    return el;
  }

  _replaceHTML(result, content) {
    replaceKeepingFocus(content, result);
  }

  _onRender() {
    const root = this.element;
    root.querySelectorAll('input[name="recipient"]').forEach((cb) =>
      cb.addEventListener("change", () => {
        if (cb.checked) this.selected.add(cb.value);
        else this.selected.delete(cb.value);
      })
    );
    const ta = root.querySelector("textarea.gmw-text");
    ta?.addEventListener("input", () => (this.draft = ta.value));
    ta?.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) {
        ev.preventDefault();
        this._send();
      }
    });
  }

  async _send() {
    if (this._sending) return;
    const text = this.draft.trim();
    if (!this.selected.size) return ui.notifications.warn(L("NoRecipients"));
    if (!text) return ui.notifications.warn(L("EmptyText"));
    const ids = [...this.selected];
    this._sending = true;
    try {
      await gmSend(text, ids);
      this.draft = "";
      ui.notifications.info(L("Sent", { names: ids.map((id) => game.users.get(id)?.name).join(", ") }));
    } catch (err) {
      console.error(`${MOD} |`, err);
      ui.notifications.error(L("SendError"));
    } finally {
      this._sending = false;
      this.render();
    }
  }

  static async #onSend() {
    await this._send();
  }

  static #onToggleAll() {
    const online = game.users.filter((u) => !u.isGM && u.active).map((u) => u.id);
    const allSelected = online.every((id) => this.selected.has(id));
    this.selected = allSelected ? new Set() : new Set(online);
    this.render();
  }

  static #onOpenThread(event, target) {
    openThread(target.dataset.userId);
  }
}

/* -------------------------------------------- */
/*  Окно переписки (у ГМа — по игроку,           */
/*  у игрока — одна ветка с Мастером)           */
/* -------------------------------------------- */

class WhisperChat extends ApplicationV2 {
  static DEFAULT_OPTIONS = {
    classes: ["gm-whisper", "gmw-chat-app"],
    window: { icon: "gmw-icon", resizable: true },
    position: { width: 380, height: 500 },
    actions: {
      send: WhisperChat.#onSend,
      clear: WhisperChat.#onClear
    }
  };

  constructor(threadId, options = {}) {
    super({ ...options, id: `gm-whisper-chat-${threadId}` });
    this.threadId = threadId;
    this.draft = "";
    this._sending = false;
  }

  get title() {
    return game.user.isGM
      ? L("ChatTitleGM", { name: game.users.get(this.threadId)?.name ?? "???" })
      : L("ChatTitlePlayer");
  }

  _senderName(msg) {
    if (msg.from === game.user.id) return L("You");
    const u = game.users.get(msg.from);
    if (!u) return "???";
    if (u.isGM) return game.user.isGM ? u.name : L("GM");
    return u.name;
  }

  async _renderHTML() {
    const player = game.users.get(this.threadId);
    const thread = getThread(this.threadId);

    const msgs = thread
      .map((m) => {
        const mine = m.from === game.user.id;
        const fromGM = game.users.get(m.from)?.isGM;
        const others = (m.group ?? []).filter((id) => id !== this.threadId).map((id) => game.users.get(id)?.name ?? "???");
        return `
        <li class="gmw-msg ${mine ? "mine" : "theirs"} ${fromGM ? "from-gm" : "from-player"}">
          <div class="gmw-meta">${esc(this._senderName(m))} · ${fmtTime(m.ts)}</div>
          <div class="gmw-bubble">${fmtText(m.text)}</div>
          ${others.length ? `<div class="gmw-group"><i class="fa-solid fa-user-group"></i> ${esc(L("AlsoTo", { names: others.join(", ") }))}</div>` : ""}
        </li>`;
      })
      .join("");

    const toolbar = game.user.isGM
      ? `<div class="gmw-toolbar">
           <span><span class="gmw-status ${player?.active ? "on" : "off"}"></span> ${L(player?.active ? "Online" : "Offline")}</span>
           <button type="button" class="gmw-small gmw-danger" data-action="clear"><i class="fa-solid fa-trash"></i> ${L("Clear")}</button>
         </div>`
      : "";

    const el = document.createElement("div");
    el.className = "gmw-chat";
    el.innerHTML = `
      ${toolbar}
      <ol class="gmw-messages">${msgs || `<li class="gmw-empty">${L("Empty")}</li>`}</ol>
      <div class="gmw-input">
        <textarea placeholder="${esc(L(game.user.isGM ? "Placeholder" : "ReplyPlaceholder"))}">${esc(this.draft)}</textarea>
        <button type="button" data-action="send" title="${esc(L("Send"))}"><i class="fa-solid fa-paper-plane"></i></button>
      </div>`;
    return el;
  }

  _replaceHTML(result, content) {
    replaceKeepingFocus(content, result);
  }

  _onRender() {
    const list = this.element.querySelector(".gmw-messages");
    if (list) list.scrollTop = list.scrollHeight;

    const ta = this.element.querySelector(".gmw-input textarea");
    ta?.addEventListener("input", () => (this.draft = ta.value));
    ta?.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) {
        ev.preventDefault();
        this._send();
      }
    });

    Notifier.clear(this.threadId);
    if (!this.minimized) markRead(this.threadId);
  }

  async _send() {
    if (this._sending) return;
    const text = this.draft.trim();
    if (!text) return;
    this._sending = true;
    try {
      if (game.user.isGM) await gmSend(text, [this.threadId]);
      else await playerSend(text);
      this.draft = "";
    } catch (err) {
      console.error(`${MOD} |`, err);
      ui.notifications.error(L("SendError"));
    } finally {
      this._sending = false;
      this.render();
    }
  }

  static async #onSend() {
    await this._send();
  }

  static async #onClear() {
    const player = game.users.get(this.threadId);
    if (!player) return;
    const ok = await DialogV2.confirm({
      window: { title: L("ClearTitle") },
      content: `<p>${esc(L("ClearConfirm", { name: player.name }))}</p>`
    });
    if (ok) await player.unsetFlag(MOD, "gmw.history");
  }
}

/* -------------------------------------------- */
/*  Открытие окон                               */
/* -------------------------------------------- */

const chatApps = new Map();
let composer = null;

function openThread(threadId) {
  if (!game.users.get(threadId)) return;
  let app = chatApps.get(threadId);
  if (!app) {
    const offset = [...chatApps.values()].filter((a) => a.rendered).length * 30;
    app = new WhisperChat(threadId, {
      position: { left: Math.round(window.innerWidth / 2 - 190 + offset), top: Math.round(window.innerHeight / 2 - 250 + offset) }
    });
    chatApps.set(threadId, app);
  }
  if (app.rendered) {
    if (app.minimized) app.maximize();
    (app.bringToFront ?? app.bringToTop)?.call(app);
    app.render();
  } else {
    app.render({ force: true });
  }
  return app;
}

function openMain() {
  if (game.user.isGM) {
    composer ??= new WhisperComposer();
    if (composer.rendered) (composer.bringToFront ?? composer.bringToTop)?.call(composer);
    composer.render({ force: true });
  } else {
    openThread(game.user.id);
  }
}

function rerenderComposer() {
  if (composer?.rendered) composer.render();
}

/* -------------------------------------------- */
/*  Входящие                                    */
/* -------------------------------------------- */

function incoming(threadId) {
  playSound();
  const app = chatApps.get(threadId);
  if (app?.rendered && !app.minimized) {
    app.render(); // окно уже открыто — просто обновим
    return;
  }
  Notifier.add(threadId);
  rerenderComposer();
}

function onSocket(data) {
  if (!data?.type) return;
  if (data.type === "whisper" && !game.user.isGM && data.to?.includes(game.user.id)) {
    incoming(game.user.id);
  } else if (data.type === "reply" && game.user.isGM) {
    incoming(data.from);
  }
}

/** Непрочитанное с прошлых сессий — показать иконку при входе */
function checkUnreadOnLogin() {
  const ids = game.user.isGM ? game.users.filter((u) => !u.isGM).map((u) => u.id) : [game.user.id];
  for (const id of ids) {
    const n = unreadCount(id);
    if (n) Notifier.add(id, n);
  }
}

/* -------------------------------------------- */
/*  Кнопка в панели управления сценой           */
/* -------------------------------------------- */

function addSceneControl(controls) {
  const title = game.user.isGM ? "GMWHISPER.ControlGM" : "GMWHISPER.ControlPlayer";

  // v12: массив групп
  if (Array.isArray(controls)) {
    const tokens = controls.find((c) => c.name === "token");
    tokens?.tools.push({ name: TOOL, title, icon: "gmw-icon", button: true, onClick: () => openMain() });
    return;
  }

  // v13: объект групп
  const tokens = controls.tokens;
  if (!tokens) return;
  tokens.tools[TOOL] = {
    name: TOOL,
    title,
    icon: "gmw-icon",
    button: true,
    order: Object.keys(tokens.tools).length + 1,
    onChange: () => openMain()
  };
}

/* -------------------------------------------- */
/*  Хуки                                        */
/* -------------------------------------------- */

Hooks.once("init", () => {
  game.settings.register(MOD, "gmw-soundPath", {
    name: "GMWHISPER.Settings.SoundPath",
    hint: "GMWHISPER.Settings.SoundPathHint",
    scope: "client",
    config: true,
    type: String,
    default: "",
    filePicker: "audio"
  });
  game.settings.register(MOD, "gmw-volume", {
    name: "GMWHISPER.Settings.Volume",
    hint: "GMWHISPER.Settings.VolumeHint",
    scope: "client",
    config: true,
    type: Number,
    range: { min: 0, max: 1, step: 0.05 },
    default: 0.6
  });
  game.settings.register(MOD, "gmw-shake", {
    name: "GMWHISPER.Settings.Shake",
    hint: "GMWHISPER.Settings.ShakeHint",
    scope: "client",
    config: true,
    type: Boolean,
    default: true,
    onChange: () => Notifier.render()
  });
  game.settings.register(MOD, "gmw-maxHistory", {
    name: "GMWHISPER.Settings.MaxHistory",
    hint: "GMWHISPER.Settings.MaxHistoryHint",
    scope: "world",
    config: true,
    type: Number,
    default: 300
  });

  game.keybindings.register(MOD, "gmw-open", {
    name: "GMWHISPER.Keybinding",
    editable: [{ key: "KeyW", modifiers: ["Alt"] }],
    onDown: () => {
      openMain();
      return true;
    }
  });
});

Hooks.once("ready", () => {
  suiteSocket.on(FEATURE, onSocket);
  checkUnreadOnLogin();
  Object.assign(api, { open: openMain, openThread });
});

Hooks.on("getSceneControlButtons", addSceneControl);

Hooks.on("updateUser", (user, changes) => {
  if (!changes.flags?.[MOD]?.gmw) return;
  const app = chatApps.get(user.id);
  if (app?.rendered) app.render();
  rerenderComposer();
});

Hooks.on("userConnected", (user) => {
  rerenderComposer();
  const app = chatApps.get(user.id);
  if (app?.rendered) app.render();
});
