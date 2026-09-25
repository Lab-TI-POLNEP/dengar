"""Text normalization and word accuracy scoring for SUS evaluation.

Provides Indonesian number-to-words conversion, Unicode text normalization,
and Levenshtein word-level alignment for computing Word Error Rate (WER) and
Word Accuracy (WAcc).
"""

from __future__ import annotations

import math
import re
import unicodedata
from typing import Any

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


def normalize_text(text: str | None) -> str:
    """Normalize text for WAcc scoring.

    Normalization rules:
    1. Convert to lowercase (case-insensitive comparison).
    2. Strip punctuation by replacing non-alphanumeric and non-space characters with space.
       Replacing with space prevents accidentally joining words (e.g. "word1.word2" -> "word1 word2").
    3. Split on whitespace and rejoin with a single space (condenses multiple spaces and strips outer spaces).
    """
    if not text:
        return ""
    text = unicodedata.normalize("NFKC", str(text)).lower()
    text = re.sub(r'[^\w\s]', ' ', text)
    text = re.sub(r"\d+", lambda match: _indonesian_number(int(match.group())), text)
    return " ".join(text.split())


def compute_word_stats(ref_text: str, hyp_text: str) -> dict[str, Any]:
    """Calculate WER, WAcc, and alignment counts (S, D, I).

    WER is (substitutions + deletions + insertions) / reference words and
    WAcc is 1 - WER. Empty references use WER 0 for an empty hypothesis and 1
    otherwise.
    Uses dynamic programming for Levenshtein distance/alignment at the word level.
    """
    ref_words = normalize_text(ref_text).split()
    hyp_words = normalize_text(hyp_text).split()

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
    """Calculate sample standard deviation with Bessel's correction (n - 1)."""
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
