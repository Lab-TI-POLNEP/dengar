# Dengar Functional Specification

## 1. Scope

Dengar is a self-hosted, open-source, and offline-first laboratory platform
for two subjective speech-evaluation tasks:

- **MOS (Mean Opinion Score):** configurable ordinal ratings of audio stimuli.
- **SUS (Semantically Unpredictable Sentences):** sentence-level
  intelligibility tasks in which respondents listen and type a transcription.

SUS does not mean System Usability Scale in this specification.

## 2. Binding Constraints

- Runtime is entirely self-hosted and has no external online dependency.
- UI language is English only in version 1.
- Frontend: Next.js + TypeScript strict mode.
- Backend: FastAPI + Python 3.11+.
- Database: SQLite.
- Deployment: Docker Compose.
- Respondents are anonymous and use server-generated non-guessable session
  tokens. Administrators use one password-protected local account.

## 3. Respondent Flow

1. Landing page.
2. Mandatory informed consent.
3. Optional, per-test configurable demographics.
4. Volume calibration.
5. MOS task pages.
6. SUS transcription task pages.
7. Completion page.

The consent screen may never be skipped. Demographic fields are minimized by
default and may be disabled per test.

## 4. MOS Requirements

Each test configures:

- score minimum and maximum;
- human-readable label for each score point;
- whether a response is required;
- assigned stimuli and neutral labels.

Default score range is 1–5. Required responses block progression until a
valid choice is submitted.

## 5. SUS Requirements

Each SUS test configures a playback quota, defaulting to two plays.

The Web Audio player must:

- authorize a play before audio begins;
- prevent rapid-click/race conditions from consuming a play without audible
  playback;
- detect full playback using audio-context clock deltas and buffer duration;
- maintain a client state machine;
- require at least one full play before Continue unless test configuration
  explicitly changes that rule;
- report events to the server;
- permit the server to reject invalid event sequences and quota overages.

The respondent API obtains a one-time play authorization before playback and
must present that authorization when submitting SUS transcription. The server
derives the persisted play count and never trusts a client-supplied counter.

## 6. Blind Presentation

Respondents see only neutral labels such as `S1` through `Sn`.

Engine/source identity is administrator-only data and must not occur in
respondent pages, API responses, audio URLs, errors, filenames, metadata,
source maps, or browser-visible diagnostics. Stimulus order is randomized per
session using a saved server-side seed.

A blind-leak test must inspect every respondent-facing endpoint and include a
positive control showing protected administrator records retain engine data.

## 7. WAcc Scoring

WAcc equals `1 - WER`. Store raw transcription separately from normalized
transcription. Normalize Indonesian text with lowercase conversion, punctuation
removal, whitespace normalization, and supported Arabic-numeral-to-Indonesian-
word conversion. Report substitutions, deletions, and insertions.

## 8. Administrator Requirements

The authenticated administrator can:

- manage an audio library: upload, inspect, preview, replace, and delete;
- assign an administrator-managed engine to each audio library asset;
- create tests through five steps: setup, audio, stimulus assignment,
  demographics, review and publish;
- configure MOS and SUS tasks;
- manage consent and completion text;
- import/export test configuration in strict YAML;
- YAML imports reject unknown keys, enforce consent-first/completion-last page
  order, validate MOS scales and SUS quotas, and require stimulus audio keys
  to exist in the configuration manifest. Physical audio asset verification
  is deferred to M4.
- export raw and summary results to XLSX;
- create and safely restore archive backups;
- inspect results dashboard data.

YAML schema rules: reject unknown keys, validate page ordering, require consent
first and completion last, verify referenced audio, validate MOS scale and SUS
quota, and return concise user-facing validation errors.

## 9. Results and Exports

The dashboard includes session/completion counts, MOS means with 95% confidence
intervals using a documented t-distribution approach, WAcc, and S/D/I
breakdowns. Small or insufficient samples must be communicated rather than
misrepresented.

XLSX includes raw response sheets, minimum necessary session metadata, MOS
ratings, raw and normalized SUS transcription, WAcc/S/D/I, summary worksheets,
and export metadata.

## 10. Backup and Restore

A backup archive (`.zip` or `.tar.gz`) contains the SQLite database, audio,
YAML configurations, and a manifest with schema version and checksums. Restore
requires admin authentication and confirmation; validates manifest, checksums,
structure, compatibility, and storage before changing data; and creates a
recovery backup before overwrite.

M9.1 exposes authenticated backup creation at `POST /admin/api/backups` with
CSRF protection. It returns a server-generated ZIP containing a SQLite
snapshot, audio and YAML configuration files, and SHA-256 manifest entries.
M9.2 adds authenticated `GET /admin/api/backups` listing and
`GET /admin/api/backups/<filename>` download operations, along with the admin
UI controls for listing, creating, and downloading archives.
M9.3 adds authenticated, CSRF-protected `POST
/admin/api/backups/<filename>/restore`, which requires explicit confirmation,
validates archive structure, compatibility, checksums, and SQLite integrity,
creates a recovery backup, and then restores the database, audio, and YAML
configuration storage.

## 11. Nonfunctional Requirements

- Responsive, modern, accessible and keyboard-navigable UI.
- Semantic HTML, visible focus, labels, sufficient contrast, and non-color-only
  error states.
- Secure password hashing, sessions, CSRF protection, upload controls and
  server-side validation.
- Pinned dependencies and reproducible Docker Compose deployment.
- Automated tests for critical flows, blind leakage, offline dependencies,
  quota race cases, restore safety, and clean-clone startup.

## 12. Milestones

Milestones overview:

| ID | Scope |
|---|---|
| M1 | Core backend foundation, SQLite database, secure admin authentication |
| M2 | Next.js foundation, local design system, landing page |
| M3 | Test model, strict YAML schema, master data, admin configuration foundation |
| M4 | AudioAsset model; upload endpoint; list/get/stream + soft-delete; library list UI; upload/delete/preview UI |
| M5 | Test draft APIs; wizard steps 1–5 UI; stimulus assignment; publish gate |
| M6 | Session and consent models; anonymous session endpoints; blind serialization + leak tests; respondent entry/consent; demographics + calibration |
| M7 | MOS API + UI; SUS quota API + Web Audio player; anti-bypass tests |
| M8 | Text normalization; WER/WAcc + S/D/I; results summary API; dashboard UI; XLSX export |
| M9 | Backup create + UI; validated restore with recovery backup + UI |
| M10 | End-to-end critical flows, offline verification, accessibility pass |
| M11 | Documentation and release readiness |
