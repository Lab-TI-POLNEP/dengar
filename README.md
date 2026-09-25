# Dengar

Dengar is an open-source, self-hosted, offline-first web platform for
subjective speech evaluation using **Mean Opinion Score (MOS)** and
**Semantically Unpredictable Sentences (SUS)** intelligibility tasks.

> In this project, SUS means **Semantically Unpredictable Sentences**.
> It does not mean System Usability Scale.

## Status

Production-ready standalone release consolidated around FastAPI and Next.js.

## Product Goals

- Self-hosted and functional on an isolated local network.
- No runtime CDN, analytics, remote API, remote font, or third-party asset.
- Anonymous respondent sessions with mandatory informed consent.
- Single-password administrator console.
- Configurable MOS scales and SUS playback quotas.
- Blind stimulus presentation and reproducible randomization.
- Indonesian WAcc scoring with S/D/I breakdown.
- Docker Compose deployment.

## Stack

- Frontend: Next.js + TypeScript strict mode.
- Backend: FastAPI + SQLAlchemy + SQLite.
- Audio: Web Audio API.
- Tests: pytest, Vitest, React Testing Library, Playwright.
- Deployment: Docker Compose.

## Quick Start

### Docker Compose (recommended)

```bash
cp .env.example .env
# Edit .env: set ADMIN_INITIAL_PASSWORD and SECRET_KEY
docker compose up --build
```

- Frontend: http://localhost:3101
- Backend API: http://localhost:4101/health
- All persistent data lives in `./data` on the host.

#### Ports

| Service | Local development | Docker Compose (host → container) |
| --- | --- | --- |
| Frontend (Next.js) | 3000 (`npm run dev`) | 3101 → 3000 |
| Backend (FastAPI) | 4000 | 4101 → 5000 |

Inside Compose the frontend reaches the backend as `http://backend:5000`
(`BACKEND_ORIGIN`, set in `docker-compose.yml`); for local development
`frontend/.env` must set `BACKEND_ORIGIN=http://localhost:4000` to match the
port the backend is started on.

### Local Development (.venv)
Run the FastAPI backend locally from repository root:

```bash
# Set up root virtual environment
python -m venv .venv
source .venv/bin/activate    # On Windows: .\.venv\Scripts\Activate.ps1

# Install dependencies
pip install -r backend/requirements.txt

# Configure (see .env.example for each variable's purpose)
cp .env.example .env         # then set ADMIN_INITIAL_PASSWORD and SECRET_KEY
# For local development, override DATA_DIR so the backend writes under ./data
# (the /data default inside .env.example targets the Compose container).
sed -i 's|^DATA_DIR=.*|DATA_DIR=./data|' .env

# Initialize database (run migrations)
python -m alembic -c alembic.ini upgrade head

# Start FastAPI development server (port 4000 — keep frontend/.env BACKEND_ORIGIN in sync)
uvicorn backend.app.main:create_app --factory --reload --port 4000

# Run tests (from the repository root; pytest.ini sets testpaths and pythonpath)
python -m pytest -q
```

All persistent data (database, audio, config exports, backups) is stored
under a single `DATA_DIR`. `.env.example` ships `DATA_DIR=/data`, which is the
path *inside* the Compose container (bind-mounted to `./data` on the host). When
the backend runs outside Docker and that path cannot be created, `Settings`
logs a warning and falls back to `<repo>/data`. See `.env.example` for details.

### Database schema

`backend/app/models.py` is the single source of truth for the schema: the
application bootstraps a fresh database with `Base.metadata.create_all` on
startup, in development and in Docker alike. The Alembic revisions under
`backend/migrations/versions/` are how an *existing* database is upgraded
(`create_all` never alters existing tables). Both must stay in agreement —
`backend/tests/test_schema_parity.py` runs `alembic upgrade head` on a scratch
database and compares the result with `Base.metadata.create_all`, so add a
migration whenever a model changes.

See [SPEC.md](SPEC.md) and [ARCHITECTURE.md](ARCHITECTURE.md) for architectural and functional specifications.

## Development Workflow

1. Create a feature branch for your changes.
2. Implement code changes with accompanying tests.
3. Verify test suites pass (`pytest` for backend, `vitest` for frontend).
4. Run integration tests or Docker Compose smoke tests before opening a pull request.

## Data Seeding (Optional)

Generate demo master data and 3 synthetic WAV audio files for local testing:

```bash
# From repository root, with .venv active
python backend/seed.py
```

This inserts (idempotent):
- 2 engines (Google TTS, Coqui TTS)
- 3 audio assets with generated WAV files in `data/audio/`
- 1 MOS scale preset (5-point)
- 3 SUS sentences
- 2 text templates (consent, completion)

Existing rows are skipped — safe to run multiple times.
Data location follows `DATA_DIR` (`./data` by default).
