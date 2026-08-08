"""Cross-check Gemini highlight windows against independent signal evidence.

Standalone research helper (P4 of docs/opensource-adoption-analysis-2026-08-08.md).
Read-only: consumes an item's Gemini candidate windows plus the P1 script outputs
(scene list, excitement profile) and reports, per window:
  - signal_support : mean excitement z-score inside the window, and whether the
    window overlaps one of the top signal windows (independent corroboration)
  - scene_alignment: distance from each window edge to the nearest neural scene
    cut (well-cut windows start/end near a cut, not mid-shot)
  - overlap        : IoU against every other window; pairs over the threshold are
    flagged (symmetric-IoU dedupe - the asymmetric candidate-only rule from the
    reference implementation lets a long window swallow a short one unnoticed)
Verdicts: "corroborated" / "neutral" / "divergent" per window - advisory only.
Nothing here selects or rejects windows; the production selector is untouched.

Usage
  python scripts/crosscheck_highlight_windows.py --item-config queue/process/item_X/item_config.json
         --scenes scenes.json --excitement excitement.json [--json OUT]
         [--iou-threshold 0.5] [--edge-tolerance 0.75]
  (or --windows-json W.json instead of --item-config)
"""

import argparse
import json
import sys

EDGE_TOLERANCE_SEC = 0.75   # an edge within this of a scene cut counts as aligned
IOU_THRESHOLD = 0.5
SUPPORT_Z = 0.3             # mean excitement above this = signal supports the window
DIVERGE_Z = -0.2            # below this = signal actively disagrees


def load_windows_from_item_config(path):
    with open(path, encoding="utf-8") as fh:
        config = json.load(fh)
    guide = config.get("ottogi_guide_output") or {}
    windows = []
    seen = set()
    for key in ("highlight_candidates", "shortform_candidate_windows", "hook_candidates"):
        for w in guide.get(key) or []:
            try:
                start = float(w.get("start_sec"))
                end = float(w.get("end_sec"))
            except (TypeError, ValueError):
                continue
            if end <= start or (start, end) in seen:
                continue
            seen.add((start, end))
            windows.append({
                "id": w.get("window_id") or w.get("purpose") or f"win_{len(windows)+1:02d}",
                "source_key": key,
                "start_sec": start,
                "end_sec": end,
                "hook_score": w.get("hook_score"),
            })
    return windows


def iou(a_start, a_end, b_start, b_end):
    inter = max(0.0, min(a_end, b_end) - max(a_start, b_start))
    union = (a_end - a_start) + (b_end - b_start) - inter
    return inter / union if union > 0 else 0.0


def nearest_cut_distance(t, cut_times):
    if not cut_times:
        return None
    return min(abs(c - t) for c in cut_times)


def mean_excitement(excitement, start, end):
    lo = max(0, int(start))
    hi = min(len(excitement), max(lo + 1, int(round(end))))
    if hi <= lo:
        return None
    values = excitement[lo:hi]
    return sum(values) / len(values)


def overlaps_top_window(start, end, top_windows):
    for w in top_windows:
        if min(end, w["end_sec"]) - max(start, w["start_sec"]) > 0:
            return w
    return None


def crosscheck(windows, scenes, excitement, top_windows,
               iou_threshold=IOU_THRESHOLD, edge_tolerance=EDGE_TOLERANCE_SEC):
    # Scene cut times = every boundary between consecutive scenes.
    cut_times = sorted({s["start_sec"] for s in scenes} | {s["end_sec"] for s in scenes})

    reports = []
    for w in windows:
        start, end = w["start_sec"], w["end_sec"]

        mean_z = mean_excitement(excitement, start, end)
        top_hit = overlaps_top_window(start, end, top_windows)

        start_dist = nearest_cut_distance(start, cut_times)
        end_dist = nearest_cut_distance(end, cut_times)
        start_aligned = start_dist is not None and start_dist <= edge_tolerance
        end_aligned = end_dist is not None and end_dist <= edge_tolerance

        if top_hit is not None or (mean_z is not None and mean_z >= SUPPORT_Z):
            verdict = "corroborated"
        elif mean_z is not None and mean_z <= DIVERGE_Z:
            verdict = "divergent"
        else:
            verdict = "neutral"

        reports.append({
            **w,
            "verdict": verdict,
            "signal_support": {
                "mean_excitement_z": round(mean_z, 3) if mean_z is not None else None,
                "overlaps_top_signal_window": (
                    {"start_sec": top_hit["start_sec"], "end_sec": top_hit["end_sec"],
                     "score": top_hit["score"]} if top_hit else None
                ),
            },
            "scene_alignment": {
                "start_to_nearest_cut_sec": round(start_dist, 3) if start_dist is not None else None,
                "end_to_nearest_cut_sec": round(end_dist, 3) if end_dist is not None else None,
                "start_aligned": start_aligned,
                "end_aligned": end_aligned,
            },
        })

    overlap_flags = []
    for i in range(len(windows)):
        for j in range(i + 1, len(windows)):
            a, b = windows[i], windows[j]
            value = iou(a["start_sec"], a["end_sec"], b["start_sec"], b["end_sec"])
            if value >= iou_threshold:
                overlap_flags.append({
                    "a": a["id"], "b": b["id"], "iou": round(value, 3),
                })

    return reports, overlap_flags


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--item-config", default="")
    parser.add_argument("--windows-json", default="")
    parser.add_argument("--scenes", required=True,
                        help="scene_detect_transnet.py output JSON")
    parser.add_argument("--excitement", required=True,
                        help="audio_motion_score.py output JSON")
    parser.add_argument("--json", dest="json_out", default="")
    parser.add_argument("--iou-threshold", type=float, default=IOU_THRESHOLD)
    parser.add_argument("--edge-tolerance", type=float, default=EDGE_TOLERANCE_SEC)
    args = parser.parse_args()

    if args.item_config:
        windows = load_windows_from_item_config(args.item_config)
    elif args.windows_json:
        with open(args.windows_json, encoding="utf-8") as fh:
            windows = json.load(fh)
    else:
        parser.error("give --item-config or --windows-json")
        return 2
    if not windows:
        raise SystemExit("no candidate windows found")

    with open(args.scenes, encoding="utf-8") as fh:
        scenes = json.load(fh).get("scenes") or []
    with open(args.excitement, encoding="utf-8") as fh:
        excitement_data = json.load(fh)

    reports, overlap_flags = crosscheck(
        windows, scenes,
        excitement_data.get("excitement") or [],
        excitement_data.get("top_windows") or [],
        iou_threshold=args.iou_threshold,
        edge_tolerance=args.edge_tolerance,
    )

    counts = {}
    for r in reports:
        counts[r["verdict"]] = counts.get(r["verdict"], 0) + 1

    result = {
        "windows_checked": len(reports),
        "verdict_counts": counts,
        "overlap_flags": overlap_flags,
        "windows": reports,
    }

    text = json.dumps(result, ensure_ascii=False, indent=2)
    if args.json_out:
        with open(args.json_out, "w", encoding="utf-8") as fh:
            fh.write(text + "\n")
        print(f"wrote {args.json_out} ({counts})")
    else:
        print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
