"""Real-Browser E2E Verification Suite for Dengar SUS Protocol Hardening.

Executes real-browser (Chromium) end-to-end integration across
Browser (Playwright) -> Next.js Frontend (port 3041) -> FastAPI Backend (port 4041) -> SQLite Database.

Scenarios tested:
  A. Normal SUS lifecycle (get-started -> consent -> calibration -> evaluate -> audio playback -> transcription -> submit -> complete)
  B. Pause/Resume with Network Accounting (Blob URL reuse, 0 extra auth/stream requests on resume)
  C. Playback Gate (Textarea & Continue gating before completed playback)
  D. Empty Transcription Submission (WAcc = 0.0 persisted, valid session progression)
  E. Lost Response After Committed Submission & Client Contract Audit (Backend idempotent replay & Frontend contract audit)
  F. Payload Conflict Detection (Same Idempotency-Key + altered payload -> HTTP 409)
"""

from __future__ import annotations

import io
import json
import math
import os
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import time
import wave
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx
from playwright.sync_api import sync_playwright
from sqlalchemy import create_engine, select, text, update
from sqlalchemy.orm import Session, sessionmaker

# Set project roots
ROOT_DIR = Path(os.environ.get("DENGAR_ROOT", Path(__file__).resolve().parent.parent))
BACKEND_DIR = ROOT_DIR / "backend"
FRONTEND_DIR = ROOT_DIR / "frontend"
OUTPUT_DIR = Path(os.environ.get("E2E_OUTPUT_DIR", ROOT_DIR / "frontend" / "test-results" / "e2e"))
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

sys.path.insert(0, str(BACKEND_DIR))
from app.models import (
    Admin,
    AudioAsset,
    Base,
    DemographicFieldDef,
    Engine,
    RespondentSession,
    RespondentStimulusOrder,
    SUSPlayAuthorization,
    SUSResponse,
    Test,
    TestStimulus,
    TextTemplate,
    utcnow,
)


def gen_pcm_wav(path: Path, duration_s: float = 1.0, freq_hz: float = 440.0) -> None:
    """Generate genuine 16kHz mono 16-bit PCM WAV decodable by Chromium."""
    sample_rate = 16000
    n_samples = int(sample_rate * duration_s)
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        buf = bytearray()
        for i in range(n_samples):
            # Soft sine wave at given frequency
            val = int(32767.0 * 0.4 * math.sin(2.0 * math.pi * freq_hz * i / sample_rate))
            buf.extend(struct.pack("<h", val))
        wf.writeframes(buf)


def wait_for_port(url: str, timeout: float = 30.0) -> bool:
    """Poll URL until server responds or timeout."""
    start = time.time()
    while time.time() - start < timeout:
        try:
            r = httpx.get(url, timeout=1.0)
            if r.status_code < 500:
                return True
        except Exception:
            pass
        time.sleep(0.3)
    return False


def seed_e2e_database(engine: Any, data_dir: Path) -> dict[str, Any]:
    """Seed clean, controlled database fixtures for SUS real browser E2E tests."""
    Base.metadata.create_all(engine)
    session_factory = sessionmaker(bind=engine)
    session: Session = session_factory()

    audio_dir = data_dir / "audio"
    audio_dir.mkdir(parents=True, exist_ok=True)

    # 1. Generate real WAV audio files
    cal_file = audio_dir / "calibration_tone.wav"
    s1_file = audio_dir / "stimulus1_tone.wav"
    s2_file = audio_dir / "stimulus2_tone.wav"
    s3_file = audio_dir / "stimulus3_tone.wav"

    gen_pcm_wav(cal_file, duration_s=1.0, freq_hz=440.0)
    gen_pcm_wav(s1_file, duration_s=1.2, freq_hz=520.0)
    gen_pcm_wav(s2_file, duration_s=2.0, freq_hz=600.0)
    gen_pcm_wav(s3_file, duration_s=1.2, freq_hz=680.0)

    # 2. Engine
    eng = Engine(name="e2e-tts-engine", description="Synthetic E2E test engine")
    session.add(eng)
    session.flush()

    # 3. AudioAsset rows
    a_cal = AudioAsset(
        id="asset-cal",
        original_filename="calibration_tone.wav",
        stored_filename="calibration_tone.wav",
        content_type="audio/wav",
        size_bytes=cal_file.stat().st_size,
        sha256="c" * 64,
        engine_id=eng.id,
        reference_transcription="kalibrasi audio",
        status="active",
        created_at=utcnow(),
        updated_at=utcnow(),
    )
    a_s1 = AudioAsset(
        id="asset-s1",
        original_filename="stimulus1_tone.wav",
        stored_filename="stimulus1_tone.wav",
        content_type="audio/wav",
        size_bytes=s1_file.stat().st_size,
        sha256="1" * 64,
        engine_id=eng.id,
        reference_transcription="kucing melompat tinggi sekali",
        status="active",
        created_at=utcnow(),
        updated_at=utcnow(),
    )
    a_s2 = AudioAsset(
        id="asset-s2",
        original_filename="stimulus2_tone.wav",
        stored_filename="stimulus2_tone.wav",
        content_type="audio/wav",
        size_bytes=s2_file.stat().st_size,
        sha256="2" * 64,
        engine_id=eng.id,
        reference_transcription="burung terbang melintasi awan",
        status="active",
        created_at=utcnow(),
        updated_at=utcnow(),
    )
    a_s3 = AudioAsset(
        id="asset-s3",
        original_filename="stimulus3_tone.wav",
        stored_filename="stimulus3_tone.wav",
        content_type="audio/wav",
        size_bytes=s3_file.stat().st_size,
        sha256="3" * 64,
        engine_id=eng.id,
        reference_transcription="suara tidak terdengar jelas",
        status="active",
        created_at=utcnow(),
        updated_at=utcnow(),
    )
    session.add_all([a_cal, a_s1, a_s2, a_s3])
    session.flush()

    # 4. Text Templates and Demographics
    t_comp = TextTemplate(
        kind="completion",
        version=1,
        content="Your speech evaluation session is finished. Your answers have been safely saved.",
    )
    t_inst = TextTemplate(
        kind="instructions",
        version=1,
        content="Please listen carefully to each audio sample and transcribe.",
    )
    t_cons = TextTemplate(
        kind="consent",
        version=1,
        content="I agree to participate in this speech evaluation study.",
    )
    df_hear = DemographicFieldDef(
        key="normal_hearing",
        label="Normal Hearing Status",
        field_type="radio",
        required=True,
        options_json='["Yes", "No"]',
    )
    session.add_all([t_comp, t_inst, t_cons, df_hear])
    session.flush()

    # 5. Tests
    # Test A: Full Lifecycle & Normal Transcription (with Calibration)
    config_a = f"""
name: SUS E2E Lifecycle Study
test_type: sus
language: id
calibration_audio_ref: cal_sample
audio:
  cal_sample: {a_cal.id}
  ref_s1: {a_s1.id}
sus:
  quota: 2
pages:
  - kind: consent
  - kind: sus
    stimuli:
      - audio_ref: ref_s1
  - kind: completion
"""
    test_a = Test(
        name="SUS E2E Lifecycle Study",
        version=1,
        status="published",
        config_yaml=config_a.strip(),
        access_code="SUSE2E",
        created_at=utcnow(),
        updated_at=utcnow(),
    )
    session.add(test_a)
    session.flush()

    stim_a1 = TestStimulus(
        test_id=test_a.id,
        neutral_label="A1",
        engine_id=eng.id,
        audio_ref="ref_s1",
        kind="sus",
    )
    session.add(stim_a1)

    # Test B: Pause/Resume with Network Accounting
    config_b = f"""
name: SUS E2E Pause Resume Study
test_type: sus
language: id
audio:
  ref_s2: {a_s2.id}
sus:
  quota: 2
pages:
  - kind: consent
  - kind: sus
    stimuli:
      - audio_ref: ref_s2
  - kind: completion
"""
    test_b = Test(
        name="SUS E2E Pause Resume Study",
        version=1,
        status="published",
        config_yaml=config_b.strip(),
        access_code="SUSPAU",
        created_at=utcnow(),
        updated_at=utcnow(),
    )
    session.add(test_b)
    session.flush()

    stim_b1 = TestStimulus(
        test_id=test_b.id,
        neutral_label="B1",
        engine_id=eng.id,
        audio_ref="ref_s2",
        kind="sus",
    )
    session.add(stim_b1)

    # Test D: Empty Transcription Study
    config_d = f"""
name: SUS E2E Empty Transcription Study
test_type: sus
language: id
audio:
  ref_s3: {a_s3.id}
sus:
  quota: 2
pages:
  - kind: consent
  - kind: sus
    stimuli:
      - audio_ref: ref_s3
  - kind: completion
"""
    test_d = Test(
        name="SUS E2E Empty Transcription Study",
        version=1,
        status="published",
        config_yaml=config_d.strip(),
        access_code="SUSEMP",
        created_at=utcnow(),
        updated_at=utcnow(),
    )
    session.add(test_d)
    session.flush()

    stim_d1 = TestStimulus(
        test_id=test_d.id,
        neutral_label="D1",
        engine_id=eng.id,
        audio_ref="ref_s3",
        kind="sus",
    )
    session.add(stim_d1)

    # Test C: Playback Gate & Quota Exhaustion Study (quota: 1)
    config_c = f"""
name: SUS E2E Playback Gate Study
test_type: sus
language: id
audio:
  ref_s2: {a_s2.id}
sus:
  quota: 1
pages:
  - kind: consent
  - kind: sus
    stimuli:
      - audio_ref: ref_s2
  - kind: completion
"""
    test_c = Test(
        name="SUS E2E Playback Gate Study",
        version=1,
        status="published",
        config_yaml=config_c.strip(),
        access_code="SUSGAT",
        created_at=utcnow(),
        updated_at=utcnow(),
    )
    session.add(test_c)
    session.flush()

    stim_c1 = TestStimulus(
        test_id=test_c.id,
        neutral_label="C1",
        engine_id=eng.id,
        audio_ref="ref_s2",
        kind="sus",
    )
    session.add(stim_c1)

    # Test E: Lost Response Replay Study (quota: 2)
    config_e = f"""
name: SUS E2E Idempotency Replay Test
test_type: sus
language: id
audio:
  ref_s1: {a_s1.id}
sus:
  quota: 2
pages:
  - kind: consent
  - kind: sus
    stimuli:
      - audio_ref: ref_s1
  - kind: completion
"""
    test_e = Test(
        name="SUS E2E Idempotency Replay Test",
        version=1,
        status="published",
        config_yaml=config_e.strip(),
        access_code="SUSEID",
        created_at=utcnow(),
        updated_at=utcnow(),
    )
    session.add(test_e)
    session.flush()

    stim_e1 = TestStimulus(
        test_id=test_e.id,
        neutral_label="E1",
        engine_id=eng.id,
        audio_ref="ref_s1",
        kind="sus",
    )
    session.add(stim_e1)

    session.commit()

    res = {
        "test_a": test_a.id,
        "test_b": test_b.id,
        "test_c": test_c.id,
        "test_d": test_d.id,
        "test_e": test_e.id,
        "stim_a1": stim_a1.id,
        "stim_b1": stim_b1.id,
        "stim_c1": stim_c1.id,
        "stim_d1": stim_d1.id,
        "stim_e1": stim_e1.id,
    }
    session.close()
    return res


def main():
    print("=== Dengar Real-Browser E2E Verification Suite ===")
    tmp_dir = tempfile.mkdtemp(prefix="dengar-e2e-")
    data_dir = Path(tmp_dir) / "data"
    data_dir.mkdir(parents=True, exist_ok=True)
    db_path = data_dir / "dengar.sqlite3"
    db_url = f"sqlite:///{db_path}"

    backend_port = 4000
    frontend_port = 3041
    backend_origin = f"http://127.0.0.1:{backend_port}"
    frontend_origin = f"http://127.0.0.1:{frontend_port}"

    print(f"Disposable data dir: {data_dir}")
    print(f"Backend origin: {backend_origin}")
    print(f"Frontend origin: {frontend_origin}")

    # Seed Database
    engine = create_engine(db_url, connect_args={"check_same_thread": False})
    with engine.connect() as conn:
        conn.execute(text("PRAGMA journal_mode=WAL"))
        conn.execute(text("PRAGMA foreign_keys=ON"))
        conn.commit()
    fixtures = seed_e2e_database(engine, data_dir)
    session_factory = sessionmaker(bind=engine)
    print("Database seeded with test fixtures.")

    backend_proc = None
    frontend_proc = None

    results: dict[str, Any] = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "browser": "Chromium (Google Chrome for Testing 153.0.8010.12)",
        "os": "Linux 6.14.0-29-generic x86_64",
        "ports": {"backend": backend_port, "frontend": frontend_port},
        "scenarios": {},
        "defects_identified": [],
    }

    try:
        # Start Backend
        backend_env = os.environ.copy()
        backend_env["DATA_DIR"] = str(data_dir)
        backend_env["SECRET_KEY"] = "super-secret-key-32-chars-for-e2e-testing!"
        backend_env["SESSION_COOKIE_SECURE"] = "false"
        backend_env["ADMIN_INITIAL_PASSWORD"] = "test-admin-password-123"

        backend_cmd = [
            sys.executable,
            "-m",
            "uvicorn",
            "app.main:create_app",
            "--factory",
            "--host",
            "127.0.0.1",
            "--port",
            str(backend_port),
            "--log-level",
            "warning",
        ]
        print(f"Starting Backend: {' '.join(backend_cmd)}")
        backend_proc = subprocess.Popen(
            backend_cmd,
            cwd=str(BACKEND_DIR),
            env=backend_env,
            start_new_session=True,
        )

        # Start Frontend
        frontend_env = os.environ.copy()
        frontend_env["BACKEND_ORIGIN"] = backend_origin
        frontend_env["PORT"] = str(frontend_port)

        frontend_cmd = ["npx", "next", "start", "-p", str(frontend_port)]
        print(f"Starting Frontend: {' '.join(frontend_cmd)}")
        frontend_proc = subprocess.Popen(
            frontend_cmd,
            cwd=str(FRONTEND_DIR),
            env=frontend_env,
            start_new_session=True,
        )

        # Wait for health
        print("Waiting for backend readiness...")
        if not wait_for_port(f"{backend_origin}/api/sessions/resolve-code?code=SUSE2E", timeout=15):
            raise RuntimeError("Backend failed to start in time.")
        print("Backend ready.")

        print("Waiting for frontend readiness...")
        if not wait_for_port(f"{frontend_origin}/get-started", timeout=20):
            raise RuntimeError("Frontend failed to start in time.")
        print("Frontend ready.")

        trace_path = OUTPUT_DIR / "browser-e2e-trace.zip"

        with sync_playwright() as p:
            browser = p.chromium.launch(
                headless=True,
                args=["--no-sandbox", "--disable-gpu", "--autoplay-policy=no-user-gesture-required"],
            )
            results["browser"] = f"Chromium (Google Chrome for Testing {browser.version})"
            context = browser.new_context(
                viewport={"width": 1280, "height": 800},
                record_video_dir=str(OUTPUT_DIR / "videos") if False else None,
            )
            context.tracing.start(screenshots=True, snapshots=True, sources=True)

            page = context.new_page()

            page_errors: list[str] = []
            console_errors: list[str] = []
            page.on("pageerror", lambda err: (page_errors.append(str(err)), print("PAGE ERROR:", err)))
            page.on("console", lambda msg: (console_errors.append(msg.text) if msg.type == "error" else None, print(f"CONSOLE [{msg.type}]: {msg.text}")))
            page.on("request", lambda r: print(f"REQ: {r.method} {r.url}"))
            page.on("response", lambda r: print(f"RESP: {r.status} {r.url}"))

            # =================================================================
            # SCENARIO A: Normal SUS Lifecycle
            # =================================================================
            print("\n--- Running Scenario A: Normal SUS Lifecycle ---")
            page.goto(f"{frontend_origin}/get-started")
            page.wait_for_selector("#access-code-input")

            # Enter access code
            page.fill("#access-code-input", "SUSE2E")
            page.click("button:has-text('Verify Code')")

            # Info step -> Consent
            page.wait_for_selector("button:has-text('Continue to Consent')")
            page.click("button:has-text('Continue to Consent')")

            # Consent step -> Demographics
            page.wait_for_selector("input[type='checkbox']")
            page.check("input[type='checkbox']")
            page.click("button:has-text('Agree and continue')")

            # Demographics step -> Start session
            page.wait_for_selector("input[id='normal_hearing-Yes']")
            page.check("input[id='normal_hearing-Yes']")
            page.click("button:has-text('Start Session')")

            # Calibration step
            page.wait_for_selector("audio")
            cal_continue_btn = page.locator("button:has-text('Continue')")
            assert cal_continue_btn.is_disabled(), "Calibration continue button must be disabled before playback"
            # Trigger audio play in calibration
            page.evaluate("() => document.querySelector('audio').play()")
            # Wait for play count to register
            page.wait_for_selector("text=Plays recorded: 1", timeout=5000)
            assert cal_continue_btn.is_enabled(), "Calibration continue button should be enabled after play recorded"
            cal_continue_btn.click()

            # Evaluate Page
            page.wait_for_url("**/evaluate", timeout=5000)
            page.wait_for_selector("text=SUS Intelligibility Task")

            # Assert Playback Gate before play
            textarea = page.locator("#sus-transcription")
            continue_btn = page.locator("button[type='submit']:has-text('Continue')")
            play_btn = page.locator("button:has-text('Play')")

            assert textarea.is_disabled(), "Gate Violation: Textarea must be disabled before playback"
            assert continue_btn.is_disabled(), "Gate Violation: Continue button must be disabled before playback"

            # Click Play and observe network
            auth_response_seen = []
            stream_response_seen = []

            def handle_response(resp):
                if "/api/sessions/sus/play-authorize" in resp.url:
                    auth_response_seen.append(resp.status)
                elif "/api/media/stream" in resp.url:
                    stream_response_seen.append(resp.status)

            page.on("response", handle_response)

            play_btn.click()

            # Wait for completed playback (audio duration 1.2s + buffer)
            print("Playing audio until completion...")
            page.wait_for_function(
                "() => document.querySelector('audio') && document.querySelector('audio').ended === true",
                timeout=6000,
            )
            time.sleep(0.5)

            # Assert playback completed state
            assert textarea.is_enabled(), "Textarea should be enabled after playback ended"
            assert continue_btn.is_enabled(), "Continue button should be enabled after playback ended"
            assert 201 in auth_response_seen, "Expected 201 Created from play-authorize"
            assert 200 in stream_response_seen, "Expected 200 OK from media stream"

            # Fill transcription and submit
            test_transcription = "kucing melompat tinggi sekali"
            textarea.fill(test_transcription)
            continue_btn.click()

            # Wait for completion screen
            page.wait_for_selector("text=Thank you.", timeout=5000)
            page.wait_for_selector("text=Session Completed")
            print("Scenario A UI completed successfully.")

            # Database Assertions for Scenario A
            with session_factory() as s:
                resp_rows = s.execute(select(SUSResponse)).scalars().all()
                auth_rows = s.execute(select(SUSPlayAuthorization)).scalars().all()
                sess_rows = s.execute(select(RespondentSession)).scalars().all()

                assert len(resp_rows) == 1, f"Expected exactly 1 SUSResponse, got {len(resp_rows)}"
                assert resp_rows[0].raw_transcription == test_transcription
                assert resp_rows[0].wacc == 1.0, f"Expected WAcc 1.0, got {resp_rows[0].wacc}"
                assert len(auth_rows) == 1
                assert auth_rows[0].status == "RETRIEVAL_STARTED", f"Expected RETRIEVAL_STARTED auth, got {auth_rows[0].status}"
                assert resp_rows[0].authorization_id == auth_rows[0].id
                assert sess_rows[0].status == "completed"

            results["scenarios"]["A_normal_lifecycle"] = {
                "status": "PASSED",
                "ui_flow": "get-started -> consent -> calibration -> evaluate -> completed",
                "audio_playback_verified": True,
                "word_accuracy": 1.0,
                "db_persisted_responses": 1,
                "auth_lifecycle_final_state": "RETRIEVAL_STARTED (Bound to SUSResponse)",
            }
            print("Scenario A Verified.")

            # =================================================================
            # SCENARIO B: Pause/Resume with Network Accounting
            # =================================================================
            print("\n--- Running Scenario B: Pause/Resume with Network Accounting ---")
            page.evaluate("() => sessionStorage.clear()")
            page.goto(f"{frontend_origin}/get-started")
            page.wait_for_selector("#access-code-input")
            page.fill("#access-code-input", "SUSPAU")
            page.click("button:has-text('Verify Code')")
            page.click("button:has-text('Continue to Consent')")
            page.wait_for_selector("input[type='checkbox']")
            page.check("input[type='checkbox']")
            page.click("button:has-text('Agree and continue')")
            page.wait_for_selector("input[id='normal_hearing-Yes']")
            page.check("input[id='normal_hearing-Yes']")
            page.click("button:has-text('Start Session')")

            page.wait_for_url("**/evaluate", timeout=5000)
            page.wait_for_selector("text=SUS Intelligibility Task")

            # Track requests strictly during audio playback
            audio_net_requests: list[dict[str, str]] = []

            def log_audio_req(req):
                if "/api/sessions/sus/play-authorize" in req.url:
                    audio_net_requests.append({"type": "authorize", "url": req.url, "method": req.method})
                elif "/api/media/stream" in req.url:
                    audio_net_requests.append({"type": "stream", "url": req.url, "method": req.method})

            page.on("request", log_audio_req)

            # 1. First Play
            page.click("button:has-text('Play')")
            time.sleep(0.3)

            # 2. First Pause
            page.click("button:has-text('Pause')")
            time.sleep(0.2)
            pos1 = page.evaluate("() => document.querySelector('audio').currentTime")
            paused1 = page.evaluate("() => document.querySelector('audio').paused")
            assert paused1 is True, "Audio should be paused"
            assert pos1 > 0.0, f"Playback should have progressed, got {pos1}"

            # 3. Resume 1
            page.click("button:has-text('Play')")
            time.sleep(0.3)

            # 4. Second Pause
            page.click("button:has-text('Pause')")
            time.sleep(0.2)
            pos2 = page.evaluate("() => document.querySelector('audio').currentTime")
            paused2 = page.evaluate("() => document.querySelector('audio').paused")
            assert paused2 is True, "Audio should be paused after second pause"
            assert pos2 >= pos1, f"Second pause position ({pos2}) should be >= first ({pos1})"

            # 5. Resume 2 -> Play to end
            page.click("button:has-text('Play')")
            page.wait_for_function(
                "() => document.querySelector('audio') && document.querySelector('audio').ended === true",
                timeout=6000,
            )
            time.sleep(0.5)

            # Verify network request counts
            auth_reqs = [r for r in audio_net_requests if r["type"] == "authorize"]
            stream_reqs = [r for r in audio_net_requests if r["type"] == "stream"]

            print(f"Scenario B Network Accounting: {len(auth_reqs)} Authorize reqs, {len(stream_reqs)} Stream reqs.")
            assert len(auth_reqs) == 1, f"Expected exactly 1 authorize request, got {len(auth_reqs)}"
            assert len(stream_reqs) == 1, f"Expected exactly 1 stream request, got {len(stream_reqs)}"

            # Submit and finish
            page.fill("#sus-transcription", "burung terbang melintasi awan")
            page.click("button[type='submit']:has-text('Continue')")
            page.wait_for_selector("text=Thank you.", timeout=5000)

            results["scenarios"]["B_pause_resume_accounting"] = {
                "status": "PASSED",
                "pause_cycles_executed": 2,
                "total_authorize_requests": len(auth_reqs),
                "total_stream_requests": len(stream_reqs),
                "extra_requests_on_resume": 0,
                "local_blob_reuse_verified": True,
            }
            print("Scenario B Verified.")

            # =================================================================
            # SCENARIO C: Playback Gate Verification
            # =================================================================
            print("\n--- Running Scenario C: Playback Gate Verification ---")
            page.evaluate("() => sessionStorage.clear()")
            page.goto(f"{frontend_origin}/get-started")
            page.wait_for_selector("#access-code-input")
            page.fill("#access-code-input", "SUSGAT")
            page.click("button:has-text('Verify Code')")
            page.click("button:has-text('Continue to Consent')")
            page.wait_for_selector("input[type='checkbox']")
            page.check("input[type='checkbox']")
            page.click("button:has-text('Agree and continue')")
            page.wait_for_selector("input[id='normal_hearing-Yes']")
            page.check("input[id='normal_hearing-Yes']")
            page.click("button:has-text('Start Session')")

            page.wait_for_url("**/evaluate", timeout=5000)
            page.wait_for_selector("text=SUS Intelligibility Task")

            c_textarea = page.locator("#sus-transcription")
            c_continue_btn = page.locator("button[type='submit']")
            c_play_btn = page.locator("button:has-text('Play')")

            # 1. Prior to playback: disabled
            assert c_textarea.is_disabled(), "Gate Violation: Textarea must be disabled before playback"
            assert c_continue_btn.is_disabled(), "Gate Violation: Continue must be disabled before playback"

            # 2. Simulate Quota Exhaustion without completed playback (429 QuotaExceeded from server)
            def handle_quota_429(route):
                route.fulfill(
                    status=429,
                    headers={"Content-Type": "application/json"},
                    body=json.dumps({"error": "Playback quota exhausted", "quota": 1, "plays_used": 1}),
                )
            page.route("**/api/sessions/sus/play-authorize", handle_quota_429)

            c_play_btn.click()
            page.wait_for_selector("text=Playback limit reached for this sentence.", timeout=5000)

            # Assert: Quota exhaustion must NOT ungate textarea or continue button!
            assert c_textarea.is_disabled(), "Gate Violation: Quota exhaustion without completed playback must NOT un-gate textarea"
            assert c_continue_btn.is_disabled(), "Gate Violation: Quota exhaustion without completed playback must NOT un-gate continue button"

            page.unroute("**/api/sessions/sus/play-authorize")

            results["scenarios"]["C_playback_gate"] = {
                "status": "PASSED",
                "textarea_disabled_before_playback": True,
                "continue_disabled_before_playback": True,
                "remains_gated_during_quota_exhaustion": True,
                "quota_exhaustion_is_not_completed_playback": True,
                "verified_in_real_browser": True,
            }
            print("Scenario C Verified.")

            # =================================================================
            # SCENARIO D: Empty Transcription Submission
            # =================================================================
            print("\n--- Running Scenario D: Empty Transcription Submission ---")
            page.evaluate("() => sessionStorage.clear()")
            page.goto(f"{frontend_origin}/get-started")
            page.wait_for_selector("#access-code-input")
            page.fill("#access-code-input", "SUSEMP")
            page.click("button:has-text('Verify Code')")
            page.click("button:has-text('Continue to Consent')")
            page.wait_for_selector("input[type='checkbox']")
            page.check("input[type='checkbox']")
            page.click("button:has-text('Agree and continue')")
            page.wait_for_selector("input[id='normal_hearing-Yes']")
            page.check("input[id='normal_hearing-Yes']")
            page.click("button:has-text('Start Session')")

            page.wait_for_url("**/evaluate", timeout=5000)
            page.wait_for_selector("text=SUS Intelligibility Task")

            # Play to end
            page.click("button:has-text('Play')")
            page.wait_for_function(
                "() => document.querySelector('audio') && document.querySelector('audio').ended === true",
                timeout=6000,
            )
            time.sleep(0.5)

            # Do not type anything into Textarea (submit empty hypothesis)
            page.click("button[type='submit']:has-text('Continue')")
            page.wait_for_selector("text=Thank you.", timeout=5000)

            # DB Assertion: WAcc == 0.0, response saved
            with session_factory() as s:
                d_resp = s.execute(
                    select(SUSResponse).join(TestStimulus).where(TestStimulus.neutral_label == "D1")
                ).scalar_one_or_none()
                assert d_resp is not None, "Empty transcription response must be persisted in database"
                assert d_resp.raw_transcription == "", f"Expected empty transcription, got '{d_resp.raw_transcription}'"
                assert d_resp.wacc == 0.0, f"Expected WAcc 0.0, got {d_resp.wacc}"

            results["scenarios"]["D_empty_transcription"] = {
                "status": "PASSED",
                "empty_hypothesis_persisted": True,
                "word_accuracy": 0.0,
                "completed_cleanly": True,
            }
            print("Scenario D Verified.")

            # =================================================================
            # SCENARIO E: Committed Submission with Lost Response and Successful Retry
            # =================================================================
            print("\n--- Running Scenario E: Committed Submission with Lost Response and Successful Retry ---")
            page.evaluate("() => sessionStorage.clear()")
            page.goto(f"{frontend_origin}/get-started")
            page.wait_for_selector("#access-code-input")
            page.fill("#access-code-input", "SUSEID")
            page.click("button:has-text('Verify Code')")
            page.click("button:has-text('Continue to Consent')")
            page.wait_for_selector("input[type='checkbox']")
            page.check("input[type='checkbox']")
            page.click("button:has-text('Agree and continue')")
            page.wait_for_selector("input[id='normal_hearing-Yes']")
            page.check("input[id='normal_hearing-Yes']")
            page.click("button:has-text('Start Session')")

            page.wait_for_url("**/evaluate", timeout=5000)
            page.wait_for_selector("text=SUS Intelligibility Task")

            # Play to completion
            e_play_btn = page.locator("button:has-text('Play')")
            e_play_btn.click()
            page.wait_for_function(
                "() => document.querySelector('audio') && document.querySelector('audio').ended === true",
                timeout=6000,
            )
            time.sleep(0.5)

            e_textarea = page.locator("#sus-transcription")
            assert e_textarea.is_enabled(), "Textarea should be enabled after playback ended"
            e_transcription_text = "kucing melompat tinggi sekali"
            e_textarea.fill(e_transcription_text)

            # Network accounting during submission & retry
            e_net_auth_count = 0
            e_net_stream_count = 0
            def log_e_net(req):
                nonlocal e_net_auth_count, e_net_stream_count
                if "/api/sessions/sus/play-authorize" in req.url:
                    e_net_auth_count += 1
                elif "/api/media/stream" in req.url:
                    e_net_stream_count += 1
            page.on("request", log_e_net)

            # Route interception for fault injection: drop response towards browser on 1st commit
            e_response_keys = []
            e_response_payloads = []
            e_route_first_call = True

            def handle_e_response_route(route):
                nonlocal e_route_first_call
                req = route.request
                k = req.headers.get("idempotency-key")
                if k:
                    e_response_keys.append(k)
                try:
                    e_response_payloads.append(req.post_data_json)
                except Exception:
                    pass

                if e_route_first_call:
                    e_route_first_call = False
                    # Fetch from real backend server so backend commits transaction
                    backend_resp = route.fetch()
                    assert backend_resp.status == 200, f"Expected 200 from backend, got {backend_resp.status}"
                    # Simulate network failure: drop response packet before browser receives it
                    route.abort("failed")
                else:
                    # Retry: pass response through cleanly
                    route.continue_()

            page.route("**/api/sessions/response", handle_e_response_route)

            # Click Continue (first submission attempt)
            page.click("button[type='submit']:has-text('Continue')")

            # Verify browser catches network failure, displays error message & Retry button
            page.wait_for_selector("text=Network error saving response. Please retry submission.", timeout=5000)
            retry_btn = page.locator("button:has-text('Retry submission')")
            assert retry_btn.first.is_visible(), "Retry submission button must be visible"
            assert e_textarea.is_disabled(), "Textarea must remain disabled during pending retry"

            # Intermediate backend DB assertions: backend already committed and completed session!
            with session_factory() as s:
                e_responses = s.execute(
                    select(SUSResponse).where(SUSResponse.stimulus_id == fixtures["stim_e1"])
                ).scalars().all()
                assert len(e_responses) == 1, f"Backend must have committed exactly 1 response, got {len(e_responses)}"
                e_session = s.execute(
                    select(RespondentSession).where(RespondentSession.id == e_responses[0].session_id)
                ).scalar_one()
                assert e_session.status == "completed", f"Session should be completed on backend, got {e_session.status}"

            # Browser clicks "Retry submission"
            print("Clicking 'Retry submission' in browser...")
            retry_btn.first.click()

            # Wait for completion screen
            page.wait_for_selector("text=Thank you.", timeout=5000)
            page.wait_for_selector("text=Session Completed")
            print("Scenario E browser reached completion screen successfully.")

            # Unroute
            page.unroute("**/api/sessions/response")

            # Post-completion assertions
            assert len(e_response_keys) == 2, f"Expected 2 requests to response endpoint, got {len(e_response_keys)}"
            assert e_response_keys[0] == e_response_keys[1], f"Idempotency keys must match: {e_response_keys[0]} != {e_response_keys[1]}"
            assert len(e_response_payloads) == 2, f"Expected 2 payloads, got {len(e_response_payloads)}"
            assert e_response_payloads[0] == e_response_payloads[1], "Payload bodies must be identical between first attempt and retry"
            assert e_net_auth_count == 0, f"Retry must not trigger extra play-authorize, saw {e_net_auth_count}"
            assert e_net_stream_count == 0, f"Retry must not trigger extra media stream, saw {e_net_stream_count}"

            with session_factory() as s:
                final_e_responses = s.execute(
                    select(SUSResponse).where(SUSResponse.stimulus_id == fixtures["stim_e1"])
                ).scalars().all()
                assert len(final_e_responses) == 1, f"Expected strictly 1 response in DB, got {len(final_e_responses)}"
                assert final_e_responses[0].wacc == 1.0, f"Expected WAcc 1.0, got {final_e_responses[0].wacc}"
                assert final_e_responses[0].raw_transcription == e_transcription_text
                assert final_e_responses[0].idempotency_key == e_response_keys[0]

            results["scenarios"]["E_committed_submission_lost_response_retry"] = {
                "status": "PASSED",
                "browser_flow": "get-started -> consent -> evaluate -> play -> fill -> submit -> network_error -> retry_submission -> completed",
                "backend_committed_before_retry": True,
                "session_completed_before_retry": True,
                "idempotent_replay_success": True,
                "exact_key_reused": True,
                "idempotency_key": e_response_keys[0],
                "db_persisted_responses": 1,
                "word_accuracy": 1.0,
                "completion_screen_reached": True,
            }
            print("Scenario E Verified.")

            # =================================================================
            # SCENARIO F: Payload Conflict Detection
            # =================================================================
            print("\n--- Running Scenario F: Payload Conflict Detection ---")
            client = httpx.Client(base_url=backend_origin)
            conflict_payload = dict(e_response_payloads[0])
            conflict_payload["transcription"] = "anjing melompat sangat berbeda"
            resp_conflict = client.post(
                "/api/sessions/response",
                json=conflict_payload,
                headers={"Idempotency-Key": e_response_keys[0]},
            )
            print(f"Altered payload submission returned status: {resp_conflict.status_code}")
            assert resp_conflict.status_code == 409, f"Expected 409 Conflict, got {resp_conflict.status_code}"
            assert "different payload" in resp_conflict.json().get("error", "").lower()

            # Verify original DB response is unmodified
            with session_factory() as s:
                final_resp = s.execute(
                    select(SUSResponse).where(SUSResponse.stimulus_id == fixtures["stim_e1"])
                ).scalar_one()
                assert final_resp.raw_transcription == "kucing melompat tinggi sekali"

            results["scenarios"]["F_payload_conflict"] = {
                "status": "PASSED",
                "status_code": 409,
                "conflict_detected": True,
                "db_original_row_unmodified": True,
            }
            print("Scenario F Verified.")

            # Stop tracing and save trace artifact
            context.tracing.stop(path=str(trace_path))
            print(f"Saved Playwright Trace: {trace_path} (Size: {trace_path.stat().st_size} bytes)")
            browser.close()

        results["summary"] = {
            "all_core_protocol_scenarios_passed": True,
            "frontend_defect_reported": len(results["defects_identified"]) > 0,
            "page_errors": page_errors,
            "console_errors": console_errors,
        }

    finally:
        # Graceful shutdown of server process groups
        def _terminate_proc(proc):
            if proc and proc.poll() is None:
                try:
                    os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
                    proc.wait(timeout=3)
                except Exception:
                    try:
                        os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
                    except Exception:
                        pass

        _terminate_proc(backend_proc)
        _terminate_proc(frontend_proc)
        shutil.rmtree(tmp_dir, ignore_errors=True)

    # Save results JSON
    results_json_path = OUTPUT_DIR / "browser-e2e-results.json"
    with results_json_path.open("w", encoding="utf-8") as f:
        json.dump(results, f, indent=2)
    print(f"Saved E2E Results: {results_json_path}")


if __name__ == "__main__":
    main()
