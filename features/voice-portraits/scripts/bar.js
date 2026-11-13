import { MODULE_ID, VOICE, EMOTIONS, DEFAULT_CONFIG, FALLBACK_IMG, SIZES } from "./constants.js";
import { getSetting, setSetting } from "./settings.js";

/**
 * Где хранится набор портретов: у закреплённого за игроком персонажа (Actor),
 * а если персонажа нет — у самого пользователя.
 */
export function configOwner(user) {
  return user.character ?? user;
}

export function getConfig(user) {
  const stored = configOwner(user).getFlag(MODULE_ID, "vp.config") ?? {};
  const cfg = foundry.utils.mergeObject(foundry.utils.deepClone(DEFAULT_CONFIG), stored, { inplace: false });
  cfg.images ??= {};
  return cfg;
}

export function getEmotion(user) {
  const e = user.getFlag(MODULE_ID, "vp.emotion") || "neutral";
  return EMOTIONS.some(x => x.id === e) ? e : "neutral";   // убранные эмоции (например, «Хитрость») → обычное
}

export function baseImage(user, cfg = getConfig(user)) {
  return cfg.images.neutral || user.character?.img || user.avatar || FALLBACK_IMG;
}

/** Какую картинку показать прямо сейчас */
export function pickImage(user, cfg, emotion, vs) {
  const imgs = cfg.images;
  const base = baseImage(user, cfg);
  const hasEmotionImg = emotion !== "neutral" && !!imgs[emotion];
  if ( cfg.mode === "voice" ) {
    if ( vs.s === VOICE.LOUD && imgs.shouting ) return imgs.shouting;
    if ( vs.s >= VOICE.TALK && imgs.talking && !hasEmotionImg ) return imgs.talking;
  }
  return hasEmotionImg ? imgs[emotion] : base;
}

const esc = s => foundry.utils.escapeHTML?.(String(s ?? "")) ?? String(s ?? "").replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[c]);

export class PortraitBar {
  /** @type {HTMLElement} */ element = null;
  /** @type {HTMLElement} */ cards = null;
  #voice;
  #bubbleTimers = new Map();
  #menu = null;

  constructor(voice) {
    this.#voice = voice;
  }

  init() {
    const el = document.createElement("div");
    el.id = "vp-bar";
    el.innerHTML = `<div class="vp-handle" data-tooltip="Перетащить панель. Двойной клик — вернуть на место"><i class="fa-solid fa-grip-vertical"></i></div><div class="vp-cards"></div>`;
    document.body.append(el);
    this.element = el;
    this.cards = el.querySelector(".vp-cards");

    this.#activateDrag(el.querySelector(".vp-handle"));
    this.cards.addEventListener("contextmenu", ev => this.#onContextMenu(ev));
    this.cards.addEventListener("click", ev => {
      const btn = ev.target.closest("[data-action='mute']");
      if ( btn ) { ev.stopPropagation(); this.#voice.toggleMute(); }
    });

    this.#voice.addEventListener("change", ev => this.updateVoice(ev.detail.userId));

    window.addEventListener("resize", () => this.position());
    const players = document.getElementById("players");
    if ( players && window.ResizeObserver ) new ResizeObserver(() => this.position()).observe(players);

    document.body.classList.toggle("vp-hide-cameras", getSetting("hideCameraDock"));
    this.render();
  }

  /* -------------------------------------------- */
  /*  Отрисовка                                   */
  /* -------------------------------------------- */

  #users() {
    const showGM = getSetting("showGM");
    const showOffline = getSetting("showOffline");
    return game.users.filter(u => (u.active || showOffline) && (showGM || !u.isGM))
      .sort((a, b) => (a.isGM - b.isGM) || a.name.localeCompare(b.name));
  }

  render() {
    if ( !this.element ) return;
    this.element.style.setProperty("--vp-size", `${SIZES[getSetting("portraitSizePreset")] ?? SIZES.medium}px`);
    this.element.dataset.size = getSetting("portraitSizePreset");
    const users = this.#users();
    const keep = new Set(users.map(u => u.id));
    for ( const card of [...this.cards.children] ) if ( !keep.has(card.dataset.userId) ) card.remove();

    for ( const user of users ) {
      let card = this.#card(user.id);
      if ( !card ) {
        card = document.createElement("div");
        card.className = "vp-card";
        card.dataset.userId = user.id;
        card.innerHTML = `
          <div class="vp-bubble"></div>
          <div class="vp-frame">
            <img class="vp-img" alt="" draggable="false">
            <i class="vp-emotion fa-solid"></i>
            <i class="vp-muted fa-solid fa-microphone-slash" data-tooltip="Микрофон выключен"></i>
          </div>
          <div class="vp-plate"><div class="vp-name"></div><div class="vp-player"></div></div>`;
      }
      this.cards.append(card);   // append переносит существующий узел → правильный порядок
      this.#fillCard(card, user);
    }
    this.element.classList.toggle("vp-empty", !users.length);
    this.position();
  }

  #card(userId) {
    return this.cards?.querySelector(`.vp-card[data-user-id="${userId}"]`);
  }

  #fillCard(card, user) {
    const cfg = getConfig(user);
    const emotion = getEmotion(user);
    const isSelf = user.id === game.user.id;
    card.style.setProperty("--vp-color", user.color?.css ?? user.color ?? "#888");
    card.classList.toggle("is-self", isSelf);
    card.classList.toggle("is-offline", !user.active);
    card.classList.toggle("vp-anim", cfg.mode === "voice");
    card.classList.toggle("vp-ring", cfg.ring !== false);

    const charName = cfg.displayName || user.character?.name || user.name;
    card.querySelector(".vp-name").textContent = charName;
    const player = card.querySelector(".vp-player");
    player.textContent = charName === user.name ? "" : user.name;
    player.hidden = !player.textContent;

    const emo = EMOTIONS.find(e => e.id === emotion);
    const emoIcon = card.querySelector(".vp-emotion");
    emoIcon.className = `vp-emotion fa-solid ${emo && emotion !== "neutral" ? emo.icon : ""}`;
    emoIcon.hidden = !emo || emotion === "neutral";
    if ( emo ) emoIcon.dataset.tooltip = emo.label;

    card._vp = { user, cfg, emotion };
    this.updateVoice(user.id);
  }

  /** Быстрое обновление только «голосовой» части карточки */
  updateVoice(userId) {
    const card = this.#card(userId);
    if ( !card?._vp ) return;
    const { user, cfg, emotion } = card._vp;
    const vs = this.#voice.getState(userId);
    card.classList.toggle("is-talking", vs.s >= VOICE.TALK);
    card.classList.toggle("is-shouting", vs.s === VOICE.LOUD);
    card.classList.toggle("is-muted", !!vs.m);
    card.style.setProperty("--vp-level", String(vs.l ?? 0));

    const img = card.querySelector(".vp-img");
    const src = pickImage(user, cfg, emotion, vs);
    if ( img.getAttribute("src") !== src ) {
      img.onerror = () => { if ( img.getAttribute("src") !== FALLBACK_IMG ) img.src = FALLBACK_IMG; };
      img.src = src;
    }
  }

  /* -------------------------------------------- */
  /*  Положение и перетаскивание                  */
  /* -------------------------------------------- */

  position() {
    const el = this.element;
    if ( !el ) return;
    const saved = getSetting("barPosition");
    if ( Number.isFinite(saved?.left) && Number.isFinite(saved?.top) ) {
      const left = Math.min(Math.max(saved.left, 0), window.innerWidth - 40);
      const top = Math.min(Math.max(saved.top, 0), window.innerHeight - 40);
      Object.assign(el.style, { left: `${left}px`, top: `${top}px`, bottom: "" });
      return;
    }
    // По умолчанию: чуть правее списка игроков, по его нижнему краю
    const players = document.getElementById("players");
    const r = players?.getBoundingClientRect();
    const left = r?.width ? r.right + 12 : 220;
    const bottom = r?.height ? Math.max(window.innerHeight - r.bottom, 8) : 10;
    Object.assign(el.style, { left: `${left}px`, bottom: `${bottom}px`, top: "" });
  }

  #activateDrag(handle) {
    handle.addEventListener("dblclick", async () => {
      await setSetting("barPosition", {});
      this.position();
    });
    handle.addEventListener("pointerdown", ev => {
      if ( ev.button !== 0 ) return;
      ev.preventDefault();
      const rect = this.element.getBoundingClientRect();
      const dx = ev.clientX - rect.left, dy = ev.clientY - rect.top;
      handle.setPointerCapture(ev.pointerId);
      this.element.classList.add("dragging");
      const move = e => {
        Object.assign(this.element.style, {
          left: `${e.clientX - dx}px`, top: `${e.clientY - dy}px`, bottom: ""
        });
      };
      const up = async () => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        this.element.classList.remove("dragging");
        const r = this.element.getBoundingClientRect();
        await setSetting("barPosition", { left: Math.round(r.left), top: Math.round(r.top) });
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
    });
  }

  /* -------------------------------------------- */
  /*  Контекстное меню                            */
  /* -------------------------------------------- */

  #onContextMenu(ev) {
    const card = ev.target.closest(".vp-card");
    if ( !card ) return;
    ev.preventDefault();
    ev.stopPropagation();
    const user = game.users.get(card.dataset.userId);
    if ( !user ) return;
    this.openMenu(user, ev);
  }

  /**
   * Открыть меню эмоций/микрофона/настройки для пользователя у курсора.
   * Публичное — им пользуются другие модули (например, BG3 Style HUD).
   */
  openMenu(user, ev) {
    const isSelf = user.id === game.user.id;
    const canEdit = isSelf || game.user.isGM;
    const current = getEmotion(user);
    const vp = game.voicePortraits;

    const items = [];
    if ( canEdit ) {
      items.push(`<li class="vp-menu-title">${isSelf ? "Эмоция" : `Эмоция: ${esc(user.name)}`}</li>`);
      const imgs = getConfig(user).images;
      for ( const e of EMOTIONS ) {
        const noImg = e.id !== "neutral" && !imgs[e.id];
        items.push(`<li data-emotion="${e.id}" class="${e.id === current ? "active" : ""}">
          <i class="fa-solid ${e.icon}"></i> ${e.label}${noImg ? ` <span class="vp-dim">(без картинки)</span>` : ""}</li>`);
      }
      items.push(`<li class="vp-sep"></li>`);
    }
    if ( isSelf ) {
      const muted = this.#voice.isMuted();
      items.push(`<li data-act="mute"><i class="fa-solid ${muted ? "fa-microphone" : "fa-microphone-slash"}"></i> ${muted ? "Включить микрофон" : "Выключить микрофон"}</li>`);
    }
    if ( !isSelf && this.#voice.mode === "foundry" && game.webrtc?.mode ) {
      const vol = this.#voice.getUserVolume(user.id);
      items.push(`<li class="vp-menu-title">Громкость: ${esc(user.name)}</li>
        <li class="vp-slider"><i class="fa-solid fa-volume-high"></i><input type="range" min="0" max="1" step="0.05" value="${vol}" data-act="volume"></li>`);
    }
    if ( canEdit ) items.push(`<li data-act="config"><i class="fa-solid fa-image-portrait"></i> Настроить портрет…</li>`);
    if ( !items.length ) return;

    this.#closeMenu();
    const menu = document.createElement("ul");
    menu.id = "vp-menu";
    menu.innerHTML = items.join("");
    document.body.append(menu);
    this.#menu = menu;

    // Позиция: у курсора, не вылезая за экран
    const mr = menu.getBoundingClientRect();
    menu.style.left = `${Math.min(ev.clientX, window.innerWidth - mr.width - 6)}px`;
    menu.style.top = `${Math.max(Math.min(ev.clientY - mr.height, window.innerHeight - mr.height - 6), 6)}px`;

    menu.addEventListener("click", async e => {
      const li = e.target.closest("li");
      if ( !li ) return;
      if ( li.dataset.emotion ) { this.#closeMenu(); await vp.setEmotion(user, li.dataset.emotion); }
      else if ( li.dataset.act === "mute" ) { this.#closeMenu(); await this.#voice.toggleMute(); }
      else if ( li.dataset.act === "config" ) { this.#closeMenu(); vp.openConfig(user); }
    });
    menu.querySelector("input[data-act='volume']")?.addEventListener("input", e => {
      this.#voice.setUserVolume(user.id, Number(e.target.value));
    });

    const close = e => {
      if ( e.type === "keydown" && e.key !== "Escape" ) return;
      if ( e.type === "pointerdown" && menu.contains(e.target) ) return;
      this.#closeMenu();
    };
    menu._close = close;
    setTimeout(() => {
      document.addEventListener("pointerdown", close, true);
      document.addEventListener("keydown", close, true);
    });
  }

  #closeMenu() {
    if ( !this.#menu ) return;
    document.removeEventListener("pointerdown", this.#menu._close, true);
    document.removeEventListener("keydown", this.#menu._close, true);
    this.#menu.remove();
    this.#menu = null;
  }

  /* -------------------------------------------- */
  /*  Облачка чата                                */
  /* -------------------------------------------- */

  showBubble(userId, text, { emote = false } = {}) {
    // Сигнал для других модулей (например, BG3 Style HUD показывает облачко у своего портрета)
    if ( text ) Hooks.callAll("voicePortraits.bubble", userId, text, { emote });
    const card = this.#card(userId);
    if ( !card || !text ) return;
    const bubble = card.querySelector(".vp-bubble");
    bubble.textContent = text;
    bubble.classList.toggle("emote", emote);

    // Если панель у верхнего края — облачко снизу, иначе сверху
    const r = card.getBoundingClientRect();
    bubble.classList.toggle("below", r.top < 160);

    card.classList.remove("has-bubble");
    void card.offsetWidth;   // перезапуск анимации появления
    card.classList.add("has-bubble");

    clearTimeout(this.#bubbleTimers.get(userId));
    const duration = Math.min(Math.max(2500 + text.length * 70, 3500), 14000);
    this.#bubbleTimers.set(userId, setTimeout(() => card.classList.remove("has-bubble"), duration));
  }
}
