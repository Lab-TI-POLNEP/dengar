"""SUS authorization, retrieval claim, and idempotent response submission service.

Implements normative protocol requirements from ADR 001:
- State separation: ISSUED -> RETRIEVAL_STARTED -> SUBMITTED.
- SQLite concurrency protection with BEGIN IMMEDIATE and SQLITE_BUSY handling.
- Uniform presentation order enforcement (first unanswered stimulus) across all gates.
- Idempotency support for authorization and response submission.
- Atomic CAS state transitions.
"""

from __future__ import annotations

import datetime
import hashlib
import logging
import secrets
from pathlib import Path
from typing import Any

from sqlalchemy import func, select, text, update
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session

from ..models import (
    AudioAsset,
    MOSResponse,
    RespondentSession,
    RespondentStimulusOrder,
    SUSPlayAuthorization,
    SUSResponse,
    utcnow,
)
from .config_service import parse_config
from .scoring import compute_word_stats, normalize_text

logger = logging.getLogger("dengar.sus")

DEFAULT_SUS_PLAY_AUTH_TTL_SECONDS = 600


class StorageContentionError(Exception):
    """Raised when SQLite storage contention (SQLITE_BUSY/locked) occurs."""
    pass


def _get(obj: Any, key: str, default: Any = None) -> Any:
    if isinstance(obj, dict):
        return obj.get(key, default)
    if hasattr(obj, "__getitem__"):
        try:
            return obj[key]
        except (KeyError, TypeError):
            pass
    return getattr(obj, key, default)


def acquire_sqlite_write_lock(session: Session) -> None:
    """Acquire BEGIN IMMEDIATE write lock on SQLite before check-and-insert."""
    bind = session.get_bind()
    if bind and bind.dialect.name == "sqlite":
        try:
            session.connection().execute(text("BEGIN IMMEDIATE"))
        except OperationalError as exc:
            msg = str(exc).lower()
            if "busy" in msg or "locked" in msg:
                raise StorageContentionError("Database contention, please retry") from exc
            if "cannot start a transaction within a transaction" not in msg:
                raise


def get_first_unanswered_stimulus_id(session: Session, session_id: int) -> int | None:
    """Recompute server-side first unanswered stimulus in presentation order."""
    orders = session.execute(
        select(RespondentStimulusOrder.stimulus_id)
        .where(RespondentStimulusOrder.session_id == session_id)
        .order_by(RespondentStimulusOrder.position.asc())
    ).scalars().all()

    if not orders:
        return None

    answered_mos = set(
        session.execute(
            select(MOSResponse.stimulus_id).where(MOSResponse.session_id == session_id)
        ).scalars().all()
    )
    answered_sus = set(
        session.execute(
            select(SUSResponse.stimulus_id).where(SUSResponse.session_id == session_id)
        ).scalars().all()
    )
    answered = answered_mos | answered_sus

    for stim_id in orders:
        if stim_id not in answered:
            return stim_id
    return None


def is_first_unanswered(session: Session, session_id: int, stimulus_id: int) -> bool:
    """Verify if stimulus_id is the next unanswered stimulus in presentation order."""
    first_id = get_first_unanswered_stimulus_id(session, session_id)
    return first_id == stimulus_id


def authorize_sus_playback(
    session: Session,
    rs: Any,
    test: Any,
    stimulus_id: int,
    idempotency_key: str | None = None,
) -> tuple[int, dict[str, Any]]:
    """Authorize a single playback allowance for a SUS stimulus.
    
    Enforces active session, calibration, stimulus kind, and first unanswered order.
    Acquires BEGIN IMMEDIATE to guarantee atomic quota check-and-insert.
    """
    session_id = _get(rs, "id")
    calibration_completed = _get(rs, "calibration_completed", False)
    config_yaml = _get(test, "config_yaml", "")

    config = parse_config(config_yaml)
    calibration_audio_ref = config.get("calibration_audio_ref")
    if (
        isinstance(calibration_audio_ref, str)
        and calibration_audio_ref in config.get("audio", {})
        and not calibration_completed
    ):
        return 400, {"error": "Calibration required"}

    # Verify presentation order
    if not is_first_unanswered(session, session_id, stimulus_id):
        return 403, {"error": "Stimulus not yet available"}

    quota = config.get("sus", {}).get("quota", 2)
    if not isinstance(quota, int) or quota < 1:
        return 500, {"error": "Invalid SUS quota configuration"}

    # Acquire SQLite write transaction BEFORE checking idempotency or quota
    acquire_sqlite_write_lock(session)

    req_hash = hashlib.sha256(f"{session_id}:{stimulus_id}".encode("utf-8")).hexdigest()

    # Check idempotency under write lock
    if idempotency_key:
        existing = session.execute(
            select(SUSPlayAuthorization).where(
                SUSPlayAuthorization.session_id == session_id,
                SUSPlayAuthorization.stimulus_id == stimulus_id,
                SUSPlayAuthorization.idempotency_key == idempotency_key,
            )
        ).scalar_one_or_none()
        if existing:
            if existing.request_hash and existing.request_hash != req_hash:
                return 409, {"error": "Idempotency key already used with different payload"}
            used_count = session.execute(
                select(func.count(SUSPlayAuthorization.id)).where(
                    SUSPlayAuthorization.session_id == session_id,
                    SUSPlayAuthorization.stimulus_id == stimulus_id,
                )
            ).scalar() or 0
            return 201, {
                "authorization_id": existing.id,
                "quota": quota,
                "plays_used": max(0, used_count - 1),
            }

    # Check quota under write lock
    used = session.execute(
        select(func.count(SUSPlayAuthorization.id)).where(
            SUSPlayAuthorization.session_id == session_id,
            SUSPlayAuthorization.stimulus_id == stimulus_id,
        )
    ).scalar() or 0

    if used >= quota:
        return 429, {"error": "SUS playback quota exceeded", "quota": quota}

    authorization_id = secrets.token_urlsafe(32)
    now = utcnow()
    expires_at = now + datetime.timedelta(seconds=DEFAULT_SUS_PLAY_AUTH_TTL_SECONDS)
    auth_record = SUSPlayAuthorization(
        id=authorization_id,
        session_id=session_id,
        stimulus_id=stimulus_id,
        status="ISSUED",
        idempotency_key=idempotency_key,
        request_hash=req_hash,
        expires_at=expires_at,
        created_at=now,
    )
    session.add(auth_record)
    session.flush()

    return 201, {
        "authorization_id": authorization_id,
        "quota": quota,
        "plays_used": used,
    }


def preflight_sus_retrieval(
    session: Session,
    rs: Any,
    test: Any,
    stimulus: Any,
    storage_dir: Path,
    authorization_id: str | None = None,
) -> tuple[int, dict[str, Any], Path | None, str | None, str | None, str | None]:
    """Validate asset presence, file existence, and authorization eligibility before claim.
    
    Returns: (status_code, error_dict, file_path, content_type, stored_filename, resolved_auth_id)
    """
    session_id = _get(rs, "id")
    calibration_completed = _get(rs, "calibration_completed", False)
    stimulus_id = _get(stimulus, "id")
    audio_ref = _get(stimulus, "audio_ref")
    config_yaml = _get(test, "config_yaml", "")

    config = parse_config(config_yaml)
    calibration_audio_ref = config.get("calibration_audio_ref")
    if (
        isinstance(calibration_audio_ref, str)
        and calibration_audio_ref in config.get("audio", {})
        and not calibration_completed
    ):
        return 400, {"error": "Calibration required"}, None, None, None, None

    # Verify presentation order
    if not is_first_unanswered(session, session_id, stimulus_id):
        return 403, {"error": "Stimulus not yet available"}, None, None, None, None

    # Check asset mapping
    audio_map = config.get("audio", {})
    asset_id = audio_map.get(audio_ref)
    if not asset_id:
        return 404, {"error": "Audio asset mapping not found"}, None, None, None, None

    asset = session.execute(
        select(AudioAsset).where(AudioAsset.id == asset_id)
    ).scalar_one_or_none()
    if not asset or asset.status != "active":
        return 404, {"error": "Audio asset not found or inactive"}, None, None, None, None

    stored_filename = asset.stored_filename
    content_type = asset.content_type
    target_path = (storage_dir / stored_filename).resolve()

    # Preflight physical file existence BEFORE claiming authorization
    if not target_path.exists() or not target_path.is_file():
        return 410, {"error": "Audio file not found on disk"}, None, None, None, None

    # Resolve authorization
    now = utcnow()
    if authorization_id:
        auth_record = session.execute(
            select(SUSPlayAuthorization).where(
                SUSPlayAuthorization.id == authorization_id,
                SUSPlayAuthorization.session_id == session_id,
                SUSPlayAuthorization.stimulus_id == stimulus_id,
            )
        ).scalar_one_or_none()
        if not auth_record:
            return 403, {"error": "Play authorization required"}, None, None, None, None
        if auth_record.status not in ("ISSUED", "authorized"):
            if auth_record.status == "EXPIRED":
                return 403, {"error": "Play authorization has expired"}, None, None, None, None
            return 403, {"error": "Play authorization already used"}, None, None, None, None
        if auth_record.expires_at is not None and auth_record.expires_at < now:
            auth_record.status = "EXPIRED"
            session.commit()
            return 403, {"error": "Play authorization has expired"}, None, None, None, None
        resolved_auth_id = auth_record.id
    else:
        # Fallback to single active ISSUED authorization for backward compatibility
        pending = session.execute(
            select(SUSPlayAuthorization).where(
                SUSPlayAuthorization.session_id == session_id,
                SUSPlayAuthorization.stimulus_id == stimulus_id,
                SUSPlayAuthorization.status.in_(["ISSUED", "authorized"]),
            ).order_by(SUSPlayAuthorization.created_at.asc())
        ).scalars().all()
        if not pending:
            return 403, {"error": "Play authorization required"}, None, None, None, None
        candidate = pending[0]
        if candidate.expires_at is not None and candidate.expires_at < now:
            candidate.status = "EXPIRED"
            session.commit()
            return 403, {"error": "Play authorization has expired"}, None, None, None, None
        resolved_auth_id = candidate.id

    return 200, {}, target_path, content_type, stored_filename, resolved_auth_id


def claim_sus_retrieval(
    session: Session,
    authorization_id: str,
    session_id: int,
    stimulus_id: int,
) -> bool:
    """Atomically transition authorization state ISSUED -> RETRIEVAL_STARTED via CAS."""
    result = session.execute(
        update(SUSPlayAuthorization)
        .where(
            SUSPlayAuthorization.id == authorization_id,
            SUSPlayAuthorization.session_id == session_id,
            SUSPlayAuthorization.stimulus_id == stimulus_id,
            SUSPlayAuthorization.status.in_(["ISSUED", "authorized"]),
        )
        .values(
            status="RETRIEVAL_STARTED",
            consumed_at=utcnow(),
        )
    )
    return result.rowcount == 1


def submit_sus_response(
    session: Session,
    rs: Any,
    test: Any,
    stimulus: Any,
    authorization_id: str,
    raw_transcription: str,
    idempotency_key: str | None = None,
) -> tuple[int, dict[str, Any]]:
    """Submit transcription response for a SUS stimulus.
    
    Requires an authorization receipt in RETRIEVAL_STARTED state.
    Does NOT consume additional playback quota.
    Enforces presentation order and idempotency.
    """
    session_id = _get(rs, "id")
    calibration_completed = _get(rs, "calibration_completed", False)
    stimulus_id = _get(stimulus, "id")
    audio_ref = _get(stimulus, "audio_ref")
    config_yaml = _get(test, "config_yaml", "")

    config = parse_config(config_yaml)
    calibration_audio_ref = config.get("calibration_audio_ref")
    if (
        isinstance(calibration_audio_ref, str)
        and calibration_audio_ref in config.get("audio", {})
        and not calibration_completed
    ):
        return 400, {"error": "Calibration required"}

    # Acquire write lock for atomic response check and submission
    acquire_sqlite_write_lock(session)

    cleaned_hypothesis = str(raw_transcription or "").strip()
    req_fingerprint = hashlib.sha256(
        f"{stimulus_id}:{authorization_id}:{cleaned_hypothesis}".encode("utf-8")
    ).hexdigest()

    # Replay check for idempotency
    if idempotency_key:
        existing_resp = session.execute(
            select(SUSResponse).where(
                SUSResponse.session_id == session_id,
                SUSResponse.stimulus_id == stimulus_id,
                SUSResponse.idempotency_key == idempotency_key,
            )
        ).scalar_one_or_none()
        if existing_resp:
            if existing_resp.request_hash and existing_resp.request_hash != req_fingerprint:
                return 409, {"error": "Idempotency key already used with different payload"}
            return 200, {
                "status": "success",
                "message": "Response saved (idempotent replay)",
                "data": {
                    "wacc": existing_resp.wacc,
                    "substitutions": existing_resp.substitutions,
                    "deletions": existing_resp.deletions,
                    "insertions": existing_resp.insertions,
                },
            }

    # Verify not already answered
    existing_any = session.execute(
        select(SUSResponse).where(
            SUSResponse.session_id == session_id,
            SUSResponse.stimulus_id == stimulus_id,
        )
    ).scalar_one_or_none()
    if existing_any:
        return 409, {"error": "Response already submitted for this stimulus"}

    # Verify presentation order
    if not is_first_unanswered(session, session_id, stimulus_id):
        return 403, {"error": "Stimulus not yet available"}

    # Validate authorization receipt
    auth_record = session.execute(
        select(SUSPlayAuthorization).where(
            SUSPlayAuthorization.id == authorization_id,
            SUSPlayAuthorization.session_id == session_id,
            SUSPlayAuthorization.stimulus_id == stimulus_id,
        )
    ).scalar_one_or_none()

    if not auth_record:
        return 400, {"error": "Invalid or already used play authorization"}

    # Direct submission without audio retrieval MUST be rejected
    if auth_record.status in ("ISSUED", "authorized"):
        return 403, {"error": "Audio must be retrieved before submitting response"}

    if auth_record.status not in ("RETRIEVAL_STARTED", "consumed"):
        return 400, {"error": "Invalid or already used play authorization"}

    # Count prior plays for audit
    prior_plays = session.execute(
        select(func.count(SUSPlayAuthorization.id)).where(
            SUSPlayAuthorization.session_id == session_id,
            SUSPlayAuthorization.stimulus_id == stimulus_id,
            SUSPlayAuthorization.status.in_(["RETRIEVAL_STARTED", "consumed"]),
        )
    ).scalar() or 1

    # Fetch reference transcription
    audio_map = config.get("audio", {})
    asset_id = audio_map.get(audio_ref)
    ref_text = ""
    if asset_id:
        asset = session.execute(
            select(AudioAsset).where(AudioAsset.id == asset_id)
        ).scalar_one_or_none()
        if asset:
            ref_text = asset.reference_transcription or ""

    language = config.get("language", "id")
    cleaned_hypothesis = str(raw_transcription or "").strip()
    norm_hyp = normalize_text(cleaned_hypothesis, language=language)
    norm_ref = normalize_text(ref_text, language=language)

    stats = compute_word_stats(norm_ref, norm_hyp, language=language)

    sus_response = SUSResponse(
        session_id=session_id,
        stimulus_id=stimulus_id,
        raw_transcription=cleaned_hypothesis,
        normalized_transcription=norm_hyp,
        wacc=stats["wacc"],
        substitutions=stats["substitutions"],
        deletions=stats["deletions"],
        insertions=stats["insertions"],
        play_count=prior_plays,
        authorization_id=authorization_id,
        idempotency_key=idempotency_key,
        request_hash=req_fingerprint,
        created_at=utcnow(),
    )
    session.add(sus_response)
    session.flush()

    # Advance session progression: check if all stimuli answered
    total_stimuli = session.execute(
        select(func.count(RespondentStimulusOrder.stimulus_id)).where(
            RespondentStimulusOrder.session_id == session_id
        )
    ).scalar() or 0

    answered_count = (
        (session.execute(
            select(func.count(MOSResponse.id)).where(MOSResponse.session_id == session_id)
        ).scalar() or 0)
        + (session.execute(
            select(func.count(SUSResponse.id)).where(SUSResponse.session_id == session_id)
        ).scalar() or 0)
    )

    if total_stimuli > 0 and answered_count >= total_stimuli:
        session.execute(
            update(RespondentSession)
            .where(RespondentSession.id == session_id)
            .values(status="completed", completed_at=utcnow())
        )

    return 200, {
        "status": "success",
        "message": "Response saved",
        "data": {
            "wacc": stats["wacc"],
            "substitutions": stats["substitutions"],
            "deletions": stats["deletions"],
            "insertions": stats["insertions"],
        },
    }
