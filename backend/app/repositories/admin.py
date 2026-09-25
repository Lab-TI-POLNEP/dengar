"""Read-only access to the existing admin account table."""

from __future__ import annotations

from sqlalchemy import select

from ..models import Admin


def find_admin(session, username: str | None = None) -> Admin | None:
    statement = select(Admin)
    if username is not None:
        statement = statement.where(Admin.username == username)
    return session.scalar(statement.limit(1))