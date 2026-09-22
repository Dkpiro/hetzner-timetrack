#!/usr/bin/env bash
# Daily backup of the SQLite DB. Installed via backup.service + backup.timer.
set -euo pipefail

APP_DIR="/root/timetrack"
DB_PATH="$APP_DIR/instance/timetrack.db"
BACKUP_DIR="$APP_DIR/backups"
KEEP_DAYS=30

mkdir -p "$BACKUP_DIR"
sqlite3 "$DB_PATH" ".backup '$BACKUP_DIR/timetrack-$(date +%F).db'"
find "$BACKUP_DIR" -name 'timetrack-*.db' -mtime +$KEEP_DAYS -delete
