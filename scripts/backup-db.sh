#!/usr/bin/env bash
# ==============================================================================
# Flipkart Stock Checker — SQLite Database Safe Backup Script
#
# Uses SQLite's online backup API (.backup) to capture a consistent snapshot
# without locking the live WAL database or corrupting active reader/writers.
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Load .env if present and DATABASE_PATH not explicitly set
if [ -z "${DATABASE_PATH:-}" ] && [ -f "${PROJECT_ROOT}/.env" ]; then
  # Extract DATABASE_PATH from .env without executing arbitrary code
  ENV_DB_PATH=$(grep -E '^[[:space:]]*DATABASE_PATH[[:space:]]*=' "${PROJECT_ROOT}/.env" | cut -d '=' -f2- | tr -d '"'"'"' | tr -d '[:space:]' || true)
  if [ -n "${ENV_DB_PATH}" ]; then
    DATABASE_PATH="${ENV_DB_PATH}"
  fi
fi

# Fallback to default path if unset
DB_PATH="${DATABASE_PATH:-${PROJECT_ROOT}/data/stock_checker.db}"

# Resolve relative path to absolute
if [[ "${DB_PATH}" != /* ]]; then
  DB_PATH="${PROJECT_ROOT}/${DB_PATH}"
fi

BACKUP_DIR="${BACKUP_DIR:-${PROJECT_ROOT}/data/backups}"
TIMESTAMP=$(date -u +"%Y%m%d_%H%M%SZ")
BACKUP_FILE="${BACKUP_DIR}/stock_checker_${TIMESTAMP}.db"
MIN_FREE_SPACE_MB=100

echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] [INFO] Starting database backup..."
echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] [INFO] Source Database: ${DB_PATH}"
echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] [INFO] Backup Destination: ${BACKUP_FILE}"

# 1. Verify source database exists
if [ ! -f "${DB_PATH}" ]; then
  echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] [ERROR] Database file does not exist: ${DB_PATH}" >&2
  exit 1
fi

# 2. Ensure backup directory exists with restrictive 0700 permissions
mkdir -p "${BACKUP_DIR}"
chmod 700 "${BACKUP_DIR}"

# 3. Check available disk space (at least 100MB required)
FREE_SPACE_MB=$(df -m "${BACKUP_DIR}" | awk 'NR==2 {print $4}')
if [ "${FREE_SPACE_MB}" -lt "${MIN_FREE_SPACE_MB}" ]; then
  echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] [ERROR] Insufficient disk space. Available: ${FREE_SPACE_MB}MB, Required: ${MIN_FREE_SPACE_MB}MB" >&2
  exit 1
fi

# 4. Check that sqlite3 CLI is available
if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] [ERROR] sqlite3 command not found. Please install sqlite3 package." >&2
  exit 1
fi

# 5. Perform safe online backup using SQLite's .backup command
sqlite3 "${DB_PATH}" ".backup '${BACKUP_FILE}'"

# 6. Apply strict file permissions (0600)
chmod 600 "${BACKUP_FILE}"

# 7. Verify integrity of newly created backup
INTEGRITY=$(sqlite3 "${BACKUP_FILE}" "PRAGMA integrity_check;")
if [ "${INTEGRITY}" != "ok" ]; then
  echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] [ERROR] Integrity check failed for ${BACKUP_FILE}: ${INTEGRITY}" >&2
  rm -f "${BACKUP_FILE}"
  exit 1
fi

BACKUP_SIZE=$(ls -lh "${BACKUP_FILE}" | awk '{print $5}')
echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] [INFO] Backup created and verified successfully (${BACKUP_SIZE})."

# 8. Prune backups older than 7 days
echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] [INFO] Pruning backups older than 7 days..."
find "${BACKUP_DIR}" -name "stock_checker_*.db" -type f -mtime +7 -exec rm -f {} +

echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] [INFO] Backup maintenance completed successfully."
