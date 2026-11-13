// ==UserScript==
// @name         Голосовые портреты: Телемост → Foundry
// @namespace    voice-portraits
// @version      1.1.0
// @description  Сообщает модулю Foundry «Голосовые портреты», когда ваш голос реально уходит в звонок Яндекс Телемоста (учитывает выключенный микрофон). Звук никуда не записывается и не передаётся.
// @match        https://telemost.yandex.ru/*
// @match        https://telemost.360.yandex.ru/*
// @match        https://discord.com/*
// @match        *://*/game*
// @include      /^https?:\/\/[^/]+\/(.*\/)?game([?#].*)?$/
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @sandbox      JavaScript
// ==/UserScript==

(function () {
  "use strict";
  const KEY = "vp_feed";
  const host = location.hostname;
  const W = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;

  /* ===================== Страница звонка (Телемост / Discord в браузере) ===================== */
  if ( /telemost/.test(host) || host === "discord.com" ) {
    const SRC = host === "discord.com" ? "discord-web" : "telemost";
    const pcs = new Set();

    // Запоминаем все WebRTC-соединения, которые создаёт страница
    for ( const name of ["RTCPeerConnection", "webkitRTCPeerConnection"] ) {
      const Orig = W[name];
      if ( !Orig || Orig.__vpWrapped ) continue;
      const Wrapped = new Proxy(Orig, {
        construct(target, args, newTarget) {
          const pc = Reflect.construct(target, args, newTarget);
          pcs.add(pc);
          return pc;
        },
        get(target, prop, recv) {
          if ( prop === "__vpWrapped" ) return true;
          return Reflect.get(target, prop, recv);
        }
      });
      try { W[name] = Wrapped; } catch (e) { /* не страшно */ }
    }

    /**
     * Голос «уходит в звонок», если есть живая, включённая аудиодорожка на отправку.
     * Громкость берём из статистики WebRTC — это ровно то, что слышат собеседники:
     * при выключенном микрофоне там тишина.
     */
    async function poll() {
      if ( !pcs.size ) return;
      let open = false;
      let level = 0;
      for ( const pc of [...pcs] ) {
        if ( pc.connectionState === "closed" || pc.signalingState === "closed" ) { pcs.delete(pc); continue; }
        let senders = [];
        try { senders = pc.getSenders(); } catch (e) { continue; }
        for ( const sender of senders ) {
          const t = sender.track;
          if ( !t || t.kind !== "audio" || t.readyState !== "live" || !t.enabled || t.muted ) continue;
          try {
            const enc = sender.getParameters().encodings || [];
            if ( enc.length && enc.every(e => e.active === false) ) continue;
          } catch (e) { /* ok */ }
          open = true;
          try {
            const stats = await sender.getStats();
            stats.forEach(r => {
              if ( r.type === "media-source" && r.kind === "audio" && typeof r.audioLevel === "number" ) {
                level = Math.max(level, r.audioLevel);
              }
            });
          } catch (e) { /* ok */ }
        }
      }
      GM_setValue(KEY, { src: SRC, live: open, level: open ? level : 0, ts: Date.now() });
    }
    setInterval(poll, 100);
    return;
  }

  /* ===================== Вкладка Foundry ===================== */
  const fire = v => {
    if ( !v || Date.now() - (v.ts || 0) > 1500 ) return;
    try {
      W.dispatchEvent(new W.CustomEvent("voice-portraits:feed", { detail: JSON.stringify(v) }));
    } catch (e) { /* ok */ }
  };
  GM_addValueChangeListener(KEY, (_name, _old, value) => fire(value));
})();
