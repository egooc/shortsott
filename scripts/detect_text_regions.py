#!/usr/bin/env python3
"""
Detect likely burned-in text/logo regions from a source video.

This is detection-only: it does not modify the source file. The output is a JSON
report plus a preview image with boxes so the editor can decide what to blur in
CapCut.
"""

import argparse
import json
import os
from datetime import datetime

try:
    import cv2  # type: ignore
except ImportError:
    cv2 = None


def zone_for_box(y, h, frame_h):
    center = y + h / 2
    if frame_h <= 0:
        return "unknown"
    if center < frame_h / 3:
        return "top"
    if center > frame_h * 2 / 3:
        return "bottom"
    return "middle"


def detect_regions(frame):
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    # Text/logo overlays usually create strong small horizontal strokes.
    blackhat = cv2.morphologyEx(gray, cv2.MORPH_BLACKHAT, cv2.getStructuringElement(cv2.MORPH_RECT, (17, 5)))
    grad = cv2.Sobel(blackhat, ddepth=cv2.CV_32F, dx=1, dy=0, ksize=-1)
    grad = cv2.convertScaleAbs(grad)
    grad = cv2.GaussianBlur(grad, (3, 3), 0)
    _, thresh = cv2.threshold(grad, 0, 255, cv2.THRESH_BINARY | cv2.THRESH_OTSU)
    close = cv2.morphologyEx(thresh, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (21, 5)))
    close = cv2.dilate(close, cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3)), iterations=1)

    contours, _ = cv2.findContours(close, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    frame_h, frame_w = frame.shape[:2]
    candidates = []
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
        candidates.append({
            "x": int(x),
            "y": int(y),
            "width": int(w),
            "height": int(h),
            "zone": zone_for_box(y, h, frame_h),
            "area_ratio": round(area_ratio, 6),
            "confidence": round(min(0.95, 0.35 + area_ratio * 60 + min(aspect, 8) / 20), 3),
        })

    candidates.sort(key=lambda item: (item["zone"], item["y"], item["x"]))
    return candidates[:24]


def make_preview(frames, output_path):
    if not frames:
        return ""
    thumbs = []
    for item in frames[:6]:
        frame = item["frame"].copy()
        for region in item["regions"]:
            x, y, w, h = region["x"], region["y"], region["width"], region["height"]
            cv2.rectangle(frame, (x, y), (x + w, y + h), (0, 64, 255), 3)
        label = f'{item["time_sec"]:.1f}s / {len(item["regions"])} candidates'
        cv2.putText(frame, label, (24, 42), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (0, 64, 255), 3, cv2.LINE_AA)
        target_w = 360
        scale = target_w / frame.shape[1]
        thumbs.append(cv2.resize(frame, (target_w, int(frame.shape[0] * scale))))

    max_h = max(thumb.shape[0] for thumb in thumbs)
    padded = []
    for thumb in thumbs:
        if thumb.shape[0] < max_h:
            pad = max_h - thumb.shape[0]
            thumb = cv2.copyMakeBorder(thumb, 0, pad, 0, 0, cv2.BORDER_CONSTANT, value=(245, 247, 250))
        padded.append(thumb)
    sheet = cv2.hconcat(padded) if len(padded) > 1 else padded[0]
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    cv2.imwrite(output_path, sheet)
    return output_path


def detect_video(video_path, output_json, preview_path, interval_sec=2.0, max_frames=12):
    if cv2 is None:
        return {
            "status": "failed",
            "reason": "opencv_not_installed",
            "message": "cv2 is required for local text-region detection.",
        }
    if not os.path.exists(video_path):
        return {
            "status": "failed",
            "reason": "source_not_found",
            "message": f"source video not found: {video_path}",
        }

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        return {
            "status": "failed",
            "reason": "video_open_failed",
            "message": f"failed to open source video: {video_path}",
        }

    fps = cap.get(cv2.CAP_PROP_FPS) or 30
    frame_count = cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0
    duration_sec = frame_count / fps if fps else 0
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)

    sample_times = []
    t = 0.0
    while t <= max(0, duration_sec) and len(sample_times) < max_frames:
        sample_times.append(round(t, 3))
        t += max(0.5, interval_sec)
    if not sample_times:
        sample_times = [0.0]

    frames_for_preview = []
    sampled = []
    zone_counts = {"top": 0, "middle": 0, "bottom": 0, "unknown": 0}
    for time_sec in sample_times:
        cap.set(cv2.CAP_PROP_POS_MSEC, time_sec * 1000)
        ok, frame = cap.read()
        if not ok or frame is None:
            continue
        regions = detect_regions(frame)
        for region in regions:
            zone_counts[region["zone"]] = zone_counts.get(region["zone"], 0) + 1
        sampled.append({
            "time_sec": time_sec,
            "regions": regions,
            "regions_count": len(regions),
        })
        if regions:
            frames_for_preview.append({"time_sec": time_sec, "regions": regions, "frame": frame})
    cap.release()

    preview_saved = make_preview(frames_for_preview, preview_path) if frames_for_preview else ""
    total_regions = sum(item["regions_count"] for item in sampled)
    result = {
        "status": "success",
        "detector": "opencv_text_region_candidates",
        "generated_at": datetime.now().isoformat(),
        "source_video": os.path.abspath(video_path),
        "video": {
            "duration_sec": round(duration_sec, 3),
            "width": width,
            "height": height,
            "fps": round(fps, 3),
        },
        "sampling": {
            "interval_sec": interval_sec,
            "max_frames": max_frames,
            "sampled_frames": len(sampled),
        },
        "regions_count": total_regions,
        "zone_counts": zone_counts,
        "preview_path": os.path.abspath(preview_saved) if preview_saved else "",
        "frames": sampled,
        "notes": [
            "Detection-only report. No source video was modified.",
            "Boxes are OCR/text-like region candidates, not guaranteed readable OCR text.",
            "Use the preview and JSON coordinates to decide manual blur/mask work in CapCut.",
        ],
    }

    os.makedirs(os.path.dirname(output_json), exist_ok=True)
    with open(output_json, "w", encoding="utf-8") as file:
        json.dump(result, file, ensure_ascii=False, indent=2)
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--video", required=True)
    parser.add_argument("--output-json", required=True)
    parser.add_argument("--preview", required=True)
    parser.add_argument("--interval-sec", type=float, default=2.0)
    parser.add_argument("--max-frames", type=int, default=12)
    args = parser.parse_args()

    result = detect_video(
        args.video,
        args.output_json,
        args.preview,
        interval_sec=args.interval_sec,
        max_frames=args.max_frames,
    )
    print(json.dumps(result, ensure_ascii=False))
    if result.get("status") != "success":
        raise SystemExit(1)


if __name__ == "__main__":
    main()
