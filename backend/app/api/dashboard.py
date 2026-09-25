"""Read-only administrator dashboard API."""

from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from sqlalchemy import MetaData, Table, select
from sqlalchemy.exc import SQLAlchemyError

from ..services.scoring import mos_summary as _mos_summary
from ..services.scoring import sample_stddev as _stddev
from .auth import admin_required

router = APIRouter(prefix="/admin/api")


def _rows(session, table, order_by=None, where=None) -> list:
    statement = select(table)
    if where is not None:
        statement = statement.where(where)
    if order_by is not None:
        statement = statement.order_by(order_by)
    return list(session.execute(statement).mappings())


def _dashboard_payload(session) -> dict[str, object]:
    metadata = MetaData()
    tables = {
        name: Table(name, metadata, autoload_with=session.bind)
        for name in (
            "test", "engine", "mos_scale_preset", "demographic_field_def", "text_template",
            "audio_asset", "test_stimulus", "respondent_session", "mos_response", "sus_response",
        )
    }
    test = tables["test"]
    engine = tables["engine"]
    mos_scale = tables["mos_scale_preset"]
    demographic = tables["demographic_field_def"]
    template = tables["text_template"]
    audio = tables["audio_asset"]
    stimulus = tables["test_stimulus"]
    respondent = tables["respondent_session"]
    mos = tables["mos_response"]
    sus = tables["sus_response"]

    tests = _rows(session, test, test.c.created_at.desc())
    engines = _rows(session, engine, engine.c.id)
    mos_scales = _rows(session, mos_scale)
    demo_fields = _rows(session, demographic)
    templates = _rows(session, template)
    audio_assets = _rows(session, audio, where=audio.c.status == "active")
    test_ids = [row["id"] for row in tests]
    stimuli = _rows(session, stimulus, where=stimulus.c.test_id.in_(test_ids)) if test_ids else []
    sessions = _rows(
        session,
        respondent,
        respondent.c.created_at.desc(),
        where=respondent.c.test_id.in_(test_ids) & (respondent.c.status != "deleted"),
    ) if test_ids else []
    session_ids = [row["id"] for row in sessions]
    stimulus_ids = [row["id"] for row in stimuli]
    mos_responses = _rows(
        session, mos,
        where=mos.c.session_id.in_(session_ids) & mos.c.stimulus_id.in_(stimulus_ids),
    ) if session_ids and stimulus_ids else []
    sus_responses = _rows(
        session, sus,
        where=sus.c.session_id.in_(session_ids) & sus.c.stimulus_id.in_(stimulus_ids),
    ) if session_ids and stimulus_ids else []

    total_tests = len(tests)
    published_tests = sum(row["status"] == "published" for row in tests)
    completed_sessions = sum(row["status"] == "completed" for row in sessions)
    mos_ratings = [row["rating"] for row in mos_responses if row["rating"] is not None]
    sus_waccs = [row["wacc"] for row in sus_responses if row["wacc"] is not None]
    metrics = {
        "total_tests": total_tests,
        "published_tests": published_tests,
        "draft_tests": sum(row["status"] == "draft" for row in tests),
        "total_sessions": len(sessions),
        "completed_sessions": completed_sessions,
        "active_sessions": sum(row["status"] == "active" for row in sessions),
        "completion_rate": round(completed_sessions / len(sessions) * 100.0, 1) if sessions else 0.0,
        "mos": {
            "total_ratings": len(mos_ratings),
            "mean": round(sum(mos_ratings) / len(mos_ratings), 2) if mos_ratings else None,
            "ci95": _mos_summary(mos_ratings)["ci95"],
        },
        "sus": {
            "total_evaluations": len(sus_waccs),
            "mean_wacc": round(sum(sus_waccs) / len(sus_waccs), 4) if sus_waccs else None,
            "total_substitutions": sum(row["substitutions"] or 0 for row in sus_responses),
            "total_deletions": sum(row["deletions"] or 0 for row in sus_responses),
            "total_insertions": sum(row["insertions"] or 0 for row in sus_responses),
        },
        "audio": {
            "total_assets": len(audio_assets),
            "total_size_bytes": sum(row["size_bytes"] or 0 for row in audio_assets),
            "engines_covered": len({row["engine_id"] for row in audio_assets if row["engine_id"] is not None}),
        },
        "system": {"offline_mode": True, "database_engine": "SQLite", "storage_healthy": True},
    }

    test_stimuli = {row["test_id"]: [] for row in stimuli}
    for row in stimuli:
        test_stimuli.setdefault(row["test_id"], []).append(row)
    test_sessions = {row["test_id"]: [] for row in sessions}
    for row in sessions:
        test_sessions.setdefault(row["test_id"], []).append(row)
    mos_by_session = {}
    for row in mos_responses:
        mos_by_session.setdefault(row["session_id"], []).append(row)
    sus_by_session = {}
    for row in sus_responses:
        sus_by_session.setdefault(row["session_id"], []).append(row)

    active_tests = []
    for row in tests:
        if row["status"] != "published":
            continue
        test_sessions_rows = test_sessions.get(row["id"], [])
        completed = [item for item in test_sessions_rows if item["status"] == "completed"]
        completed_ids = {item["id"] for item in completed}
        test_mos = [item["rating"] for session_id in completed_ids for item in mos_by_session.get(session_id, []) if item["rating"] is not None]
        test_sus = [item["wacc"] for session_id in completed_ids for item in sus_by_session.get(session_id, []) if item["wacc"] is not None]
        active_tests.append({
            "id": row["id"], "name": row["name"], "version": row["version"], "status": row["status"],
            "access_code": row["access_code"], "stimuli_count": len(test_stimuli.get(row["id"], [])),
            "created_at": row["created_at"].isoformat() if row["created_at"] else None,
            "sessions_started": len(test_sessions_rows), "sessions_completed": len(completed),
            "mos_mean": round(sum(test_mos) / len(test_mos), 2) if test_mos else None,
            "sus_wacc_mean": round(sum(test_sus) / len(test_sus), 4) if test_sus else None,
        })

    engine_benchmarks = []
    for row in engines:
        engine_stimuli = [item for item in stimuli if item["engine_id"] == row["id"]]
        stimulus_ids_for_engine = {item["id"] for item in engine_stimuli}
        engine_mos = [item["rating"] for item in mos_responses if item["stimulus_id"] in stimulus_ids_for_engine and item["rating"] is not None]
        engine_sus = [item["wacc"] for item in sus_responses if item["stimulus_id"] in stimulus_ids_for_engine and item["wacc"] is not None]
        engine_benchmarks.append({
            "id": row["id"], "name": row["name"], "description": row["description"],
            "mos_n": len(engine_mos), "mos_mean": round(sum(engine_mos) / len(engine_mos), 2) if engine_mos else None,
            "mos_stddev": round(_stddev(engine_mos), 3) if len(engine_mos) > 1 else (0.0 if engine_mos else None),
            "sus_n": len(engine_sus), "sus_wacc_mean": round(sum(engine_sus) / len(engine_sus), 4) if engine_sus else None,
            "stimuli_count": len(engine_stimuli),
        })

    test_by_id = {row["id"]: row for row in tests}
    recent_activity = []
    for row in sessions[:10]:
        test_row = test_by_id.get(row["test_id"])
        duration = int((row["completed_at"] - row["created_at"]).total_seconds()) if row["completed_at"] and row["created_at"] else None
        recent_activity.append({
            "id": row["id"], "test_id": row["test_id"], "test_name": test_row["name"] if test_row else f"Test {row['test_id']}",
            "status": row["status"], "created_at": row["created_at"].isoformat() if row["created_at"] else None,
            "completed_at": row["completed_at"].isoformat() if row["completed_at"] else None,
            "duration_seconds": duration, "mos_responses_count": len(mos_by_session.get(row["id"], [])),
            "sus_responses_count": len(sus_by_session.get(row["id"], [])),
        })

    readiness = {
        "engines": {"count": len(engines), "ready": bool(engines)},
        "mos_scales": {"count": len(mos_scales), "ready": bool(mos_scales)},
        "demographics": {"count": len(demo_fields), "ready": bool(demo_fields)},
        "text_templates": {"count": len(templates), "ready": bool(templates)},
        "audio_assets": {"count": len(audio_assets), "ready": bool(audio_assets)},
        "tests": {"count": total_tests, "ready": bool(tests)},
        "has_published_test": published_tests > 0,
    }
    return {"metrics": metrics, "active_tests": active_tests, "engine_benchmarks": engine_benchmarks, "recent_activity": recent_activity, "readiness": readiness}


@router.get("/dashboard")
async def dashboard(request: Request) -> JSONResponse:
    if error := admin_required(request):
        return error
    try:
        with request.app.state.session_factory() as session:
            return JSONResponse(_dashboard_payload(session), status_code=200)
    except SQLAlchemyError:
        return JSONResponse({"error": "internal server error"}, status_code=500)