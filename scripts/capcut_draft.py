#!/usr/bin/env python3
"""
CapCut draft generation script
Input: JSON (segments + caption-unit ttsFiles + srt info)
Output: CapCut draft folder + ZIP
"""

import json
import math
import os
import shutil
import subprocess
import sys
import time
import zipfile
import re
import uuid
from datetime import datetime

FFMPEG_BIN = os.environ.get("FFMPEG_PATH") or "ffmpeg"
FFPROBE_BIN = os.environ.get("FFPROBE_PATH") or "ffprobe"
MIDFORM_HYBRID_DUCKED_SOURCE_VOLUME = 0.3
MIDFORM_FINAL_SLOT_TAIL_ALLOWANCE_SEC = float(os.environ.get("MIDFORM_FINAL_SLOT_TAIL_ALLOWANCE_SEC") or 7.0)
PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
CAPTION_COLORS_CONFIG_PATH = os.path.join(PROJECT_ROOT, "midform", "config", "caption_colors.json")
DURATION_CONFIG_PATH = os.path.join(PROJECT_ROOT, "midform", "config", "duration.json")
PORTRAIT_CROP_CONFIG_PATH = os.path.join(PROJECT_ROOT, "midform", "config", "portrait_crop.json")

try:
    import cv2  # type: ignore
except ImportError:
    cv2 = None

try:
    import pyCapCut as cc  # type: ignore
except ImportError:
    try:
        import pycapcut as cc  # type: ignore
    except ImportError:
        print(json.dumps({"error": "pyCapCut not installed. Run: pip install pyCapCut"}))
        sys.exit(1)


# Full draft one-line captions use CapCut's normalized transform coordinates.
# On a 1080x1920 canvas, -0.36 maps to roughly Y=-691 in the CapCut UI.
FULL_CUT_CAPTION_X = 0.0
FULL_CUT_CAPTION_Y = -0.36
FULL_CUT_CAPTION_FONT_SIZE = 15.0
FULL_CUT_CAPTION_FIXED_WIDTH = -1.0
FULL_CUT_CAPTION_FIXED_HEIGHT = -1.0
FULL_CUT_CAPTION_LINE_MAX_WIDTH = 0.0
FULL_CUT_CAPTION_ANIMATION_RATIO = 0.10
FULL_CUT_CAPTION_MIN_ANIMATION_US = 40_000
FULL_CUT_CAPTION_MIN_DISPLAY_US = 800_000
# CapCut can make the text box selectable while rendering glyphs invisible when
# full-draft one-line captions overflow the sampled 9:16 text box. These are
# intentionally conservative limits for font size 14-15 and width ~720.
FULL_CUT_CAPTION_SAFE_MAX_CHARS_JA = 10
FULL_CUT_CAPTION_SAFE_MAX_CHARS_KO = 12

# Highlight drafts use one longer explainer caption. Keep it separate from the
# full-draft one-line cut captions so the forced visibility pass does not turn a
# paragraph into an off-screen single-line box.
HIGHLIGHT_EXPLAINER_X = 0.0
HIGHLIGHT_EXPLAINER_Y = -0.6
HIGHLIGHT_EXPLAINER_FONT_SIZE = 9.0
HIGHLIGHT_EXPLAINER_FIXED_WIDTH = 720.0
HIGHLIGHT_EXPLAINER_ANIMATION_RATIO = 0.5
HIGHLIGHT_EXPLAINER_MIN_ANIMATION_US = 140_000


def srt_time_to_seconds(time_str):
    time_str = time_str.replace(",", ".")
    parts = time_str.split(":")
    hours = int(parts[0])
    minutes = int(parts[1])
    seconds = float(parts[2])
    return hours * 3600 + minutes * 60 + seconds


def parse_srt(srt_path):
    entries = []
    with open(srt_path, "r", encoding="utf-8") as file:
        content = file.read().strip()

    blocks = content.split("\n\n")
    for block in blocks:
        lines = block.strip().split("\n")
        if len(lines) < 3:
            continue

        timecode_line = lines[1]
        text = "\n".join(lines[2:])
        parts = timecode_line.split(" --> ")
        if len(parts) != 2:
            continue

        start_sec = srt_time_to_seconds(parts[0].strip())
        end_sec = srt_time_to_seconds(parts[1].strip())
        entries.append({"start_sec": start_sec, "end_sec": end_sec, "text": text})
    return entries


def normalize_text_value(value):
    return re.sub(r"\s+", " ", str(value or "")).strip()


def load_caption_color_config():
    if not os.path.exists(CAPTION_COLORS_CONFIG_PATH):
        return {"roles": {}, "speakers": {}}
    try:
        with open(CAPTION_COLORS_CONFIG_PATH, "r", encoding="utf-8-sig") as file:
            data = json.load(file)
    except Exception:
        return {"roles": {}, "speakers": {}}
    return data if isinstance(data, dict) else {"roles": {}, "speakers": {}}


def load_duration_config():
    defaults = {"min_duration_sec": 60.0, "max_duration_sec": 160.0}
    if not os.path.exists(DURATION_CONFIG_PATH):
        return defaults
    try:
        with open(DURATION_CONFIG_PATH, "r", encoding="utf-8-sig") as file:
            data = json.load(file)
    except Exception:
        return defaults
    if not isinstance(data, dict):
        return defaults
    return {
        "min_duration_sec": safe_float(data.get("min_duration_sec"), defaults["min_duration_sec"]),
        "max_duration_sec": safe_float(data.get("max_duration_sec"), defaults["max_duration_sec"]),
    }


def build_duration_guide_report(total_duration_sec, source_label="tts_measured_total_sec"):
    config = load_duration_config()
    min_sec = safe_float(config.get("min_duration_sec"), 60.0)
    max_sec = safe_float(config.get("max_duration_sec"), 160.0)
    duration_sec = safe_float(total_duration_sec, 0.0)
    status = "ok"
    message = "final measured duration is within guide"
    if duration_sec > max_sec:
        status = "warn"
        message = f"final measured duration {round(duration_sec, 3)}s exceeds max_duration_sec {round(max_sec, 3)}s"
    elif 0 < duration_sec < min_sec:
        status = "warn"
        message = f"final measured duration {round(duration_sec, 3)}s is below min_duration_sec {round(min_sec, 3)}s"
    return {
        "status": status,
        "source": source_label,
        "total_duration_sec": round(duration_sec, 6),
        "min_duration_sec": min_sec,
        "max_duration_sec": max_sec,
        "message": message,
    }


def caption_color_for_speaker(speaker, config):
    speaker_key = normalize_text_value(speaker)
    if not speaker_key or not isinstance(config, dict):
        return ""
    speakers = config.get("speakers") if isinstance(config.get("speakers"), dict) else {}
    roles = config.get("roles") if isinstance(config.get("roles"), dict) else {}
    mapped = normalize_text_value(speakers.get(speaker_key))
    if mapped.startswith("#"):
        return mapped
    role_color = normalize_text_value(roles.get(mapped))
    if role_color.startswith("#"):
        return role_color
    direct_role_color = normalize_text_value(roles.get(speaker_key))
    if direct_role_color.startswith("#"):
        return direct_role_color
    return ""


def caption_color_for_key(speaker_color_key, config):
    key = normalize_text_value(speaker_color_key)
    if not key or not isinstance(config, dict):
        return ""
    if key.startswith("#"):
        return key
    roles = config.get("roles") if isinstance(config.get("roles"), dict) else {}
    role_color = normalize_text_value(roles.get(key))
    return role_color if role_color.startswith("#") else ""


def resolve_caption_color_for_dialogue(speaker, speaker_color_key, config):
    return caption_color_for_key(speaker_color_key, config) or caption_color_for_speaker(speaker, config)


def hex_to_rgb_float_list(hex_color):
    raw = normalize_text_value(hex_color)
    if raw.startswith("#"):
        raw = raw[1:]
    if len(raw) == 8:
        raw = raw[:6]
    if len(raw) != 6:
        return None
    try:
        return [int(raw[0:2], 16) / 255.0, int(raw[2:4], 16) / 255.0, int(raw[4:6], 16) / 255.0]
    except Exception:
        return None


def apply_text_material_fill_color(material, hex_color):
    rgb = hex_to_rgb_float_list(hex_color)
    if not isinstance(material, dict) or rgb is None:
        return False
    content_json = parse_json_text_content(material.get("content"))
    if not isinstance(content_json, dict):
        return False
    styles = content_json.get("styles")
    if not isinstance(styles, list) or not styles:
        styles = [{"range": [0, len(str(content_json.get("text") or ""))]}]
        content_json["styles"] = styles
    for style_item in styles:
        if not isinstance(style_item, dict):
            continue
        style_item["useLetterColor"] = True
        fill = style_item.setdefault("fill", {})
        if not isinstance(fill, dict):
            continue
        fill["alpha"] = fill.get("alpha", 1.0)
        content = fill.setdefault("content", {})
        if not isinstance(content, dict):
            continue
        content["render_type"] = content.get("render_type") or "solid"
        solid = content.setdefault("solid", {})
        if not isinstance(solid, dict):
            continue
        solid["alpha"] = solid.get("alpha", 1.0)
        solid["color"] = rgb
    material["content"] = json.dumps(content_json, ensure_ascii=False)
    material["text_color"] = f"#{normalize_text_value(hex_color).lstrip('#')[:6].upper()}"
    material["use_effect_default_color"] = False
    return True


def preserve_glow_effect_layers_for_colored_caption(material, segment, draft_doc):
    """Keep template glow/effect refs while letting speaker fill color drive dialogue text.

    Narration captions already inherit TEMPLATE_SUBTITLE's readability glow. Dialogue
    captions use the same template material chain, then override the fill color per
    speaker. Do not remove text_effect/bloom refs here; `use_effect_default_color =
    False` keeps speaker color distinct while the cloned glow remains for readability.
    """
    if isinstance(material, dict):
        content_json = parse_json_text_content(material.get("content"))
        if isinstance(content_json, dict):
            for style_item in content_json.get("styles") or []:
                if isinstance(style_item, dict):
                    style_item.pop("effectStyle", None)
            content_json.pop("effect", None)
            material["content"] = json.dumps(content_json, ensure_ascii=False)
    return 0


def srt_timestamp_from_us(value_us):
    total_ms = max(0, int(round(value_us / 1000)))
    hours = total_ms // 3_600_000
    total_ms %= 3_600_000
    minutes = total_ms // 60_000
    total_ms %= 60_000
    seconds = total_ms // 1000
    milliseconds = total_ms % 1000
    return f"{hours:02d}:{minutes:02d}:{seconds:02d},{milliseconds:03d}"


def write_srt_entries(srt_path, entries):
    lines = []
    for index, entry in enumerate(entries, start=1):
        start_us = int(entry.get("timeline_start_us", 0) or 0)
        end_us = int(entry.get("timeline_end_us", start_us) or start_us)
        text = str(entry.get("text") or "").strip()
        if not text or end_us <= start_us:
            continue
        lines.extend(
            [
                str(index),
                f"{srt_timestamp_from_us(start_us)} --> {srt_timestamp_from_us(end_us)}",
                text,
                "",
            ]
        )
    with open(srt_path, "w", encoding="utf-8") as file:
        file.write("\n".join(lines).rstrip() + "\n")


def parse_timecode_to_sec(value):
    if value is None:
        return None
    raw = str(value).strip()
    if not raw:
        return None
    normalized = raw.replace(",", ".")
    parts = normalized.split(":")
    try:
        if len(parts) == 2:
            minutes = int(parts[0])
            seconds = float(parts[1])
            return minutes * 60 + seconds
        if len(parts) == 3:
            hours = int(parts[0])
            minutes = int(parts[1])
            seconds = float(parts[2])
            return hours * 3600 + minutes * 60 + seconds
    except (TypeError, ValueError):
        return None
    return None


def zip_folder(folder_path, zip_path, zip_root_base):
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zipf:
        for root, _, files in os.walk(folder_path):
            for name in files:
                file_path = os.path.join(root, name)
                arcname = os.path.relpath(file_path, zip_root_base)
                zipf.write(file_path, arcname)


def write_notes_file(notes_path, notes_lines):
    with open(notes_path, "w", encoding="utf-8") as notes_file:
        notes_file.write("\n".join(notes_lines) + "\n")


def load_json_file(json_path):
    with open(json_path, "r", encoding="utf-8-sig") as file:
        return json.load(file)


def load_json_file_if_exists(json_path):
    raw_path = str(json_path or "").strip()
    if not raw_path:
        return None
    candidate = raw_path if os.path.isabs(raw_path) else os.path.abspath(raw_path)
    if not os.path.exists(candidate):
        return None
    return load_json_file(candidate)


def find_draft_content_in_folder(template_base):
    if not os.path.isdir(template_base):
        return None

    direct_draft_content = os.path.join(template_base, "draft_content.json")
    if os.path.isfile(direct_draft_content):
        direct_meta = os.path.join(template_base, "draft_meta_info.json")
        return {
            "template_base": template_base,
            "template_root": template_base,
            "draft_content_path": direct_draft_content,
            "draft_meta_info_path": direct_meta if os.path.isfile(direct_meta) else "",
            "depth": 0,
            "resource_entries": sorted(
                [name for name in os.listdir(template_base) if os.path.isdir(os.path.join(template_base, name))]
            ),
        }

    candidates = []
    for root, _, files in os.walk(template_base):
        rel = os.path.relpath(root, template_base)
        depth = 0 if rel == "." else rel.count(os.sep) + 1
        if depth > 2:
            continue
        if "draft_content.json" not in files:
            continue
        draft_content_path = os.path.join(root, "draft_content.json")
        draft_meta_info_path = os.path.join(root, "draft_meta_info.json")
        has_meta = os.path.isfile(draft_meta_info_path)
        candidates.append(
            {
                "template_base": template_base,
                "template_root": root,
                "draft_content_path": draft_content_path,
                "draft_meta_info_path": draft_meta_info_path if has_meta else "",
                "depth": depth,
                "has_meta": has_meta,
                "resource_entries": sorted(
                    [name for name in os.listdir(root) if os.path.isdir(os.path.join(root, name))]
                ),
            }
        )

    if not candidates:
        return None

    candidates.sort(key=lambda item: (0 if item["has_meta"] else 1, item["depth"], item["template_root"]))
    chosen = candidates[0]
    return chosen


def find_capcut_draft_template_by_name(search_root, draft_name):
    if not search_root or not draft_name:
        return None
    search_root = os.path.abspath(str(search_root))
    if not os.path.isdir(search_root):
        return None
    requested = str(draft_name).strip()
    if not requested:
        return None

    exact = os.path.join(search_root, requested)
    if os.path.isdir(exact):
        found = find_draft_content_in_folder(exact)
        if found:
            found["source"] = "capcut_draft_root_exact"
            found["draft_name"] = os.path.basename(exact)
            return found

    requested_lower = requested.casefold()
    candidates = []
    for entry in os.scandir(search_root):
        if not entry.is_dir():
            continue
        entry_lower = entry.name.casefold()
        if entry_lower == requested_lower or requested_lower in entry_lower:
            found = find_draft_content_in_folder(entry.path)
            if found:
                found["source"] = "capcut_draft_root_name"
                found["draft_name"] = entry.name
                candidates.append(found)
    if not candidates:
        return None
    candidates.sort(key=lambda item: (0 if item.get("draft_name", "").casefold() == requested_lower else 1, item.get("draft_name", "")))
    return candidates[0]


def find_capcut_template_files(template_id="channel_default", process_config=None):
    process_config = process_config if isinstance(process_config, dict) else {}
    draft_template_name = str(
        process_config.get("capcut_template_draft_name")
        or process_config.get("capcut_template_name")
        or ""
    ).strip()
    draft_roots = []
    for key in ["capcut_template_search_root", "capcut_draft_root", "output_root"]:
        value = str(process_config.get(key) or "").strip()
        if value:
            draft_roots.append(value)
    output_config = process_config.get("output") if isinstance(process_config.get("output"), dict) else {}
    if output_config.get("output_root"):
        draft_roots.append(str(output_config.get("output_root")))

    if draft_template_name:
        for draft_root in draft_roots:
            found = find_capcut_draft_template_by_name(draft_root, draft_template_name)
            if found:
                return found

    repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    safe_template_id = os.path.basename(str(template_id or "channel_default"))
    template_base = os.path.join(repo_root, "templates", "capcut", safe_template_id)
    found = find_draft_content_in_folder(os.path.abspath(template_base))
    if found:
        found["source"] = "project_templates"
        found["draft_name"] = safe_template_id
    return found


def parse_hex_color_to_rgb_tuple(color_value):
    if not isinstance(color_value, str):
        return None
    raw = color_value.strip()
    if not raw:
        return None
    if raw.startswith("#"):
        hex_value = raw[1:]
    else:
        hex_value = raw
    if len(hex_value) != 6:
        return None
    try:
        r = int(hex_value[0:2], 16) / 255.0
        g = int(hex_value[2:4], 16) / 255.0
        b = int(hex_value[4:6], 16) / 255.0
    except ValueError:
        return None
    return (r, g, b)


def safe_float(value, default_value=0.0):
    try:
        return float(value)
    except (TypeError, ValueError):
        if default_value is None:
            return None
        return float(default_value)


def first_non_empty_string(*values):
    for value in values:
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def coerce_bool(value, default_value=False):
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        lower = value.strip().lower()
        if lower in {"true", "1", "yes", "y", "on"}:
            return True
        if lower in {"false", "0", "no", "n", "off"}:
            return False
    return default_value


def resolve_draft_output_policy(config=None):
    data = config if isinstance(config, dict) else {}
    mode = normalize_text_value(data.get("draft_output_mode") or data.get("draftOutputMode") or data.get("output_mode") or data.get("outputMode")).lower()
    package_zip = data.get("package_zip") if "package_zip" in data else data.get("packageZip")
    if mode in {"folder_and_zip", "zip", "both"}:
        create_zip = True
        mode = "folder_and_zip"
    elif mode in {"folder_only", "folder", "draft_folder"}:
        create_zip = False
        mode = "folder_only"
    elif package_zip is not None:
        create_zip = coerce_bool(package_zip, False)
        mode = "folder_and_zip" if create_zip else "folder_only"
    else:
        create_zip = False
        mode = "folder_only"
    return {"mode": mode, "create_zip": create_zip}


def parse_json_text_content(raw_text):
    if not isinstance(raw_text, str):
        return None
    stripped = raw_text.strip()
    if not stripped:
        return None
    if not (stripped.startswith("{") and stripped.endswith("}")):
        return None
    try:
        return json.loads(stripped)
    except json.JSONDecodeError:
        return None


def extract_effect_style_from_content(text_material):
    content_json = parse_json_text_content(text_material.get("content"))
    if not isinstance(content_json, dict):
        return {}
    styles = content_json.get("styles")
    if not isinstance(styles, list) or not styles:
        return {}
    style_item = styles[0] if isinstance(styles[0], dict) else {}
    effect_style = style_item.get("effectStyle")
    if isinstance(effect_style, dict):
        return {
            "effect_id": str(effect_style.get("id") or "").strip(),
            "effect_path": str(effect_style.get("path") or "").strip(),
        }
    return {}


def detect_template_role_marker(text_material):
    candidates = []
    for key in ["content", "base_content", "recognize_text", "name", "text"]:
        value = text_material.get(key)
        if isinstance(value, str):
            candidates.append(value)
    parsed_content = parse_json_text_content(text_material.get("content"))
    if isinstance(parsed_content, dict):
        inner_text = parsed_content.get("text")
        if isinstance(inner_text, str):
            candidates.append(inner_text)

    joined = " ".join(candidates).upper()
    for marker in [
        "TEMPLATE_TITLE",
        "TEMPLATE_TITLE_SUBLINE",
        "TEMPLATE_SUBTITLE",
        "TEMPLATE_EMPHASIS",
        "TEMPLATE_PRETITLE",
        "TEMPLATE_MOVIE_TITLE",
        "TEMPLATE_CHANNEL_TAG",
        "TEMPLATE_FULL_CAPTION",
        "TEMPLATE_HIGHLIGHT_EXPLAINER",
        "TEMPLATE_EXPLAINER",
        "TEMPLATE_STEP_LABEL",
        "TEMPLATE_METRIC",
        "TEMPLATE_CALLOUT",
        "TEMPLATE_SOURCE_NOTE",
    ]:
        if marker in joined:
            return marker
    return ""


def normalize_font_enum_key(value):
    if not isinstance(value, str):
        return ""
    cleaned = re.sub(r"[^A-Za-z0-9_]+", "_", value.strip())
    cleaned = re.sub(r"_+", "_", cleaned).strip("_")
    return cleaned


def resolve_template_font_type(text_material):
    candidates = []
    for key in ["font_name", "font_id"]:
        raw = text_material.get(key)
        if isinstance(raw, str) and raw.strip():
            candidates.append(raw.strip())
    font_path = text_material.get("font_path")
    if isinstance(font_path, str) and font_path.strip():
        base = os.path.splitext(os.path.basename(font_path.strip()))[0]
        if base:
            candidates.append(base)

    for item in candidates:
        normalized = normalize_font_enum_key(item)
        if normalized and hasattr(cc.FontType, normalized):
            return getattr(cc.FontType, normalized), normalized
    return None, ""


def clamp_alignment(value, fallback=1):
    if isinstance(value, int) and value in {0, 1, 2}:
        return value
    return fallback


def sanitize_transform_value(value, fallback_value):
    numeric = safe_float(value, fallback_value)
    if numeric < -1.5 or numeric > 1.5:
        return fallback_value, True
    return numeric, False


def estimate_caption_lines(text, chars_per_line=26):
    raw = str(text or "").strip()
    if not raw:
        return 1
    explicit_lines = [line for line in raw.splitlines() if line.strip()]
    if len(explicit_lines) > 1:
        return max(len(explicit_lines), max(1, int((max(len(line.strip()) for line in explicit_lines) + chars_per_line - 1) / chars_per_line)))
    return max(1, int((len(raw) + chars_per_line - 1) / chars_per_line))


def apply_dynamic_explainer_position(segment, text_value):
    """Move long explainer captions upward so the lower edge stays visible."""
    if not isinstance(segment, dict):
        return None
    clip = segment.get("clip")
    if not isinstance(clip, dict):
        return None
    transform = clip.get("transform")
    if not isinstance(transform, dict):
        transform = {"x": 0.0, "y": 0.75}
        clip["transform"] = transform

    original_y = safe_float(transform.get("y"), 0.75)
    text_length = len(str(text_value or "").strip())
    estimated_lines = estimate_caption_lines(text_value)

    if estimated_lines <= 2 and text_length <= 54:
        offset = 0.0
    elif estimated_lines == 3 or text_length <= 82:
        offset = 0.08
    elif estimated_lines == 4 or text_length <= 112:
        offset = 0.15
    else:
        offset = 0.23

    new_y = max(-1.1, min(1.1, original_y - offset))
    transform["y"] = new_y
    return {
        "text_length": text_length,
        "estimated_lines": estimated_lines,
        "original_y": round(original_y, 4),
        "adjusted_y": round(new_y, 4),
        "offset": round(offset, 4),
        "applied": abs(new_y - original_y) > 0.0001,
    }


def apply_process_caption_style_profile(material, segment, style_profile):
    """Strengthen process cut captions while keeping them readable in CapCut."""
    profile = str(style_profile or "").strip()
    if not profile or not isinstance(material, dict):
        return {"profile": profile, "applied": False}

    if profile == "full_cut_caption":
        original_font_size = safe_float(material.get("font_size"), FULL_CUT_CAPTION_FONT_SIZE)
        material["font_size"] = original_font_size if original_font_size > 0 else FULL_CUT_CAPTION_FONT_SIZE
        material["text_color"] = material.get("text_color") or "#FFF2A6"
        material["text_alpha"] = 1.0
        material["global_alpha"] = 1.0
        material["use_effect_default_color"] = True
        material["has_border"] = True
        material["border_width"] = max(safe_float(material.get("border_width"), 0.0), 0.115)
        material["border_alpha"] = max(safe_float(material.get("border_alpha"), 0.0), 1.0)
        material["border_color"] = material.get("border_color") or "#000000"
        material["border_mode"] = 0
        material["has_shadow"] = True
        material["shadow_color"] = "#000000"
        material["shadow_alpha"] = max(safe_float(material.get("shadow_alpha"), 0.0), 0.82)
        material["shadow_distance"] = max(safe_float(material.get("shadow_distance"), 0.0), 7.0)
        material["shadow_angle"] = safe_float(material.get("shadow_angle"), -45.0)
        material["shadow_smoothing"] = max(safe_float(material.get("shadow_smoothing"), 0.0), 0.36)
        material["bold_width"] = max(safe_float(material.get("bold_width"), 0.0), 0.08)
        material["bold_width_rate"] = max(safe_float(material.get("bold_width_rate"), 0.0), 0.18)
        material["oneline_cutoff"] = False
        material["line_feed"] = 0
        material["fixed_width"] = FULL_CUT_CAPTION_FIXED_WIDTH
        material["fixed_height"] = FULL_CUT_CAPTION_FIXED_HEIGHT
        material["force_apply_line_max_width"] = False
        material["line_max_width"] = FULL_CUT_CAPTION_LINE_MAX_WIDTH
        material["background_color"] = material.get("background_color") or "#000000"
        material["background_alpha"] = max(safe_float(material.get("background_alpha"), 0.0), 0.28)
        material["background_round_radius"] = max(safe_float(material.get("background_round_radius"), 0.0), 0.14)
        material["single_char_bg_enable"] = False
        if isinstance(segment, dict):
            clip = segment.setdefault("clip", {})
            scale = clip.setdefault("scale", {})
            scale["x"] = 1.0
            scale["y"] = 1.0
        return {
            "profile": profile,
            "applied": True,
            "font_size": material["font_size"],
            "text_color": material["text_color"],
            "border_width": material["border_width"],
            "shadow_alpha": material["shadow_alpha"],
            "background_alpha": material["background_alpha"],
            "oneline_cutoff": material["oneline_cutoff"],
            "fixed_width": material["fixed_width"],
            "fixed_height": material["fixed_height"],
        }

    if profile == "highlight_explainer":
        original_font_size = safe_float(material.get("font_size"), HIGHLIGHT_EXPLAINER_FONT_SIZE)
        material["font_size"] = original_font_size if original_font_size > 0 else HIGHLIGHT_EXPLAINER_FONT_SIZE
        material["text_color"] = material.get("text_color") or "#FFF2A6"
        material["text_alpha"] = 1.0
        material["global_alpha"] = 1.0
        material["use_effect_default_color"] = True
        material["has_border"] = True
        material["border_width"] = max(safe_float(material.get("border_width"), 0.0), 0.095)
        material["border_alpha"] = max(safe_float(material.get("border_alpha"), 0.0), 0.82)
        material["border_color"] = material.get("border_color") or "#000000"
        material["border_mode"] = 0
        material["has_shadow"] = True
        material["shadow_color"] = "#000000"
        material["shadow_alpha"] = max(safe_float(material.get("shadow_alpha"), 0.0), 0.82)
        material["shadow_distance"] = max(safe_float(material.get("shadow_distance"), 0.0), 7.0)
        material["shadow_angle"] = safe_float(material.get("shadow_angle"), -45.0)
        material["shadow_smoothing"] = max(safe_float(material.get("shadow_smoothing"), 0.0), 0.28)
        material["bold_width"] = max(safe_float(material.get("bold_width"), 0.0), 0.04)
        material["bold_width_rate"] = max(safe_float(material.get("bold_width_rate"), 0.0), 0.1)
        material["oneline_cutoff"] = False
        material["line_feed"] = 1
        material["fixed_width"] = HIGHLIGHT_EXPLAINER_FIXED_WIDTH
        material["fixed_height"] = -1.0
        material["force_apply_line_max_width"] = True
        material["line_max_width"] = max(safe_float(material.get("line_max_width"), 0.0), 0.82)
        material["background_color"] = material.get("background_color") or "#000000"
        material["background_alpha"] = max(safe_float(material.get("background_alpha"), 0.0), 0.34)
        material["background_round_radius"] = max(safe_float(material.get("background_round_radius"), 0.0), 0.14)
        material["single_char_bg_enable"] = False
        if isinstance(segment, dict):
            clip = segment.setdefault("clip", {})
            scale = clip.setdefault("scale", {})
            scale["x"] = 1.0
            scale["y"] = 1.0
            transform = clip.setdefault("transform", {})
            transform["x"] = HIGHLIGHT_EXPLAINER_X
            transform["y"] = HIGHLIGHT_EXPLAINER_Y
        return {
            "profile": profile,
            "applied": True,
            "font_size": material["font_size"],
            "text_color": material["text_color"],
            "border_width": material["border_width"],
            "shadow_alpha": material["shadow_alpha"],
            "background_alpha": material["background_alpha"],
            "oneline_cutoff": material["oneline_cutoff"],
            "fixed_width": material["fixed_width"],
            "fixed_height": material["fixed_height"],
        }

    return {"profile": profile, "applied": False}


def build_text_profile(track, track_index, segment):
    material = segment.get("_material") or {}
    clip = segment.get("clip") if isinstance(segment.get("clip"), dict) else {}
    transform = clip.get("transform") if isinstance(clip.get("transform"), dict) else {}
    scale = clip.get("scale") if isinstance(clip.get("scale"), dict) else {}
    flip = clip.get("flip") if isinstance(clip.get("flip"), dict) else {}
    effect_style = extract_effect_style_from_content(material)
    marker = detect_template_role_marker(material)
    font_type, font_key = resolve_template_font_type(material)

    return {
        "marker": marker,
        "source": {
            "track_index": track_index,
            "track_id": track.get("id"),
            "track_name": track.get("name"),
            "track_type": track.get("type"),
            "track_attribute": track.get("attribute"),
            "segment_id": segment.get("id"),
            "material_id": material.get("id"),
            "track_render_index": segment.get("track_render_index"),
            "render_index": segment.get("render_index"),
        },
        "style": {
            "font_path": material.get("font_path", ""),
            "font_name": material.get("font_name", ""),
            "font_id": material.get("font_id", ""),
            "font_type": font_type,
            "font_type_key": font_key,
            "font_size": safe_float(material.get("font_size"), 11.0),
            "color_hex": material.get("text_color", "#FFFFFF"),
            "alpha": safe_float(material.get("text_alpha"), 1.0),
            "alignment": clamp_alignment(material.get("alignment"), 1),
            "line_spacing": safe_float(material.get("line_spacing"), 0.0),
            "letter_spacing": int(safe_float(material.get("letter_spacing"), 0)),
            "bold": safe_float(material.get("bold_width_rate"), 0.0) > 0,
            "italic": safe_float(material.get("italic_degree"), 0.0) > 0,
            "underline": coerce_bool(material.get("underline"), False),
            "shadow": {
                "enabled": coerce_bool(material.get("has_shadow"), False),
                "color": material.get("shadow_color", ""),
                "alpha": safe_float(material.get("shadow_alpha"), 1.0),
                "distance": safe_float(material.get("shadow_distance"), 0.0),
                "angle": safe_float(material.get("shadow_angle"), 0.0),
            },
            "outline": {
                "width": safe_float(material.get("border_width"), 0.0),
                "color": material.get("border_color", ""),
                "alpha": safe_float(material.get("border_alpha"), 1.0),
            },
            "background": {
                "color": material.get("background_color", ""),
                "alpha": safe_float(material.get("background_alpha"), 1.0),
            },
        },
        "clip": {
            "alpha": safe_float(clip.get("alpha"), 1.0),
            "rotation": safe_float(clip.get("rotation"), 0.0),
            "scale_x": safe_float(scale.get("x"), 1.0),
            "scale_y": safe_float(scale.get("y"), 1.0),
            "transform_x": safe_float(transform.get("x"), 0.0),
            "transform_y": safe_float(transform.get("y"), 0.75),
            "flip_horizontal": coerce_bool(flip.get("horizontal"), False),
            "flip_vertical": coerce_bool(flip.get("vertical"), False),
        },
        "effects": effect_style,
    }


def extract_template_text_profiles(template_draft_content):
    tracks = template_draft_content.get("tracks") if isinstance(template_draft_content, dict) else []
    materials = (template_draft_content.get("materials") if isinstance(template_draft_content, dict) else {}) or {}
    text_materials = {
        material.get("id"): material
        for material in (materials.get("texts") or [])
        if isinstance(material, dict) and material.get("id")
    }

    profiles = []
    for track_index, track in enumerate(tracks or []):
        if not isinstance(track, dict) or track.get("type") != "text":
            continue
        segments = track.get("segments") or []
        for segment in segments:
            if not isinstance(segment, dict):
                continue
            material_id = segment.get("material_id")
            material = text_materials.get(material_id)
            if not isinstance(material, dict):
                continue
            seg_with_material = dict(segment)
            seg_with_material["_material"] = material
            profiles.append(build_text_profile(track, track_index, seg_with_material))

    if not profiles:
        return {"title": None, "subtitle": None, "emphasis": None, "sources": {}, "summary": []}

    role_map = {"title": None, "subtitle": None, "emphasis": None}
    for profile in profiles:
        marker = profile.get("marker") or ""
        if marker == "TEMPLATE_TITLE" and role_map["title"] is None:
            role_map["title"] = profile
        elif marker == "TEMPLATE_SUBTITLE" and role_map["subtitle"] is None:
            role_map["subtitle"] = profile
        elif marker == "TEMPLATE_EMPHASIS" and role_map["emphasis"] is None:
            role_map["emphasis"] = profile

    if role_map["subtitle"] is None:
        role_map["subtitle"] = profiles[0]
    if role_map["title"] is None:
        role_map["title"] = role_map["subtitle"]
    if role_map["emphasis"] is None:
        role_map["emphasis"] = role_map["subtitle"]

    summary = []
    sources = {}
    for role in ["title", "subtitle", "emphasis"]:
        selected = role_map[role]
        if not selected:
            continue
        src = selected.get("source") or {}
        style = selected.get("style") or {}
        clip = selected.get("clip") or {}
        source_label = (
            f"track#{src.get('track_index')} material={src.get('material_id')} segment={src.get('segment_id')}"
        )
        sources[role] = source_label
        summary.append(
            {
                "role": role,
                "source": source_label,
                "font_size": style.get("font_size"),
                "color_hex": style.get("color_hex"),
                "alignment": style.get("alignment"),
                "position": {"x": clip.get("transform_x"), "y": clip.get("transform_y")},
                "scale": {"x": clip.get("scale_x"), "y": clip.get("scale_y")},
                "rotation": clip.get("rotation"),
                "effect_id": (selected.get("effects") or {}).get("effect_id", ""),
            }
        )

    return {
        "title": role_map["title"],
        "subtitle": role_map["subtitle"],
        "emphasis": role_map["emphasis"],
        "sources": sources,
        "summary": summary,
    }


def build_text_render_components_from_profile(profile, warning_collector, fallback_transform_y=0.75):
    fallback_used = False
    if not isinstance(profile, dict):
        fallback_used = True
        default_style = cc.TextStyle(size=11.0, color=(1.0, 1.0, 1.0), align=1, auto_wrapping=True, max_line_width=0.9)
        default_clip = cc.ClipSettings(transform_y=fallback_transform_y)
        return {
            "font": None,
            "style": default_style,
            "clip_settings": default_clip,
            "border": None,
            "background": None,
            "effect_id": "",
            "summary": {"fallback_used": True, "reason": "profile_missing"},
            "fallback_used": fallback_used,
        }

    style_info = profile.get("style") or {}
    clip_info = profile.get("clip") or {}
    effects_info = profile.get("effects") or {}
    source_info = profile.get("source") or {}

    style_kwargs = {
        "size": max(1.0, safe_float(style_info.get("font_size"), 11.0)),
        "bold": coerce_bool(style_info.get("bold"), False),
        "italic": coerce_bool(style_info.get("italic"), False),
        "underline": coerce_bool(style_info.get("underline"), False),
        "alpha": min(1.0, max(0.0, safe_float(style_info.get("alpha"), 1.0))),
        "align": clamp_alignment(style_info.get("alignment"), 1),
        "letter_spacing": int(safe_float(style_info.get("letter_spacing"), 0)),
        "line_spacing": int(safe_float(style_info.get("line_spacing"), 0)),
        "auto_wrapping": True,
        "max_line_width": 0.9,
    }
    parsed_color = parse_hex_color_to_rgb_tuple(style_info.get("color_hex"))
    style_kwargs["color"] = parsed_color if parsed_color is not None else (1.0, 1.0, 1.0)

    transform_x, clipped_x = sanitize_transform_value(clip_info.get("transform_x"), 0.0)
    transform_y, clipped_y = sanitize_transform_value(clip_info.get("transform_y"), fallback_transform_y)
    if clipped_x or clipped_y:
        fallback_used = True
        warning_collector.append("template text position out of bounds; fallback position applied")

    clip_kwargs = {
        "alpha": min(1.0, max(0.0, safe_float(clip_info.get("alpha"), 1.0))),
        "flip_horizontal": coerce_bool(clip_info.get("flip_horizontal"), False),
        "flip_vertical": coerce_bool(clip_info.get("flip_vertical"), False),
        "rotation": safe_float(clip_info.get("rotation"), 0.0),
        "scale_x": safe_float(clip_info.get("scale_x"), 1.0),
        "scale_y": safe_float(clip_info.get("scale_y"), 1.0),
        "transform_x": transform_x,
        "transform_y": transform_y,
    }

    border = None
    outline = style_info.get("outline") or {}
    outline_width = safe_float(outline.get("width"), 0.0)
    outline_color = parse_hex_color_to_rgb_tuple(outline.get("color"))
    if outline_width > 0 and outline_color is not None:
        border = cc.TextBorder(
            width=max(0.1, outline_width),
            color=outline_color,
            alpha=min(1.0, max(0.0, safe_float(outline.get("alpha"), 1.0))),
        )

    background = None
    background_info = style_info.get("background") or {}
    background_color = background_info.get("color")
    if isinstance(background_color, str) and background_color.strip():
        color_value = background_color if background_color.startswith("#") else f"#{background_color}"
        background = cc.TextBackground(
            color=color_value,
            alpha=min(1.0, max(0.0, safe_float(background_info.get("alpha"), 1.0))),
        )

    font = style_info.get("font_type")
    if font is None:
        fallback_used = True
        font = None

    style = cc.TextStyle(**style_kwargs)
    clip_settings = cc.ClipSettings(**clip_kwargs)
    effect_id = str(effects_info.get("effect_id") or "").strip()

    summary = {
        "source_track_index": source_info.get("track_index"),
        "source_material_id": source_info.get("material_id"),
        "source_segment_id": source_info.get("segment_id"),
        "font_path": style_info.get("font_path", ""),
        "font_type_key": style_info.get("font_type_key", ""),
        "font_size": style_kwargs["size"],
        "color_hex": style_info.get("color_hex"),
        "alignment": style_kwargs["align"],
        "outline_applied": border is not None,
        "shadow_enabled": bool((style_info.get("shadow") or {}).get("enabled")),
        "background_applied": background is not None,
        "position": {"x": clip_kwargs["transform_x"], "y": clip_kwargs["transform_y"]},
        "scale": {"x": clip_kwargs["scale_x"], "y": clip_kwargs["scale_y"]},
        "rotation": clip_kwargs["rotation"],
        "effect_id": effect_id,
        "fallback_used": fallback_used,
    }

    return {
        "font": font,
        "style": style,
        "clip_settings": clip_settings,
        "border": border,
        "background": background,
        "effect_id": effect_id,
        "summary": summary,
        "fallback_used": fallback_used,
    }


def new_capcut_id():
    return uuid.uuid4().hex


def get_material_text_value(material):
    if not isinstance(material, dict):
        return ""
    content_json = parse_json_text_content(material.get("content"))
    if isinstance(content_json, dict) and isinstance(content_json.get("text"), str):
        return content_json.get("text")
    for key in ["recognize_text", "base_content", "name", "text"]:
        value = material.get(key)
        if isinstance(value, str) and value.strip():
            return value
    return ""


def set_material_text_value(material, text_value):
    if not isinstance(material, dict):
        return
    normalized = str(text_value or "")
    content_json = parse_json_text_content(material.get("content"))
    if isinstance(content_json, dict):
        content_json["text"] = normalized
        styles = content_json.get("styles")
        if isinstance(styles, list):
            for style_item in styles:
                if isinstance(style_item, dict) and "range" in style_item:
                    style_item["range"] = [0, len(normalized)]
        material["content"] = json.dumps(content_json, ensure_ascii=False)
    material["recognize_text"] = normalized
    material["base_content"] = normalized
    if "name" in material:
        material["name"] = normalized[:64]


def microseconds(seconds_float):
    return int(round(max(0.0, float(seconds_float or 0.0)) * 1_000_000))


def new_capcut_id():
    return uuid.uuid4().hex.upper()


def detect_marker_from_text(text_value):
    if not isinstance(text_value, str):
        return ""
    upper = text_value.upper()
    for marker in [
        "TEMPLATE_PRETITLE",
        "TEMPLATE_TITLE_SUBLINE",
        "TEMPLATE_TITLE",
        "TEMPLATE_SUBTITLE",
        "TEMPLATE_MOVIE_TITLE",
        "TEMPLATE_EMPHASIS",
        "TEMPLATE_CHANNEL_TAG",
        "TEMPLATE_FULL_CAPTION",
        "TEMPLATE_HIGHLIGHT_EXPLAINER",
        "TEMPLATE_EXPLAINER",
        "TEMPLATE_STEP_LABEL",
        "TEMPLATE_METRIC",
        "TEMPLATE_CALLOUT",
        "TEMPLATE_SOURCE_NOTE",
    ]:
        if marker in upper:
            return marker
    return ""


def build_material_index_by_id(draft_doc):
    result = {}
    materials = (draft_doc.get("materials") if isinstance(draft_doc, dict) else {}) or {}
    for category, items in materials.items():
        if not isinstance(items, list):
            continue
        for item in items:
            if not isinstance(item, dict):
                continue
            item_id = item.get("id")
            if not isinstance(item_id, str) or not item_id:
                continue
            result[item_id] = (category, item)
    return result


def ensure_material_category(draft_doc, category):
    materials = draft_doc.setdefault("materials", {})
    if not isinstance(materials.get(category), list):
        materials[category] = []
    return materials[category]


def find_template_text_marker_assets(template_doc, allowed_markers=None):
    allowed = set(allowed_markers or [])
    material_index = build_material_index_by_id(template_doc)
    found = {}
    tracks = template_doc.get("tracks") or []
    for track_index, track in enumerate(tracks):
        if not isinstance(track, dict) or track.get("type") != "text":
            continue
        for segment in track.get("segments") or []:
            if not isinstance(segment, dict):
                continue
            material_id = segment.get("material_id")
            material_entry = material_index.get(material_id)
            if material_entry is None:
                continue
            _, material = material_entry
            text_value = get_material_text_value(material)
            marker = detect_marker_from_text(text_value)
            if not marker:
                continue
            if allowed and marker not in allowed:
                continue
            existing = found.get(marker)
            current_start = int((segment.get("target_timerange") or {}).get("start") or 0)
            existing_start = int(((existing or {}).get("segment") or {}).get("target_timerange", {}).get("start") or -1)
            # Sample drafts sometimes contain old marker copies. Use the last
            # marker on the timeline as the intentional editable marker.
            if existing is None or current_start >= existing_start:
                found[marker] = {
                    "track_index": track_index,
                    "track": track,
                    "segment": segment,
                    "material": material,
                    "text_value": text_value,
                }
    return found


def expected_process_caption_template_markers(process_config, explainer_blocks):
    markers = set()
    if isinstance(process_config, dict):
        variant_policy_id = str(process_config.get("variant_policy_id") or "").strip().lower()
        caption_mode = str(process_config.get("caption_mode") or "").strip().lower()
        if "highlight" in variant_policy_id or caption_mode == "long_bottom_explainer":
            markers.add("TEMPLATE_HIGHLIGHT_EXPLAINER")
        if "full" in variant_policy_id or "midform" in variant_policy_id or caption_mode == "scene_based_short_subtitles":
            markers.add("TEMPLATE_FULL_CAPTION")
    for block in explainer_blocks or []:
        if not isinstance(block, dict):
            continue
        profile = str(block.get("style_profile") or block.get("styleProfile") or "").strip()
        if profile == "highlight_explainer":
            markers.add("TEMPLATE_HIGHLIGHT_EXPLAINER")
        elif profile == "full_cut_caption":
            markers.add("TEMPLATE_FULL_CAPTION")
    return sorted(markers)


def clone_material_dependencies(template_doc, generated_doc, ref_ids, source_to_target_id_map):
    cloned_refs = []
    template_index = build_material_index_by_id(template_doc)
    for ref_id in ref_ids or []:
        if not isinstance(ref_id, str) or not ref_id:
            continue
        if ref_id in source_to_target_id_map:
            cloned_refs.append(source_to_target_id_map[ref_id])
            continue
        template_ref_entry = template_index.get(ref_id)
        if template_ref_entry is None:
            cloned_refs.append(ref_id)
            continue
        category, item = template_ref_entry
        cloned_item = json.loads(json.dumps(item))
        old_id = cloned_item.get("id")
        new_id = new_capcut_id()
        cloned_item["id"] = new_id
        ensure_material_category(generated_doc, category).append(cloned_item)
        source_to_target_id_map[old_id] = new_id
        cloned_refs.append(new_id)
    return cloned_refs


def resolve_template_media_path(template_root, material_path):
    raw_path = str(material_path or "").strip()
    if not raw_path:
        return ""
    if os.path.isabs(raw_path) and os.path.exists(raw_path):
        return raw_path
    if template_root:
        candidate = os.path.abspath(os.path.join(template_root, raw_path))
        if os.path.exists(candidate):
            return candidate
        candidate = os.path.abspath(os.path.join(template_root, os.path.basename(raw_path)))
        if os.path.exists(candidate):
            return candidate
    return raw_path if os.path.exists(raw_path) else ""


def find_template_background_entry(template_doc):
    image_exts = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}
    material_index = build_material_index_by_id(template_doc)
    candidates = []
    for track_index, track in enumerate(template_doc.get("tracks") or []):
        if not isinstance(track, dict) or track.get("type") != "video":
            continue
        track_name = str(track.get("name") or "").strip().lower()
        for segment_index, segment in enumerate(track.get("segments") or []):
            if not isinstance(segment, dict):
                continue
            material_id = segment.get("material_id")
            material_entry = material_index.get(material_id)
            if material_entry is None:
                continue
            category, material = material_entry
            if category != "videos":
                continue
            material_path = str(material.get("path") or "").strip()
            ext = os.path.splitext(material_path)[1].lower()
            if ext not in image_exts:
                continue
            priority = 0 if ("background" in track_name or "template_bg" in track_name or "template_background" in track_name) else 1
            candidates.append(
                {
                    "priority": priority,
                    "track_index": track_index,
                    "segment_index": segment_index,
                    "track": track,
                    "segment": segment,
                    "material": material,
                    "material_path": material_path,
                }
            )
    if not candidates:
        return None
    candidates.sort(key=lambda item: (item["priority"], item["track_index"], item["segment_index"]))
    return candidates[0]


def apply_template_background_layer(generated, template_doc, template_root, draft_path, total_duration_sec, source_to_target_id_map):
    summary = {
        "enabled": True,
        "applied": False,
        "track_name": "template_background",
        "template_track_name": "",
        "template_material_id": "",
        "draft_path": "",
        "source_path": "",
        "reason": "template background image not found",
    }
    entry = find_template_background_entry(template_doc)
    if not entry:
        return summary

    source_path = resolve_template_media_path(template_root, entry.get("material_path"))
    summary["template_track_name"] = str((entry.get("track") or {}).get("name") or "")
    summary["template_material_id"] = str((entry.get("material") or {}).get("id") or "")
    summary["source_path"] = source_path
    if not source_path:
        summary["reason"] = "template background image path not found"
        return summary

    background_dir = os.path.join(draft_path, "background")
    os.makedirs(background_dir, exist_ok=True)
    copied_path = os.path.abspath(os.path.join(background_dir, os.path.basename(source_path)))
    try:
        shutil.copy2(source_path, copied_path)
    except Exception as error:
        summary["reason"] = f"template background image copy failed: {error}"
        return summary

    material = json.loads(json.dumps(entry["material"]))
    old_material_id = material.get("id")
    new_material_id = new_capcut_id()
    material["id"] = new_material_id
    material["path"] = copied_path
    material["name"] = os.path.basename(copied_path)
    if isinstance(old_material_id, str) and old_material_id:
        source_to_target_id_map[old_material_id] = new_material_id
    ensure_material_category(generated, "videos").append(material)

    total_us = max(1, microseconds(total_duration_sec))
    segment = json.loads(json.dumps(entry["segment"]))
    segment["id"] = new_capcut_id()
    segment["material_id"] = new_material_id
    upsert_timerange(segment, 0, total_us)
    segment["visible"] = True
    segment["extra_material_refs"] = clone_material_dependencies(
        template_doc,
        generated,
        segment.get("extra_material_refs") or [],
        source_to_target_id_map,
    )

    tracks = generated.setdefault("tracks", [])
    tracks[:] = [
        track for track in tracks
        if not (isinstance(track, dict) and track.get("type") == "video" and track.get("name") == "template_background")
    ]
    background_track = {
        "id": new_capcut_id(),
        "type": "video",
        "segments": [segment],
        "flag": 1,
        "attribute": 0,
        "name": "template_background",
        "is_default_name": False,
        "visible": True,
    }
    tracks.insert(0, background_track)

    summary.update(
        {
            "applied": True,
            "draft_path": copied_path,
            "reason": "template background image cloned",
        }
    )
    return summary


def is_template_frame_track_name(track_name):
    normalized = str(track_name or "").strip().lower()
    if not normalized:
        return False
    if "background" in normalized or "template_bg" in normalized:
        return False
    aliases = {
        "template_frame_overlay",
        "template_frame",
        "channel_frame_overlay",
        "frame_overlay",
        "overlay_frame",
        "full_frame",
        "highlight_frame",
    }
    return any(alias in normalized for alias in aliases)


def is_template_frame_material(material):
    if not isinstance(material, dict):
        return False
    haystack = " ".join(
        str(material.get(key) or "")
        for key in ["name", "material_name", "path", "file_name", "resource_name"]
    ).strip().lower()
    if not haystack:
        return False
    aliases = {
        "template_frame_overlay",
        "template_frame",
        "channel_frame_overlay",
        "frame_overlay",
        "overlay_frame",
        "full_frame",
        "highlight_frame",
    }
    return any(alias in haystack for alias in aliases)


def find_template_frame_overlay_entries(template_doc):
    material_index = build_material_index_by_id(template_doc)
    entries = []
    for track_index, track in enumerate(template_doc.get("tracks") or []):
        if not isinstance(track, dict) or track.get("type") != "video":
            continue
        track_name = str(track.get("name") or "")
        track_is_frame = is_template_frame_track_name(track_name)
        for segment_index, segment in enumerate(track.get("segments") or []):
            if not isinstance(segment, dict):
                continue
            material_id = segment.get("material_id")
            material_entry = material_index.get(material_id)
            if material_entry is None:
                continue
            category, material = material_entry
            if category != "videos":
                continue
            if not track_is_frame and not is_template_frame_material(material):
                continue
            entries.append(
                {
                    "track_index": track_index,
                    "segment_index": segment_index,
                    "track": track,
                    "segment": segment,
                    "material": material,
                    "material_path": str(material.get("path") or "").strip(),
                }
            )
    entries.sort(key=lambda item: (item["track_index"], item["segment_index"]))
    return entries


def segment_has_mask_reference(draft_doc, segment):
    if not isinstance(draft_doc, dict) or not isinstance(segment, dict):
        return False
    material_index = build_material_index_by_id(draft_doc)
    for ref_id in segment.get("extra_material_refs") or []:
        entry = material_index.get(ref_id)
        if not entry:
            continue
        category, material = entry
        if category == "common_mask":
            return True
        if isinstance(material, dict) and str(material.get("type") or "").lower() == "mask":
            return True
    return False


def apply_template_frame_overlay_layer(generated, template_doc, template_root, draft_path, total_duration_sec, source_to_target_id_map):
    summary = {
        "enabled": True,
        "applied": False,
        "track_name": "channel_frame_overlay",
        "template_track_name": "",
        "segments_count": 0,
        "template_material_ids": [],
        "source_paths": [],
        "draft_paths": [],
        "mask_preserved": False,
        "clip_settings_preserved": False,
        "source_timerange_preserved": False,
        "render_timerange_preserved": False,
        "mask_refs_count": 0,
        "reason": "template frame overlay track not found",
    }
    entries = find_template_frame_overlay_entries(template_doc)
    if not entries:
        return summary

    total_us = max(1, microseconds(total_duration_sec))
    overlay_dir = os.path.join(draft_path, "overlay")
    os.makedirs(overlay_dir, exist_ok=True)
    cloned_segments = []
    source_paths = []
    copied_paths = []
    template_material_ids = []
    mask_preserved = False
    clip_settings_preserved = False
    source_timerange_preserved = False
    render_timerange_preserved = False
    mask_refs_count = 0

    for index, entry in enumerate(entries):
        source_path = resolve_template_media_path(template_root, entry.get("material_path"))
        if not source_path:
            continue
        source_paths.append(source_path)

        basename = os.path.basename(source_path)
        copied_name = f"template_frame_{index + 1:02d}_{basename}"
        copied_path = os.path.abspath(os.path.join(overlay_dir, copied_name))
        try:
            shutil.copy2(source_path, copied_path)
        except Exception:
            continue

        material = json.loads(json.dumps(entry["material"]))
        old_material_id = material.get("id")
        new_material_id = new_capcut_id()
        material["id"] = new_material_id
        material["path"] = copied_path
        material["name"] = os.path.basename(copied_path)
        if isinstance(old_material_id, str) and old_material_id:
            source_to_target_id_map[old_material_id] = new_material_id
            template_material_ids.append(old_material_id)
        ensure_material_category(generated, "videos").append(material)

        segment = json.loads(json.dumps(entry["segment"]))
        original_source_timerange = json.loads(json.dumps(segment.get("source_timerange"))) if isinstance(segment.get("source_timerange"), dict) else None
        original_render_timerange = json.loads(json.dumps(segment.get("render_timerange"))) if isinstance(segment.get("render_timerange"), dict) else None
        original_render_index = segment.get("render_index")
        original_track_render_index = segment.get("track_render_index")
        segment["id"] = new_capcut_id()
        segment["material_id"] = new_material_id
        segment["visible"] = True
        if original_render_index is None:
            segment["render_index"] = 11200 + index
        if original_track_render_index is None:
            segment["track_render_index"] = 0
        segment["target_timerange"] = {"start": 0, "duration": total_us}
        if original_source_timerange is not None:
            source_duration_us = int(original_source_timerange.get("duration") or 0)
            if source_duration_us > 0:
                original_source_timerange["duration"] = min(source_duration_us, total_us)
            segment["source_timerange"] = original_source_timerange
            source_timerange_preserved = True
        if original_render_timerange is not None:
            # CapCut template overlay videos often use render duration 0 while
            # the visible range is controlled by target_timerange. Preserve that
            # instead of stretching the template segment like source footage.
            segment["render_timerange"] = original_render_timerange
            render_timerange_preserved = True
        segment["extra_material_refs"] = clone_material_dependencies(
            template_doc,
            generated,
            segment.get("extra_material_refs") or [],
            source_to_target_id_map,
        )
        if isinstance(segment.get("clip"), dict):
            clip_settings_preserved = True
        generated_material_index = build_material_index_by_id(generated)
        mask_refs_count += sum(
            1
            for ref_id in (segment.get("extra_material_refs") or [])
            if isinstance(ref_id, str)
            and (
                (generated_material_index.get(ref_id) or ("", {}))[0] == "common_mask"
                or (generated_material_index.get(ref_id) or ("", {}))[1].get("type") == "mask"
            )
        )
        if (
            segment.get("enable_video_mask")
            or segment.get("enable_adjust_mask")
            or isinstance(segment.get("mask"), dict)
            or isinstance(segment.get("video_mask"), dict)
            or segment_has_mask_reference(template_doc, entry["segment"])
            or segment_has_mask_reference(generated, segment)
        ):
            mask_preserved = True
        cloned_segments.append(segment)
        copied_paths.append(copied_path)

    if not cloned_segments:
        summary["reason"] = "template frame overlay media path not found or copy failed"
        return summary

    tracks = generated.setdefault("tracks", [])
    tracks[:] = [
        track for track in tracks
        if not (isinstance(track, dict) and track.get("type") == "video" and track.get("name") == "channel_frame_overlay")
    ]
    frame_track = {
        "id": new_capcut_id(),
        "type": "video",
        "segments": cloned_segments,
        "flag": 1,
        "attribute": 0,
        "name": "channel_frame_overlay",
        "is_default_name": False,
        "visible": True,
    }
    insert_index = 0
    for track_index, track in enumerate(tracks):
        if isinstance(track, dict) and track.get("type") == "video" and track.get("name") == "source_video":
            insert_index = track_index + 1
            break
    tracks.insert(insert_index, frame_track)

    summary.update(
        {
            "applied": True,
            "template_track_name": str((entries[0].get("track") or {}).get("name") or ""),
            "segments_count": len(cloned_segments),
            "template_material_ids": template_material_ids,
            "source_paths": source_paths,
            "draft_paths": copied_paths,
            "mask_preserved": mask_preserved,
            "clip_settings_preserved": clip_settings_preserved,
            "source_timerange_preserved": source_timerange_preserved,
            "render_timerange_preserved": render_timerange_preserved,
            "mask_refs_count": mask_refs_count,
            "reason": "template frame overlay cloned with segment settings",
        }
    )
    return summary


def is_template_passthrough_track(track):
    if not isinstance(track, dict):
        return False
    track_type = str(track.get("type") or "").strip().lower()
    if track_type not in {"video", "image", "sticker"}:
        return False
    track_name = str(track.get("name") or "").strip().lower()
    if track_name in {"source_video", "video", "main_video"}:
        return False
    if "source_video" in track_name or "source footage" in track_name:
        return False
    return True


def material_media_path(material):
    if not isinstance(material, dict):
        return ""
    for key in ["path", "local_path", "file_path"]:
        value = str(material.get(key) or "").strip()
        if value:
            return value
    return ""


def apply_template_overlay_passthrough(draft_content_path, template_doc, template_root, draft_path, total_duration_sec):
    summary = {
        "enabled": True,
        "applied": False,
        "track_count": 0,
        "segments_count": 0,
        "copied_paths": [],
        "source_paths": [],
        "missing_paths": [],
        "skipped_tracks": [],
        "track_names": [],
        "reason": "template overlay tracks not found",
    }
    if not draft_content_path or not os.path.exists(draft_content_path):
        summary["reason"] = "draft_content not found"
        return summary
    if not isinstance(template_doc, dict):
        summary["reason"] = "template document not loaded"
        return summary
    try:
        with open(draft_content_path, "r", encoding="utf-8-sig") as file:
            generated = json.load(file)
    except Exception as error:
        summary["reason"] = f"draft_content load failed: {error}"
        return summary

    template_index = build_material_index_by_id(template_doc)
    source_to_target_id_map = {}
    copied_by_source_path = {}
    overlay_dir = os.path.join(draft_path or os.path.dirname(draft_content_path), "overlay")
    total_us = max(1, microseconds(total_duration_sec))
    passthrough_tracks = []

    def clone_media_material(category, material, track_number, segment_number):
        old_material_id = material.get("id")
        if isinstance(old_material_id, str) and old_material_id in source_to_target_id_map:
            return source_to_target_id_map[old_material_id]

        cloned_material = json.loads(json.dumps(material))
        new_material_id = new_capcut_id()
        cloned_material["id"] = new_material_id
        raw_path = material_media_path(cloned_material)
        if raw_path:
            source_path = resolve_template_media_path(template_root, raw_path)
            if not source_path:
                summary["missing_paths"].append(raw_path)
                return ""
            os.makedirs(overlay_dir, exist_ok=True)
            copied_path = copied_by_source_path.get(source_path)
            if not copied_path:
                base_name = os.path.basename(source_path)
                copied_name = f"template_overlay_{track_number:02d}_{segment_number:02d}_{base_name}"
                copied_path = os.path.abspath(os.path.join(overlay_dir, copied_name))
                try:
                    shutil.copy2(source_path, copied_path)
                except Exception as error:
                    summary["missing_paths"].append(f"{source_path} (copy failed: {error})")
                    return ""
                copied_by_source_path[source_path] = copied_path
                summary["source_paths"].append(source_path)
                summary["copied_paths"].append(copied_path)
            for key in ["path", "local_path", "file_path"]:
                if key in cloned_material:
                    cloned_material[key] = copied_path
            if "name" in cloned_material:
                cloned_material["name"] = os.path.basename(copied_path)

        ensure_material_category(generated, category).append(cloned_material)
        if isinstance(old_material_id, str) and old_material_id:
            source_to_target_id_map[old_material_id] = new_material_id
        return new_material_id

    for track_index, template_track in enumerate(template_doc.get("tracks") or []):
        if not is_template_passthrough_track(template_track):
            continue
        cloned_segments = []
        for segment_index, template_segment in enumerate(template_track.get("segments") or []):
            if not isinstance(template_segment, dict):
                continue
            material_id = template_segment.get("material_id")
            material_entry = template_index.get(material_id)
            if material_entry is None:
                continue
            category, material = material_entry
            if category not in {"images", "stickers", "videos"}:
                continue
            new_material_id = clone_media_material(category, material, track_index + 1, segment_index + 1)
            if not new_material_id:
                continue
            cloned_segment = json.loads(json.dumps(template_segment))
            cloned_segment["id"] = new_capcut_id()
            cloned_segment["material_id"] = new_material_id
            cloned_segment["visible"] = True
            if not isinstance(cloned_segment.get("target_timerange"), dict):
                cloned_segment["target_timerange"] = {"start": 0, "duration": total_us}
            cloned_segment["extra_material_refs"] = clone_material_dependencies(
                template_doc,
                generated,
                cloned_segment.get("extra_material_refs") or [],
                source_to_target_id_map,
            )
            cloned_segments.append(cloned_segment)
        if not cloned_segments:
            summary["skipped_tracks"].append(str(template_track.get("name") or template_track.get("type") or f"track_{track_index}"))
            continue
        cloned_track = json.loads(json.dumps(template_track))
        cloned_track["id"] = new_capcut_id()
        source_track_name = str(template_track.get("name") or template_track.get("type") or f"track_{track_index}").strip()
        cloned_track["name"] = f"template_passthrough_{source_track_name}"[:96]
        cloned_track["is_default_name"] = False
        cloned_track["visible"] = True
        cloned_track["segments"] = cloned_segments
        passthrough_tracks.append(cloned_track)
        summary["track_names"].append(cloned_track["name"])

    if not passthrough_tracks:
        if summary["missing_paths"]:
            summary["reason"] = "template overlay tracks found but media paths were missing or failed to copy"
        return summary

    tracks = generated.setdefault("tracks", [])
    tracks[:] = [
        track for track in tracks
        if not (isinstance(track, dict) and str(track.get("name") or "").startswith("template_passthrough_"))
    ]
    insert_index = 0
    for index, track in enumerate(tracks):
        if isinstance(track, dict) and track.get("type") == "video" and track.get("name") == "source_video":
            insert_index = index + 1
            break
    for offset, passthrough_track in enumerate(passthrough_tracks):
        tracks.insert(insert_index + offset, passthrough_track)

    try:
        with open(draft_content_path, "w", encoding="utf-8") as file:
            json.dump(generated, file, ensure_ascii=False, indent=4)
    except Exception as error:
        summary["reason"] = f"draft_content save failed: {error}"
        return summary

    summary.update(
        {
            "applied": True,
            "track_count": len(passthrough_tracks),
            "segments_count": sum(len(track.get("segments") or []) for track in passthrough_tracks),
            "reason": "template overlay tracks cloned and media paths copied into draft overlay folder",
        }
    )
    return summary


def upsert_timerange(segment_obj, start_us, duration_us):
    trange = {"start": int(start_us), "duration": int(duration_us)}
    segment_obj["target_timerange"] = trange
    if isinstance(segment_obj.get("source_timerange"), dict):
        segment_obj["source_timerange"] = {"start": 0, "duration": int(duration_us)}
    if isinstance(segment_obj.get("render_timerange"), dict):
        segment_obj["render_timerange"] = {"start": int(start_us), "duration": int(duration_us)}


MIDFORM_FIXED_TITLE_Y = 0.7004421221864953
MIDFORM_FIXED_SUBTITLE_Y = 0.5416639871382638
MIDFORM_CAPTION_Y = -0.35
# Narration keeps the established caption line; each speaker gets a row beneath it, so two
# people talking at once can share a moment on separate rows instead of forcing the plan to
# split slots (user directive). Rows cycle if a scene carries more speakers than rows.
MIDFORM_SPEAKER_ROW_OFFSETS = (-0.10, -0.20, -0.30)


def midform_caption_row_y(caption_kind, speaker_row_index, base_y=MIDFORM_CAPTION_Y):
    """Narration stays on base_y; dialogue drops onto its speaker's row."""
    if str(caption_kind or "").strip() != "dialogue":
        return base_y
    if speaker_row_index is None or speaker_row_index < 0:
        return base_y
    offset = MIDFORM_SPEAKER_ROW_OFFSETS[speaker_row_index % len(MIDFORM_SPEAKER_ROW_OFFSETS)]
    return round(base_y + offset, 6)


def assign_midform_speaker_rows(entries):
    """Give each distinct speaker a stable row index, in order of first appearance."""
    rows = {}
    for entry in entries or []:
        if str((entry or {}).get("caption_kind") or "").strip() != "dialogue":
            continue
        alias = str((entry or {}).get("speaker_alias") or (entry or {}).get("speaker") or "").strip()
        if not alias or alias in rows:
            continue
        rows[alias] = len(rows)
    return rows
MIDFORM_CROP_FINAL_SCALE_CAP = 2.4

# Scale is derived from the source aspect ratio, never written as an absolute. At scale 1.0
# a landscape source fits the portrait canvas by width, so its height is canvas_width /
# source_ar; scaling by source_ar therefore makes the visible window exactly square. Shot
# type then multiplies that base, which keeps its meaning if the source AR changes.
MIDFORM_SQUARE_WINDOW_MULTIPLIER = 1.0
MIDFORM_SHOT_TYPE_SCALE_MULTIPLIERS = {
    "narration": 1.0,
    "dialogue": 1.0,
}


def midform_scale_base(source_aspect):
    """Scale that makes the visible video window square on a portrait canvas."""
    ratio = safe_float(source_aspect, 0.0)
    if ratio <= 0:
        return 1.0
    return max(1.0, ratio * MIDFORM_SQUARE_WINDOW_MULTIPLIER)


def load_portrait_crop_config():
    defaults = {
        "source_scale_multi": 0.0,
        "source_scale_single": 0.0,
        "scale_cap": MIDFORM_CROP_FINAL_SCALE_CAP,
        "use_face_anchor": True,
    }
    if not os.path.exists(PORTRAIT_CROP_CONFIG_PATH):
        return defaults
    try:
        with open(PORTRAIT_CROP_CONFIG_PATH, "r", encoding="utf-8-sig") as file:
            data = json.load(file)
    except Exception:
        return defaults
    if not isinstance(data, dict):
        return defaults
    source_scale_multi = safe_float(data.get("source_scale_multi"), defaults["source_scale_multi"])
    source_scale_single = safe_float(data.get("source_scale_single"), defaults["source_scale_single"])
    scale_cap = safe_float(data.get("scale_cap"), defaults["scale_cap"])
    return {
        # 0 is the "no override" sentinel and must survive: clamping it to 1.0 would pin the
        # video to fit-by-width instead of leaving the scale derived from the source AR.
        "source_scale_multi": source_scale_multi if source_scale_multi <= 0 else max(1.0, source_scale_multi),
        "source_scale_single": source_scale_single if source_scale_single <= 0 else max(1.0, source_scale_single),
        "scale_cap": max(1.0, scale_cap),
        "use_face_anchor": coerce_bool(data.get("use_face_anchor"), defaults["use_face_anchor"]),
    }
MIDFORM_SHOT_TYPE_ALIASES = {
    "wide": "wide_shot",
    "wide_shot": "wide_shot",
    "establishing": "wide_shot",
    "establishing_shot": "wide_shot",
    "action": "action_shot",
    "action_shot": "action_shot",
    "montage": "montage",
    "medium": "medium_shot",
    "medium_shot": "medium_shot",
    "close": "close_up",
    "closeup": "close_up",
    "close_up": "close_up",
    "insert": "text_overlay",
    "text": "text_overlay",
    "text_overlay": "text_overlay",
    "title_card": "text_overlay",
    "unknown": "unknown",
}


def normalize_midform_shot_type(value):
    raw = str(value or "").strip().lower().replace("-", "_").replace(" ", "_")
    return MIDFORM_SHOT_TYPE_ALIASES.get(raw, "unknown")


def scene_time_value_to_sec(value):
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value or "").strip()
    if text.endswith("s"):
        try:
            return float(text[:-1])
        except ValueError:
            return None
    parsed = parse_timecode_to_sec(text)
    if parsed is not None:
        return parsed
    try:
        return float(text)
    except ValueError:
        return None


def build_midform_shot_scene_ranges(gemini_analysis):
    scenes = gemini_analysis.get("scenes") if isinstance(gemini_analysis, dict) else []
    ranges = []
    for index, scene in enumerate(scenes if isinstance(scenes, list) else []):
        if not isinstance(scene, dict):
            continue
        start_sec = scene_time_value_to_sec(scene.get("start_sec") or scene.get("start") or scene.get("start_time"))
        end_sec = scene_time_value_to_sec(scene.get("end_sec") or scene.get("end") or scene.get("end_time"))
        if start_sec is None or end_sec is None or end_sec <= start_sec:
            continue
        raw_shot_type = str(scene.get("shot_type") or scene.get("shotType") or "unknown").strip() or "unknown"
        normalized_shot_type = normalize_midform_shot_type(raw_shot_type)
        ranges.append(
            {
                "scene_id": str(scene.get("scene_id") or scene.get("id") or f"scene_{index + 1:03d}"),
                "start_sec": float(start_sec),
                "end_sec": float(end_sec),
                "shot_type": raw_shot_type,
                "normalized_shot_type": normalized_shot_type,
            }
        )
    return ranges


def match_midform_shot_scene(scene_ranges, source_start_value, source_end_value):
    source_start = scene_time_value_to_sec(source_start_value)
    source_end = scene_time_value_to_sec(source_end_value)
    if source_start is None or source_end is None or source_end <= source_start:
        return None
    best_match = None
    best_overlap = 0.0
    for scene in scene_ranges or []:
        overlap = min(source_end, scene["end_sec"]) - max(source_start, scene["start_sec"])
        if overlap > best_overlap:
            best_match = scene
            best_overlap = overlap
    if best_match is None or best_overlap <= 0:
        return None
    return dict(best_match, overlap_sec=round(best_overlap, 6))


def set_segment_clip_transform_y(segment_obj, y_value):
    if not isinstance(segment_obj, dict):
        return
    clip = segment_obj.setdefault("clip", {})
    if not isinstance(clip, dict):
        clip = {}
        segment_obj["clip"] = clip
    transform = clip.setdefault("transform", {})
    if not isinstance(transform, dict):
        transform = {}
        clip["transform"] = transform
    transform["y"] = float(y_value)


def derive_overlay_texts(claude_script, srt_entries):
    story = (claude_script or {}).get("story") if isinstance(claude_script, dict) else {}
    metadata = (claude_script or {}).get("metadata") if isinstance(claude_script, dict) else {}
    source_ref = (claude_script or {}).get("source_ref") if isinstance(claude_script, dict) else {}
    source_obj = (claude_script or {}).get("source") if isinstance(claude_script, dict) else {}
    title_block = (claude_script or {}).get("title_block") if isinstance(claude_script, dict) else {}
    movie_identity = (claude_script or {}).get("movie_identity") if isinstance(claude_script, dict) else {}
    movie_research = (claude_script or {}).get("movieResearch") or (claude_script or {}).get("movie_research") if isinstance(claude_script, dict) else {}
    raw_research_identity = movie_research.get("movie_identity") if isinstance(movie_research, dict) else None
    raw_research_knowledge = movie_research.get("movie_knowledge") if isinstance(movie_research, dict) else None
    research_identity = raw_research_identity if isinstance(raw_research_identity, dict) else {}
    research_knowledge = raw_research_knowledge if isinstance(raw_research_knowledge, dict) else {}

    title_text = ""
    subtitle_text = ""
    if isinstance(title_block, dict):
        overlay_title = title_block.get("overlay_title") if isinstance(title_block.get("overlay_title"), dict) else {}
        title_text = str(
            overlay_title.get("top")
            or title_block.get("overlay_top")
            or title_block.get("top_title")
            or ""
        ).strip()
        subtitle_text = str(
            overlay_title.get("bottom")
            or title_block.get("overlay_bottom")
            or title_block.get("top_subtitle")
            or ""
        ).strip()
    story_title = story.get("title") if isinstance(story, dict) else ""
    if isinstance(story_title, str) and story_title.strip():
        title_text = title_text or story_title.strip()
    if not title_text:
        candidates = metadata.get("title_candidates") if isinstance(metadata, dict) else None
        if isinstance(candidates, list) and candidates:
            first = candidates[0]
            first_title = first.get("title") if isinstance(first, dict) else ""
            if isinstance(first_title, str):
                title_text = first_title.strip()
            elif isinstance(first, str):
                title_text = first.strip()
    if title_text:
        title_text = title_text[:12].strip()
    if subtitle_text:
        subtitle_text = subtitle_text[:12].strip()

    pretitle_text = ""
    core_argument = story.get("core_argument") if isinstance(story, dict) else ""
    if isinstance(core_argument, str) and core_argument.strip():
        pretitle_text = core_argument.strip()[:40]
    if not pretitle_text and srt_entries:
        first_text = str(srt_entries[0].get("text") or "").strip()
        if first_text:
            pretitle_text = first_text[:40]
    if not pretitle_text:
        pretitle_text = '공정 요약'

    movie_title_text = ""
    for candidate in [
        movie_identity.get("display_title") if isinstance(movie_identity, dict) else "",
        movie_identity.get("title_kr") if isinstance(movie_identity, dict) else "",
        research_identity.get("title_kr") if isinstance(research_identity, dict) else "",
        research_knowledge.get("title_kr") if isinstance(research_knowledge, dict) else "",
        movie_identity.get("title_en") if isinstance(movie_identity, dict) else "",
        research_identity.get("title_en") if isinstance(research_identity, dict) else "",
        research_knowledge.get("title_en") if isinstance(research_knowledge, dict) else "",
        metadata.get("movie_title") if isinstance(metadata, dict) else "",
        metadata.get("source_title") if isinstance(metadata, dict) else "",
        source_ref.get("title") if isinstance(source_ref, dict) else "",
        source_ref.get("filename") if isinstance(source_ref, dict) else "",
        source_obj.get("filename") if isinstance(source_obj, dict) else "",
    ]:
        if isinstance(candidate, str) and candidate.strip():
            movie_title_text = candidate.strip()
            break
    if movie_title_text:
        if os.path.basename(movie_title_text) == movie_title_text:
            movie_title_text = os.path.splitext(os.path.basename(movie_title_text))[0]
    if not movie_title_text:
        movie_title_text = ""

    return {
        "pretitle": pretitle_text,
        "title": title_text,
        "subtitle": subtitle_text,
        "movie_title": movie_title_text,
    }


def apply_template_clone_mode(
    generated_draft_content_path,
    template_doc,
    srt_entries,
    claude_script,
):
    with open(generated_draft_content_path, "r", encoding="utf-8-sig") as file:
        generated = json.load(file)

    template_markers = find_template_text_marker_assets(template_doc)
    expected_markers = ["TEMPLATE_PRETITLE", "TEMPLATE_TITLE", "TEMPLATE_SUBTITLE", "TEMPLATE_MOVIE_TITLE"]
    missing_markers = [marker for marker in expected_markers if marker not in template_markers]

    tracks = generated.setdefault("tracks", [])

    def get_or_create_text_track(name):
        for track in tracks:
            if isinstance(track, dict) and track.get("type") == "text" and track.get("name") == name:
                if not isinstance(track.get("segments"), list):
                    track["segments"] = []
                track["visible"] = True
                return track
        new_track = {
            "id": new_capcut_id(),
            "type": "text",
            "segments": [],
            "flag": 1,
            "attribute": 0,
            "name": name,
            "is_default_name": False,
            "visible": True,
        }
        tracks.append(new_track)
        return new_track

    subtitle_track = get_or_create_text_track("subtitle")
    role_overlay_tracks = {}

    source_to_target_id_map = {}
    template_sources = {"subtitle": "", "title": "", "pretitle": "", "movie_title": ""}
    fixed_overlay_texts = {
        "pretitle": {"start_sec": 0.0, "end_sec": 0.0, "text": "", "generated": False},
        "title": {"start_sec": 0.0, "end_sec": 0.0, "text": "", "generated": False},
        "subtitle": {"start_sec": 0.0, "end_sec": 0.0, "text": "", "generated": False},
        "movie_title": {"start_sec": 0.0, "end_sec": 0.0, "text": "", "generated": False},
    }

    def pick_base_marker(primary_marker, fallback_markers):
        if primary_marker in template_markers:
            return primary_marker, template_markers[primary_marker], False
        for marker_name in fallback_markers:
            if marker_name in template_markers:
                return marker_name, template_markers[marker_name], True
        return "", None, True

    def clone_segment_from_entry(marker_entry, text_value, start_us, duration_us, fixed_y=None):
        if marker_entry is None:
            return None
        original_segment = marker_entry["segment"]
        original_material = marker_entry["material"]

        cloned_material = json.loads(json.dumps(original_material))
        old_material_id = cloned_material.get("id")
        new_material_id = new_capcut_id()
        cloned_material["id"] = new_material_id
        set_material_text_value(cloned_material, text_value)
        ensure_material_category(generated, "texts").append(cloned_material)
        if isinstance(old_material_id, str) and old_material_id:
            source_to_target_id_map[old_material_id] = new_material_id

        cloned_segment = json.loads(json.dumps(original_segment))
        cloned_segment["id"] = new_capcut_id()
        cloned_segment["material_id"] = new_material_id
        upsert_timerange(cloned_segment, start_us, duration_us)
        if fixed_y is not None:
            set_segment_clip_transform_y(cloned_segment, fixed_y)
        cloned_segment["extra_material_refs"] = clone_material_dependencies(
            template_doc,
            generated,
            cloned_segment.get("extra_material_refs") or [],
            source_to_target_id_map,
        )
        return cloned_segment

    def get_or_create_role_template_track(role_name, marker_entry):
        if role_name in role_overlay_tracks:
            return role_overlay_tracks[role_name]
        role_track_names = {
            "pretitle": "template_pretitle",
            "title": "template_title",
            "subtitle": "template_title_subline",
            "movie_title": "template_movie_title",
        }
        if marker_entry is None or not isinstance(marker_entry.get("track"), dict):
            role_overlay_tracks[role_name] = get_or_create_text_track(role_track_names.get(role_name, f"overlay_{role_name}"))
            return role_overlay_tracks[role_name]
        source_track = marker_entry["track"]
        cloned_track = json.loads(json.dumps(source_track))
        cloned_track["id"] = new_capcut_id()
        cloned_track["segments"] = []
        cloned_track["visible"] = True
        cloned_track["name"] = role_track_names.get(role_name, f"template_{role_name}")
        cloned_track["is_default_name"] = False
        tracks.append(cloned_track)
        role_overlay_tracks[role_name] = cloned_track
        return cloned_track

    def find_fallback_marker_entry_from_generated():
        generated_material_index = build_material_index_by_id(generated)
        for track in generated.get("tracks") or []:
            if not isinstance(track, dict) or track.get("type") != "text":
                continue
            for segment in track.get("segments") or []:
                if not isinstance(segment, dict):
                    continue
                material_id = segment.get("material_id")
                if not isinstance(material_id, str) or not material_id:
                    continue
                material_entry = generated_material_index.get(material_id)
                if material_entry is None:
                    continue
                _, material = material_entry
                if isinstance(material, dict):
                    return {"segment": segment, "material": material}
        return None

    total_tts_duration_us = 0
    for srt in srt_entries:
        total_tts_duration_us = max(total_tts_duration_us, microseconds(srt.get("end_sec", 0)))
    if total_tts_duration_us <= 0:
        total_tts_duration_us = microseconds(1.0)
    total_tts_duration_sec = round(total_tts_duration_us / 1_000_000, 6)

    overlay_texts = derive_overlay_texts(claude_script, srt_entries)

    # Timed captions remain on the generated subtitle track. TEMPLATE_SUBTITLE is the
    # timed-caption style source; TEMPLATE_TITLE_SUBLINE is the fixed title second line.
    template_sources["subtitle"] = "generated_pycapcut_subtitle_track"

    # fixed overlays: full duration and overlapping
    fixed_overlay_specs = [
        ("pretitle", "TEMPLATE_PRETITLE", "", None),
        ("title", "TEMPLATE_TITLE", overlay_texts.get("title") or "TITLE", MIDFORM_FIXED_TITLE_Y),
        ("subtitle", "TEMPLATE_TITLE_SUBLINE", overlay_texts.get("subtitle") or "", MIDFORM_FIXED_SUBTITLE_Y),
        ("movie_title", "TEMPLATE_MOVIE_TITLE", overlay_texts.get("movie_title") or "", None),
    ]
    fallback_chain = {
        "TEMPLATE_PRETITLE": ["TEMPLATE_TITLE", "TEMPLATE_TITLE_SUBLINE", "TEMPLATE_SUBTITLE", "TEMPLATE_MOVIE_TITLE"],
        "TEMPLATE_TITLE": [],
        "TEMPLATE_TITLE_SUBLINE": [],
        "TEMPLATE_MOVIE_TITLE": ["TEMPLATE_TITLE", "TEMPLATE_TITLE_SUBLINE", "TEMPLATE_SUBTITLE", "TEMPLATE_PRETITLE"],
    }

    for role_name, marker_name, text_value, fixed_y in fixed_overlay_specs:
        base_marker_name, base_entry, used_fallback = pick_base_marker(marker_name, fallback_chain[marker_name])
        if base_entry is None:
            generated_fallback_entry = find_fallback_marker_entry_from_generated()
            if generated_fallback_entry is not None:
                role_track = get_or_create_role_template_track(role_name, generated_fallback_entry)
                overlay_segment = clone_segment_from_entry(generated_fallback_entry, text_value, 0, total_tts_duration_us, fixed_y=fixed_y)
                if overlay_segment is not None:
                    role_track["segments"] = [overlay_segment]
                    template_sources[role_name] = "generated_fallback:text_track_segment_clone"
                    fixed_overlay_texts[role_name]["text"] = text_value
                    fixed_overlay_texts[role_name]["start_sec"] = 0.0
                    fixed_overlay_texts[role_name]["end_sec"] = total_tts_duration_sec
                    fixed_overlay_texts[role_name]["generated"] = True
                    continue
            fixed_overlay_texts[role_name]["text"] = text_value
            fixed_overlay_texts[role_name]["start_sec"] = 0.0
            fixed_overlay_texts[role_name]["end_sec"] = total_tts_duration_sec
            fixed_overlay_texts[role_name]["generated"] = False
            continue
        source_label = f"material={base_entry['material'].get('id')} segment={base_entry['segment'].get('id')}"
        if used_fallback:
            source_label = f"{source_label} (fallback:{base_marker_name})"
        template_sources[role_name] = source_label

        overlay_segment = clone_segment_from_entry(base_entry, text_value, 0, total_tts_duration_us, fixed_y=fixed_y)
        if overlay_segment is not None:
            role_track = get_or_create_role_template_track(role_name, base_entry)
            role_track["segments"] = [overlay_segment]
            fixed_overlay_texts[role_name]["text"] = text_value
            fixed_overlay_texts[role_name]["start_sec"] = 0.0
            fixed_overlay_texts[role_name]["end_sec"] = total_tts_duration_sec
            fixed_overlay_texts[role_name]["generated"] = True

    with open(generated_draft_content_path, "w", encoding="utf-8") as file:
        json.dump(generated, file, ensure_ascii=False, indent=4)

    return {
        "template_clone_mode": True,
        "template_markers_found": sorted(list(template_markers.keys())),
        "missing_template_markers": missing_markers,
        "subtitle_template_source": template_sources["subtitle"],
        "title_template_source": template_sources["title"],
        "pretitle_template_source": template_sources["pretitle"],
        "movie_title_template_source": template_sources["movie_title"],
        "used_fallback_subtitle": "TEMPLATE_SUBTITLE" not in template_markers,
        "fixed_overlay_texts": fixed_overlay_texts,
        "subtitle_segments_count": len(subtitle_track.get("segments") or []),
        "total_tts_duration_sec": total_tts_duration_sec,
        "movie_title_generated": bool(fixed_overlay_texts["movie_title"]["generated"]),
        "movie_title_fallback_text_used": bool(not overlay_texts.get("movie_title")),
    }


def get_video_duration_sec_ffprobe(video_path):
    try:
        result = subprocess.run(
            [FFPROBE_BIN, "-v", "quiet", "-print_format", "json", "-show_format", video_path],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=True,
        )
        data = json.loads(result.stdout or "{}")
        duration = float(((data.get("format") or {}).get("duration")) or 0)
        return duration if duration > 0 else None
    except (subprocess.SubprocessError, json.JSONDecodeError, ValueError, TypeError):
        return None


def get_video_dimensions_ffprobe(video_path):
    try:
        result = subprocess.run(
            [FFPROBE_BIN, "-v", "quiet", "-print_format", "json", "-show_streams", "-select_streams", "v:0", video_path],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=True,
        )
        data = json.loads(result.stdout or "{}")
        stream = (data.get("streams") or [{}])[0]
        width = int(stream.get("width") or 0)
        height = int(stream.get("height") or 0)
        return width, height
    except (subprocess.SubprocessError, json.JSONDecodeError, ValueError, TypeError, IndexError):
        return 0, 0


def clamp_float(value, min_value, max_value):
    return max(min_value, min(max_value, float(value)))


def load_opencv_face_cascades():
    if cv2 is None:
        return []
    cascades = []
    try:
        base = getattr(cv2, "data", None)
        cascade_root = getattr(base, "haarcascades", "") if base is not None else ""
        for name in ["haarcascade_frontalface_default.xml", "haarcascade_profileface.xml"]:
            path_value = os.path.join(cascade_root, name) if cascade_root else name
            classifier = cv2.CascadeClassifier(path_value)
            if not classifier.empty():
                cascades.append((name, classifier))
    except Exception:
        return []
    return cascades


def sample_video_frame(video_path, time_sec):
    if cv2 is None or not video_path or not os.path.exists(video_path):
        return None
    # ffmpeg input-seeking (-ss before -i) jumps to the nearest keyframe and decodes one
    # frame. cv2's CAP_PROP_POS_MSEC seek software-decodes the whole GOP up to the target,
    # which takes minutes per sample on AV1 sources and stalls the draft build.
    try:
        import numpy as np

        result = subprocess.run(
            [
                FFMPEG_BIN,
                "-ss",
                f"{max(0.0, float(time_sec or 0.0)):.3f}",
                "-i",
                video_path,
                "-frames:v",
                "1",
                "-f",
                "image2pipe",
                "-vcodec",
                "png",
                "pipe:1",
            ],
            capture_output=True,
            timeout=30,
        )
        if result.returncode == 0 and result.stdout:
            frame = cv2.imdecode(np.frombuffer(result.stdout, dtype=np.uint8), cv2.IMREAD_COLOR)
            if frame is not None:
                return frame
    except Exception:
        pass
    capture = None
    try:
        capture = cv2.VideoCapture(video_path)
        if not capture.isOpened():
            return None
        capture.set(cv2.CAP_PROP_POS_MSEC, max(0.0, float(time_sec or 0.0)) * 1000)
        ok, frame = capture.read()
        return frame if ok else None
    except Exception:
        return None
    finally:
        if capture is not None:
            capture.release()


MIDFORM_FACE_SAMPLE_POSITIONS = (0.2, 0.5, 0.8)
# Cuts this close together in the source are almost always the same scene, so an undetected
# cut can borrow the previous framing instead of snapping back to centre.
MIDFORM_FACE_ANCHOR_INHERIT_GAP_SEC = 2.0


def detect_face_anchor_for_cut(video_path, start_sec, end_sec, cascades):
    """Anchor a cut on the median of three sampled frames.

    A single mid-cut sample decides the framing for the whole shot, so one missed or
    mistaken detection throws the entire cut off. Sampling at 20/50/80% survives a miss on
    any one frame, and taking the median rather than the mean keeps a stray detection from
    dragging the result. This is not tracking — the anchor is still fixed per cut.
    """
    span = max(0.0, safe_float(end_sec, 0.0) - safe_float(start_sec, 0.0))
    if span <= 0:
        return detect_primary_face_anchor(video_path, start_sec, cascades)

    samples, attempts = [], []
    for position in MIDFORM_FACE_SAMPLE_POSITIONS:
        moment = safe_float(start_sec, 0.0) + span * position
        probe = detect_primary_face_anchor(video_path, moment, cascades)
        attempts.append({
            "position": position,
            "sample_time_sec": probe.get("sample_time_sec"),
            "detected": bool(probe.get("detected")),
            "anchor_x": probe.get("anchor_x"),
        })
        if probe.get("detected"):
            samples.append((float(probe.get("anchor_x") or 0.5), probe))

    if not samples:
        return {
            "detected": False,
            "anchor_x": 0.5,
            "anchor_y": 0.42,
            "sample_time_sec": round(safe_float(start_sec, 0.0) + span * 0.5, 3),
            "faces_count": 0,
            "source": "opencv_haar_face_median",
            "reason": "no face detected in any sampled frame",
            "samples": attempts,
        }

    samples.sort(key=lambda item: item[0])
    median_x, median_probe = samples[len(samples) // 2]
    result = dict(median_probe)
    result["anchor_x"] = median_x
    result["source"] = "opencv_haar_face_median"
    result["samples"] = attempts
    result["detected_samples"] = len(samples)
    return result


def detect_primary_face_anchor(video_path, time_sec, cascades):
    result = {
        "detected": False,
        "anchor_x": 0.5,
        "anchor_y": 0.42,
        "sample_time_sec": round(max(0.0, safe_float(time_sec, 0.0)), 3),
        "faces_count": 0,
        "source": "opencv_haar_face",
        "reason": "not attempted",
    }
    if cv2 is None:
        result["reason"] = "opencv unavailable"
        return result
    if not cascades:
        result["reason"] = "opencv haar cascades unavailable"
        return result
    frame = sample_video_frame(video_path, time_sec)
    if frame is None:
        result["reason"] = "frame sample failed"
        return result
    try:
        height, width = frame.shape[:2]
        if width <= 0 or height <= 0:
            result["reason"] = "invalid sampled frame"
            return result
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        gray = cv2.equalizeHist(gray)
        candidates = []
        for cascade_name, classifier in cascades:
            detections = classifier.detectMultiScale(gray, scaleFactor=1.08, minNeighbors=4, minSize=(36, 36))
            for x, y, w, h in detections:
                candidates.append((int(x), int(y), int(w), int(h), cascade_name, False))
            if "profile" in cascade_name:
                flipped = cv2.flip(gray, 1)
                flipped_detections = classifier.detectMultiScale(flipped, scaleFactor=1.08, minNeighbors=4, minSize=(36, 36))
                for x, y, w, h in flipped_detections:
                    candidates.append((int(width - x - w), int(y), int(w), int(h), cascade_name, True))
        result["faces_count"] = len(candidates)
        if not candidates:
            result["reason"] = "no face detected"
            return result
        center_x = width / 2.0
        center_y = height * 0.42

        def candidate_score(item):
            x, y, w, h, _name, _flipped = item
            area = w * h
            face_x = x + w / 2.0
            face_y = y + h / 2.0
            distance = ((face_x - center_x) / max(1.0, width)) ** 2 + ((face_y - center_y) / max(1.0, height)) ** 2
            return area - distance * width * height * 0.15

        best = max(candidates, key=candidate_score)
        x, y, w, h, cascade_name, flipped = best
        face_center_x = (x + w / 2.0) / width
        # Keep a little chest/headroom below the face center so the speaker reads as a person,
        # not only a cropped face. Clamp prevents wild pans on edge detections.
        face_center_y = (y + h * 0.72) / height
        result.update(
            {
                "detected": True,
                "anchor_x": round(clamp_float(face_center_x, 0.18, 0.82), 6),
                "anchor_y": round(clamp_float(face_center_y, 0.22, 0.72), 6),
                "bbox": {"x": x, "y": y, "w": w, "h": h},
                "cascade": cascade_name,
                "flipped_profile": bool(flipped),
                "reason": "face detected",
            }
        )
        return result
    except Exception as error:
        result["reason"] = f"face detection failed: {error}"
        return result


def is_black_transition_scene(scene):
    text = " ".join(
        str(scene.get(key) or "")
        for key in ["visible_action", "translated_caption_ko", "vertical_crop_note"]
    ).strip().lower()
    return any(token in text for token in ["검은색", "검은 화면", "black"])


def build_final_slot_tail_plan(slot_map_input, gemini_analysis, source_duration_us, tail_allowance_sec):
    tail_allowance_sec = max(0.0, safe_float(tail_allowance_sec, MIDFORM_FINAL_SLOT_TAIL_ALLOWANCE_SEC))
    summary = {
        "enabled": False,
        "segment_id": "",
        "tail_allowance_sec": round(tail_allowance_sec, 3),
        "visual_end_sec": 0.0,
        "slot_start_sec": 0.0,
        "visible_gap_sec": 0.0,
        "allowed_gap_sec": 0.0,
        "tail_overrun_sec": 0.0,
        "applied": False,
        "freeze_applied": False,
        "freeze_duration_sec": 0.0,
        "freeze_within_allowance": True,
        "reason": "not_applicable",
    }
    slots = slot_map_input.get("slots") if isinstance(slot_map_input, dict) else []
    if not isinstance(slots, list) or not slots:
        summary["reason"] = "slot_map missing slots"
        return summary
    narration_slots = [slot for slot in slots if isinstance(slot, dict) and str(slot.get("type") or "") == "narration"]
    if not narration_slots:
        summary["reason"] = "no narration slots"
        return summary
    final_slot = narration_slots[-1]
    source_range = final_slot.get("source_range") if isinstance(final_slot.get("source_range"), list) else []
    if len(source_range) != 2:
        summary["reason"] = "final narration slot missing source_range"
        return summary
    slot_start_sec = safe_float(source_range[0], 0.0)
    nominal_end_sec = safe_float(source_range[1], slot_start_sec)
    scene_ids = [str(item or "").strip() for item in (final_slot.get("scene_ids") or []) if str(item or "").strip()]
    scene_map = {
        str(scene.get("scene_id") or "").strip(): scene
        for scene in (gemini_analysis.get("scenes") or [])
        if isinstance(scene, dict) and str(scene.get("scene_id") or "").strip()
    } if isinstance(gemini_analysis, dict) else {}
    visible_ends = [
        safe_float((scene_map.get(scene_id) or {}).get("end_sec"), 0.0)
        for scene_id in scene_ids
        if scene_map.get(scene_id) and not is_black_transition_scene(scene_map.get(scene_id))
    ]
    source_duration_sec = (source_duration_us / 1_000_000) if source_duration_us > 0 else 0.0
    visual_end_sec = max(visible_ends) if visible_ends else min(nominal_end_sec, source_duration_sec or nominal_end_sec)
    visible_gap_sec = max(0.0, visual_end_sec - slot_start_sec)
    summary.update(
        {
            "enabled": True,
            "segment_id": str(final_slot.get("slot_id") or "").strip(),
            "visual_end_sec": round(visual_end_sec, 6),
            "slot_start_sec": round(slot_start_sec, 6),
            "visible_gap_sec": round(visible_gap_sec, 6),
            "allowed_gap_sec": round(visible_gap_sec + tail_allowance_sec, 6),
            "reason": "final narration slot capped to last non-black scene end",
        }
    )
    return summary


def apply_midform_portrait_crops_to_draft(draft_content_path, video_cut_placements, segment_type_map, canvas_width, canvas_height, source_video_path="", gemini_analysis=None):
    crop_config = load_portrait_crop_config()
    # 0 means "no override": scale stays derived from the source AR.
    source_scale_multi = safe_float(crop_config.get("source_scale_multi"), 0.0)
    source_scale_single = safe_float(crop_config.get("source_scale_single"), 0.0)
    scale_cap = safe_float(crop_config.get("scale_cap"), MIDFORM_CROP_FINAL_SCALE_CAP)
    use_face_anchor = coerce_bool(crop_config.get("use_face_anchor"), True)
    scene_ranges = build_midform_shot_scene_ranges(gemini_analysis if isinstance(gemini_analysis, dict) else {})
    face_cascades = load_opencv_face_cascades() if use_face_anchor else []
    summary = {
        "enabled": True,
        "method": "portrait_configurable_scale_uniform_vertical_face_anchor",
        "config": {
            "path": PORTRAIT_CROP_CONFIG_PATH,
            "source_scale_multi": source_scale_multi,
            "source_scale_single": source_scale_single,
            "scale_cap": scale_cap,
            "use_face_anchor": use_face_anchor,
        },
        "face_detection": {
            "attempted": bool(use_face_anchor and cv2 is not None and source_video_path),
            "available": bool(cv2 is not None and face_cascades),
            "detected_segments": 0,
            "reason": "opencv face anchor enabled" if cv2 is not None and face_cascades else ("face anchor disabled by config" if not use_face_anchor else ("opencv unavailable" if cv2 is None else "opencv haar cascades unavailable")),
        },
        "source_dimensions": {"width": 0, "height": 0},
        "canvas_dimensions": {"width": int(canvas_width or 0), "height": int(canvas_height or 0)},
        "shot_scene_count": len(scene_ranges),
        "shot_type_scale_multipliers": MIDFORM_SHOT_TYPE_SCALE_MULTIPLIERS,
        "person_scale_targets": {
            "multi_person": source_scale_multi,
            "single_person": source_scale_single,
        },
        "records": [],
        "applied": False,
        "reason": "not applied",
    }
    if not draft_content_path or not os.path.exists(draft_content_path):
        summary["reason"] = "draft_content not found"
        return summary
    source_w, source_h = get_video_dimensions_ffprobe(source_video_path) if source_video_path else (0, 0)
    summary["source_dimensions"] = {"width": source_w, "height": source_h}
    source_aspect = (source_w / source_h) if source_w > 0 and source_h > 0 else (16 / 9)
    canvas_aspect = (canvas_width / canvas_height) if canvas_width > 0 and canvas_height > 0 else (9 / 16)
    portrait_fill_scale = max(1.0, source_aspect / max(0.001, canvas_aspect))
    try:
        with open(draft_content_path, "r", encoding="utf-8-sig") as file:
            draft_content = json.load(file)
    except Exception as error:
        summary["reason"] = f"draft_content load failed: {error}"
        return summary

    source_track = None
    for track in draft_content.get("tracks") or []:
        if isinstance(track, dict) and track.get("type") == "video" and track.get("name") == "source_video":
            source_track = track
            break
    if source_track is None:
        summary["reason"] = "source_video track not found"
        return summary
    video_segments = [segment for segment in source_track.get("segments") or [] if isinstance(segment, dict)]
    placements = [placement for placement in video_cut_placements or [] if isinstance(placement, dict)]
    previous_face_anchor_x = None
    previous_face_source_end = None
    for index, segment in enumerate(video_segments):
        if index >= len(placements):
            break
        placement = placements[index]
        segment_id = str(placement.get("segment_id") or "")
        segment_type = segment_type_map.get(segment_id, "recap")
        is_dialogue = segment_type in {"dialogue_quote", "dialogue"}
        source_match_start = scene_time_value_to_sec(placement.get("source_start"))
        source_match_end = scene_time_value_to_sec(placement.get("source_end"))
        placement_source_duration = float(safe_float(placement.get("source_duration_sec"), 0.0) or 0.0)
        if source_match_start is not None and placement_source_duration > 0:
            source_match_start_for_duration = float(source_match_start)
            source_match_end = source_match_start_for_duration + placement_source_duration
        matched_scene = match_midform_shot_scene(scene_ranges, source_match_start, source_match_end)
        raw_shot_type = matched_scene.get("shot_type") or "unknown" if matched_scene else ""
        normalized_shot_type = matched_scene.get("normalized_shot_type") or "unknown" if matched_scene else ""
        # One base derived from the source AR, multiplied by shot type. The multipliers are
        # 1.0 today, so every cut shares the square window; raising one later tightens that
        # shot without breaking the geometry the frame bands depend on.
        base_scale = midform_scale_base(source_aspect)
        shot_multiplier = MIDFORM_SHOT_TYPE_SCALE_MULTIPLIERS["dialogue" if is_dialogue else "narration"]
        target_final_scale = base_scale * shot_multiplier
        scale_source = "source_aspect_ratio_base"
        uncapped_final_scale = target_final_scale
        capped_final_scale = min(scale_cap, target_final_scale)
        applied_scale = round(capped_final_scale, 6)
        anchor_x = 0.5
        face_anchor = {"detected": False, "reason": "not attempted"}
        anchor_y = 0.42
        anchor_source = "uniform_vertical_anchor"
        source_mid_sec = None
        if source_match_start is not None and source_match_end is not None and source_match_end > source_match_start:
            source_mid_sec = (source_match_start + source_match_end) / 2.0
        elif isinstance(segment.get("source_timerange"), dict):
            source_timerange = segment.get("source_timerange")
            source_start_us = safe_float(source_timerange.get("start"), 0.0)
            source_duration_us = safe_float(source_timerange.get("duration"), 0.0)
            source_mid_sec = (source_start_us + source_duration_us / 2.0) / 1_000_000
        if use_face_anchor and source_mid_sec is not None:
            cut_start = source_match_start if source_match_start is not None else source_mid_sec
            cut_end = source_match_end if source_match_end is not None else source_mid_sec
            face_anchor = detect_face_anchor_for_cut(source_video_path, cut_start, cut_end, face_cascades)
            if face_anchor.get("detected"):
                anchor_x = float(face_anchor.get("anchor_x") or anchor_x)
                faces_count = int(safe_float(face_anchor.get("faces_count"), 0.0) or 0)
                scale_override = source_scale_multi if faces_count > 1 else source_scale_single
                if scale_override > 0:
                    capped_final_scale = min(scale_cap, scale_override)
                    applied_scale = round(capped_final_scale, 6)
                anchor_source = "opencv_face_anchor"
                summary["face_detection"]["detected_segments"] += 1
                previous_face_anchor_x = anchor_x
                previous_face_source_end = cut_end
            else:
                # A cut with no detection would snap to centre and visibly jump. Recaps
                # usually take consecutive cuts from one scene, so inherit the last anchor
                # while the footage stays contiguous, and only re-centre on a scene change.
                contiguous = (
                    previous_face_anchor_x is not None
                    and previous_face_source_end is not None
                    and abs(safe_float(cut_start, 0.0) - safe_float(previous_face_source_end, 0.0)) <= MIDFORM_FACE_ANCHOR_INHERIT_GAP_SEC
                )
                if contiguous:
                    anchor_x = previous_face_anchor_x
                    anchor_source = "inherited_face_anchor"
                    summary["face_detection"]["inherited_segments"] = summary["face_detection"].get("inherited_segments", 0) + 1
                else:
                    anchor_source = "centre_fallback_scene_change"
                    summary["face_detection"]["recentred_segments"] = summary["face_detection"].get("recentred_segments", 0) + 1
                    previous_face_anchor_x = None
                previous_face_source_end = cut_end
        logical_zoom = capped_final_scale / max(0.001, portrait_fill_scale)
        transform_x = round((0.5 - anchor_x) * 0.35, 6)
        transform_y = round((0.5 - anchor_y) * 0.35, 6)
        clip = segment.setdefault("clip", {})
        clip.setdefault("flip", {"horizontal": False, "vertical": False})
        clip.setdefault("rotation", 0.0)
        clip["scale"] = {"x": applied_scale, "y": applied_scale}
        clip["transform"] = {"x": transform_x, "y": transform_y}
        segment["uniform_scale"] = {"on": True, "value": applied_scale}
        record = {
            "segment_id": segment_id,
            "segment_type": segment_type,
            "scene_id": placement.get("scene_id") or placement.get("clip_id") or "",
            "matched_scene_id": matched_scene.get("scene_id") if matched_scene else "",
            "matched_scene_range_sec": [matched_scene.get("start_sec"), matched_scene.get("end_sec")] if matched_scene else [],
            "matched_scene_overlap_sec": matched_scene.get("overlap_sec") if matched_scene else 0,
            "shot_type": raw_shot_type,
            "normalized_shot_type": normalized_shot_type,
            "source_range": [placement.get("source_start"), placement.get("source_end")],
            "source_match_range_sec": [round(source_match_start, 6), round(source_match_end, 6)] if source_match_start is not None and source_match_end is not None else [],
            "timeline_range": [placement.get("timeline_start_sec"), placement.get("timeline_end_sec")],
            "anchor": {"x": anchor_x, "y": anchor_y, "source": anchor_source},
            "logical_zoom": round(logical_zoom, 6),
            "portrait_fill_scale": round(portrait_fill_scale, 6),
            "requested_uncapped_final_scale": round(uncapped_final_scale, 6),
            "base_scale": round(base_scale, 6),
            "shot_multiplier": shot_multiplier,
            "scale_source": scale_source,
            "target_final_scale": round(target_final_scale, 6),
            "max_final_scale_cap": scale_cap,
            "final_effective_scale": applied_scale,
            "cap_applied": target_final_scale > scale_cap,
            "applied_capcut_scale": applied_scale,
            "transform": {"x": transform_x, "y": transform_y},
            "face_detection": face_anchor,
        }
        placement["crop"] = record
        summary["records"].append(record)
    try:
        with open(draft_content_path, "w", encoding="utf-8") as file:
            json.dump(draft_content, file, ensure_ascii=False, indent=4)
    except Exception as error:
        summary["reason"] = f"draft_content save failed: {error}"
        return summary
    summary["applied"] = bool(summary["records"])
    summary["reason"] = "portrait crop transforms applied" if summary["applied"] else "no video segments matched placements"
    return summary


CAPTION_TRACK_BASE_NAME = "subtitle"


def caption_track_name(index):
    """Overflow caption tracks, used when two captions genuinely share a moment."""
    return CAPTION_TRACK_BASE_NAME if index == 0 else f"{CAPTION_TRACK_BASE_NAME}_{index + 1}"


def is_caption_track(track):
    if not isinstance(track, dict) or track.get("type") != "text":
        return False
    name = str(track.get("name") or "")
    return name == CAPTION_TRACK_BASE_NAME or name.startswith(f"{CAPTION_TRACK_BASE_NAME}_")


def normalize_midform_caption_text_track(draft_content_path, caption_y=MIDFORM_CAPTION_Y):
    summary = {"applied": False, "track_found": False, "segments": 0, "caption_y": caption_y}
    if not draft_content_path or not os.path.exists(draft_content_path):
        summary["reason"] = "draft_content not found"
        return summary
    try:
        with open(draft_content_path, "r", encoding="utf-8-sig") as file:
            draft_content = json.load(file)
    except Exception as error:
        summary["reason"] = f"draft_content load failed: {error}"
        return summary
    tracks = draft_content.get("tracks") if isinstance(draft_content.get("tracks"), list) else []
    subtitle_tracks = [track for track in tracks if is_caption_track(track)]
    if not subtitle_tracks:
        summary["reason"] = "subtitle track not found"
        return summary
    segments = []
    for subtitle_track in subtitle_tracks:
        subtitle_track["visible"] = True
        segments.extend(segment for segment in subtitle_track.get("segments") or [] if isinstance(segment, dict))

    def coerce_int(value, fallback=0):
        try:
            return int(value)
        except (TypeError, ValueError):
            return fallback

    for index, segment in enumerate(segments):
        # Do not flatten speaker rows the rebuild path assigned: only place segments that have
        # no y of their own yet.
        existing_y = ((segment.get("clip") or {}).get("transform") or {}).get("y")
        if existing_y is None:
            set_segment_clip_transform_y(segment, caption_y)
        segment["render_index"] = max(15000 + index, coerce_int(segment.get("render_index"), 0))
        segment["track_render_index"] = max(0, coerce_int(segment.get("track_render_index"), 0))
    try:
        with open(draft_content_path, "w", encoding="utf-8") as file:
            json.dump(draft_content, file, ensure_ascii=False, indent=4)
    except Exception as error:
        summary["reason"] = f"draft_content save failed: {error}"
        return summary
    summary.update({"applied": bool(segments), "track_found": True, "segments": len(segments), "reason": "subtitle track y normalized"})
    return summary


def rebuild_midform_caption_track_from_template(draft_content_path, template_doc, srt_entries, caption_y=MIDFORM_CAPTION_Y):
    summary = {"applied": False, "track_found": False, "segments": 0, "caption_y": caption_y, "source_marker": "TEMPLATE_SUBTITLE", "colored_segments": 0, "removed_effect_refs": 0}
    if not draft_content_path or not os.path.exists(draft_content_path):
        summary["reason"] = "draft_content not found"
        return summary
    template_markers = find_template_text_marker_assets(template_doc if isinstance(template_doc, dict) else {}, ["TEMPLATE_SUBTITLE"])
    marker_entry = template_markers.get("TEMPLATE_SUBTITLE") if isinstance(template_markers, dict) else None
    if marker_entry is None:
        summary["reason"] = "TEMPLATE_SUBTITLE marker not found"
        return summary
    try:
        with open(draft_content_path, "r", encoding="utf-8-sig") as file:
            draft_content = json.load(file)
    except Exception as error:
        summary["reason"] = f"draft_content load failed: {error}"
        return summary

    tracks = draft_content.setdefault("tracks", [])
    # Captions that genuinely share a moment go on their own track rather than being shifted
    # off their line. Reuse any overflow tracks already present and clear them all.
    caption_tracks = [track for track in tracks if is_caption_track(track)]
    caption_tracks.sort(key=lambda track: str(track.get("name") or ""))
    for track in caption_tracks:
        track["visible"] = True
        track["segments"] = []

    def caption_track_for(start_us, track_ends):
        for position, end_us in enumerate(track_ends):
            if start_us >= end_us:
                return position
        return len(track_ends)

    def ensure_caption_track(position):
        while len(caption_tracks) <= position:
            caption_tracks.append({
                "id": new_capcut_id(),
                "type": "text",
                "segments": [],
                "flag": 1,
                "attribute": 0,
                "name": caption_track_name(len(caption_tracks)),
                "is_default_name": False,
                "visible": True,
            })
            tracks.append(caption_tracks[-1])
        return caption_tracks[position]

    ensure_caption_track(0)
    caption_track_ends = [0]
    subtitle_track = caption_tracks[0]

    source_to_target_id_map = {}
    source_material = marker_entry.get("material")
    source_segment = marker_entry.get("segment")
    if not isinstance(source_material, dict) or not isinstance(source_segment, dict):
        summary["reason"] = "invalid template marker entry"
        return summary

    speaker_rows = assign_midform_speaker_rows(srt_entries or [])
    for index, entry in enumerate(srt_entries or []):
        text_value = str(entry.get("text") or "").strip()
        start_us = microseconds(entry.get("start_sec", 0))
        end_us = microseconds(entry.get("end_sec", 0))
        duration_us = max(1, end_us - start_us)
        cloned_material = json.loads(json.dumps(source_material))
        old_material_id = cloned_material.get("id")
        new_material_id = new_capcut_id()
        cloned_material["id"] = new_material_id
        set_material_text_value(cloned_material, text_value)
        caption_color = str(entry.get("caption_color") or "").strip()
        color_applied = bool(caption_color and apply_text_material_fill_color(cloned_material, caption_color))
        if color_applied:
            summary["colored_segments"] += 1
        ensure_material_category(draft_content, "texts").append(cloned_material)
        if isinstance(old_material_id, str) and old_material_id:
            source_to_target_id_map[old_material_id] = new_material_id

        cloned_segment = json.loads(json.dumps(source_segment))
        cloned_segment["id"] = new_capcut_id()
        cloned_segment["material_id"] = new_material_id
        cloned_segment["visible"] = True
        cloned_segment["render_index"] = 15000 + index
        cloned_segment["track_render_index"] = 0
        upsert_timerange(cloned_segment, start_us, duration_us)
        entry_alias = str(entry.get("speaker_alias") or entry.get("speaker") or "").strip()
        entry_row_y = midform_caption_row_y(entry.get("caption_kind"), speaker_rows.get(entry_alias), caption_y)
        set_segment_clip_transform_y(cloned_segment, entry_row_y)
        cloned_segment["extra_material_refs"] = clone_material_dependencies(
            template_doc,
            draft_content,
            cloned_segment.get("extra_material_refs") or [],
            source_to_target_id_map,
        )
        if color_applied:
            summary["removed_effect_refs"] += preserve_glow_effect_layers_for_colored_caption(cloned_material, cloned_segment, draft_content)
        track_position = caption_track_for(start_us, caption_track_ends)
        target_track = ensure_caption_track(track_position)
        if track_position >= len(caption_track_ends):
            caption_track_ends.append(0)
        caption_track_ends[track_position] = start_us + duration_us
        cloned_segment["track_render_index"] = track_position
        target_track["segments"].append(cloned_segment)

    try:
        with open(draft_content_path, "w", encoding="utf-8") as file:
            json.dump(draft_content, file, ensure_ascii=False, indent=4)
    except Exception as error:
        summary["reason"] = f"draft_content save failed: {error}"
        return summary
    summary.update({"applied": bool(subtitle_track["segments"]), "track_found": True, "segments": len(subtitle_track["segments"]), "reason": "caption track rebuilt from template text segments"})
    return summary


def _iter_path_configs(config=None):
    if isinstance(config, dict):
        yield config
        nested = config.get("processConfig")
        if isinstance(nested, dict):
            yield nested


def select_source_video_path(config=None):
    repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    for path_config in _iter_path_configs(config):
        configured_source = str(
            path_config.get("source_video")
            or path_config.get("sourceVideoPath")
            or path_config.get("source_video_path")
            or ""
        ).strip()
        if configured_source:
            source_candidate = configured_source if os.path.isabs(configured_source) else os.path.join(repo_root, configured_source)
            if os.path.exists(source_candidate):
                return os.path.abspath(source_candidate)

    input_dir = os.path.join(repo_root, "input")
    source_clean = os.path.join(input_dir, "source_clean.mp4")
    source_raw = os.path.join(input_dir, "source.mp4")

    if os.path.exists(source_clean):
        return os.path.abspath(source_clean)
    if os.path.exists(source_raw):
        return os.path.abspath(source_raw)
    return ""


def select_output_base_path(config=None):
    repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    default_output_base = os.path.abspath(os.path.join(repo_root, "server", "output", "drafts"))
    for path_config in _iter_path_configs(config):
        configured_output_base = str(
            path_config.get("outputBasePath")
            or path_config.get("output_base_path")
            or path_config.get("output_root")
            or ""
        ).strip()
        if configured_output_base:
            candidate = configured_output_base if os.path.isabs(configured_output_base) else os.path.join(repo_root, configured_output_base)
            return os.path.abspath(candidate)
    return default_output_base


def sanitize_draft_name(value):
    text = str(value or "").strip()
    if not text:
        return ""
    safe = re.sub(r"[^A-Za-z0-9가-힣_.-]+", "_", text)
    safe = safe.strip("._ ")[:80]
    return safe or ""


def get_source_preprocess_config(process_config=None):
    raw = process_config.get("source_preprocess") if isinstance(process_config, dict) else {}
    if not isinstance(raw, dict):
        raw = {}
    scene_raw = raw.get("scene_detection") if isinstance(raw.get("scene_detection"), dict) else {}
    quality_scale = safe_float(raw.get("quality_scale"), 0.8)
    if quality_scale <= 0 or quality_scale > 1:
        quality_scale = 0.8
    crf = int(safe_float(raw.get("crf"), 28))
    crf = min(40, max(18, crf))
    return {
        "enabled": coerce_bool(raw.get("enabled"), True),
        "scene_tail_trim_sec": max(0.0, safe_float(raw.get("scene_tail_trim_sec"), 1.0)),
        "quality_scale": quality_scale,
        "hdr_look": coerce_bool(raw.get("hdr_look"), True),
        "crf": crf,
        "ocr_blur": {
            "enabled": coerce_bool((raw.get("ocr_blur") or {}).get("enabled") if isinstance(raw.get("ocr_blur"), dict) else raw.get("ocr_blur"), False),
            "mode": str((raw.get("ocr_blur") or {}).get("mode") if isinstance(raw.get("ocr_blur"), dict) else "watermark_safe").strip() or "watermark_safe",
            "padding_px": int(safe_float((raw.get("ocr_blur") or {}).get("padding_px") if isinstance(raw.get("ocr_blur"), dict) else 16, 16)),
            "detect_every_sec": max(0.2, safe_float((raw.get("ocr_blur") or {}).get("detect_every_sec") if isinstance(raw.get("ocr_blur"), dict) else 0.5, 0.5)),
            "max_samples": int(safe_float((raw.get("ocr_blur") or {}).get("max_samples") if isinstance(raw.get("ocr_blur"), dict) else 3, 3)),
            "blur_kernel": int(safe_float((raw.get("ocr_blur") or {}).get("blur_kernel") if isinstance(raw.get("ocr_blur"), dict) else 65, 65)),
        },
        "scene_detection": {
            "enabled": coerce_bool(scene_raw.get("enabled"), True),
            "threshold": min(0.95, max(0.01, safe_float(scene_raw.get("threshold"), 0.32))),
            "min_scene_sec": max(0.2, safe_float(scene_raw.get("min_scene_sec"), 1.0)),
            "gemini_scene_transitions": scene_raw.get("gemini_scene_transitions") if isinstance(scene_raw.get("gemini_scene_transitions"), list) else [],
            "gemini_scene_change_times": scene_raw.get("gemini_scene_change_times") if isinstance(scene_raw.get("gemini_scene_change_times"), list) else [],
        },
    }


def zone_for_text_box(y, h, frame_h):
    center = y + h / 2
    if frame_h <= 0:
        return "unknown"
    if center < frame_h / 3:
        return "top"
    if center > frame_h * 2 / 3:
        return "bottom"
    return "middle"


def detect_text_like_regions(frame):
    if cv2 is None or frame is None:
        return []
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    blackhat = cv2.morphologyEx(gray, cv2.MORPH_BLACKHAT, cv2.getStructuringElement(cv2.MORPH_RECT, (17, 5)))
    grad = cv2.Sobel(blackhat, ddepth=cv2.CV_32F, dx=1, dy=0, ksize=-1)
    grad = cv2.convertScaleAbs(grad)
    grad = cv2.GaussianBlur(grad, (3, 3), 0)
    _, thresh = cv2.threshold(grad, 0, 255, cv2.THRESH_BINARY | cv2.THRESH_OTSU)
    close = cv2.morphologyEx(thresh, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (21, 5)))
    close = cv2.dilate(close, cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3)), iterations=1)

    contours, _ = cv2.findContours(close, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    frame_h, frame_w = frame.shape[:2]
    regions = []
    for contour in contours:
        x, y, w, h = cv2.boundingRect(contour)
        if w < 24 or h < 8:
            continue
        if w > frame_w * 0.95 or h > frame_h * 0.28:
            continue
        aspect = w / max(1, h)
        if aspect < 1.2 or aspect > 28:
            continue
        area_ratio = (w * h) / max(1, frame_w * frame_h)
        if area_ratio < 0.00018:
            continue
        regions.append({
            "x": int(x),
            "y": int(y),
            "width": int(w),
            "height": int(h),
            "zone": zone_for_text_box(y, h, frame_h),
            "area_ratio": round(area_ratio, 6),
        })
    regions.sort(key=lambda item: (item["zone"], item["y"], item["x"]))
    return regions[:30]


def detect_text_like_regions_for_blur(frame, max_width=480):
    if frame is None:
        return []
    frame_h, frame_w = frame.shape[:2]
    if frame_w <= 0 or frame_h <= 0 or frame_w <= max_width:
        return detect_text_like_regions(frame)
    scale = max_width / frame_w
    resized = cv2.resize(frame, (max_width, int(frame_h * scale)), interpolation=cv2.INTER_AREA)
    detected = detect_text_like_regions(resized)
    restored = []
    for region in detected:
        restored.append({
            **region,
            "x": int(region["x"] / scale),
            "y": int(region["y"] / scale),
            "width": int(region["width"] / scale),
            "height": int(region["height"] / scale),
        })
    return restored


def expand_text_regions_to_blur_boxes(regions, frame_w, frame_h, padding_px=38, mode="aggressive"):
    boxes = []
    pad = max(0, int(padding_px or 0))
    vertical_pad = int(pad * (1.25 if str(mode).lower() == "aggressive" else 1.0))
    for region in regions:
        x = int(region.get("x", 0))
        y = int(region.get("y", 0))
        w = int(region.get("width", 0))
        h = int(region.get("height", 0))
        if w <= 0 or h <= 0:
            continue
        left = max(0, x - pad)
        top = max(0, y - vertical_pad)
        right = min(frame_w, x + w + pad)
        bottom = min(frame_h, y + h + vertical_pad)
        if right <= left or bottom <= top:
            continue
        boxes.append((left, top, right, bottom))

    if str(mode).lower() != "aggressive":
        return boxes

    # Nearby OCR fragments are usually parts of the same burned-in caption/logo.
    # Merge boxes on the same vertical band so the blur covers the whole visual object.
    merged = []
    for box in sorted(boxes, key=lambda item: (item[1], item[0])):
        left, top, right, bottom = box
        merged_into_existing = False
        for index, existing in enumerate(merged):
            e_left, e_top, e_right, e_bottom = existing
            vertical_overlap = min(bottom, e_bottom) - max(top, e_top)
            close_y = abs(((top + bottom) / 2) - ((e_top + e_bottom) / 2)) <= max(28, vertical_pad * 1.4)
            close_x = left <= e_right + max(80, pad * 2) and right >= e_left - max(80, pad * 2)
            if vertical_overlap > 0 or (close_y and close_x):
                merged[index] = (
                    max(0, min(e_left, left)),
                    max(0, min(e_top, top)),
                    min(frame_w, max(e_right, right)),
                    min(frame_h, max(e_bottom, bottom)),
                )
                merged_into_existing = True
                break
        if not merged_into_existing:
            merged.append(box)
    return merged


def is_watermark_safe_mode(mode):
    return str(mode or "").strip().lower() in {"watermark", "watermark_safe", "safe_watermark"}


def default_lower_center_watermark_box(frame_w, frame_h):
    # Most reposted manufacturing/process clips place a semi-transparent source
    # watermark around the lower center. Keep this deliberately narrow; the user
    # can still fine-tune manually in CapCut.
    left = int(frame_w * 0.27)
    top = int(frame_h * 0.86)
    right = int(frame_w * 0.73)
    bottom = int(frame_h * 0.90)
    return (
        max(2, left),
        max(2, top),
        min(frame_w - 2, right),
        min(frame_h - 2, bottom),
    )


def filter_watermark_safe_boxes(boxes, frame_w, frame_h):
    filtered = []
    for left, top, right, bottom in boxes:
        width = right - left
        height = bottom - top
        if width <= 0 or height <= 0:
            continue
        center_x = (left + right) / 2
        center_y = (top + bottom) / 2
        if center_y < frame_h * 0.58 or center_y > frame_h * 0.86:
            continue
        if center_x < frame_w * 0.12 or center_x > frame_w * 0.88:
            continue
        if height > frame_h * 0.075:
            continue
        if width > frame_w * 0.68:
            continue
        if width < frame_w * 0.05:
            continue
        filtered.append((left, top, right, bottom))
    return filtered


def make_odd_kernel(value):
    kernel = int(value or 91)
    kernel = max(15, kernel)
    if kernel % 2 == 0:
        kernel += 1
    return kernel


def apply_blur_boxes(frame, boxes, kernel_size):
    if frame is None or not boxes:
        return frame
    kernel = make_odd_kernel(kernel_size)
    for left, top, right, bottom in boxes:
        roi = frame[top:bottom, left:right]
        if roi.size == 0:
            continue
        # Large Gaussian kernels are too slow for batch processing. Pixelating
        # first gives a stronger removal look and keeps 10+ item queues usable.
        roi_h, roi_w = roi.shape[:2]
        pixel_scale = 18 if kernel >= 61 else 10
        small_w = max(1, roi_w // pixel_scale)
        small_h = max(1, roi_h // pixel_scale)
        small = cv2.resize(roi, (small_w, small_h), interpolation=cv2.INTER_LINEAR)
        blurred = cv2.resize(small, (roi_w, roi_h), interpolation=cv2.INTER_NEAREST)
        if kernel >= 31:
            soft_kernel = min(21, kernel)
            if soft_kernel % 2 == 0:
                soft_kernel += 1
            blurred = cv2.GaussianBlur(blurred, (soft_kernel, soft_kernel), 0)
        frame[top:bottom, left:right] = blurred
    return frame


def merge_global_blur_boxes(boxes, frame_w, frame_h, padding_px=38):
    merged = []
    pad = max(20, int(padding_px or 38))
    for box in sorted(boxes, key=lambda item: (item[1], item[0])):
        left, top, right, bottom = box
        merged_into_existing = False
        for index, existing in enumerate(merged):
            e_left, e_top, e_right, e_bottom = existing
            close_y = abs(((top + bottom) / 2) - ((e_top + e_bottom) / 2)) <= max(36, pad * 1.15)
            close_x = left <= e_right + max(120, pad * 3) and right >= e_left - max(120, pad * 3)
            if close_y and close_x:
                merged[index] = (
                    max(0, min(e_left, left)),
                    max(0, min(e_top, top)),
                    min(frame_w, max(e_right, right)),
                    min(frame_h, max(e_bottom, bottom)),
                )
                merged_into_existing = True
                break
        if not merged_into_existing:
            merged.append(box)
    max_box_height = max(56, int(frame_h * 0.12))
    bounded = []
    for left, top, right, bottom in merged:
        safe_left = max(2, left)
        safe_top = max(2, top)
        safe_right = min(frame_w - 2, right)
        safe_bottom = min(frame_h - 2, bottom)
        if safe_right <= safe_left or safe_bottom <= safe_top:
            continue
        if (safe_bottom - safe_top) <= max_box_height and (safe_right - safe_left) >= 24:
            bounded.append((safe_left, safe_top, safe_right, safe_bottom))
    # Bigger areas first; keep the filter graph bounded for batch speed.
    bounded.sort(key=lambda item: (item[2] - item[0]) * (item[3] - item[1]), reverse=True)
    return bounded[:12]


def collect_ocr_blur_boxes(video_path, ocr_config):
    if cv2 is None:
        return [], {
            "status": "failed",
            "reason": "opencv not available",
            "sampled_frames": 0,
        }

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        return [], {
            "status": "failed",
            "reason": "video open failed",
            "sampled_frames": 0,
        }

    fps = cap.get(cv2.CAP_PROP_FPS) or 30
    frame_count = cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0
    duration_sec = frame_count / fps if fps else 0
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    max_samples = max(1, int(ocr_config.get("max_samples") or 4))
    if duration_sec > 0 and max_samples > 1:
        sample_times = [round((duration_sec * index) / (max_samples - 1), 3) for index in range(max_samples)]
    else:
        sample_times = [0.0]

    all_boxes = []
    sampled_frames = 0
    mode = str(ocr_config.get("mode") or "watermark_safe")
    for time_sec in sample_times:
        cap.set(cv2.CAP_PROP_POS_MSEC, time_sec * 1000)
        ok, frame = cap.read()
        if not ok or frame is None:
            continue
        sampled_frames += 1
        regions = detect_text_like_regions_for_blur(frame)
        boxes = expand_text_regions_to_blur_boxes(
            regions,
            width,
            height,
            padding_px=int(ocr_config.get("padding_px") or 16),
            mode=mode,
        )
        all_boxes.extend(boxes)
    cap.release()

    if is_watermark_safe_mode(mode):
        # Detection is useful for reports, but too noisy for automatic removal:
        # baskets, product embossing, and machine texture can look text-like.
        # In safe mode, use only the predictable lower-center watermark mask.
        all_boxes = []
        fallback_box = default_lower_center_watermark_box(width, height)
        if fallback_box[2] > fallback_box[0] and fallback_box[3] > fallback_box[1]:
            all_boxes.append(fallback_box)

    merged_boxes = merge_global_blur_boxes(
        all_boxes,
        width,
        height,
        padding_px=int(ocr_config.get("padding_px") or 16),
    )
    return merged_boxes, {
        "status": "success",
        "duration_sec": round(duration_sec, 3),
        "width": width,
        "height": height,
        "fps": round(fps, 3),
        "sampled_frames": sampled_frames,
        "raw_boxes_count": len(all_boxes),
        "merged_boxes_count": len(merged_boxes),
        "boxes": [
            {
                "x": left,
                "y": top,
                "width": right - left,
                "height": bottom - top,
            }
            for left, top, right, bottom in merged_boxes
        ],
    }


def build_ffmpeg_ocr_blur_filter(boxes, blur_kernel, mode="watermark_safe"):
    if not boxes:
        return ""
    if is_watermark_safe_mode(mode):
        split_labels = ["base"] + [f"crop{i}" for i in range(len(boxes))]
        parts = [f"[0:v]split={len(split_labels)}" + "".join(f"[{label}]" for label in split_labels)]
        previous_label = "base"
        for index, (left, top, right, bottom) in enumerate(boxes):
            width = max(2, right - left)
            height = max(2, bottom - top)
            radius = max(8, min(24, int((blur_kernel or 65) / 4), max(8, min(width, height) // 5)))
            blur_label = f"blur{index}"
            out_label = f"ov{index}"
            parts.append(
                f"[crop{index}]crop={width}:{height}:{left}:{top},"
                f"boxblur={radius}:1[{blur_label}]"
            )
            parts.append(f"[{previous_label}][{blur_label}]overlay={left}:{top}[{out_label}]")
            previous_label = out_label
        parts.append(f"[{previous_label}]format=yuv420p[v]")
        return ";".join(parts)

    filters = []
    for left, top, right, bottom in boxes:
        width = max(2, right - left)
        height = max(2, bottom - top)
        filters.append(f"delogo=x={left}:y={top}:w={width}:h={height}:show=0")
    filters.append("format=yuv420p")
    return "[0:v]" + ",".join(filters) + "[v]"


def apply_ocr_blur_to_video(source_path, output_path, ocr_config, warnings, crf=28):
    summary = {
        "enabled": bool(ocr_config.get("enabled")),
        "requested": bool(ocr_config.get("enabled")),
        "applied": False,
        "mode": str(ocr_config.get("mode") or "aggressive"),
        "padding_px": int(ocr_config.get("padding_px") or 16),
        "detect_every_sec": safe_float(ocr_config.get("detect_every_sec"), 0.5),
        "max_samples": int(ocr_config.get("max_samples") or 4),
        "blur_kernel": make_odd_kernel(ocr_config.get("blur_kernel") or 91),
        "sampled_frames": 0,
        "boxes_applied_count": 0,
        "boxes": [],
        "reason": "",
    }
    if not summary["enabled"]:
        summary["reason"] = "ocr blur disabled"
        return summary
    if cv2 is None:
        summary["reason"] = "opencv not available"
        warnings.append("OCR blur skipped: OpenCV is not available.")
        return summary
    if not source_path or not os.path.exists(source_path):
        summary["reason"] = "source video not found"
        warnings.append("OCR blur skipped: source video not found.")
        return summary

    boxes, detection_summary = collect_ocr_blur_boxes(source_path, ocr_config)
    summary["sampled_frames"] = detection_summary.get("sampled_frames", 0)
    summary["boxes_applied_count"] = len(boxes)
    summary["boxes"] = detection_summary.get("boxes", [])
    if detection_summary.get("status") != "success":
        summary["reason"] = detection_summary.get("reason", "text region detection failed")
        warnings.append(f"OCR blur skipped: {summary['reason']}.")
        return summary
    if not boxes:
        summary["reason"] = "no OCR/text-like regions detected"
        warnings.append("OCR blur skipped: no OCR/text-like regions detected.")
        return summary

    filter_complex = build_ffmpeg_ocr_blur_filter(boxes, summary["blur_kernel"], summary["mode"])
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    cmd = [
        FFMPEG_BIN,
        "-y",
        "-i",
        source_path,
        "-filter_complex",
        filter_complex,
        "-map",
        "[v]",
        "-map",
        "0:a?",
        "-c:v",
        "libx264",
        "-crf",
        str(int(crf or 28)),
        "-preset",
        "veryfast",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-shortest",
        output_path,
    ]
    try:
        subprocess.run(cmd, capture_output=True, text=True, check=True)
        if os.path.exists(output_path) and os.path.getsize(output_path) > 1024:
            summary["applied"] = True
            summary["reason"] = "ocr text/logo candidate blur applied"
        else:
            summary["reason"] = "ffmpeg blur output missing or too small"
            warnings.append("OCR blur output missing; source preprocess output was copied without OCR blur.")
    except (OSError, subprocess.SubprocessError) as error:
        summary["reason"] = f"ffmpeg ocr blur failed: {error}"
        warnings.append(summary["reason"])
    return summary


def prepare_process_source_video(source_path, output_path, preprocess_config, warnings):
    ocr_config = preprocess_config.get("ocr_blur") if isinstance(preprocess_config.get("ocr_blur"), dict) else {}
    summary = {
        "enabled": bool(preprocess_config.get("enabled")),
        "applied": False,
        "source_path": source_path,
        "output_path": output_path,
        "quality_scale": preprocess_config.get("quality_scale"),
        "hdr_look": bool(preprocess_config.get("hdr_look")),
        "crf": preprocess_config.get("crf"),
        "method": "copy",
        "reason": "",
        "ocr_blur": {
            "enabled": bool(ocr_config.get("enabled", False)),
            "requested": bool(ocr_config.get("enabled", False)),
            "applied": False,
            "mode": str(ocr_config.get("mode") or "aggressive"),
            "padding_px": int(ocr_config.get("padding_px") or 38),
            "reason": "not attempted",
        },
    }
    if not source_path or not os.path.exists(source_path):
        summary["reason"] = "source video not found"
        return summary

    os.makedirs(os.path.dirname(output_path), exist_ok=True)

    if not summary["enabled"]:
        shutil.copy2(source_path, output_path)
        summary["reason"] = "source preprocess disabled"
        summary["ocr_blur"]["reason"] = "source preprocess disabled"
        return summary

    quality_scale = max(0.1, min(1.0, safe_float(preprocess_config.get("quality_scale"), 0.8)))
    scale_expr = f"scale=trunc(iw*{quality_scale}/2)*2:trunc(ih*{quality_scale}/2)*2"
    filters = [scale_expr]
    if coerce_bool(preprocess_config.get("hdr_look"), True):
        # This is an HDR-style grade, not a true HDR master. It is intentionally
        # conservative so the generated draft remains portable.
        filters.extend([
            "eq=contrast=1.08:saturation=1.12:brightness=0.01",
            "unsharp=5:5:0.45:3:3:0.25",
        ])

    ocr_enabled = coerce_bool(ocr_config.get("enabled"), False)
    ffmpeg_output_path = output_path
    intermediate_path = ""
    if ocr_enabled:
        intermediate_path = f"{output_path}.preprocess.mp4"
        ffmpeg_output_path = intermediate_path

    cmd = [
        FFMPEG_BIN,
        "-y",
        "-i",
        source_path,
        "-map_metadata",
        "-1",
        "-map_chapters",
        "-1",
        "-vf",
        ",".join(filters),
        "-c:v",
        "libx264",
        "-crf",
        str(int(preprocess_config.get("crf") or 28)),
        "-preset",
        "veryfast",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        ffmpeg_output_path,
    ]
    try:
        subprocess.run(cmd, capture_output=True, text=True, check=True)
        if os.path.exists(ffmpeg_output_path) and os.path.getsize(ffmpeg_output_path) > 1024:
            summary["applied"] = True
            summary["method"] = "ffmpeg"
            summary["reason"] = "ffmpeg source preprocess applied"
            if ocr_enabled:
                blur_summary = apply_ocr_blur_to_video(
                    ffmpeg_output_path,
                    output_path,
                    ocr_config,
                    warnings,
                    crf=int(preprocess_config.get("crf") or 28),
                )
                summary["ocr_blur"] = blur_summary
                if blur_summary.get("applied"):
                    summary["method"] = "ffmpeg+ocr_blur"
                    summary["reason"] = "ffmpeg source preprocess and OCR blur applied"
                else:
                    shutil.copy2(ffmpeg_output_path, output_path)
                    summary["reason"] = "ffmpeg source preprocess applied; OCR blur skipped"
                try:
                    if intermediate_path and os.path.exists(intermediate_path):
                        os.remove(intermediate_path)
                except OSError:
                    pass
            return summary
        summary["reason"] = "ffmpeg output missing or too small"
    except (OSError, subprocess.SubprocessError) as error:
        summary["reason"] = f"ffmpeg preprocess failed: {error}"
        warnings.append(summary["reason"])

    shutil.copy2(source_path, output_path)
    summary["method"] = "copy_fallback"
    summary["ocr_blur"]["reason"] = "ffmpeg preprocess failed; copied source fallback"
    try:
        if intermediate_path and os.path.exists(intermediate_path):
            os.remove(intermediate_path)
    except OSError:
        pass
    return summary


def normalize_gemini_scene_change_times(scene_config, target_duration_sec):
    candidates = []
    raw_times = scene_config.get("gemini_scene_change_times") if isinstance(scene_config, dict) else []
    if isinstance(raw_times, list):
        for value in raw_times:
            scene_time = safe_float(value, 0.0)
            if scene_time > 0:
                candidates.append(scene_time)

    raw_transitions = scene_config.get("gemini_scene_transitions") if isinstance(scene_config, dict) else []
    if isinstance(raw_transitions, list):
        for item in raw_transitions:
            if not isinstance(item, dict):
                continue
            scene_time = safe_float(item.get("transition_at_sec", item.get("end_sec", 0.0)), 0.0)
            if scene_time > 0:
                candidates.append(scene_time)

    filtered = []
    for scene_time in sorted(set(round(value, 3) for value in candidates)):
        if target_duration_sec and scene_time >= float(target_duration_sec):
            continue
        if scene_time <= 0:
            continue
        if not filtered or (scene_time - filtered[-1]) >= max(0.2, safe_float(scene_config.get("min_scene_sec"), 1.0)):
            filtered.append(scene_time)
    return filtered


def normalize_gemini_scene_transition_items(scene_config, target_duration_sec):
    raw_transitions = scene_config.get("gemini_scene_transitions") if isinstance(scene_config, dict) else []
    if not isinstance(raw_transitions, list):
        return []

    valid_focus_zones = {
        "center",
        "left",
        "right",
        "top",
        "bottom",
        "center_left",
        "center_right",
        "upper_left",
        "upper_right",
        "lower_left",
        "lower_right",
    }
    valid_camera_moves = {
        "static",
        "slow_zoom_in",
        "punch_zoom",
        "zoom_out",
        "scan_left",
        "scan_right",
        "tilt_up",
        "tilt_down",
        "speed_up",
        "slow_motion",
    }
    valid_intensities = {"low", "medium", "high"}
    normalized = []
    for index, item in enumerate(raw_transitions):
        if not isinstance(item, dict):
            continue
        start_sec = max(0.0, safe_float(item.get("start_sec"), 0.0))
        end_sec = max(start_sec, safe_float(item.get("end_sec"), safe_float(item.get("transition_at_sec"), start_sec)))
        transition_at_sec = max(0.0, safe_float(item.get("transition_at_sec"), end_sec))
        if target_duration_sec and start_sec >= float(target_duration_sec):
            continue
        if target_duration_sec:
            end_sec = min(end_sec, float(target_duration_sec))
            transition_at_sec = min(transition_at_sec, float(target_duration_sec))
        focus_zone = str(item.get("focus_zone") or "center").strip()
        camera_move = str(item.get("recommended_camera_move") or "slow_zoom_in").strip()
        intensity = str(item.get("motion_intensity") or "medium").strip()
        normalized.append(
            {
                "scene_id": str(item.get("scene_id") or f"scene_{index + 1:03d}"),
                "start_sec": round(start_sec, 3),
                "end_sec": round(end_sec, 3),
                "transition_at_sec": round(transition_at_sec, 3),
                "visual_summary": str(item.get("visual_summary") or "").strip(),
                "caption_text": str(item.get("caption_text") or item.get("visual_summary") or "").strip(),
                "caption_text_ko": str(item.get("caption_text_ko") or "").strip(),
                "change_type": str(item.get("change_type") or "scene_change").strip(),
                "confidence": str(item.get("confidence") or "medium").strip(),
                "focus_target": str(item.get("focus_target") or item.get("visual_summary") or "").strip(),
                "focus_zone": focus_zone if focus_zone in valid_focus_zones else "center",
                "recommended_camera_move": camera_move if camera_move in valid_camera_moves else "slow_zoom_in",
                "motion_intensity": intensity if intensity in valid_intensities else "medium",
                "visual_hook_score": min(10, max(1, int(round(safe_float(item.get("visual_hook_score"), 1))))),
                "visual_hook_type": str(item.get("visual_hook_type") or "").strip(),
                "curiosity_reason": str(item.get("curiosity_reason") or "").strip(),
                "repetition_potential": min(10, max(1, int(round(safe_float(item.get("repetition_potential"), 1))))),
                "mechanical_rhythm": str(item.get("mechanical_rhythm") or "").strip(),
                "human_presence": coerce_bool(item.get("human_presence"), False),
                "process_focus_priority": str(item.get("process_focus_priority") or "").strip(),
            }
        )
    normalized.sort(key=lambda item: (item["start_sec"], item["transition_at_sec"]))
    return normalized


def find_scene_focus_for_range(scene_items, start_sec, end_sec, fallback_index=0):
    if not scene_items:
        return {}
    start_sec = safe_float(start_sec, 0.0)
    end_sec = safe_float(end_sec, start_sec)
    best_item = None
    best_overlap = 0.0
    for item in scene_items:
        item_start = safe_float(item.get("start_sec"), 0.0)
        item_end = safe_float(item.get("end_sec"), safe_float(item.get("transition_at_sec"), item_start))
        overlap = max(0.0, min(end_sec, item_end) - max(start_sec, item_start))
        if overlap > best_overlap:
            best_overlap = overlap
            best_item = item
    if best_item:
        return best_item
    if 0 <= fallback_index < len(scene_items):
        return scene_items[fallback_index]
    return {}


def detect_scene_changes_pyscenedetect(video_path, target_duration_sec, scene_config, warnings):
    summary = {
        "available": False,
        "applied": False,
        "method": "pyscenedetect_content",
        "threshold": min(95.0, max(1.0, safe_float(scene_config.get("pyscenedetect_threshold"), safe_float(scene_config.get("threshold"), 0.32) * 100.0))),
        "min_scene_sec": max(0.2, safe_float(scene_config.get("min_scene_sec"), 1.0)),
        "scene_change_times": [],
        "scene_transitions": [],
        "scene_count": 0,
        "reason": "",
    }
    if coerce_bool(scene_config.get("pyscenedetect_enabled"), True) is False:
        summary["reason"] = "PySceneDetect disabled by config"
        return summary
    try:
        from scenedetect import SceneManager, open_video  # type: ignore
        from scenedetect.detectors import ContentDetector  # type: ignore
    except Exception as error:
        summary["reason"] = f"PySceneDetect not available: {error}"
        return summary

    summary["available"] = True
    try:
        video = open_video(video_path)
        scene_manager = SceneManager()
        scene_manager.add_detector(ContentDetector(threshold=summary["threshold"], min_scene_len=1))
        scene_manager.detect_scenes(video)
        scene_list = scene_manager.get_scene_list()

        transitions = []
        change_times = []
        for index, (start_time, end_time) in enumerate(scene_list):
            start_sec = float(start_time.get_seconds())
            end_sec = float(end_time.get_seconds())
            if target_duration_sec:
                if start_sec >= float(target_duration_sec):
                    continue
                end_sec = min(end_sec, float(target_duration_sec))
            if end_sec <= start_sec:
                continue
            if index > 0 and start_sec > 0:
                change_times.append(start_sec)
            transitions.append({
                "scene_id": f"pyscene_{index + 1:03d}",
                "start_sec": round(start_sec, 3),
                "end_sec": round(end_sec, 3),
                "transition_at_sec": round(end_sec, 3),
                "visual_summary": "PySceneDetect detected visual scene segment",
                "caption_text": "",
                "caption_text_ko": "",
                "focus_target": "",
                "motion_intensity": "medium",
                "recommended_camera_move": "static",
                "focus_zone": "center",
                "change_type": "pyscenedetect_scene_change",
            })

        filtered = []
        for scene_time in sorted(set(round(value, 3) for value in change_times)):
            if not filtered or (scene_time - filtered[-1]) >= summary["min_scene_sec"]:
                filtered.append(scene_time)

        summary["scene_change_times"] = filtered
        summary["scene_transitions"] = transitions
        summary["scene_count"] = len(filtered)
        summary["applied"] = len(filtered) > 0
        summary["reason"] = "PySceneDetect scene changes detected" if filtered else "PySceneDetect found no scene changes"
    except Exception as error:
        summary["reason"] = f"PySceneDetect failed: {error}"
        warnings.append(summary["reason"])
    return summary


def merge_scene_detection_sources(gemini_times, gemini_items, py_summary, scene_config, target_duration_sec):
    min_scene_sec = max(0.2, safe_float(scene_config.get("min_scene_sec"), 1.0))
    all_times = []
    for value in list(gemini_times or []) + list(py_summary.get("scene_change_times") or []):
        scene_time = safe_float(value, 0.0)
        if scene_time <= 0:
            continue
        if target_duration_sec and scene_time >= float(target_duration_sec):
            continue
        all_times.append(round(scene_time, 3))

    merged_times = []
    for scene_time in sorted(set(all_times)):
        if not merged_times or (scene_time - merged_times[-1]) >= min_scene_sec:
            merged_times.append(scene_time)

    merged_items = []
    seen_ranges = set()
    for item in list(gemini_items or []) + list(py_summary.get("scene_transitions") or []):
        start_sec = round(safe_float(item.get("start_sec"), 0.0), 3)
        end_sec = round(safe_float(item.get("end_sec"), safe_float(item.get("transition_at_sec"), start_sec + 0.2)), 3)
        if target_duration_sec:
            if start_sec >= float(target_duration_sec):
                continue
            end_sec = min(end_sec, float(target_duration_sec))
        key = (start_sec, end_sec)
        if end_sec <= start_sec or key in seen_ranges:
            continue
        seen_ranges.add(key)
        merged_items.append(item)

    return merged_times, merged_items


def detect_scene_changes_ffmpeg(video_path, target_duration_sec, preprocess_config, warnings):
    scene_config = preprocess_config.get("scene_detection") if isinstance(preprocess_config, dict) else {}
    if not isinstance(scene_config, dict):
        scene_config = {}

    summary = {
        "enabled": coerce_bool(scene_config.get("enabled"), True),
        "applied": False,
        "method": "ffmpeg_scene",
        "threshold": min(0.95, max(0.01, safe_float(scene_config.get("threshold"), 0.32))),
        "min_scene_sec": max(0.2, safe_float(scene_config.get("min_scene_sec"), 1.0)),
        "scene_change_times": [],
        "scene_transitions": [],
        "scene_count": 0,
        "reason": "",
    }

    if not summary["enabled"]:
        summary["reason"] = "scene detection disabled"
        return summary
    if not video_path or not os.path.exists(video_path):
        summary["reason"] = "video path not found"
        return summary

    gemini_times = normalize_gemini_scene_change_times(scene_config, target_duration_sec)
    gemini_scene_items = normalize_gemini_scene_transition_items(scene_config, target_duration_sec)
    py_summary = detect_scene_changes_pyscenedetect(video_path, target_duration_sec, scene_config, warnings)
    if gemini_times or py_summary.get("scene_change_times"):
        merged_times, merged_items = merge_scene_detection_sources(
            gemini_times,
            gemini_scene_items,
            py_summary,
            scene_config,
            target_duration_sec,
        )
        if gemini_times and py_summary.get("scene_change_times"):
            summary["method"] = "gemini_pyscenedetect_merge"
        elif gemini_times:
            summary["method"] = "gemini_scene_transitions"
        else:
            summary["method"] = "pyscenedetect_content"
        summary["scene_change_times"] = merged_times
        summary["scene_transitions"] = merged_items
        summary["scene_count"] = len(merged_times)
        summary["applied"] = len(merged_times) > 0
        summary["pyscenedetect"] = py_summary
        summary["reason"] = "Gemini and PySceneDetect timestamps merged" if gemini_times and py_summary.get("scene_change_times") else (
            "Gemini scene transition timestamps applied" if gemini_times else py_summary.get("reason", "PySceneDetect scene changes applied")
        )
        return summary

    filter_expr = f"select='gt(scene,{summary['threshold']})',showinfo"
    cmd = [
        FFMPEG_BIN,
        "-hide_banner",
        "-i",
        video_path,
        "-filter:v",
        filter_expr,
        "-f",
        "null",
        "-",
    ]
    try:
        completed = subprocess.run(cmd, capture_output=True, text=True, check=False)
        stderr = completed.stderr or ""
        candidates = []
        for match in re.finditer(r"pts_time:([0-9]+(?:\.[0-9]+)?)", stderr):
            scene_time = safe_float(match.group(1), 0.0)
            if scene_time <= 0:
                continue
            if target_duration_sec and scene_time >= float(target_duration_sec):
                continue
            candidates.append(scene_time)

        filtered = []
        for scene_time in sorted(set(round(value, 3) for value in candidates)):
            if not filtered or (scene_time - filtered[-1]) >= summary["min_scene_sec"]:
                filtered.append(scene_time)

        summary["scene_change_times"] = filtered
        summary["scene_count"] = len(filtered)
        summary["applied"] = len(filtered) > 0
        summary["reason"] = "scene changes detected" if filtered else "no scene changes detected; fixed 3s edit rhythm used"
    except Exception as error:
        summary["reason"] = f"scene detection failed: {error}"
        warnings.append(summary["reason"])

    return summary


def create_relative_variant(draft_path, output_base):
    relative_draft_name = f"{os.path.basename(draft_path)}_relative"
    relative_draft_path = os.path.abspath(os.path.join(output_base, relative_draft_name))
    if os.path.exists(relative_draft_path):
        shutil.rmtree(relative_draft_path)
    shutil.copytree(draft_path, relative_draft_path)

    draft_content_path = os.path.join(relative_draft_path, "draft_content.json")
    with open(draft_content_path, "r", encoding="utf-8") as draft_content_file:
        draft_content = json.load(draft_content_file)

    for audio in draft_content.get("materials", {}).get("audios", []):
        current_path = audio.get("path", "")
        if current_path:
            filename = os.path.basename(current_path)
            audio["path"] = os.path.join("audio", filename).replace("\\", "/")

    for video in draft_content.get("materials", {}).get("videos", []):
        current_path = video.get("path", "")
        if current_path:
            filename = os.path.basename(current_path)
            video["path"] = os.path.join("video", filename).replace("\\", "/")

    with open(draft_content_path, "w", encoding="utf-8") as draft_content_file:
        json.dump(draft_content, draft_content_file, ensure_ascii=False, indent=4)

    return relative_draft_name, relative_draft_path


def normalize_process_blocks(process_config, target_duration_sec):
    raw_blocks = process_config.get("explainer_blocks") if isinstance(process_config, dict) else []
    blocks = []
    if isinstance(raw_blocks, list):
        for index, raw in enumerate(raw_blocks):
            if not isinstance(raw, dict):
                continue
            text = str(raw.get("text") or "").strip()
            if not text:
                continue
            start_sec = safe_float(raw.get("start_sec"), index * 5.0)
            end_sec = safe_float(raw.get("end_sec"), start_sec + 5.0)
            start_sec = max(0.0, min(start_sec, target_duration_sec))
            end_sec = max(start_sec + 0.2, min(end_sec, target_duration_sec))
            blocks.append(
                {
                    "block_id": str(raw.get("block_id") or f"exp_{index + 1:03d}"),
                    "scene_id": str(raw.get("scene_id") or ""),
                    "parent_scene_id": str(raw.get("parent_scene_id") or raw.get("scene_id") or ""),
                    "source_scene_index": int(safe_float(raw.get("source_scene_index"), -1)) if raw.get("source_scene_index") is not None else None,
                    "caption_part_index": int(safe_float(raw.get("caption_part_index"), 0)) if raw.get("caption_part_index") is not None else None,
                    "caption_parts_count": int(safe_float(raw.get("caption_parts_count"), 1)) if raw.get("caption_parts_count") is not None else None,
                    "caption_unit_mode": str(raw.get("caption_unit_mode") or ""),
                    "output_language": str(raw.get("output_language") or raw.get("language") or ""),
                    "language": str(raw.get("language") or raw.get("output_language") or ""),
                    "full_scene_caption_text": str(raw.get("full_scene_caption_text") or ""),
                    "text": text,
                    "start_sec": start_sec,
                    "end_sec": end_sec,
                    "style_role": str(raw.get("style_role") or "main_explainer"),
                    "style_profile": str(raw.get("style_profile") or raw.get("styleProfile") or ""),
                    "anchor_zone": str(raw.get("anchor_zone") or "lower_third"),
                    "animation": str(raw.get("animation") or "pop_in"),
                    "is_preroll_hook": coerce_bool(raw.get("is_preroll_hook"), False),
                    "source_start_sec": safe_float(raw.get("source_start_sec"), -1),
                    "source_end_sec": safe_float(raw.get("source_end_sec"), -1),
                    "source_window": raw.get("source_window") if isinstance(raw.get("source_window"), dict) else {},
                    "video_transform_override": raw.get("video_transform_override") if isinstance(raw.get("video_transform_override"), dict) else {},
                    "warnings": [],
                }
            )
    if not blocks:
        blocks = [
            {
                "block_id": "exp_001",
                "text": '이 공정에서 핵심 변화가 시작되는 구간입니다.',
                "start_sec": 0.0,
                "end_sec": min(5.0, target_duration_sec),
                "style_role": "main_explainer",
                "style_profile": "",
                "anchor_zone": "lower_third",
                "animation": "pop_in",
                "warnings": ["default block generated"],
            }
        ]
    return blocks


def get_process_zoom_scale(video_transform_preset):
    zoom = video_transform_preset.get("zoom") if isinstance(video_transform_preset.get("zoom"), dict) else {}
    if coerce_bool(zoom.get("enabled"), False):
        return max(1.0, safe_float(zoom.get("scale"), 1.0))
    if coerce_bool(video_transform_preset.get("crop_zoom"), False):
        return max(1.0, safe_float(video_transform_preset.get("zoom_scale"), 1.0))
    return 1.0


def get_process_speed_value(video_transform_preset):
    speed = video_transform_preset.get("speed") if isinstance(video_transform_preset.get("speed"), dict) else {}
    if coerce_bool(speed.get("enabled"), False):
        return max(0.1, safe_float(speed.get("value"), 1.0))
    if coerce_bool(video_transform_preset.get("speed_variation"), False):
        values = video_transform_preset.get("speed_values")
        if isinstance(values, list):
            for value in values:
                parsed = safe_float(value, 1.0)
                if abs(parsed - 1.0) > 0.001:
                    return max(0.1, parsed)
        return 1.08
    return 1.0


def get_process_crop_mode(video_transform_preset):
    if isinstance(video_transform_preset.get("pattern"), list) and video_transform_preset.get("pattern"):
        return str(video_transform_preset.get("crop_mode") or "vertical_fill").strip()
    return str(video_transform_preset.get("crop_mode") or ("vertical_fill" if video_transform_preset.get("crop_zoom") else "")).strip()


def get_transform_pan_limits(video_transform_preset):
    return {
        "x": min(0.35, max(0.02, safe_float(video_transform_preset.get("pan_limit_x"), 0.16))),
        "y": min(0.28, max(0.02, safe_float(video_transform_preset.get("pan_limit_y"), 0.16))),
    }


def get_transform_max_zoom(video_transform_preset):
    return min(3.2, max(1.0, safe_float(video_transform_preset.get("max_zoom_scale"), 2.05)))


def get_process_transform_sequence(video_transform_preset):
    raw_sequence = video_transform_preset.get("transform_sequence")
    if not isinstance(raw_sequence, list) or not raw_sequence:
        raw_sequence = video_transform_preset.get("pattern")
    if not isinstance(raw_sequence, list) or not raw_sequence:
        return []

    interval_sec = max(0.2, safe_float(video_transform_preset.get("segment_unit_sec", video_transform_preset.get("interval_sec")), 3.0))
    pan_limits = get_transform_pan_limits(video_transform_preset)
    max_zoom_scale = get_transform_max_zoom(video_transform_preset)
    sequence = []
    for index, raw_step in enumerate(raw_sequence):
        if not isinstance(raw_step, dict):
            continue
        duration_sec = max(0.2, safe_float(raw_step.get("duration_sec"), interval_sec))
        zoom_scale = min(max_zoom_scale, max(1.0, safe_float(raw_step.get("zoom_scale", raw_step.get("scale")), get_process_zoom_scale(video_transform_preset))))
        speed_value = max(0.1, safe_float(raw_step.get("speed"), 1.0))
        pan_x = min(pan_limits["x"], max(-pan_limits["x"], safe_float(raw_step.get("pan_x"), 0.0)))
        pan_y = min(pan_limits["y"], max(-pan_limits["y"], safe_float(raw_step.get("pan_y"), 0.0)))
        rotation = min(3.0, max(-3.0, safe_float(raw_step.get("rotation"), 0.0)))
        sequence.append(
            {
                "index": index,
                "label": str(raw_step.get("label") or f"step_{index + 1}"),
                "duration_sec": duration_sec,
                "zoom_scale": zoom_scale,
                "speed": speed_value,
                "pan_x": pan_x,
                "pan_y": pan_y,
                "rotation": rotation,
                "mirror": False,
            }
        )
    return sequence


def get_global_transform(video_transform_preset):
    global_transform = video_transform_preset.get("global_transform") if isinstance(video_transform_preset.get("global_transform"), dict) else {}
    mirror_requested = coerce_bool(global_transform.get("mirror"), coerce_bool(video_transform_preset.get("mirror"), False))
    base_scale = max(1.0, safe_float(global_transform.get("scale"), get_process_zoom_scale(video_transform_preset)))
    return {
        "mirror": mirror_requested,
        "base_scale": base_scale,
        "mirror_policy": str(video_transform_preset.get("mirror_policy") or "global_once_only"),
    }


def focus_zone_to_pan(focus_zone, intensity="medium"):
    zone = str(focus_zone or "center").strip()
    intensity_value = {"low": 0.025, "medium": 0.045, "high": 0.06}.get(str(intensity or "medium"), 0.045)
    mapping = {
        "center": (0.0, 0.0),
        "left": (-intensity_value, 0.0),
        "right": (intensity_value, 0.0),
        "top": (0.0, -intensity_value),
        "bottom": (0.0, intensity_value),
        "center_left": (-intensity_value, 0.0),
        "center_right": (intensity_value, 0.0),
        "upper_left": (-intensity_value, -intensity_value),
        "upper_right": (intensity_value, -intensity_value),
        "lower_left": (-intensity_value, intensity_value),
        "lower_right": (intensity_value, intensity_value),
    }
    return mapping.get(zone, (0.0, 0.0))


def apply_focus_to_transform_step(step, scene_meta, segment_index=0, pan_limit_x=0.16, pan_limit_y=0.16, max_zoom_scale=2.05):
    focused = dict(step or {})
    if not isinstance(scene_meta, dict) or not scene_meta:
        focused["focus_applied"] = False
        return focused

    intensity = str(scene_meta.get("motion_intensity") or "medium").strip()
    camera_move = str(scene_meta.get("recommended_camera_move") or "static").strip()
    focus_zone = str(scene_meta.get("focus_zone") or "center").strip()
    intensity_scale = {"low": 0.04, "medium": 0.08, "high": 0.13}.get(intensity, 0.08)
    intensity_rotation = {"low": 0.3, "medium": 0.7, "high": 1.2}.get(intensity, 0.7)

    base_scale = max(1.0, safe_float(focused.get("zoom_scale", focused.get("scale")), 1.15))
    base_speed = max(0.1, safe_float(focused.get("speed"), 1.0))
    base_rotation = safe_float(focused.get("rotation"), 0.0)
    focus_pan_x, focus_pan_y = focus_zone_to_pan(focus_zone, intensity)
    visual_hook_score = min(10, max(1, int(round(safe_float(scene_meta.get("visual_hook_score"), 1)))))
    repetition_potential = min(10, max(1, int(round(safe_float(scene_meta.get("repetition_potential"), 1)))))
    human_presence = coerce_bool(scene_meta.get("human_presence"), False)
    process_focus_priority = str(scene_meta.get("process_focus_priority") or "").strip().lower()
    scene_text = " ".join(
        str(scene_meta.get(key) or "")
        for key in (
            "visual_summary",
            "focus_target",
            "caption_text",
            "visual_hook_type",
            "curiosity_reason",
            "mechanical_rhythm",
            "process_focus_priority",
        )
    ).lower()
    human_terms = (
        "person", "people", "human", "worker", "hand", "hands", "finger", "arm",
        "operator", "craftsman", "artisan", "craftsperson",
        '사람', '작업자', '직원', '손', '손가락', '팔', '장인', '기술자',
        '人', '人物', '作業者', '職人', '手', '指', '腕', 'オペレーター',
    )
    process_terms = (
        "process", "material", "machine", "press", "cut", "mold", "shape", "forming",
        "extrude", "pull", "pour", "grind", "mix", "rotate", "conveyor",
        '공정', '재료', '기계', '프레스', '절단', '성형', '압출', '분쇄', '혼합', '회전', '컨베이어', '주입', '압착', '가공', '몰드', '제품',
        '工程', '素材', '機械', 'プレス', '切断', '成形', '押出', '粉砕', '混合', '回転', 'コンベア', '注入', '圧着', '加工', '金型', '製品',
    )
    human_detected = human_presence or any(term in scene_text for term in human_terms)
    process_focus_requested = process_focus_priority in {"process", "material", "machine", "hands", "object"} or any(
        term in scene_text for term in process_terms
    )

    # Focus-zone pan is allowed to override the generic preset pan when Gemini
    # can identify a better subject area. Camera moves then add direction.
    pan_x = focus_pan_x if focus_zone != "center" else safe_float(focused.get("pan_x"), 0.0)
    pan_y = focus_pan_y if focus_zone != "center" else safe_float(focused.get("pan_y"), 0.0)

    if camera_move == "slow_zoom_in":
        base_scale += intensity_scale * 0.6
    elif camera_move == "punch_zoom":
        base_scale += intensity_scale
        base_rotation += intensity_rotation * (1 if segment_index % 2 == 0 else -1)
    elif camera_move == "zoom_out":
        base_scale = max(1.08, base_scale - intensity_scale * 0.35)
    elif camera_move == "scan_left":
        pan_x = -max(abs(pan_x), {"low": 0.035, "medium": 0.055, "high": 0.075}.get(intensity, 0.055))
    elif camera_move == "scan_right":
        pan_x = max(abs(pan_x), {"low": 0.035, "medium": 0.055, "high": 0.075}.get(intensity, 0.055))
    elif camera_move == "tilt_up":
        pan_y = -max(abs(pan_y), {"low": 0.035, "medium": 0.055, "high": 0.075}.get(intensity, 0.055))
    elif camera_move == "tilt_down":
        pan_y = max(abs(pan_y), {"low": 0.035, "medium": 0.055, "high": 0.075}.get(intensity, 0.055))
    elif camera_move == "speed_up":
        base_speed = max(base_speed, {"low": 1.05, "medium": 1.10, "high": 1.16}.get(intensity, 1.10))
    elif camera_move == "slow_motion":
        base_speed = min(base_speed, {"low": 0.96, "medium": 0.92, "high": 0.86}.get(intensity, 0.92))

    if visual_hook_score >= 8:
        base_scale += 0.08
        base_rotation += 0.35 * (1 if segment_index % 2 == 0 else -1)
    if repetition_potential >= 8:
        base_speed = max(base_speed, 1.12 if segment_index % 2 == 0 else base_speed)
    if human_detected:
        # Human/hand shots often show too much body or face. Push in harder so
        # the cut reads as material/process-focused instead of person-focused.
        base_scale += 0.16 if process_focus_requested else 0.12
        if focus_zone == "center":
            pan_y = min(pan_y, -0.045)
        if abs(pan_x) < 0.045 and segment_index % 2:
            pan_x = -0.055
    if process_focus_requested and visual_hook_score >= 7:
        base_scale += 0.05

    focused["zoom_scale"] = min(max_zoom_scale, max(1.0, base_scale))
    focused["scale"] = focused["zoom_scale"]
    focused["speed"] = min(1.55, max(0.65, base_speed))
    focused["pan_x"] = min(pan_limit_x, max(-pan_limit_x, pan_x))
    focused["pan_y"] = min(pan_limit_y, max(-pan_limit_y, pan_y))
    focused["rotation"] = min(3.0, max(-3.0, base_rotation))
    focused["focus_applied"] = True
    focused["focus_zone"] = focus_zone
    focused["focus_target"] = str(scene_meta.get("focus_target") or "").strip()
    focused["recommended_camera_move"] = camera_move
    focused["motion_intensity"] = intensity
    focused["scene_id"] = str(scene_meta.get("scene_id") or "").strip()
    focused["visual_hook_score"] = visual_hook_score
    focused["repetition_potential"] = repetition_potential
    focused["human_presence"] = human_detected
    focused["process_focus_priority"] = process_focus_priority
    return focused


def build_segment_duration_us_list(total_duration_us, segment_unit_sec=3.0, last_segment_min_sec=1.2):
    if total_duration_us <= 0:
        return []
    unit_us = max(1, microseconds(segment_unit_sec))
    min_last_us = max(1, microseconds(last_segment_min_sec))
    durations = []
    cursor_us = 0
    while cursor_us < total_duration_us:
        duration_us = min(unit_us, total_duration_us - cursor_us)
        durations.append(duration_us)
        cursor_us += duration_us
    if len(durations) > 1 and durations[-1] < min_last_us:
        durations[-2] += durations[-1]
        durations.pop()
    return durations


def is_nine_sixteen(width, height):
    if not width or not height:
        return False
    return abs((float(width) / float(height)) - (9.0 / 16.0)) < 0.01


def apply_process_video_transforms_to_draft(
    draft_content_path,
    video_transform_preset,
    source_duration_sec,
    target_duration_sec,
    draft_width,
    draft_height,
    scene_focus_plan=None,
):
    applied = {
        "zoom": {
            "requested": False,
            "applied": False,
            "value": None,
        },
        "crop": {
            "requested": False,
            "applied": False,
            "mode": "",
        },
        "mirror": {
            "requested": False,
            "applied": False,
        },
        "speed": {
            "requested": False,
            "applied": False,
            "value": None,
        },
        "color_adjustment": {
            "requested": False,
            "applied": False,
        },
        "distortion": {
            "requested": False,
            "applied": False,
        },
    }

    if not draft_content_path or not os.path.exists(draft_content_path):
        for item in applied.values():
            item["reason"] = "draft_content.json not found"
        return applied

    with open(draft_content_path, "r", encoding="utf-8-sig") as file:
        draft_content = json.load(file)

    video_track = None
    for track in draft_content.get("tracks", []):
        if isinstance(track, dict) and track.get("type") == "video" and track.get("name") == "source_video":
            video_track = track
            break
    if video_track is None:
        for track in draft_content.get("tracks", []):
            if isinstance(track, dict) and track.get("type") == "video":
                video_track = track
                break

    video_segment = None
    if video_track:
        for segment in video_track.get("segments", []):
            if isinstance(segment, dict):
                video_segment = segment
                break

    if video_segment is None:
        for item in applied.values():
            item["reason"] = "video segment not found"
        return applied

    material_id = video_segment.get("material_id")
    video_material = None
    for material in (draft_content.get("materials") or {}).get("videos", []):
        if isinstance(material, dict) and material.get("id") == material_id:
            video_material = material
            break

    clip = video_segment.setdefault("clip", {})
    if not isinstance(clip.get("scale"), dict):
        clip["scale"] = {"x": 1.0, "y": 1.0}
    if not isinstance(clip.get("flip"), dict):
        clip["flip"] = {"horizontal": False, "vertical": False}

    sequence_steps = get_process_transform_sequence(video_transform_preset)
    sequence_applied = False
    global_transform = get_global_transform(video_transform_preset)
    pan_limits = get_transform_pan_limits(video_transform_preset)
    max_zoom_scale = get_transform_max_zoom(video_transform_preset)
    scene_focus_plan = scene_focus_plan if isinstance(scene_focus_plan, list) else []
    if sequence_steps and video_track:
        video_segments = [segment for segment in video_track.get("segments", []) if isinstance(segment, dict)]
        sequence_records = []
        source_duration_us = int((source_duration_sec or 0) * 1_000_000)
        for index, segment in enumerate(video_segments):
            raw_step = sequence_steps[index % len(sequence_steps)]
            scene_meta = scene_focus_plan[index] if index < len(scene_focus_plan) and isinstance(scene_focus_plan[index], dict) else {}
            step = apply_focus_to_transform_step(
                raw_step,
                scene_meta,
                index,
                pan_limit_x=pan_limits["x"],
                pan_limit_y=pan_limits["y"],
                max_zoom_scale=max_zoom_scale,
            )
            transform_override = scene_meta.get("video_transform_override") if isinstance(scene_meta.get("video_transform_override"), dict) else {}
            if transform_override:
                step = dict(step)
                override_scale = safe_float(transform_override.get("zoom_scale", transform_override.get("scale")), safe_float(step.get("zoom_scale"), 1.0))
                step["zoom_scale"] = min(max_zoom_scale, max(1.0, override_scale))
                step["scale"] = step["zoom_scale"]
                step["pan_x"] = min(pan_limits["x"], max(-pan_limits["x"], safe_float(transform_override.get("pan_x"), safe_float(step.get("pan_x"), 0.0))))
                step["pan_y"] = min(pan_limits["y"], max(-pan_limits["y"], safe_float(transform_override.get("pan_y"), safe_float(step.get("pan_y"), 0.0))))
                step["rotation"] = min(3.0, max(-3.0, safe_float(transform_override.get("rotation"), safe_float(step.get("rotation"), 0.0))))
                step["speed"] = min(1.55, max(0.65, safe_float(transform_override.get("speed"), safe_float(step.get("speed"), 1.0))))
                step["mirror"] = coerce_bool(transform_override.get("mirror"), global_transform["mirror"])
                step["label"] = str(transform_override.get("label") or step.get("label") or "transform_override")
                step["transform_override_applied"] = True
            step_clip = segment.setdefault("clip", {})
            if not isinstance(step_clip.get("scale"), dict):
                step_clip["scale"] = {"x": 1.0, "y": 1.0}
            if not isinstance(step_clip.get("flip"), dict):
                step_clip["flip"] = {"horizontal": False, "vertical": False}
            if not isinstance(step_clip.get("transform"), dict):
                step_clip["transform"] = {"x": 0.0, "y": 0.0}

            zoom_scale = min(max_zoom_scale, max(1.0, safe_float(step.get("zoom_scale"), 1.0)))
            speed_value = max(0.1, safe_float(step.get("speed"), 1.0))
            pan_x = min(pan_limits["x"], max(-pan_limits["x"], safe_float(step.get("pan_x"), 0.0)))
            pan_y = min(pan_limits["y"], max(-pan_limits["y"], safe_float(step.get("pan_y"), 0.0)))
            rotation = min(3.0, max(-3.0, safe_float(step.get("rotation"), 0.0)))
            target_timerange = segment.get("target_timerange") or {}
            source_timerange = segment.get("source_timerange") or {}
            target_start_us = int(target_timerange.get("start") or 0)
            target_duration_us = int(target_timerange.get("duration") or 0)
            source_start_us = int(source_timerange.get("start") or 0)
            source_duration_us_for_record = int(source_timerange.get("duration") or 0)

            step_clip["scale"]["x"] = zoom_scale
            step_clip["scale"]["y"] = zoom_scale
            step_clip["transform"]["x"] = pan_x
            step_clip["transform"]["y"] = pan_y
            step_clip["rotation"] = rotation
            step_mirror = coerce_bool(step.get("mirror"), global_transform["mirror"])
            step_clip["flip"]["horizontal"] = step_mirror
            segment["uniform_scale"] = {"on": True, "value": zoom_scale}

            speed_applied = False
            if abs(speed_value - 1.0) > 0.001 and target_duration_us > 0:
                required_source_us = int(target_duration_us * speed_value)
                current_source = segment.setdefault("source_timerange", {})
                current_start_us = int(current_source.get("start") or 0)
                if source_duration_us <= 0 or current_start_us + required_source_us <= source_duration_us:
                    segment["speed"] = speed_value
                    current_source["duration"] = required_source_us
                    speed_applied = True
                    source_duration_us_for_record = required_source_us

            sequence_records.append(
                {
                    "segment_index": index,
                    "label": step.get("label"),
                    "timeline_start_sec": round(target_start_us / 1_000_000, 3),
                    "timeline_end_sec": round((target_start_us + target_duration_us) / 1_000_000, 3),
                    "source_start_sec": round(source_start_us / 1_000_000, 3),
                    "source_end_sec": round((source_start_us + source_duration_us_for_record) / 1_000_000, 3),
                    "zoom_scale": zoom_scale,
                    "scale": zoom_scale,
                    "pan_x": pan_x,
                    "pan_y": pan_y,
                    "rotation": rotation,
                    "mirror": step_mirror,
                    "speed": speed_value,
                    "speed_applied": speed_applied,
                    "transform_override_applied": bool(step.get("transform_override_applied")),
                    "is_preroll_hook": bool(scene_meta.get("is_preroll_hook")),
                    "focus_applied": bool(step.get("focus_applied")),
                    "focus_zone": step.get("focus_zone", ""),
                    "focus_target": step.get("focus_target", ""),
                    "recommended_camera_move": step.get("recommended_camera_move", ""),
                    "motion_intensity": step.get("motion_intensity", ""),
                    "scene_id": step.get("scene_id", ""),
                }
            )

        if video_segments:
            sequence_applied = True
            applied["sequence"] = {
                "requested": True,
                "applied": True,
                "interval_sec": safe_float(video_transform_preset.get("interval_sec"), 3.0),
                "segment_unit_sec": safe_float(video_transform_preset.get("segment_unit_sec", video_transform_preset.get("interval_sec")), 3.0),
                "steps_count": len(sequence_steps),
                "segments_count": len(video_segments),
                "process_order": video_transform_preset.get("process_order") or [],
                "segments": sequence_records,
            }
            applied["zoom"]["requested"] = any(record["zoom_scale"] > 1.0001 for record in sequence_records)
            applied["zoom"]["applied"] = applied["zoom"]["requested"]
            applied["zoom"]["value"] = [record["zoom_scale"] for record in sequence_records]
            applied["mirror"]["requested"] = global_transform["mirror"]
            applied["mirror"]["applied"] = global_transform["mirror"] or any(record.get("mirror") for record in sequence_records)
            applied["mirror"]["policy"] = global_transform["mirror_policy"]
            applied["speed"]["requested"] = any(abs(record["speed"] - 1.0) > 0.001 for record in sequence_records)
            applied["speed"]["applied"] = any(record["speed_applied"] for record in sequence_records)
            applied["speed"]["value"] = [record["speed"] for record in sequence_records]
            applied["distortion"]["requested"] = any(abs(record["rotation"]) > 0.001 for record in sequence_records)
            applied["distortion"]["applied"] = applied["distortion"]["requested"]
            applied["distortion"]["type"] = "micro_rotation"
            applied["distortion"]["value"] = [record["rotation"] for record in sequence_records]

    if not sequence_applied:
        zoom_scale = get_process_zoom_scale(video_transform_preset)
        applied["zoom"]["requested"] = zoom_scale > 1.0001
        applied["zoom"]["value"] = zoom_scale
        if applied["zoom"]["requested"]:
            clip["scale"]["x"] = zoom_scale
            clip["scale"]["y"] = zoom_scale
            video_segment["uniform_scale"] = {"on": True, "value": zoom_scale}
            applied["zoom"]["applied"] = True
        else:
            applied["zoom"]["reason"] = "zoom not requested"

    crop_mode = get_process_crop_mode(video_transform_preset)
    applied["crop"]["requested"] = bool(crop_mode)
    applied["crop"]["mode"] = crop_mode
    if applied["crop"]["requested"]:
        material_width = safe_float((video_material or {}).get("width"), 0)
        material_height = safe_float((video_material or {}).get("height"), 0)
        if crop_mode == "vertical_fill" and is_nine_sixteen(material_width, material_height) and is_nine_sixteen(draft_width, draft_height):
            applied["crop"]["applied"] = False
            applied["crop"]["reason"] = "source already matches 9:16 draft; no crop needed"
        elif video_material is not None:
            video_material["crop_ratio"] = "free"
            video_material["crop_scale"] = 1.0
            video_material["crop"] = {
                "upper_left_x": 0.0,
                "upper_left_y": 0.0,
                "upper_right_x": 1.0,
                "upper_right_y": 0.0,
                "lower_left_x": 0.0,
                "lower_left_y": 1.0,
                "lower_right_x": 1.0,
                "lower_right_y": 1.0,
            }
            applied["crop"]["applied"] = True
        else:
            applied["crop"]["reason"] = "video material not found"
    else:
        applied["crop"]["reason"] = "crop not requested"

    if not sequence_applied:
        mirror_requested = coerce_bool(video_transform_preset.get("mirror"), False)
        applied["mirror"]["requested"] = mirror_requested
        if mirror_requested:
            clip["flip"]["horizontal"] = True
            applied["mirror"]["applied"] = True
        else:
            applied["mirror"]["reason"] = "mirror not requested"

        speed_value = get_process_speed_value(video_transform_preset)
        applied["speed"]["requested"] = abs(speed_value - 1.0) > 0.001
        applied["speed"]["value"] = speed_value
        if applied["speed"]["requested"]:
            target_duration_us = int((video_segment.get("target_timerange") or {}).get("duration") or 0)
            source_duration_us = int((source_duration_sec or 0) * 1_000_000)
            required_source_us = int(target_duration_us * speed_value)
            if target_duration_us > 0 and source_duration_us >= required_source_us:
                video_segment["speed"] = speed_value
                source_timerange = video_segment.setdefault("source_timerange", {})
                source_timerange["duration"] = required_source_us
                applied["speed"]["applied"] = True
            else:
                applied["speed"]["reason"] = "source duration is too short to apply speed while preserving target timeline"
        else:
            applied["speed"]["reason"] = "speed not requested"

    color_adjustment = video_transform_preset.get("color_adjustment")
    color_requested = False
    if isinstance(color_adjustment, dict):
        color_requested = coerce_bool(color_adjustment.get("enabled"), False)
        applied["color_adjustment"]["style"] = color_adjustment.get("style", "")
    else:
        color_requested = bool(color_adjustment)
        applied["color_adjustment"]["style"] = str(color_adjustment or "")
    applied["color_adjustment"]["requested"] = color_requested or bool(video_transform_preset.get("sharpen"))
    if applied["color_adjustment"]["requested"]:
        target_segments = [segment for segment in (video_track.get("segments") or []) if isinstance(segment, dict)]
        for segment in target_segments:
            segment["enable_adjust"] = True
            segment["enable_smart_color_adjust"] = True
            segment["enable_color_correct_adjust"] = True
            segment["enable_color_curves"] = True
            segment["enable_hsl"] = True
            segment["enable_hsl_curves"] = True
            segment["enable_color_wheels"] = True
            segment["hdr_settings"] = {"mode": 1, "intensity": 1.0, "nits": 1000}
        applied["color_adjustment"]["applied"] = bool(target_segments)
        applied["color_adjustment"]["flags"] = [
            "enable_adjust",
            "enable_smart_color_adjust",
            "enable_color_correct_adjust",
            "enable_color_curves",
            "enable_hsl",
            "hdr_settings",
        ]
        applied["color_adjustment"]["reason"] = "safe CapCut segment color flags applied; LUT/sharpen curve mapping still needs manual confirmation"
    else:
        applied["color_adjustment"]["reason"] = "color adjustment not requested"

    with open(draft_content_path, "w", encoding="utf-8") as file:
        json.dump(draft_content, file, ensure_ascii=False, indent=4)

    return applied


def sync_full_caption_segments_to_video_timeline(draft_content_path, explainer_blocks):
    """Keep full-draft captions locked to edited video cuts, allowing multiple captions per cut."""
    summary = {
        "enabled": False,
        "applied": False,
        "reason": "not full caption mode",
        "video_segments_count": 0,
        "caption_segments_count": 0,
        "synced_count": 0,
        "caption_unit_mode": "cut",
        "position": {"x": FULL_CUT_CAPTION_X, "y": FULL_CUT_CAPTION_Y},
        "timeline_source": "source_video.target_timerange",
        "animation_policy": "full cut captions use pop_in at 10 percent of each caption duration",
        "animation_adjustments": [],
        "synced_explainer_blocks": [],
        "safe_char_limits": {
            "ja": FULL_CUT_CAPTION_SAFE_MAX_CHARS_JA,
            "ko": FULL_CUT_CAPTION_SAFE_MAX_CHARS_KO,
        },
        "caption_length_clamps": [],
    }
    blocks = explainer_blocks if isinstance(explainer_blocks, list) else []
    is_full_caption_mode = any(
        str(block.get("style_profile") or block.get("styleProfile") or "").strip() == "full_cut_caption"
        for block in blocks
        if isinstance(block, dict)
    )
    if not is_full_caption_mode:
        return summary
    summary["enabled"] = True

    if not draft_content_path or not os.path.exists(draft_content_path):
        summary["reason"] = "draft_content.json not found"
        return summary

    with open(draft_content_path, "r", encoding="utf-8-sig") as file:
        draft_content = json.load(file)

    video_track = None
    text_track = None
    for track in draft_content.get("tracks", []):
        if not isinstance(track, dict):
            continue
        if track.get("type") == "video" and track.get("name") == "source_video":
            video_track = track
        if track.get("type") == "text" and track.get("name") == "process_explainer":
            text_track = track

    if not video_track or not text_track:
        summary["reason"] = "source_video or process_explainer track not found"
        return summary

    video_segments = [
        segment for segment in (video_track.get("segments") or [])
        if isinstance(segment, dict) and isinstance(segment.get("target_timerange"), dict)
    ]
    caption_segments = [
        segment for segment in (text_track.get("segments") or [])
        if isinstance(segment, dict)
    ]
    video_segments.sort(key=lambda item: int((item.get("target_timerange") or {}).get("start") or 0))
    caption_segments.sort(key=lambda item: int((item.get("target_timerange") or {}).get("start") or 0))
    summary["video_segments_count"] = len(video_segments)
    summary["caption_segments_count"] = len(caption_segments)

    if not video_segments or not caption_segments:
        summary["reason"] = "no video or caption segments to sync"
        return summary

    material_index = build_material_index_by_id(draft_content)
    source_to_target_id_map = {}

    def find_generated_material(material_id):
        if not material_id:
            return None
        for category_items in (draft_content.get("materials") or {}).values():
            if not isinstance(category_items, list):
                continue
            for item in category_items:
                if isinstance(item, dict) and item.get("id") == material_id:
                    return item
        return None

    def block_text_for_index(index):
        if blocks:
            if index < len(blocks) and isinstance(blocks[index], dict):
                text_value = blocks[index].get("text") or blocks[index].get("caption_text") or blocks[index].get("visual_summary")
                if isinstance(text_value, str) and text_value.strip():
                    return text_value.strip()
            for block in reversed(blocks):
                if isinstance(block, dict):
                    text_value = block.get("text") or block.get("caption_text") or block.get("visual_summary")
                    if isinstance(text_value, str) and text_value.strip():
                        return text_value.strip()
        if caption_segments:
            material = find_generated_material(caption_segments[-1].get("material_id"))
            text_value = get_material_text_value(material)
            if text_value:
                return text_value
        return '자막을 다시 확인하세요.'

    def clone_caption_segment_for_caption_index(base_caption, index, text_value=None):
        cloned = json.loads(json.dumps(base_caption))
        cloned["id"] = new_capcut_id()
        cloned["render_index"] = int(base_caption.get("render_index") or 14000) + index + 1
        cloned["track_render_index"] = base_caption.get("track_render_index", 2)
        cloned["visible"] = True
        material_id = cloned.get("material_id")
        material_entry = material_index.get(material_id)
        if material_entry:
            category, item = material_entry
            cloned_material = json.loads(json.dumps(item))
            new_material_id = new_capcut_id()
            cloned_material["id"] = new_material_id
            set_material_text_value(cloned_material, text_value or block_text_for_index(index))
            ensure_material_category(draft_content, category).append(cloned_material)
            material_index[new_material_id] = (category, cloned_material)
            cloned["material_id"] = new_material_id
        cloned["extra_material_refs"] = list(base_caption.get("extra_material_refs") or [])
        return cloned

    def make_block_groups():
        groups = [[] for _ in video_segments]
        has_scene_index = False
        for block_index, block in enumerate(blocks):
            if not isinstance(block, dict):
                continue
            block_start_sec = safe_float(block.get("start_sec"), None)
            block_end_sec = safe_float(block.get("end_sec"), None)
            if block_start_sec is not None and block_end_sec is not None and block_end_sec > block_start_sec:
                matched_by_time = False
                for video_index, video_segment in enumerate(video_segments):
                    source_range = video_segment.get("source_timerange") or {}
                    source_start_sec = safe_float(source_range.get("start"), 0.0) / 1_000_000
                    source_duration_sec = safe_float(source_range.get("duration"), 0.0) / 1_000_000
                    source_end_sec = source_start_sec + max(0.0, source_duration_sec)
                    overlap_sec = min(block_end_sec, source_end_sec) - max(block_start_sec, source_start_sec)
                    if overlap_sec > 0.03:
                        groups[video_index].append(block)
                        matched_by_time = True
                if matched_by_time:
                    has_scene_index = True
                    continue
            raw_index = block.get("source_scene_index")
            if raw_index is None:
                raw_index = block.get("scene_index")
            try:
                scene_index = int(raw_index)
            except (TypeError, ValueError):
                scene_index = None
            if scene_index is not None and 0 <= scene_index < len(video_segments):
                groups[scene_index].append(block)
                has_scene_index = True
            elif block_index < len(video_segments):
                groups[block_index].append(block)
        return groups if has_scene_index else None

    def is_full_narrative_block(block):
        if not isinstance(block, dict):
            return False
        mode = str(block.get("caption_unit_mode") or "").strip().lower()
        return "full_narrative" in mode or coerce_bool(block.get("is_preroll_hook"), False)

    def is_metadata_onscreen_subtitle_block(block):
        if not isinstance(block, dict):
            return False
        mode = str(block.get("caption_unit_mode") or "").strip().lower()
        return mode.startswith("metadata_onscreen_subtitle")

    def is_gemini_screen_caption_block(block):
        if not isinstance(block, dict):
            return False
        mode = str(block.get("caption_unit_mode") or "").strip().lower()
        return (
            mode.startswith("gemini_screen_caption")
            or mode.startswith("japanese_full_technical_script")
            or mode.startswith("korean_full_technical_script")
        )

    is_narrative_timeline_mode = any(is_full_narrative_block(block) for block in blocks)
    narrative_blocks = [
        dict(block)
        for block in blocks
        if isinstance(block, dict) and (is_full_narrative_block(block) or str(block.get("style_profile") or "") == "full_cut_caption")
    ]
    narrative_blocks.sort(key=lambda item: safe_float(item.get("start_sec"), 0.0))

    block_groups = None if is_narrative_timeline_mode else make_block_groups()
    def split_narrative_blocks_to_screen_units(block_list):
        expanded = []
        for block in block_list or []:
            block = dict(block) if isinstance(block, dict) else {"text": str(block or "")}
            language = block_language(block)
            text_value = str(block.get("text") or block.get("caption_text") or block.get("visual_summary") or "").strip()
            max_chars = full_caption_safe_max_chars(language)
            units = split_text_to_screen_units(text_value, max_chars, language) or ([text_value] if text_value else [])
            if len(units) <= 1:
                block["text"] = clean_caption_unit_text(units[0] if units else text_value, language)
                block["caption_part_index"] = 0
                block["caption_parts_count"] = 1
                block["output_language"] = language
                block["language"] = language
                expanded.append(block)
                continue

            start_sec = safe_float(block.get("start_sec"), None)
            end_sec = safe_float(block.get("end_sec"), None)
            has_valid_time = start_sec is not None and end_sec is not None and end_sec > start_sec
            duration_sec = (end_sec - start_sec) if has_valid_time else 0
            for unit_index, unit in enumerate(units):
                next_block = dict(block)
                next_block["text"] = clean_caption_unit_text(unit, language)
                next_block["block_id"] = f"{block.get('block_id') or 'caption'}_screen_{unit_index + 1:02d}"
                next_block["caption_unit_mode"] = "screen_phrase_ko" if language == "ko" else "screen_phrase_ja"
                next_block["caption_part_index"] = unit_index
                next_block["caption_parts_count"] = len(units)
                next_block["output_language"] = language
                next_block["language"] = language
                if has_valid_time:
                    next_start = start_sec + duration_sec * unit_index / len(units)
                    next_end = start_sec + duration_sec * (unit_index + 1) / len(units)
                    next_block["start_sec"] = round(next_start, 3)
                    next_block["end_sec"] = round(next_end, 3)
                expanded.append(next_block)
        return expanded or block_list

    if is_narrative_timeline_mode:
        target_caption_count = max(1, len(narrative_blocks))
        summary["caption_unit_mode"] = "full_narrative_timeline"
        summary["timeline_source"] = "explainer_blocks.start_sec/end_sec"
    elif block_groups is not None:
        target_caption_count = sum(len(group) if group else 1 for group in block_groups)
        summary["caption_unit_mode"] = "phrase_within_cut"
    else:
        target_caption_count = len(video_segments)

    if target_caption_count > len(caption_segments) and caption_segments:
        base_caption = caption_segments[-1]
        original_caption_count = len(caption_segments)
        for index in range(original_caption_count, target_caption_count):
            caption_segments.append(clone_caption_segment_for_caption_index(base_caption, index))
        text_track["segments"] = caption_segments
        summary["caption_segments_count"] = len(caption_segments)

    def clone_caption_refs_for_duration(ref_ids, caption_duration_us):
        next_refs = []
        adjustments = []
        remove_animation = caption_duration_us < 180_000
        target_animation_us = int(
            min(
                max(FULL_CUT_CAPTION_MIN_ANIMATION_US, caption_duration_us * FULL_CUT_CAPTION_ANIMATION_RATIO),
                max(FULL_CUT_CAPTION_MIN_ANIMATION_US, caption_duration_us - 1),
            )
        )
        for ref_id in ref_ids or []:
            if not isinstance(ref_id, str) or not ref_id:
                continue
            entry = material_index.get(ref_id)
            if entry is None:
                next_refs.append(ref_id)
                continue
            category, item = entry
            is_animation = category == "material_animations" or isinstance(item.get("animations"), list)
            if is_animation and remove_animation:
                adjustments.append({
                    "source_ref": ref_id,
                    "action": "removed",
                    "reason": "caption shorter than minimum animation-safe duration",
                    "caption_duration_sec": round(caption_duration_us / 1_000_000, 3),
                })
                continue
            cloned_item = json.loads(json.dumps(item))
            old_id = cloned_item.get("id")
            new_id = new_capcut_id()
            cloned_item["id"] = new_id
            if is_animation:
                for animation in cloned_item.get("animations") or []:
                    if isinstance(animation, dict):
                        original_duration = int(animation.get("duration") or 0)
                        animation["start"] = 0
                        animation["duration"] = target_animation_us
                        adjustments.append({
                            "source_ref": ref_id,
                            "new_ref": new_id,
                            "action": "scaled",
                            "original_duration_sec": round(original_duration / 1_000_000, 3),
                            "new_duration_sec": round(target_animation_us / 1_000_000, 3),
                            "caption_duration_sec": round(caption_duration_us / 1_000_000, 3),
                        })
            ensure_material_category(draft_content, category).append(cloned_item)
            material_index[new_id] = (category, cloned_item)
            if old_id:
                source_to_target_id_map[f"{old_id}:{new_id}"] = new_id
            next_refs.append(new_id)
        return next_refs, adjustments

    synced_blocks = []
    sync_count = 0
    safe_x = summary["position"]["x"]
    safe_y = summary["position"]["y"]
    caption_cursor = 0
    min_caption_duration_us = FULL_CUT_CAPTION_MIN_DISPLAY_US

    def ensure_caption_segment_capacity(index, text_value=None):
        if not caption_segments:
            return False
        base_caption = caption_segments[-1]
        while len(caption_segments) <= index:
            caption_segments.append(
                clone_caption_segment_for_caption_index(base_caption, len(caption_segments), text_value)
            )
        text_track["segments"] = caption_segments
        summary["caption_segments_count"] = len(caption_segments)
        return True

    def text_has_korean(value):
        return bool(re.search(r"[\uac00-\ud7a3]", str(value or "")))

    def text_has_japanese(value):
        return bool(re.search(r"[\u3040-\u30ff\u4e00-\u9fff]", str(value or "")))

    def block_language(block):
        if isinstance(block, dict):
            explicit = str(block.get("output_language") or block.get("language") or "").strip().lower()
            if explicit.startswith("ko") or explicit.startswith("kr"):
                return "ko"
            if explicit.startswith("ja") or explicit.startswith("jp"):
                return "ja"
            text = str(block.get("text") or block.get("caption_text") or block.get("visual_summary") or block.get("full_scene_caption_text") or "")
        else:
            text = str(block or "")
        if text_has_korean(text):
            return "ko"
        return "ja"

    def full_caption_safe_max_chars(language):
        return FULL_CUT_CAPTION_SAFE_MAX_CHARS_KO if language == "ko" else FULL_CUT_CAPTION_SAFE_MAX_CHARS_JA

    def group_language(group):
        for item in group or []:
            language = block_language(item)
            if language:
                return language
        return "ja"

    def join_caption_text(left, right, language):
        left = str(left or "").strip()
        right = str(right or "").strip()
        if not left:
            return right
        if not right:
            return left
        return f"{left} {right}" if language == "ko" else f"{left}{right}"

    def clean_caption_unit_text(value, language="ja"):
        text = str(value or "").strip()
        text = re.sub(r"^[（(]\s*\d{1,2}:\d{2}\s*(頃|경)?\s*[）)]\s*", "", text)
        text = re.sub(r"^[。！？、,.!?\s]+", "", text)
        text = re.sub(r"[。！？、,.!?\s]+$", "", text)
        text = re.sub(r"\s+", " " if language == "ko" else "", text).strip()
        return text

    def visible_caption_length(value):
        return len(str(value or "").replace(" ", ""))

    def is_weak_caption_fragment(value, language):
        text = clean_caption_unit_text(value, language)
        length = visible_caption_length(text)
        if not text:
            return True
        if language == "ko":
            return length <= 3 or text in {"아름다", "고르게", "꼼꼼히", "강도와", "줄눈에"}
        if length <= 2:
            return True
        if re.match(r"^(.{1,2})\1+$", text):
            return True
        return text in {"す", "し", "し、", "ます", "です", "か", "部", "み"} or text.startswith(("し、", "す"))

    def sanitize_screen_units(units, language, max_chars):
        cleaned = []
        for raw_unit in units or []:
            unit = clean_caption_unit_text(raw_unit, language)
            if not unit:
                continue
            if is_weak_caption_fragment(unit, language):
                if cleaned:
                    joined = join_caption_text(cleaned[-1], unit, language)
                    if visible_caption_length(joined) <= max_chars + 1:
                        cleaned[-1] = compact_caption_text(joined, max_chars, language)
                continue
            if visible_caption_length(unit) > max_chars:
                unit = compact_caption_text(unit, max_chars, language)
            if not unit or is_weak_caption_fragment(unit, language):
                continue
            if cleaned and cleaned[-1] == unit:
                continue
            cleaned.append(unit)
        return cleaned

    def repair_short_caption_fragments(items, language, max_chars):
        repaired = []
        index = 0
        while index < len(items):
            block = dict(items[index])
            text = str(block.get("text") or "")
            next_block = dict(items[index + 1]) if index + 1 < len(items) else None
            prev_block = repaired[-1] if repaired else None
            if next_block and is_weak_caption_fragment(text, language):
                combined = join_caption_text(text, next_block.get("text"), language)
                if visible_caption_length(combined) <= max_chars:
                    block["text"] = combined
                    block["caption_unit_mode"] = "short_fragment_repaired"
                    block["merged_caption_parts"] = [block.get("block_id"), next_block.get("block_id")]
                    repaired.append(block)
                    index += 2
                    continue
            if prev_block and is_weak_caption_fragment(text, language):
                combined = join_caption_text(prev_block.get("text"), text, language)
                if visible_caption_length(combined) <= max_chars:
                    prev_block["text"] = combined
                    prev_block["caption_unit_mode"] = "short_fragment_repaired"
                    prev_block.setdefault("merged_caption_parts", []).append(block.get("block_id"))
                    index += 1
                    continue
            if is_weak_caption_fragment(text, language):
                index += 1
                continue
            repaired.append(block)
            index += 1
        return repaired

    def dedupe_caption_group(group):
        next_group = []
        seen = set()
        for item in group or []:
            block = dict(item) if isinstance(item, dict) else {"text": str(item or "")}
            language = block_language(block)
            text = clean_caption_unit_text(block.get("text") or block.get("caption_text") or block.get("visual_summary") or "", language)
            if not text:
                continue
            key = (language, text)
            if key in seen:
                continue
            seen.add(key)
            block["text"] = text
            block["output_language"] = language
            block["language"] = language
            next_group.append(block)
        return next_group

    def merge_caption_group_for_readability(group, video_duration_us):
        if not isinstance(group, list) or not group:
            return group
        language = group_language(group)
        max_parts = max(1, int(video_duration_us // min_caption_duration_us))
        if len(group) <= max_parts:
            return group
        merged = [dict(item) if isinstance(item, dict) else {"text": str(item or "")} for item in group]
        while len(merged) > max_parts:
            best_index = 0
            best_length = None
            for index in range(len(merged) - 1):
                left = str(merged[index].get("text") or "")
                right = str(merged[index + 1].get("text") or "")
                length = len(left) + len(right)
                if best_length is None or length < best_length:
                    best_length = length
                    best_index = index
            left = merged[best_index]
            right = merged[best_index + 1]
            combined = dict(left)
            combined["text"] = join_caption_text(left.get("text"), right.get("text"), language)
            combined["block_id"] = str(left.get("block_id") or f"caption_{best_index + 1:03d}")
            combined["merged_caption_parts"] = [
                left.get("block_id"),
                right.get("block_id"),
            ]
            combined["caption_unit_mode"] = "phrase_merged_for_readability"
            merged[best_index:best_index + 2] = [combined]
        total_parts = len(merged)
        for index, item in enumerate(merged):
            item["caption_part_index"] = index
            item["caption_parts_count"] = total_parts
        return merged

    def is_timeline_instruction_text(value):
        text = str(value or "").strip()
        if not text:
            return True
        return bool(re.match(r"^\(?\s*(약|約)?\s*\d+\s*%\s*(지점|地点|時点)?\s*\)?$", text))

    def fit_narrative_blocks_to_timeline(group, video_duration_us):
        if not isinstance(group, list):
            return []
        before_count = len(group)
        cleaned = []
        for item in group:
            block = dict(item) if isinstance(item, dict) else {"text": str(item or "")}
            language = block_language(block)
            text = clean_caption_unit_text(
                block.get("text") or block.get("caption_text") or block.get("visual_summary") or "",
                language,
            )
            if is_timeline_instruction_text(text):
                continue
            block["text"] = text
            block["output_language"] = language
            block["language"] = language
            cleaned.append(block)
        if not cleaned:
            return []

        cleaned = dedupe_caption_group(cleaned)
        if not cleaned:
            return []

        language = group_language(cleaned)
        max_chars = full_caption_safe_max_chars(language)
        cleaned = repair_short_caption_fragments(cleaned, language, max_chars)
        if not cleaned:
            return []
        max_parts = max(1, int(video_duration_us // min_caption_duration_us))
        if len(cleaned) <= max_parts:
            return cleaned

        merged = []
        current = None
        for block in cleaned:
            if current is None:
                current = dict(block)
                continue
            combined = join_caption_text(current.get("text"), block.get("text"), language)
            if visible_caption_length(combined) <= max_chars:
                current["text"] = combined
                current["caption_unit_mode"] = "merged_for_min_display_time"
                current["merged_caption_parts"] = [
                    current.get("block_id"),
                    block.get("block_id"),
                ]
            else:
                merged.append(current)
                current = dict(block)
        if current is not None:
            merged.append(current)

        merged = repair_short_caption_fragments(merged, language, max_chars)
        selected = merged
        if len(merged) > max_parts:
            selected = []
            if max_parts == 1:
                selected = [merged[0]]
            else:
                bucket_size = len(merged) / max_parts
                for index in range(max_parts):
                    start = int(round(index * bucket_size))
                    end = int(round((index + 1) * bucket_size))
                    bucket = merged[start:max(end, start + 1)] or merged[start:start + 1]
                    preferred = next(
                        (
                            item for item in bucket
                            if not is_weak_caption_fragment(item.get("text"), language)
                        ),
                        bucket[0],
                    )
                    selected.append(preferred)

        fitted = []
        for index, block in enumerate(selected):
            next_block = dict(block)
            # Redistribute fitted captions evenly over the edited timeline.
            # Keeping the original script timestamps after heavy reduction leaves
            # gaps or sub-0.2s flashes in very short full drafts.
            next_block.pop("start_sec", None)
            next_block.pop("end_sec", None)
            next_block["caption_part_index"] = index
            next_block["caption_parts_count"] = len(selected)
            next_block["caption_fit_mode"] = "min_display_time"
            fitted.append(next_block)

        if len(fitted) != before_count:
            summary.setdefault("timeline_caption_fit", []).append({
                "before": before_count,
                "after": len(fitted),
                "timeline_duration_sec": round(video_duration_us / 1_000_000, 3),
                "min_display_sec": round(min_caption_duration_us / 1_000_000, 3),
                "max_parts": max_parts,
                "language": language,
            })
        return fitted

    def compact_caption_text(value, max_chars=10, language="ja"):
        text = clean_caption_unit_text(value, language)
        text = re.sub(r"\s+", " " if language == "ko" else "", text).strip()
        if not text:
            return ""
        if len(text) <= max_chars:
            return text
        if language == "ko":
            cut = -1
            for marker in (" ", "에서", "으로", "하고", "하며", "되는", "보여", "과정"):
                idx = text.rfind(marker, 0, max_chars + 1)
                if idx >= 4:
                    cut = idx + (0 if marker == " " else len(marker))
            if cut >= 4:
                return text[:cut].strip()
        else:
            for marker in ("、", "で", "が", "を", "に", "へ", "と", "の", "は", "ます"):
                idx = text.rfind(marker, 0, max_chars + 1)
                if idx >= 3:
                    return text[:idx + len(marker)].strip()
        return text[:max(4, max_chars)].strip()

    def split_text_to_screen_units(value, max_chars=10, language="ja"):
        text = clean_caption_unit_text(value, language)
        if not text:
            return []
        if len(text) <= max_chars:
            return [text]
        markers = (
            ["습니다", "합니다", "됩니다", "입니다", "어요", "아요", "고", "며", "서", "을 ", "를 ", "이 ", "가 ", "은 ", "는 ", "에 ", "로 ", " "]
            if language == "ko"
            else ["ます", "です", "ました", "ています", "して", "から", "まで", "へ", "に", "で", "を", "が", "は", "と"]
        )
        units = []
        cursor = 0
        while cursor < len(text):
            remaining = len(text) - cursor
            if remaining <= max_chars:
                tail = text[cursor:].strip()
                if tail:
                    units.append(tail)
                break
            window_end = min(len(text), cursor + max_chars)
            window_text = text[cursor:window_end]
            cut = window_end
            for marker in markers:
                idx = window_text.rfind(marker)
                if idx >= 3:
                    cut = cursor + idx + len(marker)
                    break
            if cut <= cursor:
                cut = window_end
            units.append(text[cursor:cut].strip())
            cursor = cut
        final_units = []
        for unit in units:
            if len(unit) <= max_chars:
                final_units.append(unit)
                continue
            for index in range(0, len(unit), max_chars):
                part = unit[index:index + max_chars].strip()
                if part:
                    final_units.append(part)
        if final_units:
            return sanitize_screen_units(final_units, language, max_chars)
        if language == "ko":
            words = text.split()
            if words:
                units = []
                current = ""
                for word in words:
                    candidate = f"{current} {word}".strip()
                    if current and len(candidate) > max_chars:
                        units.append(current)
                        current = word
                    else:
                        current = candidate
                if current:
                    units.append(current)
                return sanitize_screen_units(units, language, max_chars)

            # No spaces survived in the Korean text. Split around common endings
            # before falling back to fixed-width chunks.
            pieces = re.split(r"(?<=[다요죠까네군요습니다합니다])[,.!?]?", text)
            units = [piece.strip() for piece in pieces if piece.strip()]
            if len(units) > 1:
                return sanitize_screen_units(units, language, max_chars)

        separators = ("、", "。", "！", "？", "で", "が", "を", "に", "へ", "と", "の", "は", "ます")
        units = []
        cursor = 0
        while cursor < len(text):
            limit = min(len(text), cursor + max_chars)
            cut = limit
            window = text[cursor:limit]
            for marker in separators:
                idx = window.rfind(marker)
                if idx >= 3:
                    cut = cursor + idx + len(marker)
            if cut <= cursor:
                cut = limit
            units.append(text[cursor:cut].strip())
            cursor = cut
        return sanitize_screen_units(units, language, max_chars)

    def explode_group_to_screen_units(group):
        exploded = []
        for item in group or []:
            block = dict(item) if isinstance(item, dict) else {"text": str(item or "")}
            text = str(block.get("text") or block.get("caption_text") or block.get("visual_summary") or "").strip()
            language = block_language(block)
            max_chars = full_caption_safe_max_chars(language)
            units = split_text_to_screen_units(text, max_chars, language)
            if not units:
                continue
            for unit_index, unit in enumerate(units):
                next_block = dict(block)
                next_block["text"] = clean_caption_unit_text(unit, language)
                next_block["block_id"] = f"{block.get('block_id') or 'caption'}_unit_{unit_index + 1:02d}"
                next_block["caption_unit_mode"] = "screen_phrase_ko" if language == "ko" else "screen_phrase_ja"
                next_block["output_language"] = language
                next_block["language"] = language
                next_block["caption_part_index"] = unit_index
                next_block["caption_parts_count"] = len(units)
                exploded.append(next_block)
        return exploded

    def rhythm_caption_seeds_for_text(seed_text, language="ja"):
        raw = str(seed_text or "")
        lower = raw.lower()
        seeds = []

        def add(*items):
            for item in items:
                text = compact_caption_text(item, 14 if language == "ko" else 10, language)
                if text and text not in seeds:
                    seeds.append(text)

        if language == "ko":
            machine_terms = (
                "machine", "press", "cut", "mold", "shape", "forming", "grind", "mix", "rotate", "conveyor",
                "기계", "프레스", "절단", "성형", "분쇄", "혼합", "회전", "컨베이어", "가공", "자동"
            )
            hand_terms = ("hand", "hands", "worker", "craftsman", "artisan", "손", "장인", "작업자", "수작업")
            detail_terms = ("close", "detail", "macro", "접사", "세부", "클로즈업", "확대")
            if any(term in lower or term in raw for term in machine_terms):
                add("기계가 움직입니다", "소재가 변합니다", "가공이 진행됩니다", "리듬에 주목하세요")
            if any(term in lower or term in raw for term in hand_terms):
                add("작업자의 손길", "손으로 다듬습니다", "세밀한 마무리", "손동작에 주목")
            if any(term in lower or term in raw for term in detail_terms):
                add("가까이 보는 공정", "질감이 달라집니다", "세부가 보입니다")
            add("공정이 이어집니다", "다음 변화입니다", "소재의 움직임", "완성에 가까워집니다")
            return seeds

        machine_terms = (
            "machine", "press", "cut", "mold", "shape", "forming", "grind", "mix", "rotate", "conveyor",
            "機械", "プレス", "切断", "成形", "粉砕", "混合", "回転", "コンベア", "加工", "自動"
        )
        soap_terms = ("soap", "石鹸", "せっけん", "ソープ", "洗剤")
        hand_terms = ("hand", "hands", "worker", "craftsman", "artisan", "手", "職人", "作業員", "手作業", "人の手")
        detail_terms = ("close", "detail", "macro", "接写", "細部", "クローズアップ", "拡大")

        if any(term in lower or term in raw for term in machine_terms):
            add("機械が動く瞬間", "素材が形を変える", "加工が進む", "リズムに注目")
        if any(term in lower or term in raw for term in soap_terms):
            add("石鹸が形になる", "ピンクの素材が変化", "成形の瞬間", "仕上げに注目")
        if any(term in lower or term in raw for term in hand_terms):
            add("職人の手元", "手作業で整える", "細かな仕上げ", "手の動きに注目")
        if any(term in lower or term in raw for term in detail_terms):
            add("細部を見せる", "近くで見る工程", "質感が変わる")
        add("工程が進む", "次の変化に注目", "素材の動き", "仕上がりへ進む")
        return seeds

    def expand_caption_group_for_density(group, video_duration_us):
        if not isinstance(group, list):
            group = []
        group = [dict(item) if isinstance(item, dict) else {"text": str(item or "")} for item in group if item]
        language = group_language(group)
        # Full-draft cut captions should describe the actual cut. Do not invent
        # extra rhythm/filler captions, because they read like script noise and
        # can make Korean/Japanese drafts look machine-generated.
        if group:
            return group
        max_parts = max(1, int(video_duration_us // min_caption_duration_us))
        desired_parts = max(1, min(max_parts, int(math.ceil((video_duration_us / 1_000_000) / 1.05)), 5))
        if len(group) >= desired_parts:
            return group

        seed_text = " ".join(
            str(item.get("text") or item.get("caption_text") or item.get("visual_summary") or item.get("full_scene_caption_text") or "")
            for item in group
            if isinstance(item, dict)
        )
        seeds = rhythm_caption_seeds_for_text(seed_text, language)
        cursor = 0
        while len(group) < desired_parts and seeds:
            text = seeds[cursor % len(seeds)]
            cursor += 1
            if any(str(item.get("text") or "") == text for item in group) and cursor < len(seeds) * 2:
                continue
            source = dict(group[-1]) if group else {}
            source["block_id"] = f"{source.get('block_id') or 'caption'}_rhythm_{len(group) + 1:02d}"
            source["text"] = text
            source["caption_unit_mode"] = "timeline_rhythm_fill"
            source["output_language"] = language
            source["language"] = language
            group.append(source)
        while len(group) < desired_parts and group:
            source = dict(group[-1])
            source["block_id"] = f"{source.get('block_id') or 'caption'}_repeat_{len(group) + 1:02d}"
            source["caption_unit_mode"] = "timeline_rhythm_repeat"
            source["output_language"] = language
            source["language"] = language
            group.append(source)
        return group

    def apply_caption_to_timeline(caption, start_us, duration_us, text_value, source_block, caption_index):
        source_language = block_language(source_block)
        safe_max_chars = full_caption_safe_max_chars(source_language)
        raw_text_value = str(text_value or "")
        if len(raw_text_value) > safe_max_chars:
            text_value = compact_caption_text(raw_text_value, safe_max_chars, source_language)
            summary["caption_length_clamps"].append({
                "caption_index": caption_index,
                "language": source_language,
                "original_length": len(raw_text_value),
                "safe_max_chars": safe_max_chars,
                "original_text": raw_text_value,
                "clamped_text": text_value,
            })
        text_material = find_generated_material(caption.get("material_id"))
        if text_material is not None and text_value:
            set_material_text_value(text_material, text_value)
        caption["target_timerange"] = {"start": start_us, "duration": duration_us}
        # CapCut text segments use target_timerange for timeline placement, while
        # render_timerange should stay local to the text material. Setting render
        # start to the timeline start can leave the text box selectable but the
        # glyphs invisible in CapCut.
        caption["render_timerange"] = {"start": 0, "duration": duration_us}
        if isinstance(caption.get("source_timerange"), dict):
            caption["source_timerange"] = {"start": 0, "duration": duration_us}
        refs, animation_adjustments = clone_caption_refs_for_duration(caption.get("extra_material_refs") or [], duration_us)
        caption["extra_material_refs"] = refs
        for adjustment in animation_adjustments:
            adjustment["caption_index"] = caption_index
            adjustment["caption_start_sec"] = round(start_us / 1_000_000, 3)
            summary["animation_adjustments"].append(adjustment)
        clip = caption.setdefault("clip", {})
        if not isinstance(clip.get("transform"), dict):
            clip["transform"] = {}
        clip["transform"]["x"] = safe_x
        clip["transform"]["y"] = safe_y
        if not isinstance(clip.get("scale"), dict):
            clip["scale"] = {}
        clip["scale"]["x"] = min(max(safe_float(clip["scale"].get("x"), 1.0), 0.9), 1.0)
        clip["scale"]["y"] = min(max(safe_float(clip["scale"].get("y"), 1.0), 0.9), 1.0)

        block = dict(source_block) if isinstance(source_block, dict) else {}
        block["block_id"] = block.get("block_id") or f"caption_{caption_index + 1:03d}"
        block["text"] = block.get("text") or text_value
        block["start_sec"] = round(start_us / 1_000_000, 3)
        block["end_sec"] = round((start_us + duration_us) / 1_000_000, 3)
        block["style_profile"] = block.get("style_profile") or "full_cut_caption"
        synced_blocks.append(block)

    if is_narrative_timeline_mode:
        original_narrative_count = len(narrative_blocks)
        narrative_blocks = split_narrative_blocks_to_screen_units(narrative_blocks)
        if len(narrative_blocks) != original_narrative_count:
            summary["caption_unit_mode"] = "full_narrative_timeline_screen_units"
            summary["screen_unit_split"] = {
                "before": original_narrative_count,
                "after": len(narrative_blocks),
                "max_chars_ja": FULL_CUT_CAPTION_SAFE_MAX_CHARS_JA,
                "max_chars_ko": FULL_CUT_CAPTION_SAFE_MAX_CHARS_KO,
            }

    if is_narrative_timeline_mode:
        timeline_start_us = min(
            int((segment.get("target_timerange") or {}).get("start") or 0)
            for segment in video_segments
        )
        timeline_end_us = max(
            int((segment.get("target_timerange") or {}).get("start") or 0)
            + int((segment.get("target_timerange") or {}).get("duration") or 0)
            for segment in video_segments
        )
        total_timeline_us = max(1, timeline_end_us - timeline_start_us)
        max_block_end_sec = max(
            [safe_float(block.get("end_sec"), 0.0) for block in narrative_blocks if isinstance(block, dict)]
            or [total_timeline_us / 1_000_000]
        )
        if max_block_end_sec <= 0:
            max_block_end_sec = total_timeline_us / 1_000_000
        narrative_blocks = fit_narrative_blocks_to_timeline(narrative_blocks, total_timeline_us)
        if not narrative_blocks:
            narrative_blocks = [{
                "block_id": "caption_001",
                "text": block_text_for_index(0),
                "output_language": "ko" if any(text_has_korean(block_text_for_index(i)) for i in range(len(blocks))) else "ja",
                "language": "ko" if any(text_has_korean(block_text_for_index(i)) for i in range(len(blocks))) else "ja",
            }]
        part_count = max(1, len(narrative_blocks))
        for index, block in enumerate(narrative_blocks):
            text_value = str(block.get("text") or block.get("caption_text") or block.get("visual_summary") or "").strip()
            if not text_value:
                text_value = block_text_for_index(index)
            if index >= len(caption_segments) and not ensure_caption_segment_capacity(index, text_value):
                break

            block_start_sec = safe_float(block.get("start_sec"), None)
            block_end_sec = safe_float(block.get("end_sec"), None)
            if block_start_sec is None or block_end_sec is None or block_end_sec <= block_start_sec:
                block_start_us = timeline_start_us + int(round(total_timeline_us * index / part_count))
                block_end_us = timeline_start_us + int(round(total_timeline_us * (index + 1) / part_count))
            else:
                block_start_us = timeline_start_us + int(round(total_timeline_us * max(0.0, block_start_sec) / max_block_end_sec))
                block_end_us = timeline_start_us + int(round(total_timeline_us * max(0.0, block_end_sec) / max_block_end_sec))
            block_start_us = max(timeline_start_us, min(timeline_end_us - 1, block_start_us))
            block_end_us = max(block_start_us + 1, min(timeline_end_us, block_end_us))
            apply_caption_to_timeline(
                caption_segments[index],
                block_start_us,
                max(1, block_end_us - block_start_us),
                text_value,
                block,
                index,
            )
            sync_count += 1
    elif block_groups is not None:
        for video_index, video_segment in enumerate(video_segments):
            video_target = video_segment.get("target_timerange") or {}
            video_start_us = int(video_target.get("start") or 0)
            video_duration_us = max(1, int(video_target.get("duration") or 0))
            group = block_groups[video_index] if video_index < len(block_groups) else []
            if not group:
                group = [{
                    "block_id": f"caption_{video_index + 1:03d}",
                    "text": block_text_for_index(video_index),
                    "source_scene_index": video_index,
                    "caption_part_index": 0,
                    "caption_parts_count": 1,
                    "caption_unit_mode": "cut_fallback",
                }]
            group = explode_group_to_screen_units(group)
            group = dedupe_caption_group(group)
            group = expand_caption_group_for_density(group, video_duration_us)
            group = dedupe_caption_group(group)
            group = merge_caption_group_for_readability(group, video_duration_us)
            part_count = max(1, len(group))
            for part_index, block in enumerate(group):
                text_value = ""
                if isinstance(block, dict):
                    text_value = str(block.get("text") or block.get("caption_text") or block.get("visual_summary") or "").strip()
                if not text_value:
                    text_value = block_text_for_index(caption_cursor)
                if caption_cursor >= len(caption_segments) and not ensure_caption_segment_capacity(caption_cursor, text_value):
                    break
                part_start = video_start_us + int(round(video_duration_us * part_index / part_count))
                next_start = video_start_us + int(round(video_duration_us * (part_index + 1) / part_count))
                part_duration = max(1, next_start - part_start)
                apply_caption_to_timeline(caption_segments[caption_cursor], part_start, part_duration, text_value, block, caption_cursor)
                caption_cursor += 1
                sync_count += 1
    else:
        legacy_sync_count = min(len(video_segments), len(caption_segments))
        for index in range(legacy_sync_count):
            video_target = video_segments[index].get("target_timerange") or {}
            start_us = int(video_target.get("start") or 0)
            duration_us = max(1, int(video_target.get("duration") or 0))
            text_value = block_text_for_index(index)
            block = dict(blocks[index]) if index < len(blocks) and isinstance(blocks[index], dict) else {}
            if index >= len(caption_segments) and not ensure_caption_segment_capacity(index, text_value):
                break
            apply_caption_to_timeline(caption_segments[index], start_us, duration_us, text_value, block, index)
            sync_count += 1

    if len(caption_segments) > sync_count:
        text_track["segments"] = caption_segments[:sync_count]
        caption_segments = text_track["segments"]

    def is_orphan_generated_caption_track(track):
        if track is text_track:
            return False
        if not isinstance(track, dict) or track.get("type") != "text":
            return False
        segments = [segment for segment in (track.get("segments") or []) if isinstance(segment, dict)]
        if not segments:
            return False
        for segment in segments:
            try:
                render_index = int(segment.get("render_index") or 0)
            except (TypeError, ValueError):
                render_index = 0
            target = segment.get("target_timerange") or {}
            duration_us = safe_int(target.get("duration"), 0)
            material = find_generated_material(segment.get("material_id"))
            text_value = get_material_text_value(material)
            if render_index < 14000:
                return False
            if duration_us > 350_000:
                return False
            if not text_value:
                return False
        return True

    original_track_count = len(draft_content.get("tracks") or [])
    draft_content["tracks"] = [
        track
        for track in (draft_content.get("tracks") or [])
        if not is_orphan_generated_caption_track(track)
    ]
    removed_orphan_tracks = original_track_count - len(draft_content.get("tracks") or [])
    if removed_orphan_tracks:
        summary["removed_orphan_caption_tracks"] = removed_orphan_tracks

    with open(draft_content_path, "w", encoding="utf-8") as file:
        json.dump(draft_content, file, ensure_ascii=False, indent=4)

    summary["applied"] = sync_count > 0
    summary["synced_count"] = sync_count
    summary["synced_explainer_blocks"] = synced_blocks
    summary["reason"] = "synced to source_video target timeline" if sync_count else "nothing synced"
    return summary

def force_process_caption_visibility(draft_content_path, template_doc=None, process_config=None):
    """Normalize cloned caption text so CapCut cannot keep it invisible."""
    summary = {
        "applied": False,
        "reason": "not run",
        "segments_checked": 0,
        "materials_checked": 0,
        "animation_refs_removed": 0,
        "animation_refs_added": 0,
        "animation_policy": "full cut captions use pop_in at 10 percent; highlight explainers use echo_slam at 50 percent",
        "style_preset": {
            "font_size": FULL_CUT_CAPTION_FONT_SIZE,
            "text_color": "template-preserved",
            "border_color": "template-preserved",
            "border_width": "template-preserved-with-minimum",
            "shadow_alpha": "template-preserved-with-minimum",
            "background_alpha": "template-preserved",
            "animation": "pop_in",
            "animation_duration_policy": "10_percent_of_caption_duration",
            "animation_duration_ratio": FULL_CUT_CAPTION_ANIMATION_RATIO,
        },
        "position": {"x": FULL_CUT_CAPTION_X, "y": FULL_CUT_CAPTION_Y},
        "highlight_style_preset": {
            "font_size": HIGHLIGHT_EXPLAINER_FONT_SIZE,
            "text_color": "#FFF2A6",
            "border_color": "#000000",
            "border_width": 0.095,
            "shadow_alpha": 0.82,
            "background_alpha": 0.34,
            "animation": "echo_slam",
            "animation_duration_policy": "half_of_highlight_duration",
            "animation_duration_ratio": HIGHLIGHT_EXPLAINER_ANIMATION_RATIO,
        },
        "highlight_position": {"x": HIGHLIGHT_EXPLAINER_X, "y": HIGHLIGHT_EXPLAINER_Y},
        "highlight_segments_checked": 0,
        "highlight_animation_durations": [],
        "full_animation_durations": [],
        "animation_fallbacks": [],
    }
    if not draft_content_path or not os.path.exists(draft_content_path):
        summary["reason"] = "draft_content.json not found"
        return summary

    with open(draft_content_path, "r", encoding="utf-8-sig") as file:
        draft_content = json.load(file)

    text_track = None
    for track in draft_content.get("tracks") or []:
        if isinstance(track, dict) and track.get("type") == "text" and track.get("name") == "process_explainer":
            text_track = track
            break

    if not text_track:
        summary["reason"] = "process_explainer track not found"
        return summary

    text_track["visible"] = True
    material_index = build_material_index_by_id(draft_content)
    process_config = process_config if isinstance(process_config, dict) else {}
    draft_caption_mode = str(process_config.get("caption_mode") or "").strip().lower()
    draft_variant_policy = str(process_config.get("variant_policy_id") or process_config.get("visual_template") or "").strip().lower()
    has_highlight_explainer_block = any(
        isinstance(block, dict)
        and str(block.get("style_profile") or block.get("styleProfile") or "").strip() == "highlight_explainer"
        for block in process_config.get("explainer_blocks") or []
    )
    default_is_highlight_draft = (
        draft_caption_mode == "long_bottom_explainer"
        or "highlight" in draft_variant_policy
        or has_highlight_explainer_block
    )

    def first_existing_font_path(candidates):
        for candidate in candidates:
            if os.path.exists(candidate):
                return candidate.replace("\\", "/")
        return ""

    def japanese_caption_font_path():
        return first_existing_font_path([
            r"C:\Windows\Fonts\YuGothB.ttc",
            r"C:\Windows\Fonts\YuGothM.ttc",
            r"C:\Windows\Fonts\meiryo.ttc",
            r"C:\Windows\Fonts\msgothic.ttc",
            r"C:\Windows\Fonts\NotoSans-Regular.ttf",
        ])

    def korean_caption_font_path():
        return first_existing_font_path([
            r"C:\Windows\Fonts\malgun.ttf",
            r"C:\Windows\Fonts\malgunbd.ttf",
            r"C:\Windows\Fonts\malgun.ttf",
        ])

    safe_japanese_font_path = japanese_caption_font_path()
    safe_korean_font_path = korean_caption_font_path()
    safe_font_path = safe_japanese_font_path or safe_korean_font_path
    caption_text_color = "#FFF2A6"
    caption_fill_rgb = [1.0, 0.949, 0.651]
    caption_outline_rgb = [0.0, 0.0, 0.0]
    caption_pop_animation_path = (
        r"C:\Users\sejun\AppData\Local\CapCut\User Data\Cache\effect\3834795\28d9145ead32c23742082a37e511370e"
    )
    caption_pop_animation_path = caption_pop_animation_path.replace("\\", "/")
    caption_pop_animation_available = os.path.exists(caption_pop_animation_path.replace("/", os.sep))

    def strip_emoji_text(text):
        return re.sub(r"[\U0001F300-\U0001FAFF\u2600-\u27BF]", "", str(text or "")).strip()

    def wrap_highlight_caption_text(text, max_chars=24):
        raw = strip_emoji_text(text).replace("\r\n", " ").replace("\r", " ").replace("\n", " ").strip()
        raw = re.sub(r"\s+", " ", raw)
        # Do not insert hard newlines for highlight captions. CapCut wraps more
        # naturally from fixed_width, while manual newlines make Japanese text
        # look jumpy and uneven.
        return raw

    def color_to_rgb_list(value, fallback):
        if isinstance(value, list) and len(value) >= 3:
            return [safe_float(value[0], fallback[0]), safe_float(value[1], fallback[1]), safe_float(value[2], fallback[2])]
        if isinstance(value, str):
            raw = value.strip()
            if raw.startswith("#") and len(raw) in (7, 9):
                try:
                    return [int(raw[1:3], 16) / 255.0, int(raw[3:5], 16) / 255.0, int(raw[5:7], 16) / 255.0]
                except Exception:
                    return fallback
        return fallback

    def rgb_list_to_hex(value, fallback="#FFF2A6"):
        if not isinstance(value, list) or len(value) < 3:
            return fallback
        try:
            parts = [max(0, min(255, int(round(safe_float(channel, 0.0) * 255)))) for channel in value[:3]]
            return "#" + "".join(f"{part:02X}" for part in parts)
        except Exception:
            return fallback

    def material_content_style_colors(material):
        result = {}
        content_json = parse_json_text_content(material.get("content") if isinstance(material, dict) else None)
        if not isinstance(content_json, dict):
            return result
        styles = content_json.get("styles")
        if not isinstance(styles, list):
            return result
        for style_item in styles:
            if not isinstance(style_item, dict):
                continue
            fill = style_item.get("fill")
            if isinstance(fill, dict):
                solid = ((fill.get("content") or {}).get("solid") if isinstance(fill.get("content"), dict) else None)
                if isinstance(solid, dict):
                    if isinstance(solid.get("color"), list):
                        result["fill_rgb"] = solid.get("color")
                    if solid.get("alpha") is not None:
                        result["fill_alpha"] = solid.get("alpha")
            strokes = style_item.get("strokes")
            if isinstance(strokes, list) and strokes:
                stroke = next((item for item in strokes if isinstance(item, dict)), None)
                if isinstance(stroke, dict):
                    if stroke.get("width") is not None:
                        result["border_width"] = stroke.get("width")
                    if stroke.get("alpha") is not None:
                        result["border_alpha"] = stroke.get("alpha")
                    solid = ((stroke.get("content") or {}).get("solid") if isinstance(stroke.get("content"), dict) else None)
                    if isinstance(solid, dict):
                        if isinstance(solid.get("color"), list):
                            result["outline_rgb"] = solid.get("color")
                        if solid.get("alpha") is not None:
                            result["outline_alpha"] = solid.get("alpha")
            break
        return result

    def template_content_font_fields(material):
        result = {}
        content_json = parse_json_text_content(material.get("content") if isinstance(material, dict) else None)
        if not isinstance(content_json, dict):
            return result
        styles = content_json.get("styles")
        if not isinstance(styles, list):
            return result
        for style_item in styles:
            if not isinstance(style_item, dict):
                continue
            font = style_item.get("font")
            if not isinstance(font, dict):
                continue
            for source_key, target_key in [
                ("path", "font_path"),
                ("name", "font_name"),
                ("title", "font_title"),
                ("id", "font_id"),
                ("resource_id", "font_resource_id"),
                ("source_platform", "font_source_platform"),
                ("category_name", "font_category_name"),
                ("category_id", "font_category_id"),
                ("third_resource_id", "font_third_resource_id"),
            ]:
                value = font.get(source_key)
                if value not in (None, ""):
                    result[target_key] = value
            break
        return result

    def template_content_font_size(material):
        content_json = parse_json_text_content(material.get("content") if isinstance(material, dict) else None)
        if not isinstance(content_json, dict):
            return None
        styles = content_json.get("styles")
        if not isinstance(styles, list):
            return None
        for style_item in styles:
            if isinstance(style_item, dict) and style_item.get("size") is not None:
                return safe_float(style_item.get("size"), 0.0)
        return None

    def template_style_overrides_from_marker(marker_name, style_profile):
        if not isinstance(template_doc, dict):
            return {}
        entries = find_template_text_marker_assets(template_doc, [marker_name])
        entry = entries.get(marker_name) if isinstance(entries, dict) else None
        if not isinstance(entry, dict):
            return {}
        material = entry.get("material")
        segment = entry.get("segment")
        if not isinstance(material, dict) or not isinstance(segment, dict):
            return {}
        clip = segment.get("clip") if isinstance(segment.get("clip"), dict) else {}
        transform = clip.get("transform") if isinstance(clip.get("transform"), dict) else {}
        scale = clip.get("scale") if isinstance(clip.get("scale"), dict) else {}
        overrides = {
            "marker": marker_name,
            "style_profile": style_profile,
            "font_size": template_content_font_size(material) or safe_float(material.get("font_size"), HIGHLIGHT_EXPLAINER_FONT_SIZE if style_profile == "highlight_explainer" else FULL_CUT_CAPTION_FONT_SIZE),
            "x": safe_float(transform.get("x"), HIGHLIGHT_EXPLAINER_X if style_profile == "highlight_explainer" else FULL_CUT_CAPTION_X),
            "y": safe_float(transform.get("y"), HIGHLIGHT_EXPLAINER_Y if style_profile == "highlight_explainer" else FULL_CUT_CAPTION_Y),
            "scale_x": safe_float(scale.get("x"), 1.0),
            "scale_y": safe_float(scale.get("y"), 1.0),
        }
        overrides.update(material_content_style_colors(material))
        for field in [
            "fixed_width",
            "fixed_height",
            "line_max_width",
            "line_spacing",
            "line_feed",
            "typesetting",
            "alignment",
            "oneline_cutoff",
            "force_apply_line_max_width",
            "text_color",
            "text_alpha",
            "global_alpha",
            "border_color",
            "border_alpha",
            "border_width",
            "border_mode",
            "shadow_color",
            "shadow_alpha",
            "shadow_distance",
            "shadow_angle",
            "shadow_smoothing",
            "bold_width",
            "bold_width_rate",
            "background_color",
            "background_alpha",
            "background_round_radius",
            "font_path",
            "font_name",
            "font_title",
            "font_id",
            "font_resource_id",
            "font_source_platform",
            "font_category_name",
            "font_category_id",
            "font_third_resource_id",
            "fonts",
        ]:
            if field in material:
                overrides[field] = material.get(field)
        content_font_fields = template_content_font_fields(material)
        for field, value in content_font_fields.items():
            if value not in (None, ""):
                overrides[field] = value
        content_font_path = first_non_empty_string(content_font_fields.get("font_path"), overrides.get("font_path"))
        if content_font_path:
            font_file_name = os.path.splitext(os.path.basename(content_font_path))[0]
            if font_file_name and not first_non_empty_string(content_font_fields.get("font_name"), content_font_fields.get("font_title")):
                overrides["font_name"] = font_file_name
                overrides["font_title"] = font_file_name
        return overrides

    def fallback_style_overrides_for_segment(is_highlight):
        if is_highlight:
            return template_style_overrides_from_marker("TEMPLATE_HIGHLIGHT_EXPLAINER", "highlight_explainer")
        return template_style_overrides_from_marker("TEMPLATE_FULL_CAPTION", "full_cut_caption")

    def first_non_empty_string(*values):
        for value in values:
            if isinstance(value, str) and value.strip():
                return value.strip()
        return ""

    def has_korean_text(value):
        return bool(re.search(r"[\uac00-\ud7a3]", str(value or "")))

    def has_japanese_text(value):
        return bool(re.search(r"[\u3040-\u30ff]", str(value or "")))

    def looks_like_korean_caption_font(value):
        text = str(value or "").lower()
        return any(token in text for token in ["cafe24", "카페24", "단정", "danjung", "korean"])

    def is_japanese_caption_request(text, overrides):
        language = str((overrides or {}).get("language") or (overrides or {}).get("output_language") or "").lower()
        return language.startswith(("ja", "jp")) or (has_japanese_text(text) and not has_korean_text(text))

    def is_korean_caption_request(text, overrides):
        language = str((overrides or {}).get("language") or (overrides or {}).get("output_language") or "").lower()
        return language.startswith(("ko", "kr")) or has_korean_text(text)

    def force_content_style_visible(material, font_size, stroke_width=0.115, fill_rgb=None, outline_rgb=None, font_path=None, font_overrides=None):
        fill_rgb = fill_rgb if isinstance(fill_rgb, list) else caption_fill_rgb
        outline_rgb = outline_rgb if isinstance(outline_rgb, list) else caption_outline_rgb
        font_overrides = font_overrides if isinstance(font_overrides, dict) else {}
        content_json = parse_json_text_content(material.get("content"))
        if not isinstance(content_json, dict):
            return
        content_text = get_material_text_value(material)
        if content_text:
            content_json["text"] = content_text
        styles = content_json.get("styles")
        if isinstance(styles, list):
            for style_item in styles:
                if not isinstance(style_item, dict):
                    continue
                style_item["size"] = font_size
                style_item["range"] = [0, len(content_text)]
                if font_path or font_overrides:
                    font = style_item.setdefault("font", {})
                    if isinstance(font, dict):
                        if font_path:
                            font["path"] = font_path
                        for source_key, target_key in [
                            ("font_id", "id"),
                            ("font_name", "name"),
                            ("font_title", "title"),
                            ("font_resource_id", "resource_id"),
                            ("font_source_platform", "source_platform"),
                            ("font_category_name", "category_name"),
                            ("font_category_id", "category_id"),
                            ("font_third_resource_id", "third_resource_id"),
                        ]:
                            value = font_overrides.get(source_key)
                            if value not in (None, ""):
                                font[target_key] = value
                        font["id"] = font.get("id", "")
                fill = style_item.get("fill")
                if isinstance(fill, dict):
                    fill["alpha"] = 1.0
                    content = fill.get("content")
                    if isinstance(content, dict):
                        solid = content.get("solid")
                        if isinstance(solid, dict):
                            solid["alpha"] = 1.0
                            solid["color"] = fill_rgb
                strokes = style_item.get("strokes")
                if not isinstance(strokes, list):
                    strokes = []
                    style_item["strokes"] = strokes
                if not strokes:
                    strokes.append({
                        "alpha": 1.0,
                        "content": {
                            "render_type": "solid",
                            "solid": {
                                "alpha": 1.0,
                                "color": outline_rgb,
                            },
                        },
                        "mode": 0,
                        "width": stroke_width,
                    })
                for stroke in strokes:
                    if not isinstance(stroke, dict):
                        continue
                    stroke["alpha"] = 1.0
                    stroke["width"] = max(safe_float(stroke.get("width"), 0.0), stroke_width)
                    stroke["mode"] = int(safe_float(stroke.get("mode"), 0))
                    content = stroke.get("content")
                    if not isinstance(content, dict):
                        content = {"render_type": "solid", "solid": {"alpha": 1.0, "color": outline_rgb}}
                        stroke["content"] = content
                    solid = content.get("solid")
                    if not isinstance(solid, dict):
                        solid = {"alpha": 1.0, "color": outline_rgb}
                        content["solid"] = solid
                    solid["alpha"] = 1.0
                    solid["color"] = outline_rgb
        if styles:
            content_json["styles"] = styles
        material["content"] = json.dumps(content_json, ensure_ascii=False)

    def override_float(overrides, key, fallback):
        if not isinstance(overrides, dict):
            return fallback
        if key not in overrides:
            return fallback
        return safe_float(overrides.get(key), fallback)

    def override_bool(overrides, key, fallback):
        if not isinstance(overrides, dict) or key not in overrides:
            return fallback
        return coerce_bool(overrides.get(key), fallback)

    def normalize_text_material(material, mode="full", overrides=None):
        if not isinstance(material, dict):
            return False
        material_text = strip_emoji_text(get_material_text_value(material))
        if material_text != get_material_text_value(material):
            set_material_text_value(material, material_text)
        is_highlight = mode == "highlight"
        if is_highlight:
            wrapped_text = wrap_highlight_caption_text(material_text)
            if wrapped_text and wrapped_text != material_text:
                set_material_text_value(material, wrapped_text)
                material_text = wrapped_text
        is_japanese_caption = is_japanese_caption_request(material_text, overrides if isinstance(overrides, dict) else {})
        is_korean_caption = is_korean_caption_request(material_text, overrides if isinstance(overrides, dict) else {})
        target_font_size = override_float(
            overrides,
            "font_size",
            HIGHLIGHT_EXPLAINER_FONT_SIZE if is_highlight else FULL_CUT_CAPTION_FONT_SIZE,
        )
        existing_style_colors = material_content_style_colors(material)
        base_fill_rgb = existing_style_colors.get("fill_rgb") or color_to_rgb_list(material.get("text_color"), caption_fill_rgb)
        base_outline_rgb = existing_style_colors.get("outline_rgb") or color_to_rgb_list(material.get("border_color"), caption_outline_rgb)
        override_text_color = overrides.get("text_color") if isinstance(overrides, dict) else None
        override_border_color = overrides.get("border_color") if isinstance(overrides, dict) else None
        fill_rgb = color_to_rgb_list(
            overrides.get("fill_rgb") if isinstance(overrides, dict) else None,
            color_to_rgb_list(override_text_color, base_fill_rgb),
        )
        outline_rgb = color_to_rgb_list(
            overrides.get("outline_rgb") if isinstance(overrides, dict) else None,
            color_to_rgb_list(override_border_color, base_outline_rgb),
        )
        text_color = first_non_empty_string(override_text_color, material.get("text_color")) or rgb_list_to_hex(fill_rgb, caption_text_color)
        border_color = first_non_empty_string(override_border_color, material.get("border_color")) or rgb_list_to_hex(outline_rgb, "#000000")
        stroke_width = max(
            override_float(overrides, "border_width", 0.095 if is_highlight else 0.115),
            0.035 if is_highlight else 0.05,
        )
        font_size = target_font_size
        material["font_size"] = font_size
        override_font_path = overrides.get("font_path") if isinstance(overrides, dict) else None
        material_font_path = material.get("font_path")
        has_template_font_override = isinstance(overrides, dict) and any(
            first_non_empty_string(overrides.get(field))
            for field in [
                "font_path",
                "font_name",
                "font_title",
                "font_id",
                "font_resource_id",
                "font_source_platform",
                "font_category_name",
                "font_category_id",
                "font_third_resource_id",
            ]
        )
        if is_japanese_caption:
            if not has_template_font_override and looks_like_korean_caption_font(override_font_path):
                override_font_path = ""
            if not has_template_font_override and looks_like_korean_caption_font(material_font_path):
                material_font_path = ""
            effective_font_path = first_non_empty_string(
                override_font_path,
                material_font_path,
                safe_japanese_font_path,
                safe_font_path,
            )
        elif is_korean_caption:
            effective_font_path = first_non_empty_string(
                override_font_path,
                material_font_path,
                safe_korean_font_path,
                safe_font_path,
            )
        else:
            effective_font_path = first_non_empty_string(
                override_font_path,
                material_font_path,
                safe_font_path,
            )
        if effective_font_path:
            material["font_path"] = effective_font_path
        if isinstance(overrides, dict):
            for font_field in [
                "font_name",
                "font_title",
                "font_id",
                "font_resource_id",
                "font_source_platform",
                "font_category_name",
                "font_category_id",
                "font_third_resource_id",
                "fonts",
            ]:
                if is_japanese_caption and not has_template_font_override and looks_like_korean_caption_font(overrides.get(font_field)):
                    continue
                if font_field in overrides:
                    material[font_field] = overrides.get(font_field)
        if effective_font_path:
            if is_japanese_caption and not has_template_font_override and (
                looks_like_korean_caption_font(material.get("font_name"))
                or looks_like_korean_caption_font(material.get("font_title"))
                or not first_non_empty_string(material.get("font_name"), material.get("font_title"))
            ):
                material["font_name"] = "Yu Gothic"
                material["font_title"] = "Yu Gothic"
            material["font_name"] = material.get("font_name") or "Yu Gothic"
            material["font_title"] = material.get("font_title") or material.get("font_name") or "Yu Gothic"
        material["global_alpha"] = 1.0
        material["text_alpha"] = 1.0
        material["alpha"] = 1.0
        material["visible"] = True
        material["text_color"] = text_color
        material["use_effect_default_color"] = True
        material["has_border"] = True
        material["border_alpha"] = max(override_float(overrides, "border_alpha", safe_float(material.get("border_alpha"), 0.0)), 0.45)
        material["border_width"] = max(override_float(overrides, "border_width", safe_float(material.get("border_width"), 0.0)), stroke_width)
        material["border_color"] = border_color
        material["border_mode"] = int(override_float(overrides, "border_mode", safe_float(material.get("border_mode"), 0)))
        material["has_shadow"] = True
        material["shadow_color"] = overrides.get("shadow_color", material.get("shadow_color", "#000000")) if isinstance(overrides, dict) else material.get("shadow_color", "#000000")
        material["shadow_alpha"] = max(override_float(overrides, "shadow_alpha", safe_float(material.get("shadow_alpha"), 0.0)), 0.18)
        material["shadow_distance"] = max(override_float(overrides, "shadow_distance", safe_float(material.get("shadow_distance"), 0.0)), 0.0)
        material["shadow_angle"] = override_float(overrides, "shadow_angle", safe_float(material.get("shadow_angle"), -45.0))
        material["shadow_smoothing"] = max(override_float(overrides, "shadow_smoothing", safe_float(material.get("shadow_smoothing"), 0.0)), 0.0)
        material["bold_width"] = max(override_float(overrides, "bold_width", safe_float(material.get("bold_width"), 0.0)), 0.0)
        material["bold_width_rate"] = max(override_float(overrides, "bold_width_rate", safe_float(material.get("bold_width_rate"), 0.0)), 0.0)
        material["background_color"] = overrides.get("background_color", material.get("background_color", "#000000")) if isinstance(overrides, dict) else material.get("background_color", "#000000")
        material["background_alpha"] = max(override_float(overrides, "background_alpha", safe_float(material.get("background_alpha"), 0.0)), 0.0)
        material["background_round_radius"] = max(override_float(overrides, "background_round_radius", safe_float(material.get("background_round_radius"), 0.0)), 0.0)
        material["single_char_bg_enable"] = False
        material["oneline_cutoff"] = override_bool(overrides, "oneline_cutoff", False)
        material["line_feed"] = int(override_float(overrides, "line_feed", 1 if is_highlight else 0))
        material["typesetting"] = int(override_float(overrides, "typesetting", 0))
        material["alignment"] = int(override_float(overrides, "alignment", 1))
        if is_highlight:
            material["fixed_width"] = override_float(overrides, "fixed_width", HIGHLIGHT_EXPLAINER_FIXED_WIDTH)
            material["fixed_height"] = override_float(overrides, "fixed_height", -1.0)
            material["force_apply_line_max_width"] = override_bool(overrides, "force_apply_line_max_width", True)
            material["line_spacing"] = override_float(
                overrides,
                "line_spacing",
                min(max(safe_float(material.get("line_spacing"), 0.0), -0.5), 0.05),
            )
            material["line_max_width"] = override_float(
                overrides,
                "line_max_width",
                safe_float(material.get("line_max_width"), 0.82),
            )
        else:
            material["line_spacing"] = min(max(safe_float(material.get("line_spacing"), 0.0), -0.2), 0.05)
            material["fixed_width"] = override_float(overrides, "fixed_width", FULL_CUT_CAPTION_FIXED_WIDTH)
            material["fixed_height"] = override_float(overrides, "fixed_height", FULL_CUT_CAPTION_FIXED_HEIGHT)
            material["force_apply_line_max_width"] = override_bool(overrides, "force_apply_line_max_width", False)
            material["line_max_width"] = override_float(overrides, "line_max_width", FULL_CUT_CAPTION_LINE_MAX_WIDTH)
        if not is_highlight and isinstance(overrides, dict):
            if "fixed_width" in overrides:
                material["fixed_width"] = override_float(overrides, "fixed_width", safe_float(material.get("fixed_width"), 0.0))
            if "fixed_height" in overrides:
                material["fixed_height"] = override_float(overrides, "fixed_height", safe_float(material.get("fixed_height"), -1.0))
            if "force_apply_line_max_width" in overrides:
                material["force_apply_line_max_width"] = override_bool(overrides, "force_apply_line_max_width", False)
            if "line_max_width" in overrides:
                material["line_max_width"] = override_float(overrides, "line_max_width", safe_float(material.get("line_max_width"), 0.0))
        force_content_style_visible(
            material,
            font_size,
            stroke_width=stroke_width,
            fill_rgb=fill_rgb,
            outline_rgb=outline_rgb,
            font_path=effective_font_path,
            font_overrides=overrides if isinstance(overrides, dict) else {},
        )
        return True

    def normalize_animation_material_duration(animation_material, duration_us, preferred_duration_us, min_duration_us=140_000):
        if not isinstance(animation_material, dict):
            return False
        target_us = int(min(max(min_duration_us, preferred_duration_us), max(min_duration_us, duration_us - 1)))
        changed = False
        animations = animation_material.get("animations")
        if isinstance(animations, list):
            for animation in animations:
                if not isinstance(animation, dict):
                    continue
                if int(animation.get("duration") or 0) != target_us:
                    animation["duration"] = target_us
                    changed = True
        return changed

    def build_caption_pop_animation(duration_us, preferred_duration_us=None, animation_name="pop_in", min_duration_us=140_000):
        if not caption_pop_animation_available or duration_us <= min_duration_us + 1:
            return None
        if preferred_duration_us:
            animation_duration = int(min(max(min_duration_us, preferred_duration_us), max(min_duration_us, duration_us - 1)))
        else:
            animation_duration = int(min(240_000, max(min_duration_us, duration_us * FULL_CUT_CAPTION_ANIMATION_RATIO)))
        return {
            "id": new_capcut_id(),
            "type": "sticker_animation",
            "animations": [
                {
                    "id": "3834795",
                    "type": "in",
                    "start": 0,
                    "duration": animation_duration,
                    "path": caption_pop_animation_path,
                    "platform": "all",
                    "resource_id": "7145435451946439170",
                    "third_resource_id": "0",
                    "source_platform": 0,
                    "name": animation_name,
                    "category_id": "ruchang_fav",
                    "category_name": "favorite",
                    "panel": "",
                    "material_type": "sticker",
                    "anim_adjust_params": None,
                    "request_id": "",
                }
            ],
            "multi_language_current": "none",
        }

    def highlight_animation_duration_us(duration_us):
        duration = int(duration_us or 0)
        if duration <= 1:
            return HIGHLIGHT_EXPLAINER_MIN_ANIMATION_US
        return int(
            min(
                max(HIGHLIGHT_EXPLAINER_MIN_ANIMATION_US, duration * HIGHLIGHT_EXPLAINER_ANIMATION_RATIO),
                max(HIGHLIGHT_EXPLAINER_MIN_ANIMATION_US, duration - 1),
            )
        )

    def full_caption_animation_duration_us(duration_us):
        duration = int(duration_us or 0)
        if duration <= 1:
            return FULL_CUT_CAPTION_MIN_ANIMATION_US
        return int(
            min(
                max(FULL_CUT_CAPTION_MIN_ANIMATION_US, duration * FULL_CUT_CAPTION_ANIMATION_RATIO),
                max(FULL_CUT_CAPTION_MIN_ANIMATION_US, duration - 1),
            )
        )

    visible_caption_index = 0
    sorted_text_segments = sorted(
        [segment for segment in (text_track.get("segments") or []) if isinstance(segment, dict)],
        key=lambda segment: int((segment.get("target_timerange") or {}).get("start") or 0),
    )
    for segment in sorted_text_segments:
        if not isinstance(segment, dict):
            continue
        if segment.get("visible") is False:
            # Timeline sync intentionally hides leftover template/clone captions.
            # Do not revive them here, or they will overlap near the tail.
            continue
        summary["segments_checked"] += 1
        segment["visible"] = True
        segment["render_index"] = 15000 + visible_caption_index
        segment["track_render_index"] = 0
        visible_caption_index += 1
        segment["enable_adjust"] = False
        segment["enable_video_mask"] = False
        segment["enable_mask_stroke"] = False
        segment["enable_mask_shadow"] = False
        segment["enable_adjust_mask"] = False
        if isinstance(segment.get("target_timerange"), dict):
            target = segment["target_timerange"]
            duration_us_for_render = int(target.get("duration") or 0)
            segment["render_timerange"] = {
                "start": 0,
                "duration": duration_us_for_render,
            }
            if isinstance(segment.get("source_timerange"), dict):
                segment["source_timerange"] = {
                    "start": 0,
                    "duration": duration_us_for_render,
                }
        duration_us = int((segment.get("target_timerange") or {}).get("duration") or 0)
        material_entry = material_index.get(segment.get("material_id"))
        material_text = get_material_text_value(material_entry[1]) if material_entry else ""
        style_overrides = segment.get("caption_style_overrides")
        if not isinstance(style_overrides, dict):
            style_overrides = {}
        marker_name = str(segment.get("caption_template_marker") or "")
        style_profile = str(style_overrides.get("style_profile") or "").strip()
        marker_upper = marker_name.upper()
        is_highlight = (
            style_profile == "highlight_explainer"
            or ("HIGHLIGHT" in marker_upper and "FOR_FULL_CAPTION" not in marker_upper)
        )
        if not style_overrides:
            style_overrides = fallback_style_overrides_for_segment(default_is_highlight_draft or is_highlight)
            if style_overrides:
                segment["caption_style_overrides"] = style_overrides
                segment["caption_template_marker"] = style_overrides.get("marker", marker_name)
                style_profile = str(style_overrides.get("style_profile") or "").strip()
                marker_name = str(segment.get("caption_template_marker") or "")
                marker_upper = marker_name.upper()
                is_highlight = (
                    style_profile == "highlight_explainer"
                    or ("HIGHLIGHT" in marker_upper and "FOR_FULL_CAPTION" not in marker_upper)
                )
        if is_highlight:
            summary["highlight_segments_checked"] += 1
            highlight_animation_us = highlight_animation_duration_us(duration_us)
            summary["highlight_animation_durations"].append({
                "caption_duration_sec": round(duration_us / 1_000_000, 3),
                "animation_duration_sec": round(highlight_animation_us / 1_000_000, 3),
                "ratio": HIGHLIGHT_EXPLAINER_ANIMATION_RATIO,
            })
        else:
            highlight_animation_us = HIGHLIGHT_EXPLAINER_MIN_ANIMATION_US
        caption_animation_us = highlight_animation_us if is_highlight else full_caption_animation_duration_us(duration_us)
        if not is_highlight:
            summary["full_animation_durations"].append({
                "caption_duration_sec": round(duration_us / 1_000_000, 3),
                "animation_duration_sec": round(caption_animation_us / 1_000_000, 3),
                "ratio": FULL_CUT_CAPTION_ANIMATION_RATIO,
            })
        safe_x = override_float(style_overrides, "x", HIGHLIGHT_EXPLAINER_X if is_highlight else FULL_CUT_CAPTION_X)
        safe_y = override_float(style_overrides, "y", HIGHLIGHT_EXPLAINER_Y if is_highlight else FULL_CUT_CAPTION_Y)
        clip = segment.setdefault("clip", {})
        clip["alpha"] = 1.0
        transform = clip.setdefault("transform", {})
        transform["x"] = safe_x
        transform["y"] = safe_y
        scale = clip.setdefault("scale", {})
        if is_highlight:
            scale["x"] = override_float(style_overrides, "scale_x", 1.0)
            scale["y"] = override_float(style_overrides, "scale_y", 1.0)
        else:
            scale["x"] = 1.0
            scale["y"] = 1.0

        next_refs = []
        has_animation_ref = False
        for ref_id in segment.get("extra_material_refs") or []:
            ref_entry = material_index.get(ref_id)
            if not ref_entry:
                summary["animation_refs_removed"] += 1
                continue
            is_animation_ref = ref_entry[0] == "material_animations" or isinstance(ref_entry[1].get("animations"), list)
            if is_animation_ref:
                min_animation_us = HIGHLIGHT_EXPLAINER_MIN_ANIMATION_US if is_highlight else FULL_CUT_CAPTION_MIN_ANIMATION_US
                if duration_us <= min_animation_us + 1:
                    summary["animation_refs_removed"] += 1
                    continue
                has_animation_ref = True
                if normalize_animation_material_duration(
                    ref_entry[1],
                    duration_us,
                    caption_animation_us,
                    min_animation_us,
                ):
                    summary["animation_refs_updated"] = summary.get("animation_refs_updated", 0) + 1
            next_refs.append(ref_id)
        pop_animation = None
        if is_highlight and not has_animation_ref:
            pop_animation = build_caption_pop_animation(
                duration_us,
                highlight_animation_us,
                animation_name="echo_slam_fallback_pop_in",
                min_duration_us=HIGHLIGHT_EXPLAINER_MIN_ANIMATION_US,
            )
            if pop_animation:
                summary["animation_fallbacks"].append({
                    "requested": "echo_slam",
                    "used": "pop_in",
                    "reason": "highlight template did not include a reusable animation ref",
                })
        if not is_highlight and not has_animation_ref:
            pop_animation = build_caption_pop_animation(
                duration_us,
                caption_animation_us,
                animation_name="pop_in",
                min_duration_us=FULL_CUT_CAPTION_MIN_ANIMATION_US,
            )
        if pop_animation:
            ensure_material_category(draft_content, "material_animations").append(pop_animation)
            next_refs.append(pop_animation["id"])
            summary["animation_refs_added"] += 1
        segment["extra_material_refs"] = next_refs

        if material_entry and normalize_text_material(
            material_entry[1],
            mode="highlight" if is_highlight else "full",
            overrides=style_overrides,
        ):
            summary["materials_checked"] += 1

    with open(draft_content_path, "w", encoding="utf-8") as file:
        json.dump(draft_content, file, ensure_ascii=False, indent=4)

    summary["applied"] = summary["segments_checked"] > 0
    summary["reason"] = "process_explainer captions forced visible"
    return summary


def apply_caption_blur_effect_to_draft(draft_content_path, template_doc, warnings):
    """Add a persistent CapCut blur/mosaic mask behind the caption area."""
    summary = {
        "applied": False,
        "reason": "not run",
        "segments_count": 0,
        "track_name": "caption_blur_effect",
        "template_effect_name": "",
        "duration_sec": 0,
        "mask": {"x": FULL_CUT_CAPTION_X, "y": FULL_CUT_CAPTION_Y, "width": 0.9, "height": 0.14},
    }
    if not draft_content_path or not os.path.exists(draft_content_path):
        summary["reason"] = "draft_content.json not found"
        return summary

    template_entry = find_template_ocr_mask_effect(template_doc)
    if not template_entry or not isinstance(template_entry.get("material"), dict):
        summary["reason"] = "template blur/mosaic effect not found"
        return summary

    with open(draft_content_path, "r", encoding="utf-8-sig") as file:
        draft_content = json.load(file)

    video_end_us = 0
    for track in draft_content.get("tracks") or []:
        if not isinstance(track, dict):
            continue
        if track.get("name") == "source_video":
            for segment in track.get("segments") or []:
                if not isinstance(segment, dict):
                    continue
                target = segment.get("target_timerange") or {}
                video_end_us = max(video_end_us, int(target.get("start") or 0) + int(target.get("duration") or 0))
        if track.get("name") == "process_explainer":
            for segment in track.get("segments") or []:
                if not isinstance(segment, dict):
                    continue
                target = segment.get("target_timerange") or {}
                video_end_us = max(video_end_us, int(target.get("start") or 0) + int(target.get("duration") or 0))

    if video_end_us <= 0:
        summary["reason"] = "timeline duration not found"
        return summary

    tracks = draft_content.setdefault("tracks", [])
    effect_track = None
    for track in tracks:
        if isinstance(track, dict) and track.get("type") == "effect" and track.get("name") == summary["track_name"]:
            effect_track = track
            break
    if effect_track is None:
        effect_track = {
            "id": new_capcut_id(),
            "type": "effect",
            "segments": [],
            "flag": 1,
            "attribute": 0,
            "name": summary["track_name"],
            "is_default_name": False,
        }
        tracks.append(effect_track)
    effect_track["segments"] = []

    template_material = template_entry["material"]
    template_segment = template_entry.get("segment")
    template_name = str(template_material.get("name") or template_material.get("material_name") or "Caption blur effect")

    material = json.loads(json.dumps(template_material))
    material_id = new_capcut_id()
    material["id"] = material_id
    material["name"] = f"{template_name} Caption Background"
    material["bind_segment_id"] = ""
    material["render_index"] = 12500
    material["track_render_index"] = 0
    for time_key in ["time_range", "apply_time_range"]:
        if isinstance(material.get(time_key), dict):
            material[time_key] = {"start": 0, "duration": video_end_us}
    effect_masks = material.get("effect_mask")
    if isinstance(effect_masks, list):
        for mask in effect_masks:
            if not isinstance(mask, dict):
                continue
            config = mask.setdefault("config", {})
            config["centerX"] = summary["mask"]["x"]
            config["centerY"] = summary["mask"]["y"]
            config["width"] = summary["mask"]["width"]
            config["height"] = summary["mask"]["height"]
            config.setdefault("rotation", 0.0)
            config.setdefault("feather", 0.0)
            config.setdefault("expansion", 0.0)
            config.setdefault("roundCorner", 0.0)
            config.setdefault("invert", False)
    ensure_material_category(draft_content, "video_effects").append(material)

    if isinstance(template_segment, dict):
        segment = json.loads(json.dumps(template_segment))
    else:
        segment = {
            "id": new_capcut_id(),
            "source_timerange": None,
            "render_timerange": {"start": 0, "duration": video_end_us},
            "speed": 1.0,
            "visible": True,
            "extra_material_refs": [],
            "clip": None,
            "uniform_scale": None,
        }
    segment["id"] = new_capcut_id()
    segment["material_id"] = material_id
    segment["extra_material_refs"] = []
    segment["render_index"] = 12500
    segment["track_render_index"] = 0
    segment["caption_background_blur"] = True
    upsert_timerange(segment, 0, video_end_us)
    effect_track["segments"].append(segment)

    with open(draft_content_path, "w", encoding="utf-8") as file:
        json.dump(draft_content, file, ensure_ascii=False, indent=4)

    summary["applied"] = True
    summary["reason"] = "caption background blur/mosaic effect cloned"
    summary["segments_count"] = 1
    summary["template_effect_name"] = template_name
    summary["duration_sec"] = round(video_end_us / 1_000_000, 3)
    return summary


def trim_auxiliary_tracks_to_video_timeline(draft_content_path):
    summary = {
        "applied": False,
        "reason": "not run",
        "video_end_sec": 0,
        "previous_draft_duration_sec": 0,
        "draft_duration_updated": False,
        "trimmed_tracks": [],
    }
    if not draft_content_path or not os.path.exists(draft_content_path):
        summary["reason"] = "draft_content.json not found"
        return summary

    with open(draft_content_path, "r", encoding="utf-8-sig") as file:
        draft_content = json.load(file)

    video_end_us = 0
    for track in draft_content.get("tracks", []):
        if isinstance(track, dict) and track.get("type") == "video" and track.get("name") == "source_video":
            for segment in track.get("segments") or []:
                if not isinstance(segment, dict):
                    continue
                target = segment.get("target_timerange") or {}
                start_us = int(target.get("start") or 0)
                duration_us = int(target.get("duration") or 0)
                video_end_us = max(video_end_us, start_us + duration_us)
            break

    if video_end_us <= 0:
        summary["reason"] = "source_video end time not found"
        return summary

    previous_duration_us = int(draft_content.get("duration") or 0)
    if previous_duration_us > 0:
        summary["previous_draft_duration_sec"] = round(previous_duration_us / 1_000_000, 3)

    target_track_names = {"bgm", "channel_frame_overlay", "channel_asset_overlay", "ocr_mask_overlay", "ocr_mask_effect", "caption_blur_effect", "process_explainer"}
    for track in draft_content.get("tracks", []):
        if not isinstance(track, dict) or track.get("name") not in target_track_names:
            continue
        is_caption_track = track.get("name") == "process_explainer"
        if is_caption_track:
            track["visible"] = True
        original_segments = [seg for seg in (track.get("segments") or []) if isinstance(seg, dict)]
        next_segments = []
        trimmed_count = 0
        removed_count = 0
        for segment in original_segments:
            target = segment.get("target_timerange") or {}
            start_us = int(target.get("start") or 0)
            duration_us = int(target.get("duration") or 0)
            if duration_us <= 0 or start_us >= video_end_us:
                removed_count += 1
                continue
            end_us = start_us + duration_us
            if end_us > video_end_us:
                new_duration_us = max(1, video_end_us - start_us)
                target["duration"] = new_duration_us
                segment["target_timerange"] = target
                if isinstance(segment.get("render_timerange"), dict):
                    segment["render_timerange"]["duration"] = new_duration_us
                if isinstance(segment.get("source_timerange"), dict):
                    segment["source_timerange"]["duration"] = min(
                        int(segment["source_timerange"].get("duration") or new_duration_us),
                        new_duration_us,
                    )
                trimmed_count += 1
            if is_caption_track:
                duration_us = int((segment.get("target_timerange") or {}).get("duration") or duration_us)
                segment["visible"] = True
                segment["track_render_index"] = 0
                clip = segment.setdefault("clip", {})
                clip["alpha"] = 1.0
                segment["render_timerange"] = {"start": 0, "duration": duration_us}
                if isinstance(segment.get("source_timerange"), dict):
                    segment["source_timerange"] = {"start": 0, "duration": duration_us}
            next_segments.append(segment)
        if is_caption_track:
            next_segments.sort(key=lambda segment: int((segment.get("target_timerange") or {}).get("start") or 0))
            for index, segment in enumerate(next_segments):
                segment["render_index"] = 15000 + index
                segment["track_render_index"] = 0
        track["segments"] = next_segments
        summary["trimmed_tracks"].append(
            {
                "track_name": track.get("name"),
                "original_segments": len(original_segments),
                "final_segments": len(next_segments),
                "trimmed_segments": trimmed_count,
                "removed_segments": removed_count,
            }
        )

    with open(draft_content_path, "w", encoding="utf-8") as file:
        if int(draft_content.get("duration") or 0) != video_end_us:
            draft_content["duration"] = video_end_us
            summary["draft_duration_updated"] = True
        json.dump(draft_content, file, ensure_ascii=False, indent=4)

    summary["applied"] = True
    summary["reason"] = "auxiliary tracks trimmed to source_video end"
    summary["video_end_sec"] = round(video_end_us / 1_000_000, 3)
    return summary


def find_bgm_file_from_preset(bgm_preset):
    candidate = ""
    if isinstance(bgm_preset, dict):
        process_config = bgm_preset.get("process_config") if isinstance(bgm_preset.get("process_config"), dict) else {}
        candidate = str(
            process_config.get("custom_bgm_path")
            or bgm_preset.get("custom_bgm_path")
            or bgm_preset.get("asset_path")
            or bgm_preset.get("path")
            or ""
        ).strip()
    if candidate:
        if not os.path.isabs(candidate):
            repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
            candidate = os.path.join(repo_root, candidate)
        if os.path.exists(candidate):
            return os.path.abspath(candidate)

    repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    bgm_dir = os.path.join(repo_root, "assets", "bgm", "process")
    if not os.path.isdir(bgm_dir):
        return ""
    for name in sorted(os.listdir(bgm_dir)):
        if name.lower().endswith((".mp3", ".wav", ".m4a", ".aac")):
            return os.path.abspath(os.path.join(bgm_dir, name))
    return ""


def get_channel_asset_transform(channel_asset):
    position = str((channel_asset or {}).get("position") or "top_left").strip().lower()
    # CapCut's video overlay transform uses normalized canvas coordinates.
    # Negative X is left, positive X is right. In CapCut draft video overlays,
    # positive Y is visually upper and negative Y is visually lower.
    positions = {
        "top_left": (-0.62, 0.76),
        "top_right": (0.62, 0.76),
        "bottom_left": (-0.62, -0.82),
        "bottom_right": (0.62, -0.82),
        "center": (0.0, 0.0),
    }
    transform_x, transform_y = positions.get(position, positions["top_left"])
    transform_x += safe_float((channel_asset or {}).get("offset_x"), 0.0)
    transform_y += safe_float((channel_asset or {}).get("offset_y"), 0.0)
    return {
        "position": position if position in positions else "top_left",
        "transform_x": transform_x,
        "transform_y": transform_y,
        "scale": max(0.05, min(2.0, safe_float((channel_asset or {}).get("scale"), 0.34))),
        "opacity": max(0.0, min(1.0, safe_float((channel_asset or {}).get("opacity"), 1.0))),
    }


def prepare_channel_asset_for_draft(channel_asset, overlay_dir, total_duration_sec, warnings, asset_prefix="channel_asset"):
    source_path = str((channel_asset or {}).get("path") or "").strip()
    if not source_path:
        return ""
    if not os.path.isabs(source_path):
        repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
        source_path = os.path.abspath(os.path.join(repo_root, source_path))
    if not os.path.exists(source_path):
        warnings.append(f"{asset_prefix} file not found: {source_path}")
        return ""

    os.makedirs(overlay_dir, exist_ok=True)
    ext = os.path.splitext(source_path)[1].lower()
    copied_path = os.path.abspath(os.path.join(overlay_dir, f"{asset_prefix}{ext or '.asset'}"))
    shutil.copy2(source_path, copied_path)

    image_exts = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}
    if ext in image_exts:
        converted_path = os.path.abspath(os.path.join(overlay_dir, f"{asset_prefix}_static_alpha.mov"))
        try:
            subprocess.run(
                [
                    FFMPEG_BIN,
                    "-y",
                    "-loop",
                    "1",
                    "-i",
                    copied_path,
                    "-t",
                    str(max(1.0, min(60.0, safe_float(total_duration_sec, 30.0)))),
                    "-vf",
                    "format=argb",
                    "-c:v",
                    "qtrle",
                    converted_path,
                ],
                check=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            return converted_path
        except Exception as error:
            warnings.append(f"{asset_prefix} alpha mov conversion failed; trying original file: {error}")
            return copied_path

    if ext == ".gif":
        # MP4 cannot preserve GIF alpha in this workflow, which causes transparent
        # GIF logos to appear on a white/solid background. Use an alpha-capable MOV.
        converted_path = os.path.abspath(os.path.join(overlay_dir, f"{asset_prefix}_gif_alpha.mov"))
        try:
            subprocess.run(
                [
                    FFMPEG_BIN,
                    "-y",
                    "-stream_loop",
                    "-1",
                    "-i",
                    copied_path,
                    "-t",
                    str(max(1.0, min(60.0, safe_float(total_duration_sec, 30.0)))),
                    "-vf",
                    "fps=15,format=argb",
                    "-c:v",
                    "qtrle",
                    converted_path,
                ],
                check=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            return converted_path
        except Exception as error:
            warnings.append(f"{asset_prefix} gif alpha mov conversion failed; trying original file: {error}")
            return copied_path

    video_key_exts = {".mp4", ".m4v"}
    if ext in video_key_exts:
        # Channel logo MP4s are produced with a fixed green chroma background.
        # Convert them to an alpha-capable MOV before placing them in the draft.
        # Despill removes the green fringe that can remain around antialiased edges.
        converted_path = os.path.abspath(os.path.join(overlay_dir, f"{asset_prefix}_green_key_alpha.mov"))
        green_key_filter = ",".join(
            [
                "chromakey=0x00FF00:0.20:0.04",
                "despill=type=green:mix=0.80:expand=0.20",
                "format=argb",
            ]
        )
        try:
            subprocess.run(
                [
                    FFMPEG_BIN,
                    "-y",
                    "-i",
                    copied_path,
                    "-vf",
                    green_key_filter,
                    "-c:v",
                    "qtrle",
                    converted_path,
                ],
                check=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            return converted_path
        except Exception as error:
            warnings.append(f"{asset_prefix} green chromakey conversion failed; trying original file: {error}")
            return copied_path

    return copied_path


def apply_video_overlay_transform(draft_content_path, overlay_asset, warnings, track_name="channel_asset_overlay"):
    summary = {
        "enabled": bool((overlay_asset or {}).get("enabled") or (overlay_asset or {}).get("path")),
        "applied": False,
        "track_name": track_name,
        "segments_count": 0,
        "position": "",
        "scale": None,
        "opacity": None,
        "reason": "disabled",
    }
    if not summary["enabled"]:
        return summary
    if not draft_content_path or not os.path.exists(draft_content_path):
        summary["reason"] = "draft_content.json not found"
        return summary

    try:
        with open(draft_content_path, "r", encoding="utf-8-sig") as file:
            draft_content = json.load(file)
    except Exception as error:
        summary["reason"] = f"failed to read draft_content: {error}"
        return summary

    track = None
    for candidate in draft_content.get("tracks", []):
        if isinstance(candidate, dict) and candidate.get("type") == "video" and candidate.get("name") == track_name:
            track = candidate
            break
    if not track:
        summary["reason"] = f"{track_name} track not found"
        return summary

    transform = get_channel_asset_transform(overlay_asset)
    segments = [segment for segment in track.get("segments", []) if isinstance(segment, dict)]
    for segment in segments:
        clip = segment.setdefault("clip", {})
        clip["scale"] = {"x": transform["scale"], "y": transform["scale"]}
        clip["transform"] = {"x": transform["transform_x"], "y": transform["transform_y"]}
        clip["alpha"] = transform["opacity"]
        if not isinstance(clip.get("flip"), dict):
            clip["flip"] = {"horizontal": False, "vertical": False}
        clip.setdefault("rotation", 0.0)
        segment["uniform_scale"] = {"on": True, "value": transform["scale"]}
        segment["visible"] = True

    try:
        with open(draft_content_path, "w", encoding="utf-8") as file:
            json.dump(draft_content, file, ensure_ascii=False, indent=4)
    except Exception as error:
        warnings.append(f"{track_name} transform save failed: {error}")
        summary["reason"] = f"failed to save draft_content: {error}"
        return summary

    summary.update(
        {
            "applied": bool(segments),
            "segments_count": len(segments),
            "position": transform["position"],
            "scale": transform["scale"],
            "opacity": transform["opacity"],
            "reason": "applied" if segments else "no overlay segments",
        }
    )
    return summary


def apply_channel_asset_overlay_transform(draft_content_path, channel_asset, warnings):
    return apply_video_overlay_transform(draft_content_path, channel_asset, warnings, "channel_asset_overlay")


def normalize_ocr_mask_config(process_config):
    raw = process_config.get("ocr_mask_overlay") if isinstance(process_config, dict) else {}
    if not isinstance(raw, dict):
        raw = {}
    zones = raw.get("zones") if isinstance(raw.get("zones"), list) else ["top", "bottom"]
    normalized_zones = [str(item).strip().lower() for item in zones if str(item).strip()]
    fixed_mask = raw.get("fixed_mask") if isinstance(raw.get("fixed_mask"), dict) else {}
    return {
        "enabled": coerce_bool(raw.get("enabled"), False),
        "mode": str(raw.get("mode") or "capcut_block_overlay"),
        "report_path": str(raw.get("report_path") or raw.get("reportPath") or "").strip(),
        "preview_path": str(raw.get("preview_path") or raw.get("previewPath") or "").strip(),
        "zones": normalized_zones or ["top", "bottom"],
        "max_regions_per_frame": max(1, min(12, int(safe_float(raw.get("max_regions_per_frame"), 4)))),
        "min_confidence": min(1.0, max(0.0, safe_float(raw.get("min_confidence"), 0.5))),
        "padding_px": max(0, int(safe_float(raw.get("padding_px"), 18))),
        "opacity": min(1.0, max(0.0, safe_float(raw.get("opacity"), 0.72))),
        "color": str(raw.get("color") or "#151515").strip() or "#151515",
        "fixed_mask": {
            "x": min(0.98, max(-0.98, safe_float(fixed_mask.get("x"), 0.0))),
            "y": min(0.98, max(-0.98, safe_float(fixed_mask.get("y"), 0.74))),
            "width": min(1.0, max(0.01, safe_float(fixed_mask.get("width"), 0.62))),
            "height": min(1.0, max(0.01, safe_float(fixed_mask.get("height"), 0.09))),
        },
    }


def is_fixed_ocr_mask_mode(mode):
    return str(mode or "").strip().lower() in {
        "fixed_template_blur_mask",
        "fixed_blur_mask",
        "fixed_blur",
        "fixed_template_blur",
    }


def ocr_box_to_capcut_transform(region, source_w, source_h, padding_px=0):
    x = safe_float(region.get("x"), 0.0) - padding_px
    y = safe_float(region.get("y"), 0.0) - padding_px
    w = safe_float(region.get("width"), 0.0) + padding_px * 2
    h = safe_float(region.get("height"), 0.0) + padding_px * 2
    if source_w <= 0 or source_h <= 0 or w <= 0 or h <= 0:
        return None
    left = max(0.0, x)
    top = max(0.0, y)
    right = min(float(source_w), left + w)
    bottom = min(float(source_h), top + h)
    if right <= left or bottom <= top:
        return None
    center_x = (left + right) / 2
    center_y = (top + bottom) / 2
    return {
        "x": round(((center_x / source_w) - 0.5) * 2, 6),
        "y": round(((center_y / source_h) - 0.5) * 2, 6),
        "width_ratio": round((right - left) / source_w, 6),
        "height_ratio": round((bottom - top) / source_h, 6),
        "source_box": {
            "x": int(round(left)),
            "y": int(round(top)),
            "width": int(round(right - left)),
            "height": int(round(bottom - top)),
        },
    }


def build_ocr_mask_records(process_config, total_duration_sec, warnings):
    config = normalize_ocr_mask_config(process_config)
    summary = {
        "enabled": config["enabled"],
        "applied": False,
        "mode": config["mode"],
        "track_name": "ocr_mask_overlay",
        "report_path": config["report_path"],
        "preview_path": config["preview_path"],
        "zones": config["zones"],
        "segments_count": 0,
        "regions_count": 0,
        "reason": "disabled",
        "source_video_modified": False,
    }
    if not config["enabled"]:
        return [], summary
    report_path = config["report_path"]
    if not report_path or not os.path.exists(report_path):
        summary["reason"] = "OCR report not found"
        warnings.append("OCR mask overlay skipped: OCR report not found.")
        return [], summary

    try:
        with open(report_path, "r", encoding="utf-8-sig") as file:
            report = json.load(file)
    except Exception as error:
        summary["reason"] = f"OCR report read failed: {error}"
        warnings.append(f"OCR mask overlay skipped: {error}")
        return [], summary

    video_info = report.get("video") if isinstance(report.get("video"), dict) else {}
    source_w = safe_float(video_info.get("width"), 0.0)
    source_h = safe_float(video_info.get("height"), 0.0)
    frames = report.get("frames") if isinstance(report.get("frames"), list) else []
    if source_w <= 0 or source_h <= 0 or not frames:
        summary["reason"] = "OCR report has no usable frames or video dimensions"
        return [], summary

    total_sec = max(0.1, safe_float(total_duration_sec, video_info.get("duration_sec") or 0.0))
    sample_interval = safe_float((report.get("sampling") or {}).get("interval_sec"), 2.0) if isinstance(report.get("sampling"), dict) else 2.0
    records = []
    allowed_zones = set(config["zones"])
    for frame_index, frame in enumerate(frames):
        if not isinstance(frame, dict):
            continue
        start_sec = min(total_sec, max(0.0, safe_float(frame.get("time_sec"), 0.0)))
        if start_sec >= total_sec:
            continue
        next_start = total_sec
        if frame_index + 1 < len(frames) and isinstance(frames[frame_index + 1], dict):
            next_start = safe_float(frames[frame_index + 1].get("time_sec"), start_sec + sample_interval)
        duration_sec = max(0.2, min(total_sec - start_sec, max(0.2, next_start - start_sec)))
        regions = []
        for region in frame.get("regions") or []:
            if not isinstance(region, dict):
                continue
            zone = str(region.get("zone") or "unknown").lower()
            confidence = safe_float(region.get("confidence"), 0.5)
            if allowed_zones and zone not in allowed_zones:
                continue
            if confidence < config["min_confidence"]:
                continue
            box = ocr_box_to_capcut_transform(region, source_w, source_h, config["padding_px"])
            if not box:
                continue
            area_ratio = safe_float(region.get("area_ratio"), box["width_ratio"] * box["height_ratio"])
            score = confidence + area_ratio * 60 + (0.15 if zone == "bottom" else 0.0)
            regions.append({
                **box,
                "zone": zone,
                "confidence": round(confidence, 3),
                "score": round(score, 4),
                "time_sec": start_sec,
                "duration_sec": duration_sec,
            })
        regions.sort(key=lambda item: item["score"], reverse=True)
        for region in regions[:config["max_regions_per_frame"]]:
            records.append(region)

    summary.update({
        "regions_count": int(report.get("regions_count") or 0),
        "segments_count": len(records),
        "applied": bool(records),
        "reason": "capcut video OCR mask blocks prepared" if records else "no OCR mask candidates after filtering",
    })
    return records, summary


def build_persistent_watermark_mask_from_records(records, video_timeline_end_us):
    candidates = [
        record for record in records
        if str(record.get("zone") or "").lower() in {"middle", "bottom"}
    ]
    if not candidates:
        return None

    # Use mapped OCR boxes instead of a fixed lower-third position. Source
    # watermarks often move after zoom/crop/mirror, so a hard-coded mask misses.
    candidates = sorted(candidates, key=lambda item: safe_float(item.get("score"), 0.0), reverse=True)[:16]
    left = min(safe_float(item.get("x"), 0.0) - safe_float(item.get("width_ratio"), 0.1) / 2 for item in candidates)
    right = max(safe_float(item.get("x"), 0.0) + safe_float(item.get("width_ratio"), 0.1) / 2 for item in candidates)
    top = min(safe_float(item.get("y"), 0.0) - safe_float(item.get("height_ratio"), 0.05) / 2 for item in candidates)
    bottom = max(safe_float(item.get("y"), 0.0) + safe_float(item.get("height_ratio"), 0.05) / 2 for item in candidates)

    width = min(0.92, max(0.22, (right - left) + 0.08))
    height = min(0.46, max(0.10, (bottom - top) + 0.06))
    center_x = min(0.98, max(-0.98, (left + right) / 2))
    center_y = min(0.98, max(-0.98, (top + bottom) / 2))

    return {
        "x": round(center_x, 6),
        "y": round(center_y, 6),
        "width_ratio": round(width, 6),
        "height_ratio": round(height, 6),
        "source_box": {
            "x": 0,
            "y": 0,
            "width": 0,
            "height": 0,
        },
        "zone": "middle_bottom",
        "confidence": max(safe_float(item.get("confidence"), 0.0) for item in candidates),
        "score": max(safe_float(item.get("score"), 0.0) for item in candidates),
        "time_sec": 0.0,
        "duration_sec": round(max(0.2, video_timeline_end_us / 1_000_000), 6),
        "source_time_sec": "persistent_watermark_from_ocr_candidates",
        "timeline_mapped": True,
        "persistent_watermark_mask": True,
        "source_records_count": len(candidates),
        "matched_video_segment_id": "full_source_video_timeline",
        "video_transform": {
            "normalized_from_mapped_ocr_candidates": True,
        },
    }


def align_ocr_mask_records_to_source_video_track(draft_content, records, warnings):
    """Convert OCR source-video coordinates/times into the edited CapCut timeline.

    OCR reports are generated from the raw/prepared source video. The draft can
    then mirror, zoom, pan, trim, and speed-adjust that source into many clips.
    CapCut effect masks live on the final canvas timeline, so raw OCR boxes must
    be remapped through the matching source_video segment.
    """
    if not isinstance(draft_content, dict) or not records:
        return records, {
            "applied": False,
            "reason": "no draft content or records",
            "input_records": len(records or []),
            "output_records": len(records or []),
        }

    source_track = None
    for track in draft_content.get("tracks") or []:
        if isinstance(track, dict) and track.get("type") == "video" and track.get("name") == "source_video":
            source_track = track
            break
    if not source_track:
        return records, {
            "applied": False,
            "reason": "source_video track not found",
            "input_records": len(records),
            "output_records": len(records),
        }

    video_segments = [
        segment for segment in (source_track.get("segments") or [])
        if isinstance(segment, dict)
        and isinstance(segment.get("source_timerange"), dict)
        and isinstance(segment.get("target_timerange"), dict)
    ]
    if not video_segments:
        return records, {
            "applied": False,
            "reason": "source_video has no mapped segments",
            "input_records": len(records),
            "output_records": len(records),
        }

    video_timeline_end_us = 0
    for segment in video_segments:
        target = segment.get("target_timerange") or {}
        video_timeline_end_us = max(video_timeline_end_us, int(target.get("start") or 0) + int(target.get("duration") or 0))

    def find_segment_for_source_time(source_time_us):
        for segment in video_segments:
            src = segment.get("source_timerange") or {}
            src_start = int(src.get("start") or 0)
            src_duration = max(1, int(src.get("duration") or 0))
            if src_start <= source_time_us < src_start + src_duration:
                return segment
        # OCR sampling often lands a few ms outside a trimmed scene boundary.
        tolerance_us = 250_000
        closest = None
        closest_gap = None
        for segment in video_segments:
            src = segment.get("source_timerange") or {}
            src_start = int(src.get("start") or 0)
            src_end = src_start + max(1, int(src.get("duration") or 0))
            gap = min(abs(source_time_us - src_start), abs(source_time_us - src_end))
            if gap <= tolerance_us and (closest_gap is None or gap < closest_gap):
                closest = segment
                closest_gap = gap
        return closest

    aligned = []
    skipped = 0
    mirrored_count = 0
    for record in records:
        source_time_us = microseconds(record.get("time_sec"))
        segment = find_segment_for_source_time(source_time_us)
        if not segment:
            skipped += 1
            continue

        src = segment.get("source_timerange") or {}
        tgt = segment.get("target_timerange") or {}
        clip = segment.get("clip") if isinstance(segment.get("clip"), dict) else {}
        src_start = int(src.get("start") or 0)
        src_duration = max(1, int(src.get("duration") or 0))
        tgt_start = int(tgt.get("start") or 0)
        tgt_duration = max(1, int(tgt.get("duration") or 0))
        source_offset_ratio = min(1.0, max(0.0, (source_time_us - src_start) / src_duration))
        timeline_start_us = tgt_start + int(round(source_offset_ratio * tgt_duration))
        duration_scale = tgt_duration / src_duration
        timeline_duration_us = max(200_000, int(round(microseconds(record.get("duration_sec")) * duration_scale)))
        timeline_duration_us = min(timeline_duration_us, max(200_000, tgt_start + tgt_duration - timeline_start_us))

        scale_obj = clip.get("scale") if isinstance(clip.get("scale"), dict) else {}
        transform_obj = clip.get("transform") if isinstance(clip.get("transform"), dict) else {}
        flip_obj = clip.get("flip") if isinstance(clip.get("flip"), dict) else {}
        scale_x = safe_float(scale_obj.get("x"), safe_float(segment.get("uniform_scale", {}).get("value") if isinstance(segment.get("uniform_scale"), dict) else 1.0, 1.0))
        scale_y = safe_float(scale_obj.get("y"), scale_x)
        transform_x = safe_float(transform_obj.get("x"), 0.0)
        transform_y = safe_float(transform_obj.get("y"), 0.0)

        x = safe_float(record.get("x"), 0.0)
        y = safe_float(record.get("y"), 0.0)
        if flip_obj.get("horizontal") is True:
            x = -x
            mirrored_count += 1
        if flip_obj.get("vertical") is True:
            y = -y

        # Map raw source normalized coordinates into the final scaled/panned
        # canvas. Width/height expand with zoom because the underlying video is
        # enlarged before the effect mask is visually aligned.
        mapped = dict(record)
        mapped["x"] = round(min(0.98, max(-0.98, x * scale_x + transform_x)), 6)
        mapped["y"] = round(min(0.98, max(-0.98, y * scale_y + transform_y)), 6)
        mapped["width_ratio"] = round(min(1.0, max(0.01, safe_float(record.get("width_ratio"), 0.1) * scale_x)), 6)
        mapped["height_ratio"] = round(min(1.0, max(0.01, safe_float(record.get("height_ratio"), 0.05) * scale_y)), 6)
        mapped["time_sec"] = round(timeline_start_us / 1_000_000, 6)
        mapped["duration_sec"] = round(timeline_duration_us / 1_000_000, 6)
        mapped["source_time_sec"] = record.get("time_sec")
        mapped["timeline_mapped"] = True
        mapped["matched_video_segment_id"] = segment.get("id", "")
        mapped["video_transform"] = {
            "scale_x": round(scale_x, 6),
            "scale_y": round(scale_y, 6),
            "transform_x": round(transform_x, 6),
            "transform_y": round(transform_y, 6),
            "flip_horizontal": bool(flip_obj.get("horizontal")),
            "flip_vertical": bool(flip_obj.get("vertical")),
        }
        aligned.append(mapped)

    persistent_records = [
        record for record in aligned
        if str(record.get("zone") or "").lower() in {"middle", "bottom"}
    ]
    if persistent_records:
        persistent = build_persistent_watermark_mask_from_records(persistent_records, video_timeline_end_us)
        # OCR often detects only fragmented letters, which creates tiny masks in
        # the wrong places. Normalize candidates into one stable full-duration
        # CapCut mask that the user can still tweak manually.
        aligned = [persistent]

    summary = {
        "applied": True,
        "reason": "mapped OCR source coordinates to edited source_video timeline",
        "input_records": len(records),
        "output_records": len(aligned),
        "skipped_records": skipped,
        "mirrored_records": mirrored_count,
        "persistent_bottom_watermark_mask": bool(persistent_records),
    }
    if skipped:
        warnings.append(f"OCR mask skipped {skipped} records outside edited source_video timeline")
    return aligned, summary


def create_ocr_mask_video(mask_video_path, width, height, duration_sec, color="#151515", warnings=None):
    warnings = warnings if isinstance(warnings, list) else []
    safe_color = str(color or "#151515").strip()
    if safe_color.startswith("#"):
        safe_color = f"0x{safe_color[1:]}"
    elif not safe_color.startswith("0x"):
        safe_color = "0x151515"
    safe_width = max(16, int(safe_float(width, 1080)))
    safe_height = max(16, int(safe_float(height, 1920)))
    safe_duration = max(0.5, safe_float(duration_sec, 30.0))
    try:
        subprocess.run(
            [
                FFMPEG_BIN,
                "-y",
                "-f",
                "lavfi",
                "-i",
                f"color=c={safe_color}:s={safe_width}x{safe_height}:r=30:d={safe_duration}",
                "-an",
                "-vf",
                "format=yuv420p",
                "-movflags",
                "+faststart",
                mask_video_path,
            ],
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        return mask_video_path
    except Exception as error:
        warnings.append(f"OCR mask video creation failed: {error}")
        return ""


def add_ocr_mask_video_segments(script, process_config, overlay_dir, total_duration_sec, canvas_width, canvas_height, warnings):
    config = normalize_ocr_mask_config(process_config)
    if is_fixed_ocr_mask_mode(config.get("mode")):
        return {
            "enabled": config["enabled"],
            "applied": False,
            "mode": config["mode"],
            "track_name": "ocr_mask_overlay",
            "report_path": "",
            "preview_path": "",
            "zones": config["zones"],
            "segments_count": 0,
            "regions_count": 0,
            "reason": "fixed blur mask mode; OCR detection video fallback skipped",
            "source_video_modified": False,
            "fixed_mask": config["fixed_mask"],
        }
    records, summary = build_ocr_mask_records(process_config, total_duration_sec, warnings)
    if not records:
        return summary

    if str(config.get("mode") or "").strip().lower() in {"template_blur_mask", "template_blur", "blur_template", "capcut_block_overlay"}:
        summary["applied"] = False
        summary["segments_count"] = 0
        summary["reason"] = "postprocess OCR mask mode; prebuilt black fallback video overlay disabled"
        return summary

    os.makedirs(overlay_dir, exist_ok=True)
    mask_video_path = os.path.abspath(os.path.join(overlay_dir, "ocr_mask_box.mp4"))
    mask_video_path = create_ocr_mask_video(
        mask_video_path,
        canvas_width,
        canvas_height,
        total_duration_sec,
        config["color"],
        warnings,
    )
    if not mask_video_path or not os.path.exists(mask_video_path):
        summary["applied"] = False
        summary["reason"] = "OCR mask video material could not be created"
        return summary

    try:
        mask_material = cc.VideoMaterial(mask_video_path)
        material_duration_us = int(mask_material.duration or 0)
        if material_duration_us <= 0:
            summary["applied"] = False
            summary["reason"] = "OCR mask video material duration invalid"
            warnings.append(summary["reason"])
            return summary
        script.add_material(mask_material)
        for record in records:
            start_us = microseconds(record["time_sec"])
            duration_us = max(200_000, microseconds(record["duration_sec"]))
            script.add_segment(
                cc.VideoSegment(
                    material=mask_material,
                    source_timerange=cc.Timerange(start=0, duration=min(duration_us, material_duration_us)),
                    target_timerange=cc.Timerange(start=start_us, duration=duration_us),
                ),
                track_name="ocr_mask_overlay",
            )
        summary["applied"] = True
        summary["segments_count"] = len(records)
        summary["reason"] = "capcut video OCR mask blocks created"
        summary["mask_video_path"] = mask_video_path
    except Exception as error:
        summary["applied"] = False
        summary["reason"] = f"OCR mask video segment creation failed: {error}"
        warnings.append(summary["reason"])
    return summary


def find_template_ocr_mask_effect(template_doc):
    if not isinstance(template_doc, dict):
        return None
    material_index = build_material_index_by_id(template_doc)
    aliases = {
        "template_ocr_mask",
        "template_blur_mask",
        "ocr_mask",
        "blur_mask",
        "mosaic_mask",
        "blur",
        "mosaic",
        "\ud750\ub9ac\uac8c",
        "\ube14\ub7ec",
        "\ubaa8\uc790\uc774\ud06c",
        "\ub9c8\uc2a4\ud06c",
        "\uc6cc\ud130\ub9c8\ud06c",
        "\u307c\u304b\u3057",
        "\u30d6\u30e9\u30fc",
        "\u30e2\u30b6\u30a4\u30af",
    }
    candidate_ids = set()
    for material in (template_doc.get("materials") or {}).get("video_effects", []) or []:
        if not isinstance(material, dict):
            continue
        text = " ".join(
            str(material.get(key) or "")
            for key in ["name", "material_name", "category_name", "type", "resource_id", "effect_id"]
        ).strip().lower()
        text = f"{text} {json.dumps(material, ensure_ascii=False).lower()}"
        if any(alias in text for alias in aliases):
            candidate_ids.add(material.get("id"))
    if not candidate_ids:
        return None

    for track in template_doc.get("tracks") or []:
        if not isinstance(track, dict) or track.get("type") != "effect":
            continue
        for segment in track.get("segments") or []:
            if not isinstance(segment, dict):
                continue
            material_id = segment.get("material_id")
            if material_id not in candidate_ids:
                continue
            material_entry = material_index.get(material_id)
            if material_entry:
                _, material = material_entry
                return {
                    "track": track,
                    "segment": segment,
                    "material": material,
                }
    for material_id in candidate_ids:
        material_entry = material_index.get(material_id)
        if material_entry:
            _, material = material_entry
            return {
                "track": None,
                "segment": None,
                "material": material,
            }
    return None


def apply_ocr_mask_effect_template_to_draft(draft_content, template_doc, records, total_duration_sec, warnings):
    template_entry = find_template_ocr_mask_effect(template_doc)
    if not template_entry:
        return {
            "applied": False,
            "segments_count": 0,
            "reason": "template OCR blur/mosaic effect not found",
            "template_name": "",
        }

    template_material = template_entry.get("material")
    template_segment = template_entry.get("segment")
    if not isinstance(template_material, dict):
        return {
            "applied": False,
            "segments_count": 0,
            "reason": "template OCR effect material invalid",
            "template_name": "",
        }

    effect_track = None
    for track in draft_content.setdefault("tracks", []):
        if isinstance(track, dict) and track.get("type") == "effect" and track.get("name") == "ocr_mask_effect":
            effect_track = track
            break
    if effect_track is None:
        effect_track = {
            "id": new_capcut_id(),
            "type": "effect",
            "segments": [],
            "flag": 1,
            "attribute": 0,
            "name": "ocr_mask_effect",
            "is_default_name": False,
        }
        draft_content.setdefault("tracks", []).append(effect_track)
    effect_track["segments"] = []

    video_effects = ensure_material_category(draft_content, "video_effects")
    template_name = str(template_material.get("name") or template_material.get("material_name") or "OCR mask effect")
    for index, record in enumerate(records):
        material = json.loads(json.dumps(template_material))
        material_id = new_capcut_id()
        material["id"] = material_id
        material["name"] = f"{template_name} OCR {index + 1}"
        material["bind_segment_id"] = ""
        material["render_index"] = 13000 + index
        material["track_render_index"] = 0
        for time_key in ["time_range", "apply_time_range"]:
            if isinstance(material.get(time_key), dict):
                material[time_key] = {
                    "start": microseconds(record["time_sec"]),
                    "duration": max(200_000, microseconds(record["duration_sec"])),
                }
        effect_masks = material.get("effect_mask")
        if isinstance(effect_masks, list):
            for mask in effect_masks:
                if not isinstance(mask, dict):
                    continue
                config = mask.setdefault("config", {})
                config["centerX"] = safe_float(record.get("x"), 0.0)
                config["centerY"] = safe_float(record.get("y"), 0.0)
                config["width"] = max(0.01, safe_float(record.get("width_ratio"), 0.1))
                config["height"] = max(0.01, safe_float(record.get("height_ratio"), 0.05))
                config.setdefault("rotation", 0.0)
                config.setdefault("feather", 0.0)
                config.setdefault("expansion", 0.0)
                config.setdefault("roundCorner", 0.0)
                config.setdefault("invert", False)
        video_effects.append(material)

        if isinstance(template_segment, dict):
            segment = json.loads(json.dumps(template_segment))
        else:
            segment = {
                "id": new_capcut_id(),
                "source_timerange": None,
                "render_timerange": {"start": 0, "duration": 0},
                "speed": 1.0,
                "visible": True,
                "extra_material_refs": [],
                "clip": None,
                "uniform_scale": None,
            }
        segment["id"] = new_capcut_id()
        segment["material_id"] = material_id
        segment["extra_material_refs"] = []
        segment["render_index"] = 13000 + index
        segment["track_render_index"] = 0
        upsert_timerange(segment, microseconds(record["time_sec"]), max(200_000, microseconds(record["duration_sec"])))
        segment["ocr_mask_box"] = record["source_box"]
        segment["ocr_mask_zone"] = record["zone"]
        segment["ocr_mask_confidence"] = record["confidence"]
        effect_track["segments"].append(segment)

    return {
        "applied": bool(records),
        "segments_count": len(records),
        "reason": "template OCR blur/mosaic effect cloned",
        "template_name": template_name,
    }


def apply_ocr_mask_overlay_to_draft(draft_content_path, process_config, total_duration_sec, canvas_width, canvas_height, warnings, template_doc=None):
    config = normalize_ocr_mask_config(process_config)
    if is_fixed_ocr_mask_mode(config.get("mode")):
        summary = {
            "enabled": config["enabled"],
            "applied": False,
            "mode": config["mode"],
            "track_name": "ocr_mask_effect",
            "report_path": "",
            "preview_path": "",
            "zones": config["zones"],
            "segments_count": 0,
            "regions_count": 0,
            "reason": "disabled",
            "source_video_modified": False,
            "fixed_mask": config["fixed_mask"],
        }
        if not config["enabled"]:
            return summary
        if not draft_content_path or not os.path.exists(draft_content_path):
            summary["reason"] = "draft_content.json not found"
            return summary
        try:
            with open(draft_content_path, "r", encoding="utf-8-sig") as file:
                draft_content = json.load(file)
        except Exception as error:
            summary["reason"] = f"draft_content read failed: {error}"
            return summary

        duration_sec = max(0.2, safe_float(total_duration_sec, 0.0))
        fixed_record = {
            "time_sec": 0.0,
            "duration_sec": duration_sec,
            "x": config["fixed_mask"]["x"],
            "y": config["fixed_mask"]["y"],
            "width_ratio": config["fixed_mask"]["width"],
            "height_ratio": config["fixed_mask"]["height"],
            "source_box": {
                "x": int(round((config["fixed_mask"]["x"] + 1.0) * 0.5 * max(1, canvas_width))),
                "y": int(round((config["fixed_mask"]["y"] + 1.0) * 0.5 * max(1, canvas_height))),
                "width": int(round(config["fixed_mask"]["width"] * max(1, canvas_width))),
                "height": int(round(config["fixed_mask"]["height"] * max(1, canvas_height))),
            },
            "zone": "fixed",
            "confidence": 1.0,
        }
        effect_summary = apply_ocr_mask_effect_template_to_draft(
            draft_content,
            template_doc,
            [fixed_record],
            duration_sec,
            warnings,
        )
        tracks = draft_content.setdefault("tracks", [])
        tracks[:] = [
            track for track in tracks
            if not (
                isinstance(track, dict)
                and track.get("name") == "ocr_mask_overlay"
                and track.get("type") in {"video", "text"}
            )
        ]
        try:
            with open(draft_content_path, "w", encoding="utf-8") as file:
                json.dump(draft_content, file, ensure_ascii=False, indent=4)
        except Exception as error:
            summary["reason"] = f"draft_content save failed: {error}"
            return summary
        summary["applied"] = bool(effect_summary.get("applied"))
        summary["segments_count"] = int(effect_summary.get("segments_count") or 0)
        summary["regions_count"] = 1 if summary["applied"] else 0
        summary["reason"] = effect_summary.get("reason") or (
            "fixed template blur mask applied" if summary["applied"] else "template blur/mosaic effect not found"
        )
        summary["template_effect_name"] = effect_summary.get("template_name", "")
        return summary

    records, summary = build_ocr_mask_records(process_config, total_duration_sec, warnings)
    if not records:
        return summary
    if not draft_content_path or not os.path.exists(draft_content_path):
        summary["applied"] = False
        summary["reason"] = "draft_content.json not found"
        return summary

    try:
        with open(draft_content_path, "r", encoding="utf-8-sig") as file:
            draft_content = json.load(file)
    except Exception as error:
        summary["applied"] = False
        summary["reason"] = f"draft_content read failed: {error}"
        return summary

    records, timeline_mapping_summary = align_ocr_mask_records_to_source_video_track(
        draft_content,
        records,
        warnings,
    )
    summary["timeline_mapping"] = timeline_mapping_summary
    if not records:
        summary["applied"] = False
        summary["segments_count"] = 0
        summary["reason"] = "no OCR mask candidates inside edited source_video timeline"
        return summary

    tracks = draft_content.setdefault("tracks", [])
    # Remove older text-background mask tracks; CapCut can ignore those backgrounds.
    tracks[:] = [
        track for track in tracks
        if not (
            isinstance(track, dict)
            and track.get("name") == "ocr_mask_overlay"
            and track.get("type") == "text"
        )
    ]

    effect_summary = apply_ocr_mask_effect_template_to_draft(
        draft_content,
        template_doc,
        records,
        total_duration_sec,
        warnings,
    )
    if effect_summary.get("applied"):
        # If a CapCut-native blur/mosaic mask template exists, prefer it and
        # remove generated black video boxes so the result is editable in CapCut.
        tracks[:] = [
            track for track in tracks
            if not (
                isinstance(track, dict)
                and track.get("name") == "ocr_mask_overlay"
                and track.get("type") == "video"
            )
        ]
        try:
            with open(draft_content_path, "w", encoding="utf-8") as file:
                json.dump(draft_content, file, ensure_ascii=False, indent=4)
        except Exception as error:
            summary["applied"] = False
            summary["reason"] = f"draft_content save failed: {error}"
            return summary
        summary["applied"] = True
        summary["mode"] = "template_blur_mask"
        summary["segments_count"] = effect_summary.get("segments_count", 0)
        summary["reason"] = effect_summary.get("reason", "template OCR effect cloned")
        summary["template_effect_name"] = effect_summary.get("template_name", "")
        summary["records_preview"] = records[:20]
        return summary

    # Do not leave opaque black fallback boxes in the draft. The intended UX is
    # to clone the user's CapCut blur/mosaic template marker ("흐리게"). If that
    # template effect is missing or cannot be mapped, skip the overlay and keep
    # the OCR report/preview for manual review instead of producing bad masks.
    tracks[:] = [
        track for track in tracks
        if not (
            isinstance(track, dict)
            and track.get("name") == "ocr_mask_overlay"
            and track.get("type") == "video"
        )
    ]
    try:
        with open(draft_content_path, "w", encoding="utf-8") as file:
            json.dump(draft_content, file, ensure_ascii=False, indent=4)
    except Exception as error:
        summary["applied"] = False
        summary["reason"] = f"draft_content save failed after removing fallback OCR boxes: {error}"
        return summary
    summary["applied"] = False
    summary["mode"] = "template_blur_mask_missing"
    summary["segments_count"] = 0
    summary["reason"] = effect_summary.get("reason", "template OCR blur/mosaic effect not found; black fallback boxes removed")
    summary["records_preview"] = records[:20]
    warnings.append("OCR mask overlay skipped: template blur/mosaic effect marker not found; black fallback boxes were removed.")
    return summary

    mask_track = None
    for track in tracks:
        if isinstance(track, dict) and track.get("type") == "video" and track.get("name") == "ocr_mask_overlay":
            mask_track = track
            break
    if mask_track is None:
        summary["applied"] = False
        summary["reason"] = "OCR mask video track not found"
        return summary

    config = normalize_ocr_mask_config(process_config)
    segments = [segment for segment in mask_track.get("segments", []) if isinstance(segment, dict)]
    for index, segment in enumerate(segments):
        if index >= len(records):
            break
        record = records[index]
        clip = segment.setdefault("clip", {})
        # The mask material is a full-canvas black video, so scale x/y directly
        # to the OCR box ratio. This produces an actual visible video overlay box.
        clip["transform"] = {"x": record["x"], "y": record["y"]}
        clip["scale"] = {
            "x": max(0.01, record["width_ratio"]),
            "y": max(0.01, record["height_ratio"]),
        }
        clip["alpha"] = config["opacity"]
        clip.setdefault("rotation", 0.0)
        clip.setdefault("flip", {"horizontal": False, "vertical": False})
        segment["uniform_scale"] = {"on": False, "value": 1.0}
        segment["render_index"] = 12000 + index
        segment["track_render_index"] = 0
        segment["caption_template_marker"] = "OCR_MASK_OVERLAY"
        segment["ocr_mask_box"] = record["source_box"]
        segment["ocr_mask_zone"] = record["zone"]
        segment["ocr_mask_confidence"] = record["confidence"]

    # Drop any leftover unmatched mask segments so stale boxes do not survive.
    if len(segments) > len(records):
        mask_track["segments"] = segments[:len(records)]

    try:
        with open(draft_content_path, "w", encoding="utf-8") as file:
            json.dump(draft_content, file, ensure_ascii=False, indent=4)
    except Exception as error:
        summary["applied"] = False
        summary["reason"] = f"draft_content save failed: {error}"
        return summary

    summary["applied"] = True
    summary["segments_count"] = min(len(segments), len(records))
    summary["reason"] = "capcut video OCR mask blocks created"
    summary["records_preview"] = records[:20]
    return summary

def apply_process_template_clone_mode(generated_draft_content_path, template_doc, process_config, explainer_blocks, total_duration_sec, template_root="", draft_path=""):
    with open(generated_draft_content_path, "r", encoding="utf-8-sig") as file:
        generated = json.load(file)

    expected_markers = expected_process_caption_template_markers(process_config, explainer_blocks)
    template_markers = find_template_text_marker_assets(template_doc, expected_markers)
    strict_variant_markers = bool(expected_markers)
    legacy_explainer_entry = None if strict_variant_markers else (
        template_markers.get("TEMPLATE_EXPLAINER") or template_markers.get("TEMPLATE_SUBTITLE")
    )
    full_caption_entry = template_markers.get("TEMPLATE_FULL_CAPTION") or legacy_explainer_entry
    highlight_explainer_entry = template_markers.get("TEMPLATE_HIGHLIGHT_EXPLAINER") or legacy_explainer_entry
    if not expected_markers and not (full_caption_entry or highlight_explainer_entry):
        expected_markers.append("TEMPLATE_EXPLAINER")
    optional_markers = expected_markers if strict_variant_markers else [
        "TEMPLATE_FULL_CAPTION",
        "TEMPLATE_HIGHLIGHT_EXPLAINER",
        "TEMPLATE_EXPLAINER",
        "TEMPLATE_STEP_LABEL",
        "TEMPLATE_METRIC",
        "TEMPLATE_CALLOUT",
        "TEMPLATE_SOURCE_NOTE",
    ]
    missing_markers = [marker for marker in expected_markers if marker not in template_markers]
    found_markers = sorted(list(template_markers.keys()))

    tracks = generated.setdefault("tracks", [])

    def get_or_create_text_track(name):
        for track in tracks:
            if isinstance(track, dict) and track.get("type") == "text" and track.get("name") == name:
                if not isinstance(track.get("segments"), list):
                    track["segments"] = []
                track["visible"] = True
                return track
        new_track = {
            "id": new_capcut_id(),
            "type": "text",
            "segments": [],
            "flag": 1,
            "attribute": 0,
            "name": name,
            "is_default_name": False,
            "visible": True,
        }
        tracks.append(new_track)
        return new_track

    explainer_track = get_or_create_text_track("process_explainer")

    source_to_target_id_map = {}
    template_sources = {}
    explainer_position_adjustments = []
    text_style_profile_applications = []
    template_background_summary = apply_template_background_layer(
        generated,
        template_doc,
        template_root,
        draft_path or os.path.dirname(generated_draft_content_path),
        total_duration_sec,
        source_to_target_id_map,
    )
    template_frame_overlay_summary = {
        "applied": False,
        "reason": "disabled: frame presets are applied manually in CapCut",
        "segments_count": 0,
    }

    def clone_segment_from_entry(
        marker_entry,
        text_value,
        start_us,
        duration_us,
        role_name="",
        style_profile="",
        apply_style_profile=False,
        allow_dynamic_position=False,
    ):
        if marker_entry is None:
            return None
        original_segment = marker_entry["segment"]
        original_material = marker_entry["material"]

        cloned_material = json.loads(json.dumps(original_material))
        old_material_id = cloned_material.get("id")
        new_material_id = new_capcut_id()
        cloned_material["id"] = new_material_id
        set_material_text_value(cloned_material, text_value)
        ensure_material_category(generated, "texts").append(cloned_material)
        if isinstance(old_material_id, str) and old_material_id:
            source_to_target_id_map[old_material_id] = new_material_id

        cloned_segment = json.loads(json.dumps(original_segment))
        cloned_segment["id"] = new_capcut_id()
        cloned_segment["material_id"] = new_material_id
        upsert_timerange(cloned_segment, start_us, duration_us)
        if apply_style_profile:
            profile_result = apply_process_caption_style_profile(cloned_material, cloned_segment, style_profile)
            if profile_result.get("applied"):
                profile_result["role_name"] = role_name
                profile_result["start_sec"] = round(start_us / 1_000_000, 3)
                profile_result["duration_sec"] = round(duration_us / 1_000_000, 3)
                text_style_profile_applications.append(profile_result)
        if role_name == "explainer" and allow_dynamic_position:
            adjustment = apply_dynamic_explainer_position(cloned_segment, text_value)
            if adjustment:
                adjustment["start_sec"] = round(start_us / 1_000_000, 3)
                adjustment["duration_sec"] = round(duration_us / 1_000_000, 3)
                explainer_position_adjustments.append(adjustment)
        cloned_segment["extra_material_refs"] = clone_material_dependencies(
            template_doc,
            generated,
            cloned_segment.get("extra_material_refs") or [],
            source_to_target_id_map,
        )
        return cloned_segment

    def clone_template_refs_fresh(ref_ids):
        cloned_refs = []
        template_index = build_material_index_by_id(template_doc)
        for ref_id in ref_ids or []:
            if not isinstance(ref_id, str) or not ref_id:
                continue
            template_ref_entry = template_index.get(ref_id)
            if template_ref_entry is None:
                cloned_refs.append(ref_id)
                continue
            category, item = template_ref_entry
            cloned_item = json.loads(json.dumps(item))
            old_id = cloned_item.get("id")
            new_id = new_capcut_id()
            cloned_item["id"] = new_id
            ensure_material_category(generated, category).append(cloned_item)
            if old_id:
                source_to_target_id_map[f"{old_id}:{new_id}"] = new_id
            cloned_refs.append(new_id)
        return cloned_refs

    def overlay_value(key, fallback_text):
        raw = process_config.get(key) if isinstance(process_config, dict) else {}
        if isinstance(raw, dict) and str(raw.get("text") or "").strip():
            return str(raw.get("text")).strip()
        return fallback_text

    total_us = max(1, microseconds(total_duration_sec))
    channel_asset_raw = process_config.get("channel_asset") if isinstance(process_config, dict) and isinstance(process_config.get("channel_asset"), dict) else {}
    replace_channel_tag_text = True
    channel_repeat = False
    channel_repeat_interval_us = 0
    template_sources["channel_tag"] = "disabled: channel tag text overlay is no longer used"

    explainer_segments = []
    explainer_template_usage = []
    use_simple_process_caption_track = any(
        str(block.get("style_profile") or block.get("styleProfile") or "").strip() == "full_cut_caption"
        for block in explainer_blocks
        if isinstance(block, dict)
    )

    def select_explainer_marker_for_block(block):
        profile = str(block.get("style_profile") or block.get("styleProfile") or "").strip()
        if profile == "highlight_explainer":
            if template_markers.get("TEMPLATE_HIGHLIGHT_EXPLAINER"):
                return template_markers["TEMPLATE_HIGHLIGHT_EXPLAINER"], "TEMPLATE_HIGHLIGHT_EXPLAINER", False
            if legacy_explainer_entry and not strict_variant_markers and not full_caption_entry:
                return legacy_explainer_entry, "TEMPLATE_EXPLAINER_FALLBACK_FOR_HIGHLIGHT", True
            return None, "TEMPLATE_HIGHLIGHT_EXPLAINER_MISSING", False
        if profile == "full_cut_caption":
            if template_markers.get("TEMPLATE_FULL_CAPTION"):
                return template_markers["TEMPLATE_FULL_CAPTION"], "TEMPLATE_FULL_CAPTION", False
            if legacy_explainer_entry and not strict_variant_markers:
                return legacy_explainer_entry, "TEMPLATE_EXPLAINER_FALLBACK_FOR_FULL", True
            return None, "TEMPLATE_FULL_CAPTION_MISSING", False
        if legacy_explainer_entry:
            return legacy_explainer_entry, "TEMPLATE_EXPLAINER", True
        return full_caption_entry or highlight_explainer_entry, "TEMPLATE_CAPTION_FALLBACK", False

    def template_content_font_size(material):
        content_json = parse_json_text_content(material.get("content") if isinstance(material, dict) else None)
        if not isinstance(content_json, dict):
            return None
        styles = content_json.get("styles")
        if not isinstance(styles, list):
            return None
        for style_item in styles:
            if isinstance(style_item, dict) and style_item.get("size") is not None:
                return safe_float(style_item.get("size"), 0.0)
        return None

    def template_content_style_colors(material):
        result = {}
        content_json = parse_json_text_content(material.get("content") if isinstance(material, dict) else None)
        if not isinstance(content_json, dict):
            return result
        styles = content_json.get("styles")
        if not isinstance(styles, list):
            return result
        for style_item in styles:
            if not isinstance(style_item, dict):
                continue
            fill = style_item.get("fill")
            if isinstance(fill, dict):
                solid = ((fill.get("content") or {}).get("solid") if isinstance(fill.get("content"), dict) else None)
                if isinstance(solid, dict):
                    if isinstance(solid.get("color"), list):
                        result["fill_rgb"] = solid.get("color")
                    if solid.get("alpha") is not None:
                        result["fill_alpha"] = solid.get("alpha")
            strokes = style_item.get("strokes")
            if isinstance(strokes, list) and strokes:
                stroke = next((item for item in strokes if isinstance(item, dict)), None)
                if isinstance(stroke, dict):
                    if stroke.get("width") is not None:
                        result["border_width"] = stroke.get("width")
                    if stroke.get("alpha") is not None:
                        result["border_alpha"] = stroke.get("alpha")
                    solid = ((stroke.get("content") or {}).get("solid") if isinstance(stroke.get("content"), dict) else None)
                    if isinstance(solid, dict):
                        if isinstance(solid.get("color"), list):
                            result["outline_rgb"] = solid.get("color")
                        if solid.get("alpha") is not None:
                            result["outline_alpha"] = solid.get("alpha")
            break
        return result

    def template_content_font_fields(material):
        result = {}
        content_json = parse_json_text_content(material.get("content") if isinstance(material, dict) else None)
        if not isinstance(content_json, dict):
            return result
        styles = content_json.get("styles")
        if not isinstance(styles, list):
            return result
        for style_item in styles:
            if not isinstance(style_item, dict):
                continue
            font = style_item.get("font")
            if not isinstance(font, dict):
                continue
            for source_key, target_key in [
                ("path", "font_path"),
                ("name", "font_name"),
                ("title", "font_title"),
                ("id", "font_id"),
                ("resource_id", "font_resource_id"),
                ("source_platform", "font_source_platform"),
                ("category_name", "font_category_name"),
                ("category_id", "font_category_id"),
                ("third_resource_id", "font_third_resource_id"),
            ]:
                value = font.get(source_key)
                if value not in (None, ""):
                    result[target_key] = value
            break
        return result

    def template_content_font_size(material):
        content_json = parse_json_text_content(material.get("content") if isinstance(material, dict) else None)
        if not isinstance(content_json, dict):
            return None
        styles = content_json.get("styles")
        if not isinstance(styles, list):
            return None
        for style_item in styles:
            if isinstance(style_item, dict) and style_item.get("size") is not None:
                return safe_float(style_item.get("size"), 0.0)
        return None

    def template_style_overrides_from_marker(marker_name, style_profile):
        if not isinstance(template_doc, dict):
            return {}
        entries = find_template_text_marker_assets(template_doc, [marker_name])
        entry = entries.get(marker_name) if isinstance(entries, dict) else None
        if not isinstance(entry, dict):
            return {}
        material = entry.get("material")
        segment = entry.get("segment")
        if not isinstance(material, dict) or not isinstance(segment, dict):
            return {}
        clip = segment.get("clip") if isinstance(segment.get("clip"), dict) else {}
        transform = clip.get("transform") if isinstance(clip.get("transform"), dict) else {}
        scale = clip.get("scale") if isinstance(clip.get("scale"), dict) else {}
        overrides = {
            "marker": marker_name,
            "style_profile": style_profile,
            "font_size": template_content_font_size(material) or safe_float(material.get("font_size"), HIGHLIGHT_EXPLAINER_FONT_SIZE if style_profile == "highlight_explainer" else FULL_CUT_CAPTION_FONT_SIZE),
            "x": safe_float(transform.get("x"), HIGHLIGHT_EXPLAINER_X if style_profile == "highlight_explainer" else FULL_CUT_CAPTION_X),
            "y": safe_float(transform.get("y"), HIGHLIGHT_EXPLAINER_Y if style_profile == "highlight_explainer" else FULL_CUT_CAPTION_Y),
            "scale_x": safe_float(scale.get("x"), 1.0),
            "scale_y": safe_float(scale.get("y"), 1.0),
        }
        overrides.update(material_content_style_colors(material))
        for field in [
            "fixed_width",
            "fixed_height",
            "line_max_width",
            "line_spacing",
            "line_feed",
            "typesetting",
            "alignment",
            "oneline_cutoff",
            "force_apply_line_max_width",
            "text_color",
            "text_alpha",
            "global_alpha",
            "border_color",
            "border_alpha",
            "border_width",
            "border_mode",
            "shadow_color",
            "shadow_alpha",
            "shadow_distance",
            "shadow_angle",
            "shadow_smoothing",
            "bold_width",
            "bold_width_rate",
            "background_color",
            "background_alpha",
            "background_round_radius",
            "font_path",
            "font_name",
            "font_title",
            "font_id",
            "font_resource_id",
            "font_source_platform",
            "font_category_name",
            "font_category_id",
            "font_third_resource_id",
            "fonts",
        ]:
            if field in material:
                overrides[field] = material.get(field)
        content_font_fields = template_content_font_fields(material)
        for field, value in content_font_fields.items():
            if value not in (None, ""):
                overrides[field] = value
        content_font_path = first_non_empty_string(content_font_fields.get("font_path"), overrides.get("font_path"))
        if content_font_path:
            font_file_name = os.path.splitext(os.path.basename(content_font_path))[0]
            if font_file_name and not first_non_empty_string(content_font_fields.get("font_name"), content_font_fields.get("font_title")):
                overrides["font_name"] = font_file_name
                overrides["font_title"] = font_file_name
        return overrides

    def fallback_style_overrides_for_segment(is_highlight):
        if is_highlight:
            return template_style_overrides_from_marker("TEMPLATE_HIGHLIGHT_EXPLAINER", "highlight_explainer")
        return template_style_overrides_from_marker("TEMPLATE_FULL_CAPTION", "full_cut_caption")

    def template_content_font_fields(material):
        result = {}
        content_json = parse_json_text_content(material.get("content") if isinstance(material, dict) else None)
        if not isinstance(content_json, dict):
            return result
        styles = content_json.get("styles")
        if not isinstance(styles, list):
            return result
        for style_item in styles:
            if not isinstance(style_item, dict):
                continue
            font = style_item.get("font")
            if not isinstance(font, dict):
                continue
            mapping = [
                ("path", "font_path"),
                ("name", "font_name"),
                ("title", "font_title"),
                ("id", "font_id"),
                ("resource_id", "font_resource_id"),
                ("source_platform", "font_source_platform"),
                ("category_name", "font_category_name"),
                ("category_id", "font_category_id"),
                ("third_resource_id", "font_third_resource_id"),
            ]
            for source_key, target_key in mapping:
                value = font.get(source_key)
                if value not in (None, ""):
                    result[target_key] = value
            break
        return result

    def extract_caption_style_overrides(marker_entry, marker_name, style_profile):
        if not isinstance(marker_entry, dict):
            return {}
        material = marker_entry.get("material")
        segment = marker_entry.get("segment")
        if not isinstance(material, dict) or not isinstance(segment, dict):
            return {}

        content_font_size = template_content_font_size(material)
        material_font_size = safe_float(material.get("font_size"), 0.0)
        font_size = content_font_size or material_font_size
        profile = str(style_profile or "").strip()
        if font_size <= 0:
            font_size = HIGHLIGHT_EXPLAINER_FONT_SIZE if profile == "highlight_explainer" else FULL_CUT_CAPTION_FONT_SIZE

        clip = segment.get("clip") if isinstance(segment.get("clip"), dict) else {}
        transform = clip.get("transform") if isinstance(clip.get("transform"), dict) else {}
        scale = clip.get("scale") if isinstance(clip.get("scale"), dict) else {}

        overrides = {
            "marker": marker_name,
            "style_profile": profile,
            "template_material_id": material.get("id", ""),
            "template_segment_id": segment.get("id", ""),
            "font_size": font_size,
            "x": safe_float(transform.get("x"), HIGHLIGHT_EXPLAINER_X if profile == "highlight_explainer" else FULL_CUT_CAPTION_X),
            "y": safe_float(transform.get("y"), HIGHLIGHT_EXPLAINER_Y if profile == "highlight_explainer" else FULL_CUT_CAPTION_Y),
            "scale_x": safe_float(scale.get("x"), 1.0),
            "scale_y": safe_float(scale.get("y"), 1.0),
        }
        overrides.update(template_content_style_colors(material))
        optional_fields = [
            "fixed_width",
            "fixed_height",
            "line_max_width",
            "line_spacing",
            "line_feed",
            "typesetting",
            "alignment",
            "oneline_cutoff",
            "force_apply_line_max_width",
            "text_color",
            "text_alpha",
            "global_alpha",
            "border_color",
            "border_alpha",
            "border_width",
            "border_mode",
            "shadow_color",
            "shadow_alpha",
            "shadow_distance",
            "shadow_angle",
            "shadow_smoothing",
            "bold_width",
            "bold_width_rate",
            "background_color",
            "background_alpha",
            "background_round_radius",
            "font_path",
            "font_name",
            "font_title",
            "font_id",
            "font_resource_id",
            "font_source_platform",
            "font_category_name",
            "font_category_id",
            "font_third_resource_id",
            "fonts",
        ]
        for field in optional_fields:
            if field in material:
                overrides[field] = material.get(field)
        content_font_fields = template_content_font_fields(material)
        for field, value in content_font_fields.items():
            if value not in (None, ""):
                overrides[field] = value
        content_font_path = first_non_empty_string(content_font_fields.get("font_path"))
        if content_font_path and not first_non_empty_string(content_font_fields.get("font_name"), content_font_fields.get("font_title")):
            font_file_name = os.path.splitext(os.path.basename(content_font_path))[0]
            if font_file_name:
                overrides["font_name"] = font_file_name
                overrides["font_title"] = font_file_name
        return overrides

    def caption_style_overrides_for_block(marker_entry, marker_name, block):
        overrides = extract_caption_style_overrides(
            marker_entry,
            marker_name,
            block.get("style_profile") or block.get("styleProfile") or "",
        )
        requested_animation = str(block.get("animation") or "").strip()
        if requested_animation:
            overrides["animation"] = requested_animation
        language = str(block.get("output_language") or block.get("language") or "").strip()
        if language:
            overrides["language"] = language
            overrides["output_language"] = language
        return overrides

    for block_index, block in enumerate(explainer_blocks):
        block_profile = str(block.get("style_profile") or block.get("styleProfile") or "").strip() if isinstance(block, dict) else ""
        if use_simple_process_caption_track and block_profile == "full_cut_caption":
            entry, marker_name, is_legacy_fallback = select_explainer_marker_for_block(block)
            existing_segments = explainer_track.get("segments") if isinstance(explainer_track.get("segments"), list) else []
            if block_index < len(existing_segments) and isinstance(existing_segments[block_index], dict):
                existing_segment = existing_segments[block_index]
                existing_segment["caption_template_marker"] = marker_name
                existing_segment["caption_style_overrides"] = caption_style_overrides_for_block(entry, marker_name, block)
                if isinstance(entry, dict) and isinstance(entry.get("segment"), dict):
                    existing_segment["extra_material_refs"] = clone_template_refs_fresh(
                        entry["segment"].get("extra_material_refs") or []
                    )
            explainer_template_usage.append(
                {
                    "block_id": block.get("block_id", ""),
                    "style_profile": block.get("style_profile") or block.get("styleProfile") or "",
                    "marker": marker_name or "PYCAPCUT_SIMPLE_TEXT_FOR_PROCESS_CAPTION",
                    "material": (entry.get("material") or {}).get("id", "") if isinstance(entry, dict) else "",
                    "segment": (entry.get("segment") or {}).get("id", "") if isinstance(entry, dict) else "",
                    "template_driven": bool(entry) and not is_legacy_fallback,
                    "simple_text_track": True,
                    "reason": (
                        "highlight template marker missing; refused to reuse Full caption marker"
                        if marker_name == "TEMPLATE_HIGHLIGHT_EXPLAINER_MISSING"
                        else "template-cloned process captions can produce selectable boxes without visible glyphs in CapCut"
                    ),
                }
            )
            continue
        entry, marker_name, is_legacy_fallback = select_explainer_marker_for_block(block)
        if not entry:
            continue
        start_us = microseconds(block.get("start_sec", 0))
        duration_us = max(1, microseconds(block.get("end_sec", 0)) - start_us)
        cloned = clone_segment_from_entry(
            entry,
            block.get("text") or "",
            start_us,
            duration_us,
            role_name="explainer",
            style_profile=block.get("style_profile") or block.get("styleProfile") or "",
            apply_style_profile=is_legacy_fallback or str(block.get("style_profile") or block.get("styleProfile") or "").strip() == "full_cut_caption",
            allow_dynamic_position=is_legacy_fallback,
        )
        if cloned is not None:
            cloned["caption_template_marker"] = marker_name
            cloned["caption_style_overrides"] = caption_style_overrides_for_block(entry, marker_name, block)
            explainer_segments.append(cloned)
            explainer_template_usage.append(
                {
                    "block_id": block.get("block_id", ""),
                    "style_profile": block.get("style_profile") or block.get("styleProfile") or "",
                    "marker": marker_name,
                    "material": entry["material"].get("id"),
                    "segment": entry["segment"].get("id"),
                    "template_driven": not is_legacy_fallback,
                }
            )
    if explainer_segments:
        explainer_segments.sort(key=lambda item: int((item.get("target_timerange") or {}).get("start", 0)))
        explainer_track["segments"] = explainer_segments
        first_usage = explainer_template_usage[0] if explainer_template_usage else {}
        template_sources["explainer"] = f"marker={first_usage.get('marker', '')} material={first_usage.get('material', '')} segment={first_usage.get('segment', '')}"
    elif use_simple_process_caption_track and explainer_template_usage:
        first_usage = explainer_template_usage[0]
        template_sources["explainer"] = (
            f"simple_text_from_marker={first_usage.get('marker', '')} "
            f"material={first_usage.get('material', '')} segment={first_usage.get('segment', '')}"
        )

    with open(generated_draft_content_path, "w", encoding="utf-8") as file:
        json.dump(generated, file, ensure_ascii=False, indent=4)

    return {
        "template_clone_mode": True,
        "template_markers_found": found_markers,
        "missing_template_markers": missing_markers,
        "optional_template_markers_found": [marker for marker in optional_markers if marker in template_markers],
        "channel_tag_template_source": template_sources.get("channel_tag", ""),
        "channel_tag_text_hidden_by_asset": replace_channel_tag_text,
        "channel_tag_animation_repeat": channel_repeat,
        "channel_tag_repeat_interval_sec": round(channel_repeat_interval_us / 1_000_000, 3),
        "channel_tag_segments_count": 0,
        "explainer_template_source": template_sources.get("explainer", ""),
        "explainer_segments_count": len(explainer_track.get("segments") or []) if use_simple_process_caption_track else len(explainer_segments),
        "dynamic_explainer_position": bool(explainer_position_adjustments),
        "explainer_position_adjustments": explainer_position_adjustments,
        "text_style_profile_applications": text_style_profile_applications,
        "caption_template_usage": explainer_template_usage,
        "caption_template_mode": "simple_text_for_process_caption" if use_simple_process_caption_track else "template_marker_clone",
        "template_background": template_background_summary,
        "template_frame_overlay": template_frame_overlay_summary,
    }


def create_process_draft(data):
    process_config = data.get("processConfig", {}) if isinstance(data.get("processConfig", {}), dict) else {}
    video_transform_preset = data.get("videoTransformPreset", {}) if isinstance(data.get("videoTransformPreset", {}), dict) else {}
    bgm_preset = data.get("bgmPreset", {}) if isinstance(data.get("bgmPreset", {}), dict) else {}
    width = data.get("resolution", {}).get("width", 1080)
    height = data.get("resolution", {}).get("height", 1920)
    fps = data.get("fps", 30)
    create_zip = coerce_bool(data.get("createZip"), True)

    draft_name = f"process_{int(time.time())}"
    output_base = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "server", "output", "drafts"))
    os.makedirs(output_base, exist_ok=True)
    draft_path = os.path.abspath(os.path.join(output_base, draft_name))
    audio_dir = os.path.join(draft_path, "audio")
    video_dir = os.path.join(draft_path, "video")
    subtitle_dir = os.path.join(draft_path, "subtitles")
    overlay_dir = os.path.join(draft_path, "overlay")
    warnings = []
    requested_target_sec = safe_float(process_config.get("target_duration_sec"), 30.0)
    source_video_path = select_source_video_path(process_config)
    source_preprocess = get_source_preprocess_config(process_config)
    draft_video_path = ""
    source_duration_sec = None
    source_preprocess_summary = {
        "enabled": bool(source_preprocess.get("enabled")),
        "applied": False,
        "reason": "source video not selected",
    }
    scene_detection_summary = {
        "enabled": bool(source_preprocess.get("scene_detection", {}).get("enabled", True)),
        "applied": False,
        "scene_change_times": [],
        "scene_count": 0,
        "reason": "source video not processed yet",
    }
    tail_trim_records = []

    if not source_video_path:
        warnings.append("source video not found: input/source_clean.mp4 or input/source.mp4")
    else:
        draft_video_path = os.path.abspath(os.path.join(video_dir, "source.mp4"))
        source_duration_sec = get_video_duration_sec_ffprobe(source_video_path)
        if source_duration_sec is None:
            warnings.append(f"source video duration probe failed: {source_video_path}")
            source_duration_sec = 0.0

    raw_process_blocks = process_config.get("explainer_blocks") if isinstance(process_config.get("explainer_blocks"), list) else []
    raw_preroll_blocks = [
        block for block in raw_process_blocks
        if isinstance(block, dict) and coerce_bool(block.get("is_preroll_hook"), False)
    ]
    raw_preroll_duration_sec = 0.0
    for block in raw_preroll_blocks:
        raw_preroll_duration_sec = max(
            raw_preroll_duration_sec,
            safe_float(block.get("end_sec"), 0.0) - safe_float(block.get("start_sec"), 0.0)
        )

    if source_duration_sec and source_duration_sec > 0:
        allowed_target_sec = float(source_duration_sec) + max(0.0, raw_preroll_duration_sec)
        target_duration_sec = min(requested_target_sec, allowed_target_sec)
        if requested_target_sec > allowed_target_sec:
            warnings.append("target_duration_sec exceeds source duration plus preroll; trimmed to allowed duration")
    else:
        target_duration_sec = requested_target_sec

    explainer_blocks = normalize_process_blocks(process_config, target_duration_sec)

    draft_folder = cc.DraftFolder(output_base)
    script = draft_folder.create_draft(draft_name, width, height, fps=fps, allow_replace=True)
    script.add_track(cc.TrackType.video, "source_video", relative_index=0)
    script.add_track(cc.TrackType.audio, "bgm", relative_index=1)
    script.add_track(cc.TrackType.video, "channel_asset_overlay", relative_index=2)
    script.add_track(cc.TrackType.video, "ocr_mask_overlay", relative_index=3)
    script.add_track(cc.TrackType.text, "process_explainer", relative_index=4)
    os.makedirs(audio_dir, exist_ok=True)
    os.makedirs(video_dir, exist_ok=True)
    os.makedirs(subtitle_dir, exist_ok=True)
    os.makedirs(overlay_dir, exist_ok=True)

    video_track_count = 0
    total_duration_us = microseconds(target_duration_sec)
    scene_focus_plan = []
    full_preroll_hook_block = None
    for candidate_block in explainer_blocks:
        if isinstance(candidate_block, dict) and coerce_bool(candidate_block.get("is_preroll_hook"), False):
            full_preroll_hook_block = candidate_block
            break
    full_preroll_hook_summary = {
        "enabled": bool(full_preroll_hook_block),
        "applied": False,
        "timeline_start_sec": 0,
        "timeline_end_sec": 0,
        "source_start_sec": 0,
        "source_end_sec": 0,
        "transform": {},
        "text": str((full_preroll_hook_block or {}).get("text") or "") if full_preroll_hook_block else "",
    }
    if source_video_path and draft_video_path:
        source_preprocess_summary = prepare_process_source_video(
            source_video_path,
            draft_video_path,
            source_preprocess,
            warnings,
        )
    if draft_video_path and os.path.exists(draft_video_path):
        video_material = cc.VideoMaterial(draft_video_path)
        material_duration_us = int(video_material.duration or 0)
        video_duration_us = min(total_duration_us, material_duration_us) if material_duration_us > 0 else total_duration_us
        tail_trim_us = microseconds(source_preprocess.get("scene_tail_trim_sec", 0.0))
        tail_trim_records = []
        if video_duration_us > 0:
            scene_detection_summary = detect_scene_changes_ffmpeg(
                draft_video_path,
                video_duration_us / 1_000_000,
                source_preprocess,
                warnings,
            )
            scene_focus_items = scene_detection_summary.get("scene_transitions") if isinstance(scene_detection_summary.get("scene_transitions"), list) else []
            script.add_material(video_material)
            sequence_steps = get_process_transform_sequence(video_transform_preset)
            if sequence_steps:
                cursor_us = 0
                source_cursor_us = 0
                step_index = 0
                full_preroll_hook_applied = False
                if full_preroll_hook_block:
                    hook_start_sec = max(0.0, safe_float(full_preroll_hook_block.get("source_start_sec"), 0.0))
                    hook_end_sec = safe_float(full_preroll_hook_block.get("source_end_sec"), hook_start_sec)
                    hook_duration_sec = max(
                        0.2,
                        safe_float(full_preroll_hook_block.get("end_sec"), 0.0) - safe_float(full_preroll_hook_block.get("start_sec"), 0.0)
                    )
                    hook_duration_us = microseconds(hook_duration_sec)
                    source_start_us = microseconds(hook_start_sec)
                    if hook_end_sec > hook_start_sec:
                        hook_duration_us = min(hook_duration_us, microseconds(hook_end_sec - hook_start_sec))
                    if material_duration_us > 0:
                        hook_duration_us = min(hook_duration_us, max(1, material_duration_us))
                        source_start_us = min(source_start_us, max(0, material_duration_us - hook_duration_us))
                    if hook_duration_us >= 200_000 and video_duration_us > 0:
                        script.add_segment(
                            cc.VideoSegment(
                                material=video_material,
                                source_timerange=cc.Timerange(start=source_start_us, duration=hook_duration_us),
                                target_timerange=cc.Timerange(start=0, duration=hook_duration_us),
                            ),
                            track_name="source_video",
                        )
                        cursor_us += hook_duration_us
                        full_preroll_hook_applied = True
                        transform_override = full_preroll_hook_block.get("video_transform_override") if isinstance(full_preroll_hook_block.get("video_transform_override"), dict) else {}
                        full_preroll_hook_summary.update(
                            {
                                "applied": True,
                                "timeline_start_sec": 0,
                                "timeline_end_sec": round(hook_duration_us / 1_000_000, 3),
                                "source_start_sec": round(source_start_us / 1_000_000, 3),
                                "source_end_sec": round((source_start_us + hook_duration_us) / 1_000_000, 3),
                                "transform": transform_override,
                            }
                        )
                        scene_focus_plan.append(
                            {
                                "scene_id": str(full_preroll_hook_block.get("scene_id") or "full_preroll_hook"),
                                "focus_zone": "center",
                                "recommended_camera_move": "punch_zoom",
                                "motion_intensity": "high",
                                "focus_target": "preroll visual hook",
                                "visual_hook_score": 10,
                                "repetition_potential": 10,
                                "video_transform_override": transform_override,
                                "is_preroll_hook": True,
                            }
                        )
                    else:
                        warnings.append("full preroll hook skipped: invalid source or target duration")

                hook_teaser = video_transform_preset.get("hook_teaser") if isinstance(video_transform_preset.get("hook_teaser"), dict) else {}
                hook_applied = False
                if coerce_bool(hook_teaser.get("enabled"), False) and not full_preroll_hook_applied:
                    hook_duration_us = microseconds(max(0.2, safe_float(hook_teaser.get("duration_sec"), 0.8)))
                    min_source_duration_sec = safe_float(hook_teaser.get("min_source_duration_sec"), 8.0)
                    if material_duration_us >= microseconds(min_source_duration_sec) and video_duration_us > hook_duration_us:
                        step = sequence_steps[0]
                        script.add_segment(
                            cc.VideoSegment(
                                material=video_material,
                                source_timerange=cc.Timerange(start=max(0, material_duration_us - hook_duration_us), duration=hook_duration_us),
                                target_timerange=cc.Timerange(start=0, duration=hook_duration_us),
                            ),
                            track_name="source_video",
                        )
                        cursor_us += hook_duration_us
                        hook_applied = True
                        scene_focus_plan.append(
                            {
                                "scene_id": "hook_teaser",
                                "focus_zone": "center",
                                "recommended_camera_move": "punch_zoom",
                                "motion_intensity": "high",
                                "focus_target": "final result teaser",
                            }
                        )
                    else:
                        warnings.append("hook teaser skipped: source duration shorter than min_source_duration_sec")

                if full_preroll_hook_applied:
                    remaining_video_us = max(0, min(video_duration_us, total_duration_us - cursor_us))
                else:
                    remaining_video_us = max(0, video_duration_us - cursor_us)
                scene_change_times = scene_detection_summary.get("scene_change_times") or []
                segment_plans = []
                if scene_change_times:
                    boundaries_us = [0]
                    for scene_time in scene_change_times:
                        scene_us = microseconds(scene_time)
                        if 0 < scene_us < remaining_video_us:
                            boundaries_us.append(scene_us)
                    boundaries_us.append(remaining_video_us)
                    boundaries_us = sorted(set(boundaries_us))
                    for boundary_index in range(len(boundaries_us) - 1):
                        start_us = boundaries_us[boundary_index]
                        end_us = boundaries_us[boundary_index + 1]
                        if end_us - start_us >= 200_000:
                            scene_meta = find_scene_focus_for_range(
                                scene_focus_items,
                                start_us / 1_000_000,
                                end_us / 1_000_000,
                                boundary_index,
                            )
                            segment_plans.append(
                                {
                                    "mode": "scene_change",
                                    "source_start_us": start_us,
                                    "duration_us": end_us - start_us,
                                    "scene_meta": scene_meta,
                                }
                            )
                else:
                    duration_plan = build_segment_duration_us_list(
                        remaining_video_us,
                        safe_float(video_transform_preset.get("segment_unit_sec", video_transform_preset.get("interval_sec")), 3.0),
                        1.2,
                    )
                    for step_duration_us in duration_plan:
                        segment_plans.append(
                            {
                                "mode": "fixed_interval",
                                "source_start_us": None,
                                "duration_us": step_duration_us,
                            }
                        )

                for segment_index, segment_plan in enumerate(segment_plans):
                    raw_step = sequence_steps[step_index % len(sequence_steps)]
                    scene_meta = segment_plan.get("scene_meta") if isinstance(segment_plan.get("scene_meta"), dict) else {}
                    step = apply_focus_to_transform_step(raw_step, scene_meta, segment_index)
                    step_duration_us = int(segment_plan.get("duration_us") or 0)
                    is_scene_cut = segment_plan.get("mode") == "scene_change"
                    trim_us = min(tail_trim_us, max(0, int(step_duration_us * 0.25))) if is_scene_cut else 0
                    target_step_duration_us = max(200_000, step_duration_us - trim_us)
                    speed_value = max(0.1, safe_float(step.get("speed"), 1.0))
                    source_duration_us = max(1, int(target_step_duration_us * speed_value))
                    if material_duration_us > 0:
                        if is_scene_cut:
                            max_scene_duration_us = max(1, step_duration_us - trim_us)
                            source_duration_us = min(source_duration_us, max_scene_duration_us, material_duration_us)
                            source_start_us = int(segment_plan.get("source_start_us") or 0)
                        else:
                            source_duration_us = min(source_duration_us, material_duration_us)
                            source_start_us = source_cursor_us
                        max_start_us = max(0, material_duration_us - source_duration_us)
                        if source_start_us > max_start_us:
                            source_start_us = max_start_us
                    else:
                        source_start_us = 0

                    script.add_segment(
                        cc.VideoSegment(
                            material=video_material,
                            source_timerange=cc.Timerange(start=source_start_us, duration=source_duration_us),
                            target_timerange=cc.Timerange(start=cursor_us, duration=target_step_duration_us),
                        ),
                        track_name="source_video",
                    )
                    if trim_us > 0:
                        tail_trim_records.append(
                            {
                                "segment_index": segment_index,
                                "mode": "scene_change",
                                "source_start_sec": round(source_start_us / 1_000_000, 3),
                                "source_end_sec": round((source_start_us + step_duration_us) / 1_000_000, 3),
                                "trim_sec": round(trim_us / 1_000_000, 3),
                                "original_duration_sec": round(step_duration_us / 1_000_000, 3),
                                "target_duration_sec": round(target_step_duration_us / 1_000_000, 3),
                            }
                        )
                    video_track_count += 1
                    cursor_us += target_step_duration_us
                    if not is_scene_cut:
                        source_cursor_us += source_duration_us
                    step_index += 1
                    scene_focus_plan.append(scene_meta)
                if hook_applied:
                    warnings.append("hook teaser applied from last source seconds")
            else:
                trim_us = 0
                script.add_segment(
                    cc.VideoSegment(
                        material=video_material,
                        source_timerange=cc.Timerange(start=0, duration=max(1, video_duration_us - trim_us)),
                        target_timerange=cc.Timerange(start=0, duration=max(200_000, video_duration_us - trim_us)),
                    ),
                    track_name="source_video",
                )
                video_track_count = 1
        else:
            warnings.append("source video material duration invalid")

    bgm_source_path = find_bgm_file_from_preset(bgm_preset) if coerce_bool(process_config.get("use_bgm"), True) else ""
    draft_bgm_path = ""
    bgm_track_count = 0
    if coerce_bool(process_config.get("use_bgm"), True):
        if bgm_source_path:
            draft_bgm_path = os.path.abspath(os.path.join(audio_dir, os.path.basename(bgm_source_path)))
            shutil.copy2(bgm_source_path, draft_bgm_path)
            bgm_material = cc.AudioMaterial(draft_bgm_path)
            material_duration_us = int(bgm_material.duration or 0)
            if material_duration_us > 0:
                script.add_material(bgm_material)
                cursor_us = 0
                while cursor_us < total_duration_us:
                    segment_duration_us = min(material_duration_us, total_duration_us - cursor_us)
                    script.add_segment(
                        cc.AudioSegment(
                            material=bgm_material,
                            source_timerange=cc.Timerange(start=0, duration=segment_duration_us),
                            target_timerange=cc.Timerange(start=cursor_us, duration=segment_duration_us),
                        ),
                        track_name="bgm",
                    )
                    bgm_track_count += 1
                    cursor_us += segment_duration_us
            else:
                warnings.append("bgm material duration invalid")
        else:
            warnings.append("bgm file not found under assets/bgm/process; continuing without BGM")

    channel_frame_asset = {}
    channel_frame_summary = {
        "enabled": False,
        "source_path": "",
        "draft_path": "",
        "original_name": "",
        "position": "manual_capcut_preset",
        "scale": 1.0,
        "opacity": 1.0,
        "track_count": 0,
        "applied": False,
        "reason": "removed: frame presets are applied manually in CapCut",
    }

    channel_asset = process_config.get("channel_asset") if isinstance(process_config.get("channel_asset"), dict) else {}
    channel_asset_summary = {
        "enabled": bool(channel_asset.get("enabled") or channel_asset.get("path")),
        "source_path": str(channel_asset.get("path") or ""),
        "draft_path": "",
        "original_name": str(channel_asset.get("original_name") or ""),
        "position": str(channel_asset.get("position") or "top_left"),
        "scale": safe_float(channel_asset.get("scale"), 0.34),
        "opacity": safe_float(channel_asset.get("opacity"), 1.0),
        "replace_channel_tag_text": coerce_bool(channel_asset.get("replace_channel_tag_text"), False),
        "track_count": 0,
        "applied": False,
        "reason": "disabled",
    }
    if channel_asset_summary["enabled"]:
        try:
            draft_channel_asset_path = prepare_channel_asset_for_draft(channel_asset, overlay_dir, target_duration_sec, warnings)
            channel_asset_summary["draft_path"] = draft_channel_asset_path
            if draft_channel_asset_path and os.path.exists(draft_channel_asset_path):
                channel_asset_material = cc.VideoMaterial(draft_channel_asset_path)
                material_duration_us = int(channel_asset_material.duration or 0)
                if material_duration_us > 0:
                    script.add_material(channel_asset_material)
                    cursor_us = 0
                    while cursor_us < total_duration_us:
                        duration_us = min(material_duration_us, total_duration_us - cursor_us)
                        script.add_segment(
                            cc.VideoSegment(
                                material=channel_asset_material,
                                source_timerange=cc.Timerange(start=0, duration=duration_us),
                                target_timerange=cc.Timerange(start=cursor_us, duration=duration_us),
                            ),
                            track_name="channel_asset_overlay",
                        )
                        channel_asset_summary["track_count"] += 1
                        cursor_us += duration_us
                    channel_asset_summary["reason"] = "overlay track created"
                else:
                    channel_asset_summary["reason"] = "channel asset material duration invalid"
                    warnings.append(channel_asset_summary["reason"])
            else:
                channel_asset_summary["reason"] = "channel asset draft path missing"
        except Exception as asset_error:
            channel_asset_summary["reason"] = f"channel asset overlay failed: {asset_error}"
            warnings.append(channel_asset_summary["reason"])

    ocr_mask_pre_summary = add_ocr_mask_video_segments(
        script,
        process_config,
        overlay_dir,
        target_duration_sec,
        width,
        height,
        warnings,
    )

    # Fallback text segments are intentionally simple. If a process template exists,
    # clone mode below replaces these with template-derived material/segment copies.
    try:
        for block in explainer_blocks:
            start_us = microseconds(block.get("start_sec", 0))
            duration_us = max(1, microseconds(block.get("end_sec", 0)) - start_us)
            script.add_segment(
                cc.TextSegment(text=block.get("text") or "", timerange=cc.Timerange(start=start_us, duration=duration_us)),
                track_name="process_explainer",
            )
    except Exception as text_error:
        warnings.append(f"fallback text segment creation failed: {text_error}")

    script.save()

    generated_draft_content_path = os.path.join(draft_path, "draft_content.json")
    channel_asset_transform_summary = apply_channel_asset_overlay_transform(
        generated_draft_content_path,
        channel_asset,
        warnings,
    )
    channel_asset_summary.update(channel_asset_transform_summary)

    template_id = str(process_config.get("capcut_template_id") or "process_default")
    template_info = find_capcut_template_files(template_id, process_config)
    template_draft_content = None
    template_clone_summary = {
        "template_clone_mode": False,
        "template_markers_found": [],
        "missing_template_markers": ["TEMPLATE_EXPLAINER"],
        "explainer_segments_count": len(explainer_blocks),
    }
    if template_info:
        try:
            template_draft_content = load_json_file(template_info["draft_content_path"])
        except (OSError, json.JSONDecodeError) as error:
            warnings.append(f"failed to load process template draft_content: {error}")
    else:
        warnings.append("process template not found under templates/capcut/process_default (depth<=2)")

    if template_draft_content and os.path.exists(generated_draft_content_path):
        try:
            template_clone_summary = apply_process_template_clone_mode(
                generated_draft_content_path,
                template_draft_content,
                process_config,
                explainer_blocks,
                target_duration_sec,
                template_info.get("template_root", "") if template_info else "",
                draft_path,
            )
        except Exception as error:
            warnings.append(f"process template clone mode failed: {error}")

    template_frame_overlay_summary = {
        "applied": False,
        "reason": "disabled: frame presets are applied manually in CapCut",
        "segments_count": 0,
    }

    applied_video_transforms = apply_process_video_transforms_to_draft(
        generated_draft_content_path,
        video_transform_preset,
        source_duration_sec,
        target_duration_sec,
        width,
        height,
        scene_focus_plan,
    )
    ocr_mask_overlay_summary = apply_ocr_mask_overlay_to_draft(
        generated_draft_content_path,
        process_config,
        target_duration_sec,
        width,
        height,
        warnings,
        template_draft_content,
    )
    if ocr_mask_pre_summary.get("mask_video_path") and not ocr_mask_overlay_summary.get("mask_video_path"):
        ocr_mask_overlay_summary["mask_video_path"] = ocr_mask_pre_summary.get("mask_video_path")

    caption_timeline_sync = sync_full_caption_segments_to_video_timeline(
        generated_draft_content_path,
        explainer_blocks,
    )
    if caption_timeline_sync.get("synced_explainer_blocks"):
        explainer_blocks = caption_timeline_sync["synced_explainer_blocks"]
    caption_visibility_summary = force_process_caption_visibility(
        generated_draft_content_path,
        template_doc=template_draft_content,
        process_config=process_config,
    )
    caption_blur_background_summary = {
        "applied": False,
        "reason": "temporarily disabled because CapCut effect tracks can render above text and hide glyphs",
        "segments_count": 0,
        "track_name": "caption_blur_effect",
    }
    auxiliary_timeline_trim = trim_auxiliary_tracks_to_video_timeline(generated_draft_content_path)
    for trim_item in auxiliary_timeline_trim.get("trimmed_tracks") or []:
        if trim_item.get("track_name") == "bgm":
            bgm_track_count = int(trim_item.get("final_segments") or bgm_track_count)
        if trim_item.get("track_name") == "channel_frame_overlay":
            channel_frame_summary["track_count"] = int(trim_item.get("final_segments") or channel_frame_summary.get("track_count") or 0)
        if trim_item.get("track_name") == "channel_asset_overlay":
            channel_asset_summary["track_count"] = int(trim_item.get("final_segments") or channel_asset_summary.get("track_count") or 0)

    chapter05_strategy_applied = {
        "crop_zoom": bool(applied_video_transforms.get("crop", {}).get("requested")),
        "zoom": bool(applied_video_transforms.get("zoom", {}).get("applied")),
        "mirror": bool(applied_video_transforms.get("mirror", {}).get("applied")),
        "speed_variation": bool(applied_video_transforms.get("speed", {}).get("applied")),
        "color_adjustment": bool(applied_video_transforms.get("color_adjustment", {}).get("applied")),
        "channel_overlay": True,
        "channel_frame_overlay": bool(channel_frame_summary.get("applied")),
        "channel_asset_overlay": bool(channel_asset_summary.get("applied")),
        "explainer_overlay": True,
        "bgm_mood_shift": bool(draft_bgm_path),
    }

    manual_pending = []
    for key, item in applied_video_transforms.items():
        if item.get("requested") and not item.get("applied"):
            manual_pending.append(f"{key}: {item.get('reason') or 'not applied'}")

    title_overlay_legacy = process_config.get("title_overlay") if isinstance(process_config.get("title_overlay"), dict) else {}
    upload_title = str(
        process_config.get("upload_title")
        or title_overlay_legacy.get("text")
        or '공정의 핵심 순간'
    ).strip()
    upload_description = str(process_config.get("upload_description") or "").strip()
    upload_hashtags_raw = process_config.get("upload_hashtags")
    if isinstance(upload_hashtags_raw, list):
        upload_hashtags = [str(item).strip() for item in upload_hashtags_raw if str(item).strip()]
    else:
        upload_hashtags = [item.strip() for item in str(upload_hashtags_raw or "").replace("\n", ",").split(",") if item.strip()]

    sequence_summary = applied_video_transforms.get("sequence") if isinstance(applied_video_transforms.get("sequence"), dict) else {}
    segment_transform_plan = []
    for index, item in enumerate(sequence_summary.get("segments") or []):
        segment_transform_plan.append(
            {
                "segment_id": f"seg_{index + 1:03d}",
                "timeline_start_sec": item.get("timeline_start_sec"),
                "timeline_end_sec": item.get("timeline_end_sec"),
                "source_start_sec": item.get("source_start_sec"),
                "source_end_sec": item.get("source_end_sec"),
                "scale": item.get("scale", item.get("zoom_scale")),
                "pan_x": item.get("pan_x", 0),
                "pan_y": item.get("pan_y", 0),
                "rotation": item.get("rotation", 0),
                "speed": item.get("speed", 1),
                "mirror": bool(item.get("mirror")),
                "speed_applied": item.get("speed_applied", False),
                "transform_override_applied": item.get("transform_override_applied", False),
                "is_preroll_hook": item.get("is_preroll_hook", False),
                "focus_applied": item.get("focus_applied", False),
                "focus_zone": item.get("focus_zone", ""),
                "focus_target": item.get("focus_target", ""),
                "recommended_camera_move": item.get("recommended_camera_move", ""),
                "motion_intensity": item.get("motion_intensity", ""),
                "scene_id": item.get("scene_id", ""),
            }
        )
    global_transform = get_global_transform(video_transform_preset)
    speed_requested_count = sum(1 for item in segment_transform_plan if abs(safe_float(item.get("speed"), 1.0) - 1.0) > 0.001)
    speed_applied_count = sum(1 for item in segment_transform_plan if item.get("speed_applied"))
    hook_teaser = video_transform_preset.get("hook_teaser") if isinstance(video_transform_preset.get("hook_teaser"), dict) else {}
    hook_teaser_duration_sec = safe_float(hook_teaser.get("duration_sec"), 0.8)
    hook_teaser_applied = bool(
        coerce_bool(hook_teaser.get("enabled"), False)
        and segment_transform_plan
        and safe_float(segment_transform_plan[0].get("timeline_end_sec"), 0) <= hook_teaser_duration_sec + 0.05
        and safe_float(segment_transform_plan[0].get("source_start_sec"), 0) > 0
    )
    pending_video_transforms = []
    for key, item in applied_video_transforms.items():
        if isinstance(item, dict) and item.get("requested") and not item.get("applied"):
            pending_video_transforms.append({"name": key, "reason": item.get("reason") or "not applied"})

    edit_manifest = {
        "generated_at": datetime.now().isoformat(),
        "draft_name": draft_name,
        "mode": "ultra_efficiency_process",
        "upload_title": upload_title,
        "upload_description": upload_description,
        "upload_hashtags": upload_hashtags,
        "source_video_path": source_video_path,
        "draft_video_path": draft_video_path,
        "source_duration_sec": source_duration_sec,
        "target_duration_sec": target_duration_sec,
        "actual_timeline_duration_sec": auxiliary_timeline_trim.get("video_end_sec", target_duration_sec),
        "draft_duration_normalized": bool(auxiliary_timeline_trim.get("draft_duration_updated")),
        "use_tts": bool(process_config.get("use_tts")),
        "use_bgm": bool(process_config.get("use_bgm", True)),
        "bgm_preset": process_config.get("bgm_preset") or bgm_preset.get("preset_id", ""),
        "bgm_source_path": bgm_source_path,
        "bgm_draft_path": draft_bgm_path,
        "bgm_track_count": bgm_track_count,
        "channel_frame_overlay": channel_frame_summary,
        "channel_asset_overlay": channel_asset_summary,
        "video_transform_preset_id": video_transform_preset.get("preset_id") or "",
        "mirror_policy": global_transform["mirror_policy"],
        "global_video_transform": {
            "mirror": {
                "requested": global_transform["mirror"],
                "applied": bool(applied_video_transforms.get("mirror", {}).get("applied")),
                "policy": global_transform["mirror_policy"],
            },
            "base_scale": {
                "requested": global_transform["base_scale"] > 1.0001,
                "applied": global_transform["base_scale"] > 1.0001,
                "value": global_transform["base_scale"],
            },
        },
        "segment_transform_plan": segment_transform_plan,
        "applied_segment_transforms": {
            "segments_count": len(segment_transform_plan),
            "scale_applied_count": sum(1 for item in segment_transform_plan if safe_float(item.get("scale"), 1.0) > 1.0001),
            "pan_applied_count": sum(1 for item in segment_transform_plan if abs(safe_float(item.get("pan_x"), 0)) > 0.0001 or abs(safe_float(item.get("pan_y"), 0)) > 0.0001),
            "rotation_applied_count": sum(1 for item in segment_transform_plan if abs(safe_float(item.get("rotation"), 0)) > 0.0001),
            "focus_applied_count": sum(1 for item in segment_transform_plan if item.get("focus_applied")),
            "speed_applied_count": speed_applied_count,
            "speed_skipped_count": max(0, speed_requested_count - speed_applied_count),
            "hook_teaser_applied": hook_teaser_applied,
            "scene_tail_trim_applied_count": len(tail_trim_records),
        },
        "full_preroll_hook": full_preroll_hook_summary,
        "source_preprocess": source_preprocess_summary,
        "ocr_mask_overlay": ocr_mask_overlay_summary,
        "scene_detection": scene_detection_summary,
        "scene_tail_trim": {
            "enabled": source_preprocess.get("scene_tail_trim_sec", 0) > 0,
            "mode": "scene_change_only",
            "tail_trim_sec": source_preprocess.get("scene_tail_trim_sec", 0),
            "fixed_interval_tail_trim": False,
            "records": tail_trim_records,
        },
        "pending_video_transforms": pending_video_transforms,
        "video_transform_preset": video_transform_preset,
        "applied_video_transforms": applied_video_transforms,
        "explainer_blocks_count": len(explainer_blocks),
        "explainer_blocks": explainer_blocks,
        "capcut_template_id": template_id,
        "template_path": template_info["template_root"] if template_info else "",
        "template_source": template_info.get("source", "") if template_info else "",
        "template_draft_name": template_info.get("draft_name", "") if template_info else "",
        "template_markers_found": template_clone_summary.get("template_markers_found", []),
        "missing_template_markers": template_clone_summary.get("missing_template_markers", []),
        "template_clone_mode": template_clone_summary.get("template_clone_mode", False),
        "channel_tag_template_source": template_clone_summary.get("channel_tag_template_source", "disabled: channel tag text overlay is no longer used"),
        "channel_tag_text_hidden_by_asset": True,
        "channel_tag_animation_repeat": False,
        "channel_tag_repeat_interval_sec": 0,
        "channel_tag_segments_count": 0,
        "explainer_template_source": template_clone_summary.get("explainer_template_source", ""),
        "dynamic_explainer_position": template_clone_summary.get("dynamic_explainer_position", False),
        "explainer_position_adjustments": template_clone_summary.get("explainer_position_adjustments", []),
        "text_style_profile_applications": template_clone_summary.get("text_style_profile_applications", []),
        "caption_template_mode": template_clone_summary.get("caption_template_mode", ""),
        "caption_template_usage": template_clone_summary.get("caption_template_usage", []),
        "template_background": template_clone_summary.get("template_background", {}),
        "template_frame_overlay": template_frame_overlay_summary,
        "caption_timeline_sync": {
            key: value
            for key, value in caption_timeline_sync.items()
            if key != "synced_explainer_blocks"
        },
        "caption_visibility": caption_visibility_summary,
        "caption_blur_background": caption_blur_background_summary,
        "auxiliary_timeline_trim": auxiliary_timeline_trim,
        "chapter05_strategy_applied": chapter05_strategy_applied,
        "manual_or_pending_transform_items": manual_pending,
        "warnings": warnings,
    }
    edit_manifest_path = os.path.join(draft_path, "edit_manifest.json")
    with open(edit_manifest_path, "w", encoding="utf-8") as manifest_file:
        json.dump(edit_manifest, manifest_file, ensure_ascii=False, indent=2)

    notes_lines = [
        "# Process Edit CapCut Draft Notes",
        "",
        f"- Mode: ultra_efficiency_process",
        f"- Generated At: {datetime.now().isoformat()}",
        f"- Draft Name: {draft_name}",
        f"- Upload Title: {upload_title}",
        f"- Upload Description: {upload_description if upload_description else 'none'}",
        f"- Upload Hashtags: {', '.join(upload_hashtags) if upload_hashtags else 'none'}",
        f"- Source Video: {source_video_path if source_video_path else 'none'}",
        f"- Source Preprocess: {json.dumps(source_preprocess_summary, ensure_ascii=False)}",
        f"- OCR Mask Overlay: {json.dumps(ocr_mask_overlay_summary, ensure_ascii=False)}",
        f"- Caption Visibility: {json.dumps(caption_visibility_summary, ensure_ascii=False)}",
        f"- Caption Blur Background: {json.dumps(caption_blur_background_summary, ensure_ascii=False)}",
        f"- Scene Detection: {json.dumps(scene_detection_summary, ensure_ascii=False)}",
        f"- Scene Tail Trim: {json.dumps(edit_manifest['scene_tail_trim'], ensure_ascii=False)}",
        f"- Target Duration Sec: {target_duration_sec}",
        f"- Actual Timeline Duration Sec: {edit_manifest.get('actual_timeline_duration_sec', target_duration_sec)}",
        f"- Explainer Blocks: {len(explainer_blocks)}",
        f"- BGM Enabled: {str(bool(process_config.get('use_bgm', True))).lower()}",
        f"- BGM Source: {bgm_source_path if bgm_source_path else 'none'}",
        f"- Channel Frame Overlay: {json.dumps(channel_frame_summary, ensure_ascii=False)}",
        f"- Template Frame Overlay: {json.dumps(template_frame_overlay_summary, ensure_ascii=False)}",
        f"- Channel Asset Overlay: {json.dumps(channel_asset_summary, ensure_ascii=False)}",
        f"- TTS Enabled: {str(bool(process_config.get('use_tts'))).lower()}",
        f"- CapCut Template ID: {template_id}",
        f"- Template Root: {template_info['template_root'] if template_info else 'not found'}",
        f"- Template Source: {template_info.get('source', '') if template_info else 'not found'}",
        f"- Template Draft Name: {template_info.get('draft_name', '') if template_info else 'not found'}",
        f"- Template Clone Mode: {str(bool(template_clone_summary.get('template_clone_mode'))).lower()}",
        f"- Template Markers Found: {', '.join(template_clone_summary.get('template_markers_found', [])) if template_clone_summary.get('template_markers_found') else 'none'}",
        f"- Missing Template Markers: {', '.join(template_clone_summary.get('missing_template_markers', [])) if template_clone_summary.get('missing_template_markers') else 'none'}",
        f"- Channel Tag Animation Repeat: {str(bool(edit_manifest.get('channel_tag_animation_repeat'))).lower()}",
        f"- Channel Tag Text Hidden By Asset: {str(bool(edit_manifest.get('channel_tag_text_hidden_by_asset'))).lower()}",
        f"- Channel Tag Segments Count: {edit_manifest.get('channel_tag_segments_count')}",
        f"- Dynamic Explainer Position: {str(bool(edit_manifest.get('dynamic_explainer_position'))).lower()}",
        f"- Explainer Position Adjustments: {json.dumps(edit_manifest.get('explainer_position_adjustments', []), ensure_ascii=False)}",
        f"- Text Style Profile Applications: {json.dumps(edit_manifest.get('text_style_profile_applications', []), ensure_ascii=False)}",
        f"- Caption Template Mode: {edit_manifest.get('caption_template_mode') or 'legacy'}",
        f"- Caption Template Usage: {json.dumps(edit_manifest.get('caption_template_usage', []), ensure_ascii=False)}",
        f"- Template Background: {json.dumps(edit_manifest.get('template_background', {}), ensure_ascii=False)}",
        f"- Requested Video Transform Preset: {video_transform_preset.get('preset_id') or video_transform_preset.get('name') or 'unknown'}",
        f"- Mirror Policy: {global_transform['mirror_policy']}",
        f"- Global Mirror Applied: {str(bool(applied_video_transforms.get('mirror', {}).get('applied'))).lower()}",
        f"- Segment Transform Count: {len(segment_transform_plan)}",
        f"- Applied Segment Transforms: {json.dumps(edit_manifest['applied_segment_transforms'], ensure_ascii=False)}",
        f"- Full Preroll Hook: {json.dumps(full_preroll_hook_summary, ensure_ascii=False)}",
        f"- Chapter05 Strategy Applied: {json.dumps(chapter05_strategy_applied, ensure_ascii=False)}",
        f"- Applied Video Transforms: {json.dumps(applied_video_transforms, ensure_ascii=False)}",
        "",
        "## Segment Transform Plan",
    ]
    if segment_transform_plan:
        for item in segment_transform_plan[:20]:
            notes_lines.append(
                f"- {item['segment_id']} {item['timeline_start_sec']}~{item['timeline_end_sec']}s: "
                f"scale={item['scale']}, pan=({item['pan_x']},{item['pan_y']}), "
                f"speed={item['speed']} ({'applied' if item.get('speed_applied') else 'not applied'}), mirror=false"
            )
        if len(segment_transform_plan) > 20:
            notes_lines.append(f"- ... {len(segment_transform_plan) - 20} more segments")
    else:
        notes_lines.append("- none")

    notes_lines.extend([
        "",
        "## Manual Or Pending Transform Items",
    ])
    if manual_pending:
        notes_lines.extend([f"- {item}" for item in manual_pending])
    else:
        notes_lines.append("- none")

    notes_lines.extend(["", "## Explainer Blocks"])
    for block in explainer_blocks:
        notes_lines.append(f"- {block['block_id']} ({block['start_sec']}~{block['end_sec']}): {block['text']}")

    notes_lines.extend(["", "## Warnings"])
    if warnings:
        notes_lines.extend([f"- {warning}" for warning in warnings])
    else:
        notes_lines.append("- none")

    notes_path = os.path.join(draft_path, "capcut_notes.md")
    write_notes_file(notes_path, notes_lines)

    checklist_path = os.path.join(draft_path, "capcut_import_checklist.md")
    write_notes_file(
        checklist_path,
        [
            "# Process Draft Import Checklist",
            "",
            "1. Extract the ZIP into the CapCut draft directory.",
            "2. Open CapCut and confirm source video appears on the timeline.",
            "3. Confirm explainer blocks overlay the video.",
            "4. Confirm BGM appears if a BGM file was available.",
            "5. Review manual transform items in capcut_notes.md.",
        ],
    )

    zip_filename = f"{draft_name}.zip" if create_zip else ""
    zip_path = os.path.join(output_base, zip_filename) if create_zip else ""
    if create_zip:
        zip_folder(draft_path, zip_path, output_base)

    return {
        "draftPath": draft_path,
        "zipFile": zip_filename,
        "recommendedZip": zip_filename,
        "zipPath": zip_path,
        "editManifestPath": edit_manifest_path,
        "notesPath": notes_path,
        "checklistPath": checklist_path,
        "mode": "ultra_efficiency_process",
        "sourceVideoPath": source_video_path,
        "draftVideoPath": draft_video_path,
        "targetDurationSec": target_duration_sec,
        "explainerBlocksCount": len(explainer_blocks),
        "bgmTrackCount": bgm_track_count,
        "channelAssetOverlay": channel_asset_summary,
        "videoTrackCount": video_track_count,
        "capcutTemplateUsed": bool(template_info),
        "templatePath": template_info["template_root"] if template_info else "",
        "templateSource": template_info.get("source", "") if template_info else "",
        "templateDraftName": template_info.get("draft_name", "") if template_info else "",
        "templateCloneMode": template_clone_summary.get("template_clone_mode", False),
        "templateMarkersFound": template_clone_summary.get("template_markers_found", []),
        "missingTemplateMarkers": template_clone_summary.get("missing_template_markers", []),
        "templateBackground": template_clone_summary.get("template_background", {}),
        "warnings": warnings,
    }
def apply_midform_hybrid_video_audio_policy(draft_content_path, video_cut_placements, segment_type_map):
    summary = {
        "enabled": True,
        "ducked_narration_video_segments": 0,
        "kept_dialogue_video_segments": 0,
        "unmatched_video_segments": 0,
        "narration_source_volume": MIDFORM_HYBRID_DUCKED_SOURCE_VOLUME,
        "dialogue_source_volume": 1,
    }
    if not draft_content_path or not os.path.exists(draft_content_path):
        summary["reason"] = "draft_content.json not found"
        return summary
    try:
        with open(draft_content_path, "r", encoding="utf-8-sig") as file:
            draft_content = json.load(file)
    except Exception as error:
        summary["reason"] = f"draft_content read failed: {error}"
        return summary

    source_track = None
    for track in draft_content.get("tracks") or []:
        if isinstance(track, dict) and track.get("type") == "video" and track.get("name") == "source_video":
            source_track = track
            break
    if not isinstance(source_track, dict):
        summary["reason"] = "source_video track not found"
        return summary

    source_segments = [segment for segment in source_track.get("segments") or [] if isinstance(segment, dict)]
    for index, segment in enumerate(source_segments):
        placement = video_cut_placements[index] if index < len(video_cut_placements) else None
        if not isinstance(placement, dict):
            summary["unmatched_video_segments"] += 1
            continue
        segment_id = str(placement.get("segment_id") or "")
        segment_type = str(segment_type_map.get(segment_id) or "recap")
        # scene_hook: heatmap-peak cold open that plays its original action audio at full volume.
        if segment_type in {"dialogue_quote", "dialogue", "scene_hook"}:
            segment["volume"] = 1
            segment["last_nonzero_volume"] = 1
            summary["kept_dialogue_video_segments"] += 1
        else:
            segment["volume"] = MIDFORM_HYBRID_DUCKED_SOURCE_VOLUME
            segment["last_nonzero_volume"] = MIDFORM_HYBRID_DUCKED_SOURCE_VOLUME
            summary["ducked_narration_video_segments"] += 1

    try:
        with open(draft_content_path, "w", encoding="utf-8") as file:
            json.dump(draft_content, file, ensure_ascii=False, indent=4)
    except Exception as error:
        summary["reason"] = f"draft_content save failed: {error}"
    return summary


def detect_audio_activity_ranges(source_video_path, start_sec, end_sec, threshold="-35dB", min_silence_sec=0.35):
    if not source_video_path or not os.path.exists(source_video_path):
        return []
    duration_sec = max(0.0, float(end_sec) - float(start_sec))
    if duration_sec <= 0:
        return []
    command = [
        FFMPEG_BIN,
        "-ss",
        f"{float(start_sec):.3f}",
        "-i",
        source_video_path,
        "-t",
        f"{duration_sec:.3f}",
        "-vn",
        "-af",
        f"silencedetect=noise={threshold}:duration={min_silence_sec}",
        "-f",
        "null",
        "-",
    ]
    try:
        proc = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace", check=False)
    except Exception:
        return []
    output = f"{proc.stdout or ''}\n{proc.stderr or ''}"
    silence_starts = [float(value) for value in re.findall(r"silence_start:\s*([0-9.]+)", output)]
    silence_ends = [float(value) for value in re.findall(r"silence_end:\s*([0-9.]+)", output)]
    active_ranges = []
    cursor = 0.0
    for index, silence_start in enumerate(silence_starts):
        if silence_start > cursor + 0.05:
            active_ranges.append((float(start_sec) + cursor, float(start_sec) + silence_start))
        if index < len(silence_ends):
            cursor = max(cursor, silence_ends[index])
        else:
            cursor = duration_sec
    if cursor < duration_sec - 0.05:
        active_ranges.append((float(start_sec) + cursor, float(end_sec)))
    return active_ranges


def seconds_to_timecode(total_sec):
    total_sec = max(0.0, float(total_sec or 0.0))
    hours = int(total_sec // 3600)
    minutes = int((total_sec % 3600) // 60)
    seconds = total_sec - (hours * 3600) - (minutes * 60)
    return f"{hours:02d}:{minutes:02d}:{seconds:06.3f}"


def has_dialogue_text(value):
    text = str(value or "").strip().lower()
    return bool(text and text not in {"none", "n/a", "null", "없음"})


def normalize_transcript_utterances(source_transcript):
    utterances = source_transcript.get("utterances", []) if isinstance(source_transcript, dict) else []
    normalized = []
    for utterance in utterances:
        if not isinstance(utterance, dict):
            continue
        utt_id = str(utterance.get("utt_id") or "").strip()
        start_sec = safe_float(utterance.get("start"), None)
        end_sec = safe_float(utterance.get("end"), None)
        if not utt_id or start_sec is None or end_sec is None or end_sec <= start_sec:
            continue
        normalized.append(
            {
                "utt_id": utt_id,
                "start": start_sec,
                "end": end_sec,
                "text": str(utterance.get("text") or "").strip(),
            }
        )
    return normalized


def build_transcript_utterance_map(source_transcript):
    return {utterance["utt_id"]: utterance for utterance in normalize_transcript_utterances(source_transcript)}


def parse_story_anchor_range(segment_info):
    anchor = segment_info.get("story_anchor") if isinstance(segment_info, dict) else {}
    if not isinstance(anchor, dict):
        return None
    source_range = anchor.get("source_range_hint")
    if not isinstance(source_range, list) or len(source_range) != 2:
        return None
    start_sec = safe_float(source_range[0], None)
    end_sec = safe_float(source_range[1], None)
    if start_sec is None or end_sec is None or end_sec <= start_sec:
        return None
    return (max(0.0, start_sec), end_sec)


def story_anchor_scene_refs(segment_info):
    anchor = segment_info.get("story_anchor") if isinstance(segment_info, dict) else {}
    refs = anchor.get("scene_refs") if isinstance(anchor, dict) else []
    if not isinstance(refs, list):
        return []
    return [str(item).strip() for item in refs if str(item or "").strip()]


def subtract_ranges(base_start, base_end, blocked_ranges):
    available = []
    cursor = max(0.0, float(base_start))
    base_end = max(cursor, float(base_end))
    for blocked_start, blocked_end in sorted(blocked_ranges, key=lambda row: (row[0], row[1])):
        blocked_start = max(float(blocked_start), cursor)
        blocked_end = min(float(blocked_end), base_end)
        if blocked_end <= cursor:
            continue
        if blocked_start > cursor + 0.05:
            available.append((cursor, blocked_start))
        cursor = max(cursor, blocked_end)
        if cursor >= base_end:
            break
    if cursor < base_end - 0.05:
        available.append((cursor, base_end))
    return [(start, end) for start, end in available if end - start > 0.05]


def build_speech_block_ranges(transcript_utterance_map, pad_sec=0.05):
    ranges = []
    for utterance in transcript_utterance_map.values():
        start_sec = safe_float(utterance.get("start"), None)
        end_sec = safe_float(utterance.get("end"), None)
        if start_sec is None or end_sec is None or end_sec <= start_sec:
            continue
        ranges.append((max(0.0, start_sec - pad_sec), end_sec + pad_sec))
    return ranges


def choose_story_anchor_source_clips(segment_info, target_duration_sec, transcript_utterance_map, source_duration_sec):
    anchor_range = parse_story_anchor_range(segment_info)
    segment_id = str(segment_info.get("segment_id") or "unknown_segment")
    if not anchor_range or target_duration_sec <= 0:
        return None
    source_duration = safe_float(source_duration_sec, 0.0)
    speech_ranges = build_speech_block_ranges(transcript_utterance_map)
    attempts = []
    anchor_start, anchor_end = anchor_range
    bounded_anchor = (anchor_start, min(anchor_end, source_duration) if source_duration > 0 else anchor_end)
    attempts.append(("anchor", bounded_anchor[0], bounded_anchor[1]))
    expanded_start = max(0.0, anchor_start - 10.0)
    expanded_end = anchor_end + 10.0
    if source_duration > 0:
        expanded_end = min(expanded_end, source_duration)
    attempts.append(("anchor_expanded_10s", expanded_start, expanded_end))
    adjacent_start = max(0.0, anchor_start - 25.0)
    adjacent_end = anchor_end + 25.0
    if source_duration > 0:
        adjacent_end = min(adjacent_end, source_duration)
    attempts.append(("adjacent_scene_fallback", adjacent_start, adjacent_end))

    selected_ranges = []
    selected_strategy = "none"
    for strategy, start_sec, end_sec in attempts:
        candidates = subtract_ranges(start_sec, end_sec, speech_ranges)
        available_duration = sum(end - start for start, end in candidates)
        if candidates and (available_duration + 0.001 >= target_duration_sec or strategy == "anchor"):
            selected_ranges = candidates
            selected_strategy = strategy
            break
        if strategy == "adjacent_scene_fallback":
            selected_ranges = candidates
            selected_strategy = strategy
            break

    clips = []
    selected_source_duration = sum(end - start for start, end in selected_ranges)
    speed_multiplier = 1.0
    if selected_source_duration > 0 and selected_source_duration + 0.001 < float(target_duration_sec):
        speed_multiplier = max(0.1, selected_source_duration / (float(target_duration_sec) * 1.05))
    remaining_source = selected_source_duration if speed_multiplier < 1.0 else float(target_duration_sec)
    for index, (start_sec, end_sec) in enumerate(selected_ranges, start=1):
        if remaining_source <= 0.001:
            break
        take = min(end_sec - start_sec, remaining_source)
        if take <= 0.05:
            continue
        clips.append(
            {
                "clip_id": f"{segment_id}_story_anchor_{index:02d}",
                "scene_id": story_anchor_scene_refs(segment_info)[0] if story_anchor_scene_refs(segment_info) else "story_anchor",
                "start": seconds_to_timecode(start_sec),
                "end": seconds_to_timecode(start_sec + take),
                "speed_multiplier": round(speed_multiplier, 6),
                "source": "story_anchor_non_speech",
                "story_anchor_strategy": selected_strategy,
            }
        )
        remaining_source -= take
    selected_timeline_duration = sum(
        (parse_timecode_to_sec(clip["end"]) - parse_timecode_to_sec(clip["start"])) / max(0.001, safe_float(clip.get("speed_multiplier"), 1.0))
        for clip in clips
    )
    remaining_timeline = max(0.0, float(target_duration_sec) - selected_timeline_duration)

    report = {
        "segment_id": segment_id,
        "anchor_range": [round(anchor_start, 3), round(anchor_end, 3)],
        "target_duration_sec": round(float(target_duration_sec), 6),
        "selected_duration_sec": round(sum(parse_timecode_to_sec(clip["end"]) - parse_timecode_to_sec(clip["start"]) for clip in clips), 6),
        "selected_timeline_duration_sec": round(selected_timeline_duration, 6),
        "speed_multiplier": round(speed_multiplier, 6),
        "strategy": selected_strategy,
        "clips_count": len(clips),
        "scene_refs": story_anchor_scene_refs(segment_info),
        "warning": "" if remaining_timeline <= 0.001 else f"story anchor source short by {round(remaining_timeline, 3)}s",
    }
    return clips, report


def build_midform_dialogue_map(gemini_analysis, segment_map, segment_type_map, known_source_duration_sec=0.0, source_video_path="", source_transcript=None):
    dialogue_map = []
    known_duration = safe_float(known_source_duration_sec, 0.0)
    transcript_utterance_map = build_transcript_utterance_map(source_transcript)
    if transcript_utterance_map:
        selected_segment_by_utt_id = {}
        for segment_id, segment_info in segment_map.items():
            if segment_type_map.get(segment_id) not in {"dialogue_quote", "dialogue"}:
                continue
            utt_id = str(segment_info.get("utt_id") or "").strip()
            if utt_id:
                selected_segment_by_utt_id[utt_id] = segment_id
        for utterance in transcript_utterance_map.values():
            if known_duration > 0 and utterance["start"] >= known_duration:
                continue
            dialogue_map.append(
                {
                    "utt_id": utterance["utt_id"],
                    "scene_id": "",
                    "segment_id": selected_segment_by_utt_id.get(utterance["utt_id"], ""),
                    "speech_start": round(utterance["start"], 3),
                    "speech_end": round(min(utterance["end"], known_duration) if known_duration > 0 else utterance["end"], 3),
                    "caption": utterance["text"],
                    "source": "transcript_utterance",
                }
            )
        dialogue_map.sort(key=lambda row: (row.get("speech_start", 0), row.get("speech_end", 0), row.get("utt_id", "")))
        return dialogue_map
    selected_scene_ids = set()
    for segment_id, segment_info in segment_map.items():
        if segment_type_map.get(segment_id) not in {"dialogue_quote", "dialogue"}:
            continue
        source_clips = segment_info.get("source_clips", []) if isinstance(segment_info.get("source_clips", []), list) else []
        for clip in source_clips:
            if isinstance(clip, dict) and clip.get("scene_id"):
                selected_scene_ids.add(str(clip.get("scene_id")))

    scenes = gemini_analysis.get("scenes", []) if isinstance(gemini_analysis, dict) else []
    for scene in scenes:
        if not isinstance(scene, dict) or not has_dialogue_text(scene.get("dialogue_or_caption")):
            continue
        scene_id = str(scene.get("scene_id") or "").strip()
        if scene_id in selected_scene_ids:
            continue
        start_sec = safe_float(scene.get("start_sec"), None)
        end_sec = safe_float(scene.get("end_sec"), None)
        if start_sec is None or end_sec is None or end_sec <= start_sec:
            continue
        if known_duration > 0 and start_sec >= known_duration:
            continue
        if known_duration > 0:
            end_sec = min(end_sec, known_duration)
        active_ranges = detect_audio_activity_ranges(source_video_path, start_sec, end_sec) if source_video_path else []
        if not active_ranges:
            active_ranges = [(start_sec, end_sec)]
        for active_start, active_end in active_ranges:
            if active_end - active_start <= 0.2:
                continue
            dialogue_map.append(
                {
                    "scene_id": scene_id,
                    "speech_start": round(active_start, 3),
                    "speech_end": round(active_end, 3),
                    "caption": str(scene.get("dialogue_or_caption") or ""),
                    "source": "gemini_dialogue_scene_vad",
                }
            )

    for segment_id, segment_info in segment_map.items():
        if segment_type_map.get(segment_id) not in {"dialogue_quote", "dialogue"}:
            continue
        source_clips = segment_info.get("source_clips", []) if isinstance(segment_info.get("source_clips", []), list) else []
        for clip in source_clips:
            if not isinstance(clip, dict):
                continue
            start_sec = parse_timecode_to_sec(clip.get("start"))
            end_sec = parse_timecode_to_sec(clip.get("end"))
            if start_sec is None or end_sec is None or end_sec <= start_sec:
                continue
            dialogue_map.append(
                {
                    "scene_id": str(clip.get("scene_id") or ""),
                    "segment_id": segment_id,
                    "speech_start": round(start_sec, 3),
                    "speech_end": round(end_sec, 3),
                    "caption": str(segment_info.get("dialogue_original") or segment_info.get("caption_text") or ""),
                    "source": "selected_dialogue_quote",
                }
            )
    dialogue_map.sort(key=lambda row: (row.get("speech_start", 0), row.get("speech_end", 0), row.get("scene_id", "")))
    return dialogue_map


def validate_midform_dialogue_reserved_ranges(segment_map, segment_type_map, dialogue_map):
    violations = []
    tolerance_sec = 0.3
    dialogue_segment_types = {"dialogue_quote", "dialogue"}
    for segment_id, segment_info in segment_map.items():
        segment_type = segment_type_map.get(segment_id, "recap")
        source_clips = segment_info.get("source_clips", []) if isinstance(segment_info.get("source_clips", []), list) else []
        if not source_clips:
            source_clips = segment_info.get("source_scenes", []) if isinstance(segment_info.get("source_scenes", []), list) else []
        for clip in source_clips:
            if not isinstance(clip, dict):
                continue
            start_sec = parse_timecode_to_sec(clip.get("start"))
            end_sec = parse_timecode_to_sec(clip.get("end"))
            if start_sec is None or end_sec is None or end_sec <= start_sec:
                continue
            for speech in dialogue_map:
                speech_start = safe_float(speech.get("speech_start"), None)
                speech_end = safe_float(speech.get("speech_end"), None)
                if speech_start is None or speech_end is None or speech_end <= speech_start:
                    continue
                overlap_sec = min(end_sec, speech_end) - max(start_sec, speech_start)
                if overlap_sec <= 0.001:
                    continue
                if segment_type not in dialogue_segment_types:
                    if segment_info.get("narration_background") is True:
                        continue
                    violations.append(
                        {
                            "segment_id": segment_id,
                            "segment_type": segment_type,
                            "source_range": [round(start_sec, 3), round(end_sec, 3)],
                            "dialogue_range": [round(speech_start, 3), round(speech_end, 3)],
                            "dialogue_scene_id": speech.get("scene_id"),
                            "dialogue_caption": speech.get("caption"),
                            "overlap_sec": round(overlap_sec, 3),
                            "rule": "narration_overlaps_dialogue_map",
                        }
                    )
                else:
                    same_scene = str(clip.get("scene_id") or "") == str(speech.get("scene_id") or "")
                    selected_for_same_segment = speech.get("segment_id") == segment_id and speech.get("source") in {"selected_dialogue_quote", "transcript_utterance"}
                    if selected_for_same_segment:
                        continue
                    if same_scene:
                        start_delta = abs(start_sec - speech_start)
                        end_delta = abs(end_sec - speech_end)
                        if start_delta > tolerance_sec and end_delta > tolerance_sec:
                            violations.append(
                                {
                                    "segment_id": segment_id,
                                    "segment_type": segment_type,
                                    "source_range": [round(start_sec, 3), round(end_sec, 3)],
                                    "dialogue_range": [round(speech_start, 3), round(speech_end, 3)],
                                    "dialogue_scene_id": speech.get("scene_id"),
                                    "start_delta_sec": round(start_delta, 3),
                                    "end_delta_sec": round(end_delta, 3),
                                    "rule": "dialogue_not_aligned_to_dialogue_map",
                                }
                            )
    return violations


def apply_midform_dialogue_vad_guard(segment_map, segment_type_map, source_video_path, warnings):
    snap_reports = []
    dialogue_segment_types = {"dialogue_quote", "dialogue"}
    for segment_id, segment_info in segment_map.items():
        if segment_type_map.get(segment_id) not in dialogue_segment_types:
            continue
        source_clips = segment_info.get("source_clips", []) if isinstance(segment_info.get("source_clips", []), list) else []
        if not source_clips:
            continue
        clip = source_clips[0]
        start_sec = parse_timecode_to_sec(clip.get("start"))
        end_sec = parse_timecode_to_sec(clip.get("end"))
        if start_sec is None or end_sec is None or end_sec <= start_sec:
            continue
        window_start = max(0.0, start_sec - 3.0)
        window_end = end_sec + 3.0
        activity_ranges = detect_audio_activity_ranges(source_video_path, window_start, window_end)
        overlapping = [
            (max(start_sec, active_start), min(end_sec, active_end))
            for active_start, active_end in activity_ranges
            if min(end_sec, active_end) - max(start_sec, active_start) > 0.2
        ]
        if overlapping:
            snap_reports.append(
                {
                    "segment_id": segment_id,
                    "status": "activity_present",
                    "source_start": round(start_sec, 3),
                    "source_end": round(end_sec, 3),
                }
            )
            continue
        if not activity_ranges:
            raise ValueError(
                f"MIDFORM_DIALOGUE_VAD_FAILED: {segment_id} has no detected audio activity "
                f"in source window {round(window_start, 3)}-{round(window_end, 3)}"
            )
        nearest = min(activity_ranges, key=lambda row: abs(((row[0] + row[1]) / 2) - ((start_sec + end_sec) / 2)))
        correction_sec = max(abs(nearest[0] - start_sec), abs(nearest[1] - end_sec))
        if correction_sec > 3.0:
            warnings.append(f"{segment_id}: dialogue VAD correction exceeds 3s ({round(correction_sec, 3)}s)")
        clip["start"] = seconds_to_timecode(nearest[0])
        clip["end"] = seconds_to_timecode(nearest[1])
        snap_reports.append(
            {
                "segment_id": segment_id,
                "status": "snapped_to_audio_activity",
                "from": [round(start_sec, 3), round(end_sec, 3)],
                "to": [round(nearest[0], 3), round(nearest[1], 3)],
                "correction_sec": round(correction_sec, 3),
            }
        )
    return snap_reports


def create_draft(input_json_path):
    data = load_json_file(input_json_path)

    edit_mode = str(data.get("editMode") or "").strip().lower()
    if edit_mode in {"ultra_efficiency_process", "process_explainer"}:
        return create_process_draft(data)

    segments = data.get("segments", [])
    claude_script = data.get("claudeScript", {}) if isinstance(data.get("claudeScript", {}), dict) else {}
    gemini_analysis = data.get("geminiAnalysis") if isinstance(data.get("geminiAnalysis"), dict) else data.get("gemini_analysis")
    if not isinstance(gemini_analysis, dict):
        gemini_analysis = claude_script.get("geminiAnalysis") if isinstance(claude_script.get("geminiAnalysis"), dict) else {}
    if not isinstance(gemini_analysis, dict) or not gemini_analysis:
        gemini_analysis = load_json_file_if_exists(data.get("geminiAnalysisPath") or data.get("gemini_analysis_path")) or {}
    source_transcript = data.get("sourceTranscript") if isinstance(data.get("sourceTranscript"), dict) else data.get("source_transcript")
    if not isinstance(source_transcript, dict):
        source_transcript = load_json_file_if_exists(data.get("sourceTranscriptPath") or data.get("source_transcript_path") or data.get("transcriptPath") or data.get("transcript_path"))
    if not isinstance(source_transcript, dict):
        source_transcript = gemini_analysis.get("source_transcript") if isinstance(gemini_analysis.get("source_transcript"), dict) else {}
    slot_map_input = data.get("slotMap") if isinstance(data.get("slotMap"), dict) else data.get("slot_map")
    if not isinstance(slot_map_input, dict):
        slot_map_input = claude_script.get("slot_map") if isinstance(claude_script.get("slot_map"), dict) else {}
    slot_map_mode = bool(slot_map_input.get("slots"))
    transcript_utterance_map = build_transcript_utterance_map(source_transcript)
    tts_files = data.get("ttsFiles", [])
    caption_color_config = load_caption_color_config()
    tts_duration_by_segment = {}
    for tts_item in tts_files if isinstance(tts_files, list) else []:
        if not isinstance(tts_item, dict):
            continue
        tts_segment_id = str(tts_item.get("segment_id") or tts_item.get("segmentId") or "").strip()
        if not tts_segment_id:
            continue
        tts_duration_by_segment[tts_segment_id] = tts_duration_by_segment.get(tts_segment_id, 0.0) + safe_float(tts_item.get("duration_sec"), 0.0)
    caption_units_input = data.get("captionUnits", []) if isinstance(data.get("captionUnits", []), list) else []
    caption_warnings_input = data.get("captionWarnings", []) if isinstance(data.get("captionWarnings", []), list) else []
    srt_file = data.get("srtFile", "")
    width = data.get("resolution", {}).get("width", 1080)
    height = data.get("resolution", {}).get("height", 1920)
    audio_path_mode = str(data.get("audioPathMode", "absolute") or "absolute").lower()
    if audio_path_mode not in {"absolute", "relative", "both"}:
        audio_path_mode = "absolute"
    video_placement_mode = str(data.get("videoPlacementMode", "source_clips") or "source_clips").lower()
    if video_placement_mode not in {"source_clips", "full_source"}:
        video_placement_mode = "source_clips"
    use_capcut_template = coerce_bool(data.get("useCapcutTemplate", True), True)
    draft_output_policy = resolve_draft_output_policy(data)
    create_zip = draft_output_policy["create_zip"]
    final_slot_tail_allowance_sec = max(0.0, safe_float(data.get("finalSlotTailAllowanceSec") or data.get("tailAllowanceSec"), MIDFORM_FINAL_SLOT_TAIL_ALLOWANCE_SEC))

    draft_name = sanitize_draft_name(data.get("draftName") or data.get("draft_name")) or f"pipeline_{int(time.time())}"
    output_base = select_output_base_path(data)
    os.makedirs(output_base, exist_ok=True)
    draft_path = os.path.abspath(os.path.join(output_base, draft_name))
    audio_dir = os.path.join(draft_path, "audio")
    subtitle_dir = os.path.join(draft_path, "subtitles")
    video_dir = os.path.join(draft_path, "video")

    warnings = []
    template_info = find_capcut_template_files() if use_capcut_template else None
    template_draft_content = None
    template_meta_info = None
    template_profiles = {"title": None, "subtitle": None, "emphasis": None, "sources": {}, "summary": []}
    fallback_template_style_used = False
    if use_capcut_template:
        if template_info:
            try:
                template_draft_content = load_json_file(template_info["draft_content_path"])
                template_profiles = extract_template_text_profiles(template_draft_content)
            except (OSError, json.JSONDecodeError) as error:
                warnings.append(f"failed to load template draft_content: {error}")
            if template_info.get("draft_meta_info_path"):
                try:
                    template_meta_info = load_json_file(template_info["draft_meta_info_path"])
                except (OSError, json.JSONDecodeError) as error:
                    warnings.append(f"failed to load template draft_meta_info: {error}")
        else:
            warnings.append("capcut template not found under templates/capcut/channel_default (depth<=2)")

    subtitle_track_relative_index = 2
    subtitle_profile = template_profiles.get("subtitle")
    if isinstance(subtitle_profile, dict):
        source_info = subtitle_profile.get("source") or {}
        track_idx = source_info.get("track_index")
        if isinstance(track_idx, int):
            subtitle_track_relative_index = track_idx

    draft_folder = cc.DraftFolder(output_base)
    script = draft_folder.create_draft(draft_name, width, height, fps=data.get("fps", 30), allow_replace=True)
    os.makedirs(audio_dir, exist_ok=True)
    os.makedirs(subtitle_dir, exist_ok=True)
    os.makedirs(video_dir, exist_ok=True)
    script.add_track(cc.TrackType.video, "source_video", relative_index=0)
    script.add_track(cc.TrackType.audio, "tts", relative_index=1)
    script.add_track(cc.TrackType.text, "subtitle", relative_index=subtitle_track_relative_index)

    source_video_path = select_source_video_path(data)
    draft_video_path = ""
    source_duration_sec = None
    source_duration_us = 0
    source_video_material = None
    video_cut_placements = []
    if source_video_path:
        draft_video_path = os.path.abspath(os.path.join(video_dir, "source.mp4"))
        shutil.copy2(source_video_path, draft_video_path)

        source_duration_sec = get_video_duration_sec_ffprobe(draft_video_path)
        if source_duration_sec is None:
            warnings.append(f"source video duration probe failed: {draft_video_path}")
            source_duration_sec = 0.0

        source_video_material = cc.VideoMaterial(draft_video_path)
        material_duration_us = int(source_video_material.duration or 0)
        probe_duration_us = int(round(float(source_duration_sec or 0) * 1_000_000))
        source_duration_us = min(material_duration_us, probe_duration_us) if probe_duration_us > 0 else material_duration_us

        if source_duration_us <= 0:
            source_duration_sec = 0.0
            warnings.append(f"source video duration invalid: {draft_video_path}")

    story_sync_segment_reports = []
    if transcript_utterance_map and not slot_map_mode:
        for segment in segments if isinstance(segments, list) else []:
            if not isinstance(segment, dict):
                continue
            segment_type = str(segment.get("segment_type") or "").strip()
            if segment_type in {"dialogue_quote", "dialogue"}:
                continue
            selected = choose_story_anchor_source_clips(
                segment,
                tts_duration_by_segment.get(str(segment.get("segment_id") or ""), 0.0),
                transcript_utterance_map,
                source_duration_sec or data.get("sourceDurationSec") or data.get("source_duration_sec") or 0.0,
            )
            if not selected:
                continue
            selected_clips, selected_report = selected
            if selected_clips:
                segment["source_clips"] = selected_clips
                segment["source_scenes"] = selected_clips
            story_sync_segment_reports.append(selected_report)
            if selected_report.get("warning"):
                warnings.append(f"{selected_report.get('segment_id')}: {selected_report.get('warning')}")

    segment_map = {}
    segment_type_map = {}
    for segment in segments:
        segment_id = str(segment.get("segment_id", "")).strip()
        if segment_id:
            segment_map[segment_id] = segment
            segment_type_map[segment_id] = str(segment.get("segment_type") or "recap").strip()

    midform_hybrid_mode = any(segment_type in {"dialogue_quote", "dialogue"} for segment_type in segment_type_map.values())

    dialogue_map = []
    dialogue_reserved_range_violations = []
    if midform_hybrid_mode:
        known_duration_sec = source_duration_us / 1_000_000 if source_duration_us > 0 else safe_float(
            data.get("sourceDurationSec") or data.get("source_duration_sec") or (gemini_analysis.get("selected_source") or {}).get("duration_sec"),
            0.0,
        )
        dialogue_map = build_midform_dialogue_map(gemini_analysis, segment_map, segment_type_map, known_duration_sec, source_video_path, source_transcript)
        dialogue_reserved_range_violations = validate_midform_dialogue_reserved_ranges(segment_map, segment_type_map, dialogue_map)
        if dialogue_reserved_range_violations:
            preview = "; ".join(
                f"{item.get('segment_id')} {item.get('rule')} {item.get('source_range')} vs {item.get('dialogue_range')}"
                for item in dialogue_reserved_range_violations[:8]
            )
            raise ValueError(f"MIDFORM_DIALOGUE_RESERVED_RANGE_FAILED: {preview}")
    dialogue_vad_reports = []
    if midform_hybrid_mode and source_video_path and not transcript_utterance_map:
        dialogue_vad_reports = apply_midform_dialogue_vad_guard(segment_map, segment_type_map, source_video_path, warnings)

    def get_segment_source_clips(segment_info):
        segment_type = str(segment_info.get("segment_type") or "").strip()
        utt_id = str(segment_info.get("utt_id") or "").strip()
        utterance = transcript_utterance_map.get(utt_id) if utt_id else None
        if utterance and segment_type in {"dialogue_quote", "dialogue"}:
            explicit_clips = segment_info.get("source_clips", []) if isinstance(segment_info.get("source_clips", []), list) else []
            if not explicit_clips:
                explicit_clips = segment_info.get("source_scenes", []) if isinstance(segment_info.get("source_scenes", []), list) else []
            if explicit_clips and isinstance(explicit_clips[0], dict):
                clip = explicit_clips[0]
                clip_start = parse_timecode_to_sec(clip.get("start"))
                clip_end = parse_timecode_to_sec(clip.get("end"))
                if str(clip.get("source") or "") == "locale_draft_spec" and clip_start is not None and clip_end is not None and clip_end > clip_start:
                    return [
                        {
                            "clip_id": str(clip.get("clip_id") or f"locale_{utt_id}"),
                            "scene_id": str(clip.get("scene_id") or ""),
                            "utt_id": utt_id,
                            "start": seconds_to_timecode(clip_start),
                            "end": seconds_to_timecode(clip_end),
                            "speed_multiplier": safe_float(clip.get("speed_multiplier"), 1.0) or 1.0,
                            "source": "locale_draft_spec",
                        }
                    ]
                if clip_start is not None and clip_end is not None and clip_start >= utterance["start"] - 0.05 and clip_end <= utterance["end"] + 0.05 and clip_end > clip_start:
                    return [
                        {
                            "clip_id": str(clip.get("clip_id") or f"transcript_{utt_id}"),
                            "scene_id": str(clip.get("scene_id") or ""),
                            "utt_id": utt_id,
                            "start": seconds_to_timecode(clip_start),
                            "end": seconds_to_timecode(clip_end),
                            "speed_multiplier": 1.0,
                            "source": "transcript_utterance_subrange",
                        }
                    ]
            return [
                {
                    "clip_id": f"transcript_{utt_id}",
                    "scene_id": str((segment_info.get("source_scenes") or [{}])[0].get("scene_id") or "") if isinstance(segment_info.get("source_scenes"), list) else "",
                    "utt_id": utt_id,
                    "start": seconds_to_timecode(utterance["start"]),
                    "end": seconds_to_timecode(utterance["end"]),
                    "speed_multiplier": 1.0,
                    "source": "transcript_utterance",
                }
            ]
        if transcript_utterance_map and segment_type in {"dialogue_quote", "dialogue"}:
            if not utt_id:
                raise ValueError(f"MIDFORM_TRANSCRIPT_DIALOGUE_UTT_ID_REQUIRED: {segment_info.get('segment_id') or 'unknown_segment'}")
            raise ValueError(f"MIDFORM_TRANSCRIPT_UTTERANCE_NOT_FOUND: {segment_info.get('segment_id') or 'unknown_segment'} references {utt_id}")
        source_clips = segment_info.get("source_clips", []) if isinstance(segment_info.get("source_clips", []), list) else []
        if source_clips:
            return source_clips
        source_scenes = segment_info.get("source_scenes", []) if isinstance(segment_info.get("source_scenes", []), list) else []
        converted = []
        for index, scene_ref in enumerate(source_scenes):
            if not isinstance(scene_ref, dict):
                continue
            start_value = scene_ref.get("start") or scene_ref.get("start_time") or scene_ref.get("start_sec")
            end_value = scene_ref.get("end") or scene_ref.get("end_time") or scene_ref.get("end_sec")
            if isinstance(start_value, (int, float)):
                start_value = f"00:{float(start_value):06.3f}"
            if isinstance(end_value, (int, float)):
                end_value = f"00:{float(end_value):06.3f}"
            converted.append(
                {
                    "clip_id": str(scene_ref.get("clip_id") or scene_ref.get("scene_id") or f"source_scene_{index + 1:03d}"),
                    "scene_id": str(scene_ref.get("scene_id") or ""),
                    "start": start_value,
                    "end": end_value,
                    "speed_multiplier": scene_ref.get("speed_multiplier"),
                    "source": "source_scenes",
                }
            )
        return converted

    if slot_map_mode and source_duration_us > 0:
        for segment_id, segment_info in segment_map.items():
            segment_type = segment_type_map.get(segment_id, "recap")
            if segment_type in {"dialogue_quote", "dialogue"}:
                continue
            target_duration_sec = safe_float(tts_duration_by_segment.get(segment_id), 0.0)
            if target_duration_sec <= 0:
                continue
            source_clips = get_segment_source_clips(segment_info)
            if not source_clips:
                continue
            clip = source_clips[0]
            start_sec = parse_timecode_to_sec(clip.get("start"))
            end_sec = parse_timecode_to_sec(clip.get("end"))
            if start_sec is None or end_sec is None or end_sec <= start_sec:
                continue
            source_duration_sec_for_slot = min(end_sec, source_duration_us / 1_000_000) - start_sec
            if source_duration_sec_for_slot <= 0:
                continue
            speed_multiplier = source_duration_sec_for_slot / target_duration_sec
            if speed_multiplier > 1.5:
                source_duration_sec_for_slot = target_duration_sec * 1.5
                clip["end"] = seconds_to_timecode(start_sec + source_duration_sec_for_slot)
                speed_multiplier = 1.5
            elif speed_multiplier < 0.7:
                speed_multiplier = 0.7
            clip["speed_multiplier"] = round(speed_multiplier, 6)

    final_slot_tail = build_final_slot_tail_plan(slot_map_input, gemini_analysis, source_duration_us, final_slot_tail_allowance_sec)

    current_time_us = 0
    if not source_video_path:
        warnings.append("source video not found: input/source_clean.mp4 or input/source.mp4")
    added_audio_count = 0
    edit_manifest_entries = []
    caption_timeline_entries = []
    caption_manifest_entries = []
    segment_to_caption_map = {}
    split_warnings = []
    tts_timeline_by_caption_id = {}

    for warning in caption_warnings_input:
        if not isinstance(warning, dict):
            continue
        reason = str(warning.get("reason") or "").strip().lower()
        message = str(warning.get("message") or "").strip()
        if reason == "long_sentence_split" or ("split" in message.lower() and message):
            split_warnings.append(warning)

    tts_by_caption_id = {}
    for tts_item in tts_files:
        if not isinstance(tts_item, dict):
            continue
        tts_caption_id = str(tts_item.get("caption_id") or tts_item.get("captionId") or "").strip()
        if tts_caption_id:
            tts_by_caption_id[tts_caption_id] = tts_item

    decoupled_tts_caption_units = any(
        isinstance(unit, dict)
        and unit.get("tts_enabled") is not False
        and str(unit.get("tts_caption_id") or unit.get("sentence_id") or "").strip()
        for unit in caption_units_input
    )

    non_tts_unit_counts_by_segment = {}
    for unit in caption_units_input:
        if not isinstance(unit, dict):
            continue
        if unit.get("tts_enabled") is not False:
            continue
        unit_segment_id = str(unit.get("segment_id") or unit.get("segmentId") or "").strip()
        if unit_segment_id:
            non_tts_unit_counts_by_segment[unit_segment_id] = non_tts_unit_counts_by_segment.get(unit_segment_id, 0) + 1

    def estimate_non_tts_caption_duration_us(segment_info, segment_id, segment_type=""):
        source_clips = get_segment_source_clips(segment_info)
        total_source_sec = 0.0
        for clip in source_clips:
            start_sec = parse_timecode_to_sec(clip.get("start"))
            end_sec = parse_timecode_to_sec(clip.get("end"))
            if start_sec is None or end_sec is None or end_sec <= start_sec:
                continue
            total_source_sec += end_sec - start_sec
        unit_count = max(1, non_tts_unit_counts_by_segment.get(segment_id, 1))
        if total_source_sec > 0:
            duration_sec = total_source_sec / unit_count
        else:
            duration_sec = 2.0
        # scene_hook plays its full source clip like dialogue — never clamp it to caption pacing.
        if str(segment_type or segment_type_map.get(segment_id) or "") not in {"dialogue_quote", "dialogue", "scene_hook"}:
            duration_sec = max(1.0, min(duration_sec, 4.0))
        else:
            duration_sec = max(0.001, duration_sec)
        return int(round(duration_sec * 1_000_000))

    if caption_units_input:
        draft_timeline_units = []
        if decoupled_tts_caption_units:
            emitted_tts_caption_ids = set()
            for unit_index, unit in enumerate(caption_units_input):
                if not isinstance(unit, dict):
                    continue
                if unit.get("tts_enabled") is False:
                    draft_timeline_units.append({"caption_unit": unit, "tts": None})
                    continue
                tts_caption_id = str(unit.get("tts_caption_id") or unit.get("sentence_id") or "").strip()
                if not tts_caption_id or tts_caption_id in emitted_tts_caption_ids:
                    continue
                tts_item = tts_by_caption_id.get(tts_caption_id)
                if tts_item:
                    draft_timeline_units.append({"caption_unit": None, "tts": tts_item})
                    emitted_tts_caption_ids.add(tts_caption_id)
                else:
                    warnings.append(f"{tts_caption_id}: sentence TTS referenced by caption unit but no generated TTS file was found")
        else:
            for unit_index, unit in enumerate(caption_units_input):
                if not isinstance(unit, dict):
                    continue
                unit_caption_id = str(unit.get("caption_id") or unit.get("captionId") or f"cap_{unit_index + 1:03d}").strip()
                tts_item = tts_by_caption_id.get(unit_caption_id)
                if unit.get("tts_enabled") is False:
                    draft_timeline_units.append({"caption_unit": unit, "tts": None})
                elif tts_item:
                    draft_timeline_units.append({"caption_unit": unit, "tts": tts_item})
                else:
                    warnings.append(f"{unit_caption_id}: caption unit is TTS-enabled but no generated TTS file was found")
    else:
        draft_timeline_units = [{"caption_unit": None, "tts": tts_item} for tts_item in tts_files if isinstance(tts_item, dict)]

    for idx, timeline_item in enumerate(draft_timeline_units):
        caption_unit = timeline_item.get("caption_unit") if isinstance(timeline_item.get("caption_unit"), dict) else None
        tts = timeline_item.get("tts") if isinstance(timeline_item.get("tts"), dict) else None
        if tts is None and caption_unit is None:
            continue
        segment_id = str((tts or {}).get("segment_id") or (tts or {}).get("segmentId") or f"seg_{idx + 1:03d}")
        if caption_unit is not None:
            segment_id = str(caption_unit.get("segment_id") or caption_unit.get("segmentId") or segment_id)
        caption_id = str(tts.get("caption_id") or tts.get("captionId") or f"{segment_id}_cap_{idx + 1:03d}") if tts else str(caption_unit.get("caption_id") or caption_unit.get("captionId") or f"{segment_id}_cap_{idx + 1:03d}")
        segment_info = segment_map.get(segment_id, {})
        narration = (caption_unit.get("text") if caption_unit else None) or (tts.get("text") if tts else None) or segment_info.get("narration", "")
        segment_type = str((caption_unit or {}).get("segment_type") or (caption_unit or {}).get("segmentType") or segment_type_map.get(segment_id) or "").strip()
        is_dialogue_caption = segment_type in {"dialogue_quote", "dialogue"}
        caption_kind = str((caption_unit or {}).get("caption_kind") or segment_info.get("caption_kind") or ("dialogue" if is_dialogue_caption else "narration")).strip()
        speaker = str((caption_unit or {}).get("speaker") or (caption_unit or {}).get("speaker_alias") or segment_info.get("speaker") or segment_info.get("speaker_alias") or "").strip()
        speaker_id = str((caption_unit or {}).get("speaker_id") or segment_info.get("speaker_id") or "").strip()
        speaker_alias = str((caption_unit or {}).get("speaker_alias") or segment_info.get("speaker_alias") or speaker or "").strip()
        speaker_color_key = str((caption_unit or {}).get("speaker_color_key") or segment_info.get("speaker_color_key") or "").strip()
        source_utterance_id = str((caption_unit or {}).get("source_utterance_id") or segment_info.get("source_utterance_id") or segment_info.get("utt_id") or "").strip()
        caption_color = str((caption_unit or {}).get("caption_color") or segment_info.get("caption_color") or "").strip()
        if is_dialogue_caption:
            caption_color = caption_color or resolve_caption_color_for_dialogue(speaker_alias or speaker, speaker_color_key, caption_color_config)
            if not speaker_id or not speaker_alias or not speaker_color_key or not source_utterance_id:
                warnings.append(f"{caption_id}: dialogue caption is missing speaker metadata")
            if not caption_color:
                warnings.append(f"{caption_id}: dialogue caption has no resolved speaker color")
        else:
            caption_color = ""
        source_clips = get_segment_source_clips(segment_info)
        combined_segment_ids = caption_unit.get("combined_segment_ids") if isinstance(caption_unit, dict) and isinstance(caption_unit.get("combined_segment_ids"), list) else []
        if combined_segment_ids:
            combined_source_clips = []
            for combined_segment_id in combined_segment_ids:
                combined_source_clips.extend(get_segment_source_clips(segment_map.get(str(combined_segment_id), {})))
            if combined_source_clips:
                source_clips = combined_source_clips

        timeline_start_us = current_time_us
        timeline_end_us = current_time_us
        segment_warnings = []

        if tts is None:
            visual_duration_us = estimate_non_tts_caption_duration_us(segment_info, segment_id, segment_type)
            duration_us = visual_duration_us
            duration_override_sec = safe_float(caption_unit.get("duration_override_sec") if caption_unit else 0, 0.0)
            if duration_override_sec > 0:
                duration_us = int(round(duration_override_sec * 1_000_000))
            caption_offset_sec = safe_float(caption_unit.get("caption_timeline_offset_sec") if caption_unit else 0, 0.0)
            caption_offset_us = max(0, int(round(caption_offset_sec * 1_000_000)))
            video_timeline_start_us = current_time_us
            video_timeline_end_us = current_time_us + visual_duration_us
            timeline_start_us = min(video_timeline_end_us - 1, current_time_us + caption_offset_us) if visual_duration_us > 1 else current_time_us
            timeline_end_us = min(video_timeline_end_us, timeline_start_us + duration_us)
            duration_us = max(1, timeline_end_us - timeline_start_us)
            current_time_us = video_timeline_end_us

            caption_timeline_entries.append(
                {
                    "caption_id": caption_id,
                    "segment_id": segment_id,
                    "segment_type": segment_type,
                    "caption_kind": caption_kind,
                    "tts_enabled": False,
                    "timeline_start_us": timeline_start_us,
                    "timeline_end_us": timeline_end_us,
                    "tts_duration_us": visual_duration_us,
                    "video_timeline_start_us": video_timeline_start_us,
                    "video_timeline_end_us": video_timeline_end_us,
                    "caption_timeline_offset_sec": round(caption_offset_us / 1_000_000, 6),
                    "text": narration,
                    "speaker": speaker,
                    "speaker_id": speaker_id,
                    "speaker_alias": speaker_alias,
                    "speaker_color_key": speaker_color_key,
                    "source_utterance_id": source_utterance_id,
                    "caption_color": caption_color,
                    "mp3_path": "",
                    "combined_segment_ids": combined_segment_ids,
                }
            )
            segment_to_caption_map.setdefault(segment_id, []).append(caption_id)
            caption_manifest_entries.append(
                {
                    "caption_id": caption_id,
                    "segment_id": segment_id,
                    "segment_type": segment_type,
                    "caption_kind": caption_kind,
                    "tts_enabled": False,
                    "text": narration,
                    "speaker": speaker,
                    "speaker_id": speaker_id,
                    "speaker_alias": speaker_alias,
                    "speaker_color_key": speaker_color_key,
                    "source_utterance_id": source_utterance_id,
                    "caption_color": caption_color,
                    "start_sec": round(timeline_start_us / 1_000_000, 6),
                    "end_sec": round(timeline_end_us / 1_000_000, 6),
                    "duration_sec": round(duration_us / 1_000_000, 6),
                    "video_start_sec": round(video_timeline_start_us / 1_000_000, 6),
                    "video_end_sec": round(video_timeline_end_us / 1_000_000, 6),
                    "video_duration_sec": round(visual_duration_us / 1_000_000, 6),
                    "caption_timeline_offset_sec": round(caption_offset_us / 1_000_000, 6),
                    "mp3_path": "",
                    "combined_segment_ids": combined_segment_ids,
                }
            )
            edit_manifest_entries.append(
                {
                    "caption_id": caption_id,
                    "segment_id": segment_id,
                    "segment_type": segment_type,
                    "caption_kind": caption_kind,
                    "tts_enabled": False,
                    "narration": narration,
                    "speaker": speaker,
                    "speaker_id": speaker_id,
                    "speaker_alias": speaker_alias,
                    "speaker_color_key": speaker_color_key,
                    "source_utterance_id": source_utterance_id,
                    "caption_color": caption_color,
                    "tts_source_path": "",
                    "tts_draft_path": "",
                    "tts_draft_relative_path": "",
                    "duration_sec": round(duration_us / 1_000_000, 6),
                    "timeline_start_sec": round(timeline_start_us / 1_000_000, 6),
                    "timeline_end_sec": round(timeline_end_us / 1_000_000, 6),
                    "video_timeline_start_sec": round(video_timeline_start_us / 1_000_000, 6),
                    "video_timeline_end_sec": round(video_timeline_end_us / 1_000_000, 6),
                    "video_duration_sec": round(visual_duration_us / 1_000_000, 6),
                    "caption_timeline_offset_sec": round(caption_offset_us / 1_000_000, 6),
                    "source_clips": source_clips,
                    "combined_segment_ids": combined_segment_ids,
                    "warnings": ["subtitle-only original-dialogue caption; no TTS audio generated"],
                }
            )
            continue

        tts_path = tts.get("filepath", "")
        raw_duration_sec = tts.get("duration_sec", 0)
        draft_filename = os.path.basename(tts.get("filename") or f"{caption_id}.mp3")
        draft_audio_path = os.path.abspath(os.path.join(audio_dir, draft_filename))

        def record_manifest_entry(draft_path_value, duration_value):
            draft_relative_path = ""
            if draft_path_value:
                try:
                    draft_relative_path = os.path.relpath(draft_path_value, draft_path).replace("\\", "/")
                except ValueError:
                    draft_relative_path = ""
            edit_manifest_entries.append(
                {
                    "caption_id": caption_id,
                    "segment_id": segment_id,
                    "segment_type": segment_type,
                    "caption_kind": caption_kind,
                    "tts_enabled": True,
                    "narration": narration,
                    "speaker": speaker,
                    "speaker_id": speaker_id,
                    "speaker_alias": speaker_alias,
                    "speaker_color_key": speaker_color_key,
                    "source_utterance_id": source_utterance_id,
                    "caption_color": caption_color,
                    "tts_source_path": tts_path,
                    "tts_draft_path": draft_path_value,
                    "tts_draft_relative_path": draft_relative_path,
                    "duration_sec": duration_value,
                    "timeline_start_sec": round(timeline_start_us / 1_000_000, 6),
                    "timeline_end_sec": round(timeline_end_us / 1_000_000, 6),
                    "source_clips": source_clips,
                    "warnings": segment_warnings,
                }
            )

        if not tts_path:
            segment_warnings.append("missing filepath")
            warnings.append(f"{caption_id}: missing filepath")
            record_manifest_entry("", None)
            continue
        if not os.path.exists(tts_path):
            segment_warnings.append("file not found")
            warnings.append(f"{caption_id}: file not found - {tts_path}")
            record_manifest_entry("", None)
            continue
        if os.path.getsize(tts_path) <= 0:
            segment_warnings.append("zero-byte source audio")
            warnings.append(f"{caption_id}: zero-byte audio file skipped")
            record_manifest_entry("", None)
            continue

        shutil.copy2(tts_path, draft_audio_path)
        if os.path.getsize(draft_audio_path) <= 0:
            segment_warnings.append("copied audio is zero-byte")
            warnings.append(f"{caption_id}: copied audio is zero-byte - {draft_audio_path}")
            record_manifest_entry(draft_audio_path, None)
            continue

        try:
            duration_sec = float(raw_duration_sec or 0)
        except (TypeError, ValueError):
            duration_sec = 0.0

        if duration_sec <= 0:
            segment_warnings.append(f"invalid duration_sec ({raw_duration_sec})")
            warnings.append(f"{caption_id}: invalid duration_sec ({raw_duration_sec})")
            record_manifest_entry(draft_audio_path, None)
            continue

        requested_duration_us = int(round(duration_sec * 1_000_000))

        audio_material = cc.AudioMaterial(draft_audio_path)
        material_duration_us = int(audio_material.duration or 0)
        if material_duration_us <= 0:
            segment_warnings.append(f"material duration invalid ({material_duration_us})")
            warnings.append(f"{caption_id}: material duration is invalid ({material_duration_us})")
            record_manifest_entry(draft_audio_path, None)
            continue

        duration_us = min(requested_duration_us, material_duration_us)
        if duration_us <= 0:
            segment_warnings.append(f"computed duration invalid ({duration_us})")
            warnings.append(f"{caption_id}: computed duration is invalid ({duration_us})")
            record_manifest_entry(draft_audio_path, None)
            continue

        if requested_duration_us > material_duration_us:
            clamp_note = (
                f"requested duration {requested_duration_us}us exceeds material {material_duration_us}us, clamped"
            )
            segment_warnings.append(clamp_note)
            warnings.append(f"{caption_id}: {clamp_note}")

        script.add_material(audio_material)
        audio_segment = cc.AudioSegment(
            material=audio_material,
            source_timerange=cc.Timerange(start=0, duration=duration_us),
            target_timerange=cc.Timerange(start=current_time_us, duration=duration_us),
        )
        script.add_segment(audio_segment, track_name="tts")
        timeline_end_us = current_time_us + duration_us
        current_time_us += duration_us
        added_audio_count += 1

        caption_timeline_entries.append(
            {
                "caption_id": caption_id,
                "segment_id": segment_id,
                "segment_type": segment_type,
                "caption_kind": caption_kind,
                "tts_enabled": True,
                "timeline_start_us": timeline_start_us,
                "timeline_end_us": timeline_end_us,
                "tts_duration_us": duration_us,
                "text": narration,
                "speaker": speaker,
                "speaker_id": speaker_id,
                "speaker_alias": speaker_alias,
                "speaker_color_key": speaker_color_key,
                "source_utterance_id": source_utterance_id,
                "caption_color": caption_color,
                "mp3_path": draft_audio_path,
                "combined_segment_ids": combined_segment_ids,
            }
        )
        tts_timeline_by_caption_id[caption_id] = {
            "caption_id": caption_id,
            "segment_id": segment_id,
            "segment_type": segment_type,
            "caption_kind": caption_kind,
            "speaker": speaker,
            "speaker_id": speaker_id,
            "speaker_alias": speaker_alias,
            "speaker_color_key": speaker_color_key,
            "source_utterance_id": source_utterance_id,
            "caption_color": caption_color,
            "timeline_start_us": timeline_start_us,
            "timeline_end_us": timeline_end_us,
            "duration_us": duration_us,
            "mp3_path": draft_audio_path,
            "combined_segment_ids": combined_segment_ids,
        }

        segment_to_caption_map.setdefault(segment_id, []).append(caption_id)
        caption_manifest_entries.append(
            {
                "caption_id": caption_id,
                "segment_id": segment_id,
                "segment_type": segment_type,
                "caption_kind": caption_kind,
                "tts_enabled": True,
                "text": narration,
                "speaker": speaker,
                "speaker_id": speaker_id,
                "speaker_alias": speaker_alias,
                "speaker_color_key": speaker_color_key,
                "source_utterance_id": source_utterance_id,
                "caption_color": caption_color,
                "start_sec": round(timeline_start_us / 1_000_000, 6),
                "end_sec": round(timeline_end_us / 1_000_000, 6),
                "duration_sec": round(duration_us / 1_000_000, 6),
                "mp3_path": draft_audio_path,
            }
        )

        record_manifest_entry(draft_audio_path, round(duration_us / 1_000_000, 6))

    if decoupled_tts_caption_units:
        grouped_caption_units = {}
        grouped_caption_order = []
        for unit in caption_units_input:
            if not isinstance(unit, dict) or unit.get("tts_enabled") is False:
                continue
            tts_caption_id = str(unit.get("tts_caption_id") or unit.get("sentence_id") or "").strip()
            if not tts_caption_id:
                continue
            if tts_caption_id not in grouped_caption_units:
                grouped_caption_units[tts_caption_id] = []
                grouped_caption_order.append(tts_caption_id)
            grouped_caption_units[tts_caption_id].append(unit)

        display_caption_timeline_entries = [entry for entry in caption_timeline_entries if entry.get("tts_enabled") is False]
        display_caption_manifest_entries = [entry for entry in caption_manifest_entries if entry.get("tts_enabled") is False]

        for tts_caption_id in grouped_caption_order:
            sentence_timeline = tts_timeline_by_caption_id.get(tts_caption_id)
            units_for_sentence = grouped_caption_units.get(tts_caption_id) or []
            if not sentence_timeline:
                warnings.append(f"{tts_caption_id}: sentence TTS timeline not found for proportional subtitles")
                continue
            start_us = int(sentence_timeline.get("timeline_start_us") or 0)
            end_us = int(sentence_timeline.get("timeline_end_us") or start_us)
            duration_us = max(1, end_us - start_us)
            weights = [max(1, len(str(unit.get("text") or ""))) for unit in units_for_sentence]
            total_weight = sum(weights) or 1
            elapsed_weight = 0
            for unit_index, unit in enumerate(units_for_sentence):
                unit_weight = weights[unit_index]
                unit_start_us = start_us + int(round(duration_us * elapsed_weight / total_weight))
                elapsed_weight += unit_weight
                unit_end_us = end_us if unit_index == len(units_for_sentence) - 1 else start_us + int(round(duration_us * elapsed_weight / total_weight))
                unit_duration_us = max(1, unit_end_us - unit_start_us)
                caption_id_value = str(unit.get("caption_id") or unit.get("captionId") or f"{tts_caption_id}_cap_{unit_index + 1:03d}")
                segment_id_value = str(unit.get("segment_id") or unit.get("segmentId") or sentence_timeline.get("segment_id") or "")
                segment_type_value = str(
                    unit.get("segment_type")
                    or unit.get("segmentType")
                    or sentence_timeline.get("segment_type")
                    or segment_type_map.get(segment_id_value)
                    or ""
                )
                text_value = str(unit.get("text") or "")
                caption_kind_value = str(unit.get("caption_kind") or sentence_timeline.get("caption_kind") or ("dialogue" if segment_type_value in {"dialogue_quote", "dialogue"} else "narration")).strip()
                speaker_value = str(unit.get("speaker") or unit.get("speaker_alias") or sentence_timeline.get("speaker") or "").strip()
                speaker_id_value = str(unit.get("speaker_id") or sentence_timeline.get("speaker_id") or "").strip()
                speaker_alias_value = str(unit.get("speaker_alias") or sentence_timeline.get("speaker_alias") or speaker_value or "").strip()
                speaker_color_key_value = str(unit.get("speaker_color_key") or sentence_timeline.get("speaker_color_key") or "").strip()
                source_utterance_id_value = str(unit.get("source_utterance_id") or sentence_timeline.get("source_utterance_id") or "").strip()
                caption_color_value = str(unit.get("caption_color") or sentence_timeline.get("caption_color") or "").strip()
                if segment_type_value in {"dialogue_quote", "dialogue"}:
                    caption_color_value = caption_color_value or resolve_caption_color_for_dialogue(speaker_alias_value or speaker_value, speaker_color_key_value, caption_color_config)
                combined_segment_ids = unit.get("combined_segment_ids") if isinstance(unit.get("combined_segment_ids"), list) else sentence_timeline.get("combined_segment_ids") or []
                display_caption_timeline_entries.append(
                    {
                        "caption_id": caption_id_value,
                        "sentence_id": tts_caption_id,
                        "tts_caption_id": tts_caption_id,
                        "segment_id": segment_id_value,
                        "segment_type": segment_type_value,
                        "caption_kind": caption_kind_value,
                        "tts_enabled": True,
                        "timeline_start_us": unit_start_us,
                        "timeline_end_us": unit_end_us,
                        "tts_duration_us": unit_duration_us,
                        "text": text_value,
                        "speaker": speaker_value,
                        "speaker_id": speaker_id_value,
                        "speaker_alias": speaker_alias_value,
                        "speaker_color_key": speaker_color_key_value,
                        "source_utterance_id": source_utterance_id_value,
                        "caption_color": caption_color_value,
                        "mp3_path": sentence_timeline.get("mp3_path") or "",
                        "combined_segment_ids": combined_segment_ids,
                        "timing_source": "proportional_sentence_tts",
                    }
                )
                display_caption_manifest_entries.append(
                    {
                        "caption_id": caption_id_value,
                        "sentence_id": tts_caption_id,
                        "tts_caption_id": tts_caption_id,
                        "segment_id": segment_id_value,
                        "segment_type": segment_type_value,
                        "caption_kind": caption_kind_value,
                        "tts_enabled": True,
                        "text": text_value,
                        "speaker": speaker_value,
                        "speaker_id": speaker_id_value,
                        "speaker_alias": speaker_alias_value,
                        "speaker_color_key": speaker_color_key_value,
                        "source_utterance_id": source_utterance_id_value,
                        "caption_color": caption_color_value,
                        "start_sec": round(unit_start_us / 1_000_000, 6),
                        "end_sec": round(unit_end_us / 1_000_000, 6),
                        "duration_sec": round(unit_duration_us / 1_000_000, 6),
                        "mp3_path": sentence_timeline.get("mp3_path") or "",
                        "combined_segment_ids": combined_segment_ids,
                        "timing_source": "proportional_sentence_tts",
                    }
                )

        caption_timeline_entries = sorted(display_caption_timeline_entries, key=lambda row: int(row.get("timeline_start_us") or 0))
        caption_manifest_entries = sorted(display_caption_manifest_entries, key=lambda row: safe_float(row.get("start_sec"), 0.0))
        segment_to_caption_map = {}
        for entry in caption_manifest_entries:
            entry_segment_id = str(entry.get("segment_id") or "")
            entry_caption_id = str(entry.get("caption_id") or "")
            if entry_segment_id and entry_caption_id:
                segment_to_caption_map.setdefault(entry_segment_id, []).append(entry_caption_id)

    segment_timeline_entries_for_video = []
    segment_timeline_map = {}
    for item_index, caption_entry in enumerate(caption_timeline_entries):
        segment_id = caption_entry["segment_id"]
        combined_segment_ids = caption_entry.get("combined_segment_ids") if isinstance(caption_entry.get("combined_segment_ids"), list) else []
        start_us = int(caption_entry.get("video_timeline_start_us") if caption_entry.get("video_timeline_start_us") is not None else caption_entry["timeline_start_us"])
        end_us = int(caption_entry.get("video_timeline_end_us") if caption_entry.get("video_timeline_end_us") is not None else caption_entry["timeline_end_us"])
        if segment_id not in segment_timeline_map:
            segment_timeline_map[segment_id] = {
                "segment_id": segment_id,
                "timeline_start_us": start_us,
                "timeline_end_us": end_us,
                "tts_duration_us": max(0, end_us - start_us),
                "combined_segment_ids": combined_segment_ids,
                "first_index": item_index,
            }
        else:
            if combined_segment_ids:
                existing = segment_timeline_map[segment_id].setdefault("combined_segment_ids", [])
                for combined_segment_id in combined_segment_ids:
                    if combined_segment_id not in existing:
                        existing.append(combined_segment_id)
            segment_timeline_map[segment_id]["timeline_end_us"] = max(segment_timeline_map[segment_id]["timeline_end_us"], end_us)
            segment_timeline_map[segment_id]["tts_duration_us"] = max(
                0,
                segment_timeline_map[segment_id]["timeline_end_us"] - segment_timeline_map[segment_id]["timeline_start_us"],
            )

    segment_timeline_entries_for_video = sorted(
        segment_timeline_map.values(),
        key=lambda row: row["first_index"],
    )

    def validate_slot_source_monotonicity():
        if not slot_map_mode:
            return {"enabled": False, "status": "not_applicable", "violations": []}
        rows = []
        violations = []
        previous_start_sec = None
        previous_segment_id = ""
        for entry in segment_timeline_entries_for_video:
            segment_id = str(entry.get("segment_id") or "")
            segment_info = segment_map.get(segment_id, {})
            source_clips = get_segment_source_clips(segment_info)
            combined_segment_ids = entry.get("combined_segment_ids") if isinstance(entry.get("combined_segment_ids"), list) else []
            if combined_segment_ids:
                combined_source_clips = []
                for combined_segment_id in combined_segment_ids:
                    combined_source_clips.extend(get_segment_source_clips(segment_map.get(str(combined_segment_id), {})))
                if combined_source_clips:
                    source_clips = combined_source_clips
            first_clip = next((clip for clip in source_clips if isinstance(clip, dict)), None)
            start_sec = parse_timecode_to_sec(first_clip.get("start")) if first_clip else None
            row = {
                "segment_id": segment_id,
                "segment_type": segment_type_map.get(segment_id, ""),
                "timeline_start_sec": round(int(entry.get("timeline_start_us") or 0) / 1_000_000, 6),
                "source_start_sec": round(start_sec, 6) if start_sec is not None else None,
            }
            rows.append(row)
            if start_sec is None:
                continue
            if previous_start_sec is not None and start_sec + 0.25 < previous_start_sec:
                violations.append(
                    {
                        "previous_segment_id": previous_segment_id,
                        "segment_id": segment_id,
                        "previous_source_start_sec": round(previous_start_sec, 6),
                        "source_start_sec": round(start_sec, 6),
                    }
                )
            previous_start_sec = start_sec
            previous_segment_id = segment_id
        return {
            "enabled": True,
            "status": "passed" if not violations else "failed",
            "rows": rows,
            "violations": violations,
            "reason": "slot_map source starts are monotonic in timeline order",
        }

    slot_source_monotonicity = validate_slot_source_monotonicity()
    if slot_source_monotonicity.get("status") == "failed":
        raise ValueError(
            "MIDFORM_SLOT_SOURCE_MONOTONICITY_FAILED: "
            + json.dumps(slot_source_monotonicity.get("violations", [])[:8], ensure_ascii=False)
        )

    def planned_source_ranges_for_hybrid_validation():
        planned = []
        validation_errors = []
        for entry in segment_timeline_entries_for_video:
            segment_id = entry["segment_id"]
            segment_info = segment_map.get(segment_id, {})
            segment_type = segment_type_map.get(segment_id, "recap")
            source_clips = get_segment_source_clips(segment_info)
            combined_segment_ids = entry.get("combined_segment_ids") if isinstance(entry.get("combined_segment_ids"), list) else []
            if combined_segment_ids:
                combined_source_clips = []
                for combined_segment_id in combined_segment_ids:
                    combined_source_clips.extend(get_segment_source_clips(segment_map.get(str(combined_segment_id), {})))
                if combined_source_clips:
                    source_clips = combined_source_clips
            remaining_us = int(entry["tts_duration_us"])
            if not source_clips:
                validation_errors.append(f"{segment_id}: no source_clips available")
                continue

            segment_source_total_us = 0
            for clip in source_clips:
                clip_id = str(clip.get("clip_id") or clip.get("scene_id") or "unknown_clip")
                start_sec = parse_timecode_to_sec(clip.get("start"))
                end_sec = parse_timecode_to_sec(clip.get("end"))
                if start_sec is None or end_sec is None or end_sec <= start_sec:
                    validation_errors.append(f"{segment_id}/{clip_id}: invalid source clip timecode")
                    continue
                speed_multiplier = safe_float(clip.get("speed_multiplier"), 1.0)
                if segment_type in {"dialogue_quote", "dialogue"} and abs(speed_multiplier - 1.0) > 0.001:
                    validation_errors.append(f"{segment_id}/{clip_id}: {segment_type} cannot use speed_multiplier={speed_multiplier}")

                clip_start_us = int(round(start_sec * 1_000_000))
                clip_duration_us = int(round((end_sec - start_sec) * 1_000_000))
                if source_duration_us > 0 and clip_start_us >= source_duration_us:
                    validation_errors.append(f"{segment_id}/{clip_id}: clip start exceeds source duration")
                    continue
                available_source_us = max(0, source_duration_us - clip_start_us) if source_duration_us > 0 else clip_duration_us
                usable_source_us = min(clip_duration_us, available_source_us)
                effective_speed = max(0.001, speed_multiplier)
                playable_timeline_us = int(round(usable_source_us / effective_speed))
                segment_source_total_us += playable_timeline_us if segment_type not in {"dialogue_quote", "dialogue"} else usable_source_us
                consume_timeline_us = min(playable_timeline_us, max(0, remaining_us))
                consume_source_us = min(usable_source_us, int(math.ceil(consume_timeline_us * effective_speed)))
                if consume_timeline_us > 0 and consume_source_us > 0:
                    planned.append(
                        {
                            "segment_id": segment_id,
                            "segment_type": segment_type,
                            "clip_id": clip_id,
                            "start_us": clip_start_us,
                            "end_us": clip_start_us + consume_source_us,
                        }
                    )
                    remaining_us -= consume_timeline_us
                if remaining_us <= 0:
                    break

            if segment_type in {"dialogue_quote", "dialogue"} and abs(segment_source_total_us - int(entry["tts_duration_us"])) > 1_000:
                validation_errors.append(
                    f"{segment_id}: {segment_type} timeline duration must equal source duration "
                    f"({entry['tts_duration_us']}us vs {segment_source_total_us}us)"
                )
            if remaining_us > 1_000 and segment_type in {"dialogue_quote", "dialogue"}:
                validation_errors.append(f"{segment_id}: source_clips are shorter than required timeline by {remaining_us}us")

        planned_sorted = sorted(planned, key=lambda row: (row["start_us"], row["end_us"], row["segment_id"]))
        for index, current in enumerate(planned_sorted):
            for other in planned_sorted[index + 1:]:
                if other["start_us"] >= current["end_us"] - 1_000:
                    break
                overlap_us = min(current["end_us"], other["end_us"]) - max(current["start_us"], other["start_us"])
                if overlap_us > 1_000:
                    if current["segment_id"] == other["segment_id"] and current["segment_type"] not in {"dialogue_quote", "dialogue"}:
                        continue
                    validation_errors.append(
                        f"{current['segment_id']}/{current['clip_id']} overlaps "
                        f"{other['segment_id']}/{other['clip_id']} by {round(overlap_us / 1_000_000, 3)}s"
                    )
        return validation_errors

    if midform_hybrid_mode and video_placement_mode == "source_clips":
        hybrid_validation_errors = planned_source_ranges_for_hybrid_validation()
        if hybrid_validation_errors:
            raise ValueError("MIDFORM_HYBRID_SOURCE_VALIDATION_FAILED: " + "; ".join(hybrid_validation_errors))

    segment_timeline_alignment = []
    total_video_timeline_end_us = 0
    pad_strategy_summary = "none"

    if source_video_material is not None and source_duration_us > 0:
        script.add_material(source_video_material)

        if video_placement_mode == "full_source":
            video_segment = cc.VideoSegment(
                material=source_video_material,
                source_timerange=cc.Timerange(start=0, duration=source_duration_us),
                target_timerange=cc.Timerange(start=0, duration=source_duration_us),
            )
            script.add_segment(video_segment, track_name="source_video")
            video_cut_placements.append(
                {
                    "segment_id": "full_source",
                    "clip_id": "full_source",
                    "source_start": "00:00.000",
                    "source_end": f"{round(source_duration_us / 1_000_000, 6)}s",
                    "timeline_start_sec": 0.0,
                    "timeline_end_sec": round(source_duration_us / 1_000_000, 6),
                    "tts_duration_sec": round(current_time_us / 1_000_000, 6),
                    "video_duration_sec": round(source_duration_us / 1_000_000, 6),
                    "duration_diff_sec": round((current_time_us - source_duration_us) / 1_000_000, 6),
                    "warnings": [],
                }
            )
            total_video_timeline_end_us = source_duration_us
        else:
            last_valid_clip_ref = None
            segment_pad_modes = set()

            def add_video_segment_with_manifest(
                segment_id,
                clip_id,
                source_start_tc,
                source_end_tc,
                source_start_us,
                source_duration_for_segment_us,
                place_duration_us,
                timeline_start_us,
                tts_duration_us,
                placement_warnings,
                speed_multiplier=1.0,
            ):
                nonlocal total_video_timeline_end_us
                timeline_end_us = timeline_start_us + place_duration_us
                video_segment_kwargs = {
                    "material": source_video_material,
                    "source_timerange": cc.Timerange(start=source_start_us, duration=source_duration_for_segment_us),
                    "target_timerange": cc.Timerange(start=timeline_start_us, duration=place_duration_us),
                }
                video_segment_local = cc.VideoSegment(
                    **video_segment_kwargs,
                )
                script.add_segment(video_segment_local, track_name="source_video")
                total_video_timeline_end_us = max(total_video_timeline_end_us, timeline_end_us)

                video_cut_placements.append(
                    {
                        "segment_id": segment_id,
                        "clip_id": clip_id,
                        "source_start": source_start_tc,
                        "source_end": source_end_tc,
                        "timeline_start_sec": round(timeline_start_us / 1_000_000, 6),
                        "timeline_end_sec": round(timeline_end_us / 1_000_000, 6),
                        "tts_duration_sec": round(tts_duration_us / 1_000_000, 6),
                        "video_duration_sec": round(place_duration_us / 1_000_000, 6),
                        "source_duration_sec": round(source_duration_for_segment_us / 1_000_000, 6),
                        "speed_multiplier": round(speed_multiplier, 6),
                        "duration_diff_sec": round((tts_duration_us - place_duration_us) / 1_000_000, 6),
                        "warnings": placement_warnings,
                    }
                )
                return timeline_end_us

            for entry in segment_timeline_entries_for_video:
                segment_id = entry["segment_id"]
                segment_info = segment_map.get(segment_id, {})
                segment_type = segment_type_map.get(segment_id, "recap")
                source_clips = get_segment_source_clips(segment_info)
                combined_segment_ids = entry.get("combined_segment_ids") if isinstance(entry.get("combined_segment_ids"), list) else []
                if combined_segment_ids:
                    combined_source_clips = []
                    for combined_segment_id in combined_segment_ids:
                        combined_source_clips.extend(get_segment_source_clips(segment_map.get(str(combined_segment_id), {})))
                    if combined_source_clips:
                        source_clips = combined_source_clips
                tts_duration_us = int(entry["tts_duration_us"])
                segment_tts_start_us = int(entry["timeline_start_us"])
                segment_tts_end_us = int(entry["timeline_end_us"])
                timeline_cursor_us = segment_tts_start_us
                remaining_us = int(entry["tts_duration_us"])
                segment_video_start_us = timeline_cursor_us
                segment_video_end_us = timeline_cursor_us
                segment_warnings = []
                source_clips_count = len(source_clips) if isinstance(source_clips, list) else 0
                pad_mode = "none"
                last_segment_clip_ref = None
                is_final_tail_segment = final_slot_tail.get("enabled") and segment_id == final_slot_tail.get("segment_id")
                effective_visual_end_us = int(round(safe_float(final_slot_tail.get("visual_end_sec"), 0.0) * 1_000_000)) if is_final_tail_segment else source_duration_us

                if not isinstance(source_clips, list) or not source_clips:
                    segment_warnings.append("no source_clips available for video placement")
                    warnings.append(f"{segment_id}: no source_clips available for video placement")
                else:
                    for clip in source_clips:
                        clip_id = str(clip.get("clip_id") or clip.get("scene_id") or "unknown_clip")
                        clip_start_tc = clip.get("start")
                        clip_end_tc = clip.get("end")

                        start_sec = parse_timecode_to_sec(clip_start_tc)
                        end_sec = parse_timecode_to_sec(clip_end_tc)
                        clip_warnings = []

                        if start_sec is None or end_sec is None or end_sec <= start_sec:
                            clip_warnings.append("invalid source clip timecode")
                            segment_warnings.append(f"{clip_id}: invalid source clip timecode")
                            warnings.append(f"{segment_id}/{clip_id}: invalid source clip timecode")
                            video_cut_placements.append(
                                {
                                    "segment_id": segment_id,
                                    "clip_id": clip_id,
                                    "source_start": clip_start_tc,
                                    "source_end": clip_end_tc,
                                    "timeline_start_sec": round(timeline_cursor_us / 1_000_000, 6),
                                    "timeline_end_sec": round(timeline_cursor_us / 1_000_000, 6),
                                    "tts_duration_sec": round(tts_duration_us / 1_000_000, 6),
                                    "video_duration_sec": 0.0,
                                    "duration_diff_sec": round(tts_duration_us / 1_000_000, 6),
                                    "warnings": clip_warnings,
                                }
                            )
                            continue

                        clip_source_start_us = int(round(start_sec * 1_000_000))
                        clip_source_duration_us = int(round((end_sec - start_sec) * 1_000_000))
                        if clip_source_start_us >= source_duration_us:
                            clip_warnings.append("clip start exceeds source duration")
                            segment_warnings.append(f"{clip_id}: clip start exceeds source duration")
                            warnings.append(f"{segment_id}/{clip_id}: clip start exceeds source duration")
                            video_cut_placements.append(
                                {
                                    "segment_id": segment_id,
                                    "clip_id": clip_id,
                                    "source_start": clip_start_tc,
                                    "source_end": clip_end_tc,
                                    "timeline_start_sec": round(timeline_cursor_us / 1_000_000, 6),
                                    "timeline_end_sec": round(timeline_cursor_us / 1_000_000, 6),
                                    "tts_duration_sec": round(tts_duration_us / 1_000_000, 6),
                                    "video_duration_sec": 0.0,
                                    "duration_diff_sec": round(tts_duration_us / 1_000_000, 6),
                                    "warnings": clip_warnings,
                                }
                            )
                            continue

                        capped_source_end_us = source_duration_us
                        if is_final_tail_segment and effective_visual_end_us > 0:
                            capped_source_end_us = min(source_duration_us, effective_visual_end_us)
                        available_source_us = max(0, capped_source_end_us - clip_source_start_us)
                        usable_source_us = min(clip_source_duration_us, available_source_us)
                        speed_multiplier = safe_float(clip.get("speed_multiplier"), 1.0)
                        if segment_type in {"dialogue_quote", "dialogue"}:
                            speed_multiplier = 1.0
                        speed_multiplier = max(0.001, speed_multiplier)
                        playable_timeline_us = int(round(usable_source_us / speed_multiplier))
                        place_duration_us = min(playable_timeline_us, remaining_us)
                        source_duration_for_segment_us = min(usable_source_us, int(math.ceil(place_duration_us * speed_multiplier)))

                        if place_duration_us <= 0 or source_duration_for_segment_us <= 0:
                            clip_warnings.append("clip duration became zero after bounds check")
                            segment_warnings.append(f"{clip_id}: clip duration zero after bounds check")
                            warnings.append(f"{segment_id}/{clip_id}: clip duration zero after bounds check")
                            video_cut_placements.append(
                                {
                                    "segment_id": segment_id,
                                    "clip_id": clip_id,
                                    "source_start": clip_start_tc,
                                    "source_end": clip_end_tc,
                                    "timeline_start_sec": round(timeline_cursor_us / 1_000_000, 6),
                                    "timeline_end_sec": round(timeline_cursor_us / 1_000_000, 6),
                                    "tts_duration_sec": round(tts_duration_us / 1_000_000, 6),
                                    "video_duration_sec": 0.0,
                                    "duration_diff_sec": round(tts_duration_us / 1_000_000, 6),
                                    "warnings": clip_warnings,
                                }
                            )
                            continue

                        if playable_timeline_us > remaining_us:
                            clip_warnings.append("trimmed to fit TTS segment duration")
                        if usable_source_us < clip_source_duration_us:
                            clip_warnings.append("trimmed because source clip exceeded source video duration")
                        if abs(speed_multiplier - 1.0) > 0.001:
                            clip_warnings.append(f"speed adjusted for narration background: {round(speed_multiplier, 3)}x")

                        timeline_end_us = add_video_segment_with_manifest(
                            segment_id=segment_id,
                            clip_id=clip_id,
                            source_start_tc=clip_start_tc,
                            source_end_tc=clip_end_tc,
                            source_start_us=clip_source_start_us,
                            source_duration_for_segment_us=source_duration_for_segment_us,
                            place_duration_us=place_duration_us,
                            timeline_start_us=timeline_cursor_us,
                            tts_duration_us=tts_duration_us,
                            placement_warnings=clip_warnings,
                            speed_multiplier=speed_multiplier,
                        )
                        segment_video_end_us = max(segment_video_end_us, timeline_end_us)
                        timeline_cursor_us = timeline_end_us
                        remaining_us -= place_duration_us
                        last_segment_clip_ref = {
                            "source_start_us": clip_source_start_us,
                            "source_duration_us": max(1, min(usable_source_us, clip_source_duration_us)),
                            "clip_id": clip_id,
                        }
                        last_valid_clip_ref = last_segment_clip_ref

                        if remaining_us <= 0:
                            break

                if 0 < remaining_us <= 100:
                    remaining_us = 0

                if remaining_us > 0:
                    if midform_hybrid_mode and segment_type in {"dialogue_quote", "dialogue"}:
                        raise ValueError(
                            f"MIDFORM_HYBRID_SOURCE_VALIDATION_FAILED: {segment_id} would require repeat padding "
                            f"for {remaining_us}us"
                        )
                    fill_ref = last_segment_clip_ref or last_valid_clip_ref
                    if fill_ref:
                        if is_final_tail_segment:
                            fps_value = max(1.0, safe_float(data.get("fps"), 30.0))
                            frame_duration_us = max(1, int(round(1_000_000 / fps_value)))
                            freeze_source_end_us = effective_visual_end_us if effective_visual_end_us > 0 else (fill_ref["source_start_us"] + fill_ref["source_duration_us"])
                            freeze_source_start_us = max(0, freeze_source_end_us - frame_duration_us)
                            freeze_duration_us = max(remaining_us, 0)
                            if freeze_duration_us > 0:
                                pad_mode = "freeze_last_frame"
                                segment_pad_modes.add(pad_mode)
                                final_slot_tail["applied"] = True
                                final_slot_tail["freeze_applied"] = True
                                final_slot_tail["freeze_duration_sec"] = round(freeze_duration_us / 1_000_000, 6)
                                final_slot_tail["tail_overrun_sec"] = round(freeze_duration_us / 1_000_000, 6)
                                final_slot_tail["freeze_within_allowance"] = freeze_duration_us <= int(round(final_slot_tail_allowance_sec * 1_000_000)) + 1_000
                                repeat_end_us = add_video_segment_with_manifest(
                                    segment_id=segment_id,
                                    clip_id=f"{fill_ref['clip_id']}_freeze",
                                    source_start_tc="freeze_last_frame",
                                    source_end_tc="freeze_last_frame",
                                    source_start_us=freeze_source_start_us,
                                    source_duration_for_segment_us=frame_duration_us,
                                    place_duration_us=freeze_duration_us,
                                    timeline_start_us=timeline_cursor_us,
                                    tts_duration_us=tts_duration_us,
                                    placement_warnings=[
                                        f"final slot padded by freezing last frame for {round(freeze_duration_us / 1_000_000, 3)}s",
                                        "tail allowance exceeded" if not final_slot_tail["freeze_within_allowance"] else "tail allowance respected",
                                    ],
                                )
                                timeline_cursor_us = repeat_end_us
                                segment_video_end_us = max(segment_video_end_us, repeat_end_us)
                                remaining_us = 0
                        else:
                            pad_mode = "repeat_last"
                            segment_pad_modes.add(pad_mode)
                            while remaining_us > 0:
                                repeat_us = min(fill_ref["source_duration_us"], remaining_us)
                                repeat_end_us = add_video_segment_with_manifest(
                                    segment_id=segment_id,
                                    clip_id=f"{fill_ref['clip_id']}_repeat",
                                    source_start_tc="repeat_last",
                                    source_end_tc="repeat_last",
                                    source_start_us=fill_ref["source_start_us"],
                                    source_duration_for_segment_us=repeat_us,
                                    place_duration_us=repeat_us,
                                    timeline_start_us=timeline_cursor_us,
                                    tts_duration_us=tts_duration_us,
                                    placement_warnings=["segment padded by repeating last source clip"],
                                )
                                timeline_cursor_us = repeat_end_us
                                segment_video_end_us = max(segment_video_end_us, repeat_end_us)
                                remaining_us -= repeat_us
                    else:
                        if source_duration_us > 0:
                            pad_mode = "placeholder"
                            segment_pad_modes.add(pad_mode)
                            placeholder_source_start_us = 0
                            placeholder_source_duration_us = max(1, min(source_duration_us, 1_000_000))
                            while remaining_us > 0:
                                repeat_us = min(placeholder_source_duration_us, remaining_us)
                                repeat_end_us = add_video_segment_with_manifest(
                                    segment_id=segment_id,
                                    clip_id="placeholder_repeat",
                                    source_start_tc="00:00.000",
                                    source_end_tc="placeholder",
                                    source_start_us=placeholder_source_start_us,
                                    source_duration_for_segment_us=repeat_us,
                                    place_duration_us=repeat_us,
                                    timeline_start_us=timeline_cursor_us,
                                    tts_duration_us=tts_duration_us,
                                    placement_warnings=["placeholder fill used due to missing/invalid source_clips"],
                                )
                                timeline_cursor_us = repeat_end_us
                                segment_video_end_us = max(segment_video_end_us, repeat_end_us)
                                remaining_us -= repeat_us
                            segment_warnings.append("placeholder fill used")
                            warnings.append(f"{segment_id}: placeholder fill used to avoid video gap")
                        else:
                            segment_warnings.append("cannot fill missing video timeline (source duration unavailable)")
                            warnings.append(f"{segment_id}: cannot fill missing video timeline (source duration unavailable)")

                segment_video_duration_us = max(0, segment_video_end_us - segment_video_start_us)
                duration_diff_sec = round((tts_duration_us - segment_video_duration_us) / 1_000_000, 6)
                segment_timeline_alignment.append(
                    {
                        "segment_id": segment_id,
                        "tts_start_sec": round(segment_tts_start_us / 1_000_000, 6),
                        "tts_end_sec": round(segment_tts_end_us / 1_000_000, 6),
                        "tts_duration_sec": round(tts_duration_us / 1_000_000, 6),
                        "video_start_sec": round(segment_video_start_us / 1_000_000, 6),
                        "video_end_sec": round(segment_video_end_us / 1_000_000, 6),
                        "video_duration_sec": round(segment_video_duration_us / 1_000_000, 6),
                        "source_clips_count": source_clips_count,
                        "pad_mode": pad_mode,
                        "duration_diff_sec": duration_diff_sec,
                        "warnings": segment_warnings,
                    }
                )

            if "repeat_last" in segment_pad_modes:
                pad_strategy_summary = "repeat_last"
            elif "placeholder" in segment_pad_modes:
                pad_strategy_summary = "placeholder"
            else:
                pad_strategy_summary = "none"

    total_tts_duration_sec = round(current_time_us / 1_000_000, 6)
    total_video_duration_sec = round(total_video_timeline_end_us / 1_000_000, 6)
    timeline_duration_diff_sec = round(total_tts_duration_sec - total_video_duration_sec, 6)
    duration_guide_summary = build_duration_guide_report(total_tts_duration_sec)
    if duration_guide_summary.get("status") == "warn":
        warnings.append(f"duration guide: {duration_guide_summary.get('message')}")
    video_timeline_aligned_to_tts = abs(timeline_duration_diff_sec) <= 0.2

    story_sync_summary = {
        "enabled": bool(story_sync_segment_reports),
        "status": "not_applicable",
        "segment_reports": story_sync_segment_reports,
        "monotonic_source_progression_ok": True,
        "monotonic_violations": [],
        "coverage": {
            "source_duration_sec": round(source_duration_us / 1_000_000, 6) if source_duration_us > 0 else 0.0,
            "anchor_min_start_sec": 0.0,
            "anchor_max_end_sec": 0.0,
            "coverage_ratio": 0.0,
            "last_narration_anchor_end_sec": 0.0,
            "last_narration_covers_after_70pct": False,
        },
        "placement_table": [],
    }
    if story_sync_segment_reports:
        first_placement_by_segment = {}
        ordered_placements = sorted(video_cut_placements, key=lambda row: (safe_float(row.get("timeline_start_sec"), 0.0), safe_float(row.get("timeline_end_sec"), 0.0)))
        for placement in ordered_placements:
            source_start = parse_timecode_to_sec(placement.get("source_start"))
            source_end = parse_timecode_to_sec(placement.get("source_end"))
            segment_id = str(placement.get("segment_id") or "")
            segment_type = segment_type_map.get(segment_id, "recap")
            if source_start is None or source_end is None:
                continue
            story_sync_summary["placement_table"].append(
                {
                    "segment_id": segment_id,
                    "segment_type": segment_type,
                    "clip_id": placement.get("clip_id"),
                    "source_range": [round(source_start, 3), round(source_end, 3)],
                    "timeline_range": [placement.get("timeline_start_sec"), placement.get("timeline_end_sec")],
                }
            )
            if segment_id and segment_id not in first_placement_by_segment:
                first_placement_by_segment[segment_id] = {
                    "segment_id": segment_id,
                    "segment_type": segment_type,
                    "source_start": source_start,
                    "timeline_start": safe_float(placement.get("timeline_start_sec"), 0.0),
                }

        previous_source_start = None
        previous_segment_id = ""
        for row in sorted(first_placement_by_segment.values(), key=lambda item: item["timeline_start"]):
            source_start = row["source_start"]
            segment_id = row["segment_id"]
            if previous_source_start is not None and source_start + 0.001 < previous_source_start:
                story_sync_summary["monotonic_source_progression_ok"] = False
                story_sync_summary["monotonic_violations"].append(
                    {
                        "previous_segment_id": previous_segment_id,
                        "segment_id": segment_id,
                        "previous_source_start_sec": round(previous_source_start, 3),
                        "source_start_sec": round(source_start, 3),
                    }
                )
            previous_source_start = source_start
            previous_segment_id = segment_id

        anchor_starts = [safe_float((report.get("anchor_range") or [None, None])[0], None) for report in story_sync_segment_reports]
        anchor_ends = [safe_float((report.get("anchor_range") or [None, None])[1], None) for report in story_sync_segment_reports]
        anchor_starts = [value for value in anchor_starts if value is not None]
        anchor_ends = [value for value in anchor_ends if value is not None]
        source_duration_for_coverage = safe_float(source_duration_sec, 0.0) or (source_duration_us / 1_000_000 if source_duration_us > 0 else safe_float(data.get("sourceDurationSec") or data.get("source_duration_sec"), 0.0))
        if anchor_starts and anchor_ends and source_duration_for_coverage > 0:
            anchor_min = min(anchor_starts)
            anchor_max = max(anchor_ends)
            last_anchor_end = anchor_ends[-1]
            story_sync_summary["coverage"] = {
                "source_duration_sec": round(source_duration_for_coverage, 6),
                "anchor_min_start_sec": round(anchor_min, 3),
                "anchor_max_end_sec": round(anchor_max, 3),
                "coverage_ratio": round(min(1.0, max(0.0, anchor_max - anchor_min) / source_duration_for_coverage), 6),
                "last_narration_anchor_end_sec": round(last_anchor_end, 3),
                "last_narration_covers_after_70pct": last_anchor_end >= source_duration_for_coverage * 0.7,
            }
        story_sync_summary["status"] = "passed" if story_sync_summary["monotonic_source_progression_ok"] and story_sync_summary["coverage"].get("last_narration_covers_after_70pct") else "failed"
        if story_sync_summary["status"] != "passed":
            raise ValueError("MIDFORM_STORY_SYNC_VALIDATION_FAILED: " + json.dumps({
                "monotonic_violations": story_sync_summary["monotonic_violations"][:5],
                "coverage": story_sync_summary["coverage"],
            }, ensure_ascii=False))

    template_subtitle_warnings = []
    subtitle_components = None
    title_components = None
    emphasis_components = None
    if use_capcut_template and template_profiles.get("subtitle"):
        subtitle_components = build_text_render_components_from_profile(
            template_profiles.get("subtitle"),
            warning_collector=template_subtitle_warnings,
            fallback_transform_y=0.75,
        )
        title_components = build_text_render_components_from_profile(
            template_profiles.get("title"),
            warning_collector=template_subtitle_warnings,
            fallback_transform_y=0.0,
        )
        emphasis_components = build_text_render_components_from_profile(
            template_profiles.get("emphasis"),
            warning_collector=template_subtitle_warnings,
            fallback_transform_y=0.6,
        )
    else:
        subtitle_components = build_text_render_components_from_profile(None, warning_collector=template_subtitle_warnings)
        title_components = build_text_render_components_from_profile(None, warning_collector=template_subtitle_warnings, fallback_transform_y=0.0)
        emphasis_components = build_text_render_components_from_profile(None, warning_collector=template_subtitle_warnings, fallback_transform_y=0.6)
        if use_capcut_template:
            fallback_template_style_used = True

    if template_subtitle_warnings:
        warnings.extend([f"template subtitle style: {msg}" for msg in template_subtitle_warnings])
        fallback_template_style_used = True

    copied_srt_path = ""
    srt_entries = []
    subtitle_track_count = 0
    if caption_timeline_entries:
        copied_srt_path = os.path.abspath(os.path.join(subtitle_dir, "subtitles.srt"))
        # Filter to the entries write_srt_entries will actually emit (it skips empty text,
        # e.g. silent scene_hook placeholders) so the positional metadata join stays aligned.
        srt_visible_entries = [
            entry
            for entry in caption_timeline_entries
            if str(entry.get("text") or "").strip()
            and int(entry.get("timeline_end_us", 0) or 0) > int(entry.get("timeline_start_us", 0) or 0)
        ]
        write_srt_entries(copied_srt_path, srt_visible_entries)
        srt_entries = parse_srt(copied_srt_path)
        for index, entry in enumerate(srt_entries):
            source_entry = srt_visible_entries[index] if index < len(srt_visible_entries) else {}
            if isinstance(source_entry, dict):
                entry["caption_id"] = source_entry.get("caption_id")
                entry["segment_id"] = source_entry.get("segment_id")
                entry["segment_type"] = source_entry.get("segment_type")
                entry["caption_kind"] = source_entry.get("caption_kind")
                entry["speaker"] = source_entry.get("speaker")
                entry["speaker_id"] = source_entry.get("speaker_id")
                entry["speaker_alias"] = source_entry.get("speaker_alias")
                entry["speaker_color_key"] = source_entry.get("speaker_color_key")
                entry["source_utterance_id"] = source_entry.get("source_utterance_id")
                entry["caption_color"] = source_entry.get("caption_color")
        subtitle_style = subtitle_components["style"]
        subtitle_clip = subtitle_components["clip_settings"]
        subtitle_font = subtitle_components["font"]
        subtitle_border = subtitle_components["border"]
        subtitle_background = subtitle_components["background"]
        subtitle_effect_id = subtitle_components["effect_id"]
        # One track holds one caption at a time, and CapCut rejects the whole draft if two
        # overlap. Captions that share a moment go on their own track, which keeps every
        # caption on the line it belongs to instead of shifting it off its speech.
        caption_track_ends_us = [0]
        for entry in srt_entries:
            start_us = int(entry["start_sec"] * 1_000_000)
            duration_us = int((entry["end_sec"] - entry["start_sec"]) * 1_000_000)
            if duration_us <= 0:
                continue
            lane = next((index for index, end_us in enumerate(caption_track_ends_us) if start_us >= end_us), None)
            if lane is None:
                lane = len(caption_track_ends_us)
                caption_track_ends_us.append(0)
                script.add_track(cc.TrackType.text, caption_track_name(lane), relative_index=subtitle_track_relative_index + lane)
                warnings.append(f"caption overlap: added track {caption_track_name(lane)}")
            caption_track_ends_us[lane] = start_us + duration_us
            text_segment = cc.TextSegment(
                text=entry["text"],
                timerange=cc.Timerange(start=start_us, duration=duration_us),
                font=subtitle_font,
                style=subtitle_style,
                clip_settings=subtitle_clip,
                border=subtitle_border,
                background=subtitle_background,
            )
            if subtitle_effect_id:
                try:
                    text_segment.add_effect(subtitle_effect_id)
                except Exception:
                    warnings.append(f"failed to apply template text effect id={subtitle_effect_id}")
                    fallback_template_style_used = True
            script.add_segment(text_segment, track_name=caption_track_name(lane))
            subtitle_track_count += 1
    elif srt_file and os.path.exists(srt_file):
        copied_srt_path = os.path.abspath(os.path.join(subtitle_dir, "subtitles.srt"))
        shutil.copy2(srt_file, copied_srt_path)
        srt_entries = parse_srt(copied_srt_path)
        subtitle_style = subtitle_components["style"]
        subtitle_clip = subtitle_components["clip_settings"]
        subtitle_font = subtitle_components["font"]
        subtitle_border = subtitle_components["border"]
        subtitle_background = subtitle_components["background"]
        subtitle_effect_id = subtitle_components["effect_id"]
        # One track holds one caption at a time, and CapCut rejects the whole draft if two
        # overlap. Captions that share a moment go on their own track, which keeps every
        # caption on the line it belongs to instead of shifting it off its speech.
        caption_track_ends_us = [0]
        for entry in srt_entries:
            start_us = int(entry["start_sec"] * 1_000_000)
            duration_us = int((entry["end_sec"] - entry["start_sec"]) * 1_000_000)
            if duration_us <= 0:
                continue
            lane = next((index for index, end_us in enumerate(caption_track_ends_us) if start_us >= end_us), None)
            if lane is None:
                lane = len(caption_track_ends_us)
                caption_track_ends_us.append(0)
                script.add_track(cc.TrackType.text, caption_track_name(lane), relative_index=subtitle_track_relative_index + lane)
                warnings.append(f"caption overlap: added track {caption_track_name(lane)}")
            caption_track_ends_us[lane] = start_us + duration_us
            text_segment = cc.TextSegment(
                text=entry["text"],
                timerange=cc.Timerange(start=start_us, duration=duration_us),
                font=subtitle_font,
                style=subtitle_style,
                clip_settings=subtitle_clip,
                border=subtitle_border,
                background=subtitle_background,
            )
            if subtitle_effect_id:
                try:
                    text_segment.add_effect(subtitle_effect_id)
                except Exception:
                    warnings.append(f"failed to apply template text effect id={subtitle_effect_id}")
                    fallback_template_style_used = True
            script.add_segment(text_segment, track_name=caption_track_name(lane))
            subtitle_track_count += 1
    elif srt_file:
        warnings.append(f"srt file not found - {srt_file}")

    script.save()

    generated_draft_content_path = os.path.join(draft_path, "draft_content.json")
    caption_track_normalization_summary = normalize_midform_caption_text_track(generated_draft_content_path, MIDFORM_CAPTION_Y)
    caption_track_template_rebuild_summary = {"applied": False, "reason": "template not loaded"}
    if template_draft_content and srt_entries:
        caption_track_template_rebuild_summary = rebuild_midform_caption_track_from_template(
            generated_draft_content_path,
            template_draft_content,
            srt_entries,
            MIDFORM_CAPTION_Y,
        )
    hybrid_audio_policy_summary = {"enabled": False}
    if midform_hybrid_mode and os.path.exists(generated_draft_content_path):
        hybrid_audio_policy_summary = apply_midform_hybrid_video_audio_policy(
            generated_draft_content_path,
            video_cut_placements,
            segment_type_map,
        )

    template_overlay_passthrough_summary = {"enabled": bool(use_capcut_template), "applied": False, "reason": "template not loaded"}
    template_clone_summary = {
        "template_clone_mode": False,
        "template_markers_found": [],
        "missing_template_markers": [],
        "subtitle_template_source": "",
        "title_template_source": "",
        "pretitle_template_source": "",
        "movie_title_template_source": "",
        "used_fallback_subtitle": False,
        "fixed_overlay_texts": {},
        "subtitle_segments_count": subtitle_track_count,
        "total_tts_duration_sec": total_tts_duration_sec,
        "movie_title_generated": False,
        "movie_title_fallback_text_used": False,
    }
    if use_capcut_template and template_draft_content and os.path.exists(generated_draft_content_path):
        try:
            template_clone_summary = apply_template_clone_mode(
                generated_draft_content_path=generated_draft_content_path,
                template_doc=template_draft_content,
                srt_entries=srt_entries,
                claude_script=claude_script,
            )
        except Exception as clone_error:
            warnings.append(f"template clone mode failed, fallback to pycapcut style mapping: {clone_error}")
            template_clone_summary["used_fallback_subtitle"] = True
        try:
            template_overlay_passthrough_summary = apply_template_overlay_passthrough(
                generated_draft_content_path,
                template_draft_content,
                template_info.get("template_root", "") if template_info else "",
                draft_path,
                total_tts_duration_sec,
            )
        except Exception as passthrough_error:
            template_overlay_passthrough_summary = {
                "enabled": True,
                "applied": False,
                "reason": f"template overlay passthrough failed: {passthrough_error}",
            }
            warnings.append(template_overlay_passthrough_summary["reason"])

    portrait_crop_summary = apply_midform_portrait_crops_to_draft(
        generated_draft_content_path,
        video_cut_placements,
        segment_type_map,
        width,
        height,
        source_video_path,
        gemini_analysis,
    )

    caption_text_lengths = [len(str(item.get("text") or "").strip()) for item in caption_manifest_entries]
    max_caption_chars = max(caption_text_lengths) if caption_text_lengths else 0

    edit_manifest = {
        "generated_at": datetime.now().isoformat(),
        "draft_name": draft_name,
        "audio_path_mode": audio_path_mode,
        "video_placement_mode": video_placement_mode,
        "recommended_audio_path_mode": "absolute",
        "capcut_template_used": bool(use_capcut_template and template_info and template_profiles.get("subtitle")),
        "template_path": template_info["template_root"] if template_info else "",
        "emphasis_style_source": (template_profiles.get("sources") or {}).get("emphasis", ""),
        "template_style_summary": template_profiles.get("summary") or [],
        "template_fallback_used": fallback_template_style_used,
        "template_clone_mode": template_clone_summary.get("template_clone_mode", False),
        "template_markers_found": template_clone_summary.get("template_markers_found", []),
        "missing_template_markers": template_clone_summary.get("missing_template_markers", []),
        "pretitle_style_source": template_clone_summary.get("pretitle_template_source", ""),
        "title_style_source": template_clone_summary.get("title_template_source", ""),
        "subtitle_style_source": template_clone_summary.get("subtitle_template_source", ""),
        "movie_title_style_source": template_clone_summary.get("movie_title_template_source", ""),
        "fixed_overlay_texts": template_clone_summary.get("fixed_overlay_texts", {}),
        "subtitle_segments_count": template_clone_summary.get("subtitle_segments_count", subtitle_track_count),
        "movie_title_generated": template_clone_summary.get("movie_title_generated", False),
        "movie_title_fallback_text_used": template_clone_summary.get("movie_title_fallback_text_used", False),
        "template_overlay_passthrough": template_overlay_passthrough_summary,
        "caption_units_count": len(caption_manifest_entries),
        "caption_units": caption_manifest_entries,
        "segment_to_caption_map": segment_to_caption_map,
        "max_caption_chars": max_caption_chars,
        "split_warnings": split_warnings,
        "template_base_path": template_info["template_base"] if template_info else "",
        "template_root_path": template_info["template_root"] if template_info else "",
        "template_draft_content_path": template_info["draft_content_path"] if template_info else "",
        "template_draft_meta_info_path": template_info["draft_meta_info_path"] if template_info else "",
        "template_depth": template_info["depth"] if template_info else None,
        "template_resource_entries": template_info["resource_entries"] if template_info else [],
        "template_style_extracted": bool(template_profiles.get("subtitle")),
        "source_video_path": source_video_path,
        "input_json_path": os.path.abspath(input_json_path),
        "script_input_path": data.get("script_path") or data.get("script_input_path") or data.get("scriptPath") or data.get("scriptInputPath") or "",
        "draft_video_path": draft_video_path,
        "source_duration_sec": source_duration_sec,
        "slot_map_mode": slot_map_mode,
        "slot_order": [str(slot.get("slot_id") or "") for slot in slot_map_input.get("slots", [])] if slot_map_mode else [],
        "transcript_first_enabled": bool(transcript_utterance_map),
        "transcript_utterance_count": len(transcript_utterance_map),
        "segment_count": len(segments),
        "audio_track_count": added_audio_count,
        "subtitle_track_count": subtitle_track_count,
        "total_tts_duration_sec": total_tts_duration_sec,
        "total_video_duration_sec": total_video_duration_sec,
        "duration_diff_sec": timeline_duration_diff_sec,
        "duration_guide": duration_guide_summary,
        "video_timeline_aligned_to_tts": video_timeline_aligned_to_tts,
        "pad_strategy": pad_strategy_summary,
        "final_slot_tail": final_slot_tail,
        "hybrid_audio_policy": hybrid_audio_policy_summary,
        "caption_track_normalization": caption_track_normalization_summary,
        "caption_track_template_rebuild": caption_track_template_rebuild_summary,
        "dialogue_map": dialogue_map,
        "dialogue_reserved_range_violations": dialogue_reserved_range_violations,
        "dialogue_vad_reports": dialogue_vad_reports,
        "slot_source_monotonicity": slot_source_monotonicity,
        "story_sync": story_sync_summary,
        "portrait_crop": portrait_crop_summary,
        "segment_timeline_alignment": segment_timeline_alignment,
        "video_cut_placements": video_cut_placements,
        "warnings": warnings,
        "segments": edit_manifest_entries,
    }
    edit_manifest_path = os.path.join(draft_path, "edit_manifest.json")
    with open(edit_manifest_path, "w", encoding="utf-8") as manifest_file:
        json.dump(edit_manifest, manifest_file, ensure_ascii=False, indent=2)

    notes_lines = [
        "# CapCut Draft Notes",
        "",
        f"- Generated At: {datetime.now().isoformat()}",
        f"- Draft Name: {draft_name}",
        f"- Audio Path Mode: {audio_path_mode}",
        f"- Video Placement Mode: {video_placement_mode}",
        "- Recommended Audio Path Mode: absolute",
        "- Relative path mode may cause missing audio media in current CapCut import behavior.",
        "- If using absolute mode on another PC/path, keep draft folder and audio path layout consistent.",
        f"- CapCut Template Used: {str(bool(use_capcut_template and template_info and template_profiles.get('subtitle'))).lower()}",
        f"- Template Clone Mode: {str(template_clone_summary.get('template_clone_mode', False)).lower()}",
        f"- Template Markers Found: {', '.join(template_clone_summary.get('template_markers_found', [])) if template_clone_summary.get('template_markers_found') else 'none'}",
        f"- Missing Template Markers: {', '.join(template_clone_summary.get('missing_template_markers', [])) if template_clone_summary.get('missing_template_markers') else 'none'}",
        f"- Template Clone Subtitle Source: {template_clone_summary.get('subtitle_template_source', '') or 'none'}",
        f"- Template Clone Title Source: {template_clone_summary.get('title_template_source', '') or 'none'}",
        f"- Template Clone Pretitle Source: {template_clone_summary.get('pretitle_template_source', '') or 'none'}",
        f"- Template Clone Movie Title Source: {template_clone_summary.get('movie_title_template_source', '') or 'none'}",
        f"- Fixed Overlay Texts: {json.dumps(template_clone_summary.get('fixed_overlay_texts', {}), ensure_ascii=False)}",
        f"- Subtitle Segments Count (Clone Mode): {template_clone_summary.get('subtitle_segments_count', subtitle_track_count)}",
        f"- PRETITLE/TITLE/MOVIE_TITLE Fixed Overlay: {str(bool(template_clone_summary.get('template_clone_mode', False))).lower()}",
        f"- MOVIE_TITLE Generated: {str(bool(template_clone_summary.get('movie_title_generated', False))).lower()}",
        f"- MOVIE_TITLE Fallback Text Used: {str(bool(template_clone_summary.get('movie_title_fallback_text_used', False))).lower()}",
        f"- Template Overlay Passthrough: {json.dumps(template_overlay_passthrough_summary, ensure_ascii=False)}",
        f"- Overlay Duration Sec: {template_clone_summary.get('total_tts_duration_sec', total_tts_duration_sec)}",
        f"- Applied Template Name: {os.path.basename(template_info['template_root']) if template_info else 'none'}",
        f"- Template Base Path: {template_info['template_base'] if template_info else 'not found'}",
        f"- Template Root Path: {template_info['template_root'] if template_info else 'not found'}",
        f"- Template Draft Content Path: {template_info['draft_content_path'] if template_info else 'not found'}",
        f"- Template Draft Meta Path: {template_info['draft_meta_info_path'] if template_info and template_info.get('draft_meta_info_path') else 'not found'}",
        f"- Template Discovery Depth: {template_info['depth'] if template_info else 'n/a'}",
        f"- Template Resource Entries Preserved: {', '.join(template_info['resource_entries']) if template_info and template_info['resource_entries'] else 'none'}",
        f"- Template Style Extracted: {str(bool(template_profiles.get('subtitle'))).lower()}",
        f"- Subtitle Style Source: {(template_profiles.get('sources') or {}).get('subtitle', 'fallback_default')}",
        f"- Title Style Source: {(template_profiles.get('sources') or {}).get('title', 'fallback_default')}",
        f"- Emphasis Style Source: {(template_profiles.get('sources') or {}).get('emphasis', 'fallback_default')}",
        f"- Template Fallback Used: {str(fallback_template_style_used).lower()}",
        f"- Subtitle Style Summary: {json.dumps(template_profiles.get('summary') or [], ensure_ascii=False)}",
        "- TTS/subtitle unit mode: sentence",
        f"- Caption Units Count: {len(caption_manifest_entries)}",
        f"- Max Caption Chars: {max_caption_chars}",
        f"- Caption Split Warnings Count: {len(split_warnings)}",
        f"- Total Segments: {len(segments)}",
        f"- Total TTS Duration Sec: {total_tts_duration_sec}",
        f"- Total Video Duration Sec: {total_video_duration_sec}",
        f"- Duration Guide: {json.dumps(duration_guide_summary, ensure_ascii=False)}",
        f"- Duration Diff Sec (TTS-Video): {timeline_duration_diff_sec}",
        f"- Video Timeline Aligned To TTS: {str(video_timeline_aligned_to_tts).lower()}",
        f"- Pad Strategy: {pad_strategy_summary}",
        f"- Final Slot Tail: {json.dumps(final_slot_tail, ensure_ascii=False)}",
        f"- Audio Track Count: {added_audio_count}",
        f"- Subtitle Track Count: {subtitle_track_count}",
        f"- Source Video Selected: {source_video_path if source_video_path else 'none'}",
        f"- Source Video Draft Path: {draft_video_path if draft_video_path else 'none'}",
        f"- Source Duration Sec (ffprobe): {source_duration_sec if source_duration_sec is not None else 'unknown'}",
        f"- Portrait Crop Applied: {str(bool(portrait_crop_summary.get('applied'))).lower()}",
        f"- Portrait Crop Method: {portrait_crop_summary.get('method', 'none')}",
        f"- Portrait Crop Records: {len(portrait_crop_summary.get('records') or [])}",
        f"- Transcript First Enabled: {str(bool(transcript_utterance_map)).lower()}",
        f"- Transcript Utterance Count: {len(transcript_utterance_map)}",
        f"- Subtitle File Copied: {'yes' if copied_srt_path else 'no'}",
        "- Source Clips-Based Auto Video Cut Placement: yes (default for Phase5-3)",
        "- Full Source Track Placement: optional mode (videoPlacementMode=full_source)",
        "- Draft Type: source video cuts + TTS + subtitle centered draft",
        "- Source Video Manual Placement Required: no (MVP auto placement enabled)",
        "",
        "## Caption Split Warnings",
    ]
    if split_warnings:
        notes_lines.extend(
            [
                f"- [{str(item.get('segment_id') or 'unknown')}] {str(item.get('message') or '').strip()}"
                for item in split_warnings
            ]
        )
    else:
        notes_lines.append("- none")

    notes_lines.extend(
        [
            "",
        "## Known Warnings",
        ]
    )
    if warnings:
        notes_lines.extend([f"- {warning}" for warning in warnings])
    else:
        notes_lines.append("- none")

    notes_path = os.path.join(draft_path, "capcut_notes.md")
    write_notes_file(notes_path, notes_lines)

    checklist_lines = [
        "# CapCut Import Checklist",
        "",
        "1. Copy or keep the draft folder in the CapCut draft directory (do not rename internal files).",
        "2. Open CapCut and locate the new draft by folder name.",
        "3. Verify audio waveform appears for all segments.",
        "4. Play from start and confirm subtitle timing matches narration timing.",
        "5. Check missing media dialog appears or not.",
        "6. If missing media appears:",
        "   - Absolute variant: verify draft folder path still matches original machine path.",
        "   - Relative variant: verify CapCut build supports relative media paths in draft_content.json.",
        "7. Confirm export works without audio relink prompts.",
    ]
    checklist_path = os.path.join(draft_path, "capcut_import_checklist.md")
    write_notes_file(checklist_path, checklist_lines)

    absolute_zip_filename = f"{draft_name}.zip" if create_zip else ""
    absolute_zip_path = os.path.join(output_base, absolute_zip_filename) if create_zip else ""
    if create_zip:
        zip_folder(draft_path, absolute_zip_path, output_base)

    relative_draft_name = ""
    relative_draft_path = ""
    relative_zip_filename = ""
    relative_zip_path = ""

    if audio_path_mode in {"relative", "both"}:
        relative_draft_name, relative_draft_path = create_relative_variant(draft_path, output_base)
        relative_notes_path = os.path.join(relative_draft_path, "capcut_notes.md")
        relative_notes_lines = list(notes_lines)
        relative_notes_lines.insert(4, "- Variant: relative-audio-path")
        write_notes_file(relative_notes_path, relative_notes_lines)

        relative_checklist_path = os.path.join(relative_draft_path, "capcut_import_checklist.md")
        write_notes_file(relative_checklist_path, checklist_lines)

        relative_zip_filename = f"{relative_draft_name}.zip" if create_zip else ""
        relative_zip_path = os.path.join(output_base, relative_zip_filename) if create_zip else ""
        if create_zip:
            zip_folder(relative_draft_path, relative_zip_path, output_base)

    primary_draft_path = draft_path
    primary_zip_file = absolute_zip_filename
    primary_zip_path = absolute_zip_path

    variants = {
        "absolute": {
            "draftPath": draft_path,
            "zipFile": absolute_zip_filename,
            "zipPath": absolute_zip_path,
        }
    }
    if relative_draft_path:
        variants["relative"] = {
            "draftPath": relative_draft_path,
            "zipFile": relative_zip_filename,
            "zipPath": relative_zip_path,
        }

    return {
        "draftPath": primary_draft_path,
        "draftOutputMode": draft_output_policy["mode"],
        "packageZip": create_zip,
        "zipFile": primary_zip_file,
        "recommendedZip": primary_zip_file,
        "zipPath": primary_zip_path,
        "totalDurationUs": current_time_us,
        "totalDurationSec": current_time_us / 1_000_000,
        "audioTrackCount": added_audio_count,
        "subtitleTrackCount": subtitle_track_count,
        "draftAudioDir": audio_dir,
        "draftSubtitlePath": copied_srt_path,
        "editManifestPath": edit_manifest_path,
        "notesPath": notes_path,
        "checklistPath": checklist_path,
        "audioPathMode": audio_path_mode,
        "capcutTemplateUsed": bool(use_capcut_template and template_info and template_profiles.get("subtitle")),
        "templatePath": template_info["template_root"] if template_info else "",
        "templateLoadStatus": (
            "loaded"
            if use_capcut_template and template_info and template_profiles.get("subtitle")
            else ("disabled" if not use_capcut_template else "failed")
        ),
        "templateCloneMode": template_clone_summary.get("template_clone_mode", False),
        "templateMarkersFound": template_clone_summary.get("template_markers_found", []),
        "missingTemplateMarkers": template_clone_summary.get("missing_template_markers", []),
        "zipVariants": variants,
        "warnings": warnings,
    }


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: python capcut_draft.py <input_json_path>"}))
        sys.exit(1)

    result = create_draft(sys.argv[1])
    print(json.dumps(result))

