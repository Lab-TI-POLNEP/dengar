# Data Model

## Core Entities

- Administrator: one authenticated local account.
- AudioAsset: opaque ID, metadata, storage path, checksum.
- Test: versioned configuration and publication state.
- Stimulus: participant-safe neutral label and protected source mapping.
- M3 master data: Engine, SUSSentence, MOSScalePreset, DemographicFieldDef,
	and versioned TextTemplate records are administrator-managed.
- TestStimulus stores neutral labels, protected engine references, and audio
	manifest keys. Physical audio asset binding remains an M4 responsibility.
- RespondentSession: anonymous token, randomization seed, consent state.
- DemographicField / DemographicResponse: optional per-test minimal metadata.
- MOSResponse: scale value and stimulus/session references.
- SUSResponse: raw transcription, normalized text, WAcc, S/D/I.
- PlaybackEvent: server-verifiable sequence and state details.
- ExportRecord / BackupRecord: administrative audit metadata.

## Privacy Boundary

Stimulus source/engine identity belongs only to protected administrator data.
Respondent-facing records use opaque IDs and neutral labels.

M1 creates the administrator and settings tables. M3 migration 0002 adds the
test configuration, stimulus, and master-data tables. Imported configurations
are stored as drafts with a regenerated YAML artifact.
