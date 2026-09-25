from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import TIMESTAMP, Boolean, Column, Float, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import DeclarativeBase


def utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


class Base(DeclarativeBase):
    pass


class Admin(Base):
    __tablename__ = "admin"

    id = Column(Integer, primary_key=True)
    username = Column(String(128), nullable=False, unique=True, default="admin")
    password_hash = Column(Text, nullable=False)
    created_at = Column(
        TIMESTAMP(timezone=False),
        nullable=False,
        default=utcnow,
    )


class Setting(Base):
    __tablename__ = "setting"

    id = Column(Integer, primary_key=True)
    key = Column(String(128), nullable=False, unique=True)
    value = Column(Text, nullable=True)


class Test(Base):
    __tablename__ = "test"

    id = Column(Integer, primary_key=True)
    name = Column(String(255), nullable=False)
    version = Column(Integer, nullable=False, default=1)
    status = Column(String(16), nullable=False, default="draft")
    config_yaml = Column(Text, nullable=False)
    access_code = Column(String(6), nullable=True, unique=True)
    created_at = Column(TIMESTAMP(timezone=False), nullable=False, default=utcnow)
    updated_at = Column(
        TIMESTAMP(timezone=False), nullable=False, default=utcnow, onupdate=utcnow
    )


class TestStimulus(Base):
    __tablename__ = "test_stimulus"

    id = Column(Integer, primary_key=True)
    test_id = Column(Integer, ForeignKey("test.id", ondelete="CASCADE"), nullable=False)
    neutral_label = Column(String(16), nullable=False)
    engine_id = Column(Integer, ForeignKey("engine.id"), nullable=False)
    audio_ref = Column(String(255), nullable=False)
    kind = Column(String(8), nullable=False, default="mos")


class Engine(Base):
    __tablename__ = "engine"

    id = Column(Integer, primary_key=True)
    name = Column(String(255), nullable=False, unique=True)
    description = Column(Text, nullable=True)


class SUSSentence(Base):
    __tablename__ = "sus_sentence"

    id = Column(Integer, primary_key=True)
    text = Column(Text, nullable=False)
    reference_transcription = Column(Text, nullable=False)


class MOSScalePreset(Base):
    __tablename__ = "mos_scale_preset"

    id = Column(Integer, primary_key=True)
    name = Column(String(255), nullable=False, unique=True)
    minimum = Column(Integer, nullable=False)
    maximum = Column(Integer, nullable=False)
    labels_json = Column(Text, nullable=False)
    prompt = Column(Text, nullable=False)


class DemographicFieldDef(Base):
    __tablename__ = "demographic_field_def"

    id = Column(Integer, primary_key=True)
    key = Column(String(128), nullable=False, unique=True)
    label = Column(String(255), nullable=False)
    field_type = Column(String(32), nullable=False, default="text")
    required = Column(Boolean, nullable=False, default=False)
    options_json = Column(Text, nullable=True)


class TestDemographicField(Base):
    __tablename__ = "test_demographic_field"

    id = Column(Integer, primary_key=True)
    test_id = Column(Integer, ForeignKey("test.id", ondelete="CASCADE"), nullable=False)
    field_key = Column(String(128), ForeignKey("demographic_field_def.key", ondelete="CASCADE"), nullable=False)


class TextTemplate(Base):
    __tablename__ = "text_template"

    id = Column(Integer, primary_key=True)
    kind = Column(String(32), nullable=False)
    version = Column(Integer, nullable=False, default=1)
    content = Column(Text, nullable=False)


class AudioAsset(Base):
    __tablename__ = "audio_asset"

    id = Column(String(32), primary_key=True)
    original_filename = Column(String(255), nullable=False)
    stored_filename = Column(String(255), nullable=False, unique=True)
    content_type = Column(String(128), nullable=False)
    size_bytes = Column(Integer, nullable=False)
    sha256 = Column(String(64), nullable=False)
    engine_id = Column(Integer, ForeignKey("engine.id"), nullable=True)
    reference_transcription = Column(Text, nullable=True)
    status = Column(String(16), nullable=False, default="active")
    created_at = Column(TIMESTAMP(timezone=False), nullable=False, default=utcnow)
    updated_at = Column(
        TIMESTAMP(timezone=False), nullable=False, default=utcnow, onupdate=utcnow
    )


class RespondentSession(Base):
    __tablename__ = "respondent_session"

    id = Column(Integer, primary_key=True)
    test_id = Column(Integer, ForeignKey("test.id", ondelete="CASCADE"), nullable=False)
    token = Column(String(64), nullable=False, unique=True)
    random_seed = Column(Integer, nullable=False)
    consent_accepted = Column(Boolean, nullable=False, default=True)
    status = Column(String(16), nullable=False, default="active")
    calibration_play_count = Column(Integer, nullable=False, default=0)
    calibration_completed = Column(Boolean, nullable=False, default=False)
    completed_at = Column(TIMESTAMP(timezone=False), nullable=True)
    created_at = Column(TIMESTAMP(timezone=False), nullable=False, default=utcnow)
    updated_at = Column(
        TIMESTAMP(timezone=False), nullable=False, default=utcnow, onupdate=utcnow
    )


class RespondentDemographicResponse(Base):
    __tablename__ = "respondent_demographic_response"

    id = Column(Integer, primary_key=True)
    session_id = Column(Integer, ForeignKey("respondent_session.id", ondelete="CASCADE"), nullable=False)
    field_key = Column(String(128), nullable=False)
    value = Column(Text, nullable=True)


class RespondentStimulusOrder(Base):
    __tablename__ = "respondent_stimulus_order"

    id = Column(Integer, primary_key=True)
    session_id = Column(Integer, ForeignKey("respondent_session.id", ondelete="CASCADE"), nullable=False)
    stimulus_id = Column(Integer, ForeignKey("test_stimulus.id", ondelete="CASCADE"), nullable=False)
    position = Column(Integer, nullable=False)


class MOSResponse(Base):
    __tablename__ = "mos_response"

    id = Column(Integer, primary_key=True)
    session_id = Column(Integer, ForeignKey("respondent_session.id", ondelete="CASCADE"), nullable=False)
    stimulus_id = Column(Integer, ForeignKey("test_stimulus.id", ondelete="CASCADE"), nullable=False)
    rating = Column(Integer, nullable=False)
    play_count = Column(Integer, nullable=False, default=0)
    created_at = Column(TIMESTAMP(timezone=False), nullable=False, default=utcnow)

    __table_args__ = (
        UniqueConstraint("session_id", "stimulus_id", name="uq_mos_response_session_stimulus"),
    )


class SUSResponse(Base):
    __tablename__ = "sus_response"

    id = Column(Integer, primary_key=True)
    session_id = Column(Integer, ForeignKey("respondent_session.id", ondelete="CASCADE"), nullable=False)
    stimulus_id = Column(Integer, ForeignKey("test_stimulus.id", ondelete="CASCADE"), nullable=False)
    raw_transcription = Column(Text, nullable=True)
    normalized_transcription = Column(Text, nullable=True)
    wacc = Column(Float, nullable=True)
    substitutions = Column(Integer, nullable=True)
    deletions = Column(Integer, nullable=True)
    insertions = Column(Integer, nullable=True)
    play_count = Column(Integer, nullable=False, default=0)
    created_at = Column(TIMESTAMP(timezone=False), nullable=False, default=utcnow)

    __table_args__ = (
        UniqueConstraint("session_id", "stimulus_id", name="uq_sus_response_session_stimulus"),
    )


class SUSPlayAuthorization(Base):
    __tablename__ = "sus_play_authorization"

    id = Column(String(64), primary_key=True)
    session_id = Column(Integer, ForeignKey("respondent_session.id", ondelete="CASCADE"), nullable=False)
    stimulus_id = Column(Integer, ForeignKey("test_stimulus.id", ondelete="CASCADE"), nullable=False)
    status = Column(String(16), nullable=False, default="authorized")
    created_at = Column(TIMESTAMP(timezone=False), nullable=False, default=utcnow)
    consumed_at = Column(TIMESTAMP(timezone=False), nullable=True)
