"""Optional seed script for development and demo data.

Generates minimal WAV files and inserts dummy master data
(engines, audio assets, MOS scale presets, SUS sentences, text templates).
Safe to run multiple times: uses INSERT OR IGNORE semantics.
"""

from __future__ import annotations

import hashlib
import io
import math
import os
import secrets
import struct

# Make backend importable when script is run directly
import sys
import wave
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import MetaData, Table, create_engine, insert, select

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.app.models import Base

DEFAULT_DATA_DIR = Path(__file__).resolve().parent.parent / "data"


def generate_wav(filename: str, duration_s: float = 1.0, freq_hz: float | None = 440.0) -> bytes:
    """Generate a minimal 16-bit PCM mono WAV file in memory.

    ``freq_hz=None`` (or 0) produces true silence, not a 440 Hz tone.
    """
    sample_rate = 16000
    num_samples = int(sample_rate * duration_s)

    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        frames = bytearray()
        for i in range(num_samples):
            sample = 0 if not freq_hz else int(32767 * 0.5 * math.sin(2 * math.pi * freq_hz * i / sample_rate))
            frames.extend(struct.pack("<h", sample))
        w.writeframes(bytes(frames))

    return buf.getvalue()


def table(name: str, engine) -> Table:
    return Table(name, MetaData(), autoload_with=engine)


def seed(data_dir: Path | str | None = None) -> None:
    """Insert demo master data. Idempotent via row-existence checks."""
    data_dir = Path(data_dir or DEFAULT_DATA_DIR).expanduser().resolve()
    data_dir.mkdir(parents=True, exist_ok=True)
    url = f"sqlite:///{(data_dir / 'dengar.sqlite3').as_posix()}"
    engine = create_engine(url, future=True)

    # Create tables if they don't exist
    Base.metadata.create_all(engine)

    audio_dir = data_dir / "audio"
    audio_dir.mkdir(parents=True, exist_ok=True)

    with engine.begin() as conn:
        engines = table("engine", conn)
        audio_assets = table("audio_asset", conn)
        mos_scale_presets = table("mos_scale_preset", conn)
        sus_sentences = table("sus_sentence", conn)
        text_templates = table("text_template", conn)

        # --- Engines ---
        existing_engines = {
            row["name"] for row in conn.execute(select(engines.c.name)).mappings().all()
        }
        engine_rows = []
        for name, desc in [
            ("Google TTS", "Google Cloud Text-to-Speech (Indonesian id-ID)"),
            ("Coqui TTS", "Coqui TTS local synthesis (id-ID)"),
        ]:
            if name not in existing_engines:
                engine_rows.append({"name": name, "description": desc})
        if engine_rows:
            conn.execute(insert(engines).values(engine_rows))

        # Get engine IDs
        engine_rows = conn.execute(select(engines.c.id, engines.c.name)).mappings().all()
        engine_id_map = {row["name"]: row["id"] for row in engine_rows}
        google_id = engine_id_map.get("Google TTS")

        # --- Audio assets + WAV files ---
        wav_files = [
            ("sample_google.wav", 440.0, 1.5),
            ("sample_coqui.wav", 523.25, 1.0),
            ("sample_silence.wav", None, 0.5),
        ]

        # Idempotency key is the original filename: stored filenames are random
        # per run, so checking a freshly generated one never matches.
        existing_originals = {
            row["original_filename"]
            for row in conn.execute(select(audio_assets.c.original_filename)).mappings().all()
        }

        audio_rows = []
        for wav_name, freq, dur in wav_files:
            if wav_name in existing_originals:
                continue
            data = generate_wav(wav_name, duration_s=dur, freq_hz=freq)
            digest = hashlib.sha256(data).hexdigest()
            asset_id = secrets.token_hex(16)
            stored_filename = f"{asset_id}.wav"
            audio_rows.append({
                "id": asset_id,
                "original_filename": wav_name,
                "stored_filename": stored_filename,
                "content_type": "audio/x-wav",
                "size_bytes": len(data),
                "sha256": digest,
                "engine_id": google_id,
                "reference_transcription": None,
                "status": "active",
                "created_at": datetime.now(timezone.utc).replace(tzinfo=None),
                "updated_at": datetime.now(timezone.utc).replace(tzinfo=None),
            })
            # Write WAV file with server-side UUID filename
            (audio_dir / stored_filename).write_bytes(data)
        if audio_rows:
            conn.execute(insert(audio_assets).values(audio_rows))

        # --- MOS scale presets ---
        existing_presets = {
            row["name"] for row in conn.execute(select(mos_scale_presets.c.name)).mappings().all()
        }
        if "Default 5-point MOS" not in existing_presets:
            conn.execute(
                insert(mos_scale_presets).values(
                    name="Default 5-point MOS",
                    minimum=1,
                    maximum=5,
                    labels_json='["Bad", "Poor", "Fair", "Good", "Excellent"]',
                    prompt="Please rate the quality of the audio you just heard.",
                )
            )

        # --- SUS sentences ---
        existing_sus = {
            row["text"] for row in conn.execute(select(sus_sentences.c.text)).mappings().all()
        }
        sus_data = [
            ("Angin kencang merobohkan rumah itu.", "angin kencang merobohkan rumah itu"),
            ("Kucing hitam tidur di kursi tua.", "kucing hitam tidur di kursi tua"),
            ("Dia membeli lima buku baru kemarin.", "dia membeli lima buku baru kemarin"),
        ]
        sus_rows = [
            {"text": text, "reference_transcription": ref}
            for text, ref in sus_data
            if text not in existing_sus
        ]
        if sus_rows:
            conn.execute(insert(sus_sentences).values(sus_rows))

        # --- Text templates ---
        existing_templates = {
            row["kind"] for row in conn.execute(select(text_templates.c.kind)).mappings().all()
        }
        template_rows = []
        if "consent" not in existing_templates:
            template_rows.append({
                "kind": "consent",
                "version": 1,
                "content": "This is a research study about speech quality. Your responses are anonymous. You may withdraw at any time.",
            })
        if "completion" not in existing_templates:
            template_rows.append({
                "kind": "completion",
                "version": 1,
                "content": "Thank you for completing the evaluation. Your responses have been recorded.",
            })
        if template_rows:
            conn.execute(insert(text_templates).values(template_rows))

    print(f"Seed complete. Data directory: {data_dir}")


if __name__ == "__main__":
    import os

    data_dir = os.environ.get("DATA_DIR") or (sys.argv[1] if len(sys.argv) > 1 else None)
    seed(data_dir)
