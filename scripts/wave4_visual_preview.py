#!/usr/bin/env python3
import argparse
import json
import os
from pathlib import Path

try:
    import cv2
except Exception:  # pragma: no cover
    cv2 = None

try:
    from PIL import Image, ImageDraw, ImageFont
except Exception:  # pragma: no cover
    Image = None
    ImageDraw = None
    ImageFont = None


PROJECT_ROOT = Path(__file__).resolve().parents[1]


def load_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8-sig"))


def write_json(path, data):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def normalize_text(value):
    return " ".join(str(value or "").split())


def parse_timecode(value):
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value or "").strip()
    parts = text.split(":")
    try:
        if len(parts) == 3:
            return int(parts[0]) * 3600 + int(parts[1]) * 60 + float(parts[2])
        if len(parts) == 2:
            return int(parts[0]) * 60 + float(parts[1])
        return float(text)
    except ValueError:
        return 0.0


def sample_frame(video_path, time_sec):
    if cv2 is None:
        raise RuntimeError("opencv unavailable")
    cap = cv2.VideoCapture(str(video_path))
    try:
        cap.set(cv2.CAP_PROP_POS_MSEC, max(0.0, float(time_sec)) * 1000)
        ok, frame = cap.read()
        if not ok or frame is None:
            raise RuntimeError("frame sample failed")
        return cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
    finally:
        cap.release()


def font(size):
    candidates = [
        Path("C:/Windows/Fonts/malgun.ttf"),
        Path("C:/Windows/Fonts/malgunbd.ttf"),
        Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"),
    ]
    for candidate in candidates:
        if candidate.exists() and ImageFont is not None:
            return ImageFont.truetype(str(candidate), size)
    return ImageFont.load_default() if ImageFont is not None else None


def hex_to_rgb(hex_value):
    text = str(hex_value or "").strip().lstrip("#")
    if len(text) != 6:
        return (255, 255, 255)
    try:
        return tuple(int(text[i:i + 2], 16) for i in (0, 2, 4))
    except ValueError:
        return (255, 255, 255)


def load_caption_colors():
    config_path = PROJECT_ROOT / "midform" / "config" / "caption_colors.json"
    if not config_path.exists():
        return {"roles": {}, "speakers": {}}
    return load_json(config_path)


def resolve_caption_color(speaker, config):
    name = normalize_text(speaker)
    speakers = config.get("speakers") if isinstance(config.get("speakers"), dict) else {}
    roles = config.get("roles") if isinstance(config.get("roles"), dict) else {}
    mapped = speakers.get(name)
    if isinstance(mapped, str) and mapped.startswith("#"):
        return mapped
    if isinstance(mapped, str) and roles.get(mapped):
        return roles.get(mapped)
    if roles.get(name):
        return roles.get(name)
    return ""


def wrap_text(draw, text, font_obj, max_width):
    words = list(str(text or ""))
    lines = []
    current = ""
    for ch in words:
        candidate = current + ch
        bbox = draw.textbbox((0, 0), candidate, font=font_obj)
        if bbox[2] - bbox[0] <= max_width or not current:
            current = candidate
        else:
            lines.append(current)
            current = ch
    if current:
        lines.append(current)
    return lines[:3]


def render_preview(frame_rgb, text, color_hex, output_path, label):
    if Image is None or ImageDraw is None or ImageFont is None:
        raise RuntimeError("pillow unavailable")
    image = Image.fromarray(frame_rgb)
    image.thumbnail((1080, 1920))
    canvas = Image.new("RGB", (1080, 1920), (0, 0, 0))
    x = (1080 - image.width) // 2
    y = (1920 - image.height) // 2
    canvas.paste(image, (x, y))
    overlay = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    draw.rectangle((70, 1460, 1010, 1745), fill=(0, 0, 0, 185))
    font_obj = font(54)
    label_font = font(28)
    rgb = hex_to_rgb(color_hex)
    lines = wrap_text(draw, text, font_obj, 880)
    top = 1510
    for line in lines:
        bbox = draw.textbbox((0, 0), line, font=font_obj)
        line_width = bbox[2] - bbox[0]
        draw.text(((1080 - line_width) / 2, top), line, font=font_obj, fill=rgb + (255,), stroke_width=3, stroke_fill=(0, 0, 0, 255))
        top += 64
    draw.text((80, 1418), label, font=label_font, fill=(255, 255, 255, 230))
    result = Image.alpha_composite(canvas.convert("RGBA"), overlay).convert("RGB")
    result.save(output_path, "PNG")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--draft-input", required=True)
    parser.add_argument("--proof", required=True)
    parser.add_argument("--out-dir", required=True)
    parser.add_argument("--limit", type=int, default=8)
    args = parser.parse_args()

    draft = load_json(args.draft_input)
    source_video = Path(draft.get("source_video_path") or "")
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    caption_units = [unit for unit in draft.get("captionUnits", []) if unit.get("segment_type") in {"dialogue_quote", "dialogue"}]
    color_config = load_caption_colors()
    by_segment = {}
    for segment in draft.get("segments", []):
        by_segment[str(segment.get("segment_id") or "")] = segment

    results = []
    grouped = []
    seen = set()
    for unit in caption_units:
        segment_id = str(unit.get("segment_id") or "")
        if segment_id in seen:
            continue
        seen.add(segment_id)
        segment = by_segment.get(segment_id) or {}
        speaker = normalize_text(segment.get("speaker") or unit.get("speaker") or "")
        color = normalize_text(segment.get("caption_color") or unit.get("caption_color") or resolve_caption_color(speaker, color_config))
        text = normalize_text(segment.get("caption_text") or unit.get("text") or "")
        if text and color:
            grouped.append((segment_id, segment, speaker, text, color))
    for index, (segment_id, segment, speaker, text, color) in enumerate(grouped[:args.limit], start=1):
        scenes = segment.get("source_scenes") if isinstance(segment.get("source_scenes"), list) else []
        start = parse_timecode((scenes[0] or {}).get("start") if scenes else 0)
        end = parse_timecode((scenes[0] or {}).get("end") if scenes else start + 1)
        sample_sec = start + max(0.05, min(0.5, (end - start) / 2))
        output_path = out_dir / f"{index:02d}_{segment_id}.png"
        status = "passed"
        reason = ""
        try:
            frame = sample_frame(source_video, sample_sec)
            render_preview(frame, text, color, output_path, f"{speaker or 'speaker?'} {color} @ {sample_sec:.3f}s")
        except Exception as error:  # pragma: no cover
            status = "failed"
            reason = str(error)
        results.append({
            "segment_id": segment_id,
            "speaker": speaker,
            "caption_color": color,
            "text": text,
            "sample_sec": round(sample_sec, 3),
            "preview_path": str(output_path.relative_to(PROJECT_ROOT)).replace("\\", "/") if output_path.exists() else "",
            "status": status,
            "reason": reason,
        })

    write_json(args.proof, {
        "artifact_type": "wave4_preview_frame_proof",
        "source_video": str(source_video.relative_to(PROJECT_ROOT)).replace("\\", "/") if source_video.is_absolute() and source_video.exists() else str(source_video),
        "preview_level": "source frame with generated subtitle/color overlay; local preview evidence, not CapCut app export",
        "checked": len(results),
        "passed": len([item for item in results if item["status"] == "passed"]),
        "results": results,
    })
    passed_count = len([item for item in results if item["status"] == "passed"])
    print(json.dumps({"checked": len(results), "passed": passed_count}, ensure_ascii=False))


if __name__ == "__main__":
    main()
