# Contributing

## Development Principles

- Work on one feature or bugfix at a time.
- Read `SPEC.md` and `SECURITY.md` before changing code.
- Keep commits small, focused, and reviewable.
- Add or update automated tests with behavior changes.
- Update `SPEC.md` when externally observable behavior changes.
- Do not add online runtime dependencies.

## Commit Format

Use Conventional Commits:

```text
feat(mos): add configurable Likert scale
fix(sus): reject duplicate playback event
 test(api): cover invalid YAML page order
docs(spec): define restore verification
```

## Prohibited Contributions

- Credentials, real participant data, production audio, SQLite databases,
  backups, exports, or proprietary research materials.
- Unverified claims about security, blindness, usability, or performance.
- CDN, analytics, remote font, or cloud dependency at runtime.
