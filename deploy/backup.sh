#!/usr/bin/env bash
# Daily backup of the SQLite DB. Installed via backup.service + backup.timer.
set -euo pipefail

APP_DIR="/root/timetrack"
DB_PATH="$APP_DIR/instance/timetrack.db"
BACKUP_DIR="$APP_DIR/backups"
KEEP_DAYS=30

mkdir -p "$BACKUP_DIR"
"$APP_DIR/.venv/bin/python3" -c "
import sqlite3
src = sqlite3.connect('$DB_PATH')
dst = sqlite3.connect('$BACKUP_DIR/timetrack-$(date +%F).db')
with dst:
    src.backup(dst)
src.close()
dst.close()
"
find "$BACKUP_DIR" -name 'timetrack-*.db' -mtime +$KEEP_DAYS -delete
