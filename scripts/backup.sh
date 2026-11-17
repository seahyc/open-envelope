#!/bin/sh
set -eu

umask 077

DATABASE_PATH="${DATABASE_PATH:-./data/openenvelope.db}"
DOCUMENTS_PATH="${OBJECT_STORAGE_LOCAL_PATH:-./data/documents}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
S3_ENDPOINT="${BACKUP_S3_ENDPOINT:-}"
S3_BUCKET="${BACKUP_S3_BUCKET:-}"
S3_REGION="${BACKUP_S3_REGION:-auto}"
AGE_PUBLIC_KEY="${BACKUP_AGE_PUBLIC_KEY:-}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-7}"
MAX_BYTES="${BACKUP_MAX_BYTES:-536870912}"

if [ "$RETENTION_DAYS" -lt 1 ]; then
    RETENTION_DAYS=1
fi

if [ -z "$AGE_PUBLIC_KEY" ]; then
    echo "Error: BACKUP_AGE_PUBLIC_KEY is not set. Refusing to write an unencrypted backup." >&2
    echo "Generate a key with: age-keygen -o age-key.txt" >&2
    exit 1
fi

if [ ! -f "$DATABASE_PATH" ]; then
    echo "Error: database not found: $DATABASE_PATH" >&2
    exit 1
fi

TMPDIR_BACKUP=$(mktemp -d)
cleanup() {
    rm -rf "$TMPDIR_BACKUP"
}
trap cleanup EXIT INT TERM

TIMESTAMP=$(date +%Y%m%d-%H%M%S)
ARCHIVE_NAME="openenvelope-backup-${TIMESTAMP}.tar.zst.age"
SNAPSHOT_DB="${TMPDIR_BACKUP}/openenvelope.db"
TAR_PATH="${TMPDIR_BACKUP}/openenvelope-backup.tar"
ZST_PATH="${TAR_PATH}.zst"
ENCRYPTED_PATH="${TMPDIR_BACKUP}/${ARCHIVE_NAME}"

echo "Creating consistent SQLite snapshot of $DATABASE_PATH..."
sqlite3 "$DATABASE_PATH" ".backup '${SNAPSHOT_DB}'"

if [ ! -f "$SNAPSHOT_DB" ]; then
    echo "Error: sqlite .backup did not produce a snapshot" >&2
    exit 1
fi

refuse_links() {
    root=$1
    label=$2
    if [ -L "$root" ]; then
        echo "Error: refusing to archive ${label} because it is a symlink: $root" >&2
        exit 1
    fi
    found=$(find "$root" \( -type l -o \( -type f -links +1 \) \) -print)
    if [ -n "$found" ]; then
        echo "Error: refusing to archive ${label} containing symlinks or hard links:" >&2
        echo "$found" >&2
        exit 1
    fi
}

echo "Archiving snapshot and documents..."
# Build a relative-path archive from the temp dir so restore can reject unsafe members.
mkdir -p "${TMPDIR_BACKUP}/archive"
mv "$SNAPSHOT_DB" "${TMPDIR_BACKUP}/archive/openenvelope.db"

if [ -d "$DOCUMENTS_PATH" ]; then
    echo "Including documents from $DOCUMENTS_PATH"
    refuse_links "$DOCUMENTS_PATH" "documents"
    cp -a "$DOCUMENTS_PATH" "${TMPDIR_BACKUP}/archive/documents"
    refuse_links "${TMPDIR_BACKUP}/archive/documents" "copied documents"
fi

tar -C "${TMPDIR_BACKUP}/archive" -cf "$TAR_PATH" .
zstd -q -f "$TAR_PATH" -o "$ZST_PATH"
rm -f "$TAR_PATH"

echo "Encrypting backup..."
age -r "$AGE_PUBLIC_KEY" -o "$ENCRYPTED_PATH" "$ZST_PATH"
rm -f "$ZST_PATH"

SIZE=$(wc -c < "$ENCRYPTED_PATH")
if [ "$SIZE" -gt "$MAX_BYTES" ]; then
    echo "Error: backup size ${SIZE} bytes exceeds BACKUP_MAX_BYTES=${MAX_BYTES}" >&2
    exit 1
fi

mkdir -p "$BACKUP_DIR"
LOCAL_PATH="${BACKUP_DIR}/${ARCHIVE_NAME}"
cp "$ENCRYPTED_PATH" "$LOCAL_PATH"
chmod 600 "$LOCAL_PATH"

echo "Pruning local backups older than ${RETENTION_DAYS} days..."
find "$BACKUP_DIR" -type f -name 'openenvelope-backup-*.tar.zst.age' -mtime "+$((RETENTION_DAYS - 1))" -delete 2>/dev/null || true

if [ -n "$S3_ENDPOINT" ] && [ -n "$S3_BUCKET" ]; then
    if ! command -v aws >/dev/null 2>&1; then
        echo "Error: S3 backup is configured but aws CLI is not installed" >&2
        exit 1
    fi

    if [ -z "${BACKUP_S3_ACCESS_KEY_ID:-${AWS_ACCESS_KEY_ID:-}}" ] || [ -z "${BACKUP_S3_SECRET_ACCESS_KEY:-${AWS_SECRET_ACCESS_KEY:-}}" ]; then
        echo "Error: S3 backup is configured but access key env vars are not set" >&2
        exit 1
    fi

    AWS_ACCESS_KEY_ID="${BACKUP_S3_ACCESS_KEY_ID:-$AWS_ACCESS_KEY_ID}"
    AWS_SECRET_ACCESS_KEY="${BACKUP_S3_SECRET_ACCESS_KEY:-$AWS_SECRET_ACCESS_KEY}"
    AWS_DEFAULT_REGION="$S3_REGION"
    export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_DEFAULT_REGION

    echo "Uploading to S3-compatible storage..."
    aws s3 cp "$LOCAL_PATH" "s3://${S3_BUCKET}/backups/${ARCHIVE_NAME}" --endpoint-url "$S3_ENDPOINT"
    echo "Backup uploaded (local copy retained for ${RETENTION_DAYS} days)"
else
    echo "S3 not configured, keeping local backup only"
fi

echo "Backup completed: ${LOCAL_PATH} (${SIZE} bytes)"
