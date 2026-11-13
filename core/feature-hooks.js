/**
 * Отложенные хуки для функции.
 *
 * Код бывших отдельных модулей писался так: Hooks.on(...) / Hooks.once("init", ...) прямо на верхнем уровне файла.
 * Чтобы выключенная функция вообще ни на что не подписывалась, каждая функция получает свой объект Hooks:
 *
 *   import { createFeatureHooks } from "../../core/feature-hooks.js";
 *   const Hooks = createFeatureHooks();
 *   export function setup() { Hooks.activate(); }
 *
 * До activate() все подписки складываются в очередь. activate() вызывает ядро во время init и только если функция
 * включена: подписки "init" выполняются сразу (init уже идёт), остальные передаются настоящему Hooks.
 * После activate() объект работает как обычный Hooks.
 */
export function createFeatureHooks() {
  const G = globalThis.Hooks;
  const queue = [];
  let live = false;

  return {
    on(name, fn, options) {
      if (live) return G.on(name, fn, options);
      queue.push(["on", name, fn, options]);
      return null;
    },
    once(name, fn) {
      if (live) return G.once(name, fn);
      queue.push(["once", name, fn]);
      return null;
    },
    off: (name, fn) => G.off(name, fn),
    call: (...args) => G.call(...args),
    callAll: (...args) => G.callAll(...args),
    get active() { return live; },
    activate() {
      if (live) return;
      live = true;
      const list = queue.splice(0);
      for (const [method, name, fn, options] of list) {
        if (name === "init") fn();          // init уже идёт — выполняем сразу
        else G[method](name, fn, options);
      }
    }
  };
}
