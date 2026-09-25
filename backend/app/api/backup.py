"""Admin backup API endpoints."""

from __future__ import annotations

import logging

from fastapi import APIRouter, Request
from fastapi.responses import FileResponse, JSONResponse, Response

from ..services.backup_service import BackupError, create_backup, delete_backup, get_backup, list_backups, restore_backup
from .auth import admin_required, csrf_failure, request_json

logger = logging.getLogger("dengar.app")

router = APIRouter(prefix="/admin/api/backups")


@router.get("")
async def get_backup_list(request: Request) -> JSONResponse:
    if error := admin_required(request):
        return error
    try:
        return JSONResponse({"items": list_backups(request.app.state.settings.data_dir)}, status_code=200)
    except (BackupError, OSError):
        return JSONResponse({"error": "backup list failed"}, status_code=500)


@router.get("/{filename}")
async def download_backup(filename: str, request: Request):
    if error := admin_required(request):
        return error
    try:
        archive_path = get_backup(request.app.state.settings.data_dir, filename)
    except (BackupError, OSError):
        return JSONResponse({"error": "backup archive unavailable"}, status_code=404)

    return FileResponse(
        path=archive_path,
        media_type="application/zip",
        filename=archive_path.name,
    )


@router.delete("/{filename}")
async def delete_backup_archive(filename: str, request: Request):
    if error := admin_required(request):
        return error
    if error := await csrf_failure(request):
        return error

    try:
        delete_backup(request.app.state.settings.data_dir, filename)
    except (BackupError, OSError):
        return JSONResponse({"error": "backup archive unavailable"}, status_code=404)

    logger.info("backup deleted", extra={"archive": filename, "actor": request.session.get("admin_username")})
    return Response(status_code=204)


@router.post("/{filename}/restore")
async def restore_backup_archive(filename: str, request: Request):
    if error := admin_required(request):
        return error
    if error := await csrf_failure(request):
        return error

    payload = await request_json(request)
    if not isinstance(payload, dict) or payload.get("confirm") is not True:
        return JSONResponse({"error": "restore confirmation required"}, status_code=400)

    try:
        archive_path = get_backup(request.app.state.settings.data_dir, filename)
    except (BackupError, OSError):
        return JSONResponse({"error": "backup archive unavailable"}, status_code=404)

    try:
        _, recovery_path = restore_backup(request.app.state.settings.data_dir, archive_path)
    except (BackupError, OSError):
        logger.error("backup restore failed", extra={"archive": archive_path.name})
        return JSONResponse({"error": "restore failed"}, status_code=400)

    # Restore replaces the database file; pooled SQLite connections still hold the
    # old inode, so drop them and let subsequent requests reconnect to the new file.
    request.app.state.engine.dispose()
    logger.info(
        "backup restored",
        extra={
            "archive": archive_path.name,
            "recovery_archive": recovery_path.name,
            "actor": request.session.get("admin_username"),
        },
    )

    return JSONResponse(
        {"restored_filename": archive_path.name, "recovery_filename": recovery_path.name},
        status_code=200,
    )


@router.post("")
async def create_backup_archive(request: Request):
    if error := admin_required(request):
        return error
    if error := await csrf_failure(request):
        return error

    try:
        archive_path = create_backup(request.app.state.settings.data_dir)
    except (BackupError, OSError):
        logger.error("backup creation failed")
        return JSONResponse({"error": "backup creation failed"}, status_code=500)

    logger.info("backup created", extra={"archive": archive_path.name, "actor": request.session.get("admin_username")})

    return FileResponse(
        path=archive_path,
        media_type="application/zip",
        filename=archive_path.name,
    )
