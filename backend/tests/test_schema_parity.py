"""Schema authority guard: the Alembic head and the SQLAlchemy models must agree.

``backend/app/models.py`` + ``Base.metadata.create_all`` bootstrap the schema at
application startup, while the Alembic revisions are how an existing database is
upgraded. The two drifting apart silently breaks upgraded deployments, so this
test pushes a scratch SQLite database to ``alembic upgrade head`` and compares
the result with ``Base.metadata.create_all`` on a second scratch database.
"""

from __future__ import annotations

import os
from pathlib import Path

from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import create_engine, inspect, text

from backend.app.models import Base

REPO_ROOT = Path(__file__).resolve().parents[2]


def _table_columns(path: Path) -> dict[str, list[tuple[str, str, bool]]]:
    """Columns per table, sorted by name: column order is not significant."""
    engine = create_engine(f"sqlite:///{path}")
    try:
        inspector = inspect(engine)
        return {
            table: sorted(
                (column["name"], str(column["type"]), bool(column["nullable"]))
                for column in inspector.get_columns(table)
            )
            for table in inspector.get_table_names()
            if table != "alembic_version"
        }
    finally:
        engine.dispose()


def _unique_columns(path: Path) -> dict[str, set[tuple[str, ...]]]:
    """Unique-protected column sets per table (inline constraints + unique indexes)."""
    engine = create_engine(f"sqlite:///{path}")
    try:
        inspector = inspect(engine)
        result: dict[str, set[tuple[str, ...]]] = {}
        for table in inspector.get_table_names():
            if table == "alembic_version":
                continue
            unique: set[tuple[str, ...]] = {
                tuple(constraint["column_names"])
                for constraint in inspector.get_unique_constraints(table)
            }
            unique |= {
                tuple(index["column_names"])
                for index in inspector.get_indexes(table)
                if index.get("unique")
            }
            result[table] = unique
        return result
    finally:
        engine.dispose()


def _head_revision() -> str:
    config = Config(str(REPO_ROOT / "alembic.ini"))
    config.set_main_option("script_location", str(REPO_ROOT / "backend/migrations"))
    heads = ScriptDirectory.from_config(config).get_heads()
    assert len(heads) == 1, f"expected a single migration head, found {heads}"
    return heads[0]


def _alembic_head_database(data_dir: Path) -> Path:
    config = Config(str(REPO_ROOT / "alembic.ini"))
    config.set_main_option("script_location", str(REPO_ROOT / "backend/migrations"))
    previous = os.environ.get("DATA_DIR")
    os.environ["DATA_DIR"] = str(data_dir)
    try:
        command.upgrade(config, "head")
    finally:
        if previous is None:
            os.environ.pop("DATA_DIR", None)
        else:
            os.environ["DATA_DIR"] = previous
    return data_dir / "dengar.sqlite3"


def _models_database(data_dir: Path) -> Path:
    engine = create_engine(f"sqlite:///{data_dir / 'dengar.sqlite3'}")
    try:
        Base.metadata.create_all(engine)
    finally:
        engine.dispose()
    return data_dir / "dengar.sqlite3"


def test_startup_stamps_alembic_head(fastapi_client) -> None:
    """A database bootstrapped by create_all must carry the migration head, so a
    later `alembic upgrade head` does not fail on already-created tables."""
    engine = fastapi_client.app.state.engine
    with engine.connect() as connection:
        revision = connection.execute(text("SELECT version_num FROM alembic_version")).scalar()

    assert revision == _head_revision()


def test_alembic_head_matches_models(tmp_path: Path) -> None:
    migrated_dir = tmp_path / "migrated"
    models_dir = tmp_path / "models"
    migrated_dir.mkdir()
    models_dir.mkdir()

    migrated_db = _alembic_head_database(migrated_dir)
    models_db = _models_database(models_dir)

    migrated_columns = _table_columns(migrated_db)
    models_columns = _table_columns(models_db)

    assert sorted(migrated_columns) == sorted(models_columns), (
        "table sets drifted: "
        f"missing from migrations={sorted(set(models_columns) - set(migrated_columns))}, "
        f"extra in migrations={sorted(set(migrated_columns) - set(models_columns))}"
    )
    for table in sorted(models_columns):
        assert migrated_columns[table] == models_columns[table], f"columns drifted for table {table!r}"

    migrated_unique = _unique_columns(migrated_db)
    models_unique = _unique_columns(models_db)
    for table in sorted(models_unique):
        # The migrations declare some unique columns as a unique index and the models
        # as an inline constraint; both enforce the same rule, so compare the column sets.
        assert migrated_unique[table] == models_unique[table], f"unique constraints drifted for table {table!r}"
