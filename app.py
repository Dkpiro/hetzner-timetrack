import os
import secrets
import sqlite3
from pathlib import Path

from flask import Flask, jsonify, redirect, render_template, request, session, url_for
from werkzeug.security import generate_password_hash

import db as db_module
from auth import check_password, login_required

BASE_DIR = Path(__file__).parent


def create_app():
    app = Flask(__name__)

    instance_dir = BASE_DIR / "instance"
    instance_dir.mkdir(exist_ok=True)

    password_hash = os.environ.get("TIMETRACK_PASSWORD_HASH")
    if not password_hash:
        password_hash = generate_password_hash(
            os.environ.get("TIMETRACK_PASSWORD", "changeme")
        )
        if not os.environ.get("TIMETRACK_PASSWORD"):
            app.logger.warning(
                "TIMETRACK_PASSWORD / TIMETRACK_PASSWORD_HASH not set — "
                "using default dev password 'changeme'."
            )

    app.config.update(
        SECRET_KEY=os.environ.get("TIMETRACK_SECRET_KEY", secrets.token_hex(32)),
        DATABASE=os.environ.get("TIMETRACK_DB", str(instance_dir / "timetrack.db")),
        PASSWORD_HASH=password_hash,
    )

    db_module.init_app(app)

    with app.app_context():
        db_module.init_db()

    register_routes(app)
    return app


def register_routes(app):
    @app.route("/login", methods=["GET", "POST"])
    def login():
        error = None
        if request.method == "POST":
            if check_password(request.form.get("password", "")):
                session.clear()
                session["logged_in"] = True
                session.permanent = True
                next_url = request.args.get("next") or url_for("today")
                return redirect(next_url)
            error = "Wrong password."
        return render_template("login.html", error=error)

    @app.route("/logout", methods=["POST"])
    def logout():
        session.clear()
        return redirect(url_for("login"))

    @app.route("/")
    @login_required
    def today():
        return render_template("today.html")

    @app.route("/week")
    @login_required
    def week():
        return render_template("week.html")

    @app.route("/widget")
    @login_required
    def widget():
        return render_template("widget.html")

    @app.route("/topics")
    @login_required
    def topics_page():
        return render_template("topics.html")

    # ---- API: status / timer control ----

    @app.route("/api/status")
    @login_required
    def api_status():
        db = db_module.get_db()
        entry = db.execute(
            """SELECT te.id, te.topic_id, te.start_ts, t.name AS topic_name,
                      c.name AS category_name
               FROM time_entries te
               JOIN topics t ON t.id = te.topic_id
               JOIN categories c ON c.id = t.category_id
               WHERE te.end_ts IS NULL
               ORDER BY te.start_ts DESC LIMIT 1"""
        ).fetchone()
        return jsonify({"active": dict(entry) if entry else None})

    @app.route("/api/start", methods=["POST"])
    @login_required
    def api_start():
        data = request.get_json(force=True)
        topic_id = data.get("topic_id")
        if not topic_id:
            return jsonify({"error": "topic_id required"}), 400
        db = db_module.get_db()
        topic = db.execute(
            "SELECT id FROM topics WHERE id = ? AND archived = 0", (topic_id,)
        ).fetchone()
        if not topic:
            return jsonify({"error": "unknown or archived topic"}), 404
        _stop_active(db)
        now = db_module.now_iso()
        cur = db.execute(
            "INSERT INTO time_entries (topic_id, start_ts) VALUES (?, ?)",
            (topic_id, now),
        )
        db.commit()
        return jsonify({"id": cur.lastrowid, "start_ts": now})

    @app.route("/api/stop", methods=["POST"])
    @login_required
    def api_stop():
        db = db_module.get_db()
        stopped = _stop_active(db)
        db.commit()
        return jsonify({"stopped": stopped})

    def _stop_active(db):
        active = db.execute(
            "SELECT id FROM time_entries WHERE end_ts IS NULL"
        ).fetchone()
        if not active:
            return False
        db.execute(
            "UPDATE time_entries SET end_ts = ? WHERE id = ?",
            (db_module.now_iso(), active["id"]),
        )
        return True

    # ---- API: categories ----

    @app.route("/api/categories", methods=["GET", "POST"])
    @login_required
    def api_categories():
        db = db_module.get_db()
        if request.method == "POST":
            name = (request.get_json(force=True).get("name") or "").strip()
            if not name:
                return jsonify({"error": "name required"}), 400
            max_order = db.execute(
                "SELECT COALESCE(MAX(sort_order), -1) AS m FROM categories"
            ).fetchone()["m"]
            try:
                cur = db.execute(
                    "INSERT INTO categories (name, sort_order) VALUES (?, ?)",
                    (name, max_order + 1),
                )
            except sqlite3.IntegrityError:
                return jsonify({"error": "category already exists"}), 409
            db.commit()
            return jsonify({"id": cur.lastrowid, "name": name})
        rows = db.execute(
            "SELECT id, name, sort_order FROM categories ORDER BY sort_order"
        ).fetchall()
        return jsonify([dict(r) for r in rows])

    @app.route("/api/categories/<int:cat_id>", methods=["PATCH", "DELETE"])
    @login_required
    def api_category_detail(cat_id):
        db = db_module.get_db()
        if request.method == "DELETE":
            in_use = db.execute(
                "SELECT COUNT(*) AS n FROM topics WHERE category_id = ?", (cat_id,)
            ).fetchone()["n"]
            if in_use:
                return jsonify({"error": "category has topics, archive them first"}), 409
            db.execute("DELETE FROM categories WHERE id = ?", (cat_id,))
            db.commit()
            return jsonify({"deleted": True})
        data = request.get_json(force=True)
        name = (data.get("name") or "").strip()
        if not name:
            return jsonify({"error": "name required"}), 400
        db.execute("UPDATE categories SET name = ? WHERE id = ?", (name, cat_id))
        db.commit()
        return jsonify({"id": cat_id, "name": name})

    # ---- API: topics ----

    @app.route("/api/topics", methods=["GET", "POST"])
    @login_required
    def api_topics():
        db = db_module.get_db()
        if request.method == "POST":
            data = request.get_json(force=True)
            name = (data.get("name") or "").strip()
            category_id = data.get("category_id")
            if not name or not category_id:
                return jsonify({"error": "name and category_id required"}), 400
            cur = db.execute(
                "INSERT INTO topics (name, category_id) VALUES (?, ?)",
                (name, category_id),
            )
            db.commit()
            return jsonify({"id": cur.lastrowid, "name": name, "category_id": category_id})
        include_archived = request.args.get("include_archived") == "1"
        query = (
            "SELECT t.id, t.name, t.category_id, t.archived, c.name AS category_name "
            "FROM topics t JOIN categories c ON c.id = t.category_id"
        )
        if not include_archived:
            query += " WHERE t.archived = 0"
        query += " ORDER BY c.sort_order, t.name"
        rows = db.execute(query).fetchall()
        return jsonify([dict(r) for r in rows])

    @app.route("/api/topics/<int:topic_id>", methods=["PATCH", "DELETE"])
    @login_required
    def api_topic_detail(topic_id):
        db = db_module.get_db()
        if request.method == "DELETE":
            in_use = db.execute(
                "SELECT COUNT(*) AS n FROM time_entries WHERE topic_id = ?", (topic_id,)
            ).fetchone()["n"]
            if in_use:
                return jsonify({"error": "topic has time entries, archive it instead"}), 409
            db.execute("DELETE FROM topics WHERE id = ?", (topic_id,))
            db.commit()
            return jsonify({"deleted": True})
        data = request.get_json(force=True)
        fields, values = [], []
        if "name" in data:
            fields.append("name = ?")
            values.append(data["name"].strip())
        if "category_id" in data:
            fields.append("category_id = ?")
            values.append(data["category_id"])
        if "archived" in data:
            fields.append("archived = ?")
            values.append(1 if data["archived"] else 0)
        if not fields:
            return jsonify({"error": "nothing to update"}), 400
        values.append(topic_id)
        db.execute(f"UPDATE topics SET {', '.join(fields)} WHERE id = ?", values)
        db.commit()
        return jsonify({"id": topic_id, "updated": True})

    # ---- API: entries ----

    @app.route("/api/entries")
    @login_required
    def api_entries():
        start = request.args.get("start")
        end = request.args.get("end")
        db = db_module.get_db()
        query = (
            "SELECT te.id, te.topic_id, te.start_ts, te.end_ts, te.note, "
            "t.name AS topic_name, c.id AS category_id, c.name AS category_name "
            "FROM time_entries te "
            "JOIN topics t ON t.id = te.topic_id "
            "JOIN categories c ON c.id = t.category_id "
            "WHERE 1=1"
        )
        params = []
        if start:
            query += " AND te.start_ts >= ?"
            params.append(start)
        if end:
            query += " AND te.start_ts < ?"
            params.append(end)
        query += " ORDER BY te.start_ts DESC"
        rows = db.execute(query, params).fetchall()
        return jsonify([dict(r) for r in rows])

    @app.route("/api/entries/<int:entry_id>", methods=["PATCH", "DELETE"])
    @login_required
    def api_entry_detail(entry_id):
        db = db_module.get_db()
        if request.method == "DELETE":
            db.execute("DELETE FROM time_entries WHERE id = ?", (entry_id,))
            db.commit()
            return jsonify({"deleted": True})
        data = request.get_json(force=True)
        fields, values = [], []
        for key in ("topic_id", "start_ts", "end_ts", "note"):
            if key in data:
                fields.append(f"{key} = ?")
                values.append(data[key])
        if not fields:
            return jsonify({"error": "nothing to update"}), 400
        values.append(entry_id)
        db.execute(f"UPDATE time_entries SET {', '.join(fields)} WHERE id = ?", values)
        db.commit()
        return jsonify({"id": entry_id, "updated": True})


app = create_app()

if __name__ == "__main__":
    app.run(debug=True, port=5000)
