from __future__ import annotations

import json
import logging
import random
import secrets
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from sqlalchemy import MetaData, Table, func, select, update
from sqlalchemy.exc import SQLAlchemyError

from ..core.security import rate_limited
from ..services.config_service import ConfigValidationError, parse_config
from ..services.media_service import resolve_stored_path, stream_media_file
from ..services.scoring import compute_word_stats, normalize_text

router = APIRouter(prefix="/api")

logger = logging.getLogger("dengar.api.respondent")

_INVALID_CODE = {"error": "Invalid or expired access code"}
_INVALID_SESSION = {"error": "Invalid or expired session token"}


def utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _table(session, name: str) -> Table:
    return Table(name, MetaData(), autoload_with=session.bind)


def _options(value: str | None) -> list[Any]:
    if not value:
        return []
    try:
        parsed = json.loads(value)
    except (TypeError, ValueError):
        return []
    return parsed


async def _json_payload(request: Request) -> dict[str, Any]:
    content_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    if content_type != "application/json" and not content_type.endswith("+json"):
        return {}
    try:
        payload = await request.json()
    except (ValueError, UnicodeDecodeError):
        return {}
    return payload if isinstance(payload, dict) else {}


def serialize_public_test(record: dict[str, Any]) -> dict[str, Any]:
    from yaml import YAMLError, safe_load

    try:
        config = safe_load(record.get("config_yaml") or "")
    except YAMLError:
        config = None
    safe_config = None
    if isinstance(config, dict):
        safe_config = dict(config)
        # Protect stimulus audio references: audio is only served through
        # active respondent sessions at /api/media/stream/{token}/{stimulus_id}
        safe_config.pop("audio", None)
    return {
        "id": record["id"],
        "name": record["name"],
        "version": record["version"],
        "status": record["status"],
        "config": safe_config,
    }


@router.get("/tests")
async def list_public_tests(request: Request):
    try:
        with request.app.state.session_factory() as session:
            tests = _table(session, "test")
            records = session.execute(
                select(tests).where(tests.c.status == "published").order_by(tests.c.created_at.desc())
            ).mappings().all()
            items = [
                {"id": record["id"], "name": record["name"], "version": record["version"], "status": record["status"]}
                for record in records
            ]
        return JSONResponse({"items": items})
    except SQLAlchemyError:
        return JSONResponse({"error": "internal server error"}, status_code=500)


@router.get("/tests/{test_id}")
async def public_test_detail(request: Request, test_id: int):
    try:
        with request.app.state.session_factory() as session:
            tests = _table(session, "test")
            record = session.execute(
                select(tests).where(tests.c.id == test_id)
            ).mappings().first()
            if record is None or record["status"] != "published":
                return JSONResponse({"error": "test not found"}, status_code=404)
            return JSONResponse(serialize_public_test(dict(record)))
    except SQLAlchemyError:
        return JSONResponse({"error": "internal server error"}, status_code=500)


@router.post("/sessions/resolve")
async def resolve_access_code(request: Request):
    payload = await _json_payload(request)
    code_raw = payload.get("access_code") or ""
    if not isinstance(code_raw, str):
        return JSONResponse(_INVALID_CODE, status_code=400)

    code = code_raw.strip().upper()
    if not code:
        return JSONResponse(_INVALID_CODE, status_code=400)

    # Rate limit access code resolution to 10 req/min per client
    key = f"resolve:{request.client.host if request.client else 'unknown'}"
    if rate_limited(key, 10, 60.0):
        return JSONResponse({"error": "too many requests"}, status_code=429)

    try:
        with request.app.state.session_factory() as session:
            tests = _table(session, "test")
            test = session.execute(
                select(tests).where(
                    tests.c.access_code == code,
                    tests.c.status == "published",
                )
            ).mappings().first()
            if test is None:
                return JSONResponse(_INVALID_CODE, status_code=400)

            templates = _table(session, "text_template")
            template = session.execute(
                select(templates)
                .where(templates.c.kind == "consent")
                .order_by(templates.c.version.desc())
            ).mappings().first()
            consent_text = template["content"] if template else "No consent template available."

            definitions = _table(session, "demographic_field_def")
            links = _table(session, "test_demographic_field")
            demo_fields = session.execute(
                select(definitions)
                .join(links, links.c.field_key == definitions.c.key)
                .where(links.c.test_id == test["id"])
                .order_by(definitions.c.id)
            ).mappings().all()

            normal_hearing = session.execute(
                select(definitions).where(definitions.c.key == "normal_hearing")
            ).mappings().first()
            serialized_fields: list[dict[str, Any]] = []
            if normal_hearing is not None and not any(
                field["key"] == "normal_hearing" for field in demo_fields
            ):
                serialized_fields.append(
                    {
                        "key": normal_hearing["key"],
                        "label": normal_hearing["label"],
                        "field_type": normal_hearing["field_type"],
                        "required": True,
                        "options": _options(normal_hearing["options_json"]),
                    }
                )

            for field in demo_fields:
                serialized_fields.append(
                    {
                        "key": field["key"],
                        "label": field["label"],
                        "field_type": field["field_type"],
                        "required": field["required"] or field["key"] == "normal_hearing",
                        "options": _options(field["options_json"]),
                    }
                )

            unique_fields: list[dict[str, Any]] = []
            seen_keys: set[str] = set()
            for field in serialized_fields:
                if field["key"] not in seen_keys:
                    seen_keys.add(field["key"])
                    unique_fields.append(field)

            return JSONResponse(
                {
                    "test_id": test["id"],
                    "name": test["name"],
                    "consent_text": consent_text,
                    "demographics": unique_fields,
                }
            )
    except SQLAlchemyError:
        return JSONResponse({"error": "internal server error"}, status_code=500)


@router.post("/sessions/start")
async def start_session(request: Request):
    payload = await _json_payload(request)
    code_raw = payload.get("access_code") or ""
    consent_accepted = payload.get("consent_accepted")
    demographics_answers = payload.get("demographics") or {}
    token_existing = payload.get("token")

    if not isinstance(code_raw, str):
        return JSONResponse(_INVALID_CODE, status_code=400)

    code = code_raw.strip().upper()
    if not code:
        return JSONResponse(_INVALID_CODE, status_code=400)

    if not consent_accepted:
        return JSONResponse({"error": "Consent is mandatory."}, status_code=400)

    if not isinstance(demographics_answers, dict):
        demographics_answers = {}

    # Rate limit session starts to 5 req/min per client
    key = f"start:{request.client.host if request.client else 'unknown'}"
    if rate_limited(key, 5, 60.0):
        return JSONResponse({"error": "too many requests"}, status_code=429)

    try:
        with request.app.state.session_factory() as session, session.begin():
            tests = _table(session, "test")
            test = session.execute(
                select(tests).where(
                    tests.c.access_code == code,
                    tests.c.status == "published",
                )
            ).mappings().first()
            if test is None:
                return JSONResponse(_INVALID_CODE, status_code=400)

            respondent_sessions = _table(session, "respondent_session")
            # Idempotence check with token
            if token_existing:
                existing_session = session.execute(
                    select(respondent_sessions).where(
                        respondent_sessions.c.token == token_existing,
                        respondent_sessions.c.status != "deleted",
                    )
                ).mappings().first()
                if existing_session is not None and existing_session["test_id"] == test["id"]:
                    config = parse_config(test["config_yaml"])
                    calibration_audio_ref = config.get("calibration_audio_ref")
                    requires_calibration = (
                        isinstance(calibration_audio_ref, str)
                        and calibration_audio_ref in config.get("audio", {})
                    )
                    return JSONResponse(
                        {
                            "session_token": existing_session["token"],
                            "test_id": test["id"],
                            "name": test["name"],
                            "requires_calibration": requires_calibration,
                            "calibration_completed": bool(existing_session["calibration_completed"]),
                        },
                        status_code=200,
                    )

            # Validate demographics
            definitions = _table(session, "demographic_field_def")
            links = _table(session, "test_demographic_field")
            demo_fields = session.execute(
                select(definitions)
                .join(links, links.c.field_key == definitions.c.key)
                .where(links.c.test_id == test["id"])
            ).mappings().all()

            errors = []
            nh_val = demographics_answers.get("normal_hearing")
            if not nh_val or not str(nh_val).strip():
                errors.append("Hearing status declaration is required.")

            for df in demo_fields:
                val = demographics_answers.get(df["key"])
                if (df["required"] or df["key"] == "normal_hearing") and (
                    not val or not str(val).strip()
                ):
                    errors.append(f"{df['label']} is required.")

            if errors:
                return JSONResponse({"errors": errors}, status_code=400)

            # Generate new session
            session_token = secrets.token_hex(32)
            random_seed = secrets.randbits(31)
            now = utcnow()

            session_id = session.execute(
                respondent_sessions.insert().values(
                    test_id=test["id"],
                    token=session_token,
                    random_seed=random_seed,
                    consent_accepted=True,
                    status="active",
                    calibration_play_count=0,
                    calibration_completed=False,
                    created_at=now,
                    updated_at=now,
                ).returning(respondent_sessions.c.id)
            ).scalar_one()

            # Save demographics answers
            all_keys = {df["key"] for df in demo_fields}
            all_keys.add("normal_hearing")

            demographic_responses = _table(session, "respondent_demographic_response")
            for k in all_keys:
                val = demographics_answers.get(k)
                if val is not None:
                    session.execute(
                        demographic_responses.insert().values(
                            session_id=session_id,
                            field_key=k,
                            value=str(val),
                        )
                    )

            config = parse_config(test["config_yaml"])
            calibration_audio_ref = config.get("calibration_audio_ref")
            requires_calibration = (
                isinstance(calibration_audio_ref, str)
                and calibration_audio_ref in config.get("audio", {})
            )

            # Get and randomize stimuli
            test_stimuli = _table(session, "test_stimulus")
            stimuli = session.execute(
                select(test_stimuli).where(test_stimuli.c.test_id == test["id"])
            ).mappings().all()

            mos_stimuli = [s for s in stimuli if s["kind"] == "mos"]
            sus_stimuli = [s for s in stimuli if s["kind"] == "sus"]

            rng = random.Random(random_seed)
            rng.shuffle(mos_stimuli)
            rng.shuffle(sus_stimuli)

            stimulus_orders = _table(session, "respondent_stimulus_order")
            position = 0
            for s in mos_stimuli:
                session.execute(
                    stimulus_orders.insert().values(
                        session_id=session_id,
                        stimulus_id=s["id"],
                        position=position,
                    )
                )
                position += 1

            for s in sus_stimuli:
                session.execute(
                    stimulus_orders.insert().values(
                        session_id=session_id,
                        stimulus_id=s["id"],
                        position=position,
                    )
                )
                position += 1

            return JSONResponse(
                {
                    "session_token": session_token,
                    "test_id": test["id"],
                    "name": test["name"],
                    "requires_calibration": requires_calibration,
                    "calibration_completed": False,
                },
                status_code=201,
            )
    except SQLAlchemyError:
        return JSONResponse({"error": "internal server error"}, status_code=500)


@router.post("/sessions/resume")
async def resume_session(request: Request):
    payload = await _json_payload(request)
    token = payload.get("token") or ""
    if not token or not isinstance(token, str):
        return JSONResponse(_INVALID_SESSION, status_code=400)

    try:
        with request.app.state.session_factory() as session:
            respondent_sessions = _table(session, "respondent_session")
            rs = session.execute(
                select(respondent_sessions).where(
                    respondent_sessions.c.token == token,
                    respondent_sessions.c.status != "deleted",
                )
            ).mappings().first()
            if rs is None:
                return JSONResponse(_INVALID_SESSION, status_code=400)

            tests = _table(session, "test")
            test = session.execute(
                select(tests).where(tests.c.id == rs["test_id"])
            ).mappings().first()
            if test is None or test["status"] != "published":
                return JSONResponse(_INVALID_SESSION, status_code=400)

            try:
                config = parse_config(test["config_yaml"])
            except ConfigValidationError:
                logger.exception("stored configuration is invalid for test %s", test["id"])
                return JSONResponse({"error": "stored configuration is invalid"}, status_code=500)
            calibration_audio_ref = config.get("calibration_audio_ref")
            requires_calibration = (
                isinstance(calibration_audio_ref, str)
                and calibration_audio_ref in config.get("audio", {})
            )
            # Ensure calibration_completed is only True when calibration was actually required
            # If no calibration required, treat as completed (no-op)
            calibration_completed = bool(rs["calibration_completed"]) if requires_calibration else True
            return JSONResponse(
                {
                    "session_token": rs["token"],
                    "test_id": test["id"],
                    "name": test["name"],
                    "status": rs["status"],
                    "requires_calibration": requires_calibration,
                    "calibration_completed": calibration_completed,
                }
            )
    except SQLAlchemyError:
        return JSONResponse({"error": "internal server error"}, status_code=500)


@router.post("/sessions/next-stimulus")
async def get_next_stimulus(request: Request):
    payload = await _json_payload(request)
    token = payload.get("token") or ""
    if not token or not isinstance(token, str):
        return JSONResponse(_INVALID_SESSION, status_code=400)

    try:
        with request.app.state.session_factory() as session:
            respondent_sessions = _table(session, "respondent_session")
            rs = session.execute(
                select(respondent_sessions).where(
                    respondent_sessions.c.token == token,
                    respondent_sessions.c.status != "deleted",
                )
            ).mappings().first()
            if rs is None:
                return JSONResponse(_INVALID_SESSION, status_code=400)

            templates = _table(session, "text_template")
            completion_template = session.execute(
                select(templates)
                .where(templates.c.kind == "completion")
                .order_by(templates.c.version.desc())
            ).mappings().first()
            completion_text = (
                completion_template["content"]
                if completion_template
                else "Thank you for participating."
            )

            if rs["status"] == "completed":
                return JSONResponse(
                    {
                        "status": "completed",
                        "message": completion_text,
                        "completion_text": completion_text,
                    }
                )

            tests = _table(session, "test")
            test = session.execute(
                select(tests).where(tests.c.id == rs["test_id"])
            ).mappings().first()
            if test is None or test["status"] != "published":
                return JSONResponse(_INVALID_SESSION, status_code=400)

            stimulus_orders_table = _table(session, "respondent_stimulus_order")
            stimulus_orders = session.execute(
                select(stimulus_orders_table)
                .where(stimulus_orders_table.c.session_id == rs["id"])
                .order_by(stimulus_orders_table.c.position.asc())
            ).mappings().all()

            if not stimulus_orders:
                now = utcnow()
                completed_at = rs["completed_at"] or now
                session.execute(
                    update(respondent_sessions)
                    .where(respondent_sessions.c.id == rs["id"])
                    .values(status="completed", completed_at=completed_at)
                )
                session.commit()
                return JSONResponse(
                    {
                        "status": "completed",
                        "message": completion_text,
                        "completion_text": completion_text,
                    }
                )

            mos_responses_table = _table(session, "mos_response")
            sus_responses_table = _table(session, "sus_response")

            answered_mos_ids = set(
                session.execute(
                    select(mos_responses_table.c.stimulus_id).where(
                        mos_responses_table.c.session_id == rs["id"]
                    )
                ).scalars().all()
            )
            answered_sus_ids = set(
                session.execute(
                    select(sus_responses_table.c.stimulus_id).where(
                        sus_responses_table.c.session_id == rs["id"]
                    )
                ).scalars().all()
            )
            answered_stimulus_ids = answered_mos_ids.union(answered_sus_ids)

            next_order = None
            for order in stimulus_orders:
                if order["stimulus_id"] not in answered_stimulus_ids:
                    next_order = order
                    break

            if not next_order:
                now = utcnow()
                completed_at = rs["completed_at"] or now
                session.execute(
                    update(respondent_sessions)
                    .where(respondent_sessions.c.id == rs["id"])
                    .values(status="completed", completed_at=completed_at)
                )
                session.commit()
                return JSONResponse(
                    {
                        "status": "completed",
                        "message": completion_text,
                        "completion_text": completion_text,
                    }
                )

            test_stimuli_table = _table(session, "test_stimulus")
            stimulus = session.execute(
                select(test_stimuli_table).where(
                    test_stimuli_table.c.id == next_order["stimulus_id"]
                )
            ).mappings().first()
            if stimulus is None:
                return JSONResponse({"error": "Stimulus not found"}, status_code=404)

            current_index = len(answered_stimulus_ids) + 1
            total_stimuli = len(stimulus_orders)

            config = parse_config(test["config_yaml"])
            mos_config = config.get(
                "mos",
                {
                    "min": 1,
                    "max": 5,
                    "labels": ["Bad", "Poor", "Fair", "Good", "Excellent"],
                },
            )

            return JSONResponse(
                {
                    "status": "active",
                    "session_token": rs["token"],
                    "test_id": test["id"],
                    "test_name": test["name"],
                    "current_index": current_index,
                    "total_stimuli": total_stimuli,
                    "stimulus": {
                        "id": stimulus["id"],
                        "neutral_label": stimulus["neutral_label"],
                        "kind": stimulus["kind"],
                    },
                    "mos_config": mos_config,
                }
            )
    except SQLAlchemyError:
        return JSONResponse({"error": "internal server error"}, status_code=500)


@router.post("/sessions/sus/play-authorize")
async def authorize_sus_play(request: Request):
    payload = await _json_payload(request)
    token = payload.get("token")
    stimulus_id = payload.get("stimulus_id")
    if not isinstance(token, str) or not token:
        return JSONResponse(_INVALID_SESSION, status_code=400)
    if isinstance(stimulus_id, bool) or not isinstance(stimulus_id, int):
        return JSONResponse({"error": "stimulus_id must be an integer"}, status_code=400)

    try:
        with request.app.state.session_factory() as session, session.begin():
            respondent_sessions = _table(session, "respondent_session")
            rs = session.execute(
                select(respondent_sessions).where(
                    respondent_sessions.c.token == token,
                    respondent_sessions.c.status != "deleted",
                )
            ).mappings().first()
            if rs is None or rs["status"] == "completed":
                return JSONResponse(_INVALID_SESSION, status_code=400)

            tests = _table(session, "test")
            test = session.execute(
                select(tests).where(tests.c.id == rs["test_id"])
            ).mappings().first()

            test_stimuli = _table(session, "test_stimulus")
            stimulus = session.execute(
                select(test_stimuli).where(test_stimuli.c.id == stimulus_id)
            ).mappings().first()

            order_table = _table(session, "respondent_stimulus_order")
            order = session.execute(
                select(order_table).where(
                    order_table.c.session_id == rs["id"],
                    order_table.c.stimulus_id == stimulus_id,
                )
            ).mappings().first()

            if test is None or test["status"] != "published":
                return JSONResponse(_INVALID_SESSION, status_code=400)
            if order is None or stimulus is None:
                return JSONResponse({"error": "Stimulus not found in this session"}, status_code=404)
            if stimulus["kind"] != "sus":
                return JSONResponse({"error": "Stimulus is not a SUS item"}, status_code=400)

            config = parse_config(test["config_yaml"])
            calibration_audio_ref = config.get("calibration_audio_ref")
            if (
                isinstance(calibration_audio_ref, str)
                and calibration_audio_ref in config.get("audio", {})
                and not rs["calibration_completed"]
            ):
                return JSONResponse({"error": "Calibration required"}, status_code=400)

            quota = config.get("sus", {}).get("quota", 2)
            if type(quota) is not int or quota < 1:
                return JSONResponse({"error": "Invalid SUS quota configuration"}, status_code=500)

            sus_play_authorizations = _table(session, "sus_play_authorization")
            used = session.execute(
                select(func.count(sus_play_authorizations.c.id)).where(
                    sus_play_authorizations.c.session_id == rs["id"],
                    sus_play_authorizations.c.stimulus_id == stimulus_id,
                )
            ).scalar() or 0

            if used >= quota:
                return JSONResponse(
                    {"error": "SUS playback quota exceeded", "quota": quota},
                    status_code=429,
                )

            authorization_id = secrets.token_urlsafe(32)
            session.execute(
                sus_play_authorizations.insert().values(
                    id=authorization_id,
                    session_id=rs["id"],
                    stimulus_id=stimulus_id,
                    status="authorized",
                    created_at=utcnow(),
                )
            )

            return JSONResponse(
                {
                    "authorization_id": authorization_id,
                    "quota": quota,
                    "plays_used": used,
                },
                status_code=201,
            )
    except SQLAlchemyError:
        return JSONResponse({"error": "internal server error"}, status_code=500)


@router.post("/sessions/response")
async def submit_response(request: Request):
    payload = await _json_payload(request)
    token = payload.get("token") or ""
    stimulus_id = payload.get("stimulus_id")
    rating = payload.get("rating")
    play_count = payload.get("play_count", 0)
    authorization_id = payload.get("authorization_id")

    if not token or not isinstance(token, str):
        return JSONResponse(_INVALID_SESSION, status_code=400)
    if stimulus_id is None:
        return JSONResponse({"error": "stimulus_id is required"}, status_code=400)
    if isinstance(stimulus_id, bool) or isinstance(play_count, bool):
        return JSONResponse({"error": "stimulus_id and play_count must be integers"}, status_code=400)
    try:
        stimulus_id = int(stimulus_id)
        play_count = int(play_count)
    except (ValueError, TypeError, OverflowError):
        return JSONResponse({"error": "stimulus_id and play_count must be integers"}, status_code=400)
    if play_count < 0:
        return JSONResponse({"error": "play_count must be non-negative"}, status_code=400)

    try:
        with request.app.state.session_factory() as session, session.begin():
            respondent_sessions = _table(session, "respondent_session")
            rs = session.execute(
                select(respondent_sessions).where(
                    respondent_sessions.c.token == token,
                    respondent_sessions.c.status != "deleted",
                )
            ).mappings().first()
            if rs is None:
                return JSONResponse(_INVALID_SESSION, status_code=400)

            tests = _table(session, "test")
            test = session.execute(
                select(tests).where(tests.c.id == rs["test_id"])
            ).mappings().first()
            if test is None or test["status"] != "published":
                return JSONResponse(_INVALID_SESSION, status_code=400)

            config = parse_config(test["config_yaml"])
            calibration_audio_ref = config.get("calibration_audio_ref")
            requires_calibration = (
                isinstance(calibration_audio_ref, str)
                and calibration_audio_ref in config.get("audio", {})
            )
            if requires_calibration and not rs["calibration_completed"]:
                return JSONResponse({"error": "Calibration required"}, status_code=400)

            if rs["status"] == "completed":
                return JSONResponse({"error": "Session is already completed"}, status_code=400)

            order_table = _table(session, "respondent_stimulus_order")
            order = session.execute(
                select(order_table).where(
                    order_table.c.session_id == rs["id"],
                    order_table.c.stimulus_id == stimulus_id,
                )
            ).mappings().first()
            if order is None:
                return JSONResponse({"error": "Stimulus not found in this session"}, status_code=404)

            test_stimuli = _table(session, "test_stimulus")
            stimulus = session.execute(
                select(test_stimuli).where(test_stimuli.c.id == stimulus_id)
            ).mappings().first()
            if stimulus is None:
                return JSONResponse({"error": "Stimulus not found"}, status_code=404)

            if stimulus["kind"] == "mos":
                if rating is None:
                    return JSONResponse({"error": "rating is required for MOS stimulus"}, status_code=400)
                if isinstance(rating, bool) or (
                    not isinstance(rating, int)
                    and not (
                        isinstance(rating, str)
                        and rating.strip().lstrip("-").isdigit()
                    )
                ):
                    return JSONResponse({"error": "rating must be an integer"}, status_code=400)
                try:
                    rating_val = int(rating)
                except (ValueError, TypeError, OverflowError):
                    return JSONResponse({"error": "rating must be an integer"}, status_code=400)

                mos_config = config.get("mos", {"min": 1, "max": 5})
                try:
                    min_val = int(mos_config.get("min", 1))
                    max_val = int(mos_config.get("max", 5))
                except (ValueError, TypeError):
                    return JSONResponse({"error": "Invalid MOS scale configuration"}, status_code=500)

                if rating_val < min_val or rating_val > max_val:
                    return JSONResponse({"error": f"rating must be between {min_val} and {max_val}"}, status_code=400)

                mos_responses = _table(session, "mos_response")
                existing_response = session.execute(
                    select(mos_responses).where(
                        mos_responses.c.session_id == rs["id"],
                        mos_responses.c.stimulus_id == stimulus_id,
                    )
                ).mappings().first()

                if existing_response:
                    session.execute(
                        update(mos_responses)
                        .where(
                            mos_responses.c.session_id == rs["id"],
                            mos_responses.c.stimulus_id == stimulus_id,
                        )
                        .values(
                            rating=rating_val,
                            play_count=play_count,
                        )
                    )
                else:
                    session.execute(
                        mos_responses.insert().values(
                            session_id=rs["id"],
                            stimulus_id=stimulus_id,
                            rating=rating_val,
                            play_count=play_count,
                            created_at=utcnow(),
                        )
                    )

            elif stimulus["kind"] == "sus":
                quota = config.get("sus", {}).get("quota", 2)
                if type(quota) is not int or quota < 1:
                    return JSONResponse({"error": "Invalid SUS quota configuration"}, status_code=500)

                sus_play_authorizations = _table(session, "sus_play_authorization")
                prior_plays = session.execute(
                    select(func.count(sus_play_authorizations.c.id)).where(
                        sus_play_authorizations.c.session_id == rs["id"],
                        sus_play_authorizations.c.stimulus_id == stimulus_id,
                        sus_play_authorizations.c.status == "consumed",
                    )
                ).scalar() or 0

                if not isinstance(authorization_id, str) or not authorization_id:
                    return JSONResponse({"error": "A valid play authorization is required"}, status_code=400)

                authorization = session.execute(
                    select(sus_play_authorizations).where(
                        sus_play_authorizations.c.id == authorization_id,
                        sus_play_authorizations.c.session_id == rs["id"],
                        sus_play_authorizations.c.stimulus_id == stimulus_id,
                        sus_play_authorizations.c.status == "authorized",
                    )
                ).mappings().first()

                if authorization is None:
                    return JSONResponse({"error": "Invalid or already used play authorization"}, status_code=400)

                consumed_time = utcnow()
                consume_result = session.execute(
                    update(sus_play_authorizations)
                    .where(
                        sus_play_authorizations.c.id == authorization_id,
                        sus_play_authorizations.c.status == "authorized",
                    )
                    .values(
                        status="consumed",
                        consumed_at=consumed_time,
                    )
                )
                if consume_result.rowcount == 0:
                    return JSONResponse({"error": "Invalid or already used play authorization"}, status_code=400)

                prior_plays += 1

                raw_text = payload.get("transcription")
                if raw_text is None:
                    raw_text = payload.get("raw_transcription")
                if raw_text is None:
                    raw_text = ""
                raw_text = str(raw_text).strip()

                reference_text = ""
                try:
                    audio_map = config.get("audio", {})
                    asset_id = audio_map.get(stimulus["audio_ref"])
                    if asset_id:
                        audio_assets = _table(session, "audio_asset")
                        asset = session.execute(
                            select(audio_assets).where(audio_assets.c.id == asset_id)
                        ).mappings().first()
                        if asset:
                            reference_text = asset["reference_transcription"] or ""
                except (SQLAlchemyError, KeyError, TypeError) as exc:
                    # Scoring must not fail the submission; fall back to an empty reference.
                    logger.warning("reference transcription lookup failed: %s", exc)

                language = config.get("language", "id")
                stats = compute_word_stats(reference_text, raw_text, language=language)
                normalized_text = normalize_text(raw_text, language=language)

                sus_responses = _table(session, "sus_response")
                existing_response = session.execute(
                    select(sus_responses).where(
                        sus_responses.c.session_id == rs["id"],
                        sus_responses.c.stimulus_id == stimulus_id,
                    )
                ).mappings().first()

                if existing_response:
                    session.execute(
                        update(sus_responses)
                        .where(
                            sus_responses.c.session_id == rs["id"],
                            sus_responses.c.stimulus_id == stimulus_id,
                        )
                        .values(
                            raw_transcription=raw_text,
                            normalized_transcription=normalized_text,
                            wacc=stats["wacc"],
                            substitutions=stats["substitutions"],
                            deletions=stats["deletions"],
                            insertions=stats["insertions"],
                            play_count=prior_plays,
                        )
                    )
                else:
                    session.execute(
                        sus_responses.insert().values(
                            session_id=rs["id"],
                            stimulus_id=stimulus_id,
                            raw_transcription=raw_text,
                            normalized_transcription=normalized_text,
                            wacc=stats["wacc"],
                            substitutions=stats["substitutions"],
                            deletions=stats["deletions"],
                            insertions=stats["insertions"],
                            play_count=prior_plays,
                            created_at=utcnow(),
                        )
                    )
            else:
                return JSONResponse({"error": "Invalid stimulus kind"}, status_code=400)

            # Check if all stimuli are answered now
            stimulus_orders = session.execute(
                select(order_table).where(order_table.c.session_id == rs["id"])
            ).mappings().all()

            mos_responses_table = _table(session, "mos_response")
            sus_responses_table = _table(session, "sus_response")

            answered_mos_ids = set(
                session.execute(
                    select(mos_responses_table.c.stimulus_id).where(
                        mos_responses_table.c.session_id == rs["id"]
                    )
                ).scalars().all()
            )
            answered_sus_ids = set(
                session.execute(
                    select(sus_responses_table.c.stimulus_id).where(
                        sus_responses_table.c.session_id == rs["id"]
                    )
                ).scalars().all()
            )
            answered_all = answered_mos_ids.union(answered_sus_ids)

            if len(answered_all) >= len(stimulus_orders):
                session_update_values = {"status": "completed"}
                if not rs["completed_at"]:
                    session_update_values["completed_at"] = utcnow()
                session.execute(
                    update(respondent_sessions)
                    .where(respondent_sessions.c.id == rs["id"])
                    .values(**session_update_values)
                )

            return JSONResponse({"status": "success", "message": "Response saved"})
    except SQLAlchemyError:
        return JSONResponse({"error": "internal server error"}, status_code=500)


@router.api_route("/sessions/calibration/stream", methods=["GET", "HEAD"])
async def public_calibration_stream(request: Request):
    token = request.query_params.get("token") or ""
    if not token or not isinstance(token, str):
        return JSONResponse({"error": "Invalid session token"}, status_code=400)

    try:
        with request.app.state.session_factory() as session:
            respondent_sessions = _table(session, "respondent_session")
            rs = session.execute(
                select(respondent_sessions).where(
                    respondent_sessions.c.token == token,
                    respondent_sessions.c.status != "deleted",
                )
            ).mappings().first()
            if not rs:
                return JSONResponse({"error": "Invalid session token"}, status_code=400)

            tests = _table(session, "test")
            test = session.execute(
                select(tests).where(tests.c.id == rs["test_id"])
            ).mappings().first()
            if not test or test["status"] != "published":
                return JSONResponse({"error": "Invalid session token"}, status_code=400)

            config = parse_config(test["config_yaml"])
            audio_map = config.get("audio", {})
            calibration_audio_ref = config.get("calibration_audio_ref")
            if not isinstance(calibration_audio_ref, str) or calibration_audio_ref not in audio_map:
                return JSONResponse({"error": "Calibration audio not configured"}, status_code=404)

            asset_id = audio_map.get(calibration_audio_ref)
            audio_assets = _table(session, "audio_asset")
            asset = session.execute(
                select(audio_assets).where(audio_assets.c.id == asset_id)
            ).mappings().first()
            if not asset or asset["status"] != "active":
                return JSONResponse({"error": "Audio asset not found or inactive"}, status_code=404)

            stored_filename = asset["stored_filename"]
            content_type = asset["content_type"]

        storage_dir = request.app.state.settings.audio_storage_path
        path = resolve_stored_path(storage_dir, stored_filename)
        if path is None:
            return JSONResponse({"error": "invalid storage reference"}, status_code=500)

        return stream_media_file(request, path, content_type, stored_filename)
    except SQLAlchemyError:
        return JSONResponse({"error": "internal server error"}, status_code=500)


@router.post("/sessions/calibration/play")
async def calibration_play(request: Request):
    payload = await _json_payload(request)
    token = payload.get("token") or ""
    if not token or not isinstance(token, str):
        return JSONResponse({"error": "Invalid session token"}, status_code=400)

    try:
        with request.app.state.session_factory() as session:
            respondent_sessions = _table(session, "respondent_session")
            rs = session.execute(
                select(respondent_sessions).where(
                    respondent_sessions.c.token == token,
                    respondent_sessions.c.status != "deleted",
                )
            ).mappings().first()
            if not rs:
                return JSONResponse({"error": "Invalid session token"}, status_code=400)

            tests = _table(session, "test")
            test = session.execute(
                select(tests).where(tests.c.id == rs["test_id"])
            ).mappings().first()
            if not test or test["status"] != "published":
                return JSONResponse({"error": "Invalid session token"}, status_code=400)

            config = parse_config(test["config_yaml"])
            audio_map = config.get("audio", {})
            calibration_audio_ref = config.get("calibration_audio_ref")
            if not isinstance(calibration_audio_ref, str) or calibration_audio_ref not in audio_map:
                return JSONResponse({"error": "Calibration audio not configured"}, status_code=404)

            new_count = (rs["calibration_play_count"] or 0) + 1
            session.execute(
                update(respondent_sessions)
                .where(respondent_sessions.c.id == rs["id"])
                .values(calibration_play_count=new_count)
            )
            session.commit()
            return JSONResponse({"calibration_play_count": new_count})
    except SQLAlchemyError:
        return JSONResponse({"error": "internal server error"}, status_code=500)


@router.post("/sessions/calibration/complete")
async def calibration_complete(request: Request):
    payload = await _json_payload(request)
    token = payload.get("token") or ""
    if not token or not isinstance(token, str):
        return JSONResponse({"error": "Invalid session token"}, status_code=400)

    try:
        with request.app.state.session_factory() as session:
            respondent_sessions = _table(session, "respondent_session")
            rs = session.execute(
                select(respondent_sessions).where(
                    respondent_sessions.c.token == token,
                    respondent_sessions.c.status != "deleted",
                )
            ).mappings().first()
            if not rs:
                return JSONResponse({"error": "Invalid session token"}, status_code=400)

            tests = _table(session, "test")
            test = session.execute(
                select(tests).where(tests.c.id == rs["test_id"])
            ).mappings().first()
            if not test or test["status"] != "published":
                return JSONResponse({"error": "Invalid session token"}, status_code=400)

            config = parse_config(test["config_yaml"])
            audio_map = config.get("audio", {})
            calibration_audio_ref = config.get("calibration_audio_ref")
            if not isinstance(calibration_audio_ref, str) or calibration_audio_ref not in audio_map:
                return JSONResponse({"error": "Calibration audio not configured"}, status_code=404)

            if (rs["calibration_play_count"] or 0) < 1:
                return JSONResponse({"error": "Calibration sample must be played at least once before continuing."}, status_code=400)

            session.execute(
                update(respondent_sessions)
                .where(respondent_sessions.c.id == rs["id"])
                .values(calibration_completed=True)
            )
            session.commit()
            return JSONResponse({"status": "success"})
    except SQLAlchemyError:
        return JSONResponse({"error": "internal server error"}, status_code=500)



@router.api_route("/media/stream/{token}/{stimulus_id}", methods=["GET", "HEAD"])
async def public_stream_audio(request: Request, token: str, stimulus_id: int):
    if not token or not isinstance(token, str):
        return JSONResponse({"error": "Invalid session token"}, status_code=400)

    try:
        with request.app.state.session_factory() as session:
            respondent_sessions = _table(session, "respondent_session")
            rs = session.execute(
                select(respondent_sessions).where(
                    respondent_sessions.c.token == token,
                    respondent_sessions.c.status != "deleted",
                )
            ).mappings().first()
            if not rs:
                return JSONResponse({"error": "Invalid session token"}, status_code=400)

            # Block streaming once the session is completed
            if rs["status"] == "completed":
                return JSONResponse({"error": "Session is already completed"}, status_code=400)

            tests = _table(session, "test")
            test = session.execute(
                select(tests).where(tests.c.id == rs["test_id"])
            ).mappings().first()
            if not test or test["status"] != "published":
                return JSONResponse({"error": "Invalid session token"}, status_code=400)

            config = parse_config(test["config_yaml"])

            # Enforce calibration gate before any stimulus audio is served
            calibration_audio_ref = config.get("calibration_audio_ref")
            if (
                isinstance(calibration_audio_ref, str)
                and calibration_audio_ref in config.get("audio", {})
                and not rs["calibration_completed"]
            ):
                return JSONResponse({"error": "Calibration required"}, status_code=400)

            # Verify the stimulus belongs to this session AND is the next unanswered one
            order_table = _table(session, "respondent_stimulus_order")
            orders = session.execute(
                select(order_table).where(
                    order_table.c.session_id == rs["id"],
                ).order_by(order_table.c.position.asc())
            ).mappings().all()

            target_order = next((o for o in orders if o["stimulus_id"] == stimulus_id), None)
            if target_order is None:
                return JSONResponse({"error": "Stimulus not found in this session"}, status_code=404)

            # Look up answered stimuli to enforce presentation order
            mos_responses_table = _table(session, "mos_response")
            sus_responses_table = _table(session, "sus_response")
            answered_mos = {
                r for r in session.execute(
                    select(mos_responses_table.c.stimulus_id).where(
                        mos_responses_table.c.session_id == rs["id"]
                    )
                ).scalars().all()
            }
            answered_sus = {
                r for r in session.execute(
                    select(sus_responses_table.c.stimulus_id).where(
                        sus_responses_table.c.session_id == rs["id"]
                    )
                ).scalars().all()
            }
            answered_ids = answered_mos | answered_sus

            # Only allow streaming the FIRST unanswered stimulus
            for o in orders:
                if o["stimulus_id"] not in answered_ids:
                    if o["stimulus_id"] != stimulus_id:
                        return JSONResponse({"error": "Stimulus not yet available"}, status_code=403)
                    break

            stimulus_table = _table(session, "test_stimulus")
            stimulus = session.execute(
                select(stimulus_table).where(stimulus_table.c.id == stimulus_id)
            ).mappings().first()
            if not stimulus:
                return JSONResponse({"error": "Stimulus not found"}, status_code=404)

            # For SUS stimuli, require and atomically consume a valid play authorization.
            # Each authorization allows exactly one stream, enforcing the quota.
            if stimulus["kind"] == "sus":
                sus_play_authorizations = _table(session, "sus_play_authorization")
                authorization = session.execute(
                    select(sus_play_authorizations).where(
                        sus_play_authorizations.c.session_id == rs["id"],
                        sus_play_authorizations.c.stimulus_id == stimulus_id,
                        sus_play_authorizations.c.status == "authorized",
                    )
                ).mappings().first()
                if authorization is None:
                    return JSONResponse({"error": "Play authorization required"}, status_code=403)

                # Atomically consume the authorization
                result = session.execute(
                    update(sus_play_authorizations)
                    .where(
                        sus_play_authorizations.c.id == authorization["id"],
                        sus_play_authorizations.c.status == "authorized",
                    )
                    .values(status="consumed", consumed_at=utcnow())
                )
                if result.rowcount == 0:
                    return JSONResponse({"error": "Play authorization required"}, status_code=403)
                session.commit()

            audio_map = config.get("audio", {})
            asset_id = audio_map.get(stimulus["audio_ref"])
            if not asset_id:
                return JSONResponse({"error": "Audio asset mapping not found"}, status_code=404)

            audio_assets = _table(session, "audio_asset")
            asset = session.execute(
                select(audio_assets).where(audio_assets.c.id == asset_id)
            ).mappings().first()
            if not asset or asset["status"] != "active":
                return JSONResponse({"error": "Audio asset not found or inactive"}, status_code=404)

            stored_filename = asset["stored_filename"]
            content_type = asset["content_type"]

        storage_dir = request.app.state.settings.audio_storage_path
        path = resolve_stored_path(storage_dir, stored_filename)
        if path is None:
            return JSONResponse({"error": "invalid storage reference"}, status_code=500)

        return stream_media_file(request, path, content_type, stored_filename)
    except SQLAlchemyError:
        return JSONResponse({"error": "internal server error"}, status_code=500)
