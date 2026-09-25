# Test Plan

## Test Layers

- Backend unit and integration tests: pytest.
- Frontend component tests: Vitest and React Testing Library.
- Browser workflows: Playwright.
- Static checks: Ruff, ESLint, TypeScript strict type checking.
- Offline audit: scans frontend assets, configuration, and API output for
  prohibited remote dependencies.
- Security checks: dependency review, secret scan, upload/restore test cases.

## Critical Test Requirements

- Mandatory consent cannot be bypassed.
- MOS validation respects configured scales.
- SUS quota state machine handles normal, interrupted, refresh, and race cases.
- Blind-leak test catches engine identity in every respondent-facing channel.
- WAcc normalization and S/D/I calculations use representative Indonesian input.
- YAML validation rejects invalid order, unknown fields, and missing audio.
- Restore rejects malformed or unsafe archives before modifying data.
- Clean-clone Docker Compose startup succeeds by M10.
