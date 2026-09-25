"""Synchronous SQLAlchemy support for the existing database schema."""

from __future__ import annotations

import logging
from pathlib import Path

from sqlalchemy import create_engine, event, text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker

logger = logging.getLogger("dengar.app")

ALEMBIC_VERSION_DDL = (
    "CREATE TABLE IF NOT EXISTS alembic_version ("
    "version_num VARCHAR(32) NOT NULL, "
    "CONSTRAINT alembic_version_pkc PRIMARY KEY (version_num))"
)


def create_database_engine(database_url: str) -> Engine:
    is_sqlite = database_url.startswith("sqlite")
    connect_args = {"check_same_thread": False} if is_sqlite else {}
    engine = create_engine(database_url, future=True, connect_args=connect_args)

    if is_sqlite and database_url != "sqlite:///:memory:":
        @event.listens_for(engine, "connect")
        def configure_sqlite_connection(dbapi_connection, _connection_record):
            cursor = dbapi_connection.cursor()
            cursor.execute("PRAGMA journal_mode=WAL")
            cursor.execute("PRAGMA busy_timeout=5000")
            cursor.close()

    return engine


def stamp_alembic_head(engine: Engine, migrations_dir: Path) -> str | None:
    """Record the Alembic head on a database bootstrapped by ``create_all``.

    ``Base.metadata.create_all`` builds the tables but never writes ``alembic_version``,
    so a later ``alembic upgrade head`` on that database fails with "table already
    exists". Stamping the head closes the gap; it is safe because
    ``backend/tests/test_schema_parity.py`` proves the migrations and the models
    produce the same schema. An existing revision is never overwritten.
    """
    from alembic.config import Config
    from alembic.script import ScriptDirectory

    config = Config()
    config.set_main_option("script_location", str(migrations_dir))
    heads = ScriptDirectory.from_config(config).get_heads()
    if len(heads) != 1:
        logger.warning("skipping alembic stamp: expected one head, found %s", heads)
        return None
    head = heads[0]

    with engine.begin() as connection:
        connection.execute(text(ALEMBIC_VERSION_DDL))
        current = connection.execute(text("SELECT version_num FROM alembic_version")).scalars().all()
        if current:
            return current[0] if len(current) == 1 else None
        connection.execute(text("INSERT INTO alembic_version (version_num) VALUES (:revision)"), {"revision": head})
    return head


def create_session_factory(engine: Engine) -> sessionmaker[Session]:
    return sessionmaker(bind=engine, future=True, expire_on_commit=False)