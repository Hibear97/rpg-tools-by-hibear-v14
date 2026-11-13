import { MODULE_ID, FEATURE_ID, VOICE } from "./constants.js";
import { suiteSocket } from "../../../core/socket.js";
import { getSetting } from "./settings.js";

/** Какую версию бота ждёт модуль и какой протокол понимает. Старый бот продолжает работать, модуль лишь подскажет обновиться. */
export const BOT_EXPECTED = "1.2.0";
const BOT_PROTOCOL = 1;
const newer = (a, b) => {
  const pa = String(a).split(".").map(Number), pb = String(b).split(".").map(Number);
  for ( let i = 0; i < 3; i++ ) if ( (pa[i] || 0) !== (pb[i] || 0) ) return (pa[i] || 0) > (pb[i] || 0);
  return false;
};

const SPEAK_DB = -55;   // тише — считаем тишиной (хвостовые пакеты Discord)

/**
 * Работает ТОЛЬКО в браузере мастера.
 * Подключается к локальному Discord-боту (bot/), узнаёт, кто реально передаёт голос в Discord
 * и насколько громко, и рассылает это всем игрокам через сокет модуля.
 */
export class DiscordBridge {
  #voice;
  #ws = null;
  #reconnect = null;
  #intervals = [];
  #connected = false;
  #channel = null;
  #members = new Map();   // discordId -> { id, username, globalName, nick, displayName, mute }
  #recs = new Map();      // discordId -> состояние голоса
  #notified = false;
  #warnedOld = false;
  #asked = new Set();     // кого из Discord уже предлагали привязать
  #hubs = new Map();      // userId мастера -> время последнего «я подключён к боту»
  #started = false;
  #listening = false;

  constructor(voice) {
    this.#voice = voice;
  }

  /** Этот клиент может держать связь с ботом: мастер и мост включён */
  get canHub() {
    return !!getSetting("discordBridge") && game.user.isGM;
  }

  /**
   * Этот клиент сейчас рассылает голос игрокам.
   * К боту могут подключиться несколько окон мастера (браузер, приложение Foundry, вторая вкладка) —
   * рассылает одно: подключённое к боту с наименьшим id пользователя. Остальные остаются на связи в запасе
   * и сразу подхватывают, если главное окно закроется. Раньше лишние окна разрывали связь — бот «отключался».
   */
  get isHub() {
    if ( !this.canHub || !this.#connected ) return false;
    const now = Date.now();
    const ids = [game.user.id];
    for ( const [id, ts] of this.#hubs ) {
      if ( now - ts < 7000 && game.users.get(id)?.active ) ids.push(id);
    }
    ids.sort();
    return ids[0] === game.user.id;
  }

  #heartbeat() {
    if ( !this.canHub ) return;
    suiteSocket.emit(FEATURE_ID, { t: "hub", u: game.user.id, on: this.#connected });
  }

  #onHub(data) {
    if ( !data?.u || data.u === game.user.id ) return;
    if ( data.on ) this.#hubs.set(data.u, Date.now());
    else this.#hubs.delete(data.u);
  }

  get connected() { return this.#connected; }
  get channel() { return this.#channel; }

  start() {
    if ( !this.#listening ) {
      this.#listening = true;
      suiteSocket.on(FEATURE_ID, data => { if ( data?.t === "hub" ) this.#onHub(data); });
    }
    if ( !this.canHub || this.#started ) return;
    this.#started = true;
    this.#connect();
    this.#intervals.push(setInterval(() => this.#heartbeat(), 2000));
    this.#intervals.push(setInterval(() => this.broadcastStatus(), 3000));
    this.#intervals.push(setInterval(() => { for ( const id of this.#recs.keys() ) this.#update(id); }, 100));
  }

  stop(silent = false) {
    const wasHub = this.isHub;
    this.#started = false;
    this.#intervals.forEach(clearInterval);
    this.#intervals = [];
    clearTimeout(this.#reconnect);
    if ( this.#ws ) { this.#ws.onclose = null; this.#ws.close(); this.#ws = null; }
    this.#connected = false;
    this.#heartbeat();
    if ( !silent && wasHub ) this.broadcastStatus(true);
  }

  restart() {
    this.stop();
    this.start();
  }

  #connect() {
    clearTimeout(this.#reconnect);
    let ws;
    try { ws = new WebSocket(getSetting("discordBridgeUrl")); }
    catch(err) {
      console.warn(`${MODULE_ID} | неверный адрес Discord-бота`, err);
      return;
    }
    this.#ws = ws;
    ws.onopen = () => {
      this.#connected = true;
      this.#heartbeat();
      if ( !this.#notified ) ui.notifications.info("Голосовые портреты: Discord-бот подключён");
      this.#notified = true;
    };
    ws.onmessage = ev => {
      try { this.#onMessage(JSON.parse(ev.data)); } catch(err) { console.warn(`${MODULE_ID} | Discord`, err); }
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      const was = this.#connected;
      const wasHub = this.isHub;
      this.#connected = false;
      this.#channel = null;
      this.#recs.clear();
      this.#heartbeat();
      if ( was ) ui.notifications.warn("Голосовые портреты: связь с Discord-ботом потеряна, переподключаюсь…");
      if ( wasHub ) this.broadcastStatus(true);
      if ( this.#started ) this.#reconnect = setTimeout(() => this.#connect(), 5000);
    };
  }

  /** Версия подключённого бота (null — бот старше 1.2 и не сообщает версию) */
  botVersion = null;

  #onMessage(m) {
    switch ( m.t ) {
      case "hello": {
        this.botVersion = String(m.version ?? "");
        if ( Number(m.protocol) > BOT_PROTOCOL ) {
          ui.notifications.warn("Голосовые портреты: Discord-бот новее модуля — обновите модуль RPG-Tools.");
        } else if ( newer(BOT_EXPECTED, this.botVersion) && !this.#warnedOld ) {
          this.#warnedOld = true;
          ui.notifications.info(`Голосовые портреты: есть новая версия Discord-бота (${BOT_EXPECTED}). Перезапустите бота — он обновится сам.`);
        }
        break;
      }
      case "members":
        this.#channel = m.channel ?? null;
        this.#members = new Map((m.list ?? []).map(x => [x.id, x]));
        this.broadcastStatus();
        for ( const id of this.#members.keys() ) this.#update(id, true);
        break;
      case "speak": {
        const rec = this.#rec(m.id);
        rec.speaking = !!m.on;
        this.#update(m.id);
        break;
      }
      case "lvl": {
        const rec = this.#rec(m.id);
        rec.db = Number(m.db);
        rec.levelTs = performance.now();
        this.#update(m.id);
        break;
      }
    }
  }

  #rec(id) {
    let r = this.#recs.get(id);
    if ( !r ) this.#recs.set(id, r = {
      speaking: false, db: -100, levelTs: -1e9, talkUntil: 0, loudUntil: 0, loudSince: null, level: 0,
      sent: { s: -1, l: -1, m: null }, lastSent: 0
    });
    return r;
  }

  /** Найти пользователя Foundry по нику в Discord (указывается в «Настроить портрет…») */
  userFor(discordId) {
    const mem = this.#members.get(discordId);
    const keys = [discordId, mem?.username, mem?.globalName, mem?.nick, mem?.displayName]
      .filter(Boolean).map(k => String(k).toLowerCase());
    return game.users.find(u => {
      const n = normalize(u.getFlag(MODULE_ID, "vp.discord"));
      return n && keys.includes(n);
    });
  }

  /** Перевести данные Discord в состояние портрета и разослать */
  #update(discordId, force = false) {
    if ( !this.isHub ) return;   // голос рассылает только одно окно мастера
    const user = this.userFor(discordId);
    const rec = this.#rec(discordId);
    if ( !user ) {
      if ( rec.speaking ) this.#offerLink(discordId);
      return;
    }
    const mem = this.#members.get(discordId);
    const now = performance.now();
    const shoutT = getSetting("discordShoutDb");
    const hasLevels = now - rec.levelTs < 600;

    let s = VOICE.SILENT;
    let l = 0;
    if ( rec.speaking ) {
      if ( !hasLevels ) { s = VOICE.TALK; l = 0.4; }     // громкость неизвестна — просто «говорит»
      else {
        if ( rec.db > SPEAK_DB ) rec.talkUntil = now + 300;
        if ( rec.db > shoutT ) {
          rec.loudSince ??= now;
          if ( now - rec.loudSince >= 150 ) rec.loudUntil = now + 700;
        } else rec.loudSince = null;
        s = now < rec.loudUntil ? VOICE.LOUD : now < rec.talkUntil ? VOICE.TALK : VOICE.SILENT;
        const raw = s ? Math.min(Math.max((rec.db - SPEAK_DB) / (shoutT - SPEAK_DB), 0), 1) : 0;
        rec.level = s ? rec.level * 0.5 + raw * 0.5 : 0;
        l = Math.round(rec.level * 20) / 20;
      }
    }
    const m = !!mem?.mute;
    const changed = s !== rec.sent.s || m !== rec.sent.m;
    if ( !force && !changed && !(s && (l !== rec.sent.l) && now - rec.lastSent > 120) ) return;
    rec.sent = { s, l, m };
    rec.lastSent = now;
    const data = { t: "v", d: 1, u: user.id, s, l, m };
    suiteSocket.emit(FEATURE_ID, data);
    this.#voice.applyRemote(data);
  }

  /**
   * В Discord говорит человек, которого бот не может сопоставить ни с одним игроком Foundry.
   * Мастеру один раз предлагаем выбрать, чей это голос, — ник сохранится у выбранного пользователя.
   */
  async #offerLink(discordId) {
    if ( this.#asked.has(discordId) ) return;
    this.#asked.add(discordId);
    const mem = this.#members.get(discordId);
    const shown = mem?.displayName || mem?.globalName || mem?.nick || mem?.username || discordId;
    const nick = mem?.username || discordId;
    const users = game.users.filter(u => !u.getFlag(MODULE_ID, "vp.discord"));
    if ( !users.length ) return;
    const esc = s => foundry.utils.escapeHTML?.(String(s)) ?? String(s);
    const options = users.map(u => `<option value="${u.id}">${esc(u.name)}${u.isGM ? " (мастер)" : ""}${u.active ? "" : " — не в сети"}</option>`).join("");
    const DialogV2 = foundry.applications.api.DialogV2;
    const userId = await DialogV2.wait({
      window: { title: "Голосовые портреты · Discord", icon: "fa-brands fa-discord" },
      content: `<p>В Discord говорит <b>${esc(shown)}</b> (${esc(nick)}), но он не привязан ни к одному игроку,
        поэтому его портрет не двигается. Кто это?</p>
        <div class="form-group"><label>Игрок</label><select name="user">${options}</select></div>`,
      rejectClose: false,
      buttons: [
        { action: "link", label: "Привязать", icon: "fa-solid fa-link", default: true,
          callback: (event, button) => button.form?.elements?.user?.value ?? null },
        { action: "skip", label: "Не сейчас", callback: () => null }
      ]
    });
    const target = userId ? game.users.get(userId) : null;
    if ( !target ) return;
    await target.setFlag(MODULE_ID, "vp.discord", nick);
    ui.notifications.info(`Голосовые портреты: ${shown} в Discord → ${target.name}`);
    this.broadcastStatus();
  }

  /** Сообщить всем, работает ли бот и чьими портретами он управляет */
  broadcastStatus(off = false) {
    if ( !game.user.isGM ) return;
    if ( !off && !this.isHub ) return;
    const on = !off && this.#connected && !!this.#channel;
    const linked = on ? game.users.filter(u => normalize(u.getFlag(MODULE_ID, "vp.discord"))).map(u => u.id) : [];
    const matched = on ? [...this.#members.keys()].map(id => this.userFor(id)?.id).filter(Boolean) : [];
    const data = { t: "gs", u: game.user.id, on, linked, matched, channel: this.#channel };
    suiteSocket.emit(FEATURE_ID, data);
    this.#voice.applyRemote(data);
  }
}

function normalize(name) {
  return String(name ?? "").trim().replace(/^@/, "").toLowerCase();
}
