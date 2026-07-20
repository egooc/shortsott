#!/usr/bin/env python3
"""Stage 1 lightweight YouTube channel verification.

Reads input/handles.txt and writes output/stage1_result.json.
Only metadata is requested through yt-dlp; videos are never downloaded.
"""

from __future__ import annotations

import json
import logging
import os
import random
import re
import shutil
import subprocess
import sys
import time
from argparse import ArgumentParser
from collections import Counter
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from csv import DictReader
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from urllib.parse import urlparse, urlunparse


SCRIPT_DIR = Path(__file__).resolve().parent
MIDFORM_DIR = SCRIPT_DIR.parent
INPUT_FILE = SCRIPT_DIR / "input" / "handles.txt"
OUTPUT_DIR = SCRIPT_DIR / "output"
OUTPUT_FILE = OUTPUT_DIR / "stage1_result.json"
SEED_FILE = OUTPUT_DIR / "seed_videos_ranked.csv"
LOG_DIR = MIDFORM_DIR / "logs"
LOG_FILE = LOG_DIR / "phase_a_verify_light.log"

MAX_WORKERS = max(1, min(8, int(os.environ.get("VERIFY_LIGHT_WORKERS", "6"))))
CHECKPOINT_EVERY = 100
ACTIVE_DAYS = 90
MIN_VIDEO_COUNT = 10
YTDLP_TIMEOUT_SEC = int(os.environ.get("YTDLP_TIMEOUT_SEC", "90"))
SEED_TOP_N = int(os.environ.get("VERIFY_LIGHT_SEED_TOP_N", "50"))
SCALE_PLAYLIST_END = 501


class MissingYtDlp(RuntimeError):
    pass


def setup_dirs() -> None:
    (SCRIPT_DIR / "input").mkdir(parents=True, exist_ok=True)
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    LOG_DIR.mkdir(parents=True, exist_ok=True)


def setup_logging() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        handlers=[
            logging.StreamHandler(sys.stdout),
            logging.FileHandler(LOG_FILE, encoding="utf-8"),
        ],
    )


def parse_args() -> Any:
    parser = ArgumentParser(description="Lightweight YouTube channel verification")
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="Verify only the first N handles from input/handles.txt.",
    )
    parser.add_argument(
        "--refresh-status",
        action="append",
        default=[],
        help="Re-check existing rows with this status. Can be passed multiple times.",
    )
    return parser.parse_args()


def utc_now() -> datetime:
    return datetime.now(UTC)


def clean_input_line(line: str) -> str | None:
    value = line.strip()
    if not value or value.startswith("#"):
        return None
    return value


def normalize_handle(raw: str) -> str:
    raw = raw.strip()
    if raw.startswith("@"):
        return raw
    if re.fullmatch(r"UC[\w-]{20,}", raw):
        return raw
    if not raw.lower().startswith(("http://", "https://")):
        return f"@{raw.lstrip('@')}"

    parsed = urlparse(raw)
    path_parts = [part for part in parsed.path.split("/") if part]
    for part in path_parts:
        if part.startswith("@"):
            return part
    cleaned = parsed._replace(query="", fragment="")
    return urlunparse(cleaned).rstrip("/")


def channel_videos_url(handle: str) -> str:
    if handle.startswith("@"):
        return f"https://www.youtube.com/{handle}/videos"
    if re.fullmatch(r"UC[\w-]{20,}", handle):
        return f"https://www.youtube.com/channel/{handle}/videos"
    if handle.lower().startswith(("http://", "https://")):
        base = handle.rstrip("/")
        if base.endswith("/videos"):
            return base
        return f"{base}/videos"
    return f"https://www.youtube.com/@{handle.lstrip('@')}/videos"


def ytdlp_base_cmd(single_json: bool = True) -> list[str]:
    module_cmd = [sys.executable, "-m", "yt_dlp"]
    executable = shutil.which("yt-dlp") or shutil.which("yt-dlp.exe")
    if executable:
        # Prefer the executable when present because it also works in zipapp installs.
        cmd = [executable]
    else:
        cmd = module_cmd
    cmd.extend(
        [
            "--skip-download",
            "--no-warnings",
            "--ignore-no-formats-error",
            "--socket-timeout",
            "20",
            "--extractor-retries",
            "2",
        ]
    )
    cmd.append("--dump-single-json" if single_json else "--dump-json")
    return cmd


def run_ytdlp(args: list[str], timeout: int = YTDLP_TIMEOUT_SEC) -> dict[str, Any]:
    time.sleep(random.uniform(0.5, 1.5))
    cmd = ytdlp_base_cmd() + args
    proc = subprocess.run(
        cmd,
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
        raise RuntimeError(stderr or f"yt-dlp exited with code {proc.returncode}")
    stdout = proc.stdout.strip()
    if not stdout:
        raise RuntimeError("yt-dlp returned empty output")
    return json.loads(stdout)


def load_handles() -> list[dict[str, str]]:
    if not INPUT_FILE.exists():
        INPUT_FILE.write_text(
            "# Add one YouTube channel handle or URL per line.\n", encoding="utf-8"
        )
    items: list[dict[str, str]] = []
    seen: set[str] = set()
    for line in INPUT_FILE.read_text(encoding="utf-8").splitlines():
        raw = clean_input_line(line)
        if raw is None:
            continue
        handle = normalize_handle(raw)
        key = handle.lower()
        if key in seen:
            continue
        seen.add(key)
        items.append({"raw": raw, "handle": handle, "url": channel_videos_url(handle)})
    return items


def load_existing() -> dict[str, dict[str, Any]]:
    if not OUTPUT_FILE.exists():
        return {}
    try:
        data = json.loads(OUTPUT_FILE.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        backup = OUTPUT_FILE.with_suffix(f".json.broken-{int(time.time())}")
        OUTPUT_FILE.replace(backup)
        logging.warning("Invalid existing JSON moved to %s", backup)
        return {}

    rows: list[dict[str, Any]]
    if isinstance(data, list):
        rows = data
    elif isinstance(data, dict) and isinstance(data.get("results"), list):
        rows = data["results"]
    elif isinstance(data, dict) and "handle" in data:
        rows = [data]
    else:
        rows = []
    return {str(row.get("handle", "")).lower(): row for row in rows if row.get("handle")}


def save_results(results: dict[str, dict[str, Any]], input_order: list[str]) -> None:
    ordered = []
    for key in input_order:
        if key not in results:
            continue
        row = results[key]
        ordered.append(
            {
                "handle": row.get("handle"),
                "status": row.get("status"),
                "video_count": int(row.get("video_count") or 0),
                "last_upload": row.get("last_upload"),
            }
        )
    temp = OUTPUT_FILE.with_suffix(".json.tmp")
    temp.write_text(json.dumps(ordered, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temp.replace(OUTPUT_FILE)


def load_seed_top_handles(limit: int = SEED_TOP_N) -> list[str]:
    if not SEED_FILE.exists():
        return []
    handles: list[str] = []
    seen: set[str] = set()
    with SEED_FILE.open("r", encoding="utf-8-sig", newline="") as handle:
        for row in DictReader(handle):
            raw = row.get("handle")
            if not raw:
                continue
            normalized = normalize_handle(raw)
            key = normalized.lower()
            if key in seen:
                continue
            seen.add(key)
            handles.append(normalized)
            if len(handles) >= limit:
                break
    return handles


def print_summary(results: dict[str, dict[str, Any]], input_order: list[str], elapsed_sec: float) -> None:
    rows = [results[key] for key in input_order if key in results]
    status_counts = Counter(str(row.get("status") or "unknown") for row in rows)
    pass_rows = [row for row in rows if row.get("status") == "pass"]

    dist = Counter()
    for row in pass_rows:
        count = int(row.get("video_count") or 0)
        if count < 50:
            dist["10~50"] += 1
        elif count < 200:
            dist["50~200"] += 1
        elif count < 500:
            dist["200~500"] += 1
        else:
            dist["500+"] += 1

    recent_pass = sorted(
        [row for row in pass_rows if row.get("last_upload")],
        key=lambda row: str(row.get("last_upload")),
        reverse=True,
    )[:20]

    seed_top = load_seed_top_handles()
    seed_top_keys = {handle.lower(): index + 1 for index, handle in enumerate(seed_top)}
    lost_seed_rows = [
        row
        for row in rows
        if row.get("status") in {"unreachable", "deleted"}
        and str(row.get("handle", "")).lower() in seed_top_keys
    ]
    lost_seed_rows.sort(key=lambda row: seed_top_keys[str(row.get("handle", "")).lower()])

    logging.info("----- Stage 1 Summary -----")
    for status in ("pass", "inactive", "too_small", "unreachable", "deleted"):
        logging.info("%s: %s", status, status_counts.get(status, 0))
    logging.info("Pass video count distribution:")
    logging.info("10~50: %s", dist.get("10~50", 0))
    logging.info("50~200: %s", dist.get("50~200", 0))
    logging.info("200~500: %s", dist.get("200~500", 0))
    logging.info("500+: %s", dist.get("500+", 0))
    logging.info("Top 20 pass handles by latest upload:")
    for index, row in enumerate(recent_pass, start=1):
        logging.info(
            "%02d. %s last_upload=%s video_count=%s",
            index,
            row.get("handle"),
            row.get("last_upload"),
            row.get("video_count"),
        )
    logging.info("Elapsed: %.1f seconds", elapsed_sec)
    if lost_seed_rows:
        logging.warning(
            "Unreachable/deleted handles found in top %s seed_videos_ranked.csv handles:",
            SEED_TOP_N,
        )
        for row in lost_seed_rows:
            rank = seed_top_keys[str(row.get("handle", "")).lower()]
            logging.warning(
                "rank=%s handle=%s status=%s",
                rank,
                row.get("handle"),
                row.get("status"),
            )
    else:
        logging.info(
            "No unreachable/deleted handles found in top %s seed_videos_ranked.csv handles.",
            SEED_TOP_N,
        )


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


def entry_upload_date(entry: dict[str, Any]) -> str | None:
    for key in ("upload_date", "timestamp", "release_timestamp", "date"):
        parsed = parse_upload_date(entry.get(key))
        if parsed:
            return parsed
    return None


def latest_upload_from_entries(entries: list[dict[str, Any]]) -> str | None:
    dates = [entry_upload_date(entry) for entry in entries]
    valid = [value for value in dates if value]
    return max(valid) if valid else None


def entry_to_video_url(entry: dict[str, Any]) -> str | None:
    url = entry.get("webpage_url") or entry.get("url") or entry.get("id")
    if not url:
        return None
    text = str(url)
    if text.startswith("http"):
        return text
    if re.fullmatch(r"[\w-]{11}", text):
        return f"https://www.youtube.com/watch?v={text}"
    return None


def fetch_latest_dates(entries: list[dict[str, Any]], limit: int = 5) -> list[str]:
    dates: list[str] = []
    for entry in entries[:limit]:
        video_url = entry_to_video_url(entry)
        if not video_url:
            continue
        try:
            info = run_ytdlp(["--no-playlist", video_url], timeout=60)
        except Exception as exc:  # noqa: BLE001 - keep channel verification moving.
            logging.debug("Latest video detail failed for %s: %s", video_url, exc)
            continue
        date = entry_upload_date(info)
        if date:
            dates.append(date)
    return dates


def fetch_video_count_scale(url: str) -> int | None:
    try:
        info = run_ytdlp(["--flat-playlist", "--playlist-end", str(SCALE_PLAYLIST_END), url])
    except Exception as exc:  # noqa: BLE001 - scale is useful, not required for status.
        logging.debug("Scale count failed for %s: %s", url, exc)
        return None
    entries = [entry for entry in info.get("entries", []) if entry]
    playlist_count = info.get("playlist_count") or info.get("n_entries")
    if playlist_count:
        try:
            return int(playlist_count)
        except (TypeError, ValueError):
            pass
    return len(entries)


def classify_error(error: Exception) -> str:
    text = str(error).lower()
    if "does not have a videos tab" in text:
        return "too_small"
    deleted_markers = [
        "terminated",
        "does not exist",
        "not found",
        "unavailable",
        "account has been closed",
        "channel was not found",
        "404",
    ]
    if any(marker in text for marker in deleted_markers):
        return "deleted"
    return "unreachable"


def verify_one(item: dict[str, str]) -> dict[str, Any]:
    handle = item["handle"]
    url = item["url"]
    result: dict[str, Any] = {
        "handle": handle,
        "status": "unreachable",
        "video_count": 0,
        "last_upload": None,
        "url": url,
        "checked_at": utc_now().isoformat(timespec="seconds"),
    }

    last_error: Exception | None = None
    for attempt in range(2):
        try:
            info = run_ytdlp(["--flat-playlist", "--playlist-end", "30", url])
            entries = [entry for entry in info.get("entries", []) if entry]
            playlist_count = info.get("playlist_count") or info.get("n_entries")
            video_count = int(playlist_count) if playlist_count else len(entries)
            last_upload = latest_upload_from_entries(entries)
            if not last_upload and entries:
                detail_dates = fetch_latest_dates(entries)
                if detail_dates:
                    last_upload = max(detail_dates)

            result["video_count"] = video_count
            result["last_upload"] = last_upload
            if video_count < MIN_VIDEO_COUNT:
                result["status"] = "too_small"
            elif not last_upload:
                result["status"] = "inactive"
                result["note"] = "last_upload_unknown"
            else:
                cutoff = (utc_now() - timedelta(days=ACTIVE_DAYS)).date().isoformat()
                result["status"] = "pass" if last_upload >= cutoff else "inactive"
            if result["status"] == "pass" and video_count >= 30:
                scale_count = fetch_video_count_scale(url)
                if scale_count is not None:
                    result["video_count"] = scale_count
            return result
        except MissingYtDlp:
            raise
        except Exception as exc:  # noqa: BLE001 - retry once, then record status.
            last_error = exc
            if attempt == 0:
                time.sleep(random.uniform(1.0, 2.5))

    assert last_error is not None
    result["status"] = classify_error(last_error)
    result["error"] = str(last_error)[0:500]
    return result


def main() -> int:
    args = parse_args()
    started_at = time.monotonic()
    setup_dirs()
    setup_logging()
    handles = load_handles()
    if args.limit is not None:
        if args.limit < 1:
            logging.error("--limit must be 1 or greater")
            return 2
        handles = handles[: args.limit]
    if not handles:
        logging.info("No handles found in %s", INPUT_FILE)
        return 0

    existing = load_existing()
    order = [item["handle"].lower() for item in handles]
    refresh_statuses = {status.lower() for status in args.refresh_status}
    pending = [
        item
        for item in handles
        if item["handle"].lower() not in existing
        or str(existing[item["handle"].lower()].get("status", "")).lower() in refresh_statuses
    ]
    total = len(handles)
    completed = len(handles) - len(pending)

    for item in handles:
        row = existing.get(item["handle"].lower())
        if row and item not in pending:
            logging.info("[%s/%s] %s -> SKIP %s", completed, total, item["handle"], row.get("status"))

    logging.info("Stage 1 starting: total=%s pending=%s workers=%s", total, len(pending), MAX_WORKERS)
    consecutive_failures = 0
    processed_since_save = 0
    pending_iter = iter(pending)

    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
        futures = {}

        def submit_next() -> None:
            try:
                item = next(pending_iter)
            except StopIteration:
                return
            futures[executor.submit(verify_one, item)] = item

        for _ in range(MAX_WORKERS):
            submit_next()

        while futures:
            done, _ = wait(futures, return_when=FIRST_COMPLETED)
            for future in done:
                item = futures.pop(future)
                try:
                    row = future.result()
                except MissingYtDlp as exc:
                    logging.error("%s", exc)
                    save_results(existing, order)
                    return 2
                except Exception as exc:  # noqa: BLE001 - record and continue.
                    row = {
                        "handle": item["handle"],
                        "status": classify_error(exc),
                        "video_count": 0,
                        "last_upload": None,
                        "url": item["url"],
                        "checked_at": utc_now().isoformat(timespec="seconds"),
                        "error": str(exc)[0:500],
                    }

                existing[item["handle"].lower()] = row
                completed += 1
                processed_since_save += 1
                status = str(row.get("status", "unknown")).upper()
                logging.info("[%s/%s] %s -> %s", completed, total, item["handle"], status)

                if row.get("status") in {"unreachable", "deleted"}:
                    consecutive_failures += 1
                else:
                    consecutive_failures = 0
                if consecutive_failures >= 10:
                    logging.warning("10 consecutive failures detected. Sleeping 60 seconds before resuming.")
                    save_results(existing, order)
                    time.sleep(60)
                    consecutive_failures = 0

                if processed_since_save >= CHECKPOINT_EVERY:
                    save_results(existing, order)
                    processed_since_save = 0

                submit_next()

    save_results(existing, order)
    logging.info("Stage 1 complete. Wrote %s", OUTPUT_FILE)
    print_summary(existing, order, time.monotonic() - started_at)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
