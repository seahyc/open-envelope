#!/bin/bash
set -euo pipefail

COMPOSE_FILE=${COMPOSE_FILE:-docker-compose.yml}
SERVICE_NAME=${SERVICE_NAME:-openenvelope}

docker compose -f "$COMPOSE_FILE" exec -T "$SERVICE_NAME" /app/scripts/backup.sh
