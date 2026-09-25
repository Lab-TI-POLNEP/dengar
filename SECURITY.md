# Security Requirements

## Security Baseline

Dengar is designed for self-hosted laboratory use, but local deployment does
not eliminate security requirements.

## Authentication

- Support one administrator account.
- Provision the initial administrator through environment variables or a
  first-run setup flow; never commit credentials.
- Hash passwords with Argon2id or bcrypt.
- Use secure, HttpOnly, SameSite cookies.
- Require CSRF protection for state-changing browser requests.
- Rate-limit login failures.

## File Handling

- Allowlist supported audio formats and verify content type server-side.
- Enforce configurable upload size limits.
- Generate storage filenames server-side.
- Never use a user-controlled path.
- Reject archives with traversal paths, symlinks, malformed manifests, or
  invalid checksums during restore.

## Privacy

- Collect minimal respondent data.
- Demographics are optional and configured per test.
- Keep engine identities out of respondent-visible paths and payloads.
- Do not enable analytics or telemetry.
- Use structured logs that avoid credentials, raw passwords, and unnecessary
  respondent text.

## Secure Development

- Pin dependencies.
- Run tests, lint, type checks, secret scans, and offline audits in CI.
- Record security-relevant decisions as ADRs.
- Report vulnerabilities privately; see `.github/ISSUE_TEMPLATE/security.md`.
