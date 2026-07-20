#!/usr/bin/env python3
"""Phase A-0: extract channel handles from seed video URLs.

Reads input/video_urls.txt and writes:
- output/url_to_channel.csv
- input/handles.txt
- output/seed_videos_ranked.csv

Only metadata is requested through yt-dlp; videos are never downloaded.
"""

from __future__ import annotations

import csv
import argparse
import logging
import os
import random
import re
import shutil
import subprocess
import sys
import time
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlencode, urlparse, urlunparse


SCRIPT_DIR = Path(__file__).resolve().parent
MIDFORM_DIR = SCRIPT_DIR.parent
INPUT_DIR = SCRIPT_DIR / "input"
OUTPUT_DIR = SCRIPT_DIR / "output"
VIDEO_URLS_FILE = INPUT_DIR / "video_urls.txt"
HANDLES_FILE = INPUT_DIR / "handles.txt"
URL_TO_CHANNEL_CSV = OUTPUT_DIR / "url_to_channel.csv"
SEED_RANKED_CSV = OUTPUT_DIR / "seed_videos_ranked.csv"
LOG_DIR = MIDFORM_DIR / "logs"
LOG_FILE = LOG_DIR / "phase_a_extract_handles.log"

MAX_WORKERS = max(1, min(8, int(os.environ.get("EXTRACT_HANDLES_WORKERS", "6"))))
CHECKPOINT_EVERY = 100
YTDLP_TIMEOUT_SEC = int(os.environ.get("YTDLP_TIMEOUT_SEC", "90"))
PRINT_FORMAT = (
    "%(uploader_id)s|%(channel_id)s|%(channel)s|%(view_count)s|"
    "%(duration)s|%(upload_date)s"
)

CSV_COLUMNS = [
    "video_url",
    "handle",
    "channel_id",
    "channel_name",
    "view_count",
    "duration_sec",
    "upload_date",
    "status",
]


class MissingYtDlp(RuntimeError):
    pass


def setup_dirs() -> None:
    INPUT_DIR.mkdir(parents=True, exist_ok=True)
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    LOG_DIR.mkdir(parents=True, exist_ok=True)


def setup_logging() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        handlers=[
            logging.StreamHandler(sys.stdout),
            logging.FileHandler(LOG_FILE, encoding="utf-8"),
        ],
    )


def utc_now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def ytdlp_cmd() -> list[str]:
    executable = shutil.which("yt-dlp") or shutil.which("yt-dlp.exe")
    cmd = [executable] if executable else [sys.executable, "-m", "yt_dlp"]
    cmd.extend(
        [
            "--skip-download",
            "--no-warnings",
            "--no-playlist",
            "--socket-timeout",
            "20",
            "--extractor-retries",
            "2",
            "--print",
            PRINT_FORMAT,
        ]
    )
    return cmd


def clean_input_line(line: str) -> str | None:
    value = line.strip()
    if not value or value.startswith("#"):
        return None
    return value


def normalize_video_url(raw: str) -> str:
    value = raw.strip()
    parsed = urlparse(value)
    if parsed.netloc.lower() in {"youtu.be", "www.youtu.be"}:
        video_id = parsed.path.strip("/").split("/")[0]
        return f"https://www.youtube.com/watch?v={video_id}" if video_id else value
    if "youtube.com" not in parsed.netloc.lower():
        return value

    query = parse_qs(parsed.query)
    video_id = (query.get("v") or [""])[0]
    if "/shorts/" in parsed.path:
        match = re.search(r"/shorts/([\w-]{11})", parsed.path)
        video_id = match.group(1) if match else video_id
    if video_id:
        return urlunparse(
            (
                "https",
                "www.youtube.com",
                "/watch",
                "",
                urlencode({"v": video_id}),
                "",
            )
        )
    return urlunparse(parsed._replace(query="", fragment="")).rstrip("/")


def load_video_urls(limit: int | None = None) -> list[str]:
    if not VIDEO_URLS_FILE.exists():
        VIDEO_URLS_FILE.write_text(
            "# Add one YouTube video URL per line.\n", encoding="utf-8"
        )
    seen: set[str] = set()
    urls: list[str] = []
    for line in VIDEO_URLS_FILE.read_text(encoding="utf-8").splitlines():
        raw = clean_input_line(line)
        if raw is None:
            continue
        url = normalize_video_url(raw)
        key = url.lower()
        if key in seen:
            continue
        seen.add(key)
        urls.append(url)
        if limit is not None and len(urls) >= limit:
            break
    return urls


def load_existing_rows() -> dict[str, dict[str, str]]:
    if not URL_TO_CHANNEL_CSV.exists():
        return {}
    with URL_TO_CHANNEL_CSV.open("r", newline="", encoding="utf-8") as fp:
        reader = csv.DictReader(fp)
        rows = {}
        for row in reader:
            url = row.get("video_url")
            if not url:
                continue
            cleaned = {column: row.get(column, "") for column in CSV_COLUMNS}
            if (
                cleaned.get("status") == "ok"
                and not cleaned.get("handle")
                and not cleaned.get("channel_id")
            ):
                continue
            rows[normalize_video_url(url).lower()] = cleaned
        return rows


def safe_int(value: str) -> int | None:
    text = value.strip()
    if not text or text in {"NA", "None", "none", "null"}:
        return None
    try:
        return int(float(text))
    except ValueError:
        return None


def safe_text(value: str) -> str:
    text = value.strip()
    return "" if text in {"NA", "None", "none", "null"} else text


def parse_print_line(line: str) -> dict[str, Any]:
    first = line.split("|", 2)
    if len(first) != 3:
        raise ValueError(f"Unexpected yt-dlp print output: {line[:200]}")
    uploader_id, channel_id, rest = first
    tail = rest.rsplit("|", 3)
    if len(tail) != 4:
        raise ValueError(f"Unexpected yt-dlp print output: {line[:200]}")
    channel_name, view_count, duration, upload_date = tail
    uploader_id = safe_text(uploader_id)
    channel_id = safe_text(channel_id)
    handle = uploader_id if uploader_id.startswith("@") else channel_id
    return {
        "handle": handle,
        "channel_id": channel_id,
        "channel_name": safe_text(channel_name),
        "view_count": safe_int(view_count),
        "duration_sec": safe_int(duration),
        "upload_date": safe_text(upload_date),
    }


def classify_error(error: Exception) -> str:
    text = str(error).lower()
    deleted_markers = [
        "video unavailable",
        "private video",
        "this video has been removed",
        "removed by the uploader",
        "not available",
        "unavailable",
        "deleted",
        "copyright claim",
    ]
    if any(marker in text for marker in deleted_markers):
        return "deleted"
    return "unreachable"


def extract_one(video_url: str) -> dict[str, Any]:
    last_error: Exception | None = None
    for attempt in range(2):
        try:
            time.sleep(random.uniform(0.5, 1.5))
            proc = subprocess.run(
                ytdlp_cmd() + [video_url],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=YTDLP_TIMEOUT_SEC,
            )
            stderr = proc.stderr.strip()
            if proc.returncode != 0 and "No module named yt_dlp" in stderr:
                raise MissingYtDlp(
                    "yt-dlp is not installed. Install it with: python -m pip install -U yt-dlp"
                )
            if proc.returncode != 0:
                raise RuntimeError(stderr or f"yt-dlp exited with code {proc.returncode}")
            lines = [line.strip() for line in proc.stdout.splitlines() if line.strip()]
            if not lines:
                raise RuntimeError("yt-dlp returned empty output")
            parsed = parse_print_line(lines[-1])
            if not parsed["handle"] and not parsed["channel_id"]:
                return {
                    "video_url": video_url,
                    "handle": "",
                    "channel_id": "",
                    "channel_name": parsed["channel_name"],
                    "view_count": parsed["view_count"] if parsed["view_count"] is not None else "",
                    "duration_sec": parsed["duration_sec"] if parsed["duration_sec"] is not None else "",
                    "upload_date": parsed["upload_date"],
                    "status": "deleted",
                    "checked_at": utc_now(),
                    "error": "missing channel metadata",
                }
            return {
                "video_url": video_url,
                "handle": parsed["handle"],
                "channel_id": parsed["channel_id"],
                "channel_name": parsed["channel_name"],
                "view_count": parsed["view_count"] if parsed["view_count"] is not None else "",
                "duration_sec": parsed["duration_sec"] if parsed["duration_sec"] is not None else "",
                "upload_date": parsed["upload_date"],
                "status": "ok",
                "checked_at": utc_now(),
            }
        except MissingYtDlp:
            raise
        except Exception as exc:  # noqa: BLE001 - retry once, then record and continue.
            last_error = exc
            if attempt == 0:
                time.sleep(random.uniform(1.0, 2.5))

    assert last_error is not None
    return {
        "video_url": video_url,
        "handle": "",
        "channel_id": "",
        "channel_name": "",
        "view_count": "",
        "duration_sec": "",
        "upload_date": "",
        "status": classify_error(last_error),
        "checked_at": utc_now(),
        "error": str(last_error)[0:500],
    }


def ordered_rows(results: dict[str, dict[str, Any]], input_order: list[str]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for url in input_order:
        row = results.get(url.lower())
        if not row:
            continue
        rows.append(row)
    return rows


def write_url_to_channel(rows: list[dict[str, Any]]) -> None:
    temp = URL_TO_CHANNEL_CSV.with_suffix(".csv.tmp")
    with temp.open("w", newline="", encoding="utf-8") as fp:
        writer = csv.DictWriter(fp, fieldnames=CSV_COLUMNS)
        writer.writeheader()
        for row in rows:
            writer.writerow({column: row.get(column, "") for column in CSV_COLUMNS})
    temp.replace(URL_TO_CHANNEL_CSV)


def write_handles(rows: list[dict[str, Any]]) -> None:
    seen: set[str] = set()
    handles: list[str] = []
    for row in rows:
        if row.get("status") != "ok":
            continue
        handle = str(row.get("handle") or row.get("channel_id") or "").strip()
        if not handle:
            continue
        key = handle.lower()
        if key in seen:
            continue
        seen.add(key)
        handles.append(handle)
    temp = HANDLES_FILE.with_suffix(".txt.tmp")
    temp.write_text("\n".join(handles) + ("\n" if handles else ""), encoding="utf-8")
    temp.replace(HANDLES_FILE)


def view_sort_key(row: dict[str, Any]) -> int:
    value = row.get("view_count")
    if isinstance(value, int):
        return value
    try:
        return int(str(value))
    except (TypeError, ValueError):
        return -1


def write_seed_ranked(rows: list[dict[str, Any]]) -> None:
    ranked = [row for row in rows if row.get("status") == "ok"]
    ranked.sort(key=view_sort_key, reverse=True)
    temp = SEED_RANKED_CSV.with_suffix(".csv.tmp")
    with temp.open("w", newline="", encoding="utf-8") as fp:
        writer = csv.DictWriter(fp, fieldnames=CSV_COLUMNS)
        writer.writeheader()
        for row in ranked:
            writer.writerow({column: row.get(column, "") for column in CSV_COLUMNS})
    temp.replace(SEED_RANKED_CSV)


def persist_outputs(results: dict[str, dict[str, Any]], input_order: list[str]) -> None:
    rows = ordered_rows(results, input_order)
    write_url_to_channel(rows)
    write_handles(rows)
    write_seed_ranked(rows)


def main() -> int:
    parser = argparse.ArgumentParser(description="Extract YouTube channel handles from video URLs.")
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="Process only the first N unique video URLs from input/video_urls.txt.",
    )
    args = parser.parse_args()

    setup_dirs()
    setup_logging()
    urls = load_video_urls(args.limit)
    if not urls:
        logging.info("No video URLs found in %s", VIDEO_URLS_FILE)
        persist_outputs({}, [])
        return 0

    existing = load_existing_rows()
    order = [url.lower() for url in urls]
    pending = [url for url in urls if url.lower() not in existing]
    total = len(urls)
    completed = len(urls) - len(pending)
    logging.info("Phase A-0 starting: total=%s pending=%s workers=%s", total, len(pending), MAX_WORKERS)

    consecutive_failures = 0
    processed_since_save = 0
    pending_iter = iter(pending)

    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
        futures = {}

        def submit_next() -> None:
            try:
                url = next(pending_iter)
            except StopIteration:
                return
            futures[executor.submit(extract_one, url)] = url

        for _ in range(MAX_WORKERS):
            submit_next()

        while futures:
            done, _ = wait(futures, return_when=FIRST_COMPLETED)
            for future in done:
                url = futures.pop(future)
                key = url.lower()
                try:
                    row = future.result()
                except MissingYtDlp as exc:
                    logging.error("%s", exc)
                    persist_outputs(existing, order)
                    return 2
                except Exception as exc:  # noqa: BLE001 - record and continue.
                    row = {
                        "video_url": url,
                        "handle": "",
                        "channel_id": "",
                        "channel_name": "",
                        "view_count": "",
                        "duration_sec": "",
                        "upload_date": "",
                        "status": classify_error(exc),
                        "checked_at": utc_now(),
                        "error": str(exc)[0:500],
                    }

                existing[key] = row
                completed += 1
                processed_since_save += 1
                label = row.get("handle") or row.get("channel_id") or row.get("status")
                logging.info("[%s/%s] %s -> %s", completed, total, url, label)

                if row.get("status") != "ok":
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
    logging.info("Phase A-0 complete. Wrote %s, %s, and %s", URL_TO_CHANNEL_CSV, HANDLES_FILE, SEED_RANKED_CSV)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
