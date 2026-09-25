# Export YAML Feature

## Summary

Added an **Export YAML** button to the admin Tests page. When a test is
published, administrators can download its full configuration as a `.yaml`
file. The export is read-only — no import functionality is included.

## Changes

### Backend — `backend/app/api/tests.py`

New endpoint:

```
GET /admin/api/tests/{test_id}/export/yaml
```

- Requires admin authentication (session cookie + CSRF header).
- Returns `404` HTML for non-numeric IDs.
- Returns `404 JSON` if the test does not exist.
- Response: `application/x-yaml` with `Content-Disposition: attachment;
  filename="<sanitized_name>_v<version>.yaml"`.
- Filename is derived from the test name: non-alphanumeric characters
  (except `-` and `_`) are replaced with `_`.

### Frontend — `frontend/app/admin/tests/page.tsx`

- New `handleExportYaml(testId, name)` function.
- Button labeled **"Export YAML"** appears in the action row for
  published tests (next to "Unpublish").
- Downloads the file via `blob` + temporary `<a>` element.

## Verification

- [x] Export returns the exact `config_yaml` stored in the database.
- [x] Filename follows `<name>_v<version>.yaml` format.
- [x] `Content-Type` is `application/x-yaml`.
- [x] `Content-Disposition` triggers browser download.
- [x] Draft tests do not show the Export YAML button.
- [x] Admin-only: unauthenticated requests receive `401`.

## Notes

- The export is a direct dump of the `test.config_yaml` column. No
  transformation or re-serialization is applied.
- Import is intentionally out of scope for this feature.
