import { MODULE_ID, EMOTIONS, VOICE_SLOTS } from "./constants.js";
import { getConfig, configOwner } from "./bar.js";
import { getSetting, setSetting } from "./settings.js";

const esc = s => String(s ?? "").replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[c]);

function imageRow(id, label, hint, value, placeholder = "") {
  return `
    <div class="vp-img-row">
      <img class="vp-thumb" src="${esc(value || placeholder || "icons/svg/mystery-man.svg")}" data-thumb="${id}">
      <div class="vp-img-fields">
        <label>${label}${hint ? ` <span class="vp-dim">— ${hint}</span>` : ""}</label>
        <div class="vp-img-input">
          <input type="text" name="img.${id}" value="${esc(value)}" placeholder="${esc(placeholder ? "по умолчанию: " + placeholder : "не задано")}">
          <button type="button" data-pick="${id}" data-tooltip="Выбрать файл"><i class="fa-solid fa-file-image"></i></button>
          <button type="button" data-clear="${id}" data-tooltip="Очистить"><i class="fa-solid fa-xmark"></i></button>
        </div>
      </div>
    </div>`;
}

/**
 * Окно настройки портрета пользователя.
 * @param {User} user
 */
export async function openConfigDialog(user, voice) {
  const cfg = getConfig(user);
  const isSelf = user.id === game.user.id;
  const defaultImg = user.character?.img || user.avatar || "";
  const imgs = cfg.images;

  const calibration = isSelf ? `
    <fieldset class="vp-calib">
      <legend>Микрофон (настройки этого компьютера)</legend>
      <div class="vp-meter"><div class="vp-meter-fill"></div>
        <div class="vp-meter-mark speak"></div><div class="vp-meter-mark shout"></div></div>
      <p class="vp-source">Голос сейчас берётся из: <b>${
        voice.isDiscordControlled(user.id) ? "Discord-бота (пороги ниже не используются)"
        : voice.hasFeed ? (voice.feedSource === "telemost" ? "Яндекс Телемоста (скрипт)" : "скрипта на странице звонка")
        : getSetting("voiceSource") === "foundry" ? "голосового чата Foundry" : "микрофона в браузере"}</b></p>
      <div class="vp-meter-text">Сейчас: <b data-db>—</b> дБ <span class="vp-dim">(скажите что-нибудь обычным голосом, потом громко)</span></div>
      <label>Порог речи: <b data-out="speak">${getSetting("speakThreshold")}</b> дБ
        <input type="range" name="speakThreshold" min="-80" max="-10" step="1" value="${getSetting("speakThreshold")}"></label>
      <label>Порог крика: <b data-out="shout">${getSetting("shoutThreshold")}</b> дБ
        <input type="range" name="shoutThreshold" min="-50" max="0" step="1" value="${getSetting("shoutThreshold")}"></label>
    </fieldset>` : "";

  const owner = configOwner(user);
  const ownerNote = user.character
    ? `<p class="vp-owner"><i class="fa-solid fa-link"></i> Портреты привязаны к персонажу <b>${esc(user.character.name)}</b>. Если игроку назначат другого персонажа, у того будет свой набор.</p>`
    : `<p class="vp-owner"><i class="fa-solid fa-triangle-exclamation"></i> За игроком не закреплён персонаж — портреты сохраняются для самого игрока. Персонажа можно назначить в «Настройках игрока».</p>`;

  const di = voice.discordInfo;
  const discordStatus = !getSetting("discordBridge")
      ? `<span class="vp-bad">Discord-бот выключен в настройках мира. Мастер: центр управления (Shift+M) → Голосовые портреты → «Discord-бот: включить».</span>`
    : !di.on ? `<span class="vp-bad">бот не подключён — мастер должен быть в Foundry на том компьютере, где запущен бот (окно бота открыто)</span>`
    : di.matched.has(user.id) ? `<span class="vp-ok">✓ найден в канале «${esc(di.channel)}»</span>`
    : `<span class="vp-bad">✗ сейчас нет в голосовом канале «${esc(di.channel)}» (или ник указан неверно)</span>`;

  const content = `
    <div class="vp-config">
      ${ownerNote}
      <div class="form-group">
        <label>Имя на табличке</label>
        <input type="text" name="displayName" value="${esc(cfg.displayName)}" placeholder="${esc(user.character?.name || user.name)}">
      </div>
      <div class="form-group">
        <label>Режим портрета</label>
        <select name="mode">
          <option value="voice" ${cfg.mode === "voice" ? "selected" : ""}>Реагирует на голос</option>
          <option value="static" ${cfg.mode === "static" ? "selected" : ""}>Статичный</option>
        </select>
      </div>
      <div class="form-group">
        <label>Ник в Discord <span class="vp-dim">(для бота)</span></label>
        <input type="text" name="discord" value="${esc(user.getFlag(MODULE_ID, "vp.discord") ?? "")}" placeholder="имя пользователя или ID">
      </div>
      ${discordStatus ? `<p class="vp-discord-status">Discord: ${discordStatus}</p>` : ""}
      <div class="form-group">
        <label>Подсвечивать рамку, когда говорит</label>
        <input type="checkbox" name="ring" ${cfg.ring !== false ? "checked" : ""}>
      </div>
      <p class="vp-dim">Пустые картинки заменяются основным портретом. «Говорит» и «Кричит» используются только в режиме «Реагирует на голос»; если их нет, портрет просто покачивается и светится в такт голосу.</p>
      <h4>Основной портрет и голос</h4>
      ${imageRow("neutral", "Основной портрет", "", imgs.neutral, defaultImg)}
      ${VOICE_SLOTS.map(s => imageRow(s.id, s.label, s.hint, imgs[s.id])).join("")}
      <h4>Эмоции (правый клик по портрету)</h4>
      ${EMOTIONS.filter(e => e.id !== "neutral").map(e => imageRow(e.id, `<i class="fa-solid ${e.icon}"></i> ${e.label}`, "", imgs[e.id])).join("")}
      ${calibration}
    </div>`;

  let meterTimer = null;
  const DialogV2 = foundry.applications.api.DialogV2;

  const result = await DialogV2.wait({
    window: { title: `Портрет: ${user.character?.name ?? user.name}`, icon: "fa-solid fa-image-portrait" },
    position: { width: 600 },
    classes: ["vp-config-dialog"],
    content,
    rejectClose: false,
    buttons: [
      {
        action: "save", label: "Сохранить", icon: "fa-solid fa-floppy-disk", default: true,
        callback: (event, button) => {
          const fd = new FormData(button.form);
          return Object.fromEntries(fd.entries());
        }
      },
      { action: "cancel", label: "Отмена", icon: "fa-solid fa-xmark" }
    ],
    render: (event, arg) => {
      const root = arg instanceof HTMLElement ? arg : (arg?.element ?? event?.target?.element);
      if ( !root ) return;
      const form = root.querySelector("form") ?? root;

      // Выбор файла
      form.addEventListener("click", ev => {
        const pick = ev.target.closest("[data-pick]");
        const clear = ev.target.closest("[data-clear]");
        if ( pick ) {
          const id = pick.dataset.pick;
          const input = form.querySelector(`[name="img.${id}"]`);
          const FP = foundry.applications?.apps?.FilePicker?.implementation ?? globalThis.FilePicker;
          new FP({
            type: "image", current: input.value,
            callback: path => { input.value = path; input.dispatchEvent(new Event("change", { bubbles: true })); }
          }).render(true);
        }
        if ( clear ) {
          const input = form.querySelector(`[name="img.${clear.dataset.clear}"]`);
          input.value = "";
          input.dispatchEvent(new Event("change", { bubbles: true }));
        }
      });
      // Превью
      form.addEventListener("change", ev => {
        const name = ev.target.name ?? "";
        if ( !name.startsWith("img.") ) return;
        const id = name.slice(4);
        const thumb = form.querySelector(`[data-thumb="${id}"]`);
        thumb.src = ev.target.value || (id === "neutral" ? defaultImg : "") || "icons/svg/mystery-man.svg";
      });

      // Индикатор микрофона
      if ( isSelf ) {
        const fill = form.querySelector(".vp-meter-fill");
        const dbOut = form.querySelector("[data-db]");
        const speak = form.querySelector("[name=speakThreshold]");
        const shout = form.querySelector("[name=shoutThreshold]");
        const markS = form.querySelector(".vp-meter-mark.speak");
        const markL = form.querySelector(".vp-meter-mark.shout");
        const pct = db => `${Math.min(Math.max((db + 80) / 80, 0), 1) * 100}%`;
        const marks = () => {
          markS.style.left = pct(Number(speak.value));
          markL.style.left = pct(Number(shout.value));
          form.querySelector("[data-out=speak]").textContent = speak.value;
          form.querySelector("[data-out=shout]").textContent = shout.value;
        };
        speak.addEventListener("input", marks);
        shout.addEventListener("input", marks);
        marks();
        meterTimer = setInterval(() => {
          const db = voice.currentDb;
          fill.style.width = pct(db);
          fill.classList.toggle("talk", db > Number(speak.value));
          fill.classList.toggle("shout", db > Number(shout.value));
          dbOut.textContent = db > -100 ? db.toFixed(0) : "нет сигнала";
        }, 60);
      }
    }
  });
  clearInterval(meterTimer);
  if ( !result || typeof result !== "object" ) return;

  const images = {};
  for ( const [k, v] of Object.entries(result) ) if ( k.startsWith("img.") ) images[k.slice(4)] = String(v).trim();
  const newCfg = {
    displayName: String(result.displayName ?? "").trim(),
    mode: result.mode === "static" ? "static" : "voice",
    ring: result.ring === "on",
    images
  };
  await owner.update({ [`flags.${MODULE_ID}.vp.config`]: newCfg });
  const discord = String(result.discord ?? "").trim().replace(/^@/, "");
  if ( discord !== (user.getFlag(MODULE_ID, "vp.discord") ?? "") ) await user.setFlag(MODULE_ID, "vp.discord", discord);

  if ( isSelf && result.speakThreshold !== undefined ) {
    await setSetting("speakThreshold", Number(result.speakThreshold));
    await setSetting("shoutThreshold", Number(result.shoutThreshold));
  }
  ui.notifications.info("Портрет сохранён");
}
