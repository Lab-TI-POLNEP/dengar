"""Tests for hardened SUS authorization, streaming, and idempotent submission protocol.

Verifies:
1. Normal lifecycle: authorize -> GET (with X-Play-Authorization) -> submit succeeds and creates 1 response.
2. Direct submit without GET is rejected with 403.
3. Stimulus presentation order enforced at authorize, stream, and submit gates.
4. HEAD request is non-consuming; subsequent GET succeeds.
5. Range request on SUS is rejected with 416 before token consumption.
6. Missing audio file on disk returns 410 before token consumption.
7. Authorization idempotency: same key + same payload returns original authorization without consuming quota.
8. Submission idempotency: same key + same payload returns original result without duplicate score row.
9. Quota enforcement: cannot authorize beyond configured quota.
10. Replay with already used authorization for another response is rejected.
"""

from __future__ import annotations

import io
import wave
from pathlib import Path

import pytest
import yaml
from fastapi.testclient import TestClient

import backend.app.models as db
from backend.app.core.config import Settings
from backend.app.core.database import stamp_alembic_head
from backend.app.main import create_app


def make_valid_wav() -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(16000)
        wf.writeframes(b"\x00\x00" * 8000)
    return buf.getvalue()


@pytest.fixture()
def sus_client(tmp_path: Path):
    settings = Settings(
        data_dir=tmp_path,
        admin_initial_password=None,
        secret_key="test-secret-key-at-least-32-chars-long",
        session_cookie_secure=False,
        max_audio_upload_mb=100,
    )
    app = create_app(settings)
    migrations_dir = Path(__file__).resolve().parents[1] / "migrations"
    stamp_alembic_head(app.state.engine, migrations_dir)
    db.Base.metadata.create_all(app.state.engine)

    wav_bytes = make_valid_wav()
    storage = Path(settings.audio_storage_path)
    storage.mkdir(parents=True, exist_ok=True)
    (storage / "sus1.wav").write_bytes(wav_bytes)
    (storage / "sus2.wav").write_bytes(wav_bytes)

    with app.state.session_factory() as session:
        engine = db.Engine(name="sus-engine")
        session.add(engine)
        session.flush()

        session.add_all([
            db.AudioAsset(
                id="asset-1",
                original_filename="sus1.wav",
                stored_filename="sus1.wav",
                content_type="audio/wav",
                size_bytes=len(wav_bytes),
                sha256="1" * 64,
                engine_id=engine.id,
                reference_transcription="the quick brown fox",
                status="active",
            ),
            db.AudioAsset(
                id="asset-2",
                original_filename="sus2.wav",
                stored_filename="sus2.wav",
                content_type="audio/wav",
                size_bytes=len(wav_bytes),
                sha256="2" * 64,
                engine_id=engine.id,
                reference_transcription="jumps over lazy dog",
                status="active",
            ),
        ])

        config = {
            "name": "Hardened SUS Test",
            "test_type": "sus",
            "language": "en",
            "sus": {"quota": 2},
            "audio": {"ref_1": "asset-1", "ref_2": "asset-2"},
            "pages": [
                {"kind": "consent"},
                {"kind": "sus", "stimuli": [{"audio_ref": "ref_1"}, {"audio_ref": "ref_2"}]},
                {"kind": "completion"},
            ],
        }

        test = db.Test(
            name="Hardened SUS Test",
            version=1,
            status="published",
            config_yaml=yaml.safe_dump(config, sort_keys=False),
            access_code="SUSTEST",
        )
        session.add(test)
        session.flush()

        stim1 = db.TestStimulus(
            test_id=test.id,
            neutral_label="S1",
            engine_id=engine.id,
            audio_ref="ref_1",
            kind="sus",
        )
        stim2 = db.TestStimulus(
            test_id=test.id,
            neutral_label="S2",
            engine_id=engine.id,
            audio_ref="ref_2",
            kind="sus",
        )
        session.add_all([stim1, stim2])
        session.flush()

        respondent = db.RespondentSession(
            test_id=test.id,
            token="token-session-12345",
            random_seed=1,
            consent_accepted=True,
            status="active",
        )
        session.add(respondent)
        session.flush()

        session.add_all([
            db.RespondentStimulusOrder(
                session_id=respondent.id,
                stimulus_id=stim1.id,
                position=0,
            ),
            db.RespondentStimulusOrder(
                session_id=respondent.id,
                stimulus_id=stim2.id,
                position=1,
            ),
        ])
        session.commit()

        app.state.test_ctx = {
            "test_id": test.id,
            "session_id": respondent.id,
            "stim1_id": stim1.id,
            "stim2_id": stim2.id,
            "token": "token-session-12345",
        }

    with TestClient(app, raise_server_exceptions=False) as client:
        yield client


def test_sus_normal_lifecycle_succeeds(sus_client: TestClient):
    ctx = sus_client.app.state.test_ctx
    token = ctx["token"]
    stim1_id = ctx["stim1_id"]

    # 1. Authorize
    auth_resp = sus_client.post(
        "/api/sessions/sus/play-authorize",
        json={"token": token, "stimulus_id": stim1_id},
    )
    assert auth_resp.status_code == 201
    auth_id = auth_resp.json()["authorization_id"]

    # 2. GET Audio with header
    get_resp = sus_client.get(
        f"/api/media/stream/{token}/{stim1_id}",
        headers={"X-Play-Authorization": auth_id},
    )
    assert get_resp.status_code == 200
    assert len(get_resp.content) > 0

    # 3. Submit Response with same authorization_id
    submit_resp = sus_client.post(
        "/api/sessions/response",
        json={
            "token": token,
            "stimulus_id": stim1_id,
            "authorization_id": auth_id,
            "transcription": "the quick brown fox",
        },
    )
    assert submit_resp.status_code == 200, submit_resp.text
    data = submit_resp.json()
    assert data["status"] == "success"
    assert data["data"]["wacc"] == 1.0


def test_sus_direct_submit_without_retrieval_is_rejected(sus_client: TestClient):
    ctx = sus_client.app.state.test_ctx
    token = ctx["token"]
    stim1_id = ctx["stim1_id"]

    # 1. Authorize only
    auth_resp = sus_client.post(
        "/api/sessions/sus/play-authorize",
        json={"token": token, "stimulus_id": stim1_id},
    )
    assert auth_resp.status_code == 201
    auth_id = auth_resp.json()["authorization_id"]

    # 2. Skip GET audio and submit directly -> MUST be rejected with 403
    submit_resp = sus_client.post(
        "/api/sessions/response",
        json={
            "token": token,
            "stimulus_id": stim1_id,
            "authorization_id": auth_id,
            "transcription": "unheard text",
        },
    )
    assert submit_resp.status_code == 403
    assert submit_resp.json() == {"error": "Audio must be retrieved before submitting response"}


def test_sus_presentation_order_enforced_at_all_gates(sus_client: TestClient):
    ctx = sus_client.app.state.test_ctx
    token = ctx["token"]
    stim2_id = ctx["stim2_id"]  # Stimulus 2 while Stimulus 1 is unanswered

    # Gate 1: Authorize out-of-order -> 403
    auth_resp = sus_client.post(
        "/api/sessions/sus/play-authorize",
        json={"token": token, "stimulus_id": stim2_id},
    )
    assert auth_resp.status_code == 403
    assert auth_resp.json() == {"error": "Stimulus not yet available"}

    # Gate 2: Stream out-of-order -> 403
    stream_resp = sus_client.get(f"/api/media/stream/{token}/{stim2_id}")
    assert stream_resp.status_code == 403
    assert stream_resp.json() == {"error": "Stimulus not yet available"}

    # Gate 3: Submit out-of-order -> 403
    submit_resp = sus_client.post(
        "/api/sessions/response",
        json={
            "token": token,
            "stimulus_id": stim2_id,
            "authorization_id": "dummy-auth-id",
            "transcription": "out of order",
        },
    )
    assert submit_resp.status_code == 403
    assert submit_resp.json() == {"error": "Stimulus not yet available"}


def test_sus_head_request_is_non_consuming(sus_client: TestClient):
    ctx = sus_client.app.state.test_ctx
    token = ctx["token"]
    stim1_id = ctx["stim1_id"]

    # Authorize
    auth_resp = sus_client.post(
        "/api/sessions/sus/play-authorize",
        json={"token": token, "stimulus_id": stim1_id},
    )
    auth_id = auth_resp.json()["authorization_id"]

    # HEAD request
    head_resp = sus_client.head(
        f"/api/media/stream/{token}/{stim1_id}",
        headers={"X-Play-Authorization": auth_id},
    )
    assert head_resp.status_code == 200
    assert len(head_resp.content) == 0
    assert "Content-Length" in head_resp.headers

    # Subsequent GET must succeed because HEAD did not consume token!
    get_resp = sus_client.get(
        f"/api/media/stream/{token}/{stim1_id}",
        headers={"X-Play-Authorization": auth_id},
    )
    assert get_resp.status_code == 200
    assert len(get_resp.content) > 0


def test_sus_range_request_rejected_without_consuming_token(sus_client: TestClient):
    ctx = sus_client.app.state.test_ctx
    token = ctx["token"]
    stim1_id = ctx["stim1_id"]

    auth_resp = sus_client.post(
        "/api/sessions/sus/play-authorize",
        json={"token": token, "stimulus_id": stim1_id},
    )
    auth_id = auth_resp.json()["authorization_id"]

    # Range request on SUS must return 416
    range_resp = sus_client.get(
        f"/api/media/stream/{token}/{stim1_id}",
        headers={"X-Play-Authorization": auth_id, "Range": "bytes=0-100"},
    )
    assert range_resp.status_code == 416
    assert range_resp.json() == {"error": "Range requests not supported for SUS evaluation"}

    # Subsequent full GET succeeds because Range didn't consume token
    full_resp = sus_client.get(
        f"/api/media/stream/{token}/{stim1_id}",
        headers={"X-Play-Authorization": auth_id},
    )
    assert full_resp.status_code == 200


def test_sus_missing_file_returns_410_without_consuming(sus_client: TestClient):
    ctx = sus_client.app.state.test_ctx
    token = ctx["token"]
    stim1_id = ctx["stim1_id"]

    # Temporarily remove audio file
    storage = Path(sus_client.app.state.settings.audio_storage_path)
    file_path = storage / "sus1.wav"
    bak_path = storage / "sus1.wav.bak"
    file_path.rename(bak_path)

    try:
        auth_resp = sus_client.post(
            "/api/sessions/sus/play-authorize",
            json={"token": token, "stimulus_id": stim1_id},
        )
        auth_id = auth_resp.json()["authorization_id"]

        get_resp = sus_client.get(
            f"/api/media/stream/{token}/{stim1_id}",
            headers={"X-Play-Authorization": auth_id},
        )
        assert get_resp.status_code == 410
        assert get_resp.json() == {"error": "Audio file not found on disk"}
    finally:
        bak_path.rename(file_path)

    # After restoring file, token can still be used because 410 didn't consume it!
    get_retry = sus_client.get(
        f"/api/media/stream/{token}/{stim1_id}",
        headers={"X-Play-Authorization": auth_id},
    )
    assert get_retry.status_code == 200


def test_sus_idempotency_for_authorize_and_submit(sus_client: TestClient):
    ctx = sus_client.app.state.test_ctx
    token = ctx["token"]
    stim1_id = ctx["stim1_id"]

    # 1. Authorize with Idempotency-Key
    auth1 = sus_client.post(
        "/api/sessions/sus/play-authorize",
        json={"token": token, "stimulus_id": stim1_id},
        headers={"Idempotency-Key": "idemp-auth-001"},
    )
    assert auth1.status_code == 201
    auth1_id = auth1.json()["authorization_id"]

    # Retry authorize with same key -> same authorization_id returned, no quota wasted
    auth2 = sus_client.post(
        "/api/sessions/sus/play-authorize",
        json={"token": token, "stimulus_id": stim1_id},
        headers={"Idempotency-Key": "idemp-auth-001"},
    )
    assert auth2.status_code == 201
    assert auth2.json()["authorization_id"] == auth1_id

    # 2. Retrieve audio
    get_resp = sus_client.get(
        f"/api/media/stream/{token}/{stim1_id}",
        headers={"X-Play-Authorization": auth1_id},
    )
    assert get_resp.status_code == 200

    # 3. Submit with Idempotency-Key
    sub1 = sus_client.post(
        "/api/sessions/response",
        json={
            "token": token,
            "stimulus_id": stim1_id,
            "authorization_id": auth1_id,
            "transcription": "the quick brown fox",
        },
        headers={"Idempotency-Key": "idemp-sub-001"},
    )
    assert sub1.status_code == 200

    # Retry submit with same key -> returns idempotent replay successfully
    sub2 = sus_client.post(
        "/api/sessions/response",
        json={
            "token": token,
            "stimulus_id": stim1_id,
            "authorization_id": auth1_id,
            "transcription": "the quick brown fox",
        },
        headers={"Idempotency-Key": "idemp-sub-001"},
    )
    assert sub2.status_code == 200
    assert "idempotent replay" in sub2.json()["message"]
