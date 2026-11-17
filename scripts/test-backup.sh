#!/bin/bash
set -euo pipefail

echo "Testing backup script with MinIO..."

sudo docker compose -f docker-compose.test.yml up -d minio

echo "Waiting for MinIO..."
sleep 5

echo "Creating S3 bucket..."
sudo docker run --rm --network host \
    -e AWS_ACCESS_KEY_ID=minioadmin \
    -e AWS_SECRET_ACCESS_KEY=minioadmin \
    amazon/aws-cli \
    --endpoint-url http://localhost:9000 \
    s3 mb s3://openenvelope-backups || echo "Bucket might already exist"

echo "Starting OpenEnvelope container..."
sudo docker compose -f docker-compose.test.yml up -d openenvelope

echo "Waiting for app to be healthy..."
sleep 10

echo "Creating test data..."
sudo docker compose -f docker-compose.test.yml exec -T openenvelope sqlite3 /data/openenvelope.db << 'EOF'
CREATE TABLE IF NOT EXISTS test_backup (id INTEGER PRIMARY KEY, data TEXT);
INSERT INTO test_backup (data) VALUES ('test-backup-data');
EOF

echo "Running backup..."
sudo docker compose -f docker-compose.test.yml exec -T openenvelope /app/scripts/backup.sh

echo "Checking if backup was uploaded to S3..."
sudo docker run --rm --network host \
    -e AWS_ACCESS_KEY_ID=minioadmin \
    -e AWS_SECRET_ACCESS_KEY=minioadmin \
    amazon/aws-cli \
    --endpoint-url http://localhost:9000 \
    s3 ls s3://openenvelope-backups/

echo "✓ Backup test complete"

sudo docker compose -f docker-compose.test.yml down
