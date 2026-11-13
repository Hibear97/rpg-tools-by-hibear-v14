#!/bin/bash
# RPG-Tools — Discord-бот голосовых портретов (macOS). Запуск: двойной щелчок по этому файлу.
cd "$(dirname "$0")" || exit 1
printf '\033]0;RPG-Tools - Discord-бот\007'

# Node.js из установщика nodejs.org или из Homebrew (Intel и Apple Silicon)
export PATH="/usr/local/bin:/opt/homebrew/bin:$HOME/.volta/bin:$PATH"
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh"

pause() { echo; read -r -p "Нажмите Enter, чтобы закрыть окно…" _; }

if ! command -v node >/dev/null 2>&1; then
  echo "Не найден Node.js. Установите Node.js 24 LTS с https://nodejs.org (файл .pkg) и запустите этот файл снова."
  open "https://nodejs.org"
  pause; exit 1
fi

# Из папки модуля бот переносится в постоянную папку (~/Library/Application Support/RPG-Tools/discord-bot)
# и запускается уже оттуда — тогда обновления модуля не стирают токен и не ломают бота.
node launcher.mjs --install
rc=$?
if [ $rc -eq 10 ]; then
  cd "$HOME/Library/Application Support/RPG-Tools/discord-bot" || { pause; exit 1; }
  chmod +x start-macos.command 2>/dev/null
  exec bash ./start-macos.command
fi
[ $rc -ne 0 ] && { pause; exit 1; }

node launcher.mjs
pause
