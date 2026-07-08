#!/usr/bin/env bash
#
# flareburner — Ubuntu/Debian VPS setup & deploy script.
#
# Installs Node.js, Google Chrome, Xvfb and project dependencies, then runs the
# API as a systemd service so it stays up across reboots/crashes.
#
# Usage:
#   sudo bash setup.sh            # install everything + start service on :4001
#   PORT=8080 sudo bash setup.sh  # use a different port
#
set -euo pipefail

PORT="${PORT:-4001}"
NODE_MAJOR="${NODE_MAJOR:-20}"
SERVICE_NAME="flareburner"

# This is a Linux (Ubuntu/Debian) deploy script. Bail clearly if it's run on
# Windows/macOS/Git Bash, where apt-get & systemd don't exist.
if [[ "$(uname -s 2>/dev/null)" != Linux* ]] || ! command -v apt-get >/dev/null 2>&1; then
  echo "setup.sh deploys flareburner on an Ubuntu/Debian VPS — it can't run here." >&2
  echo "  • Local dev (Windows/macOS): just run  node server.js" >&2
  echo "  • Deploy: copy this project to your VPS, then run there:  sudo bash setup.sh" >&2
  exit 1
fi

# Resolve the project directory (where this script lives) and the user that
# should own the service (the human who invoked sudo, not root).
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_USER="${SUDO_USER:-$(whoami)}"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Please run as root: sudo bash setup.sh" >&2
  exit 1
fi

echo ">> flareburner deploy"
echo "   project : ${PROJECT_DIR}"
echo "   user    : ${RUN_USER}"
echo "   port    : ${PORT}"

export DEBIAN_FRONTEND=noninteractive

echo ">> [1/6] System packages"
apt-get update -y
# Only the essentials here. Chrome's own shared-lib dependencies (libnss3,
# libasound2/libasound2t64, libgbm1, …) are resolved automatically when apt
# installs google-chrome-stable in step 3 — which avoids version-specific
# package-name breakage (e.g. libasound2 -> libasound2t64 on Ubuntu 24.04).
apt-get install -y \
  curl ca-certificates gnupg \
  xvfb \
  fonts-liberation fonts-noto-color-emoji

echo ">> [2/6] Node.js ${NODE_MAJOR}.x"
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v | cut -c2- | cut -d. -f1)" -lt "${NODE_MAJOR}" ]]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
fi
node -v

echo ">> [3/6] Google Chrome (stable)"
if ! command -v google-chrome-stable >/dev/null 2>&1; then
  curl -fsSL https://dl.google.com/linux/linux_signing_key.pub \
    | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg
  echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" \
    > /etc/apt/sources.list.d/google-chrome.list
  apt-get update -y
  apt-get install -y google-chrome-stable
fi
google-chrome-stable --version

echo ">> [4/6] Project dependencies"
# --ignore-scripts skips native build steps (e.g. the optional `sleep` addon),
# so no compiler toolchain is required on the host.
su - "${RUN_USER}" -c "cd '${PROJECT_DIR}' && npm install --omit=dev --ignore-scripts --no-audit --no-fund"

echo ">> [5/6] Config (.env) + systemd service"
# Seed a .env from the example on first run so config lives in one place.
if [[ ! -f "${PROJECT_DIR}/.env" && -f "${PROJECT_DIR}/.env.example" ]]; then
  sed "s/^PORT=.*/PORT=${PORT}/" "${PROJECT_DIR}/.env.example" > "${PROJECT_DIR}/.env"
  chown "${RUN_USER}:${RUN_USER}" "${PROJECT_DIR}/.env"
  echo "   wrote ${PROJECT_DIR}/.env (edit it to set API_KEY, POOL_SIZE, etc.)"
fi

cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=flareburner Cloudflare-bypass scraping API
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${RUN_USER}
WorkingDirectory=${PROJECT_DIR}
ExecStart=/usr/bin/node ${PROJECT_DIR}/server.js
Restart=always
RestartSec=3
# Chrome needs a writable HOME. All app config (PORT, API_KEY, POOL_SIZE, …)
# is read from ${PROJECT_DIR}/.env — edit that file, then: systemctl restart ${SERVICE_NAME}
Environment=HOME=/home/${RUN_USER}

[Install]
WantedBy=multi-user.target
EOF

echo ">> [6/6] Starting service"
if [[ -d /run/systemd/system ]]; then
  # Real systemd host (typical VPS).
  systemctl daemon-reload
  systemctl enable "${SERVICE_NAME}"
  systemctl restart "${SERVICE_NAME}"
  sleep 2
  systemctl --no-pager status "${SERVICE_NAME}" || true

  echo
  echo ">> Done. flareburner is running on http://0.0.0.0:${PORT}"
  echo "   Test:  curl -X POST http://localhost:${PORT}/v1 -H 'Content-Type: application/json' -d '{\"url\":\"https://nowsecure.nl\"}'"
  echo "   Logs:  journalctl -u ${SERVICE_NAME} -f"
  echo "   Stop:  systemctl stop ${SERVICE_NAME}"
else
  # No systemd (Docker / dev container / Codespace). Run it with nohup instead.
  echo "   systemd not available — starting with nohup (no auto-restart on reboot)."
  PID_FILE="${PROJECT_DIR}/${SERVICE_NAME}.pid"
  LOG_FILE="${PROJECT_DIR}/${SERVICE_NAME}.log"
  # Stop a previous nohup instance if one is recorded.
  if [[ -f "${PID_FILE}" ]] && kill -0 "$(cat "${PID_FILE}")" 2>/dev/null; then
    kill "$(cat "${PID_FILE}")" 2>/dev/null || true
    sleep 1
  fi
  su - "${RUN_USER}" -c "cd '${PROJECT_DIR}' && PORT='${PORT}' nohup node server.js >> '${LOG_FILE}' 2>&1 & echo \$! > '${PID_FILE}'"
  sleep 2

  echo
  echo ">> Done. flareburner is running on http://0.0.0.0:${PORT}"
  echo "   Test:  curl -X POST http://localhost:${PORT}/v1 -H 'Content-Type: application/json' -d '{\"url\":\"https://nowsecure.nl\"}'"
  echo "   Logs:  tail -f '${LOG_FILE}'"
  echo "   Stop:  kill \$(cat '${PID_FILE}')"
fi
