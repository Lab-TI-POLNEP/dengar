"""FastAPI application construction."""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response
from sqlalchemy import select, text
from sqlalchemy.exc import SQLAlchemyError
from starlette.middleware.sessions import SessionMiddleware

from .api.audio import router as audio_router
from .api.auth import DEFAULT_ADMIN_USERNAME, hash_password
from .api.auth import router as auth_router
from .api.backup import router as backup_router
from .api.dashboard import router as dashboard_router
from .api.entities import router as entities_router
from .api.respondent import router as respondent_router
from .api.tests import router as tests_router
from .core.config import Settings
from .core.database import create_database_engine, create_session_factory, stamp_alembic_head
from .models import Admin, Base

logger = logging.getLogger("dengar.app")

MIGRATIONS_DIR = Path(__file__).resolve().parents[1] / "migrations"


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Verify database connectivity and seed default admin account."""
    app.state.settings.data_dir.mkdir(parents=True, exist_ok=True)
    engine = create_database_engine(app.state.settings.database_url)
    Base.metadata.create_all(engine)
    try:
        revision = stamp_alembic_head(engine, MIGRATIONS_DIR)
    except (ImportError, OSError, SQLAlchemyError) as exc:
        logger.warning("could not stamp alembic revision: %s", exc)
    else:
        if revision:
            logger.info("database stamped at alembic head", extra={"revision": revision})
    with app.state.session_factory() as session:
        session.execute(text("SELECT 1"))
        admin = session.execute(select(Admin).limit(1)).mappings().first()
        if admin is None and app.state.settings.admin_initial_password:
            session.add(
                Admin(
                    username=DEFAULT_ADMIN_USERNAME,
                    password_hash=hash_password(app.state.settings.admin_initial_password),
                )
            )
            session.commit()
    yield
    app.state.engine.dispose()


def create_app(settings: Settings | None = None) -> FastAPI:
    resolved_settings = settings or Settings.from_environment()
    engine = create_database_engine(resolved_settings.database_url)
    app = FastAPI(
        title="Dengar FastAPI Backend",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        lifespan=lifespan,
    )
    app.add_middleware(
        SessionMiddleware,
        secret_key=resolved_settings.secret_key,
        session_cookie="session",
        max_age=28800,
        same_site="none" if resolved_settings.session_cookie_secure else "lax",
        https_only=resolved_settings.session_cookie_secure,
    )

    # Low-cost, no-feature-risk security headers.
    from starlette.types import ASGIApp, Receive, Scope, Send

    class _SecurityHeadersMiddleware:
        def __init__(self, app_inner: ASGIApp):
            self.app_inner = app_inner

        async def __call__(self, scope: Scope, receive: Receive, send: Send):
            if scope["type"] != "http":
                await self.app_inner(scope, receive, send)
                return

            async def _send(message):
                if message["type"] == "http.response.start":
                    headers = list(message.get("headers", []))
                    headers.append(
                        (b"x-content-type-options", b"nosniff"),
                    )
                    headers.append(
                        (b"x-frame-options", b"DENY"),
                    )
                    headers.append(
                        (b"referrer-policy", b"no-referrer"),
                    )
                    # CSP: restrict scripts/styles to self, allow inline for dev ergonomics
                    headers.append(
                        (b"content-security-policy",
                         b"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none';"),
                    )
                    headers.append(
                        (b"permissions-policy",
                         b"accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()"),
                    )
                    headers.append(
                        (b"cross-origin-opener-policy", b"same-origin"),
                    )
                    message["headers"] = headers
                await send(message)

            await self.app_inner(scope, receive, _send)

    app.add_middleware(_SecurityHeadersMiddleware)
    app.state.settings = resolved_settings
    app.state.engine = engine
    app.state.session_factory = create_session_factory(engine)
    app.include_router(auth_router)
    app.include_router(dashboard_router)
    app.include_router(backup_router)
    app.include_router(audio_router)
    app.include_router(tests_router)
    app.include_router(entities_router)
    app.include_router(respondent_router)

    @app.exception_handler(Exception)
    async def handle_unexpected_error(request: Request, exc: Exception) -> JSONResponse:
        del request
        logger.error("unhandled exception", extra={"exception_type": type(exc).__name__})
        return JSONResponse(status_code=500, content={"detail": "internal server error"})

    @app.get("/health")
    async def health() -> Response:
        return Response(
            content='{"status":"ok"}\n',
            media_type="application/json",
            status_code=200,
        )

    return app