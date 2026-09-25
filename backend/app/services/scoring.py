"""Text normalization and word/character accuracy scoring for SUS evaluation.

Provides multi-language number-to-words conversion, Unicode text normalization,
and Levenshtein word-level (or character-level for Chinese) alignment for
computing Word Error Rate (WER) / Character Error Rate (CER) and
Word Accuracy (WAcc) / Character Accuracy (CAcc).

Supported languages:
  - id: Indonesian (word-level, WAcc/WER)
  - en: English (word-level, WAcc/WER)
  - zh: Chinese/Mandarin (character-level, CAcc/CER)
"""

from __future__ import annotations

import math
import re
import unicodedata
from typing import Any

# Supported language codes for SUS scoring normalization.
SUPPORTED_LANGUAGES = ("id", "en", "zh")

# ---------------------------------------------------------------------------
# Indonesian number-to-words
# ---------------------------------------------------------------------------

_INDONESIAN_NUMBERS = (
    "nol", "satu", "dua", "tiga", "empat", "lima",
    "enam", "tujuh", "delapan", "sembilan",
)


def _indonesian_number(value: int) -> str:
    if value < 10:
        return _INDONESIAN_NUMBERS[value]
    if value < 20:
        return "sepuluh" if value == 10 else "sebelas" if value == 11 else f"{_INDONESIAN_NUMBERS[value - 10]} belas"
    if value < 100:
        tens, remainder = divmod(value, 10)
        return f"{_INDONESIAN_NUMBERS[tens]} puluh" + (f" {_indonesian_number(remainder)}" if remainder else "")
    if value < 1000:
        hundreds, remainder = divmod(value, 100)
        prefix = "seratus" if hundreds == 1 else f"{_INDONESIAN_NUMBERS[hundreds]} ratus"
        return prefix + (f" {_indonesian_number(remainder)}" if remainder else "")
    if value < 1_000_000:
        thousands, remainder = divmod(value, 1000)
        prefix = "seribu" if thousands == 1 else f"{_indonesian_number(thousands)} ribu"
        return prefix + (f" {_indonesian_number(remainder)}" if remainder else "")
    if value < 1_000_000_000:
        millions, remainder = divmod(value, 1_000_000)
        prefix = f"{_indonesian_number(millions)} juta"
        return prefix + (f" {_indonesian_number(remainder)}" if remainder else "")
    return str(value)


# ---------------------------------------------------------------------------
# English number-to-words
# ---------------------------------------------------------------------------

_ENGLISH_ONES = (
    "zero", "one", "two", "three", "four", "five",
    "six", "seven", "eight", "nine", "ten",
    "eleven", "twelve", "thirteen", "fourteen", "fifteen",
    "sixteen", "seventeen", "eighteen", "nineteen",
)
_ENGLISH_TENS = (
    "", "", "twenty", "thirty", "forty", "fifty",
    "sixty", "seventy", "eighty", "ninety",
)


def _english_number(value: int) -> str:
    if value < 20:
        return _ENGLISH_ONES[value]
    if value < 100:
        tens, remainder = divmod(value, 10)
        return _ENGLISH_TENS[tens] + (f" {_ENGLISH_ONES[remainder]}" if remainder else "")
    if value < 1000:
        hundreds, remainder = divmod(value, 100)
        return f"{_ENGLISH_ONES[hundreds]} hundred" + (f" {_english_number(remainder)}" if remainder else "")
    if value < 1_000_000:
        thousands, remainder = divmod(value, 1000)
        return f"{_english_number(thousands)} thousand" + (f" {_english_number(remainder)}" if remainder else "")
    if value < 1_000_000_000:
        millions, remainder = divmod(value, 1_000_000)
        return f"{_english_number(millions)} million" + (f" {_english_number(remainder)}" if remainder else "")
    return str(value)


# ---------------------------------------------------------------------------
# Chinese (Mandarin) number-to-characters
# ---------------------------------------------------------------------------

_CHINESE_DIGITS = "零一二三四五六七八九"
_CHINESE_UNITS = ("", "十", "百", "千")
_CHINESE_GROUP_UNITS = ("", "万", "亿")


def _chinese_group_segment(group: int) -> str:
    """Convert a 4-digit group (0-9999) to Chinese characters."""
    if group == 0:
        return ""

    units = ("", "十", "百", "千")
    digits = [int(c) for c in str(group)]
    num_digits = len(digits)

    parts: list[str] = []
    zero_pending = False

    for i, d in enumerate(digits):
        pos = num_digits - 1 - i
        if d == 0:
            if parts:
                zero_pending = True
        else:
            if zero_pending:
                parts.append("零")
                zero_pending = False
            parts.append(_CHINESE_DIGITS[d] + units[pos])

    return "".join(parts)


def _chinese_number(value: int) -> str:
    """Convert an integer to Mandarin Chinese characters (simplified)."""
    if value < 0:
        return f"负{_chinese_number(-value)}"
    if value < 10:
        return _CHINESE_DIGITS[value]
    if value >= 1_000_000_000:
        return " ".join(_CHINESE_DIGITS[int(d)] for d in str(value))

    parts: list[str] = []
    group_index = 0
    prev_had_zero = False

    while value > 0:
        group = value % 10000
        value //= 10000

        if group == 0:
            group_index += 1
            prev_had_zero = True
            continue

        segment = _chinese_group_segment(group)
        unit = _CHINESE_GROUP_UNITS[group_index] if group_index < len(_CHINESE_GROUP_UNITS) else ""

        if prev_had_zero and parts:
            parts.append("零")

        parts.append(unit)
        parts.append(segment)

        if group < 1000 and value > 0 and not prev_had_zero:
            parts.append("零")

        prev_had_zero = False
        group_index += 1

    result = "".join(reversed(parts))
    if result.startswith("一十") and len(result) <= 3:
        result = result[1:]
    return result


# ---------------------------------------------------------------------------
# CJK character detection and tokenization
# ---------------------------------------------------------------------------

_CJK_RE = re.compile(
    r"[\u4e00-\u9fff"           # CJK Unified Ideographs
    r"\u3400-\u4dbf"            # CJK Extension A
    r"\uf900-\ufaff"            # CJK Compatibility Ideographs
    r"\U00020000-\U0002a6df"    # CJK Extension B
    r"\U0002a700-\U0002b73f"    # CJK Extension C
    r"\U0002b740-\U0002b81f"    # CJK Extension D
    r"]"
)


def _tokenize_chinese(text: str) -> list[str]:
    """Tokenize Chinese text into individual characters for CER evaluation."""
    spaced = _CJK_RE.sub(lambda m: f" {m.group()} ", text)
    return spaced.split()


# ---------------------------------------------------------------------------
# Number-to-words dispatch
# ---------------------------------------------------------------------------

_NUMBER_CONVERTERS: dict[str, Any] = {
    "id": _indonesian_number,
    "en": _english_number,
    "zh": _chinese_number,
}


# ---------------------------------------------------------------------------
# Text normalization
# ---------------------------------------------------------------------------

def normalize_text(text: str | None, language: str = "id") -> str:
    """Normalize text for WAcc/CAcc scoring."""
    if not text:
        return ""
    text = unicodedata.normalize("NFKC", str(text)).lower()
    text = re.sub(r'[^\w\s]', ' ', text)

    converter = _NUMBER_CONVERTERS.get(language)
    if converter is not None:
        text = re.sub(r"\d+", lambda match: converter(int(match.group())), text)

    if language == "zh":
        tokens = _tokenize_chinese(text)
        return " ".join(tokens)

    return " ".join(text.split())


# ---------------------------------------------------------------------------
# Word/character accuracy scoring (Levenshtein alignment)
# ---------------------------------------------------------------------------

def compute_word_stats(ref_text: str, hyp_text: str, language: str = "id") -> dict[str, Any]:
    """Calculate WER/CER, WAcc/CAcc, and alignment counts (S, D, I)."""
    ref_words = normalize_text(ref_text, language).split()
    hyp_words = normalize_text(hyp_text, language).split()

    n = len(ref_words)
    m = len(hyp_words)

    if n == 0:
        wer = 0.0 if m == 0 else 1.0
        return {
            "wer": wer,
            "wacc": 1.0 - wer,
            "substitutions": 0,
            "deletions": 0,
            "insertions": m,
            "correct": 0
        }

    dp = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(n + 1):
        dp[i][0] = i
    for j in range(m + 1):
        dp[0][j] = j

    for i in range(1, n + 1):
        for j in range(1, m + 1):
            if ref_words[i - 1] == hyp_words[j - 1]:
                dp[i][j] = dp[i - 1][j - 1]
            else:
                dp[i][j] = min(
                    dp[i - 1][j] + 1,      # deletion
                    dp[i][j - 1] + 1,      # insertion
                    dp[i - 1][j - 1] + 1    # substitution
                )

    i, j = n, m
    substitutions = 0
    deletions = 0
    insertions = 0
    correct = 0

    while i > 0 or j > 0:
        if i > 0 and j > 0 and ref_words[i - 1] == hyp_words[j - 1]:
            correct += 1
            i -= 1
            j -= 1
        elif i > 0 and j > 0 and dp[i][j] == dp[i - 1][j - 1] + 1:
            substitutions += 1
            i -= 1
            j -= 1
        elif i > 0 and dp[i][j] == dp[i - 1][j] + 1:
            deletions += 1
            i -= 1
        elif j > 0 and dp[i][j] == dp[i][j - 1] + 1:
            insertions += 1
            j -= 1
        else:
            if i > 0 and j > 0:
                substitutions += 1
                i -= 1
                j -= 1
            elif i > 0:
                deletions += 1
                i -= 1
            else:
                insertions += 1
                j -= 1

    wer = (substitutions + deletions + insertions) / n
    return {
        "wer": wer,
        "wacc": 1.0 - wer,
        "substitutions": substitutions,
        "deletions": deletions,
        "insertions": insertions,
        "correct": correct
    }


def sample_stddev(values: list[float]) -> float:
    """Calculate sample standard deviation with Bessel correction (n - 1)."""
    n = len(values)
    if n < 2:
        return 0.0
    mean = sum(values) / n
    variance = sum((x - mean) ** 2 for x in values) / (n - 1)
    return math.sqrt(variance)


def mos_summary(ratings: list[float]) -> dict[str, Any]:
    """Calculate Mean Opinion Score summary statistics with 95% confidence interval."""
    n = len(ratings)
    if n == 0:
        return {"n": 0, "mean": None, "ci95": None}
    mean = sum(ratings) / n
    if n < 2:
        return {"n": n, "mean": mean, "ci95": None}
    stddev = sample_stddev(ratings)
    critical_values = {
        1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571,
        6: 2.447, 7: 2.365, 8: 2.306, 9: 2.262, 10: 2.228,
        11: 2.201, 12: 2.179, 13: 2.160, 14: 2.145, 15: 2.131,
        16: 2.120, 17: 2.110, 18: 2.101, 19: 2.093, 20: 2.086,
        21: 2.080, 22: 2.074, 23: 2.069, 24: 2.064, 25: 2.060,
        26: 2.056, 27: 2.052, 28: 2.048, 29: 2.045, 30: 2.042,
    }
    margin = critical_values.get(n - 1, 1.96) * stddev / math.sqrt(n)
    return {
        "n": n,
        "mean": mean,
        "ci95": {"lower": mean - margin, "upper": mean + margin},
    }
