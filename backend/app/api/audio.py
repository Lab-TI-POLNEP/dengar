"""Admin audio library endpoints for FastAPI parallel backend.

Implements upload, list, get, update (PATCH), stream, and soft-delete.
"""

from __future__ import annotations

import hashlib
import json
import logging
import mimetypes
import secrets
from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated, Any

from fastapi import APIRouter, File, Form, Request, UploadFile
from fastapi.responses import JSONResponse, Response
from sqlalchemy import MetaData, Table, select, update
from sqlalchemy.exc import SQLAlchemyError

from ..services.media_service import resolve_stored_path, stream_media_file
from .auth import admin_required, csrf_failure

router = APIRouter(prefix="/admin/api/audio")


def utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)

logger = logging.getLogger("dengar.api.audio")

ALLOWED_EXTENSIONS = {".wav", ".mp3", ".ogg", ".flac", ".m4a"}
DEFAULT_MAX_UPLOAD_MB = 100
MAX_UPLOAD_BYTES = 100 * 1024 * 1024  # upper bound for the streaming cap


def _table(session, name: str) -> Table:
    return Table(name, MetaData(), autoload_with=session.bind)


def _serialize_asset(record: dict[str, Any]) -> dict[str, Any]:
    created_at = record.get("created_at")
    return {
        "id": record["id"],
        "original_filename": record["original_filename"],
        "content_type": record["content_type"],
        "size_bytes": record["size_bytes"],
        "sha256": record["sha256"],
        "engine_id": record["engine_id"],
        "reference_transcription": record.get("reference_transcription"),
        "status": record["status"],
        "created_at": created_at.isoformat() if hasattr(created_at, "isoformat") else created_at,
    }


@router.post("")
async def upload_audio(
    request: Request,
    file: Annotated[UploadFile, File()],
    engine_id: Annotated[str, Form()] = "",
):
    if error := admin_required(request):
        return error
    if error := await csrf_failure(request):
        return error

    if not file.filename:
        return JSONResponse({"error": "file: required"}, status_code=400)

    extension = Path(file.filename).suffix.lower()
    if extension not in ALLOWED_EXTENSIONS:
        return JSONResponse({"error": "unsupported file extension"}, status_code=415)

    limit = request.app.state.settings.max_audio_upload_mb * 1024 * 1024
    content_length = request.headers.get("content-length")
    if content_length:
        try:
            if int(content_length) > limit:
                return JSONResponse({"error": "file exceeds maximum upload size"}, status_code=413)
        except (ValueError, TypeError):
            pass

    # Stream to a temp file with a hard cap to avoid OOM on large uploads
    asset_id = secrets.token_hex(16)
    stored_filename = f"{asset_id}{extension}"
    storage_dir = Path(request.app.state.settings.audio_storage_path)
    storage_dir.mkdir(parents=True, exist_ok=True)
    target_file = storage_dir / stored_filename

    size = 0
    digest = hashlib.sha256()
    try:
        with target_file.open("wb") as out:
            while chunk := await file.read(65536):
                size += len(chunk)
                if size > limit:
                    out.close()
                    target_file.unlink(missing_ok=True)
                    return JSONResponse({"error": "file exceeds maximum upload size"}, status_code=413)
                digest.update(chunk)
                out.write(chunk)
    except OSError as exc:
        logger.warning("upload write failed for %s: %s", stored_filename, exc)
        target_file.unlink(missing_ok=True)
        return JSONResponse({"error": "internal server error"}, status_code=500)

    if size == 0:
        target_file.unlink(missing_ok=True)
        return JSONResponse({"error": "file: empty"}, status_code=400)

    engine_id_value: int | None = None
    if engine_id:
        try:
            engine_id_value = int(engine_id)
        except (TypeError, ValueError):
            target_file.unlink(missing_ok=True)
            return JSONResponse({"error": "engine_id: must be an integer"}, status_code=422)

    try:
        with request.app.state.session_factory() as session:
            if engine_id_value is not None:
                engines = _table(session, "engine")
                if session.execute(select(engines).where(engines.c.id == engine_id_value)).first() is None:
                    target_file.unlink(missing_ok=True)
                    return JSONResponse({"error": "engine_id: unknown engine"}, status_code=422)

            audio_assets = _table(session, "audio_asset")
            now = utcnow()
            values = {
                "id": asset_id,
                "original_filename": Path(file.filename).name,
                "stored_filename": stored_filename,
                "content_type": (mimetypes.guess_type(file.filename)[0] if file.filename else None) or "application/octet-stream",
                "size_bytes": size,
                "sha256": digest.hexdigest(),
                "engine_id": engine_id_value,
                "status": "active",
                "created_at": now,
                "updated_at": now,
            }
            session.execute(audio_assets.insert().values(**values))
            session.commit()

            record = session.execute(select(audio_assets).where(audio_assets.c.id == asset_id)).mappings().first()
            return JSONResponse(_serialize_asset(dict(record)), status_code=201)
    except SQLAlchemyError:
        target_file.unlink(missing_ok=True)
        return JSONResponse({"error": "internal server error"}, status_code=500)


@router.get("")
async def list_audio(request: Request):
    if error := admin_required(request):
        return error
    try:
        with request.app.state.session_factory() as session:
            audio_assets = _table(session, "audio_asset")
            records = session.execute(
                select(audio_assets)
                .where(audio_assets.c.status == "active")
                .order_by(audio_assets.c.created_at.desc())
            ).mappings().all()
            items = [_serialize_asset(dict(r)) for r in records]
            return JSONResponse({"items": items}, status_code=200)
    except SQLAlchemyError:
        return JSONResponse({"error": "internal server error"}, status_code=500)


@router.get("/{asset_id}")
async def get_audio(request: Request, asset_id: str):
    if error := admin_required(request):
        return error
    try:
        with request.app.state.session_factory() as session:
            audio_assets = _table(session, "audio_asset")
            record = session.execute(
                select(audio_assets).where(audio_assets.c.id == asset_id)
            ).mappings().first()
            if record is None or record["status"] != "active":
                return JSONResponse({"error": "asset not found"}, status_code=404)
            return JSONResponse(_serialize_asset(dict(record)), status_code=200)
    except SQLAlchemyError:
        return JSONResponse({"error": "internal server error"}, status_code=500)


@router.patch("/{asset_id}")
async def update_audio(request: Request, asset_id: str):
    if error := admin_required(request):
        return error
    if error := await csrf_failure(request):
        return error

    body = await request.body()
    if not body:
        payload = {}
    else:
        try:
            payload = json.loads(body)
        except ValueError:
            payload = {}
    if payload is None:
        payload = {}
    if not isinstance(payload, dict):
        return JSONResponse({"error": "payload: must be a JSON object"}, status_code=400)

    if (
        "reference_transcription" in payload
        and payload["reference_transcription"] is not None
        and not isinstance(payload["reference_transcription"], str)
    ):
        return JSONResponse({"error": "reference_transcription: must be a string"}, status_code=422)
    if (
        "engine_id" in payload
        and payload["engine_id"] is not None
        and (isinstance(payload["engine_id"], bool) or not isinstance(payload["engine_id"], int))
    ):
        return JSONResponse({"error": "engine_id: must be an integer or null"}, status_code=422)

    try:
        with request.app.state.session_factory() as session:
            audio_assets = _table(session, "audio_asset")
            record = session.execute(
                select(audio_assets).where(audio_assets.c.id == asset_id)
            ).mappings().first()
            if record is None or record["status"] != "active":
                return JSONResponse({"error": "asset not found"}, status_code=404)

            updates: dict[str, Any] = {}
            if "reference_transcription" in payload:
                updates["reference_transcription"] = payload["reference_transcription"]
            if "engine_id" in payload:
                new_engine_id = payload["engine_id"]
                if new_engine_id is not None:
                    engines = _table(session, "engine")
                    if session.execute(select(engines).where(engines.c.id == new_engine_id)).first() is None:
                        return JSONResponse({"error": "engine_id: unknown engine"}, status_code=422)
                updates["engine_id"] = new_engine_id

            if updates:
                session.execute(
                    update(audio_assets).where(audio_assets.c.id == asset_id).values(**updates)
                )
                session.commit()

            updated_record = session.execute(
                select(audio_assets).where(audio_assets.c.id == asset_id)
            ).mappings().first()
            return JSONResponse(_serialize_asset(dict(updated_record)), status_code=200)
    except SQLAlchemyError:
        return JSONResponse({"error": "internal server error"}, status_code=500)


@router.api_route("/{asset_id}/stream", methods=["GET", "HEAD"])
async def stream_audio_asset(request: Request, asset_id: str):
    if error := admin_required(request):
        return error

    try:
        with request.app.state.session_factory() as session:
            audio_assets = _table(session, "audio_asset")
            record = session.execute(
                select(audio_assets).where(audio_assets.c.id == asset_id)
            ).mappings().first()
            if record is None or record["status"] != "active":
                return JSONResponse({"error": "asset not found"}, status_code=404)

            stored_filename = record["stored_filename"]
            content_type = record["content_type"]

        storage_dir = request.app.state.settings.audio_storage_path
        path = resolve_stored_path(storage_dir, stored_filename)
        if path is None:
            return JSONResponse({"error": "invalid storage reference"}, status_code=500)
        if not path.is_file():
            return JSONResponse({"error": "asset file missing"}, status_code=410)

        return stream_media_file(request, path, content_type, stored_filename)
    except SQLAlchemyError:
        return JSONResponse({"error": "internal server error"}, status_code=500)


@router.delete("/{asset_id}")
async def delete_audio(request: Request, asset_id: str):
    if error := admin_required(request):
        return error
    if error := await csrf_failure(request):
        return error

    try:
        with request.app.state.session_factory() as session:
            audio_assets = _table(session, "audio_asset")
            record = session.execute(
                select(audio_assets).where(audio_assets.c.id == asset_id)
            ).mappings().first()
            if record is None or record["status"] != "active":
                return JSONResponse({"error": "asset not found"}, status_code=404)

            tests = _table(session, "test")
            referenced = session.execute(
                select(tests.c.id).where(
                    tests.c.config_yaml.op("LIKE")(f'%"{asset_id}"%')
                ).limit(1)
            ).first()
            if referenced is not None:
                return JSONResponse({"error": "asset is referenced by a test and cannot be deleted"}, status_code=409)

            session.execute(
                update(audio_assets).where(audio_assets.c.id == asset_id).values(status="deleted")
            )
            session.commit()

        return Response(status_code=204)
    except SQLAlchemyError:
        return JSONResponse({"error": "internal server error"}, status_code=500)
