from __future__ import annotations

import pytest

from backend.app.services.config_service import ConfigValidationError, parse_config
from backend.app.services.scoring import (
    _chinese_number,
    _english_number,
    _indonesian_number,
    compute_word_stats,
    normalize_text,
)


def test_indonesian_number_conversion():
    assert _indonesian_number(0) == "nol"
    assert _indonesian_number(1) == "satu"
    assert _indonesian_number(10) == "sepuluh"
    assert _indonesian_number(11) == "sebelas"
    assert _indonesian_number(15) == "lima belas"
    assert _indonesian_number(21) == "dua puluh satu"
    assert _indonesian_number(100) == "seratus"
    assert _indonesian_number(105) == "seratus lima"
    assert _indonesian_number(1000) == "seribu"
    assert _indonesian_number(2500) == "dua ribu lima ratus"


def test_english_number_conversion():
    assert _english_number(0) == "zero"
    assert _english_number(1) == "one"
    assert _english_number(12) == "twelve"
    assert _english_number(25) == "twenty five"
    assert _english_number(100) == "one hundred"
    assert _english_number(105) == "one hundred five"
    assert _english_number(1000) == "one thousand"
    assert _english_number(2024) == "two thousand twenty four"


def test_chinese_number_conversion():
    assert _chinese_number(0) == "零"
    assert _chinese_number(1) == "一"
    assert _chinese_number(10) == "十"
    assert _chinese_number(15) == "十五"
    assert _chinese_number(20) == "二十"
    assert _chinese_number(25) == "二十五"
    assert _chinese_number(100) == "一百"
    assert _chinese_number(105) == "一百零五"
    assert _chinese_number(1000) == "一千"
    assert _chinese_number(1005) == "一千零五"


def test_normalize_text_multilingual():
    # Indonesian
    id_norm = normalize_text("Saya punya 2 ekor kucing!", language="id")
    assert id_norm == "saya punya dua ekor kucing"

    # English
    en_norm = normalize_text("I have 2 cats and 10 dogs!", language="en")
    assert en_norm == "i have two cats and ten dogs"

    # Chinese: numbers converted to hanzi, and CJK characters tokenized with spaces
    zh_norm = normalize_text("我有2只猫和10条狗！", language="zh")
    assert zh_norm == "我 有 二 只 猫 和 十 条 狗"


def test_compute_word_stats_indonesian():
    ref = "kucing makan ikan di meja"
    hyp = "kucing makan ikan di meja"
    res = compute_word_stats(ref, hyp, language="id")
    assert res["wer"] == 0.0
    assert res["wacc"] == 1.0
    assert res["correct"] == 5

    hyp_with_error = "kucing makan daging di meja"
    res2 = compute_word_stats(ref, hyp_with_error, language="id")
    assert res2["substitutions"] == 1
    assert res2["correct"] == 4
    assert res2["wacc"] == 0.8


def test_compute_word_stats_english():
    ref = "the quick brown fox jumps over the lazy dog"
    hyp = "the fast brown fox jumps over the lazy dog"
    res = compute_word_stats(ref, hyp, language="en")
    assert res["substitutions"] == 1
    assert res["correct"] == 8
    assert res["wer"] == pytest.approx(1 / 9)

    # Number conversion in English
    ref_num = "room 12 is ready"
    hyp_num = "room twelve is ready"
    res_num = compute_word_stats(ref_num, hyp_num, language="en")
    assert res_num["wer"] == 0.0
    assert res_num["wacc"] == 1.0


def test_compute_word_stats_chinese():
    # Chinese character-level evaluation (CER / CAcc)
    ref = "今天天气很好"
    hyp = "今天天气很好"
    res = compute_word_stats(ref, hyp, language="zh")
    assert res["wer"] == 0.0
    assert res["wacc"] == 1.0
    assert res["correct"] == 6

    # 1 substitution: 天气 vs 水气
    hyp_err = "今天水气很好"
    res_err = compute_word_stats(ref, hyp_err, language="zh")
    assert res_err["substitutions"] == 1
    assert res_err["correct"] == 5
    assert res_err["wer"] == pytest.approx(1 / 6)

    # Number conversion in Chinese
    ref_num = "我有15本书"
    hyp_num = "我有十五本书"
    res_zh_num = compute_word_stats(ref_num, hyp_num, language="zh")
    assert res_zh_num["wer"] == 0.0
    assert res_zh_num["wacc"] == 1.0


def test_config_language_validation():
    valid_yaml = """
name: Chinese Test
test_type: sus
language: zh
audio:
  clip-1: asset-1
pages:
  - kind: consent
    title: Consent
  - kind: sus
    title: SUS
    stimuli:
      - audio_ref: clip-1
  - kind: completion
    title: Done
sus:
  quota: 2
"""
    cfg = parse_config(valid_yaml)
    assert cfg["language"] == "zh"

    invalid_yaml = valid_yaml.replace("language: zh", "language: fr")
    with pytest.raises(ConfigValidationError) as exc_info:
        parse_config(invalid_yaml)
    assert "language: must be 'id', 'en', or 'zh'" in str(exc_info.value)


def test_respondent_sus_scoring_multilingual_integration(fastapi_auth_client):
    """End-to-end integration test: respondent submits Chinese transcription and scoring uses zh rules."""
    from backend.app import models as db

    client = fastapi_auth_client
    with client.app.state.session_factory() as session:
        # Create audio asset with Chinese reference transcription
        asset = db.AudioAsset(
            id="asset-zh-001",
            original_filename="chinese_sample.wav",
            stored_filename="chinese_sample_stored.wav",
            content_type="audio/wav",
            size_bytes=1000,
            sha256="abc0000000000000000000000000000000000000000000000000000000000001",
            reference_transcription="我有10个苹果",  # "I have 10 apples"
            status="active",
        )
        session.add(asset)

        # Create published test with language: zh
        zh_config = """
name: Chinese Intelligibility Study
test_type: sus
language: zh
audio:
  clip-zh-1: asset-zh-001
pages:
  - kind: consent
    title: Consent
  - kind: sus
    title: SUS
    stimuli:
      - audio_ref: clip-zh-1
  - kind: completion
    title: Done
sus:
  quota: 2
"""
        test = db.Test(
            name="Chinese Intelligibility Study",
            version=1,
            status="published",
            config_yaml=zh_config,
            access_code="ZH1234",
        )
        session.add(test)
        session.flush()

        # Create stimulus
        engine = db.Engine(name="TestEngineZh")
        session.add(engine)
        session.flush()

        stimulus = db.TestStimulus(
            test_id=test.id,
            neutral_label="S1",
            engine_id=engine.id,
            audio_ref="clip-zh-1",
            kind="sus",
        )
        session.add(stimulus)
        session.flush()

        # Create respondent session
        rs = db.RespondentSession(
            test_id=test.id,
            token="token-zh-test-12345",
            random_seed=42,
            consent_accepted=True,
            status="active",
            calibration_completed=True,
        )
        session.add(rs)
        session.flush()

        # Create stimulus order
        so = db.RespondentStimulusOrder(
            session_id=rs.id,
            stimulus_id=stimulus.id,
            position=0,
        )
        session.add(so)

        # Create authorized play
        auth = db.SUSPlayAuthorization(
            id="auth-zh-token-123",
            session_id=rs.id,
            stimulus_id=stimulus.id,
            status="authorized",
        )
        session.add(auth)
        session.commit()

        stimulus_id = stimulus.id
        session_id = rs.id

    # Respondent submits transcription using digits "我有10个苹果"
    # In Chinese scoring:
    # 10 is converted to "十", and text is tokenized into characters: "我 有 十 个 苹 果"
    # If respondent types "我有十个苹果" or "我有10个苹果", both match 100%!
    response = client.post(
        "/api/sessions/response",
        json={
            "token": "token-zh-test-12345",
            "stimulus_id": stimulus_id,
            "transcription": "我有10个苹果",
            "authorization_id": "auth-zh-token-123",
        },
    )
    assert response.status_code == 200, response.text

    # Verify scored results in database
    with client.app.state.session_factory() as session:
        sus_resp = session.query(db.SUSResponse).filter_by(
            session_id=session_id,
            stimulus_id=stimulus_id,
        ).first()
        assert sus_resp is not None
        assert sus_resp.wacc == 1.0  # Perfect Character Accuracy!
        assert sus_resp.substitutions == 0
        assert sus_resp.deletions == 0
        assert sus_resp.insertions == 0
        # Check normalized transcription has Chinese character spacing
        assert sus_resp.normalized_transcription == "我 有 十 个 苹 果"

