import { SUITE_ID } from "./constants.js";

/**
 * Общий сокет модуля с маршрутизацией по функциям.
 * Каждая функция шлёт и получает только свои сообщения: { f: "<id функции>", d: <данные> }.
 * Так функции не мешают друг другу, даже если используют одинаковые типы сообщений.
 */
const CHANNEL = `module.${SUITE_ID}`;
const handlers = new Map();
let listening = false;

function listen() {
  if (listening || !game.socket) return;
  listening = true;
  game.socket.on(CHANNEL, (msg) => {
    if (!msg || typeof msg !== "object" || !msg.f) return;
    for (const h of handlers.get(msg.f) ?? []) {
      try { h(msg.d); } catch (err) { console.error(`${SUITE_ID} | socket [${msg.f}]`, err); }
    }
  });
}

export const suiteSocket = {
  /** Подписаться на сообщения функции */
  on(feature, handler) {
    if (!handlers.has(feature)) handlers.set(feature, []);
    handlers.get(feature).push(handler);
    listen();
  },
  /** Отправить сообщение функции всем остальным клиентам */
  emit(feature, data) {
    listen();
    game.socket?.emit(CHANNEL, { f: feature, d: data });
  }
};
