from __future__ import annotations

import csv
import io
import json
import logging
import re
import secrets
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response
from sqlalchemy import MetaData, Table, delete, literal, select
from sqlalchemy.exc import SQLAlchemyError
from yaml import YAMLError, safe_load

from ..services.config_service import ConfigValidationError, dump_config, parse_config, rebuild_pages
from ..services.scoring import mos_summary as _results_mos_summary
from ..services.scoring import sample_stddev as _results_stddev
from .auth import admin_required, csrf_failure

logger = logging.getLogger("dengar.app")

router = APIRouter(prefix="/admin/api")


def utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _is_valid_test_id(test_id: str) -> bool:
    """Validate test_id is a non-negative integer without sign characters."""
    return bool(re.fullmatch(r"\d+", test_id))


def _not_found() -> JSONResponse:
    """JSON error surface: HTML error pages never belong on a JSON API."""
    return JSONResponse({"error": "not found"}, status_code=404)


def _server_error() -> JSONResponse:
    return JSONResponse({"error": "internal server error"}, status_code=500)


def _table(session, name: str) -> Table:
    return Table(name, MetaData(), autoload_with=session.bind)


def _jsonable(value: Any) -> Any:
    return value.isoformat() if hasattr(value, "isoformat") else value


def _detail(row: dict[str, Any]) -> dict[str, Any]:
    try:
        config = safe_load(row["config_yaml"])
    except YAMLError:
        config = None
    return {key: _jsonable(row.get(key)) for key in ("id", "name", "version", "status", "access_code", "created_at", "updated_at")} | {"yaml": row["config_yaml"], "config": config}


def _stimulus_item(row: dict[str, Any]) -> dict[str, Any]:
    return {key: row[key] for key in ("id", "neutral_label", "engine_id", "audio_ref", "kind")}


def _row(session, table: Table, test_id: int):
    return session.execute(select(table).where(table.c.id == test_id)).mappings().first()


def _access_code(session, tests: Table) -> str:
    chars = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"
    while True:
        code = "".join(secrets.choice(chars) for _ in range(6))
        if session.execute(select(tests).where(tests.c.access_code == code)).first() is None:
            return code


async def _json(request: Request) -> dict[str, Any]:
    try:
        payload = await request.json()
    except (ValueError, UnicodeDecodeError):
        return {}
    return payload if isinstance(payload, dict) else {}


@router.get("/tests")
async def list_tests(request: Request):
    if error := admin_required(request):
        return error
    try:
        with request.app.state.session_factory() as session:
            tests = _table(session, "test")
            rows = session.execute(select(tests).order_by(tests.c.created_at.desc())).mappings()
            return JSONResponse({"items": [{key: _jsonable(row[key]) for key in ("id", "name", "version", "status", "access_code")} for row in rows]})
    except SQLAlchemyError:
        return JSONResponse({"error": "internal server error"}, status_code=500)


@router.api_route("/tests/{test_id}", methods=["GET", "PATCH", "DELETE"])
async def test_detail(test_id: str, request: Request):
    if not _is_valid_test_id(test_id):
        return _not_found()
    numeric_test_id = int(test_id)
    if error := admin_required(request):
        return error
    if request.method != "GET" and (error := await csrf_failure(request)):
        return error
    try:
        with request.app.state.session_factory() as session:
            tests = _table(session, "test")
            record = _row(session, tests, numeric_test_id)
            if record is None:
                return JSONResponse({"error": "test not found"}, status_code=404)
            if request.method == "GET":
                return JSONResponse(_detail(dict(record)))
            if request.method == "DELETE":
                respondent = _table(session, "respondent_session")
                session_ids = select(respondent.c.id).where(respondent.c.test_id == numeric_test_id)
                for child_name in (
                    "mos_response",
                    "sus_response",
                    "sus_play_authorization",
                    "respondent_stimulus_order",
                    "respondent_demographic_response",
                ):
                    child = _table(session, child_name)
                    session.execute(delete(child).where(child.c.session_id.in_(session_ids)))
                session.execute(delete(respondent).where(respondent.c.test_id == numeric_test_id))
                stimuli = _table(session, "test_stimulus")
                session.execute(delete(stimuli).where(stimuli.c.test_id == numeric_test_id))
                links = _table(session, "test_demographic_field")
                session.execute(delete(links).where(links.c.test_id == numeric_test_id))
                session.execute(delete(tests).where(tests.c.id == numeric_test_id))
                session.commit()
                return Response(status_code=204)
            payload = await _json(request)
            source, name = payload.get("yaml"), payload.get("name")
            if source is None and name is None:
                return JSONResponse({"errors": ["payload: provide 'name' and/or 'yaml'"]}, status_code=422)
            values: dict[str, Any] = {"version": record["version"] + 1, "status": "draft"}
            if source is not None:
                if not isinstance(source, str):
                    return JSONResponse({"errors": ["yaml: must be a string"]}, status_code=422)
                try:
                    config = parse_config(source)
                except ConfigValidationError as exc:
                    return JSONResponse({"errors": exc.errors}, status_code=422)
                values.update(config_yaml=dump_config(config), name=config["name"])
            elif not isinstance(name, str) or not name.strip():
                return JSONResponse({"errors": ["name: must be a non-empty string"]}, status_code=422)
            else:
                values["name"] = name.strip()
            session.execute(tests.update().where(tests.c.id == numeric_test_id).values(**values))
            session.commit()
            return JSONResponse(_detail(dict(_row(session, tests, test_id))))
    except SQLAlchemyError:
        return JSONResponse({"error": "internal server error"}, status_code=500)


@router.post("/tests")
@router.post("/tests/import")
async def create_test(request: Request):
    if error := admin_required(request):
        return error
    if error := await csrf_failure(request):
        return error
    payload = await _json(request)
    source = payload.get("yaml")
    if source is not None:
        if not isinstance(source, str):
            return JSONResponse({"errors": ["yaml: must be a string"]}, status_code=422)
        try:
            config = parse_config(source)
        except ConfigValidationError as exc:
            return JSONResponse({"errors": exc.errors}, status_code=422)
    else:
        name = (payload.get("name") or "").strip()
        if not name:
            return JSONResponse({"errors": ["name: required"]}, status_code=422)
        test_type = payload.get("test_type", "mos")
        if test_type not in ("mos", "sus", "combined", "mos_sus"):
            return JSONResponse({"errors": ["test_type: must be 'mos', 'sus', or 'combined'"]}, status_code=422)
        config = {"name": name, "test_type": test_type, "audio": {}, "pages": [{"kind": "consent", "title": "Informed consent"}, {"kind": "completion", "title": "Session complete"}]}
        if test_type in ("mos", "combined"):
            config["mos"] = {"min": 1, "max": 5, "labels": ["Bad", "Poor", "Fair", "Good", "Excellent"]}
        if test_type in ("sus", "combined"):
            config["sus"] = {"quota": 2}
    artifact = dump_config(config)
    artifact_dir: Path = request.app.state.settings.config_storage_path
    artifact_dir.mkdir(parents=True, exist_ok=True)
    (artifact_dir / f"{secrets.token_hex(16)}.yaml").write_text(artifact, encoding="utf-8")
    try:
        with request.app.state.session_factory() as session:
            tests, defs, links = _table(session, "test"), _table(session, "demographic_field_def"), _table(session, "test_demographic_field")
            now = utcnow()
            result = session.execute(tests.insert().values(name=config["name"], version=1, status="draft", config_yaml=artifact, created_at=now, updated_at=now).returning(tests.c.id, tests.c.name, tests.c.status)).mappings().first()
            pages = config.get("pages", [])
            demo_keys = next((page.get("fields", []) for page in pages if isinstance(page, dict) and page.get("kind") == "demographics"), [])
            if isinstance(demo_keys, list):
                for key in demo_keys:
                    if isinstance(key, str) and session.execute(select(defs).where(defs.c.key == key)).first() is None:
                        session.execute(defs.insert().values(key=key, label=key.replace("_", " ").replace("-", " ").strip().title(), field_type="text", required=False))
                    if isinstance(key, str):
                        session.execute(links.insert().from_select([links.c.test_id, links.c.field_key], select(literal(result["id"]), defs.c.key).where(defs.c.key == key)))
            session.commit()
            return JSONResponse({"id": result["id"], "name": result["name"], "status": result["status"]}, status_code=201)
    except SQLAlchemyError:
        return JSONResponse({"error": "internal server error"}, status_code=500)


@router.api_route("/tests/{test_id}/stimuli", methods=["GET", "PUT"])
async def stimuli(test_id: int, request: Request):
    if error := admin_required(request):
        return error
    if request.method != "GET" and (error := await csrf_failure(request)):
        return error
    try:
        with request.app.state.session_factory() as session:
            tests, stimuli_table, engines = _table(session, "test"), _table(session, "test_stimulus"), _table(session, "engine")
            record = _row(session, tests, test_id)
            if record is None:
                return JSONResponse({"error": "test not found"}, status_code=404)
            if request.method == "GET":
                rows = session.execute(select(stimuli_table).where(stimuli_table.c.test_id == test_id).order_by(stimuli_table.c.id)).mappings()
                return JSONResponse({"items": [_stimulus_item(row) for row in rows]})
            payload = await _json(request)
            items = payload.get("stimuli")
            if not isinstance(items, list):
                return JSONResponse({"errors": ["stimuli: required list"]}, status_code=422)
            config = safe_load(record["config_yaml"])
            if not isinstance(config, dict):
                return JSONResponse({"error": "stored configuration is invalid"}, status_code=500)
            audio = config.get("audio") if isinstance(config.get("audio"), dict) else {}
            errors, normalized = [], []
            for index, item in enumerate(items):
                if not isinstance(item, dict):
                    errors.append(f"stimuli[{index}]: must be a mapping")
                    continue
                engine_id, audio_ref, kind = item.get("engine_id"), item.get("audio_ref"), item.get("kind", "mos")
                if not isinstance(engine_id, int) or session.execute(select(engines).where(engines.c.id == engine_id)).first() is None:
                    errors.append(f"stimuli[{index}].engine_id: unknown engine")
                if not isinstance(audio_ref, str) or audio_ref not in audio:
                    errors.append(f"stimuli[{index}].audio_ref: unknown audio reference")
                if kind not in {"mos", "sus"}:
                    errors.append(f"stimuli[{index}].kind: must be 'mos' or 'sus'")
                normalized.append({"engine_id": engine_id, "audio_ref": audio_ref, "kind": kind})
            if errors:
                return JSONResponse({"errors": errors}, status_code=422)
            config["pages"] = rebuild_pages(config.get("pages", []), normalized)
            artifact = dump_config(config)
            try:
                parse_config(artifact)
            except ConfigValidationError as exc:
                return JSONResponse({"errors": exc.errors}, status_code=422)
            session.execute(delete(stimuli_table).where(stimuli_table.c.test_id == test_id))
            for position, item in enumerate(normalized):
                session.execute(stimuli_table.insert().values(test_id=test_id, neutral_label=f"S{position + 1}", **item))
            session.execute(tests.update().where(tests.c.id == test_id).values(config_yaml=artifact, status="draft"))
            session.commit()
            rows = session.execute(select(stimuli_table).where(stimuli_table.c.test_id == test_id).order_by(stimuli_table.c.id)).mappings()
            return JSONResponse({"items": [_stimulus_item(row) for row in rows]})
    except SQLAlchemyError:
        return JSONResponse({"error": "internal server error"}, status_code=500)


@router.api_route("/tests/{test_id}/demographics", methods=["GET", "PUT"])
async def demographics(test_id: int, request: Request):
    if error := admin_required(request):
        return error
    if request.method != "GET" and (error := await csrf_failure(request)):
        return error
    try:
        with request.app.state.session_factory() as session:
            tests, defs, links = _table(session, "test"), _table(session, "demographic_field_def"), _table(session, "test_demographic_field")
            record = _row(session, tests, test_id)
            if record is None:
                return JSONResponse({"error": "test not found"}, status_code=404)
            enabled = {row[0] for row in session.execute(select(links.c.field_key).where(links.c.test_id == test_id))}
            if request.method == "GET":
                rows = session.execute(select(defs).order_by(defs.c.id)).mappings()
                return JSONResponse({"items": [_demographic_item(row, enabled) for row in rows]})
            payload = await _json(request)
            keys = payload.get("keys")
            if not isinstance(keys, list):
                return JSONResponse({"errors": ["keys: required list"]}, status_code=422)
            valid = {row[0] for row in session.execute(select(defs.c.key))}
            errors = [f"keys[{index}]: must be a string" if not isinstance(key, str) else f"keys[{index}]: unknown demographic key '{key}'" for index, key in enumerate(keys) if not isinstance(key, str) or key not in valid]
            if errors:
                return JSONResponse({"errors": errors}, status_code=422)
            enabled_keys = set(keys) | {"normal_hearing"}
            config = safe_load(record["config_yaml"])
            if not isinstance(config, dict):
                return JSONResponse({"error": "stored configuration is invalid"}, status_code=500)
            pages = config.get("pages", [])
            consent_index = next((index for index, page in enumerate(pages) if isinstance(page, dict) and page.get("kind") == "consent"), -1)
            pages = [page for page in pages if not (isinstance(page, dict) and page.get("kind") == "demographics")]
            page = {"kind": "demographics", "title": "About you", "fields": sorted(enabled_keys)}
            pages.insert(consent_index + 1 if consent_index >= 0 else 0, page)
            config["pages"] = pages
            artifact = dump_config(config)
            try:
                parse_config(artifact)
            except ConfigValidationError as exc:
                return JSONResponse({"errors": exc.errors}, status_code=422)
            session.execute(delete(links).where(links.c.test_id == test_id))
            session.execute(links.insert(), [{"test_id": test_id, "field_key": key} for key in sorted(enabled_keys)])
            session.execute(tests.update().where(tests.c.id == test_id).values(config_yaml=artifact, status="draft"))
            session.commit()
            rows = session.execute(select(defs).order_by(defs.c.id)).mappings()
            enabled = {row[0] for row in session.execute(select(links.c.field_key).where(links.c.test_id == test_id))}
            return JSONResponse({"items": [_demographic_item(row, enabled, include_options=False) for row in rows]})
    except SQLAlchemyError:
        return JSONResponse({"error": "internal server error"}, status_code=500)


def _demographic_item(row: dict[str, Any], enabled: set[str], include_options: bool = True) -> dict[str, Any]:
    try:
        options = json.loads(row["options_json"]) if row["options_json"] else []
    except (TypeError, ValueError):
        options = []
    item = {"key": row["key"], "label": row["label"], "field_type": row["field_type"], "required": row["required"], "enabled": row["key"] in enabled or row["key"] == "normal_hearing"}
    if include_options:
        item["options"] = options
    return item


@router.post("/tests/{test_id}/unpublish")
async def unpublish(test_id: str, request: Request):
    if not _is_valid_test_id(test_id):
        return _not_found()
    return await _set_publish_state(int(test_id), request, "draft")


@router.post("/tests/{test_id}/publish")
async def publish(test_id: int, request: Request):
    return await _set_publish_state(test_id, request, "published")


async def _set_publish_state(test_id: int, request: Request, status: str):
    if error := admin_required(request):
        return error
    if error := await csrf_failure(request):
        return error
    try:
        with request.app.state.session_factory() as session:
            tests = _table(session, "test")
            record = _row(session, tests, test_id)
            if record is None:
                return JSONResponse({"error": "test not found"}, status_code=404)
            if status == "published":
                if record["status"] == "published":
                    return JSONResponse({"id": record["id"], "name": record["name"], "status": record["status"]})
                if record["status"] != "draft":
                    return JSONResponse({"error": f"cannot publish a test with status '{record['status']}'"}, status_code=409)

                errors: list[str] = []
                try:
                    parsed_config = parse_config(record["config_yaml"])
                except ConfigValidationError as exc:
                    parsed_config = None
                    errors.extend(exc.errors)

                stimuli = _table(session, "test_stimulus")
                stimulus_rows = list(session.execute(select(stimuli).where(stimuli.c.test_id == test_id)).mappings())
                if not stimulus_rows:
                    errors.append("At least one stimulus must be assigned before publishing.")
                else:
                    missing_engine = [row["neutral_label"] for row in stimulus_rows if row["engine_id"] is None]
                    if missing_engine:
                        errors.append(f"All stimuli must have an engine assigned. Missing: {', '.join(missing_engine)}.")

                    audio_map = parsed_config.get("audio", {}) if isinstance(parsed_config, dict) else {}
                    audio_assets = _table(session, "audio_asset")
                    for row in stimulus_rows:
                        asset_id = audio_map.get(row["audio_ref"])
                        if asset_id:
                            asset = session.execute(select(audio_assets).where(audio_assets.c.id == asset_id)).mappings().first()
                            if asset and asset["engine_id"] is None:
                                errors.append(f"Stimulus '{row['neutral_label']}' audio clip has no engine assigned in the Audio Library.")
                            if row["kind"] == "sus" and (not asset or not asset["reference_transcription"] or not asset["reference_transcription"].strip()):
                                errors.append(f"SUS stimulus '{row['neutral_label']}' must have a reference transcription in the Audio Library.")

                    config_type = parsed_config.get("test_type") if isinstance(parsed_config, dict) else None
                    has_mos = any(row["kind"] == "mos" for row in stimulus_rows)
                    has_sus = any(row["kind"] == "sus" for row in stimulus_rows)
                    if (has_mos or config_type in ("mos", "combined")) and (not parsed_config or not parsed_config.get("mos")):
                        errors.append("MOS scale must be configured before publishing.")
                    if config_type == "mos" and has_sus:
                        errors.append("A MOS test cannot contain SUS stimuli.")
                    elif config_type == "sus" and has_mos:
                        errors.append("A SUS test cannot contain MOS stimuli.")
                    elif config_type in ("combined", "mos_sus"):
                        if not has_mos:
                            errors.append("A combined test must include at least one MOS stimulus.")
                        if not has_sus:
                            errors.append("A combined test must include at least one SUS stimulus.")

                if not record["name"] or not record["name"].strip():
                    errors.insert(0, "Test name is required.")
                if errors:
                    return JSONResponse({"errors": errors}, status_code=422)
            previous_status = record["status"]
            values = {"status": status}
            if status == "published" and not record["access_code"]:
                values["access_code"] = _access_code(session, tests)
            session.execute(tests.update().where(tests.c.id == test_id).values(**values))
            session.commit()
            updated = dict(_row(session, tests, test_id))
            result = {"id": updated["id"], "name": updated["name"], "status": updated["status"]}
            if previous_status != status:
                logger.info(
                    "test publish state changed",
                    extra={
                        "test_id": test_id,
                        "from_status": previous_status,
                        "to_status": status,
                        "actor": request.session.get("admin_username"),
                    },
                )
            return JSONResponse(result)
    except SQLAlchemyError:
        logger.error("publish state change failed", extra={"test_id": test_id, "to_status": status})
        return JSONResponse({"error": "internal server error"}, status_code=500)


@router.post("/tests/{test_id}/access-code")
async def access_code(test_id: str, request: Request):
    if not _is_valid_test_id(test_id):
        return _not_found()
    numeric_test_id = int(test_id)
    if error := admin_required(request):
        return error
    if error := await csrf_failure(request):
        return error
    payload = await _json(request)
    action = payload.get("action")
    if action not in ("enable", "disable", "regenerate"):
        return JSONResponse({"error": "invalid action"}, status_code=400)
    try:
        with request.app.state.session_factory() as session:
            tests = _table(session, "test")
            record = _row(session, tests, numeric_test_id)
            if record is None:
                return JSONResponse({"error": "test not found"}, status_code=404)
            code = None if action == "disable" else (record["access_code"] or _access_code(session, tests)) if action == "enable" else _access_code(session, tests)
            session.execute(tests.update().where(tests.c.id == numeric_test_id).values(access_code=code))
            session.commit()
            return JSONResponse(_detail(dict(_row(session, tests, numeric_test_id))))
    except SQLAlchemyError:
        return _server_error()


@router.get("/tests/{test_id}/results")
async def get_test_results(test_id: str, request: Request):
    if not _is_valid_test_id(test_id):
        return _not_found()
    numeric_test_id = int(test_id)
    if error := admin_required(request):
        return error
    try:
        with request.app.state.session_factory() as session:
            test_table = _table(session, "test")
            test = _row(session, test_table, numeric_test_id)
            if not test:
                return JSONResponse({"error": "Test not found"}, status_code=404)

            stimulus_table = _table(session, "test_stimulus")
            engine_table = _table(session, "engine")
            session_table = _table(session, "respondent_session")
            mos_resp_table = _table(session, "mos_response")
            sus_resp_table = _table(session, "sus_response")
            demographic_resp_table = _table(session, "respondent_demographic_response")

            stimuli = session.execute(
                select(stimulus_table).where(stimulus_table.c.test_id == numeric_test_id)
            ).mappings().all()
            stimulus_map = {s["id"]: s for s in stimuli}

            engines = session.execute(select(engine_table)).mappings().all()
            engine_names = {e["id"]: e["name"] for e in engines}

            sessions = session.execute(
                select(session_table)
                .where(session_table.c.test_id == numeric_test_id, session_table.c.status != "deleted")
                .order_by(session_table.c.created_at.desc())
            ).mappings().all()

            sessions_started = len(sessions)
            sessions_completed = sum(1 for s in sessions if s["status"] == "completed")
            completed_session_ids = [s["id"] for s in sessions if s["status"] == "completed"]
            all_session_ids = [s["id"] for s in sessions]

            mos_by_engine: dict[int, list[float]] = {}
            mos_by_stimulus: dict[int, list[float]] = {}
            sus_by_engine: dict[int, list[float]] = {}
            sus_by_stimulus: dict[int, list[float]] = {}
            all_mos_ratings: list[float] = []
            all_sus_waccs: list[float] = []

            for s in stimuli:
                if s["kind"] == "mos":
                    mos_by_stimulus[s["id"]] = []
                    mos_by_engine.setdefault(s["engine_id"], [])
                elif s["kind"] == "sus":
                    sus_by_stimulus[s["id"]] = []
                    sus_by_engine.setdefault(s["engine_id"], [])

            if completed_session_ids:
                completed_mos = session.execute(
                    select(mos_resp_table).where(mos_resp_table.c.session_id.in_(completed_session_ids))
                ).mappings().all()
                for r in completed_mos:
                    stim = stimulus_map.get(r["stimulus_id"])
                    if stim and r["rating"] is not None:
                        mos_by_stimulus[stim["id"]].append(r["rating"])
                        mos_by_engine[stim["engine_id"]].append(r["rating"])
                        all_mos_ratings.append(r["rating"])

                completed_sus = session.execute(
                    select(sus_resp_table).where(sus_resp_table.c.session_id.in_(completed_session_ids))
                ).mappings().all()
                for r in completed_sus:
                    stim = stimulus_map.get(r["stimulus_id"])
                    if stim and r["wacc"] is not None:
                        sus_by_stimulus[stim["id"]].append(r["wacc"])
                        sus_by_engine[stim["engine_id"]].append(r["wacc"])
                        all_sus_waccs.append(r["wacc"])

            test_engine_ids = {s["engine_id"] for s in stimuli}
            engine_stats = []
            for eng_id in sorted(test_engine_ids):
                eng_name = engine_names.get(eng_id, f"Engine {eng_id}")
                mos_ratings = mos_by_engine.get(eng_id, [])
                mos_n = len(mos_ratings)
                mos_mean = sum(mos_ratings) / mos_n if mos_n > 0 else None
                mos_stddev = _results_stddev(mos_ratings) if mos_n > 1 else 0.0

                sus_waccs = sus_by_engine.get(eng_id, [])
                sus_n = len(sus_waccs)
                sus_wacc_mean = sum(sus_waccs) / sus_n if sus_n > 0 else None

                engine_stats.append({
                    "engine_id": eng_id,
                    "engine_name": eng_name,
                    "mos_n": mos_n,
                    "mos_mean": mos_mean,
                    "mos_stddev": mos_stddev,
                    "sus_n": sus_n,
                    "sus_wacc_mean": sus_wacc_mean,
                })

            stimulus_stats = []
            for s in stimuli:
                if s["kind"] == "mos":
                    ratings = mos_by_stimulus.get(s["id"], [])
                    n = len(ratings)
                    mean = sum(ratings) / n if n > 0 else None
                    stddev = _results_stddev(ratings) if n > 1 else 0.0
                    stat: dict[str, Any] = {"n": n, "mean": mean, "stddev": stddev}
                else:
                    waccs = sus_by_stimulus.get(s["id"], [])
                    n = len(waccs)
                    mean = sum(waccs) / n if n > 0 else None
                    stat = {"n": n, "wacc_mean": mean}

                stimulus_stats.append({
                    "id": s["id"],
                    "neutral_label": s["neutral_label"],
                    "kind": s["kind"],
                    "engine_id": s["engine_id"],
                    "engine_name": engine_names.get(s["engine_id"], f"Engine {s['engine_id']}"),
                    "audio_ref": s["audio_ref"],
                    "stats": stat,
                })

            # Batch load demographic responses for all non-deleted sessions
            demographics_by_session: dict[int, dict[str, str]] = {}
            if all_session_ids:
                all_demo = session.execute(
                    select(demographic_resp_table).where(
                        demographic_resp_table.c.session_id.in_(all_session_ids)
                    )
                ).mappings().all()
                for dr in all_demo:
                    demographics_by_session.setdefault(dr["session_id"], {})[dr["field_key"]] = dr["value"]

            # Batch load all responses for all non-deleted sessions preserving session order
            mos_by_session: dict[int, list[dict[str, Any]]] = {}
            sus_by_session: dict[int, list[dict[str, Any]]] = {}
            if all_session_ids:
                all_mos = session.execute(
                    select(mos_resp_table).where(mos_resp_table.c.session_id.in_(all_session_ids))
                ).mappings().all()
                for r in all_mos:
                    stim = stimulus_map.get(r["stimulus_id"])
                    if stim:
                        mos_by_session.setdefault(r["session_id"], []).append({
                            "stimulus_id": r["stimulus_id"],
                            "neutral_label": stim["neutral_label"],
                            "kind": "mos",
                            "rating": r["rating"],
                            "play_count": r["play_count"],
                        })

                all_sus = session.execute(
                    select(sus_resp_table).where(sus_resp_table.c.session_id.in_(all_session_ids))
                ).mappings().all()
                for r in all_sus:
                    stim = stimulus_map.get(r["stimulus_id"])
                    if stim:
                        sus_by_session.setdefault(r["session_id"], []).append({
                            "stimulus_id": r["stimulus_id"],
                            "neutral_label": stim["neutral_label"],
                            "kind": "sus",
                            "raw_transcription": r["raw_transcription"] or "",
                            "normalized_transcription": r["normalized_transcription"] or "",
                            "wer": 1.0 - r["wacc"] if r["wacc"] is not None else None,
                            "wacc": r["wacc"],
                            "substitutions": r["substitutions"],
                            "deletions": r["deletions"],
                            "insertions": r["insertions"],
                            "play_count": r["play_count"],
                        })

            respondent_sessions = []
            for sess in sessions:
                duration = None
                if sess["completed_at"] and sess["created_at"]:
                    duration = int((sess["completed_at"] - sess["created_at"]).total_seconds())

                responses_list = []
                responses_list.extend(mos_by_session.get(sess["id"], []))
                responses_list.extend(sus_by_session.get(sess["id"], []))

                respondent_sessions.append({
                    "id": sess["id"],
                    "token_anonymized": sess["token"][:8] + "...",
                    "status": sess["status"],
                    "created_at": sess["created_at"].isoformat() if sess["created_at"] else None,
                    "completed_at": sess["completed_at"].isoformat() if sess["completed_at"] else None,
                    "duration_seconds": duration,
                    "demographics": demographics_by_session.get(sess["id"], {}),
                    "responses": responses_list,
                })

            return JSONResponse({
                "summary": {
                    "sessions_started": sessions_started,
                    "sessions_completed": sessions_completed,
                    "mos": _results_mos_summary(all_mos_ratings),
                    "sus": {
                        "n": len(all_sus_waccs),
                        "wacc_mean": sum(all_sus_waccs) / len(all_sus_waccs) if all_sus_waccs else None,
                    },
                },
                "engines": engine_stats,
                "stimuli": stimulus_stats,
                "respondents": respondent_sessions,
            })
    except SQLAlchemyError:
        return _server_error()


def _excel_safe_value(value: Any) -> Any:
    if isinstance(value, str) and value.startswith(("=", "+", "-", "@")):
        return "'" + value
    return value


def _csv_safe_value(value: Any) -> Any:
    """Neutralise leading formula characters for CSV export.

    Uses csv.QUOTE_ALL which wraps all fields in quotes, neutralizing
    =, +, -, @, tab, comma, and other injection vectors.
    """
    if isinstance(value, str) and value.startswith(("=", "+", "-", "@", "\t")):
        return "'" + value
    return value


@router.get("/tests/{test_id}/export/yaml")
async def export_test_yaml(test_id: str, request: Request):
    """Export a single test configuration as a YAML file download."""
    if not _is_valid_test_id(test_id):
        return _not_found()
    numeric_test_id = int(test_id)
    if error := admin_required(request):
        return error
    try:
        with request.app.state.session_factory() as session:
            test_table = _table(session, "test")
            test = _row(session, test_table, numeric_test_id)
            if not test:
                return JSONResponse({"error": "Test not found"}, status_code=404)

            yaml_content = test["config_yaml"] or ""
            test_name = test["name"] or f"test-{numeric_test_id}"
            # Sanitize filename: replace non-alphanumeric with underscore
            safe_name = "".join(c if c.isalnum() or c in "-_" else "_" for c in test_name).strip("_")
            filename = f"{safe_name}_v{test['version']}.yaml"

            return Response(
                content=yaml_content.encode("utf-8"),
                media_type="application/x-yaml",
                headers={
                    "Content-Disposition": f'attachment; filename="{filename}"',
                    "Content-Length": str(len(yaml_content.encode("utf-8"))),
                },
            )
    except SQLAlchemyError:
        return _server_error()
@router.get("/tests/{test_id}/results/export")
async def export_test_results_csv(test_id: str, request: Request):
    if not _is_valid_test_id(test_id):
        return _not_found()
    numeric_test_id = int(test_id)
    if error := admin_required(request):
        return error
    try:
        with request.app.state.session_factory() as session:
            test_table = _table(session, "test")
            test = _row(session, test_table, numeric_test_id)
            if not test:
                return JSONResponse({"error": "Test not found"}, status_code=404)

            stimulus_table = _table(session, "test_stimulus")
            engine_table = _table(session, "engine")
            session_table = _table(session, "respondent_session")
            mos_resp_table = _table(session, "mos_response")
            sus_resp_table = _table(session, "sus_response")

            stimuli = session.execute(
                select(stimulus_table).where(stimulus_table.c.test_id == numeric_test_id)
            ).mappings().all()
            engines = session.execute(select(engine_table)).mappings().all()
            engine_names = {e["id"]: e["name"] for e in engines}

            sessions = session.execute(
                select(session_table)
                .where(session_table.c.test_id == numeric_test_id, session_table.c.status != "deleted")
                .order_by(session_table.c.id.asc())
            ).mappings().all()

            session_ids = [sess["id"] for sess in sessions]
            mos_responses = session.execute(
                select(mos_resp_table).where(mos_resp_table.c.session_id.in_(session_ids))
            ).mappings().all() if session_ids else []
            sus_responses = session.execute(
                select(sus_resp_table).where(sus_resp_table.c.session_id.in_(session_ids))
            ).mappings().all() if session_ids else []

            mos_by_session: dict[int, dict[int, Any]] = {}
            for r in mos_responses:
                mos_by_session.setdefault(r["session_id"], {})[r["stimulus_id"]] = r

            sus_by_session: dict[int, dict[int, Any]] = {}
            for r in sus_responses:
                sus_by_session.setdefault(r["session_id"], {})[r["stimulus_id"]] = r

            output = io.StringIO()
            output.write("\ufeff")
            writer = csv.writer(output, quoting=csv.QUOTE_ALL)

            writer.writerow([
                "Session ID",
                "Status",
                "Engine",
                "Stimulus Kind",
                "Stimulus Label",
                "MOS Rating",
                "Raw Transcription",
                "Normalized Transcription",
                "WER",
                "WAcc",
                "Substitutions",
                "Deletions",
                "Insertions",
                "Play Count",
                "Session Duration (seconds)",
            ])

            for sess in sessions:
                duration = ""
                if sess["completed_at"] and sess["created_at"]:
                    duration = str(int((sess["completed_at"] - sess["created_at"]).total_seconds()))

                sess_mos = mos_by_session.get(sess["id"], {})
                sess_sus = sus_by_session.get(sess["id"], {})

                for s in stimuli:
                    engine_name = engine_names.get(s["engine_id"], f"Engine {s['engine_id']}")

                    mos_rating = ""
                    raw_trans = ""
                    norm_trans = ""
                    wer_val = ""
                    wacc_val = ""
                    substitutions = ""
                    deletions = ""
                    insertions = ""
                    play_count = 0

                    if s["kind"] == "mos":
                        r = sess_mos.get(s["id"])
                        if r:
                            mos_rating = str(r["rating"])
                            play_count = r["play_count"]
                    elif s["kind"] == "sus":
                        r = sess_sus.get(s["id"])
                        if r:
                            raw_trans = r["raw_transcription"] or ""
                            norm_trans = r["normalized_transcription"] or ""
                            wer_val = f"{1.0 - r['wacc']:.4f}" if r["wacc"] is not None else ""
                            wacc_val = f"{r['wacc']:.4f}" if r["wacc"] is not None else ""
                            substitutions = str(r["substitutions"]) if r["substitutions"] is not None else ""
                            deletions = str(r["deletions"]) if r["deletions"] is not None else ""
                            insertions = str(r["insertions"]) if r["insertions"] is not None else ""
                            play_count = r["play_count"]

                    writer.writerow([
                        f"Session {sess['id']}",
                        sess["status"],
                        _csv_safe_value(engine_name),
                        s["kind"].upper(),
                        _csv_safe_value(s["neutral_label"]),
                        mos_rating,
                        _csv_safe_value(raw_trans),
                        _csv_safe_value(norm_trans),
                        wer_val,
                        wacc_val,
                        _csv_safe_value(substitutions),
                        _csv_safe_value(deletions),
                        _csv_safe_value(insertions),
                        play_count,
                        duration,
                    ])

            content = output.getvalue()
            return Response(
                content=content.encode("utf-8"),
                media_type="text/csv; charset=utf-8",
                headers={"Content-Disposition": f'attachment; filename="results-test-{numeric_test_id}.csv"'},
            )
    except SQLAlchemyError:
        return _server_error()


@router.get("/tests/{test_id}/results/export.xlsx")
async def export_test_results_xlsx(test_id: str, request: Request):
    if not _is_valid_test_id(test_id):
        return _not_found()
    numeric_test_id = int(test_id)
    if error := admin_required(request):
        return error
    try:
        from openpyxl import Workbook
        from openpyxl.styles import Font

        with request.app.state.session_factory() as session:
            test_table = _table(session, "test")
            test = _row(session, test_table, numeric_test_id)
            if not test:
                return JSONResponse({"error": "Test not found"}, status_code=404)

            stimulus_table = _table(session, "test_stimulus")
            engine_table = _table(session, "engine")
            session_table = _table(session, "respondent_session")
            mos_resp_table = _table(session, "mos_response")
            sus_resp_table = _table(session, "sus_response")
            demographic_resp_table = _table(session, "respondent_demographic_response")

            stimuli = session.execute(
                select(stimulus_table).where(stimulus_table.c.test_id == numeric_test_id).order_by(stimulus_table.c.id.asc())
            ).mappings().all()
            engine_names = {
                e["id"]: e["name"]
                for e in session.execute(select(engine_table)).mappings().all()
            }
            sessions = session.execute(
                select(session_table)
                .where(session_table.c.test_id == numeric_test_id, session_table.c.status != "deleted")
                .order_by(session_table.c.id.asc())
            ).mappings().all()
            session_ids = [sess["id"] for sess in sessions]

            mos_responses = session.execute(
                select(mos_resp_table).where(mos_resp_table.c.session_id.in_(session_ids))
            ).mappings().all() if session_ids else []
            sus_responses = session.execute(
                select(sus_resp_table).where(sus_resp_table.c.session_id.in_(session_ids))
            ).mappings().all() if session_ids else []
            demographics = session.execute(
                select(demographic_resp_table).where(
                    demographic_resp_table.c.session_id.in_(session_ids)
                )
            ).mappings().all() if session_ids else []

            mos_by_key = {(r["session_id"], r["stimulus_id"]): r for r in mos_responses}
            sus_by_key = {(r["session_id"], r["stimulus_id"]): r for r in sus_responses}
            demographics_by_session: dict[int, list[Any]] = {}
            for r in demographics:
                demographics_by_session.setdefault(r["session_id"], []).append(r)

            workbook = Workbook()
            responses_sheet = workbook.active
            responses_sheet.title = "Responses"
            response_headers = [
                "Session ID", "Status", "Created At", "Completed At", "Duration (seconds)",
                "Engine", "Stimulus Kind", "Stimulus Label", "MOS Rating",
                "Raw Transcription", "Normalized Transcription", "WER", "WAcc",
                "Substitutions", "Deletions", "Insertions", "Play Count",
            ]
            responses_sheet.append(response_headers)

            mos_ratings: list[float] = []
            sus_waccs: list[float] = []
            sus_substitutions = sus_deletions = sus_insertions = 0
            for sess in sessions:
                duration = None
                if sess["created_at"] and sess["completed_at"]:
                    duration = int((sess["completed_at"] - sess["created_at"]).total_seconds())
                for stimulus in stimuli:
                    mos_response = mos_by_key.get((sess["id"], stimulus["id"]))
                    sus_response = sus_by_key.get((sess["id"], stimulus["id"]))
                    mos_rating = mos_response["rating"] if mos_response else None
                    raw_transcription = normalized_transcription = None
                    wer = wacc = None
                    substitutions = deletions = insertions = None
                    play_count = 0
                    if stimulus["kind"] == "mos" and mos_response:
                        if sess["status"] == "completed":
                            mos_ratings.append(mos_response["rating"])
                        play_count = mos_response["play_count"]
                    elif stimulus["kind"] == "sus" and sus_response:
                        raw_transcription = sus_response["raw_transcription"]
                        normalized_transcription = sus_response["normalized_transcription"]
                        wacc = sus_response["wacc"]
                        wer = 1.0 - wacc if wacc is not None else None
                        substitutions = sus_response["substitutions"]
                        deletions = sus_response["deletions"]
                        insertions = sus_response["insertions"]
                        play_count = sus_response["play_count"]
                        if sess["status"] == "completed":
                            if wacc is not None:
                                sus_waccs.append(wacc)
                            sus_substitutions += substitutions or 0
                            sus_deletions += deletions or 0
                            sus_insertions += insertions or 0
                    responses_sheet.append([
                        sess["id"], sess["status"], sess["created_at"], sess["completed_at"], duration,
                        _excel_safe_value(engine_names.get(stimulus["engine_id"], f"Engine {stimulus['engine_id']}")),
                        stimulus["kind"].upper(), stimulus["neutral_label"], mos_rating,
                        _excel_safe_value(raw_transcription), _excel_safe_value(normalized_transcription),
                        wer, wacc, substitutions, deletions, insertions, play_count,
                    ])

            sessions_sheet = workbook.create_sheet("Sessions")
            sessions_sheet.append(["Session ID", "Status", "Created At", "Completed At", "Duration (seconds)", "Demographic Key", "Demographic Value"])
            for sess in sessions:
                duration = None
                if sess["created_at"] and sess["completed_at"]:
                    duration = int((sess["completed_at"] - sess["created_at"]).total_seconds())
                session_demographics = demographics_by_session.get(sess["id"], [])
                if not session_demographics:
                    sessions_sheet.append([sess["id"], sess["status"], sess["created_at"], sess["completed_at"], duration, None, None])
                for demographic in session_demographics:
                    sessions_sheet.append([
                        sess["id"], sess["status"], sess["created_at"], sess["completed_at"], duration,
                        demographic["field_key"], _excel_safe_value(demographic["value"]),
                    ])

            summary_sheet = workbook.create_sheet("Summary")
            mos_summary = _results_mos_summary(mos_ratings)
            sus_mean = sum(sus_waccs) / len(sus_waccs) if sus_waccs else None
            summary_sheet.append(["Metric", "Value"])
            summary_sheet.append(["Sessions started", len(sessions)])
            summary_sheet.append(["Sessions completed", sum(sess["status"] == "completed" for sess in sessions)])
            summary_sheet.append(["MOS ratings", mos_summary["n"]])
            summary_sheet.append(["MOS mean", mos_summary["mean"]])
            summary_sheet.append(["MOS 95% CI lower", mos_summary["ci95"]["lower"] if mos_summary["ci95"] else None])
            summary_sheet.append(["MOS 95% CI upper", mos_summary["ci95"]["upper"] if mos_summary["ci95"] else None])
            summary_sheet.append(["SUS scored responses", len(sus_waccs)])
            summary_sheet.append(["SUS WAcc mean", sus_mean])
            summary_sheet.append(["SUS substitutions", sus_substitutions])
            summary_sheet.append(["SUS deletions", sus_deletions])
            summary_sheet.append(["SUS insertions", sus_insertions])

            metadata_sheet = workbook.create_sheet("Metadata")
            metadata_sheet.append(["Field", "Value"])
            metadata_sheet.append(["Export type", "Dengar results XLSX"])
            metadata_sheet.append(["Test ID", test["id"]])
            metadata_sheet.append(["Test name", _excel_safe_value(test["name"])])
            metadata_sheet.append(["Test version", test["version"]])
            metadata_sheet.append(["Exported at (UTC)", utcnow()])

            for sheet in workbook.worksheets:
                sheet.freeze_panes = "A2"
                sheet.auto_filter.ref = sheet.dimensions
                for cell in sheet[1]:
                    cell.font = Font(bold=True)
                for column in sheet.columns:
                    width = min(max(max(len(str(cell.value or "")) for cell in column) + 2, 10), 40)
                    sheet.column_dimensions[column[0].column_letter].width = width

            output = io.BytesIO()
            workbook.save(output)
            output.seek(0)
            return Response(
                content=output.getvalue(),
                media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                headers={"Content-Disposition": f'attachment; filename="results-test-{numeric_test_id}.xlsx"'},
            )
    except SQLAlchemyError:
        return _server_error()


@router.delete("/tests/{test_id}/sessions/{session_id}")
async def delete_respondent_session(test_id: int, session_id: int, request: Request):
    if error := admin_required(request):
        return error
    if error := await csrf_failure(request):
        return error
    try:
        with request.app.state.session_factory() as session:
            respondent_sessions = _table(session, "respondent_session")
            rs = session.execute(
                select(respondent_sessions).where(
                    respondent_sessions.c.id == session_id,
                    respondent_sessions.c.test_id == test_id,
                )
            ).mappings().first()
            if rs is None:
                return JSONResponse({"error": "session not found"}, status_code=404)
            session.execute(
                respondent_sessions.update()
                .where(respondent_sessions.c.id == session_id)
                .values(status="deleted")
            )
            session.commit()
            return Response(status_code=204)
    except SQLAlchemyError:
        return _server_error()

