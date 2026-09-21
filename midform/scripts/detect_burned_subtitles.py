"""Find the band a source video burns its own subtitles into.

Clip channels hard-burn their subtitles into the picture, so a recap that shows the frame
untouched ends up with two subtitle layers on screen: theirs and ours. TikTok flagged
20260904d-wardogs as reused content with that stacking visible (owner, 2026-09-05). Cropping
the band away removes the duplicate text AND the most obvious "this is someone else's upload"
signal in the frame.

    python midform/scripts/detect_burned_subtitles.py <video> [--json OUT] [--samples 48]

Output JSON:
    { detected, frames_sampled, frames_with_text, picture_top_ratio, picture_bottom_ratio,
      band_top_ratio, trim_bottom_ratio, confidence, reason }

`trim_top_ratio` / `trim_bottom_ratio` are the fractions of the FULL frame height to drop so
that the letterbox bars AND any burned-in subtitle band are gone. Both are 0.0 when there is
nothing to cut, so a caller can apply them unconditionally. `detected` refers to the subtitle
band specifically - a source with no burned-in dialogue can still return a bottom trim, because
clip channels print their copyright line inside the bar.

Detection, not a fixed ratio: the band sits at a different height in every source. War Dogs
(2.39:1 letterboxed inside 1920x1080) puts it at y=866..937 of 1080; a 16:9 source with no
letterbox puts it lower. A fixed trim either leaves text on screen or eats faces.
"""

import argparse
import json
import os
import subprocess
import sys
import tempfile

import numpy as np
from PIL import Image

# A subtitle glyph is near-white. 200 keeps antialiased edges out of the count without
# losing the stroke itself; the outline most clip channels use is darker than the fill.
BRIGHT = 200
# Letterbox rows are not pure black after compression.
LETTERBOX_MAX = 28
# A picture row lights up this share of its width. A line of credit text lights up far less,
# so the bar it sits in still reads as letterbox and gets cropped away with it.
LETTERBOX_MIN_SHARE = 0.20
# Subtitles are horizontally centred: ignore the outer 12% so a bright window or a channel
# bug in the corner cannot look like text.
SIDE_MARGIN = 0.12
# A subtitle row lights up this many central pixels. Measured on War Dogs: real subtitle rows
# ran 60-260, the brightest non-subtitle row in the same band ran 31.
MIN_BRIGHT_PIXELS = 60
# The band has to show up in enough frames to be a fixture rather than a bright prop.
MIN_FRAME_FRACTION = 0.15
# Glyph edges along one row. A word of six letters already clears this; a lit wall does not.
MIN_TRANSITIONS = 12
# A row joins the band only if it carried text in this share of the sampled frames.
MIN_ROW_FRACTION = 0.10
# Rows this close together belong to the same block - the gap between two subtitle lines.
MAX_ROW_GAP = 24
# Two lines of subtitle at 1080p, with the gap. Anything taller is not a subtitle block.
MAX_BAND_HEIGHT_ROWS = 130
# A burned-in band is in most frames. Below this the hits are scenery and graphics, and acting
# on them costs picture for nothing - The Dictator scored 0.19 and has no burned-in dialogue.
MIN_ACT_CONFIDENCE = 0.35
# Never eat more than this much of the frame, whatever the rows say.
MAX_TRIM_RATIO = 0.25
# Breathing room above the band so the descenders and the outline go too.
TOP_MARGIN_RATIO = 0.012


def sample_frames(video_path, out_dir, samples):
    """Even sampling across the whole file - subtitles are absent from action stretches, so a
    burst from one region can miss them entirely."""
    duration = probe_duration(video_path)
    if duration <= 0:
        return []
    fps = max(samples / duration, 0.02)
    subprocess.run(
        ["ffmpeg", "-y", "-i", video_path, "-vf", f"fps={fps}", "-frames:v", str(samples),
         os.path.join(out_dir, "f_%04d.png"), "-loglevel", "error"],
        check=False,
    )
    return sorted(
        os.path.join(out_dir, name) for name in os.listdir(out_dir) if name.endswith(".png")
    )


def probe_duration(video_path):
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=nw=1:nk=1", video_path],
            capture_output=True, text=True, check=False,
        ).stdout
        return float(str(out).strip())
    except Exception:
        return 0.0


def analyze(frame_paths):
    """Score every row for "this looks like a line of text", then keep only the rows that score
    across many frames.

    Brightness alone does not separate a subtitle from a lit wall or a sky - the first pass of
    this detector asked for bright central pixels and proposed cropping 42% of War Dogs, because
    the brightest rows inside the search window were scenery. Two properties do separate them.
    Glyphs alternate bright and dark many times along a row, where lit scenery is a smooth run;
    and a burned-in band sits at the SAME rows frame after frame, where scenery moves.
    """
    picture_tops = []
    picture_bottoms = []
    picture_lefts = []
    picture_rights = []
    height = 0
    width = 0
    row_text_hits = None
    frames_with_text = 0

    for path in frame_paths:
        try:
            gray = np.asarray(Image.open(path).convert("L"), dtype=np.float32)
        except Exception:
            continue
        height, width = gray.shape
        if row_text_hits is None:
            row_text_hits = np.zeros(height, dtype=np.int32)
        # Letterbox by AREA, not by max: a copyright line printed in the black bar makes its
        # rows "lit" under a max test, so the picture edge lands below the text and the bar
        # (with the credit in it) survives the crop. The Dictator carries
        # "(c) 2012 Paramount Pictures. All Rights Reserved" that way in every frame.
        bright_mask = gray > LETTERBOX_MAX
        lit_share = bright_mask.sum(axis=1) / max(1, gray.shape[1])
        lit = np.where(lit_share > LETTERBOX_MIN_SHARE)[0]
        if not len(lit):
            continue
        picture_top, picture_bottom = int(lit[0]), int(lit[-1])
        picture_tops.append(picture_top)
        picture_bottoms.append(picture_bottom)
        # Pillarbox as well as letterbox. The Dictator is a 1920x1080 file with the film in a
        # centred box on all four sides; trimming only top and bottom leaves the side bars in
        # frame AND computes the portrait fill against a width that is part black, which scales
        # the subject down by exactly the width of the bars.
        col_share = bright_mask.sum(axis=0) / max(1, gray.shape[0])
        lit_cols = np.where(col_share > LETTERBOX_MIN_SHARE)[0]
        if len(lit_cols):
            picture_lefts.append(int(lit_cols[0]))
            picture_rights.append(int(lit_cols[-1]))

        centre = gray[:, int(width * SIDE_MARGIN):int(width * (1 - SIDE_MARGIN))] > BRIGHT
        centre_width = max(1, centre.shape[1])
        counts = centre.sum(axis=1)
        # Bright->dark boundaries along the row: one per glyph edge. A word gives tens of them,
        # a lit wall gives one or two.
        transitions = np.abs(np.diff(centre.astype(np.int8), axis=1)).sum(axis=1)
        texty = (
            (counts >= MIN_BRIGHT_PIXELS)
            & (counts <= centre_width * 0.6)   # a full-width bright row is a flash, not a line
            & (transitions >= MIN_TRANSITIONS)
        )
        picture_height = max(1, picture_bottom - picture_top)
        search_from = picture_top + int(picture_height * 0.5)
        window = np.zeros(height, dtype=bool)
        window[search_from:picture_bottom + 1] = True
        hits = texty & window
        if hits.any():
            frames_with_text += 1
            row_text_hits[hits] += 1

    result = {
        "frames_sampled": len(frame_paths),
        "frames_with_text": frames_with_text,
        "frame_height": int(height),
        "detected": False,
        "picture_top_ratio": 0.0,
        "picture_bottom_ratio": 1.0,
        "picture_left_ratio": 0.0,
        "picture_right_ratio": 1.0,
        "trim_left_ratio": 0.0,
        "trim_right_ratio": 0.0,
        "band_top_ratio": 0.0,
        "trim_bottom_ratio": 0.0,
        "confidence": 0.0,
        "reason": "",
    }
    if not frame_paths or not height:
        result["reason"] = "no frames sampled"
        return result
    if picture_tops:
        picture_top = float(np.median(picture_tops))
        picture_bottom = float(np.median(picture_bottoms))
        result["picture_top_ratio"] = round(picture_top / height, 4)
        result["picture_bottom_ratio"] = round(picture_bottom / height, 4)
        # The bars themselves are free to cut - they are black, and any credit line printed in
        # them goes with them. This applies whether or not a subtitle band is found.
        result["trim_top_ratio"] = round(min(picture_top / height, MAX_TRIM_RATIO), 4)
        result["letterbox_bottom_ratio"] = round(
            min(max(0.0, (height - 1 - picture_bottom) / height), MAX_TRIM_RATIO), 4)
        result["trim_bottom_ratio"] = result["letterbox_bottom_ratio"]
    if picture_lefts and width:
        picture_left = float(np.median(picture_lefts))
        picture_right = float(np.median(picture_rights))
        result["picture_left_ratio"] = round(picture_left / width, 4)
        result["picture_right_ratio"] = round(picture_right / width, 4)
        result["trim_left_ratio"] = round(min(picture_left / width, MAX_TRIM_RATIO), 4)
        result["trim_right_ratio"] = round(
            min(max(0.0, (width - 1 - picture_right) / width), MAX_TRIM_RATIO), 4)

    fraction = frames_with_text / len(frame_paths)
    result["confidence"] = round(fraction, 3)
    if fraction < MIN_FRAME_FRACTION:
        result["reason"] = f"text in {frames_with_text}/{len(frame_paths)} frames - below fixture threshold"
        return result

    # A row belongs to the band when it carried text in a real share of the sampled frames.
    # Scenery never repeats on the same row often enough to clear this.
    need = max(2, int(len(frame_paths) * MIN_ROW_FRACTION))
    band_rows = np.where(row_text_hits >= need)[0]
    if not len(band_rows):
        result["reason"] = "text rows never repeated at a fixed height - no burned-in band"
        return result

    # Keep the lowest contiguous group: a two-line subtitle is one group, a caption plus a
    # channel watermark higher up is two, and only the subtitle block matters.
    groups = np.split(band_rows, np.where(np.diff(band_rows) > MAX_ROW_GAP + 1)[0] + 1)
    band = groups[-1]

    # Reach upward for the SECOND line. A two-line subtitle shows its upper line only on the
    # long sentences, so those rows clear a lower bar than the always-present bottom line -
    # on War Dogs the first pass stopped at row 897 and would have left "who owned a boxing and
    # storage company" on screen above the cut.
    weak = max(2, int(len(frame_paths) * MIN_ROW_FRACTION * 0.35))
    top = int(band[0])
    reach = MAX_ROW_GAP * 2
    # Subtitles are one or two lines. Without a stop the reach walks up through every bright
    # graphic in the shot - on The Dictator it climbed from row 820 to 662 and proposed cutting
    # 40% of the frame for a band that was one row of a news-ticker graphic.
    floor_row = max(0, int(band[-1]) - MAX_BAND_HEIGHT_ROWS)
    while top > floor_row:
        window_start = max(floor_row, top - reach)
        above = np.where(row_text_hits[window_start:top] >= weak)[0]
        if not len(above):
            break
        top = window_start + int(above[0])
    band_top = float(top)
    result["band_bottom_ratio"] = round(float(band[-1]) / height, 4)
    cut_from = band_top - height * TOP_MARGIN_RATIO
    cut_from = max(0.0, min(cut_from, float(height)))
    trim = max(0.0, (height - cut_from) / height)
    if fraction < MIN_ACT_CONFIDENCE:
        result["band_top_ratio"] = round(band_top / height, 4)
        result["reason"] = (f"band rows {int(band[0])}-{int(band[-1])} in only "
                            f"{frames_with_text}/{len(frame_paths)} frames - not a fixture, no trim")
        return result
    if trim > MAX_TRIM_RATIO:
        result["band_top_ratio"] = round(band_top / height, 4)
        result["reason"] = (f"proposed trim {trim:.2f} over the {MAX_TRIM_RATIO} cap - "
                            f"detection is not trustworthy, no trim")
        return result
    result["detected"] = True
    result["band_top_ratio"] = round(band_top / height, 4)
    # Whichever reaches higher wins: on a letterboxed source the bar is often the deeper cut,
    # and cutting to the band alone would leave the bar (and its credit line) on screen.
    result["trim_bottom_ratio"] = round(min(max(trim, result["letterbox_bottom_ratio"]),
                                            MAX_TRIM_RATIO), 4)
    result["reason"] = (f"subtitle band rows {int(band[0])}-{int(band[-1])} of {height}, "
                        f"text in {frames_with_text}/{len(frame_paths)} frames")
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("video")
    parser.add_argument("--json", default="")
    parser.add_argument("--samples", type=int, default=48)
    args = parser.parse_args()

    if not os.path.exists(args.video):
        print(json.dumps({"detected": False, "reason": "video not found"}, ensure_ascii=False))
        return 2

    with tempfile.TemporaryDirectory(prefix="burnedsubs_") as tmp:
        frames = sample_frames(args.video, tmp, max(8, args.samples))
        result = analyze(frames)

    result["video"] = args.video
    text = json.dumps(result, ensure_ascii=False, indent=2)
    if args.json:
        os.makedirs(os.path.dirname(os.path.abspath(args.json)) or ".", exist_ok=True)
        with open(args.json, "w", encoding="utf-8") as handle:
            handle.write(text + "\n")
    print(text)
    return 0


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.exit(main())
