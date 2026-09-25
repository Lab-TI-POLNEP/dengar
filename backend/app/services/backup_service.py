"""Backup and restore service for Dengar."""

from __future__ import annotations

import hashlib
import json
import os
import secrets
import shutil
import sqlite3
import tempfile
import zipfile
from datetime import datetime, timezone
from pathlib import Path


class BackupError(RuntimeError):
    pass


SUPPORTED_SCHEMA_VERSION = 1


def _database_path(data_dir: Path) -> Path:
    return data_dir / "dengar.sqlite3"


def _regular_files(root: Path, suffixes: set[str] | None = None) -> list[tuple[str, Path]]:
    if not root.exists():
        return []
    if not root.is_dir() or root.is_symlink():
        raise BackupError("configured storage path is not a directory")

    files: list[tuple[str, Path]] = []
    for path in sorted(root.rglob("*")):
        if path.is_symlink() or not path.is_file():
            continue
        if suffixes and path.suffix.lower() not in suffixes:
            continue
        relative = path.relative_to(root).as_posix()
        files.append((relative, path))
    return files


def _copy_sqlite_database(source: Path, destination: Path) -> None:
    if not source.is_file() or source.is_symlink():
        raise BackupError("configured database file is unavailable")
    source_connection = None
    destination_connection = None
    try:
        source_connection = sqlite3.connect(source)
        destination_connection = sqlite3.connect(destination)
        with destination_connection:
            source_connection.backup(destination_connection)
    except (OSError, sqlite3.Error) as exc:
        raise BackupError("database snapshot failed") from exc
    finally:
        if destination_connection is not None:
            destination_connection.close()
        if source_connection is not None:
            source_connection.close()


def _write_entry(archive: zipfile.ZipFile, archive_name: str, source: Path) -> dict[str, str | int]:
    digest = hashlib.sha256()
    size = 0
    with source.open("rb") as input_file, archive.open(archive_name, "w") as output_file:
        while chunk := input_file.read(1024 * 1024):
            output_file.write(chunk)
            digest.update(chunk)
            size += len(chunk)
    return {"path": archive_name, "size": size, "sha256": digest.hexdigest()}


def backup_directory(data_dir: Path) -> Path:
    return data_dir / "backups"


def create_backup(data_dir: Path, destination_dir: Path | None = None) -> Path:
    backup_dir = destination_dir or backup_directory(data_dir)
    audio_dir = data_dir / "audio"
    config_dir = data_dir / "config"
    backup_dir.mkdir(parents=True, exist_ok=True)

    database_path = _database_path(data_dir)
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    archive_path = backup_dir / f"dengar-backup-{timestamp}-{secrets.token_hex(4)}.zip"

    with tempfile.TemporaryDirectory(dir=backup_dir) as temporary_dir:
        snapshot_path = Path(temporary_dir) / "database.sqlite3"
        _copy_sqlite_database(database_path, snapshot_path)
        entries = [("database/dengar.sqlite3", snapshot_path)]
        entries.extend((f"audio/{relative}", path) for relative, path in _regular_files(audio_dir))
        entries.extend((f"config/{relative}", path) for relative, path in _regular_files(config_dir, {".yaml", ".yml"}))

        temporary_archive = Path(temporary_dir) / archive_path.name
        try:
            with zipfile.ZipFile(temporary_archive, "w", compression=zipfile.ZIP_DEFLATED) as archive:
                manifest_entries = [_write_entry(archive, name, path) for name, path in entries]
                manifest = {
                    "format": "dengar-backup",
                    "schema_version": 1,
                    "created_at": datetime.now(timezone.utc).isoformat(),
                    "files": manifest_entries,
                }
                archive.writestr(
                    "manifest.json",
                    json.dumps(manifest, indent=2, sort_keys=True).encode("utf-8"),
                )
            os.replace(temporary_archive, archive_path)
        except (OSError, ValueError, zipfile.BadZipFile) as exc:
            raise BackupError("backup archive creation failed") from exc

    return archive_path


def list_backups(data_dir: Path) -> list[dict[str, str | int]]:
    directory = backup_directory(data_dir)
    if not directory.exists():
        return []
    if not directory.is_dir() or directory.is_symlink():
        raise BackupError("configured backup path is not a directory")

    backups: list[dict[str, str | int]] = []
    for path in sorted(directory.iterdir(), key=lambda item: item.name, reverse=True):
        if path.is_symlink() or not path.is_file() or path.suffix.lower() != ".zip":
            continue
        modified_at = datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc)
        backups.append({
            "filename": path.name,
            "size_bytes": path.stat().st_size,
            "created_at": modified_at.isoformat(),
        })
    return backups


def get_backup(data_dir: Path, filename: str) -> Path:
    directory = backup_directory(data_dir)
    if not directory.exists() or not directory.is_dir() or directory.is_symlink():
        raise BackupError("configured backup path is unavailable")
    if Path(filename).name != filename or not filename.startswith("dengar-backup-") or not filename.endswith(".zip"):
        raise BackupError("invalid backup filename")

    candidate = (directory / filename).resolve()
    try:
        candidate.relative_to(directory.resolve())
    except ValueError as exc:
        raise BackupError("invalid backup filename") from exc
    if not candidate.is_file() or candidate.is_symlink():
        raise BackupError("backup archive is unavailable")
    return candidate


def delete_backup(data_dir: Path, filename: str) -> None:
    archive_path = get_backup(data_dir, filename)
    try:
        archive_path.unlink()
    except OSError as exc:
        raise BackupError("backup archive deletion failed") from exc


def _archive_entry_path(name: str) -> None:
    if not name or name.startswith("/") or "\\" in name:
        raise BackupError("backup archive contains an invalid path")
    path = Path(name)
    if any(part in ("", ".", "..") for part in path.parts):
        raise BackupError("backup archive contains an invalid path")
    if path.parts[0] not in {"database", "audio", "config"} or len(path.parts) < 2:
        raise BackupError("backup archive contains an invalid path")
    if path.parts[0] == "database" and name != "database/dengar.sqlite3":
        raise BackupError("backup archive contains an invalid path")
    if path.parts[0] == "config" and path.suffix.lower() not in {".yaml", ".yml"}:
        raise BackupError("backup archive contains an invalid path")


def _validate_archive(archive_path: Path, staging_dir: Path) -> None:
    try:
        archive = zipfile.ZipFile(archive_path)
    except (OSError, zipfile.BadZipFile) as exc:
        raise BackupError("backup archive is invalid") from exc

    with archive:
        infos = archive.infolist()
        names = [info.filename for info in infos]
        if len(names) != len(set(names)) or "manifest.json" not in names:
            raise BackupError("backup archive structure is invalid")
        manifest_info = archive.getinfo("manifest.json")
        if manifest_info.is_dir() or (manifest_info.external_attr >> 16) & 0o170000 == 0o120000:
            raise BackupError("backup archive structure is invalid")
        try:
            manifest = json.loads(archive.read(manifest_info))
        except (UnicodeDecodeError, json.JSONDecodeError, OSError, zipfile.BadZipFile) as exc:
            raise BackupError("backup manifest is invalid") from exc
        if not isinstance(manifest, dict) or manifest.get("format") != "dengar-backup":
            raise BackupError("backup manifest is invalid")
        if manifest.get("schema_version") != SUPPORTED_SCHEMA_VERSION:
            raise BackupError("backup schema version is unsupported")
        entries = manifest.get("files")
        if not isinstance(entries, list) or not entries:
            raise BackupError("backup manifest is invalid")

        manifest_names: set[str] = set()
        for entry in entries:
            if not isinstance(entry, dict) or set(entry) != {"path", "size", "sha256"}:
                raise BackupError("backup manifest is invalid")
            name = entry["path"]
            if not isinstance(name, str) or name in manifest_names:
                raise BackupError("backup manifest is invalid")
            _archive_entry_path(name)
            manifest_names.add(name)
            if name not in names:
                raise BackupError("backup manifest is incomplete")
            if not isinstance(entry["size"], int) or entry["size"] < 0:
                raise BackupError("backup manifest is invalid")
            digest = entry["sha256"]
            if not isinstance(digest, str) or len(digest) != 64:
                raise BackupError("backup manifest is invalid")
            info = archive.getinfo(name)
            if info.is_dir() or (info.external_attr >> 16) & 0o170000 == 0o120000:
                raise BackupError("backup archive structure is invalid")
            payload = archive.read(info)
            if len(payload) != entry["size"] or hashlib.sha256(payload).hexdigest() != digest:
                raise BackupError("backup checksum validation failed")
            destination = staging_dir / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(payload)

        if set(names) != manifest_names | {"manifest.json"}:
            raise BackupError("backup archive contains unexpected files")
        if "database/dengar.sqlite3" not in manifest_names:
            raise BackupError("backup database is missing")

        database = staging_dir / "database/dengar.sqlite3"
        connection = None
        try:
            connection = sqlite3.connect(database)
            result = connection.execute("PRAGMA integrity_check").fetchone()
            if not result or result[0] != "ok":
                raise BackupError("backup database is invalid")
        except (OSError, sqlite3.Error) as exc:
            raise BackupError("backup database is invalid") from exc
        finally:
            if connection is not None:
                connection.close()


def _install_database(staged_database: Path, database_path: Path, old_database: Path) -> None:
    if not database_path.exists():
        database_path.parent.mkdir(parents=True, exist_ok=True)
        os.replace(staged_database, database_path)
        return
    try:
        os.replace(database_path, old_database)
        os.replace(staged_database, database_path)
    except PermissionError:
        if old_database.exists() and not database_path.exists():
            os.replace(old_database, database_path)
        source = destination = None
        try:
            source = sqlite3.connect(staged_database)
            destination = sqlite3.connect(database_path)
            with destination:
                source.backup(destination)
        except (OSError, sqlite3.Error) as exc:
            raise BackupError("database restore failed") from exc
        finally:
            if destination is not None:
                destination.close()
            if source is not None:
                source.close()


def restore_backup(data_dir: Path, archive_path: Path) -> tuple[Path, Path]:
    database_path = _database_path(data_dir)
    audio_dir = data_dir / "audio"
    config_dir = data_dir / "config"
    for storage_path in (database_path, audio_dir, config_dir):
        if storage_path.exists() and storage_path.is_symlink():
            raise BackupError("configured storage path is invalid")
    if not archive_path.is_file() or archive_path.is_symlink():
        raise BackupError("backup archive is unavailable")

    backup_dir = backup_directory(data_dir)
    backup_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=backup_dir) as temporary_dir:
        staging_dir = Path(temporary_dir) / "staged"
        staging_dir.mkdir()
        _validate_archive(archive_path, staging_dir)
        recovery_path = create_backup(data_dir)
        old_dir = Path(temporary_dir) / "old"
        old_dir.mkdir()
        old_database = old_dir / "dengar.sqlite3"
        moved: list[tuple[Path, Path]] = []
        try:
            for live_path, staged_path in (
                (audio_dir, staging_dir / "audio"),
                (config_dir, staging_dir / "config"),
            ):
                if live_path.exists():
                    old_path = old_dir / live_path.name
                    os.replace(live_path, old_path)
                    moved.append((live_path, old_path))
                staged_path.mkdir(parents=True, exist_ok=True)
                live_path.parent.mkdir(parents=True, exist_ok=True)
                os.replace(staged_path, live_path)

            _install_database(staging_dir / "database/dengar.sqlite3", database_path, old_database)
        except (OSError, BackupError) as exc:
            for live_path, old_path in reversed(moved):
                if live_path.exists():
                    shutil.rmtree(live_path)
                os.replace(old_path, live_path)
            if old_database.exists() and not database_path.exists():
                os.replace(old_database, database_path)
            raise BackupError("restore failed") from exc
    return archive_path, recovery_path
