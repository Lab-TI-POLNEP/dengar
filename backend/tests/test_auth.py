from __future__ import annotations

import logging
from datetime import datetime

import pytest
from argon2 import PasswordHasher
from fastapi.testclient import TestClient

from backend.app.core.config import Settings
from backend.app.core.security import login_states
from backend.app.main import create_app
from backend.app.models import Admin, Base


def get_csrf(client) -> str:
    response = client.get("/admin/csrf-token")
    assert response.status_code == 200
    return response.json()["csrf_token"]


def login(client, csrf: str | None = None):
    token = csrf or get_csrf(client)
    return client.post(
        "/admin/login",
        json={"username": "admin", "password": "secret123", "csrf_token": token},
    )


def test_authentication_and_csrf_ordering(fastapi_auth_client) -> None:
    client = fastapi_auth_client
    csrf = get_csrf(client)

    assert client.get("/admin/api/settings").status_code == 401
    assert client.post("/admin/logout").json() == {"error": "authentication required"}
    assert client.post("/admin/login", json={"username": "admin", "password": "secret123"}).json() == {
        "error": "missing or invalid CSRF token"
    }
    assert client.post(
        "/admin/login",
        json={"username": "admin", "password": "secret123", "csrf_token": csrf},
    ).status_code == 200
    assert client.post("/admin/logout").json() == {"error": "missing or invalid CSRF token"}
    assert client.get("/admin/api/settings").status_code == 200
    assert client.post("/admin/logout", headers={"X-CSRF-Token": csrf}).json() == {
        "status": "logged out"
    }
    assert client.get("/admin/api/settings").status_code == 401


def test_admin_created_at_default_is_persisted(fastapi_auth_client) -> None:
    with fastapi_auth_client.app.state.session_factory() as session:
        admin = session.query(Admin).filter_by(username="admin").one()
        assert isinstance(admin.created_at, datetime)
        assert admin.created_at is not None


def test_csrf_header_takes_precedence_and_invalid_credentials_are_generic(fastapi_auth_client) -> None:
    client = fastapi_auth_client
    csrf = get_csrf(client)
    response = client.post(
        "/admin/login",
        json={"username": "admin", "password": "wrong", "csrf_token": csrf},
        headers={"X-CSRF-Token": "wrong"},
    )
    assert response.status_code == 400
    response = client.post(
        "/admin/login", json={"username": "admin", "password": "wrong", "csrf_token": csrf}
    )
    assert response.status_code == 401
    assert response.json() == {"error": "invalid credentials"}


def test_rate_limit_threshold(fastapi_auth_client) -> None:
    login_states.clear()
    client = fastapi_auth_client
    csrf = get_csrf(client)
    for _ in range(5):
        assert client.post(
            "/admin/login", json={"username": "admin", "password": "wrong", "csrf_token": csrf}
        ).status_code == 401
    response = client.post(
        "/admin/login", json={"username": "admin", "password": "wrong", "csrf_token": csrf}
    )
    assert response.status_code == 429
    assert response.json() == {"error": "too many failed login attempts"}
    login_states.clear()


@pytest.mark.parametrize("secure", [False, True])
def test_session_cookie_attributes(tmp_path, secure: bool) -> None:
    data_dir = tmp_path / f"app-{secure}"
    data_dir.mkdir(parents=True, exist_ok=True)
    settings = Settings(
        data_dir=data_dir,
        admin_initial_password=None,
        secret_key="cookie-secret",
        session_cookie_secure=secure,
        max_audio_upload_mb=100,
    )
    app = create_app(settings)
    Base.metadata.create_all(app.state.engine)
    with app.state.session_factory() as session:
        session.add(Admin(username="admin", password_hash=PasswordHasher().hash("secret123")))
        session.commit()
    base_url = "https://testserver" if secure else "http://testserver"
    with TestClient(app, base_url=base_url, raise_server_exceptions=False) as client:
        response = login(client)
    cookie = response.headers.get("set-cookie", "").lower()
    assert "session=" in cookie
    assert "path=/" in cookie
    assert "httponly" in cookie
    assert ("samesite=none" in cookie) is secure
    assert ("samesite=lax" in cookie) is not secure
    assert ("secure" in cookie) is secure


def test_generic_errors_do_not_expose_secrets_or_log_details(fastapi_auth_client, caplog) -> None:
    app = fastapi_auth_client.app

    @app.get("/__test-secret-error")
    async def secret_error():
        raise RuntimeError("password=secret path=C:\\private database=prod")

    with caplog.at_level(logging.DEBUG):
        response = fastapi_auth_client.get("/__test-secret-error")
    assert response.status_code == 500
    assert response.json() == {"detail": "internal server error"}
    assert "secret" not in response.text.lower()
    assert "private" not in response.text.lower()
    assert "prod" not in caplog.text


def test_settings_update_validation_persistence_and_password(fastapi_auth_client) -> None:
    client = fastapi_auth_client
    csrf = get_csrf(client)
    assert login(client, csrf).status_code == 200

    assert client.put("/admin/api/settings", json={"default_page_size": 50}).status_code == 400
    invalid = client.put(
        "/admin/api/settings", json={"default_page_size": 4}, headers={"X-CSRF-Token": csrf}
    )
    assert invalid.status_code == 422
    assert invalid.json() == {"error": "default_page_size must be between 5 and 100"}
    invalid = client.put(
        "/admin/api/settings", json={"default_page_size": "many"}, headers={"X-CSRF-Token": csrf}
    )
    assert invalid.status_code == 422
    assert invalid.json() == {"error": "default_page_size must be an integer"}
    invalid = client.put(
        "/admin/api/settings", json={"new_password": "short", "confirm_password": "short"},
        headers={"X-CSRF-Token": csrf},
    )
    assert invalid.status_code == 422
    assert invalid.json() == {"error": "new_password must be at least 8 characters long"}
    invalid = client.put(
        "/admin/api/settings", json={"new_password": "newSecret456", "confirm_password": "different"},
        headers={"X-CSRF-Token": csrf},
    )
    assert invalid.status_code == 422
    assert invalid.json() == {"error": "new_password and confirm_password must match"}
    updated = client.put(
        "/admin/api/settings",
        json={"default_page_size": 50, "new_password": "newSecret456", "confirm_password": "newSecret456"},
        headers={"X-CSRF-Token": csrf},
    )
    assert updated.status_code == 200
    assert updated.json()["default_page_size"] == 50
    assert client.get("/admin/api/settings").json()["default_page_size"] == 50

    assert client.post("/admin/logout", headers={"X-CSRF-Token": csrf}).status_code == 200
    next_csrf = get_csrf(client)
    assert client.post(
        "/admin/login",
        json={"username": "admin", "password": "newSecret456", "csrf_token": next_csrf},
    ).status_code == 200