# Deployment Guide

## Target

Self-hosted Docker Compose deployment on a local server or workstation.

## Pre-Deployment Checklist

- Docker Engine and Docker Compose installed.
- Create `.env` from `.env.example` and fill in the secrets.
- Replace `SECRET_KEY` and `ADMIN_INITIAL_PASSWORD` with long random values.
- Choose durable host storage for `./data`.
- Restrict host access to trusted local-network users.

## Startup

```bash
cp .env.example .env
# Edit .env: set ADMIN_INITIAL_PASSWORD and SECRET_KEY
docker compose up --build -d
```

- Frontend: http://localhost:3101
- Backend API: http://localhost:4101/health

### Ports

| Service | Local development | Docker Compose (host → container) |
| --- | --- | --- |
| Frontend (Next.js) | 3000 (`npm run dev`) | 3101 → 3000 |
| Backend (FastAPI) | 4000 | 4101 → 5000 |

Inside Compose the frontend reaches the backend as `http://backend:5000`
(`BACKEND_ORIGIN`, set in `docker-compose.yml`). For local development,
`frontend/.env` must set `BACKEND_ORIGIN=http://localhost:4000`.

## Database schema

`backend/app/models.py` is the single source of truth: the application bootstraps
a fresh database with `Base.metadata.create_all` on startup, in development and in
Docker. The Alembic revisions under `backend/migrations/versions/` upgrade an
existing, populated database. Both must stay in agreement —
`backend/tests/test_schema_parity.py` compares a `create_all` database against
`alembic upgrade head`, so a model change always needs a matching migration.

Startup records the applied Alembic revision via `stamp_alembic_head()`, so a
fresh container that ran `create_all` still reports a valid Alembic version.

## Persistent storage

All persistent data (SQLite database, uploaded audio, exported YAML configs,
backup archives) lives under `DATA_DIR`. With Docker Compose this is `/data`
inside the container, bind-mounted to `./data` on the host. For local (non-Docker)
runs, set `DATA_DIR` to a writable path (e.g. `~/dengar-data`); if the path cannot
be created, the application logs a warning and falls back to `<repo>/data`.

## Upgrade path

1. Stop the stack.
2. Back up `./data`.
3. `docker compose up --build -d` (new image, same volumes).
4. Alembic migrations run automatically on startup for existing databases.
