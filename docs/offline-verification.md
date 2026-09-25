# Offline Verification

## Runtime Requirement

Dengar must run on an isolated local network with no dependency on external
network access.

## Prohibited Runtime Dependencies

- CDN, remote fonts, analytics, remote APIs, telemetry, remote authentication,
  cloud database/storage, and third-party script/style/image resources.

## Required Audit Coverage

The future automated audit must inspect:

1. frontend source and production build output;
2. HTML, CSS, JavaScript, source maps, and static assets;
3. backend configuration and API responses;
4. Docker Compose/runtime environment;
5. browser network activity in Playwright.

## Evidence

Each offline-related milestone records command output in
evidence file. The test must include a clean-clone test in an
environment whose application containers have no outbound network route.
