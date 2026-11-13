import { MODULE_ID, EMOTIONS } from "./constants.js";
import { registerSettings, registerKeybindings, getSetting, setSetting } from "./settings.js";
import { VoiceMonitor } from "./voice.js";
import { PortraitBar, getConfig, getEmotion, pickImage, baseImage } from "./bar.js";
import { openConfigDialog } from "./config-dialog.js";
import { DiscordBridge } from "./discord-bridge.js";

const voice = new VoiceMonitor();
const bar = new PortraitBar(voice);
const discord = new DiscordBridge(voice);

/** Публичное API — можно использовать в макросах: game.voicePortraits.setEmotion(game.user, "happy") */
const api = {
  voice, bar, discord,
  emotions: EMOTIONS.map(e => e.id),
  async setEmotion(user = game.user, emotion = "neutral") {
    if ( typeof user === "string" ) user = game.users.get(user) ?? game.users.getName(user);
    if ( !user ) return;
    if ( !EMOTIONS.some(e => e.id === emotion) ) return ui.notifications.warn(`Нет эмоции «${emotion}»`);
    if ( user.id !== game.user.id && !game.user.isGM ) return;
    if ( (user.getFlag(MODULE_ID, "vp.emotion") || "neutral") === emotion ) return;
    await user.setFlag(MODULE_ID, "vp.emotion", emotion);
  },
  openConfig(user = game.user) {
    if ( user.id !== game.user.id && !game.user.isGM ) return;
    return openConfigDialog(user, voice);
  },
  showBubble: (userId, text) => bar.showBubble(userId, text),

  // Для интеграции с другими модулями (BG3 Style HUD и т.п.)
  emotionList: EMOTIONS,
  getConfig, getEmotion, pickImage, baseImage,
  openMenu: (user, event) => bar.openMenu(user, event)
};

/**
 * Запуск функции. Вызывается ядром RPG Suite во время init, только если функция включена.
 */
export function setup() {
  registerSettings();
  registerKeybindings();
  game.voicePortraits = api;
  registerHooks();
}

function registerHooks() {

Hooks.once("ready", () => {
  voice.init();
  bar.init();
  discord.start();
  offerFoundryVoiceSetup();
  offerDiscordNick();
  warnBridgeOff();
});

/* -------------------------------------------- */
/*  Обновление панели                            */
/* -------------------------------------------- */

Hooks.on("userConnected", (user, connected) => {
  // Если «главный» мастер сменился — мост с ботом переезжает
  // Окна мастера сами договариваются, кто рассылает голос (см. DiscordBridge.isHub) — здесь только запускаем мост у себя
  if ( user.isGM && getSetting("discordBridge") ) setTimeout(() => discord.start(), 500);
  if ( !connected ) voice.forget(user.id);
  else if ( user.id !== game.user.id ) voice.sendStatus();
  bar.render();
});

Hooks.on("updateUser", (user, changes) => {
  if ( foundry.utils.hasProperty(changes, `flags.${MODULE_ID}.vp.discord`) ) discord.broadcastStatus();
  if ( ["flags", "character", "avatar", "color", "name", "role", "active"].some(k => k in changes) ) bar.render();
});

Hooks.on("updateActor", (actor, changes) => {
  if ( !("img" in changes) && !("name" in changes) && !foundry.utils.hasProperty(changes, `flags.${MODULE_ID}.vp`) ) return;
  if ( game.users.some(u => u.character?.id === actor.id) ) bar.render();
});

Hooks.on("renderPlayers", () => bar.position());
Hooks.on("collapseSidebar", () => bar.position());
Hooks.on("rtcSettingsChanged", () => { voice.refresh(); voice.sendStatus(); bar.render(); });

/* -------------------------------------------- */
/*  Облачка чата                                 */
/* -------------------------------------------- */

const STYLES = CONST.CHAT_MESSAGE_STYLES ?? {};

function plainText(html) {
  const doc = new DOMParser().parseFromString(String(html ?? ""), "text/html");   // скрипты не выполняются
  doc.querySelectorAll("br, p, div").forEach(n => n.append(" "));
  return (doc.body.textContent ?? "").replace(/\s+/g, " ").trim();
}

function isPlayerCharacterSpeaker(speaker) {
  const actor = speaker?.actor ? game.actors.get(speaker.actor) : null;
  return !!actor?.hasPlayerOwner;
}

Hooks.on("createChatMessage", message => {
  if ( !getSetting("bubbles") ) return;
  const author = message.author ?? message.user;
  if ( !author ) return;
  if ( message.visible === false || message.blind ) return;
  if ( message.whisper?.length && !message.whisper.includes(game.user.id) && author.id !== game.user.id ) return;

  // ГМ говорит от лица NPC-токена — облачко остаётся на поле, а не у портрета ГМа
  if ( author.isGM && message.speaker?.token && !isPlayerCharacterSpeaker(message.speaker) ) return;

  let text = "";
  if ( message.isRoll ) {
    if ( !getSetting("bubbleRolls") ) return;
    const totals = (message.rolls ?? []).map(r => r.total).filter(t => t !== undefined);
    if ( !totals.length ) return;
    const flavor = plainText(message.flavor);
    text = `🎲 ${flavor ? flavor + ": " : ""}${totals.join(", ")}`;
  } else {
    const style = message.style ?? message.type;
    const isChatStyle = [STYLES.OOC, STYLES.IC, STYLES.EMOTE].includes(style);
    // Карточки предметов/заклинаний систем — это HTML-блоки, их не показываем
    const looksLikeCard = /<(div|section|header|table|form)\b/i.test(message.content ?? "");
    if ( !isChatStyle && looksLikeCard ) return;
    text = plainText(message.content);
  }
  if ( !text ) return;
  if ( text.length > 220 ) text = `${text.slice(0, 217)}…`;
  const emote = (message.style ?? message.type) === STYLES.EMOTE;
  bar.showBubble(author.id, text, { emote });
});

/** Не дублировать облачка над токенами персонажей игроков */
Hooks.on("chatBubbleHTML", token => {
  if ( !getSetting("hideCanvasBubbles") || !getSetting("bubbles") ) return;
  if ( token?.actor?.hasPlayerOwner ) return false;
});

/* -------------------------------------------- */
/*  Помощь ГМу: включить голосовой чат Foundry   */
/* -------------------------------------------- */

async function offerFoundryVoiceSetup() {
  if ( !game.user.isGM || getSetting("voiceSource") !== "foundry" || getSetting("setupPrompted") ) return;
  const rtc = game.webrtc;
  if ( !rtc || rtc.mode ) return;   // уже включён
  const DialogV2 = foundry.applications.api.DialogV2;
  const choice = await DialogV2.wait({
    window: { title: "Голосовые портреты" },
    content: `<p>Голосовой чат Foundry сейчас <b>выключен</b>. Включить его в режиме «только звук»?</p>
      <p class="vp-dim">Потом все игроки должны обновить страницу (F5) и разрешить доступ к микрофону.
      Если вы общаетесь в Discord — выберите «Я в Discord», портреты будут реагировать на ваш микрофон без передачи звука.</p>`,
    rejectClose: false,
    buttons: [
      { action: "enable", label: "Включить (только звук)", icon: "fa-solid fa-microphone", default: true },
      { action: "external", label: "Я в Discord", icon: "fa-brands fa-discord" },
      { action: "later", label: "Не сейчас" }
    ]
  });
  if ( choice === "later" || !choice ) return;
  await setSetting("setupPrompted", true);
  if ( choice === "external" ) {
    await setSetting("voiceSource", "external");   // requiresReload покажет запрос на перезагрузку
    return;
  }
  try {
    const AUDIO = foundry.av?.AVSettings?.AV_MODES?.AUDIO ?? globalThis.AVSettings?.AV_MODES?.AUDIO ?? 1;
    await rtc.settings.set("world", "mode", AUDIO);
    ui.notifications.info("Голосовой чат включён. Попросите игроков обновить страницу (F5).");
    foundry.utils.debouncedReload?.() ?? window.location.reload();
  } catch(err) {
    console.error(`${MODULE_ID} |`, err);
    ui.notifications.error("Не получилось включить голосовой чат автоматически. Включите его вручную: Настройки → Настройка аудио/видео → Режим: только аудио.");
  }
}

/* -------------------------------------------- */
/*  Помощь игроку: привязать свой ник в Discord  */
/* -------------------------------------------- */

/**
 * Источник голоса выбирает мастер (это настройка мира). Если мастер подключил Discord-бота,
 * портрет игрока оживает, только когда бот знает, кто этот игрок в Discord. Поэтому при входе
 * игроку без указанного ника один раз предлагаем его ввести.
 */
/** Мастеру: голос «Внешний», а Discord-бот не включён — портреты игроков без https двигаться не будут. */
function warnBridgeOff() {
  if ( !game.user.isGM || getSetting("voiceSource") !== "external" || getSetting("discordBridge") ) return;
  ui.notifications.warn("Голосовые портреты: источник голоса «Внешний», но Discord-бот выключен. "
    + "Если бот запущен — включите «Discord-бот: включить» (центр управления → Голосовые портреты).");
}

async function offerDiscordNick() {
  if ( game.user.isGM || !getSetting("discordBridge") ) return;
  if ( game.user.getFlag(MODULE_ID, "vp.discord") || getSetting("discordPromptOff") ) return;
  const DialogV2 = foundry.applications.api.DialogV2;
  const result = await DialogV2.wait({
    window: { title: "Голосовые портреты · Discord", icon: "fa-brands fa-discord" },
    content: `<p>Мастер общается с группой в <b>Discord</b>. Чтобы ваш портрет двигался, когда вы говорите,
      укажите свой ник в Discord (имя пользователя, а не отображаемое имя — его видно в профиле Discord).</p>
      <div class="form-group"><label>Ник в Discord</label>
      <input type="text" name="discord" placeholder="например, hibear" autofocus></div>
      <p class="vp-dim">Изменить можно позже: правый клик по своему портрету → «Настроить портрет…».</p>`,
    rejectClose: false,
    buttons: [
      { action: "save", label: "Сохранить", icon: "fa-solid fa-check", default: true,
        callback: (event, button) => String(button.form?.elements?.discord?.value ?? "").trim().replace(/^@/, "") },
      { action: "no", label: "Я не в Discord", icon: "fa-solid fa-xmark", callback: () => "__no" },
      { action: "later", label: "Позже", callback: () => null }
    ]
  });
  if ( result === "__no" ) return setSetting("discordPromptOff", true);
  if ( result ) {
    await game.user.setFlag(MODULE_ID, "vp.discord", result);
    ui.notifications.info(`Голосовые портреты: ник в Discord «${result}» сохранён.`);
  }
}

}   // registerHooks
