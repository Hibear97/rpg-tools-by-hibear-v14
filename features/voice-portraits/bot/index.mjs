/**
 * Discord-бот для модуля Foundry VTT «Голосовые портреты».
 *
 * Сидит в голосовом канале (без звука, ничего не записывает и не сохраняет) и сообщает
 * браузеру мастера, кто СЕЙЧАС реально передаёт голос в Discord и насколько громко.
 * Режим рации и мут учитываются автоматически: если Discord не передаёт голос — бот его не видит.
 */
import fs from "node:fs";
import { Client, Events, GatewayIntentBits } from "discord.js";
import {
  joinVoiceChannel, entersState, VoiceConnectionStatus, EndBehaviorType
} from "@discordjs/voice";
import OpusScript from "opusscript";
import { WebSocketServer } from "ws";

/* ---------------- Настройки ---------------- */

const CONFIG_PATH = new URL("./config.json", import.meta.url);
/** Версия бота и протокола. Протокол меняется, только если ломается совместимость — модуль сверяет его при подключении. */
const BOT_VERSION = JSON.parse(fs.readFileSync(new URL("./package.json", import.meta.url), "utf8")).version;
const PROTOCOL = 1;
if ( !fs.existsSync(CONFIG_PATH) ) {
  console.error("Нет файла config.json. Скопируйте config.example.json в config.json и впишите токен бота.");
  process.exit(1);
}
const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
const TOKEN = process.env.DISCORD_TOKEN || cfg.token;
const HOST = cfg.host || "127.0.0.1";
const PORT = Number(cfg.port) || 30500;
const FOLLOW = String(cfg.followUser ?? "").trim().replace(/^@/, "").toLowerCase();
const GUILD_ID = String(cfg.guildId ?? "").trim();

if ( !TOKEN || TOKEN.includes("ВСТАВЬТЕ") ) {
  console.error("Впишите токен бота в config.json (поле \"token\").");
  process.exit(1);
}

const log = (...a) => console.log(new Date().toLocaleTimeString("ru-RU"), ...a);

/* ---------------- WebSocket для Foundry ---------------- */

const wss = new WebSocketServer({ host: HOST, port: PORT });
const send = msg => {
  const text = JSON.stringify(msg);
  for ( const ws of wss.clients ) if ( ws.readyState === 1 ) ws.send(text);
};
wss.on("connection", ws => {
  log("Foundry подключился");
  ws.send(JSON.stringify({ t: "hello", version: BOT_VERSION, protocol: PROTOCOL }));
  ws.send(JSON.stringify(membersMessage()));
  ws.on("close", () => log("Foundry отключился"));
});
wss.on("listening", () => log(`Жду Foundry на ws://${HOST}:${PORT}`));
wss.on("error", err => {
  console.error("Ошибка WebSocket-сервера:", err.message);
  if ( err.code === "EADDRINUSE" ) console.error(`Порт ${PORT} занят — может, бот уже запущен в другом окне?`);
  process.exit(1);
});

/* ---------------- Discord ---------------- */

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });

let current = null;      // { channel, connection }
const listeners = new Map();   // userId -> { stream, decoder, peak }

function memberKeys(member) {
  return [member.id, member.user.username, member.user.globalName, member.nickname, member.displayName]
    .filter(Boolean).map(s => String(s).toLowerCase());
}

/** Какой канал слушать: где сидит followUser, иначе самый людный */
function pickChannel() {
  const guilds = [...client.guilds.cache.values()].filter(g => !GUILD_ID || g.id === GUILD_ID);
  if ( FOLLOW ) {
    for ( const g of guilds ) {
      const vs = g.voiceStates.cache.find(v => v.channelId && v.member && memberKeys(v.member).includes(FOLLOW));
      if ( vs ) return vs.channel;
    }
    return null;
  }
  let best = null, count = 0;
  for ( const g of guilds ) {
    for ( const ch of g.channels.cache.values() ) {
      if ( !ch.isVoiceBased?.() ) continue;
      const humans = ch.members.filter(m => !m.user.bot).size;
      if ( humans > count ) { best = ch; count = humans; }
    }
  }
  return best;
}

function membersMessage() {
  const ch = current?.channel;
  const list = ch ? [...ch.members.values()].filter(m => !m.user.bot).map(m => ({
    id: m.id,
    username: m.user.username,
    globalName: m.user.globalName,
    nick: m.nickname,
    displayName: m.displayName,
    mute: !!(m.voice.selfMute || m.voice.serverMute || m.voice.selfDeaf || m.voice.serverDeaf)
  })) : [];
  return { t: "members", channel: ch?.name ?? null, list };
}

let syncing = false;
async function sync() {
  if ( syncing ) return;
  syncing = true;
  try {
    const target = pickChannel();
    if ( target && target.id === current?.channel.id ) return;
    if ( !target ) {
      // Никого нет (или followUser вышел) — уходим, если канал опустел
      const humans = current?.channel.members.filter(m => !m.user.bot).size ?? 0;
      if ( current && !humans ) leave();
      return;
    }
    leave();
    await join(target);
  } catch(err) {
    console.error("Не получилось зайти в голосовой канал:", err.message);
    leave();
  } finally {
    syncing = false;
  }
}

async function join(channel) {
  log(`Захожу в «${channel.name}» (${channel.guild.name})…`);
  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: false,   // чтобы видеть, кто говорит
    selfMute: true
  });
  current = { channel, connection };
  connection.on("error", err => console.error("Ошибка голосового соединения:", err.message));
  connection.on("stateChange", async (_old, state) => {
    if ( state.status === VoiceConnectionStatus.Disconnected ) {
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5000)
        ]);
      } catch {
        if ( current?.connection === connection ) { leave(); setTimeout(sync, 2000); }
      }
    }
  });

  await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
  log(`Слушаю канал «${channel.name}». Можно играть!`);

  const receiver = connection.receiver;
  receiver.speaking.on("start", userId => {
    send({ t: "speak", id: userId, on: true });
    listen(receiver, userId);
  });
  receiver.speaking.on("end", userId => send({ t: "speak", id: userId, on: false }));
  send(membersMessage());
}

function leave() {
  for ( const id of [...listeners.keys()] ) stopListening(id);
  if ( current ) {
    log(`Выхожу из «${current.channel.name}»`);
    try { current.connection.destroy(); } catch {}
  }
  current = null;
  send(membersMessage());
}

/* ---------------- Громкость ---------------- */

/** Подписаться на звук пользователя, чтобы знать громкость (звук нигде не сохраняется) */
function listen(receiver, userId) {
  if ( listeners.has(userId) ) return;
  let stream;
  try {
    stream = receiver.subscribe(userId, { end: { behavior: EndBehaviorType.AfterSilence, duration: 1500 } });
  } catch { return; }
  const entry = { stream, decoder: new OpusScript(48000, 2, OpusScript.Application.VOIP), peak: -Infinity };
  listeners.set(userId, entry);
  stream.on("data", packet => {
    try {
      const pcm = entry.decoder.decode(packet);
      let sum = 0;
      const n = pcm.length >> 1;
      for ( let i = 0; i < pcm.length; i += 2 ) {
        const v = pcm.readInt16LE(i) / 32768;
        sum += v * v;
      }
      const db = 20 * Math.log10(Math.max(Math.sqrt(sum / Math.max(n, 1)), 1e-8));
      if ( db > entry.peak ) entry.peak = db;
    } catch { /* битый/зашифрованный пакет — пропускаем, «говорит» всё равно сработает */ }
  });
  stream.on("error", () => {});
  stream.on("close", () => stopListening(userId));
  stream.on("end", () => stopListening(userId));
}

function stopListening(userId) {
  const e = listeners.get(userId);
  if ( !e ) return;
  listeners.delete(userId);
  try { e.stream.destroy(); } catch {}
  try { e.decoder.delete(); } catch {}
}

// 10 раз в секунду отправляем пиковую громкость каждого говорящего
setInterval(() => {
  for ( const [id, e] of listeners ) {
    if ( e.peak === -Infinity ) continue;
    send({ t: "lvl", id, db: Math.round(e.peak) });
    e.peak = -Infinity;
  }
}, 100);

/* ---------------- События ---------------- */

client.once(Events.ClientReady, c => {
  log(`Бот ${c.user.tag} в сети. Серверов: ${c.guilds.cache.size}`);
  if ( !c.guilds.cache.size ) log("Бот не добавлен ни на один сервер — пригласите его по ссылке из README.");
  if ( FOLLOW ) log(`Слежу за пользователем «${cfg.followUser}»: бот зайдёт в тот канал, где он сидит.`);
  sync();
});

client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  const ch = current?.channel.id;
  if ( ch && (oldState.channelId === ch || newState.channelId === ch) ) send(membersMessage());
  sync();
});

client.on(Events.Error, err => console.error("Ошибка Discord:", err.message));

process.on("SIGINT", () => { leave(); client.destroy(); process.exit(0); });

client.login(TOKEN).catch(err => {
  console.error("Не удалось войти в Discord:", err.message);
  if ( /token/i.test(err.message) ) console.error("Проверьте токен в config.json (Developer Portal → Bot → Reset Token).");
  process.exit(1);
});
