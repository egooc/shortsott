#!/usr/bin/env python3
"""Stage 2 deep YouTube channel verification.

Reads output/stage1_result.json, analyzes PASS channels, and writes:
- output/stage2_result.json
- output/channels_graded.csv
- output/legend_videos.csv

Only metadata is requested through yt-dlp; videos are never downloaded.
"""

from __future__ import annotations

import csv
import argparse
import json
import logging
import math
import os
import random
import re
import shutil
import statistics
import subprocess
import sys
import time
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from urllib.parse import urlparse, urlunparse


SCRIPT_DIR = Path(__file__).resolve().parent
MIDFORM_DIR = SCRIPT_DIR.parent
OUTPUT_DIR = SCRIPT_DIR / "output"
STAGE1_FILE = OUTPUT_DIR / "stage1_result.json"
STAGE2_FILE = OUTPUT_DIR / "stage2_result.json"
CHANNELS_CSV = OUTPUT_DIR / "channels_graded.csv"
LEGENDS_CSV = OUTPUT_DIR / "legend_videos.csv"
LOG_DIR = MIDFORM_DIR / "logs"
LOG_FILE = LOG_DIR / "phase_a_verify_deep.log"

MAX_WORKERS = max(1, min(5, int(os.environ.get("VERIFY_DEEP_WORKERS", "5"))))
CHECKPOINT_EVERY = 20
RECENT_LIMIT = 50
POPULAR_LIMIT = 30
YTDLP_TIMEOUT_SEC = int(os.environ.get("YTDLP_TIMEOUT_SEC", "240"))


class MissingYtDlp(RuntimeError):
    pass


def setup_dirs() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    LOG_DIR.mkdir(parents=True, exist_ok=True)


def setup_logging() -> None:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except AttributeError:
        pass
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        handlers=[
            logging.StreamHandler(sys.stdout),
            logging.FileHandler(LOG_FILE, encoding="utf-8"),
        ],
    )


def utc_now() -> datetime:
    return datetime.now(UTC)


def ytdlp_base_cmd() -> list[str]:
    executable = shutil.which("yt-dlp") or shutil.which("yt-dlp.exe")
    cmd = [executable] if executable else [sys.executable, "-m", "yt_dlp"]
    cmd.extend(
        [
            "--skip-download",
            "--no-warnings",
            "--ignore-no-formats-error",
            "--socket-timeout",
            "25",
            "--extractor-retries",
            "2",
            "--dump-single-json",
        ]
    )
    return cmd


def run_ytdlp(args: list[str], timeout: int = YTDLP_TIMEOUT_SEC) -> dict[str, Any]:
    time.sleep(random.uniform(1.0, 2.0))
    proc = subprocess.run(
        ytdlp_base_cmd() + args,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
    )
    stderr = proc.stderr.strip()
    if proc.returncode != 0 and "No module named yt_dlp" in stderr:
        raise MissingYtDlp(
            "yt-dlp is not installed. Install it with: python -m pip install -U yt-dlp"
        )
    if proc.returncode != 0:
        lowered = stderr.lower()
        if any(marker in lowered for marker in ("captcha", "sign in to confirm", "bot", "unusual traffic", "429")):
            logging.warning("Possible YouTube bot/rate block detected. Sleeping 60 seconds before retry.")
            time.sleep(60)
            proc = subprocess.run(
                ytdlp_base_cmd() + args,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=timeout,
            )
            stderr = proc.stderr.strip()
            if proc.returncode == 0:
                stdout = proc.stdout.strip()
                if not stdout:
                    raise RuntimeError("yt-dlp returned empty output")
                return json.loads(stdout)
        raise RuntimeError(stderr or f"yt-dlp exited with code {proc.returncode}")
    stdout = proc.stdout.strip()
    if not stdout:
        raise RuntimeError("yt-dlp returned empty output")
    return json.loads(stdout)


def load_json_rows(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    data = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(data, list):
        return [row for row in data if isinstance(row, dict)]
    if isinstance(data, dict) and isinstance(data.get("results"), list):
        return [row for row in data["results"] if isinstance(row, dict)]
    if isinstance(data, dict) and data.get("handle"):
        return [data]
    return []


def save_stage2(results: dict[str, dict[str, Any]], input_order: list[str]) -> None:
    ordered = [results[key] for key in input_order if key in results]
    temp = STAGE2_FILE.with_suffix(".json.tmp")
    temp.write_text(json.dumps(ordered, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temp.replace(STAGE2_FILE)


def parse_upload_date(value: Any) -> str | None:
    if value in (None, ""):
        return None
    if isinstance(value, (int, float)):
        try:
            return datetime.fromtimestamp(value, UTC).date().isoformat()
        except (OSError, OverflowError, ValueError):
            return None
    text = str(value).strip()
    if re.fullmatch(r"\d{8}", text):
        return f"{text[0:4]}-{text[4:6]}-{text[6:8]}"
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", text):
        return text
    return None


def parse_date_obj(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value).replace(tzinfo=UTC)
    except ValueError:
        return None


def entry_upload_date(entry: dict[str, Any]) -> str | None:
    for key in ("upload_date", "timestamp", "release_timestamp", "date"):
        parsed = parse_upload_date(entry.get(key))
        if parsed:
            return parsed
    return None


def normalize_channel_url(row: dict[str, Any]) -> str:
    url = str(row.get("url") or "").strip()
    handle = str(row.get("handle") or "").strip()
    if url:
        base = url.rstrip("/")
        if base.endswith("/videos"):
            return base
        return f"{base}/videos"
    if handle.startswith("@"):
        return f"https://www.youtube.com/{handle}/videos"
    if re.fullmatch(r"UC[\w-]{20,}", handle):
        return f"https://www.youtube.com/channel/{handle}/videos"
    if handle.lower().startswith(("http://", "https://")):
        cleaned = urlunparse(urlparse(handle)._replace(query="", fragment="")).rstrip("/")
        return cleaned if cleaned.endswith("/videos") else f"{cleaned}/videos"
    return f"https://www.youtube.com/@{handle.lstrip('@')}/videos"


def popular_url(recent_url: str) -> str:
    base = recent_url.rstrip("/")
    if not base.endswith("/videos"):
        base = f"{base}/videos"
    return f"{base}?view=0&sort=p&flow=grid"


def video_url(entry: dict[str, Any]) -> str | None:
    url = entry.get("webpage_url") or entry.get("original_url") or entry.get("url") or entry.get("id")
    if not url:
        return None
    text = str(url)
    if text.startswith("http"):
        return text
    if re.fullmatch(r"[\w-]{11}", text):
        return f"https://www.youtube.com/watch?v={text}"
    return None


def video_id(entry: dict[str, Any]) -> str:
    value = str(entry.get("id") or "")
    if value:
        return value
    url = video_url(entry) or ""
    match = re.search(r"(?:v=|/shorts/|youtu\.be/)([\w-]{11})", url)
    return match.group(1) if match else url


def summarize_video(entry: dict[str, Any]) -> dict[str, Any]:
    upload_date = entry_upload_date(entry)
    duration = entry.get("duration")
    view_count = entry.get("view_count")
    return {
        "id": video_id(entry),
        "url": video_url(entry),
        "title": entry.get("title") or "",
        "upload_date": upload_date,
        "view_count": int(view_count) if isinstance(view_count, (int, float)) else None,
        "duration_sec": int(duration) if isinstance(duration, (int, float)) else None,
    }


def collect_playlist(url: str, limit: int) -> list[dict[str, Any]]:
    info = run_ytdlp(["--playlist-end", str(limit), url])
    entries = [entry for entry in info.get("entries", []) if isinstance(entry, dict)]
    return [summarize_video(entry) for entry in entries]


def dedupe_videos(*groups: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen: set[str] = set()
    videos: list[dict[str, Any]] = []
    for group in groups:
        for video in group:
            key = str(video.get("id") or video.get("url") or video.get("title"))
            if not key or key in seen:
                continue
            seen.add(key)
            videos.append(video)
    return videos


def median(values: list[int]) -> int:
    if not values:
        return 0
    return int(statistics.median(values))


def top10pct_average(values: list[int]) -> int:
    if not values:
        return 0
    ordered = sorted(values, reverse=True)
    count = max(1, math.ceil(len(ordered) * 0.10))
    return int(sum(ordered[:count]) / count)


def language_guess(titles: list[str]) -> str:
    joined = " ".join(titles[:80])
    counts = {
        "ko": len(re.findall(r"[\uac00-\ud7a3]", joined)),
        "ja": len(re.findall(r"[\u3040-\u30ff]", joined)),
        "zh": len(re.findall(r"[\u4e00-\u9fff]", joined)),
        "en": len(re.findall(r"[A-Za-z]", joined)),
    }
    if not joined:
        return "unknown"
    lang, count = max(counts.items(), key=lambda item: item[1])
    return lang if count > 0 else "unknown"


def is_active(last_upload: str | None) -> bool:
    parsed = parse_date_obj(last_upload)
    if not parsed:
        return False
    return parsed.date() >= (utc_now() - timedelta(days=90)).date()


def grade_channel(
    midform_ratio: float,
    median_views: int,
    recent_30d_median: int,
    legend_count: int,
) -> str:
    if midform_ratio < 0.10:
        return "X"
    if (
        midform_ratio >= 0.50
        and recent_30d_median >= median_views
        and legend_count >= 3
    ):
        return "S"
    if midform_ratio >= 0.30 and median_views >= 10000:
        return "A"
    return "B"


def analyze_channel(row: dict[str, Any]) -> dict[str, Any]:
    handle = str(row.get("handle"))
    recent_url = normalize_channel_url(row)
    result: dict[str, Any] = {
        "handle": handle,
        "url": recent_url,
        "status": "failed",
        "checked_at": utc_now().isoformat(timespec="seconds"),
    }

    last_error: Exception | None = None
    for attempt in range(2):
        try:
            recent = collect_playlist(recent_url, RECENT_LIMIT)
            popular = collect_playlist(popular_url(recent_url), POPULAR_LIMIT)
            videos = dedupe_videos(recent, popular)
            durations = [v["duration_sec"] for v in videos if isinstance(v.get("duration_sec"), int)]
            views = [v["view_count"] for v in videos if isinstance(v.get("view_count"), int)]
            upload_dates = [v["upload_date"] for v in videos if v.get("upload_date")]
            last_upload = max(upload_dates) if upload_dates else row.get("last_upload")

            midform_count = sum(1 for value in durations if 60 <= value <= 600)
            shortform_count = sum(1 for value in durations if value <= 60)
            longform_count = sum(1 for value in durations if value > 600)
            midform_ratio = round(midform_count / len(durations), 4) if durations else 0.0
            shortform_ratio = round(shortform_count / len(durations), 4) if durations else 0.0
            longform_ratio = round(longform_count / len(durations), 4) if durations else 0.0
            median_views = median(views)
            top10_avg = top10pct_average(views)
            recent_cutoff = (utc_now() - timedelta(days=30)).date()
            recent_30d_views = [
                int(v["view_count"])
                for v in videos
                if isinstance(v.get("view_count"), int)
                and (parse_date_obj(v.get("upload_date")) or datetime.min.replace(tzinfo=UTC)).date()
                >= recent_cutoff
            ]
            recent_30d_median = median(recent_30d_views)

            old_cutoff = (utc_now() - timedelta(days=183)).date()
            legends: list[dict[str, Any]] = []
            for video in videos:
                upload_date = parse_date_obj(video.get("upload_date"))
                view_count = video.get("view_count")
                duration = video.get("duration_sec")
                if (
                    upload_date
                    and upload_date.date() <= old_cutoff
                    and isinstance(view_count, int)
                    and isinstance(duration, int)
                    and 60 <= duration <= 600
                    and median_views > 0
                    and view_count >= median_views * 10
                ):
                    multiplier = round(view_count / median_views, 2)
                    legends.append(
                        {
                            "video_url": video.get("url"),
                            "channel_handle": handle,
                            "title": video.get("title"),
                            "upload_date": video.get("upload_date"),
                            "view_count": view_count,
                            "duration_sec": duration,
                            "views_vs_channel_median": multiplier,
                        }
                    )

            grade = grade_channel(
                midform_ratio,
                median_views,
                recent_30d_median,
                len(legends),
            )
            result.update(
                {
                    "status": "ok",
                    "grade": grade,
                    "videos_analyzed": len(videos),
                    "video_count": len(videos),
                    "midform_ratio": midform_ratio,
                    "shortform_ratio": shortform_ratio,
                    "longform_ratio": longform_ratio,
                    "median_views": median_views,
                    "top10pct_avg_views": top10_avg,
                    "recent_30d_median": recent_30d_median,
                    "recent_30d_view_distribution": sorted(recent_30d_views),
                    "legend_count": len(legends),
                    "last_upload": last_upload,
                    "primary_lang": language_guess([str(v.get("title") or "") for v in videos[:10]]),
                    "recent_videos_collected": len(recent),
                    "popular_videos_collected": len(popular),
                    "videos": videos,
                    "legends": sorted(
                        legends,
                        key=lambda item: float(item.get("views_vs_channel_median") or 0),
                        reverse=True,
                    ),
                }
            )
            return result
        except MissingYtDlp:
            raise
        except Exception as exc:  # noqa: BLE001 - retry once, then record and continue.
            last_error = exc
            if attempt == 0:
                time.sleep(random.uniform(2.0, 4.0))

    assert last_error is not None
    result["error"] = str(last_error)[0:500]
    return result


def write_channels_csv(results: dict[str, dict[str, Any]], input_order: list[str]) -> None:
    columns = [
        "handle",
        "grade",
        "videos_analyzed",
        "midform_ratio",
        "shortform_ratio",
        "longform_ratio",
        "median_views",
        "top10pct_avg_views",
        "recent_30d_median",
        "legend_count",
        "primary_lang",
        "last_upload",
        "url",
    ]
    grade_order = {"S": 0, "A": 1, "B": 2, "X": 3}
    rows = [results[key] for key in input_order if key in results]
    rows.sort(key=lambda row: (grade_order.get(str(row.get("grade")), 99), -int(row.get("median_views") or 0)))
    with CHANNELS_CSV.open("w", newline="", encoding="utf-8") as fp:
        writer = csv.DictWriter(fp, fieldnames=columns)
        writer.writeheader()
        for row in rows:
            writer.writerow({column: row.get(column, "") for column in columns})


def write_legends_csv(results: dict[str, dict[str, Any]]) -> None:
    columns = [
        "video_url",
        "channel_handle",
        "title",
        "upload_date",
        "view_count",
        "duration_sec",
        "views_vs_channel_median",
    ]
    legends: list[dict[str, Any]] = []
    for row in results.values():
        for legend in row.get("legends", []) or []:
            if isinstance(legend, dict):
                legends.append(legend)
    legends.sort(
        key=lambda item: float(item.get("views_vs_channel_median") or 0),
        reverse=True,
    )
    with LEGENDS_CSV.open("w", newline="", encoding="utf-8") as fp:
        writer = csv.DictWriter(fp, fieldnames=columns)
        writer.writeheader()
        for legend in legends:
            writer.writerow({column: legend.get(column, "") for column in columns})


def persist_outputs(results: dict[str, dict[str, Any]], input_order: list[str]) -> None:
    save_stage2(results, input_order)
    write_channels_csv(results, input_order)
    write_legends_csv(results)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Deep-verify PASS channels from stage1_result.json.")
    parser.add_argument("--limit", type=int, default=None, help="Analyze only the first N pending PASS channels.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    setup_dirs()
    setup_logging()
    stage1 = [row for row in load_json_rows(STAGE1_FILE) if row.get("status") == "pass"]
    if args.limit is not None:
        stage1 = stage1[: max(0, args.limit)]
    if not stage1:
        logging.info("No PASS channels found in %s. Run verify_light.py first.", STAGE1_FILE)
        persist_outputs({}, [])
        return 0

    existing_rows = load_json_rows(STAGE2_FILE)
    existing = {str(row.get("handle", "")).lower(): row for row in existing_rows if row.get("handle")}
    order = [str(row.get("handle")).lower() for row in stage1]
    pending = [row for row in stage1 if str(row.get("handle")).lower() not in existing]
    total = len(stage1)
    completed = len(stage1) - len(pending)

    logging.info("Stage 2 starting: total_pass=%s pending=%s workers=%s", total, len(pending), MAX_WORKERS)
    consecutive_failures = 0
    processed_since_save = 0
    pending_iter = iter(pending)

    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
        futures = {}

        def submit_next() -> None:
            try:
                row = next(pending_iter)
            except StopIteration:
                return
            futures[executor.submit(analyze_channel, row)] = row

        for _ in range(MAX_WORKERS):
            submit_next()

        while futures:
            done, _ = wait(futures, return_when=FIRST_COMPLETED)
            for future in done:
                row = futures.pop(future)
                handle = str(row.get("handle"))
                key = handle.lower()
                try:
                    analyzed = future.result()
                except MissingYtDlp as exc:
                    logging.error("%s", exc)
                    persist_outputs(existing, order)
                    return 2
                except Exception as exc:  # noqa: BLE001 - record and continue.
                    analyzed = {
                        "handle": handle,
                        "url": normalize_channel_url(row),
                        "status": "failed",
                        "checked_at": utc_now().isoformat(timespec="seconds"),
                        "error": str(exc)[0:500],
                    }

                existing[key] = analyzed
                completed += 1
                processed_since_save += 1
                status = analyzed.get("grade") if analyzed.get("status") == "ok" else analyzed.get("status")
                logging.info("[%s/%s] %s -> %s", completed, total, handle, status)

                if analyzed.get("status") != "ok":
                    consecutive_failures += 1
                else:
                    consecutive_failures = 0
                if consecutive_failures >= 10:
                    logging.warning("10 consecutive failures detected. Sleeping 60 seconds before resuming.")
                    persist_outputs(existing, order)
                    time.sleep(60)
                    consecutive_failures = 0

                if processed_since_save >= CHECKPOINT_EVERY:
                    persist_outputs(existing, order)
                    processed_since_save = 0

                submit_next()

    persist_outputs(existing, order)
    logging.info("Stage 2 complete. Wrote %s and %s", CHANNELS_CSV, LEGENDS_CSV)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
