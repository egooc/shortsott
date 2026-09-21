"""Stamp sampled frames with their source timecode and tile them into contact sheets.

A vision model reading a long source needs three things at once: enough frames to not miss a
beat, the time each frame came from, and the frames' order. Sending them as loose images with
the times listed in the prompt supplies none of it reliably - the model matches image N to line
N of the listing, and one dropped or reordered image shifts every description after it onto the
wrong window. On The Dictator that produced scene descriptions carrying character names the
prompt had explicitly forbidden, and the acceptance gate then rejected correct narration for
disagreeing with them.

Printing the timecode INTO each cell makes the mapping self-describing: the model quotes the
timecode it is looking at, and a shifted sheet is visible instead of silent. Tiling also gives
the model the neighbouring shots in one glance, which is what a cut needs to be read as a cut.

    python midform/scripts/build_contact_sheets.py --frames frames.json --out-dir sheets/
                                                   [--cols 5] [--rows 4] [--cell-width 448]

frames.json: [{"file": "...", "start_sec": 0.0, "end_sec": 4.0}, ...] in chronological order.

Writes sheet_000.jpg, sheet_001.jpg, ... and prints JSON describing what landed on each sheet,
so the caller can map a model's answer back to source time without re-deriving the layout.
"""

import argparse
import json
import os
import sys

from PIL import Image, ImageDraw, ImageFont

LABEL_HEIGHT = 26
LABEL_BG = (14, 14, 16)
LABEL_FG = (255, 214, 92)
SHEET_BG = (24, 24, 28)
GAP = 6


def timecode(seconds):
    seconds = max(0.0, float(seconds))
    hours = int(seconds // 3600)
    minutes = int((seconds % 3600) // 60)
    secs = seconds % 60
    if hours:
        return f"{hours:d}:{minutes:02d}:{secs:04.1f}"
    return f"{minutes:02d}:{secs:04.1f}"


def load_font(size):
    # DejaVu ships with Pillow; the Windows fonts directory is not guaranteed to hold a
    # readable TTF under every account.
    for candidate in ("DejaVuSans-Bold.ttf", "DejaVuSans.ttf", "arial.ttf"):
        try:
            return ImageFont.truetype(candidate, size)
        except Exception:
            continue
    return ImageFont.load_default()


def build_cell(frame, cell_width, font):
    image = Image.open(frame["file"]).convert("RGB")
    ratio = cell_width / max(1, image.width)
    cell_height = max(1, int(round(image.height * ratio)))
    image = image.resize((cell_width, cell_height))
    cell = Image.new("RGB", (cell_width, cell_height + LABEL_HEIGHT), LABEL_BG)
    cell.paste(image, (0, 0))
    label = f'{timecode(frame["start_sec"])}-{timecode(frame["end_sec"])}'
    draw = ImageDraw.Draw(cell)
    draw.text((6, cell_height + 4), label, fill=LABEL_FG, font=font)
    return cell, label


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--frames", required=True)
    parser.add_argument("--out-dir", required=True)
    parser.add_argument("--cols", type=int, default=5)
    parser.add_argument("--rows", type=int, default=4)
    parser.add_argument("--cell-width", type=int, default=448)
    args = parser.parse_args()

    with open(args.frames, "r", encoding="utf-8-sig") as handle:
        frames = json.load(handle)
    frames = [f for f in frames if isinstance(f, dict) and os.path.exists(str(f.get("file") or ""))]
    os.makedirs(args.out_dir, exist_ok=True)

    per_sheet = max(1, args.cols * args.rows)
    font = load_font(17)
    sheets = []
    for sheet_index, offset in enumerate(range(0, len(frames), per_sheet)):
        batch = frames[offset:offset + per_sheet]
        cells = []
        for frame in batch:
            try:
                cells.append((build_cell(frame, args.cell_width, font), frame))
            except Exception:
                continue
        if not cells:
            continue
        cell_w, cell_h = cells[0][0][0].size
        used_cols = min(args.cols, len(cells))
        used_rows = (len(cells) + args.cols - 1) // args.cols
        sheet = Image.new(
            "RGB",
            (used_cols * cell_w + (used_cols + 1) * GAP,
             used_rows * cell_h + (used_rows + 1) * GAP),
            SHEET_BG,
        )
        entries = []
        for index, ((cell, label), frame) in enumerate(cells):
            row, col = divmod(index, args.cols)
            sheet.paste(cell, (GAP + col * (cell_w + GAP), GAP + row * (cell_h + GAP)))
            entries.append({
                "cell": index + 1,
                "row": row + 1,
                "col": col + 1,
                "label": label,
                "start_sec": frame["start_sec"],
                "end_sec": frame["end_sec"],
            })
        out_path = os.path.join(args.out_dir, f"sheet_{sheet_index:03d}.jpg")
        sheet.save(out_path, quality=88)
        sheets.append({
            "file": out_path,
            "index": sheet_index,
            "cols": used_cols,
            "rows": used_rows,
            "cells": entries,
        })

    print(json.dumps({"sheets": sheets, "frames": len(frames)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.exit(main())
