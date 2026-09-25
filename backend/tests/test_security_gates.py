"""End-to-end regression guards for the S1-S3 security gates.

S1: /api/media/stream authorization, presentation order, calibration gate,
    SUS play authorization/quota and completion gating.
S2: per-client rate limits on /api/sessions/resolve and /api/sessions/start.
S3: admin login lockout keyed on the real client address, not X-Forwarded-For.

These drive the public HTTP surface, so they also cover the async file-streaming
path in services/media_service.py (full-content and Range responses).
"""

from __future__ import annotations

from pathlib import Path

import pytest
import yaml
from test_auth import get_csrf, login

from backend.app import models as db
from backend.app.core.security import MAX_LOGIN_FAILURES, login_states, request_history

MOS_ASSET_ID = "a" * 32
SUS_ASSET_ID = "b" * 32
CAL_ASSET_ID = "d" * 32
TOKEN = "c" * 64

MOS_BYTES = b"RIFFmos-data"
SUS_BYTES = b"RIFFsus-data"
CAL_BYTES = b"RIFFcal-data"


@pytest.fixture(autouse=True)
def _reset_security_state():
    """Rate limits and login lockouts are process-global; isolate every test."""
    login_states.clear()
    request_history.clear()
    yield
    login_states.clear()
    request_history.clear()


def _seed(client, *, kinds=("mos", "sus"), calibration: bool = False, quota: int = 2) -> dict:
    """Create a published test, audio assets, an active session and its stimulus order."""
    storage = Path(client.app.state.settings.audio_storage_path)
    storage.mkdir(parents=True, exist_ok=True)
    (storage / "mos.wav").write_bytes(MOS_BYTES)
    (storage / "sus.wav").write_bytes(SUS_BYTES)
    (storage / "cal.wav").write_bytes(CAL_BYTES)

    audio = {"mos_a": MOS_ASSET_ID, "sus_a": SUS_ASSET_ID}
    if calibration:
        audio["cal_a"] = CAL_ASSET_ID

    config = {
        "name": "Gate test",
        "test_type": "mos_sus",
        "audio": audio,
        "pages": [
            {"kind": "consent"},
            {"kind": "mos", "stimuli": [{"audio_ref": "mos_a"}]},
            {"kind": "sus", "stimuli": [{"audio_ref": "sus_a"}]},
            {"kind": "completion"},
        ],
        "sus": {"quota": quota},
    }
    if calibration:
        config["calibration_audio_ref"] = "cal_a"

    with client.app.state.session_factory() as session:
        engine = db.Engine(name="gate-engine")
        session.add(engine)
        session.flush()

        assets = [
            db.AudioAsset(
                id=MOS_ASSET_ID,
                original_filename="mos.wav",
                stored_filename="mos.wav",
                content_type="audio/wav",
                size_bytes=len(MOS_BYTES),
                sha256="0" * 64,
                engine_id=engine.id,
                reference_transcription="halo dunia",
                status="active",
            ),
            db.AudioAsset(
                id=SUS_ASSET_ID,
                original_filename="sus.wav",
                stored_filename="sus.wav",
                content_type="audio/wav",
                size_bytes=len(SUS_BYTES),
                sha256="1" * 64,
                engine_id=engine.id,
                reference_transcription="halo dunia",
                status="active",
            ),
        ]
        if calibration:
            assets.append(
                db.AudioAsset(
                    id=CAL_ASSET_ID,
                    original_filename="cal.wav",
                    stored_filename="cal.wav",
                    content_type="audio/wav",
                    size_bytes=len(CAL_BYTES),
                    sha256="2" * 64,
                    engine_id=engine.id,
                    status="active",
                )
            )
        session.add_all(assets)

        test = db.Test(
            name="Gate test",
            version=1,
            status="published",
            config_yaml=yaml.safe_dump(config, sort_keys=False),
            access_code="GATE01",
        )
        session.add(test)
        session.flush()

        respondent = db.RespondentSession(
            test_id=test.id,
            token=TOKEN,
            random_seed=1,
            consent_accepted=True,
            status="active",
        )
        session.add(respondent)
        session.flush()

        stimuli: dict[str, int] = {}
        stimulus_ids: list[int] = []
        for position, kind in enumerate(kinds):
            stimulus = db.TestStimulus(
                test_id=test.id,
                neutral_label=f"{kind.upper()}{position}",
                engine_id=engine.id,
                audio_ref=f"{kind}_a",
                kind=kind,
            )
            session.add(stimulus)
            session.flush()
            stimuli[kind] = stimulus.id
            stimulus_ids.append(stimulus.id)
            session.add(
                db.RespondentStimulusOrder(
                    session_id=respondent.id,
                    stimulus_id=stimulus.id,
                    position=position,
                )
            )
        session.commit()
        return {
            "test_id": test.id,
            "session_id": respondent.id,
            "stimuli": stimuli,
            "stimulus_ids": stimulus_ids,
        }


def _set_session_status(client, session_id: int, status: str) -> None:
    with client.app.state.session_factory() as session:
        record = session.get(db.RespondentSession, session_id)
        record.status = status
        session.commit()


def _authorize(client, stimulus_id: int):
    return client.post(
        "/api/sessions/sus/play-authorize",
        json={"token": TOKEN, "stimulus_id": stimulus_id},
    )


# --- S1: /api/media/stream gates -------------------------------------------------


def test_media_stream_serves_first_stimulus_full_content(fastapi_auth_client) -> None:
    client = fastapi_auth_client
    seeded = _seed(client)

    response = client.get(f"/api/media/stream/{TOKEN}/{seeded['stimuli']['mos']}")

    assert response.status_code == 200
    assert response.content == MOS_BYTES
    assert response.headers["accept-ranges"] == "bytes"


def test_media_stream_serves_range_request(fastapi_auth_client) -> None:
    client = fastapi_auth_client
    seeded = _seed(client)

    response = client.get(
        f"/api/media/stream/{TOKEN}/{seeded['stimuli']['mos']}",
        headers={"Range": "bytes=0-3"},
    )

    assert response.status_code == 206
    assert response.content == b"RIFF"
    assert response.headers["content-range"] == f"bytes 0-3/{len(MOS_BYTES)}"


def test_media_stream_head_request_has_no_body(fastapi_auth_client) -> None:
    client = fastapi_auth_client
    seeded = _seed(client)

    response = client.head(f"/api/media/stream/{TOKEN}/{seeded['stimuli']['mos']}")

    assert response.status_code == 200
    assert response.content == b""
    assert response.headers["content-length"] == str(len(MOS_BYTES))


def test_media_stream_rejects_unknown_token(fastapi_auth_client) -> None:
    client = fastapi_auth_client
    seeded = _seed(client)

    response = client.get(f"/api/media/stream/{'z' * 64}/{seeded['stimuli']['mos']}")

    assert response.status_code == 400
    assert response.json() == {"error": "Invalid session token"}


def test_media_stream_rejects_stimulus_outside_session(fastapi_auth_client) -> None:
    client = fastapi_auth_client
    _seed(client)

    response = client.get(f"/api/media/stream/{TOKEN}/999999")

    assert response.status_code == 404
    assert response.json() == {"error": "Stimulus not found in this session"}


def test_media_stream_enforces_presentation_order(fastapi_auth_client) -> None:
    """A later stimulus must not be served while an earlier one is unanswered."""
    client = fastapi_auth_client
    seeded = _seed(client)

    response = client.get(f"/api/media/stream/{TOKEN}/{seeded['stimuli']['sus']}")

    assert response.status_code == 403
    assert response.json() == {"error": "Stimulus not yet available"}


def test_media_stream_blocks_completed_session(fastapi_auth_client) -> None:
    client = fastapi_auth_client
    seeded = _seed(client)
    _set_session_status(client, seeded["session_id"], "completed")

    response = client.get(f"/api/media/stream/{TOKEN}/{seeded['stimuli']['mos']}")

    assert response.status_code == 400
    assert response.json() == {"error": "Session is already completed"}


def test_media_stream_blocks_unpublished_test(fastapi_auth_client) -> None:
    client = fastapi_auth_client
    seeded = _seed(client)
    with client.app.state.session_factory() as session:
        record = session.get(db.Test, seeded["test_id"])
        record.status = "draft"
        session.commit()

    response = client.get(f"/api/media/stream/{TOKEN}/{seeded['stimuli']['mos']}")

    assert response.status_code == 400
    assert response.json() == {"error": "Invalid session token"}


def test_media_stream_enforces_calibration_gate(fastapi_auth_client) -> None:
    client = fastapi_auth_client
    seeded = _seed(client, kinds=("mos",), calibration=True)

    response = client.get(f"/api/media/stream/{TOKEN}/{seeded['stimuli']['mos']}")

    assert response.status_code == 400
    assert response.json() == {"error": "Calibration required"}


def test_sus_stream_requires_play_authorization(fastapi_auth_client) -> None:
    client = fastapi_auth_client
    seeded = _seed(client, kinds=("sus",))

    response = client.get(f"/api/media/stream/{TOKEN}/{seeded['stimuli']['sus']}")

    assert response.status_code == 403
    assert response.json() == {"error": "Play authorization required"}


def test_sus_stream_consumes_authorization_once(fastapi_auth_client) -> None:
    client = fastapi_auth_client
    seeded = _seed(client, kinds=("sus",))
    sus_id = seeded["stimuli"]["sus"]

    authorization = _authorize(client, sus_id)
    assert authorization.status_code == 201
    authorization_id = authorization.json()["authorization_id"]

    first = client.get(f"/api/media/stream/{TOKEN}/{sus_id}")
    assert first.status_code == 200
    assert first.content == SUS_BYTES

    with client.app.state.session_factory() as session:
        record = session.get(db.SUSPlayAuthorization, authorization_id)
        assert record.status == "consumed"
        assert record.consumed_at is not None

    replay = client.get(f"/api/media/stream/{TOKEN}/{sus_id}")
    assert replay.status_code == 403
    assert replay.json() == {"error": "Play authorization required"}


def test_play_authorization_respects_quota(fastapi_auth_client) -> None:
    client = fastapi_auth_client
    seeded = _seed(client, kinds=("sus",), quota=2)
    sus_id = seeded["stimuli"]["sus"]

    assert _authorize(client, sus_id).status_code == 201
    assert _authorize(client, sus_id).status_code == 201

    exceeded = _authorize(client, sus_id)

    assert exceeded.status_code == 429
    assert exceeded.json() == {"error": "SUS playback quota exceeded", "quota": 2}


def test_play_authorization_rejects_completed_session(fastapi_auth_client) -> None:
    client = fastapi_auth_client
    seeded = _seed(client, kinds=("sus",))
    _set_session_status(client, seeded["session_id"], "completed")

    response = _authorize(client, seeded["stimuli"]["sus"])

    assert response.status_code == 400
    assert response.json() == {"error": "Invalid or expired session token"}


def test_sus_response_rejects_reused_authorization(fastapi_auth_client) -> None:
    client = fastapi_auth_client
    # Two SUS stimuli so answering the first one does not complete the session
    # (a completed session is rejected earlier, which would mask this guard).
    seeded = _seed(client, kinds=("sus", "sus"))
    sus_id = seeded["stimulus_ids"][0]
    authorization_id = _authorize(client, sus_id).json()["authorization_id"]

    first = client.post(
        "/api/sessions/response",
        json={
            "token": TOKEN,
            "stimulus_id": sus_id,
            "transcription": "halo dunia",
            "authorization_id": authorization_id,
        },
    )
    assert first.status_code == 200, first.text

    replay = client.post(
        "/api/sessions/response",
        json={
            "token": TOKEN,
            "stimulus_id": sus_id,
            "transcription": "halo dunia",
            "authorization_id": authorization_id,
        },
    )

    assert replay.status_code == 400
    assert replay.json() == {"error": "Invalid or already used play authorization"}


def test_completed_session_rejects_further_responses(fastapi_auth_client) -> None:
    client = fastapi_auth_client
    seeded = _seed(client, kinds=("sus",))
    sus_id = seeded["stimuli"]["sus"]
    authorization_id = _authorize(client, sus_id).json()["authorization_id"]

    first = client.post(
        "/api/sessions/response",
        json={
            "token": TOKEN,
            "stimulus_id": sus_id,
            "transcription": "halo dunia",
            "authorization_id": authorization_id,
        },
    )
    assert first.status_code == 200, first.text

    with client.app.state.session_factory() as session:
        assert session.get(db.RespondentSession, seeded["session_id"]).status == "completed"

    replay = client.post(
        "/api/sessions/response",
        json={"token": TOKEN, "stimulus_id": sus_id, "transcription": "halo dunia"},
    )

    assert replay.status_code == 400
    assert replay.json() == {"error": "Session is already completed"}


# --- S2: rate limits ------------------------------------------------------------


def test_resolve_access_code_is_rate_limited(fastapi_auth_client) -> None:
    client = fastapi_auth_client
    payload = {"access_code": "NOPE01"}

    for attempt in range(10):
        assert client.post("/api/sessions/resolve", json=payload).status_code == 400, attempt

    limited = client.post("/api/sessions/resolve", json=payload)

    assert limited.status_code == 429
    assert limited.json() == {"error": "too many requests"}


def test_start_session_is_rate_limited(fastapi_auth_client) -> None:
    client = fastapi_auth_client
    payload = {"access_code": "NOPE01", "consent_accepted": True}

    for attempt in range(5):
        assert client.post("/api/sessions/start", json=payload).status_code == 400, attempt

    limited = client.post("/api/sessions/start", json=payload)

    assert limited.status_code == 429
    assert limited.json() == {"error": "too many requests"}


def test_resolve_rate_limit_does_not_block_start(fastapi_auth_client) -> None:
    """The two endpoints keep separate buckets."""
    client = fastapi_auth_client

    for _ in range(10):
        client.post("/api/sessions/resolve", json={"access_code": "NOPE01"})
    assert client.post("/api/sessions/resolve", json={"access_code": "NOPE01"}).status_code == 429

    started = client.post(
        "/api/sessions/start",
        json={"access_code": "NOPE01", "consent_accepted": True},
    )

    assert started.status_code == 400


# --- S3: login lockout ----------------------------------------------------------


def test_login_lockout_after_repeated_failures(fastapi_auth_client) -> None:
    client = fastapi_auth_client
    csrf = get_csrf(client)

    for attempt in range(MAX_LOGIN_FAILURES):
        response = client.post(
            "/admin/login",
            json={"username": "admin", "password": "wrong-password", "csrf_token": csrf},
        )
        assert response.status_code == 401, attempt

    blocked = client.post(
        "/admin/login",
        json={"username": "admin", "password": "secret123", "csrf_token": csrf},
    )

    assert blocked.status_code == 429
    assert blocked.json() == {"error": "too many failed login attempts"}


def test_login_lockout_ignores_forwarded_for_header(fastapi_auth_client) -> None:
    """Spoofing a new X-Forwarded-For per attempt must not reset the lockout."""
    client = fastapi_auth_client
    csrf = get_csrf(client)

    for attempt in range(MAX_LOGIN_FAILURES):
        response = client.post(
            "/admin/login",
            json={"username": "admin", "password": "wrong-password", "csrf_token": csrf},
            headers={"X-Forwarded-For": f"10.0.0.{attempt}"},
        )
        assert response.status_code == 401, attempt

    blocked = client.post(
        "/admin/login",
        json={"username": "admin", "password": "wrong-password", "csrf_token": csrf},
        headers={"X-Forwarded-For": "10.0.0.99"},
    )

    assert blocked.status_code == 429


def test_successful_login_clears_failure_counter(fastapi_auth_client) -> None:
    client = fastapi_auth_client
    csrf = get_csrf(client)

    for _ in range(MAX_LOGIN_FAILURES - 1):
        client.post(
            "/admin/login",
            json={"username": "admin", "password": "wrong-password", "csrf_token": csrf},
        )

    assert login(client, csrf).status_code == 200
    assert client.post("/admin/login", json={}).status_code in {400, 401}

    # Counter cleared: a fresh wrong attempt is a plain 401, not a 429.
    assert (
        client.post(
            "/admin/login",
            json={"username": "admin", "password": "wrong-password", "csrf_token": csrf},
        ).status_code
        == 401
    )


def test_public_audio_stream_endpoint_is_not_exposed(fastapi_auth_client) -> None:
    """Public audio streaming by test_id/audio_ref must not exist to prevent SUS quota bypass."""
    client = fastapi_auth_client
    seeded = _seed(client)

    response = client.get(f"/api/tests/{seeded['test_id']}/audio/sus_a/stream")
    assert response.status_code == 404
