"""Regression guards for the batch 4-fix audit: JSON error surfaces, admin audit
logging (publish/unpublish, password change, backup restore) and the restore path
reconnecting the SQLAlchemy pool after the database file is replaced.
"""

from __future__ import annotations

import logging
from pathlib import Path

from starlette.requests import Request
from test_auth import get_csrf, login

from backend.app import models as db
from backend.app.services.media_service import stream_media_file


def _csrf(client) -> str:
    return get_csrf(client)


def _request(headers: dict[str, str]) -> Request:
    scope = {
        "type": "http",
        "method": "GET",
        "path": "/media",
        "headers": [(key.lower().encode(), value.encode()) for key, value in headers.items()],
    }
    return Request(scope)


def test_unsatisfiable_range_is_json(fastapi_auth_client) -> None:
    audio_path = Path(fastapi_auth_client.app.state.settings.audio_storage_path)
    audio_path.mkdir(parents=True, exist_ok=True)
    target = audio_path / "range-probe.wav"
    target.write_bytes(b"RIFF....WAVEfmt data")

    response = stream_media_file(_request({"Range": "bytes=99999-100000"}), target, "audio/wav", target.name)

    assert response.status_code == 416
    assert response.headers["content-type"].startswith("application/json")
    assert response.headers["content-range"] == f"bytes */{target.stat().st_size}"


def test_malformed_content_length_does_not_crash_upload(fastapi_auth_client) -> None:
    client = fastapi_auth_client
    csrf = _csrf(client)
    assert login(client, csrf).status_code == 200

    for bogus in ("abc", "-5", "1e3"):
        response = client.post(
            "/admin/api/audio",
            files={"file": ("probe.wav", b"RIFF....WAVEfmt ", "audio/wav")},
            headers={"X-CSRF-Token": csrf, "Content-Length": bogus},
        )
        assert response.status_code == 201, (bogus, response.status_code, response.text)


def test_json_error_surface_for_invalid_test_id(fastapi_auth_client) -> None:
    client = fastapi_auth_client
    response = client.get("/admin/api/tests/not-a-number")

    assert response.status_code == 404
    assert response.headers["content-type"].startswith("application/json")
    assert response.json() == {"error": "not found"}


def test_json_error_surface_for_unknown_test(fastapi_auth_client) -> None:
    client = fastapi_auth_client
    csrf = _csrf(client)
    assert login(client, csrf).status_code == 200

    response = client.get("/admin/api/tests/999999")

    assert response.status_code == 404
    assert response.headers["content-type"].startswith("application/json")
    assert response.json() == {"error": "test not found"}


def test_unpublish_emits_audit_log(fastapi_auth_client, caplog) -> None:
    client = fastapi_auth_client
    with client.app.state.session_factory() as session:
        record = db.Test(name="Audit test", version=1, status="published", config_yaml="{}\n", access_code="AB23CD")
        session.add(record)
        session.commit()
        test_id = record.id

    csrf = _csrf(client)
    assert login(client, csrf).status_code == 200

    with caplog.at_level(logging.INFO, logger="dengar.app"):
        response = client.post(f"/admin/api/tests/{test_id}/unpublish", headers={"X-CSRF-Token": csrf})

    assert response.status_code == 200
    assert response.json()["status"] == "draft"
    assert any(record.message == "test publish state changed" for record in caplog.records)
    event = next(record for record in caplog.records if record.message == "test publish state changed")
    assert event.from_status == "published"
    assert event.to_status == "draft"
    assert event.test_id == test_id


def test_password_change_emits_audit_log(fastapi_auth_client, caplog) -> None:
    client = fastapi_auth_client
    csrf = _csrf(client)
    assert login(client, csrf).status_code == 200

    with caplog.at_level(logging.INFO, logger="dengar.app"):
        response = client.put(
            "/admin/api/settings",
            json={"new_password": "new-secret-123", "confirm_password": "new-secret-123", "csrf_token": csrf},
        )

    assert response.status_code == 200
    assert any(record.message == "admin password changed" for record in caplog.records)


def test_restore_reconnects_pool_and_keeps_data(fastapi_auth_client, caplog) -> None:
    client = fastapi_auth_client
    with client.app.state.session_factory() as session:
        session.add(db.Test(name="Restored test", version=1, status="draft", config_yaml="{}\n"))
        session.commit()

    csrf = _csrf(client)
    assert login(client, csrf).status_code == 200

    created = client.post("/admin/api/backups", headers={"X-CSRF-Token": csrf})
    assert created.status_code == 200
    archive = created.headers["content-disposition"].split("filename=")[-1].strip('"')

    with caplog.at_level(logging.INFO, logger="dengar.app"):
        restored = client.post(
            f"/admin/api/backups/{archive}/restore",
            json={"confirm": True, "csrf_token": csrf},
        )

    assert restored.status_code == 200, restored.text
    assert any(record.message == "backup restored" for record in caplog.records)

    # The restore replaced the database file; the pool must serve the restored one.
    listing = client.get("/admin/api/tests")
    assert listing.status_code == 200
    assert [item["name"] for item in listing.json()["items"]] == ["Restored test"]

    with client.app.state.session_factory() as session:
        assert session.query(db.Test).count() == 1
