#!/bin/sh
set -eu

umask 077

if [ $# -lt 2 ]; then
    echo "Usage: $0 <encrypted-backup-file> <age-private-key-file>" >&2
    echo "Example: $0 backups/openenvelope-backup-20240115-120000.tar.zst.age age-key.txt" >&2
    exit 1
fi

ENCRYPTED_FILE="$1"
AGE_KEY_FILE="$2"
DATABASE_PATH="${DATABASE_PATH:-./data/openenvelope.db}"
DOCUMENTS_PATH="${OBJECT_STORAGE_LOCAL_PATH:-./data/documents}"

if [ ! -f "$ENCRYPTED_FILE" ]; then
    echo "Error: Encrypted backup file not found: $ENCRYPTED_FILE" >&2
    exit 1
fi

if [ ! -f "$AGE_KEY_FILE" ]; then
    echo "Error: Age private key file not found: $AGE_KEY_FILE" >&2
    exit 1
fi

abs_path() {
    dir=$(dirname -- "$1")
    base=$(basename -- "$1")
    (cd "$dir" && printf '%s/%s\n' "$(pwd)" "$base")
}

path_has_dotdot() {
    oldifs=$IFS
    set -f
    IFS=/
    # shellcheck disable=SC2086
    set -- $1
    IFS=$oldifs
    set +f
    for part in "$@"; do
        if [ "$part" = ".." ]; then
            return 0
        fi
    done
    return 1
}

scan_extracted_links() {
    root=$1
    found=$(find "$root" \( -type l -o \( -type f -links +1 \) \) -print)
    if [ -n "$found" ]; then
        echo "Error: refusing extracted files that are symlinks or hard links:" >&2
        echo "$found" >&2
        exit 1
    fi
}

TMPDIR_RESTORE=$(mktemp -d)
DID_SWAP_DB=0
DID_SWAP_DOCS=0
DB_ASIDE=""
WAL_ASIDE=""
SHM_ASIDE=""
DOCS_ASIDE=""
DB_INCOMING=""
DOCS_INCOMING=""

rollback_live() {
    echo "Error: restore failed after swap started; reverting live files" >&2
    if [ "$DID_SWAP_DOCS" = 1 ]; then
        rm -rf "$DOCUMENTS_PATH"
        if [ -n "$DOCS_ASIDE" ] && [ -e "$DOCS_ASIDE" ]; then
            mv "$DOCS_ASIDE" "$DOCUMENTS_PATH"
        fi
        DID_SWAP_DOCS=0
    fi
    if [ "$DID_SWAP_DB" = 1 ]; then
        rm -f "$DATABASE_PATH"
        if [ -n "$DB_ASIDE" ] && [ -e "$DB_ASIDE" ]; then
            mv "$DB_ASIDE" "$DATABASE_PATH"
        fi
        if [ -n "$WAL_ASIDE" ] && [ -e "$WAL_ASIDE" ]; then
            mv "$WAL_ASIDE" "${DATABASE_PATH}-wal"
        fi
        if [ -n "$SHM_ASIDE" ] && [ -e "$SHM_ASIDE" ]; then
            mv "$SHM_ASIDE" "${DATABASE_PATH}-shm"
        fi
        DID_SWAP_DB=0
    fi
}

CLEANED_UP=0
cleanup() {
    rc=${1:-$?}
    if [ "$CLEANED_UP" = 1 ]; then
        return 0
    fi
    CLEANED_UP=1
    if [ "$rc" -ne 0 ]; then
        if [ "$DID_SWAP_DB" = 1 ] || [ "$DID_SWAP_DOCS" = 1 ]; then
            rollback_live
        fi
    fi
    rm -rf "$TMPDIR_RESTORE"
    if [ -n "$DB_INCOMING" ] && [ -e "$DB_INCOMING" ]; then
        rm -f "$DB_INCOMING"
    fi
    if [ -n "$DOCS_INCOMING" ] && [ -e "$DOCS_INCOMING" ]; then
        rm -rf "$DOCS_INCOMING"
    fi
}
trap 'cleanup $?' EXIT
trap 'cleanup 130; exit 130' INT TERM

ZST_PATH="${TMPDIR_RESTORE}/archive.tar.zst"
EXTRACT_DIR="${TMPDIR_RESTORE}/extract"
STAGING_DIR="${TMPDIR_RESTORE}/staging"
mkdir -p "$EXTRACT_DIR" "$STAGING_DIR"

echo "Decrypting backup..."
age -d -i "$AGE_KEY_FILE" -o "$ZST_PATH" "$ENCRYPTED_FILE"

echo "Checking archive integrity..."
if ! zstd -t "$ZST_PATH" >/dev/null 2>&1; then
    echo "Error: zstd integrity check failed" >&2
    exit 1
fi

echo "Scanning archive members for unsafe paths..."
TAR_PATH="${TMPDIR_RESTORE}/archive.tar"
zstd -d -q "$ZST_PATH" -o "$TAR_PATH"
MEMBERS_FILE="${TMPDIR_RESTORE}/members.txt"
VERBOSE_FILE="${TMPDIR_RESTORE}/members-verbose.txt"
tar -tf "$TAR_PATH" > "$MEMBERS_FILE"
tar -tvf "$TAR_PATH" > "$VERBOSE_FILE"

while IFS= read -r line; do
    [ -z "$line" ] && continue
    case "$line" in
        l*)
            echo "Error: refusing archive member that is a symlink: $line" >&2
            exit 1
            ;;
        h*)
            echo "Error: refusing archive member that is a hard link: $line" >&2
            exit 1
            ;;
    esac
done < "$VERBOSE_FILE"

FOUND_DB=0
while IFS= read -r member; do
    [ -z "$member" ] && continue
    case "$member" in
        /*)
            echo "Error: refusing archive member with absolute path: $member" >&2
            exit 1
            ;;
    esac
    if path_has_dotdot "$member"; then
        echo "Error: refusing archive member containing '..': $member" >&2
        exit 1
    fi
    case "$member" in
        openenvelope.db|./openenvelope.db)
            FOUND_DB=1
            ;;
    esac
done < "$MEMBERS_FILE"

if [ "$FOUND_DB" -ne 1 ]; then
    echo "Error: archive does not contain a database snapshot (openenvelope.db)" >&2
    exit 1
fi

echo "Extracting to staging..."
tar -C "$EXTRACT_DIR" --no-overwrite-dir -xf "$TAR_PATH"

DB_SRC=""
if [ -f "${EXTRACT_DIR}/openenvelope.db" ] && [ ! -L "${EXTRACT_DIR}/openenvelope.db" ]; then
    DB_SRC="${EXTRACT_DIR}/openenvelope.db"
fi

if [ -z "$DB_SRC" ] || [ ! -f "$DB_SRC" ]; then
    echo "Error: archive does not contain a database snapshot (openenvelope.db)" >&2
    exit 1
fi

EXTRACTED_LIST="${TMPDIR_RESTORE}/extracted.txt"
find "$EXTRACT_DIR" -print > "$EXTRACTED_LIST"
while IFS= read -r extracted; do
    rel=${extracted#"$EXTRACT_DIR"/}
    [ "$rel" = "$EXTRACT_DIR" ] && continue
    case "$rel" in
        /*)
            echo "Error: extracted absolute path: $rel" >&2
            exit 1
            ;;
    esac
    if path_has_dotdot "$rel"; then
        echo "Error: extracted path contains '..': $rel" >&2
        exit 1
    fi
done < "$EXTRACTED_LIST"

scan_extracted_links "$EXTRACT_DIR"

echo "Checking snapshot integrity..."
integrity=$(sqlite3 "$DB_SRC" "PRAGMA integrity_check;" 2>"${TMPDIR_RESTORE}/integrity.err" || true)
if [ ! -s "${TMPDIR_RESTORE}/integrity.err" ] && [ "$integrity" = "ok" ]; then
    :
else
    echo "Error: snapshot failed PRAGMA integrity_check" >&2
    if [ -n "$integrity" ]; then
        echo "$integrity" >&2
    fi
    if [ -s "${TMPDIR_RESTORE}/integrity.err" ]; then
        cat "${TMPDIR_RESTORE}/integrity.err" >&2
    fi
    exit 1
fi

STAGING_DB="${STAGING_DIR}/openenvelope.db"
cp "$DB_SRC" "$STAGING_DB"

HAS_DOCS=0
if [ -d "${EXTRACT_DIR}/documents" ]; then
    HAS_DOCS=1
    cp -a "${EXTRACT_DIR}/documents" "${STAGING_DIR}/documents"
    scan_extracted_links "${STAGING_DIR}/documents"
fi

DEST_DIR=$(dirname -- "$DATABASE_PATH")
mkdir -p "$DEST_DIR"
if [ "$HAS_DOCS" = 1 ]; then
    mkdir -p "$(dirname -- "$DOCUMENTS_PATH")"
fi

if [ -e "$DATABASE_PATH" ]; then
    echo "Checking that the database is not in use..."
    abs_db=$(abs_path "$DATABASE_PATH")
    our_pid=$$
    holder=""
    for piddir in /proc/[0-9]*; do
        p=${piddir#/proc/}
        [ "$p" = "$our_pid" ] && continue
        [ -d "$piddir/fd" ] || continue
        for fd in "$piddir"/fd/*; do
            target=$(readlink "$fd" 2>/dev/null) || continue
            case "$target" in
                "$abs_db"|"${abs_db}-wal"|"${abs_db}-shm")
                    holder=$p
                    break
                    ;;
            esac
        done
        [ -n "$holder" ] && break
    done
    if [ -n "$holder" ]; then
        echo "Error: database is in use by process ${holder}. Stop the OpenEnvelope container before restoring." >&2
        echo "Example: docker compose stop openenvelope" >&2
        exit 1
    fi

    # /proc only sees this container. An idle WAL reader (the running app)
    # holds no lock that BEGIN EXCLUSIVE; ROLLBACK conflicts with.
    # locking_mode=EXCLUSIVE does conflict, including across containers
    # sharing the same volume.
    if ! sqlite3 "$DATABASE_PATH" "PRAGMA busy_timeout=100; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; SELECT count(*) FROM sqlite_master; COMMIT;" >/dev/null 2>"${TMPDIR_RESTORE}/lock.err"; then
        echo "Error: database is locked (another process or container has it open). Stop the OpenEnvelope container before restoring." >&2
        echo "Example: docker compose stop openenvelope" >&2
        if [ -s "${TMPDIR_RESTORE}/lock.err" ]; then
            cat "${TMPDIR_RESTORE}/lock.err" >&2
        fi
        exit 1
    fi
fi

echo "Staging restore next to live paths..."
DB_INCOMING="${DATABASE_PATH}.incoming.$$"
cp "$STAGING_DB" "$DB_INCOMING"
chmod 600 "$DB_INCOMING" 2>/dev/null || true

if [ "$HAS_DOCS" = 1 ]; then
    DOCS_INCOMING="${DOCUMENTS_PATH}.incoming.$$"
    cp -a "${STAGING_DIR}/documents" "$DOCS_INCOMING"
    scan_extracted_links "$DOCS_INCOMING"
fi

if [ "${OPENENVELOPE_TEST_MODE:-}" = 1 ] && [ "${RESTORE_FAIL_BEFORE_SWAP:-}" = 1 ]; then
    echo "Error: RESTORE_FAIL_BEFORE_SWAP is set" >&2
    exit 1
fi

SWAP_STAMP=$(date +%Y%m%d-%H%M%S)

echo "Swapping database into $DATABASE_PATH..."
if [ -f "$DATABASE_PATH" ]; then
    DB_ASIDE="${DATABASE_PATH}.pre-restore.${SWAP_STAMP}"
    mv "$DATABASE_PATH" "$DB_ASIDE"
fi
if [ -e "${DATABASE_PATH}-wal" ]; then
    WAL_ASIDE="${DATABASE_PATH}-wal.pre-restore.${SWAP_STAMP}"
    mv "${DATABASE_PATH}-wal" "$WAL_ASIDE"
fi
if [ -e "${DATABASE_PATH}-shm" ]; then
    SHM_ASIDE="${DATABASE_PATH}-shm.pre-restore.${SWAP_STAMP}"
    mv "${DATABASE_PATH}-shm" "$SHM_ASIDE"
fi
mv "$DB_INCOMING" "$DATABASE_PATH"
DID_SWAP_DB=1
chmod 600 "$DATABASE_PATH" 2>/dev/null || true

if [ "${OPENENVELOPE_TEST_MODE:-}" = 1 ] && [ "${RESTORE_FAIL_AFTER_DB_SWAP:-}" = 1 ]; then
    echo "Error: RESTORE_FAIL_AFTER_DB_SWAP is set" >&2
    exit 1
fi

if [ "$HAS_DOCS" = 1 ]; then
    echo "Swapping documents into $DOCUMENTS_PATH..."
    if [ -e "$DOCUMENTS_PATH" ]; then
        DOCS_ASIDE="${DOCUMENTS_PATH}.pre-restore.${SWAP_STAMP}"
        mv "$DOCUMENTS_PATH" "$DOCS_ASIDE"
    fi
    mv "$DOCS_INCOMING" "$DOCUMENTS_PATH"
    DID_SWAP_DOCS=1
fi

echo "Restore completed successfully"
