#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${REPO_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
CONFIG_FILE="${CONFIG_FILE:-$REPO_DIR/scripts/macos_update_socks5.env}"
GIT_REMOTE="${GIT_REMOTE:-origin}"
GIT_BRANCH="${GIT_BRANCH:-main}"

export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.hermes/node/bin:$HOME/.nvm/current/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

log() {
  printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"
}

if [ -f "$CONFIG_FILE" ]; then
  log "Loading macOS config: $CONFIG_FILE"
  set -a
  # shellcheck disable=SC1090
  . "$CONFIG_FILE"
  set +a
else
  log "No macOS config found at $CONFIG_FILE; using defaults"
fi

cd "$REPO_DIR"

if [ -d .git ]; then
  log "Pulling latest repository state"
  git pull --ff-only "$GIT_REMOTE" "$GIT_BRANCH"
fi

log "Running SOCKS5 checker"
node scripts/update-socks5.mjs

if [ -d .git ]; then
  git config user.name "${GIT_USER_NAME:-JERRYZFC}"
  git config user.email "${GIT_USER_EMAIL:-shrl007@163.com}"
  git add data/
  if git diff --cached --quiet; then
    log "No data changes to commit"
  else
    git commit -m "${GIT_COMMIT_MESSAGE:-chore: refresh locally verified SOCKS5 nodes}"
    git push "$GIT_REMOTE" "HEAD:$GIT_BRANCH"
  fi
fi

log "SOCKS5 update completed"
