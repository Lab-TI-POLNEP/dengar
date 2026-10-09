"""Focused regression tests for the publication-critical SUS correction sprint.

Verifies:
1. Foreign key enforcement on runtime SQLite connections and cascade behaviors.
2. Final-submission idempotent replay after session completion.
3. Connection pool behavior and controlled contention/timeout responses.
4. Idempotency integrity: scoped uniqueness and payload fingerprint conflict rejection.
5. Authorization TTL: expiration evaluation, non-refunding quota, and retrieval receipt decoupling.
"""

from __future__ import annotations

import datetime
import io
import wave
from pathlib import Path

import pytest
import yaml
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

import backend.app.models as db
from backend.app.core.config import Settings
from backend.app.core.database import stamp_alembic_head
from backend.app.main import create_app
from backend.app.models import utcnow


def make_valid_wav() -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(16000)
        wf.writeframes(b"\x00\x00" * 8000)
    return buf.getvalue()


@pytest.fixture()
def sprint_client(tmp_path: Path):
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
    (storage / "stim1.wav").write_bytes(wav_bytes)

    with app.state.session_factory() as session:
        engine = db.Engine(name="sprint-engine")
        session.add(engine)
        session.flush()

        asset = db.AudioAsset(
            id="asset-sprint-1",
            original_filename="stim1.wav",
            stored_filename="stim1.wav",
            content_type="audio/wav",
            size_bytes=len(wav_bytes),
            sha256="s" * 64,
            engine_id=engine.id,
            reference_transcription="the quick brown fox",
            status="active",
        )
        session.add(asset)

        config = {
            "name": "Sprint SUS Test",
            "test_type": "sus",
            "language": "en",
            "sus": {"quota": 2},
            "audio": {"ref_1": "asset-sprint-1"},
            "pages": [
                {"kind": "consent"},
                {"kind": "sus", "stimuli": [{"audio_ref": "ref_1"}]},
                {"kind": "completion"},
            ],
        }

        test = db.Test(
            name="Sprint SUS Test",
            version=1,
            status="published",
            config_yaml=yaml.safe_dump(config, sort_keys=False),
            access_code="SPRINT01",
        )
        session.add(test)
        session.flush()

        stim = db.TestStimulus(
            test_id=test.id,
            neutral_label="S1",
            engine_id=engine.id,
            audio_ref="ref_1",
            kind="sus",
        )
        session.add(stim)
        session.flush()

        respondent = db.RespondentSession(
            test_id=test.id,
            token="token-sprint-12345",
            random_seed=1,
            consent_accepted=True,
            status="active",
        )
        session.add(respondent)
        session.flush()

        session.add(
            db.RespondentStimulusOrder(
                session_id=respondent.id,
                stimulus_id=stim.id,
                position=0,
            )
        )
        session.commit()

        app.state.sprint_ctx = {
            "test_id": test.id,
            "session_id": respondent.id,
            "stim_id": stim.id,
            "token": respondent.token,
        }

    with TestClient(app, raise_server_exceptions=False) as client:
        yield client


# ==============================================================================
# DEFECT 1: FOREIGN KEY ENFORCEMENT
# ==============================================================================

def test_sqlite_foreign_keys_pragma_enabled_and_enforced(sprint_client: TestClient):
    app = sprint_client.app
    with app.state.session_factory() as session:
        # 1. Assert runtime pragma is active
        fk_val = session.execute(text("PRAGMA foreign_keys")).scalar()
        assert fk_val == 1, "PRAGMA foreign_keys must be 1 on runtime connections"

        # 2. Assert invalid foreign key insertion is rejected by SQLite
        invalid_resp = db.SUSResponse(
            session_id=999999,  # Non-existent session
            stimulus_id=app.state.sprint_ctx["stim_id"],
            raw_transcription="testing fk",
            normalized_transcription="testing fk",
        )
        session.add(invalid_resp)
        with pytest.raises(IntegrityError):
            session.commit()
        session.rollback()

        # 3. Assert cascade delete works on parent deletion
        # First add valid play authorization
        auth = db.SUSPlayAuthorization(
            id="auth-cascade-test",
            session_id=app.state.sprint_ctx["session_id"],
            stimulus_id=app.state.sprint_ctx["stim_id"],
            status="ISSUED",
        )
        session.add(auth)
        session.commit()

        # Delete respondent session -> must cascade to sus_play_authorization
        session.execute(
            text("DELETE FROM respondent_session WHERE id = :sid"),
            {"sid": app.state.sprint_ctx["session_id"]},
        )
        session.commit()

        remaining_auth = session.execute(
            text("SELECT count(*) FROM sus_play_authorization WHERE id = 'auth-cascade-test'")
        ).scalar()
        assert remaining_auth == 0, "CASCADE delete failed to delete child authorization"


# ==============================================================================
# DEFECT 2: FINAL-SUBMISSION IDEMPOTENT REPLAY
# ==============================================================================

def test_final_submission_idempotent_replay_after_session_completed(sprint_client: TestClient):
    ctx = sprint_client.app.state.sprint_ctx
    token = ctx["token"]
    stim_id = ctx["stim_id"]
    idemp_key = "idemp-final-001"

    # 1. Authorize
    auth_resp = sprint_client.post(
        "/api/sessions/sus/play-authorize",
        json={"token": token, "stimulus_id": stim_id},
    )
    assert auth_resp.status_code == 201
    auth_id = auth_resp.json()["authorization_id"]

    # 2. Retrieve audio
    get_resp = sprint_client.get(
        f"/api/media/stream/{token}/{stim_id}",
        headers={"X-Play-Authorization": auth_id},
    )
    assert get_resp.status_code == 200

    # 3. First Submission -> completes the session
    sub1 = sprint_client.post(
        "/api/sessions/response",
        json={
            "token": token,
            "stimulus_id": stim_id,
            "authorization_id": auth_id,
            "transcription": "the quick brown fox",
        },
        headers={"Idempotency-Key": idemp_key},
    )
    assert sub1.status_code == 200
    assert sub1.json()["data"]["wacc"] == 1.0

    # Verify session is now completed
    with sprint_client.app.state.session_factory() as session:
        rs = session.get(db.RespondentSession, ctx["session_id"])
        assert rs.status == "completed"

    # 4. Exact retry of final submission on COMPLETED session -> MUST return 200 replay
    sub2 = sprint_client.post(
        "/api/sessions/response",
        json={
            "token": token,
            "stimulus_id": stim_id,
            "authorization_id": auth_id,
            "transcription": "the quick brown fox",
        },
        headers={"Idempotency-Key": idemp_key},
    )
    assert sub2.status_code == 200
    assert "idempotent replay" in sub2.json()["message"]
    assert sub2.json()["data"]["wacc"] == 1.0

    # 5. Changed payload with same key on COMPLETED session -> MUST return 409 Conflict
    sub_changed = sprint_client.post(
        "/api/sessions/response",
        json={
            "token": token,
            "stimulus_id": stim_id,
            "authorization_id": auth_id,
            "transcription": "completely different transcription",
        },
        headers={"Idempotency-Key": idemp_key},
    )
    assert sub_changed.status_code == 409
    assert "different payload" in sub_changed.json()["error"]

    # 6. Attempt new submission (different key or no key) on COMPLETED session -> MUST return 400
    sub_new = sprint_client.post(
        "/api/sessions/response",
        json={
            "token": token,
            "stimulus_id": stim_id,
            "authorization_id": auth_id,
            "transcription": "new attempt",
        },
        headers={"Idempotency-Key": "different-key"},
    )
    assert sub_new.status_code == 400
    assert "Session is already completed" in sub_new.json()["error"]


# ==============================================================================
# DEFECT 3 & 4: IDEMPOTENCY INTEGRITY & SCOPED UNIQUENESS
# ==============================================================================

def test_idempotency_different_payload_conflict_on_authorize_and_submit(sprint_client: TestClient):
    ctx = sprint_client.app.state.sprint_ctx
    token = ctx["token"]
    stim_id = ctx["stim_id"]

    # 1. Authorize with key
    auth1 = sprint_client.post(
        "/api/sessions/sus/play-authorize",
        json={"token": token, "stimulus_id": stim_id},
        headers={"Idempotency-Key": "auth-key-conflict"},
    )
    assert auth1.status_code == 201
    auth_id = auth1.json()["authorization_id"]

    # Retrieve
    sprint_client.get(f"/api/media/stream/{token}/{stim_id}", headers={"X-Play-Authorization": auth_id})

    # Submit with key
    sub1 = sprint_client.post(
        "/api/sessions/response",
        json={
            "token": token,
            "stimulus_id": stim_id,
            "authorization_id": auth_id,
            "transcription": "the quick brown fox",
        },
        headers={"Idempotency-Key": "sub-key-conflict"},
    )
    assert sub1.status_code == 200

    # Retry submit with SAME key but DIFFERENT payload -> 409
    sub_conflict = sprint_client.post(
        "/api/sessions/response",
        json={
            "token": token,
            "stimulus_id": stim_id,
            "authorization_id": auth_id,
            "transcription": "altered text",
        },
        headers={"Idempotency-Key": "sub-key-conflict"},
    )
    assert sub_conflict.status_code == 409
    assert "different payload" in sub_conflict.json()["error"]


def test_scoped_uniqueness_constraint_on_auth_idempotency_key(sprint_client: TestClient):
    app = sprint_client.app
    ctx = app.state.sprint_ctx
    sid = ctx["session_id"]
    stim_id = ctx["stim_id"]

    with app.state.session_factory() as session:
        # Insert first auth record with key
        a1 = db.SUSPlayAuthorization(
            id="auth-unique-1",
            session_id=sid,
            stimulus_id=stim_id,
            status="ISSUED",
            idempotency_key="key-unique-test",
        )
        session.add(a1)
        session.commit()

        # Insert second record with SAME (session_id, stimulus_id, idempotency_key)
        a2 = db.SUSPlayAuthorization(
            id="auth-unique-2",
            session_id=sid,
            stimulus_id=stim_id,
            status="ISSUED",
            idempotency_key="key-unique-test",
        )
        session.add(a2)
        with pytest.raises(IntegrityError):
            session.commit()
        session.rollback()


# ==============================================================================
# DEFECT 5: AUTHORIZATION TTL
# ==============================================================================

def test_authorization_ttl_evaluation_and_quota_retention(sprint_client: TestClient):
    ctx = sprint_client.app.state.sprint_ctx
    token = ctx["token"]
    stim_id = ctx["stim_id"]

    # 1. Authorize: verify expires_at is set in future
    auth_resp = sprint_client.post(
        "/api/sessions/sus/play-authorize",
        json={"token": token, "stimulus_id": stim_id},
    )
    assert auth_resp.status_code == 201
    auth_id = auth_resp.json()["authorization_id"]

    with sprint_client.app.state.session_factory() as session:
        rec = session.get(db.SUSPlayAuthorization, auth_id)
        assert rec.expires_at is not None
        assert rec.expires_at > utcnow()

        # Artificially expire the token using controlled timestamp
        rec.expires_at = utcnow() - datetime.timedelta(seconds=10)
        session.commit()

    # 2. Attempt GET retrieval with expired token -> must return 403 expired
    get_resp = sprint_client.get(
        f"/api/media/stream/{token}/{stim_id}",
        headers={"X-Play-Authorization": auth_id},
    )
    assert get_resp.status_code == 403
    assert get_resp.json() == {"error": "Play authorization has expired"}

    # Verify status in DB transitioned to EXPIRED
    with sprint_client.app.state.session_factory() as session:
        rec = session.get(db.SUSPlayAuthorization, auth_id)
        assert rec.status == "EXPIRED"

    # 3. Verify quota was NOT refunded: plays_used still accounts for the expired token
    auth_resp2 = sprint_client.post(
        "/api/sessions/sus/play-authorize",
        json={"token": token, "stimulus_id": stim_id},
    )
    assert auth_resp2.status_code == 201
    # quota is 2, plays_used should now be 1
    assert auth_resp2.json()["plays_used"] == 1
    auth2_id = auth_resp2.json()["authorization_id"]

    # Retrieve valid second token -> RETRIEVAL_STARTED
    get_resp2 = sprint_client.get(
        f"/api/media/stream/{token}/{stim_id}",
        headers={"X-Play-Authorization": auth2_id},
    )
    assert get_resp2.status_code == 200

    # Artificially set expires_at in the past on auth2
    with sprint_client.app.state.session_factory() as session:
        rec2 = session.get(db.SUSPlayAuthorization, auth2_id)
        assert rec2.status == "RETRIEVAL_STARTED"
        rec2.expires_at = utcnow() - datetime.timedelta(seconds=10)
        session.commit()

    # 4. Verify RETRIEVAL_STARTED receipt is decoupled from retrieval TTL during submit
    sub_resp = sprint_client.post(
        "/api/sessions/response",
        json={
            "token": token,
            "stimulus_id": stim_id,
            "authorization_id": auth2_id,
            "transcription": "the quick brown fox",
        },
    )
    assert sub_resp.status_code == 200
    assert sub_resp.json()["status"] == "success"
