"""Authentication and session endpoints."""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from sqlalchemy import MetaData, Table, select
from sqlalchemy.exc import SQLAlchemyError

from ..core.security import (
    clear_failed_attempts,
    csrf_token,
    hash_password,
    is_locked_out,
    record_failed_attempt,
    verify_csrf,
    verify_password,
)
from ..repositories.admin import find_admin

router = APIRouter(prefix="/admin")
DEFAULT_PAGE_SIZE = 20
DEFAULT_ADMIN_USERNAME = "admin"

logger = logging.getLogger("dengar.app")


def settings_tables(session):
    metadata = MetaData()
    return (
        Table("admin", metadata, autoload_with=session.bind),
        Table("setting", metadata, autoload_with=session.bind),
    )


def settings_payload(session) -> dict[str, object]:
    admin_table, setting_table = settings_tables(session)
    admin = session.execute(select(admin_table).limit(1)).mappings().first()
    setting = session.execute(
        select(setting_table).where(setting_table.c.key == "default_page_size")
    ).mappings().first()
    page_size = DEFAULT_PAGE_SIZE
    if setting is not None:
        try:
            page_size = int(str(setting["value"]))
        except (TypeError, ValueError):
            page_size = DEFAULT_PAGE_SIZE
    if not 5 <= page_size <= 100:
        page_size = DEFAULT_PAGE_SIZE
    return {
        "admin_username": admin["username"] if admin else "admin",
        "username_locked": True,
        "default_page_size": page_size,
    }


def client_key(request: Request) -> str:
    # Use the actual client IP; do not trust X-Forwarded-For from untrusted callers.
    return request.client.host if request.client else "127.0.0.1"


async def request_json(request: Request) -> dict[str, Any]:
    try:
        payload = await request.json()
    except (ValueError, UnicodeDecodeError):
        return {}
    return payload if isinstance(payload, dict) else {}


async def csrf_failure(request: Request) -> JSONResponse | None:
    token = request.headers.get("X-CSRF-Token")
    if not token:
        token = (await request_json(request)).get("csrf_token")
    if not verify_csrf(request.session, token):
        return JSONResponse({"error": "missing or invalid CSRF token"}, status_code=400)
    return None


def admin_required(request: Request) -> JSONResponse | None:
    if not request.session.get("is_admin_authenticated"):
        return JSONResponse({"error": "authentication required"}, status_code=401)
    return None


@router.get("/csrf-token")
async def issue_csrf_token(request: Request) -> dict[str, str]:
    return {"csrf_token": csrf_token(request.session)}


@router.post("/login")
async def login(request: Request) -> JSONResponse:
    csrf_error = await csrf_failure(request)
    if csrf_error:
        return csrf_error

    key = client_key(request)
    if is_locked_out(key):
        return JSONResponse({"error": "too many failed login attempts"}, status_code=429)

    payload = await request_json(request)
    username = payload.get("username")
    password = payload.get("password")
    if not username or not password:
        record_failed_attempt(key)
        return JSONResponse({"error": "username and password are required"}, status_code=400)

    try:
        with request.app.state.session_factory() as session:
            admin = find_admin(session, username if isinstance(username, str) else None)
            valid = bool(admin and isinstance(password, str) and verify_password(admin.password_hash, password))
            admin_username = admin.username if admin else None
    except SQLAlchemyError:
        return JSONResponse({"error": "internal server error"}, status_code=500)

    if not valid:
        record_failed_attempt(key)
        logger.info("failed login attempt", extra={"username": username})
        return JSONResponse({"error": "invalid credentials"}, status_code=401)

    clear_failed_attempts(key)
    logger.info("successful login", extra={"username": admin_username})
    preserved_csrf = request.session.get("csrf_token")
    request.session.clear()
    if preserved_csrf:
        request.session["csrf_token"] = preserved_csrf
    request.session["is_admin_authenticated"] = True
    request.session["admin_username"] = admin_username
    return JSONResponse({"status": "ok", "username": admin_username}, status_code=200)


@router.get("/dashboard")
async def admin_dashboard_session_check(request: Request) -> JSONResponse:
    auth_error = admin_required(request)
    if auth_error:
        return auth_error
    return JSONResponse({"message": "dashboard placeholder"}, status_code=200)


@router.post("/logout")
async def logout(request: Request) -> JSONResponse:
    auth_error = admin_required(request)
    if auth_error:
        return auth_error
    csrf_error = await csrf_failure(request)
    if csrf_error:
        return csrf_error
    request.session.clear()
    return JSONResponse({"status": "logged out"}, status_code=200)


@router.get("/api/settings")
async def admin_settings(request: Request) -> JSONResponse:
    auth_error = admin_required(request)
    if auth_error:
        return auth_error
    try:
        with request.app.state.session_factory() as session:
            admin_table, _ = settings_tables(session)
            if session.execute(select(admin_table).limit(1)).first() is None:
                return JSONResponse({"error": "admin account not found"}, status_code=404)
            return JSONResponse(settings_payload(session), status_code=200)
    except SQLAlchemyError:
        return JSONResponse({"error": "internal server error"}, status_code=500)


@router.put("/api/settings")
async def admin_settings_update(request: Request) -> JSONResponse:
    auth_error = admin_required(request)
    if auth_error:
        return auth_error
    csrf_error = await csrf_failure(request)
    if csrf_error:
        return csrf_error

    payload = await request_json(request)
    password_changed = False
    try:
        with request.app.state.session_factory() as session:
            admin_table, setting_table = settings_tables(session)
            admin = session.execute(select(admin_table).limit(1)).mappings().first()
            if admin is None:
                return JSONResponse({"error": "admin account not found"}, status_code=404)

            page_size_raw = payload.get("default_page_size")
            if page_size_raw is not None:
                try:
                    page_size = int(page_size_raw)
                except (TypeError, ValueError):
                    return JSONResponse({"error": "default_page_size must be an integer"}, status_code=422)
                if not 5 <= page_size <= 100:
                    return JSONResponse({"error": "default_page_size must be between 5 and 100"}, status_code=422)
                setting = session.execute(
                    select(setting_table).where(setting_table.c.key == "default_page_size")
                ).mappings().first()
                if setting is None:
                    session.execute(setting_table.insert().values(key="default_page_size", value=str(DEFAULT_PAGE_SIZE)))
                session.execute(
                    setting_table.update()
                    .where(setting_table.c.key == "default_page_size")
                    .values(value=str(page_size))
                )

            new_password = payload.get("new_password")
            confirm_password = payload.get("confirm_password")
            if new_password is not None or confirm_password is not None:
                if not isinstance(new_password, str) or not new_password.strip():
                    return JSONResponse({"error": "new_password is required"}, status_code=422)
                if new_password != confirm_password:
                    return JSONResponse({"error": "new_password and confirm_password must match"}, status_code=422)
                if len(new_password) < 8:
                    return JSONResponse({"error": "new_password must be at least 8 characters long"}, status_code=422)
                session.execute(
                    admin_table.update().where(admin_table.c.id == admin["id"]).values(
                        password_hash=hash_password(new_password)
                    )
                )
                password_changed = True
            session.commit()
            if password_changed:
                logger.info("admin password changed", extra={"username": admin["username"]})
            return JSONResponse(settings_payload(session), status_code=200)
    except SQLAlchemyError:
        return JSONResponse({"error": "internal server error"}, status_code=500)