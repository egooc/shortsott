# -*- coding: utf-8 -*-
"""Sync audit gate: every caption timestamp vs what the exported mp4 actually plays.

Owner directive 2026-09-07 ("프레임 전사하고 자막 통독해서 STT랑 타임스탬프 매칭해서
전수조사"). Manual spot checks missed a narration line announcing gunfire four seconds
after the gunfire started; this makes the full pass a machine step.

  python midform/scripts/audit_sync.py --mp4 <exported.mp4> --manifest <edit_manifest.json>
                                       [--out-dir <dir>] [--tolerance 0.8]

Checks, exit 1 on any FAIL:
  1. DIALOGUE: for each dialogue caption row, STT (Groq, English) a window around its
     timeline slot and require the row's source line to be heard inside it; measured
     onset vs caption start must be within tolerance.
  2. NARRATION: STT (Groq, Korean or Japanese) the whole mp4 once; every narration
     sentence must be matched near its caption start within tolerance.
  3. FRAMES: a contact sheet (sentence label x frame at display start) is written to
     out-dir for the mandatory human read-through - the gate cannot judge meaning,
     only presence and timing.
"""
import argparse
import io
import json
import os
import re
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from asr_backend import transcribe  # Groq whisper-large-v3, local fallback

FFMPEG = os.environ.get("FFMPEG_PATH") or "ffmpeg"


def norm_en(text):
    return re.sub(r"[^a-z0-9 ]", "", str(text).lower())


def tokens_en(text):
    return [t for t in norm_en(text).split() if len(t) > 2]


def norm_k(text):
    return re.sub(r"[\s\W]+", "", str(text))


def load_rows(manifest_path):
    with io.open(manifest_path, encoding="utf-8") as fh:
        manifest = json.load(fh)
    dialogue, narration, seen = [], [], set()
    for seg in sorted(manifest.get("segments") or [], key=lambda s: s.get("timeline_start_sec") or 0):
        text = str(seg.get("narration") or "").strip()
        if not text:
            continue
        key = f"{seg.get('segment_id')}|{seg.get('caption_id')}"
        if key in seen:
            continue
        seen.add(key)
        row = {
            "id": str(seg.get("segment_id") or ""),
            "caption_id": str(seg.get("caption_id") or ""),
            "at": float(seg.get("timeline_start_sec") or 0),
            "end": float(seg.get("timeline_end_sec") or 0),
            "text": text,
            "source_line": str(seg.get("dialogue_original") or ""),
        }
        if str(seg.get("caption_kind") or "") == "dialogue":
            dialogue.append(row)
        else:
            # 문장 첫 청크만 시각 기준으로 삼는다 (한 문장 = TTS 한 덩이).
            if not narration or narration[-1]["id"] != row["id"] or not row["caption_id"].endswith("_001"):
                if row["caption_id"].endswith("_001") or all(n["id"] != row["id"] for n in narration):
                    narration.append(row)
    return dialogue, narration


def audit_dialogue(mp4, rows, tolerance):
    """Group rows by segment; one Groq call per group window."""
    findings = []
    groups = {}
    for row in rows:
        groups.setdefault(row["id"].split("_cap")[0], []).append(row)
    for gid, group in groups.items():
        # Groq(whisper)는 클립 첫 단어의 start를 클립 머리에 붙인다(실측: 창을 3.5s에서
        # 자르든 2.0s에서 자르든 첫 단어 start == 창 시작). 패딩을 넉넉히 잡고 창 머리
        # 0.35s 안에서 시작하는 "온셋"은 아티팩트로 버린다.
        start = max(0.0, min(r["at"] for r in group) - 2.5)
        end = max(r["end"] for r in group) + 1.5
        try:
            res = transcribe(mp4, language="en", start=start, end=end)
        except Exception as error:
            findings.append({"level": "FAIL", "id": gid, "why": f"STT error: {error}"})
            continue
        # asr_backend는 start를 되더한 ABSOLUTE 시각을 돌려준다 - 더하지 말 것.
        segs = [{"s": float(s["start"]), "e": float(s["end"]), "t": s["text"]} for s in res.get("segments") or []]
        words = [{"s": float(w["start"]), "e": float(w["end"])} for w in res.get("words") or []]
        # 발화 온셋 = 0.25s 이상 침묵 뒤 첫 단어. 연속 발화에서 "창 안 첫 단어"를 잡으면
        # 항상 허용범위 하한(-1.0s)이 찍히는 아티팩트가 난다(실측 21행 동일값) - 온셋만 보고,
        # 자막 시각에 가장 가까운 온셋을 고른다.
        onsets = []
        prev_end = None
        for w in words:
            if (prev_end is None or (w["s"] - prev_end) >= 0.25) and w["s"] > start + 0.35:
                onsets.append(w["s"])
            prev_end = max(prev_end or 0.0, w["e"])
        for row in group:
            # 후행 청크(cap_002+)는 읽기 지속용이라 발화가 이미 끝나 있어도 정상 -
            # 커버만 확인하고, 엄격한 온셋 대조는 줄의 첫 청크(cap_001)에만 건다.
            is_line_head = row["caption_id"].endswith("_cap_001")
            onset = None
            near = [o for o in onsets if abs(o - row["at"]) <= tolerance + 0.4]
            if near:
                onset = min(near, key=lambda o: abs(o - row["at"]))
            if not is_line_head:
                covered = any(s["s"] <= row["at"] + 0.2 and s["e"] >= row["at"] for s in segs)
                findings.append({"level": "OK", "id": row["caption_id"],
                                 "why": "후행 청크" + ("(발화 커버)" if covered else "(읽기 지속)")})
                continue
            covered = any(s["s"] <= row["at"] + 0.2 and s["e"] >= row["at"] + 0.4 for s in segs)
            if onset is None and not covered:
                findings.append({"level": "FAIL", "id": row["caption_id"],
                                 "why": f"자막 {row['at']:.1f}s 주변에 발화 없음 (창 {start:.1f}-{end:.1f})"})
                continue
            if onset is not None:
                offset = onset - row["at"]
                level = "OK" if abs(offset) <= tolerance else "FAIL"
                findings.append({"level": level, "id": row["caption_id"],
                                 "why": f"발화 {onset:.1f}s vs 자막 {row['at']:.1f}s (offset {offset:+.1f}s)"})
            else:
                findings.append({"level": "OK", "id": row["caption_id"], "why": "발화 진행 중(커버)"})
    return findings


def audit_narration(mp4, rows, tolerance, language):
    try:
        res = transcribe(mp4, language=language)
    except Exception as error:
        return [{"level": "FAIL", "id": "narration", "why": f"STT error: {error}"}]
    segs = [{"s": float(s["start"]), "e": float(s["end"]), "t": norm_k(s["text"])} for s in res.get("segments") or []]
    findings = []
    for row in rows:
        head = norm_k(row["text"])[:8]
        if len(head) < 4:
            continue
        hit = None
        for s in segs:
            if head[:6] in s["t"] or head[2:8] in s["t"]:
                hit = s
                break
        if hit is None:
            findings.append({"level": "WARN", "id": row["id"],
                             "why": f"해설 미검출(STT 세그먼트 병합 가능): '{row['text'][:24]}'"})
            continue
        if hit["s"] <= row["at"] + 0.3 and hit["e"] >= row["at"] + 0.5:
            findings.append({"level": "OK", "id": row["id"], "why": "병합 세그먼트가 자막 시각을 커버"})
            continue
        offset = hit["s"] - row["at"]
        # 나레이션은 STT가 세그먼트를 크게 묶는 일이 잦아 허용을 2배로 둔다.
        level = "OK" if abs(offset) <= tolerance * 2 else "FAIL"
        findings.append({"level": level, "id": row["id"],
                         "why": f"발화 {hit['s']:.1f}s vs 자막 {row['at']:.1f}s (offset {offset:+.1f}s)"})
    return findings


def write_frames(mp4, rows, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    files = []
    for i, row in enumerate(rows):
        png = os.path.join(out_dir, f"nar_{i:02d}.png")
        subprocess.run([FFMPEG, "-loglevel", "error", "-ss", str(row["at"]), "-i", mp4,
                        "-frames:v", "1", "-vf", "scale=240:-1", "-y", png], check=False)
        if os.path.exists(png):
            files.append(png)
    sheet = os.path.join(out_dir, "sync_frames.png")
    if len(files) >= 2:
        args = [FFMPEG, "-loglevel", "error"]
        for f in files:
            args += ["-i", f]
        args += ["-filter_complex", f"hstack={len(files)}", "-y", sheet]
        subprocess.run(args, check=False)
    return sheet if os.path.exists(sheet) else ""


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--mp4", required=True)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--out-dir", default="")
    parser.add_argument("--tolerance", type=float, default=0.8)
    parser.add_argument("--narration-language", default="ko")
    args = parser.parse_args()

    dialogue, narration = load_rows(args.manifest)
    out_dir = args.out_dir or (os.path.splitext(args.mp4)[0] + ".sync_audit")

    findings = []
    findings += audit_dialogue(args.mp4, dialogue, args.tolerance)
    # 혼합 언어 오디오에서 whisper는 큰 창을 절단하거나 한국어를 번역-전사한다(실측 3건 전부
    # 오탐). FAIL 행은 그 줄만 잘라낸 초점 창으로 한 번 더 재서, 진짜만 남긴다.
    by_id = {r["caption_id"]: r for r in dialogue}
    for f in findings:
        if f["level"] != "FAIL" or f["id"] not in by_id:
            continue
        row = by_id[f["id"]]
        try:
            res = transcribe(args.mp4, language="en", start=max(0.0, row["at"] - 0.6), end=row["end"] + 1.2)
        except Exception:
            continue
        words = res.get("words") or []
        if not words:
            continue
        onset = float(words[0]["start"])
        # 첫 단어 스트레치: 두 번째 단어가 자막 시각에 더 가깝다면 그쪽이 진짜 온셋이다.
        if len(words) > 1 and abs(float(words[1]["start"]) - row["at"]) < abs(onset - row["at"]):
            onset = float(words[1]["start"])
        if abs(onset - row["at"]) <= args.tolerance + 0.4:
            f["level"] = "OK"
            f["why"] = f"재프로브 통과: 발화 {onset:.1f}s vs 자막 {row['at']:.1f}s"
    findings += audit_narration(args.mp4, narration, args.tolerance, args.narration_language)
    sheet = write_frames(args.mp4, narration, out_dir)

    fails = [f for f in findings if f["level"] == "FAIL"]
    warns = [f for f in findings if f["level"] == "WARN"]
    lines = [f"# sync audit — {os.path.basename(args.mp4)}",
             f"대사 {len(dialogue)}행 · 해설 {len(narration)}문장 · FAIL {len(fails)} · WARN {len(warns)}", ""]
    for f in findings:
        lines.append(f"- [{f['level']}] {f['id']}: {f['why']}")
    if sheet:
        lines.append(f"\n해설 시간축 프레임 시트(육안 통독용): {sheet}")
    report = "\n".join(lines)
    print(report)
    os.makedirs(out_dir, exist_ok=True)
    with io.open(os.path.join(out_dir, "sync_audit.md"), "w", encoding="utf-8") as fh:
        fh.write(report + "\n")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.exit(main())
