"""Reference-data CRUD APIs."""

from __future__ import annotations

import json
import re

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response
from sqlalchemy import MetaData, Table, delete, func, select, update
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from yaml import YAMLError, safe_load

from .auth import admin_required, csrf_failure

router = APIRouter(prefix="/admin/api")
ENTITY_TABLES = {
    "engines": "engine",
    "mos-scales": "mos_scale_preset",
    "demographic-fields": "demographic_field_def",
    "text-templates": "text_template",
}
PREDEFINED_KEYS = {"age", "gender", "native_speaker", "normal_hearing", "experience"}


def _table(session, entity: str) -> Table | None:
    table_name = ENTITY_TABLES.get(entity)
    if table_name is None:
        return None
    return Table(table_name, MetaData(), autoload_with=session.bind)


def _unique_column(table: Table, entity: str):
    if entity in ("engines", "mos-scales"):
        return table.c.name if "name" in table.c else None
    if entity == "demographic-fields":
        return table.c.key if "key" in table.c else None
    return None


def _serialize(row, entity: str) -> dict[str, object]:
    values = dict(row)
    if entity == "mos-scales":
        values["labels"] = json.loads(values.pop("labels_json") or "[]")
    elif entity == "demographic-fields":
        raw_options = values.pop("options_json", None)
        try:
            values["options"] = json.loads(raw_options) if raw_options else []
        except (TypeError, ValueError):
            values["options"] = []
    return values


async def _json(request: Request) -> dict[str, object]:
    try:
        payload = await request.json()
    except (ValueError, UnicodeDecodeError):
        return {}
    return payload if isinstance(payload, dict) else {}


_auth_error = admin_required


def _validation(entity: str, payload: dict[str, object], existing=None) -> tuple[list[str], dict[str, object]]:
    values = dict(payload)
    errors: list[str] = []
    if entity == "engines":
        if "name" in values or existing is None:
            name = str(values.get("name") or "").strip()
            if not name:
                errors.append("name: required")
            values["name"] = name
        if "description" in values and values["description"] is not None:
            values["description"] = str(values["description"]).strip()
    elif entity == "mos-scales":
        name = str(values.get("name") or "").strip() if existing is None or "name" in values else None
        prompt = str(values.get("prompt") or "").strip() if existing is None or "prompt" in values else None
        if existing is None or "name" in values:
            if not name:
                errors.append("name: required")
            values["name"] = name
        if existing is None or "prompt" in values:
            if not prompt:
                errors.append("prompt: required")
            values["prompt"] = prompt
        if existing is None or any(key in values for key in ("min", "minimum", "max", "maximum", "labels")):
            minimum = values.get("min", values.get("minimum", existing["minimum"] if existing else None))
            maximum = values.get("max", values.get("maximum", existing["maximum"] if existing else None))
            labels = values.get("labels", json.loads(existing["labels_json"]) if existing else [])
            if isinstance(minimum, bool) or isinstance(maximum, bool) or not isinstance(minimum, int) or not isinstance(maximum, int) or minimum >= maximum:
                errors.append("min must be less than max")
            elif not isinstance(labels, list) or len(labels) != maximum - minimum + 1:
                errors.append("label count must match scale points")
            elif any(not isinstance(label, str) or not label.strip() for label in labels):
                errors.append("all labels must be non-empty strings")
            else:
                values.update(minimum=minimum, maximum=maximum, labels_json=json.dumps([label.strip() for label in labels]))
            values.pop("min", None)
            values.pop("max", None)
            values.pop("labels", None)
    elif entity == "demographic-fields":
        if existing is None or "label" in values or "name" in values:
            label = str(values.get("label", values.get("name", "")) or "").strip()
            if not label:
                errors.append("label: required")
            values["label"] = label
        if existing is None:
            key = str(values.get("key") or "").strip()
            if not key:
                key = re.sub(r"[^a-z0-9_]", "", values["label"].lower().replace(" ", "_").replace("-", "_"))
            if values["label"] and (not key or not re.match(r"^[a-z0-9_]+$", key)):
                errors.append("key: must contain lower-case letters, numbers, and underscores")
            values["key"] = key
            values.setdefault("field_type", "text")
            values.setdefault("required", False)
        elif "key" in values and values["key"] != existing["key"]:
            if existing["key"] in PREDEFINED_KEYS:
                return [f"Predefined demographic field key '{existing['key']}' cannot be changed"], values
            key = str(values["key"]).strip()
            if not key or not re.match(r"^[a-z0-9_]+$", key):
                errors.append("key: invalid format")
            values["key"] = key
        if isinstance(values.get("options"), list):
            values["options_json"] = json.dumps([str(item).strip() for item in values["options"] if str(item).strip()])
            values.pop("options", None)
    elif entity == "text-templates":
        if existing is None or "kind" in values:
            kind = str(values.get("kind") or "").strip().lower()
            if not kind:
                errors.append("kind: required")
            values["kind"] = kind
        if existing is None or "content" in values:
            content = str(values.get("content") or "").strip()
            if not content:
                errors.append("content: required")
            values["content"] = content
        if "version" in values and (not isinstance(values["version"], int) or isinstance(values["version"], bool) or values["version"] < 1):
            errors.append("version: must be a positive integer")
    return errors, values


@router.get("/{entity}")
async def list_entities(entity: str, request: Request):
    if error := _auth_error(request):
        return error
    try:
        with request.app.state.session_factory() as session:
            table = _table(session, entity)
            if table is None:
                return JSONResponse({"error": "unknown entity"}, status_code=404)
            rows = session.execute(select(table).order_by(table.c.id)).mappings()
            return JSONResponse({"items": [_serialize(row, entity) for row in rows]})
    except SQLAlchemyError:
        return JSONResponse({"error": "internal server error"}, status_code=500)


@router.post("/{entity}")
async def create_entity(entity: str, request: Request):
    if error := _auth_error(request):
        return error
    if error := await csrf_failure(request):
        return error
    payload = await _json(request)
    try:
        with request.app.state.session_factory() as session:
            table = _table(session, entity)
            if table is None:
                return JSONResponse({"error": "unknown entity"}, status_code=404)
            errors, values = _validation(entity, payload)
            if errors:
                return JSONResponse({"errors": errors}, status_code=422)
            if entity == "text-templates" and "version" not in values:
                values["version"] = (session.scalar(select(func.max(table.c.version)).where(table.c.kind == values["kind"])) or 0) + 1
            unique_column = _unique_column(table, entity)
            if unique_column is not None and session.execute(select(table).where(unique_column == values[unique_column.name])).first():
                return JSONResponse({"errors": [f"{unique_column.name}: already exists"]}, status_code=422)
            allowed = {column.name for column in table.columns if column.name != "id"}
            values = {key: value for key, value in values.items() if key in allowed}
            result = session.execute(table.insert().values(**values).returning(table)).mappings().first()
            session.commit()
            return JSONResponse(_serialize(result, entity), status_code=201)
    except IntegrityError:
        return JSONResponse({"errors": ["record could not be saved"]}, status_code=422)
    except SQLAlchemyError:
        return JSONResponse({"error": "internal server error"}, status_code=500)


@router.api_route("/{entity}/{record_id}", methods=["GET", "PUT", "DELETE"])
async def entity_detail(entity: str, record_id: int, request: Request):
    if error := _auth_error(request):
        return error
    if request.method != "GET" and (error := await csrf_failure(request)):
        return error
    try:
        with request.app.state.session_factory() as session:
            table = _table(session, entity)
            if table is None:
                return JSONResponse({"error": "unknown entity"}, status_code=404)
            row = session.execute(select(table).where(table.c.id == record_id)).mappings().first()
            if row is None:
                return JSONResponse({"error": "record not found"}, status_code=404)
            if request.method == "GET":
                return JSONResponse(_serialize(row, entity))
            if request.method == "DELETE":
                if entity == "engines":
                    stimulus = Table("test_stimulus", MetaData(), autoload_with=session.bind)
                    if session.execute(select(stimulus).where(stimulus.c.engine_id == record_id)).first():
                        return JSONResponse({"error": "record is referenced by a test"}, status_code=409)
                    audio = Table("audio_asset", MetaData(), autoload_with=session.bind)
                    session.execute(update(audio).where(audio.c.engine_id == record_id).values(engine_id=None))
                elif entity == "mos-scales":
                    tests = Table("test", MetaData(), autoload_with=session.bind)
                    for test in session.execute(select(tests)).mappings():
                        try:
                            if (safe_load(test["config_yaml"]) or {}).get("mos", {}).get("scale_id") == record_id:
                                return JSONResponse({"error": "record is referenced by a test"}, status_code=409)
                        except (AttributeError, TypeError, YAMLError):
                            pass
                elif entity == "demographic-fields":
                    if row["key"] in PREDEFINED_KEYS:
                        if row["key"] == "normal_hearing":
                            return JSONResponse({"error": "Mandatory demographic field 'normal_hearing' cannot be deleted"}, status_code=400)
                        return JSONResponse({"error": f"Predefined demographic field '{row['key']}' cannot be deleted"}, status_code=400)
                    links = Table("test_demographic_field", MetaData(), autoload_with=session.bind)
                    if session.execute(select(links).where(links.c.field_key == row["key"])).first():
                        return JSONResponse({"error": "record is referenced by a test"}, status_code=409)
                session.execute(delete(table).where(table.c.id == record_id))
                session.commit()
                return Response(status_code=204)
            payload = await _json(request)
            errors, values = _validation(entity, payload, row)
            if errors:
                return JSONResponse({"error": errors[0]}, status_code=400) if errors[0].startswith("Predefined") else JSONResponse({"errors": errors}, status_code=422)
            unique_column = _unique_column(table, entity)
            if unique_column is not None and unique_column.name in values and session.execute(select(table).where(unique_column == values[unique_column.name], table.c.id != record_id)).first():
                return JSONResponse({"errors": [f"{unique_column.name}: already exists"]}, status_code=422)
            allowed = {column.name for column in table.columns if column.name != "id"}
            values = {key: value for key, value in values.items() if key in allowed}
            result = session.execute(table.update().where(table.c.id == record_id).values(**values).returning(table)).mappings().first()
            session.commit()
            return JSONResponse(_serialize(result, entity))
    except IntegrityError:
        return JSONResponse({"errors": ["record could not be saved"]}, status_code=422)
    except SQLAlchemyError:
        return JSONResponse({"error": "internal server error"}, status_code=500)