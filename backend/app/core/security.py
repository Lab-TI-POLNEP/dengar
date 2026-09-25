"""
Security utilities: password hashing, CSRF, login lockout, rate limiting.

WARNING: `login_states` and `request_history` are in-process globals.
They work correctly for single-worker/single-container deployments.
Multi-worker (gunicorn, uvicorn --workers) or multi-container deployments
require a shared store (Redis, database) — otherwise lockout/rate-limit
state is not shared across processes and can be bypassed.
"""

import logging
import secrets
import time
from dataclasses import dataclass, field

from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError

logger = logging.getLogger("dengar.app")
PASSWORD_HASHER = PasswordHasher()
MAX_LOGIN_FAILURES = 5
FAILURE_WINDOW_SECONDS = 15 * 60
LOCKOUT_SECONDS = 5 * 60


@dataclass
class LoginState:
    failures: list[float] = field(default_factory=list)
    lockout_until: float | None = None


login_states: dict[str, LoginState] = {}
request_history: dict[str, list[float]] = {}
MAX_TRACKED_KEYS = 2048


def hash_password(password: str) -> str:
    return PASSWORD_HASHER.hash(password)


def csrf_token(session: dict[str, object]) -> str:
    token = session.get("csrf_token")
    if not isinstance(token, str) or not token:
        token = secrets.token_urlsafe(32)
        session["csrf_token"] = token
    return token


def verify_csrf(session: dict[str, object], token: object) -> bool:
    expected = session.get("csrf_token")
    expected_str = expected if isinstance(expected, str) else ""
    return isinstance(token, str) and bool(token) and secrets.compare_digest(token, expected_str)


def verify_password(password_hash: str, password: str) -> bool:
    try:
        return PASSWORD_HASHER.verify(password_hash, password)
    except (VerifyMismatchError, ValueError):
        return False


def record_failed_attempt(key: str) -> None:
    now = time.monotonic()
    state = login_states.setdefault(key, LoginState())
    state.failures = [stamp for stamp in state.failures if stamp > now - FAILURE_WINDOW_SECONDS]
    state.failures.append(now)
    if len(state.failures) >= MAX_LOGIN_FAILURES:
        state.lockout_until = now + LOCKOUT_SECONDS
        logger.warning("login lockout triggered", extra={"key": key})
    _prune_stale_keys(now)


def is_locked_out(key: str) -> bool:
    state = login_states.get(key)
    if not state or state.lockout_until is None:
        return False
    if state.lockout_until > time.monotonic():
        return True
    state.lockout_until = None
    state.failures = [stamp for stamp in state.failures if stamp > time.monotonic() - FAILURE_WINDOW_SECONDS]
    return False


def clear_failed_attempts(key: str) -> None:
    login_states.pop(key, None)


def rate_limited(key: str, limit: int, window_seconds: float) -> bool:
    """Return True when `key` already spent `limit` requests inside the window.

    In-process sliding window. Sufficient for the single-container deployment;
    a multi-worker deployment needs a shared store.
    """
    now = time.monotonic()
    stamps = [stamp for stamp in request_history.get(key, []) if stamp > now - window_seconds]
    if len(stamps) >= limit:
        request_history[key] = stamps
        return True
    stamps.append(now)
    request_history[key] = stamps
    _prune_stale_keys(now)
    return False


def _prune_stale_keys(now: float) -> None:
    """Drop keys with no live failure and no in-window request, keeping the maps bounded."""
    if len(login_states) + len(request_history) < MAX_TRACKED_KEYS:
        return
    for key, state in list(login_states.items()):
        if state.lockout_until and state.lockout_until > now:
            continue
        if any(stamp > now - FAILURE_WINDOW_SECONDS for stamp in state.failures):
            continue
        login_states.pop(key, None)
    for key, stamps in list(request_history.items()):
        if any(stamp > now - 60.0 for stamp in stamps):
            continue
        request_history.pop(key, None)