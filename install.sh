#!/usr/bin/env bash
# open-envelope installer.
#   curl -fsSL https://raw.githubusercontent.com/seahyc/open-envelope/main/install.sh | bash
# or, from a checkout:  ./install.sh
#
# Needs: git, docker (with compose v2), openssl. Creates ./open-envelope (or uses the
# current checkout), writes a .env with fresh random secrets, builds and starts it.
#
# Options (env vars):
#   OE_DIR=<path>        install location (default ./open-envelope)
#   OE_PORT=3100         host port
#   OE_BIND=127.0.0.1    interface to bind. Use 0.0.0.0 ONLY behind an auth proxy.
#   OE_REPO=<git url>    repo to clone
set -euo pipefail

REPO="${OE_REPO:-https://github.com/seahyc/open-envelope.git}"
PORT="${OE_PORT:-3100}"
BIND="${OE_BIND:-127.0.0.1}"

say()  { printf '\033[1m==> %s\033[0m\n' "$*"; }
die()  { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "$1 is required but not installed. $2"; }

need git     "Install git first."
need docker  "Install Docker: https://docs.docker.com/get-docker/"
need openssl "Install openssl first."
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required ('docker compose')."
docker info >/dev/null 2>&1 || die "Docker is installed but not running."

# Use the current checkout if we're inside one, otherwise clone.
if [ -f docker-compose.yml ] && [ -f Dockerfile ] && grep -q '"name": "open-envelope"' package.json 2>/dev/null; then
  DIR="$(pwd)"
else
  DIR="${OE_DIR:-$(pwd)/open-envelope}"
  if [ -d "$DIR/.git" ]; then
    say "Updating $DIR"
    git -C "$DIR" pull --ff-only
  else
    say "Cloning into $DIR"
    git clone --depth 1 "$REPO" "$DIR"
  fi
fi
cd "$DIR"

if [ -f .env ]; then
  say "Keeping existing .env"
else
  say "Writing .env with fresh secrets"
  cp .env.example .env
  set_env() { # set_env KEY VALUE
    if grep -q "^$1=" .env; then
      # portable in-place edit (BSD + GNU sed)
      sed -e "s|^$1=.*|$1=$2|" .env > .env.tmp && mv .env.tmp .env
    else
      printf '%s=%s\n' "$1" "$2" >> .env
    fi
  }
  set_env INGEST_API_KEY "$(openssl rand -hex 24)"
  set_env EMAIL_INGEST_HMAC_SECRET "$(openssl rand -hex 32)"
  set_env AUTH_MODE "none"
  set_env OE_PORT "$PORT"
  set_env OE_BIND "$BIND"
  chmod 600 .env
fi

mkdir -p data backups
chown 1000:1000 backups 2>/dev/null || chmod 777 backups 2>/dev/null || true

say "Building and starting (first build takes a few minutes)"
docker compose up -d --build

say "Waiting for it to come up"
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
    printf '\n\033[32mopen-envelope is running:\033[0m http://localhost:%s\n' "$PORT"
    if [ "$BIND" = "127.0.0.1" ]; then
      echo "Bound to localhost only, with no login. To share it, put it behind an auth proxy"
      echo "(Cloudflare Access, Tailscale, ...). See README > Free Hosting Option."
    fi
    echo "Logs: docker compose logs -f   Stop: docker compose down"
    exit 0
  fi
  sleep 2
done
docker compose logs --tail 40
die "Did not become healthy within 2 minutes."
