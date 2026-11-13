/**
 * Запуск Discord-бота «Голосовых портретов» так, чтобы обновления модуля его не ломали.
 *
 * Бот живёт НЕ в папке модуля, а в постоянной папке пользователя:
 *   Windows — %LOCALAPPDATA%\RPG-Tools\discord-bot
 *   macOS   — ~/Library/Application Support/RPG-Tools/discord-bot
 *   Linux   — ~/.local/share/RPG-Tools/discord-bot
 * Там же лежат config.json (токен) и node_modules — Foundry их не трогает при обновлении модуля.
 *
 *   node launcher.mjs --install  — запущено из папки модуля: копирует бота в постоянную папку (с переносом
 *                                  старого config.json), делает ярлык на рабочем столе, выходит с кодом 10.
 *                                  Вне папки модуля — ничего не делает (код 0).
 *   node launcher.mjs            — подтягивает свежий код из папки модуля (если модуль обновился),
 *                                  создаёт config.json, ставит зависимости при необходимости и запускает бота.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CODE_FILES = [
  "index.mjs", "launcher.mjs", "package.json", "config.example.json",
  "start-windows.bat", "start-macos.command", "КАК ЗАПУСТИТЬ.txt"
];
const RESTART_CODE = 75;
const isWin = process.platform === "win32";
const isMac = process.platform === "darwin";

const log = (...a) => console.log("[RPG-Tools]", ...a);

/** Постоянная папка бота */
function homeDir() {
  if (process.env.RPGT_BOT_HOME) return process.env.RPGT_BOT_HOME;
  if (isWin) return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "RPG-Tools", "discord-bot");
  if (isMac) return path.join(os.homedir(), "Library", "Application Support", "RPG-Tools", "discord-bot");
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "RPG-Tools", "discord-bot");
}

/** Этот экземпляр лежит внутри модуля Foundry (modules/rpg-tools-by-hibear/features/voice-portraits/bot)? */
function isModuleCopy(dir) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, "..", "..", "..", "module.json"), "utf8"));
    return m.id === "rpg-tools-by-hibear" || m.id === "rpg-suite";
  } catch { return false; }
}

const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const read = (p) => { try { return fs.readFileSync(p); } catch { return null; } };
const versionOf = (dir) => { try { return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).version; } catch { return "?"; } };

/** Скопировать файлы кода из src в dst. Возвращает список изменённых файлов. config.json и node_modules не трогаются. */
function copyCode(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  const changed = [];
  for (const f of CODE_FILES) {
    const from = path.join(src, f);
    const data = read(from);
    if (!data) continue;
    const to = path.join(dst, f);
    const old = read(to);
    if (old && Buffer.compare(old, data) === 0) continue;
    fs.writeFileSync(to, data);
    changed.push(f);
  }
  try { fs.chmodSync(path.join(dst, "start-macos.command"), 0o755); } catch { /* Windows */ }
  return changed;
}

/* ---------------- Установка из папки модуля ---------------- */

function createShortcut(home) {
  try {
    if (isWin) {
      const ps = `$d=[Environment]::GetFolderPath('Desktop');` +
        `$s=(New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $d 'RPG-Tools Discord-бот.lnk'));` +
        `$s.TargetPath='${path.join(home, "start-windows.bat").replace(/'/g, "''")}';` +
        `$s.WorkingDirectory='${home.replace(/'/g, "''")}';$s.Save()`;
      const enc = Buffer.from(ps, "utf16le").toString("base64");
      spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", enc], { stdio: "ignore" });
    } else if (isMac) {
      const link = path.join(os.homedir(), "Desktop", "RPG-Tools Discord-бот.command");
      fs.writeFileSync(link, `#!/bin/bash\nexec "${path.join(home, "start-macos.command")}"\n`);
      fs.chmodSync(link, 0o755);
    }
  } catch (e) {
    log("Не удалось создать ярлык на рабочем столе:", e.message);
  }
}

function install() {
  if (!isModuleCopy(HERE)) return 0;
  const home = homeDir();
  if (same(home, HERE)) return 0;
  const first = !fs.existsSync(path.join(home, "launcher.mjs"));
  copyCode(HERE, home);
  // перенос токена из старой схемы, когда бот запускали прямо из папки модуля
  const oldCfg = path.join(HERE, "config.json");
  const newCfg = path.join(home, "config.json");
  if (!fs.existsSync(newCfg) && fs.existsSync(oldCfg)) {
    fs.copyFileSync(oldCfg, newCfg);
    log("Ваш config.json перенесён в постоянную папку.");
  }
  fs.writeFileSync(path.join(home, "source.json"), JSON.stringify({ moduleBotDir: HERE }, null, 2));
  if (first) {
    createShortcut(home);
    log(`Бот установлен в постоянную папку:\n    ${home}\n  Обновления модуля его больше не затрагивают: токен и зависимости хранятся там.${isWin || isMac ? "\n  На рабочем столе появился ярлык «RPG-Tools Discord-бот»." : ""}`);
  }
  return 10;
}

/* ---------------- Обычный запуск ---------------- */

/** Если модуль обновился — забрать свежий код бота из папки модуля. true — сам лаунчер поменялся, нужен перезапуск. */
function syncFromModule() {
  let src = null;
  try { src = JSON.parse(fs.readFileSync(path.join(HERE, "source.json"), "utf8")).moduleBotDir; } catch { return false; }
  // модуль переименовали (папка rpg-suite → rpg-tools-by-hibear) — ищем бота в новой папке и запоминаем её
  if (src && !fs.existsSync(path.join(src, "index.mjs"))) {
    const renamed = src.replace(/([\\/])rpg-suite([\\/])/, "$1rpg-tools-by-hibear$2");
    if (renamed !== src && fs.existsSync(path.join(renamed, "index.mjs"))) {
      src = renamed;
      fs.writeFileSync(path.join(HERE, "source.json"), JSON.stringify({ moduleBotDir: src }, null, 2));
    }
  }
  if (!src || same(src, HERE) || !fs.existsSync(path.join(src, "index.mjs"))) return false;
  const before = versionOf(HERE);
  const changed = copyCode(src, HERE);
  if (!changed.length) return false;
  log(`Бот обновлён из модуля: ${before} → ${versionOf(HERE)} (${changed.join(", ")})`);
  return changed.includes("launcher.mjs");
}

function ensureConfig() {
  const cfgPath = path.join(HERE, "config.json");
  if (!fs.existsSync(cfgPath)) {
    fs.copyFileSync(path.join(HERE, "config.example.json"), cfgPath);
    log(`Создан config.json:\n    ${cfgPath}\n  Вставьте в него токен бота, сохраните файл и запустите бота снова.`);
    if (isWin) spawn("notepad.exe", [cfgPath], { detached: true, stdio: "ignore" }).unref();
    else if (isMac) spawnSync("open", ["-e", cfgPath]);
    return false;
  }
  try {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    if (!cfg.token || String(cfg.token).includes("ВСТАВЬТЕ")) {
      log(`Впишите токен бота в поле "token":\n    ${cfgPath}`);
      if (isWin) spawn("notepad.exe", [cfgPath], { detached: true, stdio: "ignore" }).unref();
      else if (isMac) spawnSync("open", ["-e", cfgPath]);
      return false;
    }
  } catch (e) {
    log(`config.json повреждён (${e.message}).\n  Частая причина — «умные» кавычки “ ” или « » вместо обычных ". Откройте файл и исправьте:\n    ${cfgPath}`);
    return false;
  }
  return true;
}

/** Поставить зависимости, если их нет, сменился package.json, система или версия Node. */
function ensureDeps() {
  const pkg = read(path.join(HERE, "package.json")) ?? Buffer.from("");
  const deps = JSON.stringify(JSON.parse(pkg.toString() || "{}").dependencies ?? {});
  const stamp = crypto.createHash("sha1").update(`${deps}|${process.platform}|${process.arch}|${process.versions.node.split(".")[0]}`).digest("hex");
  const nm = path.join(HERE, "node_modules");
  const stampFile = path.join(nm, ".rpgt-deps");
  if (read(stampFile)?.toString() === stamp) return true;
  log("Устанавливаю зависимости бота, это займёт минуту…");
  fs.rmSync(nm, { recursive: true, force: true });
  const r = spawnSync(isWin ? "npm.cmd" : "npm", ["install", "--omit=dev", "--no-audit", "--no-fund"], {
    cwd: HERE, stdio: "inherit", shell: isWin
  });
  if (r.status !== 0) {
    log("Не удалось установить зависимости. Проверьте интернет и запустите бота снова.");
    return false;
  }
  fs.writeFileSync(stampFile, stamp);
  return true;
}

function runBot() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(HERE, "index.mjs")], { cwd: HERE, stdio: "inherit" });
    const stop = () => child.kill("SIGINT");
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    child.on("exit", (code) => resolve(code ?? 0));
  });
}

async function main() {
  if (process.argv.includes("--install")) return install();

  if (syncFromModule()) {
    // обновился сам лаунчер — передаём управление новой версии
    const r = spawnSync(process.execPath, [path.join(HERE, "launcher.mjs")], { cwd: HERE, stdio: "inherit" });
    return r.status ?? 0;
  }
  log(`Discord-бот v${versionOf(HERE)} · папка: ${HERE}`);
  if (!ensureConfig()) return 0;
  if (!ensureDeps()) return 1;
  for (;;) {
    const code = await runBot();
    if (code !== RESTART_CODE) return code;
    log("Перезапуск бота…");
  }
}

main().then((code) => process.exit(code ?? 0), (err) => { console.error(err); process.exit(1); });
