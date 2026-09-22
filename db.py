import sqlite3
from pathlib import Path
from datetime import datetime, timezone

import click
from flask import current_app, g

SCHEMA_PATH = Path(__file__).parent / "schema.sql"

SEED_CATEGORIES = ["Backend", "ERP", "BI", "Data Quality", "Breaks"]
SEED_TOPICS = {"Breaks": ["Lunch"]}


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(
            current_app.config["DATABASE"],
            detect_types=sqlite3.PARSE_DECLTYPES,
        )
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA foreign_keys = ON")
    return g.db


def close_db(e=None):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db():
    db = get_db()
    with open(SCHEMA_PATH, "r") as f:
        db.executescript(f.read())
    seed_if_empty(db)
    db.commit()


def seed_if_empty(db):
    row = db.execute("SELECT COUNT(*) AS n FROM categories").fetchone()
    if row["n"] > 0:
        return
    for i, name in enumerate(SEED_CATEGORIES):
        db.execute(
            "INSERT INTO categories (name, sort_order) VALUES (?, ?)", (name, i)
        )
    cats = {
        r["name"]: r["id"] for r in db.execute("SELECT id, name FROM categories")
    }
    for cat_name, topics in SEED_TOPICS.items():
        for topic_name in topics:
            db.execute(
                "INSERT INTO topics (name, category_id) VALUES (?, ?)",
                (topic_name, cats[cat_name]),
            )


def init_app(app):
    app.teardown_appcontext(close_db)
    app.cli.add_command(init_db_command)


@click.command("init-db")
def init_db_command():
    """Create tables and seed default categories/topics if the DB is empty."""
    init_db()
    click.echo("Database initialized.")
