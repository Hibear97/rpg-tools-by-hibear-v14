/**
 * Общая шина функций: как функции узнают друг о друге, не завися друг от друга напрямую.
 *
 *  - suite.isActive("reactions") — запущена ли другая функция в этом клиенте;
 *  - shared.track(key, promise) / shared.wait(key) — одна функция говорит «я ещё работаю над этим»,
 *    другая ждёт, пока она закончит (например, Авто-бой ждёт ответа игрока на «Щит», прежде чем бросать урон);
 *  - shared.flag / shared.busy — короткие отметки «сейчас идёт X».
 *
 * Если одна из функций выключена, шина просто пустая, и другая функция работает как раньше, в одиночку.
 */
const waits = new Map();
const counters = new Map();

export const shared = {
  /** Зарегистрировать незавершённую операцию под ключом. */
  track(key, promise) {
    const p = Promise.resolve(promise).catch(() => null);
    waits.set(key, p);
    p.finally(() => { if (waits.get(key) === p) waits.delete(key); });
    return promise;
  },

  /** Дождаться операции под ключом (если её нет — сразу). Не дольше timeoutMs. */
  async wait(key, timeoutMs = 150000) {
    const p = waits.get(key);
    if (!p) return null;
    return Promise.race([p, new Promise((r) => setTimeout(() => r(null), timeoutMs))]);
  },

  has: (key) => waits.has(key),

  /** Выполнить fn, пока поднята отметка name (вложенные вызовы считаются). */
  async during(name, fn) {
    counters.set(name, (counters.get(name) ?? 0) + 1);
    try { return await fn(); }
    finally { counters.set(name, Math.max(0, (counters.get(name) ?? 1) - 1)); }
  },

  /** Поднята ли сейчас отметка name. */
  busy: (name) => (counters.get(name) ?? 0) > 0
};
