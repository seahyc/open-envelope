#!/bin/sh
# Boot the hardened stack and import a synthetic CSV.
# Prefers docker compose; falls back to equivalent `docker run` flags.
set -eu
ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

IMAGE="${COMPOSE_IMAGE:-openenvelope:local}"
NAME="${SMOKE_CONTAINER:-openenvelope-smoke}"
PORT="${SMOKE_PORT:-3100}"

if docker info >/dev/null 2>&1; then
  DOCKER="docker"
elif sudo docker info >/dev/null 2>&1; then
  DOCKER="sudo docker"
else
  echo "docker daemon is not available" >&2
  exit 1
fi

mkdir -p backups
if [ "$(id -u)" = "0" ]; then
  chown 1000:1000 backups 2>/dev/null || true
fi

if ! $DOCKER image inspect "$IMAGE" >/dev/null 2>&1; then
  $DOCKER build -t "$IMAGE" .
fi

compose_up() {
  $DOCKER compose -f docker-compose.yml -f docker-compose.smoke.yml up -d --no-build
}

compose_down() {
  $DOCKER compose -f docker-compose.yml -f docker-compose.smoke.yml down --volumes >/dev/null 2>&1 || true
}

run_up() {
  $DOCKER rm -f "$NAME" >/dev/null 2>&1 || true
  $DOCKER volume create oe-smoke-data >/dev/null
  $DOCKER volume create oe-smoke-backups >/dev/null
  $DOCKER run -d --name "$NAME" \
    --read-only \
    --cap-drop=ALL \
    --security-opt no-new-privileges:true \
    --memory=768m \
    --cpus=1.0 \
    --pids-limit=256 \
    --tmpfs /tmp:mode=1777,size=128m \
    --tmpfs /home/node:uid=1000,gid=1000,mode=0755,size=64m \
    -v oe-smoke-data:/data \
    -v oe-smoke-backups:/backups \
    -e AUTH_MODE=none \
    -e CATEGORISER_PROVIDER=none \
    -e LLM_PROVIDER=none \
    -e PORT=3100 \
    -p "${PORT}:3100" \
    "$IMAGE"
}

run_down() {
  $DOCKER rm -f "$NAME" >/dev/null 2>&1 || true
  $DOCKER volume rm oe-smoke-data oe-smoke-backups >/dev/null 2>&1 || true
}

MODE=run
if $DOCKER compose version >/dev/null 2>&1; then
  MODE=compose
fi

if [ "$MODE" = "compose" ]; then
  compose_up
  cleanup() { compose_down; }
else
  run_up
  cleanup() { run_down; }
fi
trap cleanup EXIT

i=0
while [ "$i" -lt 60 ]; do
  if curl -fsS "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1; then
    break
  fi
  i=$((i + 1))
  sleep 1
done
curl -fsS "http://127.0.0.1:${PORT}/healthz" >/dev/null

curl -fsS -X POST "http://127.0.0.1:${PORT}/api/accounts" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Smoke Checking","aliases":["generic"],"group":"budget"}' >/dev/null

IMPORT_JSON="$(curl -fsS -X POST "http://127.0.0.1:${PORT}/api/import" \
  -F "file=@fixtures/synthetic-transactions.csv;type=text/csv;filename=synthetic-transactions.csv")"

echo "$IMPORT_JSON"
node -e '
  const j = JSON.parse(process.argv[1]);
  if (!j.observationsCreated || j.observationsCreated < 1) {
    console.error("expected observationsCreated >= 1", j);
    process.exit(1);
  }
' "$IMPORT_JSON"
echo "compose smoke ok (mode=$MODE)"
