import { MODULE_ID, FEATURE_ID, VOICE } from "./constants.js";
import { suiteSocket } from "../../../core/socket.js";
import { getSetting, setSetting } from "./settings.js";

/**
 * Следит за СВОИМ микрофоном, определяет «молчит / говорит / кричит»
 * и рассылает это состояние остальным через сокет модуля.
 * Чужие состояния приходят по сокету и хранятся в this.states.
 *
 * Так работает одинаково и со встроенным голосовым чатом Foundry,
 * и при общении через Discord (режим «Внешний»).
 */
export class VoiceMonitor extends EventTarget {
  /** @type {Map<string, {s:number, l:number, m:boolean, ts:number}>} */
  states = new Map();

  /** Текущий уровень своего микрофона в дБ (для индикатора в настройках) */
  currentDb = -100;

  #ctx = null;
  #source = null;
  #analyser = null;
  #buf = null;
  #stream = null;
  #ownStream = false;   // поток создан нами (режим «Внешний») — нужно остановить при отключении
  #tickTimer = null;
  #speakUntil = 0;
  #loudUntil = 0;
  #loudSince = null;
  #feedTs = -1e9;
  #discordTs = 0;
  #discordLinked = new Set();
  feedSource = null;
  discordInfo = { on: false, channel: null, matched: new Set() };
  #level = 0;
  #lastSent = 0;
  #lastState = VOICE.SILENT;
  #acquiring = false;
  #micFailed = false;

  get mode() { return getSetting("voiceSource"); }

  init() {
    suiteSocket.on(FEATURE_ID, data => this.#onSocket(data));

    // Браузер разрешает звук только после действия пользователя
    const resume = () => { if ( this.#ctx?.state === "suspended" ) this.#ctx.resume(); };
    document.addEventListener("pointerdown", resume, { capture: true });
    document.addEventListener("keydown", resume, { capture: true });

    // Поток громкости от userscript (Яндекс Телемост и т.п.)
    window.addEventListener("voice-portraits:feed", ev => this.#onFeed(ev));
    window.voicePortraitsFeedReady = true;

    setInterval(() => this.#housekeeping(), 1000);
    setInterval(() => this.sendStatus(), 5000);

    suiteSocket.emit(FEATURE_ID, { t: "hello", u: game.user.id });
    this.sendStatus();
    this.refresh();
  }

  /* -------------------------------------------- */
  /*  Состояние                                   */
  /* -------------------------------------------- */

  getState(userId) {
    return this.states.get(userId) ?? { s: VOICE.SILENT, l: 0, m: false, ts: 0 };
  }

  #setState(userId, patch) {
    const prev = this.getState(userId);
    const next = { ...prev, ...patch, ts: Date.now() };
    this.states.set(userId, next);
    this.dispatchEvent(new CustomEvent("change", { detail: { userId, state: next } }));
  }

  forget(userId) {
    this.states.delete(userId);
    this.dispatchEvent(new CustomEvent("change", { detail: { userId, state: this.getState(userId) } }));
  }

  /* -------------------------------------------- */
  /*  Микрофон: вкл/выкл                          */
  /* -------------------------------------------- */

  isMuted() {
    if ( this.mode === "external" ) return getSetting("externalMuted");
    const rtc = game.webrtc;
    if ( !rtc ) return false;
    const fromSettings = rtc.settings?.client?.users?.[game.user.id]?.muted;
    if ( fromSettings !== undefined ) return !!fromSettings;
    try { return !!rtc.client?.isMuted; } catch { return false; }
  }

  async toggleMute() {
    const muted = !this.isMuted();
    if ( this.mode === "external" ) await setSetting("externalMuted", muted);
    else {
      try {
        await game.webrtc.settings.set("client", `users.${game.user.id}.muted`, muted);
      } catch(err) {
        console.error(`${MODULE_ID} | не удалось переключить микрофон`, err);
        ui.notifications.warn("Не получилось переключить микрофон Foundry. Проверьте, что голосовой чат включён.");
      }
    }
    this.#setState(game.user.id, { m: muted, s: VOICE.SILENT, l: 0 });
    this.sendStatus();
    ui.notifications.info(muted ? "Микрофон выключен" : "Микрофон включён");
  }

  /** Передаёт ли сейчас Foundry наш голос (учитывает mute, push-to-talk, активацию голосом) */
  #isTransmitting() {
    if ( this.isMuted() ) return false;
    if ( this.mode === "external" ) return true;
    const c = game.webrtc?.client;
    if ( !c ) return false;
    try { if ( typeof c.isAudioEnabled === "function" && !c.isAudioEnabled() ) return false; } catch {}
    let always = false;
    try { always = !!c.isVoiceAlways; } catch {}
    if ( !always && c.audioBroadcastEnabled === false ) return false;
    return true;
  }

  /* -------------------------------------------- */
  /*  Захват звука                                */
  /* -------------------------------------------- */

  /** Найти/обновить поток своего микрофона */
  async refresh() {
    if ( this.mode === "external" ) {
      // Голос даёт Discord-бот мастера — микрофон в браузере не нужен (и без https всё равно недоступен)
      if ( getSetting("discordBridge") ) return;
      if ( this.#stream?.active || this.#acquiring || this.#micFailed ) return;
      this.#acquiring = true;
      try {
        const deviceId = game.webrtc?.settings?.client?.audioSrc;
        const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: false };
        if ( deviceId && deviceId !== "default" ) audio.deviceId = { ideal: deviceId };
        const stream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
        this.#attach(stream, true);
      } catch(err) {
        this.#micFailed = true;
        console.warn(`${MODULE_ID} | нет доступа к микрофону`, err);
        // Не страшно, если голос приходит от Discord-бота или скрипта Телемоста
        setTimeout(() => {
          if ( this.hasFeed || this.isDiscordControlled(game.user.id) ) return;
          ui.notifications.warn(game.user.isGM
            ? "Голосовые портреты: браузер не дал доступ к микрофону (Foundry открыт не по https). Если вы играете в Discord — "
              + "запустите бота и включите «Discord-бот: включить» в центре управления → Голосовые портреты."
            : "Голосовые портреты: браузер не дал доступ к микрофону (Foundry открыт не по https). Попросите мастера включить Discord-бота.",
            { permanent: false });
        }, 8000);
      } finally { this.#acquiring = false; }
      return;
    }

    // Режим Foundry: используем поток, который Foundry сам делает для измерения громкости
    const c = game.webrtc?.client;
    let stream = null;
    try {
      stream = c?.getLevelsStreamForUser?.(game.user.id)
        ?? c?.levelsStream
        ?? c?.getMediaStreamForUser?.(game.user.id)
        ?? c?.localStream
        ?? null;
    } catch { stream = null; }
    if ( stream && !stream.getAudioTracks().length ) stream = null;
    if ( stream !== this.#stream ) this.#attach(stream, false);
  }

  #attach(stream, own) {
    this.#detach();
    if ( !stream ) return;
    try {
      this.#ctx ??= new AudioContext();
      this.#source = this.#ctx.createMediaStreamSource(stream);
      this.#analyser = this.#ctx.createAnalyser();
      this.#analyser.fftSize = 1024;
      this.#analyser.smoothingTimeConstant = 0;
      this.#source.connect(this.#analyser);
      this.#buf = new Float32Array(this.#analyser.fftSize);
      this.#stream = stream;
      this.#ownStream = own;
      this.#tickTimer = setInterval(() => this.#tick(), 50);
    } catch(err) {
      console.error(`${MODULE_ID} | ошибка анализа звука`, err);
    }
  }

  #detach() {
    clearInterval(this.#tickTimer);
    this.#tickTimer = null;
    try { this.#source?.disconnect(); } catch {}
    if ( this.#ownStream ) this.#stream?.getTracks().forEach(t => t.stop());
    this.#source = this.#analyser = this.#buf = this.#stream = null;
    this.#ownStream = false;
  }

  #tick() {
    if ( !this.#analyser ) return;
    // Если идёт поток от скрипта Телемоста или голосом управляет Discord-бот — свой микрофон не нужен
    if ( this.hasFeed || this.isDiscordControlled(game.user.id) ) return;
    this.#analyser.getFloatTimeDomainData(this.#buf);
    let sum = 0;
    for ( const v of this.#buf ) sum += v * v;
    const rms = Math.sqrt(sum / this.#buf.length);
    const db = 20 * Math.log10(Math.max(rms, 1e-8));
    this.currentDb = db;
    this.#process(db, this.#isTransmitting());
  }

  /** Есть ли свежие данные от userscript (Телемост и т.п.) */
  get hasFeed() {
    return performance.now() - this.#feedTs < 1500;
  }

  /** Данные от userscript: { level: 0..1, live: bool, src: "telemost" } */
  #onFeed(ev) {
    let d = ev.detail;
    try { if ( typeof d === "string" ) d = JSON.parse(d); } catch { return; }
    if ( !d || typeof d !== "object" ) return;
    if ( !this.hasFeed ) console.log(`${MODULE_ID} | голос берётся из ${d.src ?? "внешнего скрипта"}`);
    this.#feedTs = performance.now();
    this.feedSource = d.src ?? "script";
    if ( this.isDiscordControlled(game.user.id) ) return;
    const level = Number(d.level) || 0;
    // audioLevel из WebRTC — пиковый уровень, он примерно на 10 дБ выше среднего (RMS) — приводим к одной шкале
    const db = level > 0 ? 20 * Math.log10(level) - 10 : -100;
    this.currentDb = db;
    this.#process(db, d.live !== false && !this.isMuted());
  }

  /** Перевести громкость (дБ) в состояние «молчит/говорит/кричит» и разослать */
  #process(db, tx) {
    const now = performance.now();
    const speakT = getSetting("speakThreshold");
    const shoutT = Math.max(getSetting("shoutThreshold"), speakT + 1);

    if ( tx && db > speakT ) this.#speakUntil = now + 300;          // «хвост», чтобы не мигало между словами
    if ( tx && db > shoutT ) {
      this.#loudSince ??= now;
      if ( now - this.#loudSince >= 120 ) this.#loudUntil = now + 700;   // крик — от ~0.1 c
    } else this.#loudSince = null;

    const state = !tx ? VOICE.SILENT
      : now < this.#loudUntil ? VOICE.LOUD
      : now < this.#speakUntil ? VOICE.TALK
      : VOICE.SILENT;

    const raw = state ? Math.min(Math.max((db - speakT) / (shoutT - speakT), 0), 1) : 0;
    this.#level = state ? (this.#level * 0.5 + raw * 0.5) : 0;
    const l = Math.round(this.#level * 20) / 20;

    const prev = this.getState(game.user.id);
    if ( state !== prev.s || l !== prev.l ) this.#setState(game.user.id, { s: state, l, m: this.isMuted() });

    const changed = state !== this.#lastState;
    if ( changed || (state && now - this.#lastSent > 120) ) {
      suiteSocket.emit(FEATURE_ID, { t: "v", u: game.user.id, s: state, l, m: this.isMuted() });
      this.#lastSent = now;
      this.#lastState = state;
    }
  }

  sendStatus() {
    const m = this.isMuted();
    const own = this.getState(game.user.id);
    if ( own.m !== m ) this.#setState(game.user.id, { m });
    suiteSocket.emit(FEATURE_ID, { t: "st", u: game.user.id, m });
  }

  /* -------------------------------------------- */
  /*  Discord-бот (данные рассылает клиент мастера)  */
  /* -------------------------------------------- */

  /** Голосом этого пользователя управляет Discord-бот? */
  isDiscordControlled(userId) {
    return Date.now() - this.#discordTs < 8000 && this.#discordLinked.has(userId);
  }

  /** Принять пакет так, будто он пришёл по сокету (мастер применяет свои же рассылки) */
  applyRemote(data) {
    this.#onSocket(data, true);
  }

  #housekeeping() {
    // Если сообщение о тишине потерялось — гасим «говорящих» через 1.5 c
    const now = Date.now();
    for ( const [userId, st] of this.states ) {
      if ( userId === game.user.id && !this.isDiscordControlled(userId) ) continue;
      if ( st.s !== VOICE.SILENT && now - st.ts > 1500 ) this.#setState(userId, { s: VOICE.SILENT, l: 0 });
    }
    // Foundry может пересоздать поток (смена микрофона и т.п.)
    if ( this.mode === "foundry" || !this.#stream?.active ) this.refresh();
  }

  #onSocket(data, local = false) {
    if ( !data?.t ) return;
    // Состояния от Discord-бота (присылает мастер) — в том числе про нас самих
    if ( data.t === "gs" ) {
      const before = new Set(this.#discordLinked);
      this.#discordTs = data.on ? Date.now() : 0;
      this.#discordLinked = new Set(data.on ? (data.linked ?? []) : []);
      this.discordInfo = { on: !!data.on, channel: data.channel ?? null, matched: new Set(data.matched ?? []) };
      for ( const id of new Set([...before, ...this.#discordLinked]) ) {
        if ( before.has(id) !== this.#discordLinked.has(id) ) this.#setState(id, { s: VOICE.SILENT, l: 0 });
      }
      return;
    }
    if ( data.t === "v" && data.d ) {
      if ( data.u ) this.#setState(data.u, { s: data.s | 0, l: Number(data.l) || 0, m: !!data.m });
      return;
    }
    if ( !data.u || (data.u === game.user.id && !local) ) return;
    switch ( data.t ) {
      case "hello": this.sendStatus(); game.voicePortraits?.discord?.broadcastStatus(); break;
      case "st": this.#setState(data.u, { m: !!data.m }); break;
      case "v":
        if ( this.isDiscordControlled(data.u) ) return;   // приоритет у Discord-бота
        this.#setState(data.u, { s: data.s | 0, l: Number(data.l) || 0, m: !!data.m });
        break;
    }
  }

  /* -------------------------------------------- */
  /*  Громкость других игроков (только Foundry)   */
  /* -------------------------------------------- */

  getUserVolume(userId) {
    const v = game.webrtc?.settings?.client?.users?.[userId]?.volume ?? 1;
    const AH = foundry.audio?.AudioHelper;
    return AH?.volumeToInput ? AH.volumeToInput(v) : v;
  }

  async setUserVolume(userId, input) {
    const AH = foundry.audio?.AudioHelper;
    const volume = AH?.inputToVolume ? AH.inputToVolume(input) : input;
    try {
      const el = ui.webrtc?.getUserVideoElement?.(userId);
      if ( el ) el.volume = volume;
      await game.webrtc?.settings?.set("client", `users.${userId}.volume`, volume);
    } catch(err) { console.warn(`${MODULE_ID} | громкость`, err); }
  }
}
