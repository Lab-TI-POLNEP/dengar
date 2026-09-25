"""Environment-backed application settings."""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from pathlib import Path

logger = logging.getLogger("dengar.app")


class SettingsError(ValueError):
    """Raised when required application configuration is absent or invalid."""


def _load_root_env_if_present(env_path: Path | None = None) -> None:
    """Load root .env for development defaults without overriding explicit environment variables."""
    root_env = env_path if env_path is not None else (Path(__file__).resolve().parents[3] / ".env")
    if not root_env.is_file():
        return
    try:
        from dotenv import dotenv_values
        values = dotenv_values(root_env)
        for key, value in values.items():
            if key and value is not None and key not in os.environ:
                os.environ[key] = value
    except ImportError:
        try:
            with root_env.open("r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    key, _, val = line.partition("=")
                    key = key.strip()
                    val = val.strip().strip("\"'")
                    if key and key not in os.environ:
                        os.environ[key] = val
        except OSError:
            pass


def resolve_data_dir(value: str | Path | None, root: Path) -> Path:
    """Resolve the persistent data directory for a given project root.

    ``DATA_DIR=/data`` is the path inside the Docker container; outside Docker that
    path usually cannot be created, so fall back to ``<root>/data`` instead of
    failing at startup. Shared by the application settings and the Alembic env.
    """
    data_dir = Path(value).expanduser() if value else root / "data"
    try:
        data_dir.mkdir(parents=True, exist_ok=True)
    except OSError:
        fallback = root / "data"
        logger.warning("DATA_DIR %s is not usable; falling back to %s", data_dir, fallback)
        data_dir = fallback
        data_dir.mkdir(parents=True, exist_ok=True)
    if not os.access(data_dir, os.W_OK):
        # e.g. a ./data directory created by Docker (root-owned) while running as a
        # regular user locally: warn loudly instead of failing later with an opaque
        # "attempt to write a readonly database".
        logger.warning("DATA_DIR %s is not writable by the current user", data_dir)
    return data_dir.resolve()


def _env_bool(name: str, default: bool) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    return value.lower() in {"1", "true", "yes"}


@dataclass(frozen=True, slots=True)
class Settings:
    """Application settings.

    All persistent data lives under a single ``data_dir``:

    - ``dengar.sqlite3``  — the SQLite database file
    - ``audio/``          — uploaded audio assets
    - ``config/``         — exported YAML test configurations
    - ``backups/``        — backup archives and recovery snapshots
    """

    data_dir: Path
    admin_initial_password: str | None
    secret_key: str
    session_cookie_secure: bool
    max_audio_upload_mb: int

    @property
    def database_path(self) -> Path:
        return self.data_dir / "dengar.sqlite3"

    @property
    def database_url(self) -> str:
        return f"sqlite:///{self.database_path.as_posix()}"

    @property
    def audio_storage_path(self) -> Path:
        return self.data_dir / "audio"

    @property
    def config_storage_path(self) -> Path:
        return self.data_dir / "config"

    @property
    def backup_storage_path(self) -> Path:
        return self.data_dir / "backups"

    @classmethod
    def from_environment(cls, load_env: bool = True, env_file: Path | None = None) -> Settings:
        if load_env:
            _load_root_env_if_present(env_file)

        secret = os.environ.get("SECRET_KEY")
        if not secret:
            raise SettingsError("SECRET_KEY must be configured")
        if len(secret) < 32:
            raise SettingsError("SECRET_KEY must be at least 32 characters")

        max_upload_raw = os.environ.get("MAX_AUDIO_UPLOAD_MB")
        try:
            max_upload = int(max_upload_raw) if max_upload_raw else 100
        except ValueError:
            max_upload = 100
        if max_upload <= 0:
            raise SettingsError("MAX_AUDIO_UPLOAD_MB must be positive")

        root = Path(__file__).resolve().parents[3]
        data_dir = resolve_data_dir(os.environ.get("DATA_DIR"), root)

        return cls(
            data_dir=data_dir,
            admin_initial_password=os.environ.get("ADMIN_INITIAL_PASSWORD"),
            secret_key=secret,
            session_cookie_secure=_env_bool("SESSION_COOKIE_SECURE", False),
            max_audio_upload_mb=max_upload,
        )
