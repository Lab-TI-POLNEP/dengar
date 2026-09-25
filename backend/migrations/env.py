from __future__ import annotations

import os
import sys
from logging.config import fileConfig
from pathlib import Path

from alembic import context
from sqlalchemy import engine_from_config, pool

PROJECT_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PROJECT_ROOT))

config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

from backend.app.core.config import _load_root_env_if_present, resolve_data_dir
from backend.app.models import Base

# Same .env resolution as the app, otherwise DATA_DIR from .env is invisible here
# and migrations target <repo>/data while the app targets /data.
_load_root_env_if_present()

target_metadata = Base.metadata


def get_url() -> str:
    # Same DATA_DIR resolution (including the non-container fallback) as the app,
    # so migrations and the application never target different databases.
    data_dir = resolve_data_dir(os.environ.get("DATA_DIR"), PROJECT_ROOT)
    return f"sqlite:///{data_dir / 'dengar.sqlite3'}"


def run_migrations_offline() -> None:
    url = get_url()
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )

    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    configuration = config.get_section(config.config_ini_section, {})
    configuration["sqlalchemy.url"] = get_url()
    connectable = engine_from_config(
        configuration,
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )

    with connectable.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata)

        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
