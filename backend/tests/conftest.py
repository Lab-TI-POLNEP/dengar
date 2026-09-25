from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.app.api.auth import hash_password
from backend.app.core.config import Settings
from backend.app.main import create_app
from backend.app.models import Admin, Base


@pytest.fixture()
def fastapi_settings(tmp_path: Path) -> Settings:
    return Settings(
        data_dir=tmp_path,
        admin_initial_password=None,
        secret_key="test-only-secret-key-at-least-32-chars-long",
        session_cookie_secure=False,
        max_audio_upload_mb=100,
    )


@pytest.fixture()
def fastapi_client(fastapi_settings: Settings):
    app = create_app(fastapi_settings)
    with TestClient(app, raise_server_exceptions=False) as client:
        yield client


@pytest.fixture()
def fastapi_auth_client(tmp_path: Path):
    settings = Settings(
        data_dir=tmp_path,
        admin_initial_password=None,
        secret_key="test-secret-key-at-least-32-chars-long",
        session_cookie_secure=False,
        max_audio_upload_mb=100,
    )
    app = create_app(settings)
    # Ensure test DB is at alembic head (schema parity)
    from pathlib import Path

    from backend.app.core.database import stamp_alembic_head
    MIGRATIONS_DIR = Path(__file__).resolve().parents[1] / "migrations"
    stamp_alembic_head(app.state.engine, MIGRATIONS_DIR)
    Base.metadata.create_all(app.state.engine)
    with app.state.session_factory() as session:
        session.add(Admin(username="admin", password_hash=hash_password("secret123")))
        session.commit()
    with TestClient(app, raise_server_exceptions=False) as client:
        yield client
