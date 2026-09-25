# Dengar Backend (FastAPI)

FastAPI-based backend for the Dengar subjective speech evaluation platform.

## Features
- Administrator API for managing tests, audio assets, text templates, and demographic questions.
- Participant API for MOS (Mean Opinion Score) ratings and SUS (Semantically Unpredictable Sentences) transcriptions.
- Web Audio streaming with Range requests support.
- Results aggregation and XLSX export.
- Database backups and restoration.

## Running Locally

From repository root:

```bash
# Setup virtual environment
python -m venv .venv
source .venv/bin/activate

# Install dependencies
pip install -r backend/requirements.txt

# Run migrations
alembic upgrade head

# Seed initial data (optional)
python backend/seed.py

# Run server (port 4000 — keep frontend/.env BACKEND_ORIGIN in sync)
uvicorn backend.app.main:create_app --factory --port 4000 --reload
```

`alembic upgrade head` is only needed for a database that already carries data;
a fresh database is created from `app/models.py` at startup
(`Base.metadata.create_all`). `backend/tests/test_schema_parity.py` keeps both
paths in agreement.
