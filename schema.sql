PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS topics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    category_id INTEGER NOT NULL REFERENCES categories(id),
    archived INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS time_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    topic_id INTEGER NOT NULL REFERENCES topics(id),
    start_ts TEXT NOT NULL,
    end_ts TEXT,
    note TEXT
);

-- One row per local calendar day; the date string comes from the client so
-- the server never needs to know the user's timezone.
CREATE TABLE IF NOT EXISTS days (
    date TEXT PRIMARY KEY,
    started_at TEXT NOT NULL,
    finished_at TEXT
);

CREATE TABLE IF NOT EXISTS plan_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_date TEXT NOT NULL,
    topic_id INTEGER NOT NULL REFERENCES topics(id),
    title TEXT NOT NULL,
    notes TEXT,
    expected_minutes INTEGER,
    ticket TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    done INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_plan_items_date ON plan_items(plan_date, sort_order);
CREATE INDEX IF NOT EXISTS idx_time_entries_topic ON time_entries(topic_id);
CREATE INDEX IF NOT EXISTS idx_time_entries_start ON time_entries(start_ts);
-- At most one open entry is enforced in application code (SQLite can't easily
-- express "at most one row where end_ts IS NULL" as a constraint).
