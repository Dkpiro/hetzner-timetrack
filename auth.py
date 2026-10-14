import functools
import hmac
import os

from flask import current_app, jsonify, redirect, request, session, url_for
from werkzeug.security import check_password_hash


def check_password(password):
    return check_password_hash(current_app.config["PASSWORD_HASH"], password)


def login_required(view):
    @functools.wraps(view)
    def wrapped(*args, **kwargs):
        if not session.get("logged_in"):
            return redirect(url_for("login", next=request.path))
        return view(*args, **kwargs)

    return wrapped


def api_or_login_required(view):
    """Session login, or `Authorization: Bearer <TIMETRACK_API_TOKEN>` for
    machine clients (read-only export). The token route is disabled unless
    the env var is set."""

    @functools.wraps(view)
    def wrapped(*args, **kwargs):
        token = os.environ.get("TIMETRACK_API_TOKEN")
        header = request.headers.get("Authorization", "")
        if token and header.startswith("Bearer "):
            if hmac.compare_digest(header[len("Bearer "):], token):
                return view(*args, **kwargs)
            return jsonify({"error": "invalid token"}), 401
        if not session.get("logged_in"):
            return redirect(url_for("login", next=request.path))
        return view(*args, **kwargs)

    return wrapped
