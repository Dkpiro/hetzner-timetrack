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

CREATE INDEX IF NOT EXISTS idx_time_entries_topic ON time_entries(topic_id);
CREATE INDEX IF NOT EXISTS idx_time_entries_start ON time_entries(start_ts);
-- At most one open entry is enforced in application code (SQLite can't easily
-- express "at most one row where end_ts IS NULL" as a constraint).
