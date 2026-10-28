#!/usr/bin/env bash
# Deploys the current main branch to a host that runs the app as a systemd user service.
# Usage: scripts/deploy-remote.sh <ssh-host>
# It does not change the tailnet proxy and does not use sudo. Add the proxy path once by hand.
set -euo pipefail
HOST="${1:?Usage: scripts/deploy-remote.sh <ssh-host>}"
ssh "$HOST" 'set -euo pipefail
  cd ~/Repos/job-search-engine
  git pull --ff-only -q
  npm ci --no-audit --no-fund >/dev/null
  npm run build >/dev/null
  systemctl --user restart job-search-engine
  sleep 3
  systemctl --user is-active job-search-engine
  set -a; . ~/data/job-search-engine/job-search-engine.env; set +a
  curl -fsS "http://127.0.0.1:${PORT}${BASE_PATH}/api/v1/health"
  echo
'
