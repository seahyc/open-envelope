#!/bin/sh
set -e

echo "OpenEnvelope Deployment Script"
echo "================================"
echo ""

if [ ! -f ".env" ]; then
    echo "Creating .env from .env.example..."
    cp .env.example .env
    echo "⚠️  Please edit .env with your configuration before continuing."
    echo "   At minimum, set INGEST_API_KEY and BACKUP_AGE_PUBLIC_KEY"
    exit 1
fi

echo "Checking prerequisites..."
command -v docker >/dev/null 2>&1 || { echo "❌ Docker is required but not installed."; exit 1; }
command -v docker-compose >/dev/null 2>&1 || command -v docker >/dev/null 2>&1 || { echo "❌ Docker Compose is required"; exit 1; }
echo "✅ Docker found"

if [ ! -d "node_modules" ]; then
    echo "Installing dependencies..."
    npm install
fi

echo "Running tests..."
npm run test:ci || { echo "❌ Tests failed"; exit 1; }
echo "✅ Tests passed"

echo "Type checking..."
npm run typecheck || { echo "❌ Type check failed"; exit 1; }
echo "✅ Type check passed"

echo "Building Docker image..."
docker-compose build

echo "Creating data and backup directories..."
mkdir -p data backups
# The image runs as uid 1000 (node). A bind-mounted ./backups must be owned by
# that uid, or switch docker-compose to a named volume for /backups.
if chown 1000:1000 backups 2>/dev/null; then
    echo "✅ ./backups owned by uid 1000"
else
    echo "⚠️  Could not chown ./backups to uid 1000."
    echo "   Run: sudo chown 1000:1000 backups"
    echo "   Or use a named volume for /backups instead of ./backups."
fi

echo "Starting services..."
docker-compose up -d

echo "Waiting for service to be healthy..."
for i in 1 2 3 4 5; do
    sleep 2
    if docker-compose exec -T openenvelope wget -q -O /dev/null http://localhost:3100/healthz 2>/dev/null; then
        echo "✅ Service is healthy"
        break
    fi
    if [ $i -eq 5 ]; then
        echo "❌ Service failed to become healthy"
        docker-compose logs --tail=50
        exit 1
    fi
    echo "   Still waiting... ($i/5)"
done

echo ""
echo "================================"
echo "✅ OpenEnvelope deployed successfully!"
echo ""
echo "Service URL: http://localhost:3100"
echo "Health check: http://localhost:3100/healthz"
echo ""
echo "View logs: docker-compose logs -f"
echo "Stop service: docker-compose down"
echo ""
echo "Next steps:"
echo "1. Set up reverse proxy with SSL (Nginx, Caddy, etc.)"
echo "2. Configure authentication (Cloudflare Access, etc.)"
echo "3. Set up backup cron job: crontab -e"
echo "   0 2 * * * /path/to/openenvelope/scripts/backup.sh"
echo ""
