#!/usr/bin/env python3
"""Optional YouTube download fallback using pytubefix.

This script is intentionally optional. The Node service calls it only after
yt-dlp attempts fail, and it exits with a clear JSON error if pytubefix is not
installed in the active Python environment.
"""

import argparse
import json
import os
import sys
from pathlib import Path


def fail(code, message, **details):
    print(json.dumps({
        "ok": False,
        "code": code,
        "message": message,
        "details": details,
    }, ensure_ascii=False))
    return 1


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    try:
        from pytubefix import YouTube
    except Exception as exc:
        return fail(
            "PYTUBEFIX_NOT_INSTALLED",
            "pytubefix is not installed. Install it only if you want the optional fallback.",
            error=str(exc),
        )

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    try:
        yt = YouTube(args.url)
        stream = (
            yt.streams
            .filter(progressive=True, file_extension="mp4")
            .order_by("resolution")
            .desc()
            .first()
        )
        if stream is None:
            stream = (
                yt.streams
                .filter(file_extension="mp4")
                .order_by("resolution")
                .desc()
                .first()
            )
        if stream is None:
            return fail("PYTUBEFIX_NO_MP4_STREAM", "No MP4 stream was available.")

        temp_name = f"{output_path.stem}.pytubefix.mp4"
        downloaded = Path(stream.download(output_path=str(output_path.parent), filename=temp_name))
        if output_path.exists():
            output_path.unlink()
        os.replace(downloaded, output_path)

        print(json.dumps({
            "ok": True,
            "method": "pytubefix",
            "output": str(output_path),
            "title": yt.title,
        }, ensure_ascii=False))
        return 0
    except Exception as exc:
        return fail("PYTUBEFIX_DOWNLOAD_FAILED", "pytubefix failed to download the video.", error=str(exc))


if __name__ == "__main__":
    sys.exit(main())
