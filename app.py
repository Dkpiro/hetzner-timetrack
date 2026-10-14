import csv
import io
import os
import secrets
import sqlite3
from datetime import datetime
from pathlib import Path

from flask import Flask, jsonify, redirect, render_template, request, session, url_for
from werkzeug.security import generate_password_hash

import db as db_module
from auth import api_or_login_required, check_password, login_required

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

    @app.route("/plan")
    @login_required
    def plan_page():
        return render_template("plan.html")

    @app.route("/topics")
    @login_required
    def topics_page():
        return render_template("topics.html")

    # ---- API: status / timer control ----

    def _clean_ticket(value):
        value = (value or "").strip()
        return value or None

    def _parse_iso(value):
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00"))
        except (AttributeError, ValueError):
            return None

    def _get_day(db, date):
        row = db.execute(
            "SELECT date, started_at, finished_at FROM days WHERE date = ?", (date,)
        ).fetchone()
        return dict(row) if row else None

    @app.route("/api/status")
    @login_required
    def api_status():
        db = db_module.get_db()
        entry = db.execute(
            """SELECT te.id, te.topic_id, te.start_ts, te.ticket,
                      t.name AS topic_name, c.name AS category_name
               FROM time_entries te
               JOIN topics t ON t.id = te.topic_id
               JOIN categories c ON c.id = t.category_id
               WHERE te.end_ts IS NULL
               ORDER BY te.start_ts DESC LIMIT 1"""
        ).fetchone()
        day = untracked_since = None
        date = request.args.get("date")
        if date:
            day = _get_day(db, date)
            if day:
                last_end = db.execute(
                    "SELECT MAX(end_ts) AS m FROM time_entries "
                    "WHERE end_ts IS NOT NULL AND end_ts >= ?",
                    (day["started_at"],),
                ).fetchone()["m"]
                untracked_since = max(day["started_at"], last_end or "")
        return jsonify(
            {
                "active": dict(entry) if entry else None,
                "day": day,
                "untracked_since": untracked_since,
            }
        )

    # ---- API: day clock (start day / Feierabend) ----

    @app.route("/api/day")
    @login_required
    def api_day():
        date = request.args.get("date", "")
        return jsonify({"day": _get_day(db_module.get_db(), date)})

    @app.route("/api/days/open")
    @login_required
    def api_days_open():
        rows = db_module.get_db().execute(
            "SELECT date, started_at FROM days WHERE finished_at IS NULL ORDER BY date"
        ).fetchall()
        return jsonify([dict(r) for r in rows])

    @app.route("/api/day/start", methods=["POST"])
    @login_required
    def api_day_start():
        date = (request.get_json(force=True).get("date") or "").strip()
        if not date:
            return jsonify({"error": "date required"}), 400
        db = db_module.get_db()
        if not _get_day(db, date):
            db.execute(
                "INSERT INTO days (date, started_at) VALUES (?, ?)",
                (date, db_module.now_iso()),
            )
            db.commit()
        return jsonify({"day": _get_day(db, date)})

    @app.route("/api/day/finish", methods=["POST"])
    @login_required
    def api_day_finish():
        data = request.get_json(force=True)
        date = (data.get("date") or "").strip()
        db = db_module.get_db()
        if not _get_day(db, date):
            return jsonify({"error": "that day was never started"}), 404
        finished_at = data.get("finished_at") or db_module.now_iso()
        finished_dt = _parse_iso(finished_at)
        if not finished_dt:
            return jsonify({"error": "invalid finished_at"}), 400
        active = db.execute(
            "SELECT id, start_ts FROM time_entries WHERE end_ts IS NULL"
        ).fetchone()
        # Only close the running entry if it started before the finish time;
        # otherwise it belongs to a later day and must be left alone.
        if active:
            start_dt = _parse_iso(active["start_ts"])
            if start_dt and start_dt <= finished_dt:
                db.execute(
                    "UPDATE time_entries SET end_ts = ? WHERE id = ?",
                    (finished_at, active["id"]),
                )
        db.execute("UPDATE days SET finished_at = ? WHERE date = ?", (finished_at, date))
        db.commit()
        return jsonify({"day": _get_day(db, date)})

    @app.route("/api/day/reopen", methods=["POST"])
    @login_required
    def api_day_reopen():
        date = (request.get_json(force=True).get("date") or "").strip()
        db = db_module.get_db()
        db.execute("UPDATE days SET finished_at = NULL WHERE date = ?", (date,))
        db.commit()
        return jsonify({"day": _get_day(db, date)})

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
        date = (data.get("date") or "").strip()
        now = db_module.now_iso()
        if date:
            day = _get_day(db, date)
            if day and day["finished_at"]:
                return jsonify({"error": "This day is finished. Reopen it to keep tracking."}), 409
            if not day:
                db.execute(
                    "INSERT INTO days (date, started_at) VALUES (?, ?)", (date, now)
                )
        _stop_active(db)
        cur = db.execute(
            "INSERT INTO time_entries (topic_id, start_ts, ticket) VALUES (?, ?, ?)",
            (topic_id, now, _clean_ticket(data.get("ticket"))),
        )
        db.commit()
        return jsonify({"id": cur.lastrowid, "start_ts": now})

    @app.route("/api/recent-topics")
    @login_required
    def api_recent_topics():
        limit = min(int(request.args.get("limit", 6)), 20)
        rows = db_module.get_db().execute(
            """SELECT t.id, t.name, t.category_id, c.name AS category_name,
                      MAX(te.start_ts) AS last_used
               FROM time_entries te
               JOIN topics t ON t.id = te.topic_id
               JOIN categories c ON c.id = t.category_id
               WHERE t.archived = 0
               GROUP BY t.id
               ORDER BY last_used DESC LIMIT ?""",
            (limit,),
        ).fetchall()
        return jsonify([dict(r) for r in rows])

    @app.route("/api/tickets")
    @login_required
    def api_tickets():
        topic_id = request.args.get("topic_id", type=int)
        rows = db_module.get_db().execute(
            """SELECT ticket, MAX(start_ts) AS last_used FROM time_entries
               WHERE topic_id = ? AND ticket IS NOT NULL AND ticket != ''
               GROUP BY ticket ORDER BY last_used DESC LIMIT 8""",
            (topic_id,),
        ).fetchall()
        return jsonify([r["ticket"] for r in rows])

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

    def _query_entries(start, end, order="DESC"):
        query = (
            "SELECT te.id, te.topic_id, te.start_ts, te.end_ts, te.note, te.ticket, "
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
        query += f" ORDER BY te.start_ts {order}"
        return db_module.get_db().execute(query, params).fetchall()

    @app.route("/api/entries", methods=["GET", "POST"])
    @login_required
    def api_entries():
        if request.method == "POST":
            data = request.get_json(force=True)
            db = db_module.get_db()
            start_dt, end_dt = _parse_iso(data.get("start_ts")), _parse_iso(data.get("end_ts"))
            if not start_dt or not end_dt or end_dt <= start_dt:
                return jsonify({"error": "valid start_ts and a later end_ts required"}), 400
            if not db.execute(
                "SELECT 1 FROM topics WHERE id = ?", (data.get("topic_id"),)
            ).fetchone():
                return jsonify({"error": "unknown topic"}), 404
            cur = db.execute(
                "INSERT INTO time_entries (topic_id, start_ts, end_ts, ticket, note) "
                "VALUES (?, ?, ?, ?, ?)",
                (
                    data["topic_id"],
                    data["start_ts"],
                    data["end_ts"],
                    _clean_ticket(data.get("ticket")),
                    data.get("note"),
                ),
            )
            db.commit()
            return jsonify({"id": cur.lastrowid})
        rows = _query_entries(request.args.get("start"), request.args.get("end"))
        return jsonify([dict(r) for r in rows])

    @app.route("/api/export")
    @api_or_login_required
    def api_export():
        """Read-only export for importing into other tools.

        Query: start/end (ISO datetimes or YYYY-MM-DD, compared against
        start_ts in UTC), format=csv|json (default csv).
        """
        rows = _query_entries(
            request.args.get("start"), request.args.get("end"), order="ASC"
        )
        records = []
        for r in rows:
            start_dt, end_dt = _parse_iso(r["start_ts"]), _parse_iso(r["end_ts"] or "")
            records.append(
                {
                    "id": r["id"],
                    "start": r["start_ts"],
                    "end": r["end_ts"],
                    "duration_seconds": int((end_dt - start_dt).total_seconds())
                    if start_dt and end_dt
                    else None,
                    "category": r["category_name"],
                    "topic": r["topic_name"],
                    "ticket": r["ticket"],
                    "note": r["note"],
                }
            )
        if request.args.get("format") == "json":
            return jsonify(records)
        buf = io.StringIO()
        writer = csv.DictWriter(
            buf,
            fieldnames=["id", "start", "end", "duration_seconds", "category", "topic", "ticket", "note"],
        )
        writer.writeheader()
        writer.writerows(records)
        return app.response_class(
            buf.getvalue(),
            mimetype="text/csv",
            headers={"Content-Disposition": "attachment; filename=timetrack-export.csv"},
        )

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
        if "ticket" in data:
            fields.append("ticket = ?")
            values.append(_clean_ticket(data["ticket"]))
        if not fields:
            return jsonify({"error": "nothing to update"}), 400
        values.append(entry_id)
        db.execute(f"UPDATE time_entries SET {', '.join(fields)} WHERE id = ?", values)
        db.commit()
        return jsonify({"id": entry_id, "updated": True})

    # ---- API: next-day planning ----

    PLAN_SELECT = (
        "SELECT p.id, p.plan_date, p.topic_id, p.title, p.notes, p.expected_minutes, "
        "p.ticket, p.sort_order, p.done, t.name AS topic_name, c.name AS category_name "
        "FROM plan_items p JOIN topics t ON t.id = p.topic_id "
        "JOIN categories c ON c.id = t.category_id "
    )

    def _next_sort_order(db, plan_date):
        return db.execute(
            "SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM plan_items WHERE plan_date = ?",
            (plan_date,),
        ).fetchone()["n"]

    def _minutes_or_none(value):
        if value in (None, ""):
            return None
        try:
            return max(0, int(value))
        except (TypeError, ValueError):
            return None

    @app.route("/api/plan", methods=["GET", "POST"])
    @login_required
    def api_plan():
        db = db_module.get_db()
        if request.method == "POST":
            data = request.get_json(force=True)
            plan_date = (data.get("plan_date") or "").strip()
            title = (data.get("title") or "").strip()
            if not plan_date or not title or not data.get("topic_id"):
                return jsonify({"error": "plan_date, topic_id and title required"}), 400
            if not db.execute(
                "SELECT 1 FROM topics WHERE id = ?", (data["topic_id"],)
            ).fetchone():
                return jsonify({"error": "unknown topic"}), 404
            cur = db.execute(
                "INSERT INTO plan_items (plan_date, topic_id, title, notes, "
                "expected_minutes, ticket, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (
                    plan_date,
                    data["topic_id"],
                    title,
                    (data.get("notes") or "").strip() or None,
                    _minutes_or_none(data.get("expected_minutes")),
                    _clean_ticket(data.get("ticket")),
                    _next_sort_order(db, plan_date),
                ),
            )
            db.commit()
            return jsonify({"id": cur.lastrowid})
        rows = db.execute(
            PLAN_SELECT + "WHERE p.plan_date = ? ORDER BY p.sort_order, p.id",
            (request.args.get("date", ""),),
        ).fetchall()
        return jsonify([dict(r) for r in rows])

    @app.route("/api/plan/<int:item_id>", methods=["PATCH", "DELETE"])
    @login_required
    def api_plan_item(item_id):
        db = db_module.get_db()
        if request.method == "DELETE":
            db.execute("DELETE FROM plan_items WHERE id = ?", (item_id,))
            db.commit()
            return jsonify({"deleted": True})
        data = request.get_json(force=True)
        fields, values = [], []
        if "title" in data:
            title = (data["title"] or "").strip()
            if not title:
                return jsonify({"error": "title required"}), 400
            fields.append("title = ?")
            values.append(title)
        if "notes" in data:
            fields.append("notes = ?")
            values.append((data["notes"] or "").strip() or None)
        if "expected_minutes" in data:
            fields.append("expected_minutes = ?")
            values.append(_minutes_or_none(data["expected_minutes"]))
        if "ticket" in data:
            fields.append("ticket = ?")
            values.append(_clean_ticket(data["ticket"]))
        if "topic_id" in data:
            fields.append("topic_id = ?")
            values.append(data["topic_id"])
        if "done" in data:
            fields.append("done = ?")
            values.append(1 if data["done"] else 0)
        if "plan_date" in data:
            # Moving to another day puts the item at the end of that day's list.
            fields.extend(["plan_date = ?", "sort_order = ?"])
            values.extend([data["plan_date"], _next_sort_order(db, data["plan_date"])])
        if not fields:
            return jsonify({"error": "nothing to update"}), 400
        values.append(item_id)
        db.execute(f"UPDATE plan_items SET {', '.join(fields)} WHERE id = ?", values)
        db.commit()
        return jsonify({"id": item_id, "updated": True})

    @app.route("/api/plan/reorder", methods=["POST"])
    @login_required
    def api_plan_reorder():
        data = request.get_json(force=True)
        db = db_module.get_db()
        for index, item_id in enumerate(data.get("ids", [])):
            db.execute(
                "UPDATE plan_items SET sort_order = ? WHERE id = ? AND plan_date = ?",
                (index, item_id, data.get("plan_date")),
            )
        db.commit()
        return jsonify({"reordered": True})


app = create_app()

if __name__ == "__main__":
    app.run(debug=True, port=5000)
