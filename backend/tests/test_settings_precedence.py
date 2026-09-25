from __future__ import annotations

from pathlib import Path

import pytest

from backend.app.core.config import Settings, SettingsError, resolve_data_dir


def test_environment_precedence_and_discovery(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    # Create an isolated temporary root with a test .env file
    dummy_root = tmp_path / "mock_repo"
    dummy_root.mkdir()
    fake_env = dummy_root / ".env"
    fake_env.write_text(
        "SECRET_KEY=discovered-from-dotenv-secret-at-least-32-chars\n"
        "MAX_AUDIO_UPLOAD_MB=42\n"
        "ADMIN_INITIAL_PASSWORD=dummy-password\n",
        encoding="utf-8",
    )

    # Clear environment variables
    monkeypatch.delenv("SECRET_KEY", raising=False)
    monkeypatch.delenv("MAX_AUDIO_UPLOAD_MB", raising=False)
    monkeypatch.delenv("ADMIN_INITIAL_PASSWORD", raising=False)

    # 1. Discover settings from isolated .env file
    settings = Settings.from_environment(load_env=True, env_file=fake_env)
    assert settings.secret_key == "discovered-from-dotenv-secret-at-least-32-chars"
    assert settings.max_audio_upload_mb == 42
    assert settings.admin_initial_password == "dummy-password"

    # 2. Explicit environment variable takes precedence over .env
    monkeypatch.setenv("MAX_AUDIO_UPLOAD_MB", "99")
    monkeypatch.setenv("SECRET_KEY", "explicit-process-secret-at-least-32-chars")
    settings_override = Settings.from_environment(load_env=True, env_file=fake_env)
    assert settings_override.secret_key == "explicit-process-secret-at-least-32-chars"
    assert settings_override.max_audio_upload_mb == 99


def test_unusable_data_dir_falls_back_to_repo_data(tmp_path: Path) -> None:
    root = tmp_path / "repo"
    root.mkdir()
    # A regular file where a directory path is expected makes mkdir fail with OSError,
    # mirroring DATA_DIR=/data outside Docker.
    blocker = tmp_path / "blocker"
    blocker.write_text("not a directory", encoding="utf-8")

    resolved = resolve_data_dir(blocker / "data", root)

    assert resolved == (root / "data").resolve()
    assert resolved.is_dir()


def test_missing_secret_raises_error_without_leaking(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("SECRET_KEY", raising=False)
    with pytest.raises(SettingsError) as exc_info:
        Settings.from_environment(load_env=False)
    assert "SECRET_KEY must be configured" in str(exc_info.value)
