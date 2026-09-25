from __future__ import annotations

from typing import Any

import yaml


class ConfigValidationError(ValueError):
    def __init__(self, errors: list[str]) -> None:
        self.errors = errors
        super().__init__("; ".join(errors))


ROOT_KEYS = {"name", "test_type", "language", "audio", "pages", "mos", "sus", "calibration_audio_ref"}
PAGE_KEYS = {"kind", "title", "stimuli", "fields"}
PAGE_ORDER = ["consent", "demographics", "mos", "sus", "completion"]


def parse_config(text: str) -> dict[str, Any]:
    try:
        value = yaml.safe_load(text)
    except yaml.YAMLError as exc:
        problem = getattr(exc, "problem", None) or "invalid syntax"
        raise ConfigValidationError([f"yaml: malformed document ({problem})"])
    errors: list[str] = []
    if not isinstance(value, dict):
        raise ConfigValidationError(["config: root must be a mapping"])
    errors.extend(f"config: unknown key '{key}'" for key in value if key not in ROOT_KEYS)
    if not isinstance(value.get("name"), str) or not value.get("name", "").strip():
        errors.append("name: required")
    test_type = value.get("test_type")
    if test_type is not None and (not isinstance(test_type, str) or test_type not in ("mos", "sus", "combined", "mos_sus")):
        errors.append("test_type: must be 'mos', 'sus', or 'combined'")
    language = value.get("language")
    if language is not None and (not isinstance(language, str) or language not in ("id", "en", "zh")):
        errors.append("language: must be 'id', 'en', or 'zh'")
    audio = value.get("audio")
    if not isinstance(audio, dict):
        errors.append("audio: required mapping")
        audio = {}
    calibration_audio_ref = value.get("calibration_audio_ref")
    if calibration_audio_ref is not None:
        if not isinstance(calibration_audio_ref, str) or not calibration_audio_ref.strip():
            errors.append("calibration_audio_ref: must be a non-empty string")
        elif not errors and calibration_audio_ref not in audio:
            errors.append("calibration_audio_ref: unknown audio reference")
    pages = value.get("pages")
    if not isinstance(pages, list):
        errors.append("pages: required list")
        pages = []
    else:
        kinds: list[str] = []
        for index, page in enumerate(pages):
            if not isinstance(page, dict):
                errors.append(f"pages[{index}]: must be a mapping")
                continue
            errors.extend(f"pages[{index}]: unknown key '{key}'" for key in page if key not in PAGE_KEYS)
            kind = page.get("kind")
            if kind not in PAGE_ORDER:
                errors.append(f"pages[{index}].kind: unknown page kind")
            else:
                kinds.append(kind)
            if kind == "demographics":
                fields = page.get("fields")
                if fields is not None:
                    if not isinstance(fields, list) or not all(isinstance(field, str) for field in fields):
                        errors.append(f"pages[{index}].fields: must be a list of strings")
                    elif "normal_hearing" not in fields:
                        errors.append(f"pages[{index}].fields: must include mandatory 'normal_hearing' field")
            if kind == "sus":
                for stimulus in page.get("stimuli", []):
                    if isinstance(stimulus, dict) and stimulus.get("audio_ref") not in audio:
                        errors.append(f"pages[{index}].stimuli: unknown audio reference")
        positions = [PAGE_ORDER.index(kind) for kind in kinds]
        if not kinds or kinds[0] != "consent" or kinds[-1] != "completion" or positions != sorted(positions):
            errors.append("pages: order must start with consent and end with completion")
        if kinds and kinds[-1] != "completion":
            errors.append("pages: completion must be last")
        if kinds and kinds[0] != "consent":
            errors.append("pages: consent must be first")
    mos = value.get("mos")
    if mos is not None:
        if not isinstance(mos, dict):
            errors.append("mos: must be a mapping")
        else:
            minimum, maximum, labels = mos.get("min"), mos.get("max"), mos.get("labels")
            if not isinstance(minimum, int) or not isinstance(maximum, int) or minimum >= maximum:
                errors.append("mos: min must be less than max")
            elif not isinstance(labels, list) or len(labels) != maximum - minimum + 1:
                errors.append("mos: label count must match scale points")
            if mos.get("prompt") is not None and not isinstance(mos.get("prompt"), str):
                errors.append("mos.prompt: must be a string")
    sus = value.get("sus")
    if sus is not None:
        if not isinstance(sus, dict):
            errors.append("sus: must be a mapping")
        elif "quota" in sus and (not isinstance(sus["quota"], int) or sus["quota"] < 1):
            errors.append("sus.quota: must be a positive integer")
        else:
            sus.setdefault("quota", 2)
    if errors:
        raise ConfigValidationError(errors)
    return value


def dump_config(config: dict[str, Any]) -> str:
    return yaml.safe_dump(config, sort_keys=False, allow_unicode=True)


def rebuild_pages(pages: list[Any], items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    existing = [page for page in pages if isinstance(page, dict)]
    titles = {kind: next((page.get("title") for page in existing if page.get("kind") == kind), None) for kind in ("mos", "sus")}
    kept = [page for page in existing if page.get("kind") not in ("mos", "sus")]
    completion = [page for page in kept if page.get("kind") == "completion"]
    middle = [page for page in kept if page.get("kind") != "completion"]
    task_pages = []
    for kind in ("mos", "sus"):
        stimuli = [{"audio_ref": item["audio_ref"]} for item in items if item["kind"] == kind]
        if stimuli:
            fallback = "Rate each sample" if kind == "mos" else "Type what you hear"
            title = titles[kind] if isinstance(titles[kind], str) else fallback
            task_pages.append({"kind": kind, "title": title, "stimuli": stimuli})
    return middle + task_pages + completion
