/**
 * Интеграция BG3 Style HUD ↔ Voice Portraits (голосовые портреты).
 *
 * Работает, только если в RPG Suite включена функция «Голосовые портреты». Ничего в нём не ломает:
 *  - свой портрет (круг слева от скиллбара) двигается под голос, меняет картинку «говорит/кричит»
 *    и эмоции, показывает облачко чата и значок микрофона;
 *  - панель портретов voice-portraits перестраивается в вертикальную колонку слева (как группа в BG3),
 *    карточка «своего» игрока в ней скрывается (он уже в круге); полоску хитов видит только мастер.
 * Выключается настройкой «Голосовые портреты: встроить в интерфейс» — тогда всё как раньше.
 */

import { SUITE_ID } from "../../core/constants.js";

const MOD = SUITE_ID;
const VOICE = { SILENT: 0, TALK: 1, LOUD: 2 };

let vp = null;              // game.voicePortraits
let helpers = null;         // { getConfig, getEmotion, pickImage, emotions }
let ctx = {};               // { getActor, getRoot, isOn, rerender }
let portraitUserId = null;  // чей голос показывает круглый портрет
let lastBubble = null;      // { userId, text, emote, until }
let bubbleTimer = null;
const boundRoots = new WeakSet();

const L = (k) => game.i18n.localize(`BG3HUD.${k}`);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* ------------------------------------------------------------------ */

export function registerVoiceSettings() {
  // Настройки встраивания нужны, только если включена функция «Голосовые портреты»
  if (game.rpgSuite && !game.rpgSuite.isEnabled("portraits")) return;
  game.settings.register(MOD, "hud-vpDock", {
    name: "BG3HUD.Settings.vpDock.name",
    hint: "BG3HUD.Settings.vpDock.hint",
    scope: "client", config: true, type: Boolean, default: true,
    onChange: () => { applyDock(); ctx.rerender?.(); }
  });
  // Старый отдельный ползунок размера колонки. Теперь размер задаёт общая настройка
  // «Голосовые портреты · Размер портретов», поэтому ползунок скрыт (оставлен, чтобы не ломать сохранённые данные).
  game.settings.register(MOD, "hud-vpPartySize", {
    scope: "client", config: false, type: Number, default: 76
  });
  // Мастер сменил «Размер портретов» — сразу перестроить колонку у всех.
  // Первое изменение мир-настройки СОЗДАЁТ запись (createSetting), следующие — обновляют (updateSetting).
  for (const hook of ["createSetting", "updateSetting"]) {
    Hooks.on(hook, (setting) => {
      if (setting.key === `${MOD}.vp-portraitSizePreset`) setTimeout(() => applyDock(), 0);
    });
  }
}

/** Размер портретов в колонке группы по общей настройке «Размер портретов» (small / medium / large) */
/** Колонка слева: средний — прежний размер 76 px, большой ×1.5, маленький ×0.5 */
const PARTY_SIZES = { small: 38, medium: 76, large: 114 };

export function vpAvailable() {
  // Функция «Голосовые портреты» включена в RPG Suite (или старый модуль voice-portraits)
  return !!game.voicePortraits?.voice;
}

function docked() {
  try {
    return vpAvailable() && !!ctx.isOn?.() && !!game.settings.get(MOD, "hud-vpDock");
  } catch { return false; }
}

async function loadHelpers() {
  const api = game.voicePortraits;
  if (api?.getConfig && api.pickImage && api.getEmotion) {
    return { getConfig: api.getConfig, getEmotion: api.getEmotion, pickImage: api.pickImage, emotions: api.emotionList ?? [] };
  }
  return null;   // старая версия портретов: анимация будет, но без смены картинок
}

/* ------------------------------------------------------------------ */
/*  Инициализация                                                       */
/* ------------------------------------------------------------------ */

export async function initVoiceBridge(context) {
  ctx = context;
  if (!vpAvailable()) return;
  vp = game.voicePortraits;
  helpers = await loadHelpers();

  vp.voice.addEventListener("change", (ev) => {
    if (ev.detail?.userId === portraitUserId) updatePortraitVoice();
  });

  Hooks.on("voicePortraits.bubble", (userId, text, opts = {}) => {
    if (!docked() || userId !== portraitUserId) return;
    showPortraitBubble(userId, text, opts.emote);
  });

  Hooks.on("updateUser", (user) => { if (user.id === portraitUserId) updatePortraitVoice(); });
  Hooks.on("updateActor", (actor) => {
    if (game.users.some((u) => u.character?.id === actor.id)) decorateParty();
  });
  Hooks.on("renderSceneControls", () => positionParty());
  window.addEventListener("resize", () => positionParty());

  // Панель voice-portraits создаётся в её «ready» — дождёмся
  const attach = () => {
    const bar = vp.bar;
    if (!bar?.element || !bar.cards) return setTimeout(attach, 300);
    new MutationObserver(() => decorateParty()).observe(bar.cards, { childList: true });
    bar.element.addEventListener("click", onPartyClick);
    bar.element.addEventListener("dblclick", onPartyDblClick);
    applyDock();
  };
  attach();
  ctx.rerender?.();
}

/* ------------------------------------------------------------------ */
/*  Колонка портретов группы слева                                      */
/* ------------------------------------------------------------------ */

export function applyDock() {
  const on = docked();
  document.body.classList.toggle("bg3hud-vp-docked", on);
  let preset = "medium";
  try { preset = game.settings.get(MOD, "vp-portraitSizePreset") ?? "medium"; } catch {}
  const size = PARTY_SIZES[preset] ?? PARTY_SIZES.medium;
  document.documentElement.style.setProperty("--bg3-party-size", `${size}px`);
  positionParty();
  decorateParty();
  if (!on) vp?.bar?.position?.();
}

function positionParty() {
  const sc = document.getElementById("scene-controls");
  const r = sc?.getBoundingClientRect();
  const left = r && r.width ? Math.round(r.right + 10) : 70;
  document.documentElement.style.setProperty("--bg3-party-left", `${left}px`);
}

function decorateParty() {
  const cards = vp?.bar?.cards;
  if (!cards) return;
  const on = docked();
  for (const card of cards.children) {
    card.classList.toggle("bg3-vp-hidden", on && !!portraitUserId && card.dataset.userId === portraitUserId);
    let bar = card.querySelector(".bg3-vp-hp");
    const actor = game.users.get(card.dataset.userId)?.character;
    const hp = actor?.system?.attributes?.hp;
    // Хиты сопартийцев видит только мастер — игроки не должны знать чужое здоровье
    if (!on || !hp || !game.user.isGM) { bar?.remove(); continue; }
    const max = (Number(hp.max) || 0) + (Number(hp.tempmax) || 0);
    const val = Number(hp.value) || 0;
    const temp = Number(hp.temp) || 0;
    const pct = max ? Math.min(Math.max(val / max * 100, 0), 100) : 0;
    if (!bar) {
      bar = document.createElement("div");
      bar.className = "bg3-vp-hp";
      card.querySelector(".vp-frame")?.append(bar);
    }
    bar.classList.toggle("low", pct <= 35);
    bar.classList.toggle("down", val <= 0);
    bar.innerHTML = `<div class="fill" style="width:${pct}%"></div><span>${val}${temp ? `+${temp}` : ""}/${max}</span>`;
  }
}

function partyTarget(ev) {
  if (!docked()) return null;
  if (ev.target.closest("[data-action='mute'], .vp-handle, .vp-bubble")) return null;
  const card = ev.target.closest(".vp-card");
  const user = card ? game.users.get(card.dataset.userId) : null;
  return user?.character ? { user, actor: user.character } : null;
}

function onPartyClick(ev) {
  const t = partyTarget(ev);
  if (!t) return;
  const token = t.actor.getActiveTokens?.()?.[0];
  if (!token) return;
  if (token.isOwner) token.control({ releaseOthers: !ev.shiftKey });
  canvas.animatePan?.({ x: token.center.x, y: token.center.y, duration: 250 });
}

function onPartyDblClick(ev) {
  const t = partyTarget(ev);
  if (!t) return;
  if (t.actor.testUserPermission?.(game.user, "OBSERVER") ?? t.actor.isOwner) t.actor.sheet?.render(true);
}

/* ------------------------------------------------------------------ */
/*  Круглый портрет BG3                                                 */
/* ------------------------------------------------------------------ */

/** Вызывается BG3 HUD после каждой перерисовки */
export function afterRender(root, actor) {
  if (!vp) return;
  // Мастер управляет чужими токенами: его большой портрет всегда реагирует на ЕГО голос,
  // иначе при выделенном токене игрока портрет «дёргался» бы, когда говорит этот игрок.
  const owner = actor && !game.user.isGM ? game.users.find((u) => u.character && u.character.id === actor.id) : null;
  const newId = actor ? (owner ?? game.user).id : null;
  if (newId !== portraitUserId) { portraitUserId = newId; decorateParty(); }
  if (!root || !actor || !docked()) return;

  if (!boundRoots.has(root)) {
    boundRoots.add(root);
    root.addEventListener("click", onRootClick);
    root.addEventListener("contextmenu", onRootContext);
  }

  const wrap = root.querySelector(".bg3-portrait-wrap");
  if (!wrap || wrap.classList.contains("vp-linked")) return;
  wrap.classList.add("vp-linked");
  wrap.insertAdjacentHTML("afterbegin", `
    <div class="bg3-vp-bubble"></div>
    <div class="bg3-vp-ring"></div>
    <i class="bg3-vp-emotion fa-solid" hidden></i>
    <i class="bg3-vp-muted fa-solid fa-microphone-slash" data-tooltip="${esc(L("VpMuted"))}"></i>`);
  if (portraitUserId === game.user.id) {
    wrap.querySelector(".bg3-rest")?.insertAdjacentHTML("beforeend",
      `<button type="button" class="bg3-vp-mic" data-vp="mute" data-tooltip="${esc(L("VpMic"))}"><i class="fa-solid fa-microphone"></i></button>`);
  }
  const portrait = wrap.querySelector(".bg3-portrait");
  if (portrait) portrait.dataset.tooltip = `${portrait.dataset.tooltip ?? ""} — ${L("VpPortraitHint")}`;

  // восстановить облачко после перерисовки
  if (lastBubble && lastBubble.userId === portraitUserId && Date.now() < lastBubble.until) {
    const b = wrap.querySelector(".bg3-vp-bubble");
    b.textContent = lastBubble.text;
    b.classList.toggle("emote", !!lastBubble.emote);
    wrap.classList.add("vp-has-bubble");
  }
  updatePortraitVoice();
}

function onRootClick(ev) {
  const btn = ev.target.closest("[data-vp='mute']");
  if (!btn || !vp) return;
  ev.preventDefault();
  ev.stopPropagation();
  vp.voice.toggleMute();
}

function onRootContext(ev) {
  if (!docked() || !vp) return;
  const portrait = ev.target.closest(".bg3-portrait-wrap.vp-linked .bg3-portrait");
  if (!portrait) return;
  const user = game.users.get(portraitUserId);
  if (!user) return;
  ev.preventDefault();
  ev.stopPropagation();
  if (typeof vp.openMenu === "function") return vp.openMenu(user, ev);
  return vp.openConfig?.(user);
}

function updatePortraitVoice() {
  const wrap = ctx.getRoot?.()?.querySelector(".bg3-portrait-wrap.vp-linked");
  const user = game.users.get(portraitUserId);
  if (!wrap || !user || !vp) return;
  const vs = vp.voice.getState(user.id);
  const actor = ctx.getActor?.();

  let anim = true, ring = true, emotionIcon = null, emotionLabel = "";
  const img = wrap.querySelector(".bg3-portrait img");
  if (helpers && actor && user.character?.id === actor.id) {
    const cfg = helpers.getConfig(user);
    const emotion = helpers.getEmotion(user);
    anim = cfg.mode === "voice";
    ring = cfg.ring !== false;
    const src = helpers.pickImage(user, cfg, emotion, vs);
    if (img && src && img.getAttribute("src") !== src) {
      img.onerror = () => { if (img.getAttribute("src") !== actor.img) img.src = actor.img; };
      img.src = src;
    }
    const emo = helpers.emotions.find((e) => e.id === emotion);
    if (emo && emotion !== "neutral") { emotionIcon = emo.icon; emotionLabel = emo.label; }
  }

  wrap.classList.toggle("vp-anim", anim);
  wrap.classList.toggle("vp-ring", ring);
  wrap.classList.toggle("vp-talking", vs.s >= VOICE.TALK);
  wrap.classList.toggle("vp-shouting", vs.s === VOICE.LOUD);
  wrap.classList.toggle("vp-muted", !!vs.m);
  wrap.style.setProperty("--vp-level", String(vs.l ?? 0));

  const emo = wrap.querySelector(".bg3-vp-emotion");
  if (emo) {
    emo.className = `bg3-vp-emotion fa-solid ${emotionIcon ?? ""}`;
    emo.hidden = !emotionIcon;
    emo.dataset.tooltip = emotionLabel;
  }
  const mic = wrap.querySelector(".bg3-vp-mic i");
  if (mic) mic.className = `fa-solid ${vs.m ? "fa-microphone-slash" : "fa-microphone"}`;
  wrap.querySelector(".bg3-vp-mic")?.classList.toggle("off", !!vs.m);
}

function showPortraitBubble(userId, text, emote) {
  const duration = Math.min(Math.max(2500 + text.length * 70, 3500), 14000);
  lastBubble = { userId, text, emote, until: Date.now() + duration };
  const wrap = ctx.getRoot?.()?.querySelector(".bg3-portrait-wrap.vp-linked");
  if (!wrap) return;
  const b = wrap.querySelector(".bg3-vp-bubble");
  b.textContent = text;
  b.classList.toggle("emote", !!emote);
  wrap.classList.remove("vp-has-bubble");
  void wrap.offsetWidth;
  wrap.classList.add("vp-has-bubble");
  clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(() => {
    ctx.getRoot?.()?.querySelector(".bg3-portrait-wrap")?.classList.remove("vp-has-bubble");
  }, duration);
}
