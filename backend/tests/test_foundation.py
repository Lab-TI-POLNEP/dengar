from __future__ import annotations

from fastapi import Request
from fastapi.responses import JSONResponse

from backend.app.core.config import Settings, SettingsError


def test_health_and_public_api_docs_are_disabled(fastapi_client) -> None:
    response = fastapi_client.get("/health")

    assert response.status_code == 200
    assert response.headers["content-type"] == "application/json"
    assert response.content == b'{"status":"ok"}\n'
    assert fastapi_client.get("/docs").status_code == 404
    assert fastapi_client.get("/redoc").status_code == 404
    assert fastapi_client.get("/openapi.json").status_code == 404


def test_unexpected_errors_use_a_generic_response(fastapi_client) -> None:
    app = fastapi_client.app

    @app.get("/__test-error")
    async def raise_error(request: Request) -> JSONResponse:
        del request
        raise RuntimeError("secret path and database details")

    response = fastapi_client.get("/__test-error")

    assert response.status_code == 500
    assert response.json() == {"detail": "internal server error"}
    assert "secret path" not in response.text
    assert "database" not in response.text


def test_settings_load_from_environment(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("DATA_DIR", str(tmp_path / "storage"))
    monkeypatch.setenv("ADMIN_INITIAL_PASSWORD", "initial")
    monkeypatch.setenv("SECRET_KEY", "test-secret-key-at-least-32-chars-long")
    monkeypatch.setenv("SESSION_COOKIE_SECURE", "yes")
    monkeypatch.setenv("MAX_AUDIO_UPLOAD_MB", "12")

    settings = Settings.from_environment(load_env=False)

    assert settings.admin_initial_password == "initial"
    assert settings.secret_key == "test-secret-key-at-least-32-chars-long"
    assert settings.session_cookie_secure is True
    assert settings.max_audio_upload_mb == 12
    assert settings.data_dir == tmp_path / "storage"
    assert settings.database_path == tmp_path / "storage" / "dengar.sqlite3"
    assert settings.database_url == f"sqlite:///{(tmp_path / 'storage' / 'dengar.sqlite3').as_posix()}"
    assert settings.audio_storage_path == tmp_path / "storage" / "audio"
    assert settings.config_storage_path == tmp_path / "storage" / "config"
    assert settings.backup_storage_path == tmp_path / "storage" / "backups"


def test_settings_require_a_secret(monkeypatch) -> None:
    monkeypatch.delenv("SECRET_KEY", raising=False)

    try:
        Settings.from_environment(load_env=False)
    except SettingsError as error:
        assert str(error) == "SECRET_KEY must be configured"
    else:
        raise AssertionError("missing secret must not receive an insecure default")
