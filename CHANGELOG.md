# Changelog

All notable changes to Dengar are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-09-25

### Added

- **Multilingual SUS Scoring**: Added evaluation and text normalization support for English (`en`) and Standard Chinese / Mandarin (`zh`) in addition to Indonesian (`id`).
  - English number-to-words conversion (0 up to millions).
  - Mandarin Chinese number-to-character conversion and CJK character-level tokenization for Character Error Rate (CER) and Character Accuracy (CAcc) evaluation.
  - Test-level `language` configuration attribute in YAML test specification (`id`, `en`, `zh`).
  - Audio language selection dropdown in the Admin Test Setup wizard and review summary card.

## [0.1.0] - 2026-09-25

Initial open-source release of Dengar, an offline-first subjective speech evaluation platform.

### Added

- **Evaluation Workflows**: Support for Mean Opinion Score (MOS) Likert scales and Semantically Unpredictable Sentences (SUS) intelligibility tests.
- **Audio Delivery & Streaming**: Web Audio API integration with server-side media streaming gates, calibration checks, and SUS playback quota enforcement.
- **Administration & Data Management**: Web console for test creation, respondent session tracking, data export (JSON/CSV/Excel), and database backup/restore.
- **Scoring**: Indonesian Word Accuracy (WAcc) scoring with Substitution/Deletion/Insertion (S/D/I) breakdown.
- **Security & Hardening**:
  - Argon2id password hashing with brute-force lockout.
  - Granular rate limiting on session resolution and starts.
  - Streaming file uploads with hard caps and strict MIME/path validation.
  - Formula injection mitigation on tabular exports.
  - Schema-parity verification test suite comparing SQLAlchemy models with Alembic migrations.
- **Deployment**: Ready-to-use Docker Compose configuration with zero external CDN or cloud dependencies.

