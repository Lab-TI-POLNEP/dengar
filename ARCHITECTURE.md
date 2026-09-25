# Architecture

## Overview

Dengar uses a two-service architecture behind Docker Compose:

```text
Browser
  ├─ Next.js frontend (local assets only)
  └─ FastAPI API
       ├─ SQLite database volume
       ├─ audio storage volume
       └─ backup/export storage volume
```

The browser communicates only with the self-hosted frontend and FastAPI API.
The application must not depend on third-party services at runtime.

## Trust Boundaries

- Public/respondent interface: anonymous sessions with neutral labels only.
- Administrator interface: authenticated local account.
- Protected data: engine/source identities, raw configuration mapping,
  backups, and database records.
- Audio assets are served through opaque identifiers; engine identity may not
  appear in URLs, content headers, filenames, or public payloads.

## Major Components

### Frontend

Next.js with TypeScript strict mode renders public, respondent, and admin
interfaces. It uses locally bundled assets and the Web Audio API for SUS
playback controls.

### Backend

FastAPI exposes authenticated and respondent-safe APIs, owns business rules,
session state, validation, scoring, export, and backup/restore operations.
M3 adds authenticated administration APIs for master data and strict YAML test
configuration import/export.

### Database

SQLite stores configuration, test versions, sessions, responses, playback
events, admin metadata, and audit metadata. Data changes occur through
migrations.

### Data Storage

All persistent state lives under `DATA_DIR` (Docker: `/data`; local: any writable path):

- `dengar.sqlite3` — configuration, test versions, sessions, responses, playback
  events, admin account, audit metadata.
- `audio/` — uploaded audio assets keyed by opaque identifiers.
- `backups/` — timestamped ZIP archives and recovery snapshots.
- YAML test configurations are stored as database rows and exported on demand
  via the wizard; they are not kept as files in `DATA_DIR`.

The schema is defined in `backend/app/models.py` and bootstrapped with
`Base.metadata.create_all` on startup; existing databases are upgraded through
Alembic (`backend/migrations/versions/`).

## Architecture Decision Records

Store architecture decisions under `docs/adr/`. Any change to the stack,
offline guarantee, privacy boundary, authentication model, or storage strategy
requires an ADR and explicit user approval.
