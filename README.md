# Time Tracker

A small personal web app for tracking work time: start/stop a clock against a
topic (topics grouped into categories like Backend / ERP / BI / Data
Quality), with a Today view and a Week overview.

The running timer is server-side state (an open row in `time_entries`), so a
page refresh, browser close, or network blip never loses it — reloading just
re-reads `/api/status` and resumes counting from `start_ts`.

## Local development

```bash
python -m venv .venv
source .venv/bin/activate   # or .venv\Scripts\activate on Windows
pip install -r requirements.txt
export TIMETRACK_PASSWORD=devpassword   # optional, defaults to "changeme"
python app.py
```

Open http://127.0.0.1:5000 — the DB (`instance/timetrack.db`) and its
tables/seed data are created automatically on first run.

## Configuration (env vars)

- `TIMETRACK_PASSWORD_HASH` — a `werkzeug.security.generate_password_hash`
  value; takes priority over `TIMETRACK_PASSWORD` if set. Generate one with:
  ```bash
  python -c "from werkzeug.security import generate_password_hash as g; print(g('your-password'))"
  ```
- `TIMETRACK_PASSWORD` — plaintext fallback, hashed at startup. Simpler for
  local dev; prefer `TIMETRACK_PASSWORD_HASH` in production so the plaintext
  password never sits in the environment/service file.
- `TIMETRACK_SECRET_KEY` — Flask session signing key. Set a fixed random
  value in production (otherwise sessions invalidate on every restart).
- `TIMETRACK_DB` — path to the SQLite file. Defaults to `instance/timetrack.db`.

## Deploying to the Hetzner VM

Already deployed at `https://<vm-ip>:8443` (self-signed cert — the browser
warns once, click through). To redeploy from scratch, or set this up on a
different host:

The VM runs nginx for other domain-based sites via `/etc/nginx/conf.d/*.conf`
(no `sites-available`/`sites-enabled` split here). Gunicorn listens
internally on `127.0.0.1:8420`; nginx terminates TLS on `8443` externally,
since there's no domain to hang this app off of. Both ports were confirmed
free with `ss -tlnp` before use — check again if reusing this on another VM.

1. `git clone https://github.com/Dkpiro/hetzner-timetrack.git /root/timetrack`
2. `python3 -m venv .venv && .venv/bin/pip install -r requirements.txt`
   (needs the `python3-venv` apt package if `venv` creation fails)
3. Create `/root/timetrack/.env` (mode `600`) with:
   ```
   TIMETRACK_PASSWORD=<your password>
   TIMETRACK_SECRET_KEY=<random hex, e.g. `openssl rand -hex 32`>
   ```
   (or set `TIMETRACK_PASSWORD_HASH` instead, see Configuration above, if
   you'd rather not keep the plaintext password on disk)
4. Generate a self-signed cert:
   ```bash
   sudo mkdir -p /etc/ssl/timetrack
   sudo openssl req -x509 -nodes -newkey rsa:2048 -days 3650 \
     -keyout /etc/ssl/timetrack/timetrack.key \
     -out /etc/ssl/timetrack/timetrack.crt \
     -subj "/CN=timetrack"
   ```
5. Install the systemd unit (`--preload` matters — see note below):
   ```bash
   sudo cp deploy/timetrack.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now timetrack
   ```
6. Install the nginx site:
   ```bash
   sudo cp deploy/nginx_timetrack.conf /etc/nginx/conf.d/timetrack.conf
   sudo nginx -t && sudo systemctl reload nginx
   ```
7. Install the daily backup timer:
   ```bash
   sudo cp deploy/timetrack-backup.service deploy/timetrack-backup.timer /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now timetrack-backup.timer
   ```
8. Open `https://<vm-ip>:8443`, click through the self-signed cert warning,
   log in.

Because there's no domain and no Let's Encrypt cert, the browser warning is
expected — the connection is still encrypted, which is the point (so the
password isn't sent in the clear to the public internet).

**Why `--preload`:** gunicorn's default worker model imports `app.py` (and
runs `create_app()` → `init_db()`) separately in *each* worker process. On
first boot against an empty DB, two workers can race to seed the default
categories and crash on a UNIQUE constraint. `--preload` loads the app once
in the master before forking, so setup runs exactly once. Seeding is also
written to be idempotent (`INSERT OR IGNORE`) as a second line of defense.

## Data safety

- SQLite runs in WAL mode.
- `deploy/backup.sh` (installed as a daily systemd timer) copies the DB into
  `backups/`, keeping the last 30 days — restore by copying a dated file
  back over `instance/timetrack.db` while the service is stopped.
- Topics/entries with history are never hard-deleted from the UI unless
  empty; the API refuses to delete a topic with existing time entries or a
  category with existing topics (archive instead).
