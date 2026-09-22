import functools

from flask import current_app, redirect, request, session, url_for
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
