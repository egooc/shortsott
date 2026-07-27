# Completion Report — Second Validation Video Phase 1 Suitability (`3e-5BAhZQ5w`)

Date: 2026-07-20

## Request handled

Ran:

```bash
node scripts/midform.js compress --source https://www.youtube.com/watch?v=3e-5BAhZQ5w --target 180
```

and evaluated the **pre-apply** artifacts only to decide whether this video is suitable material.

## Run created

- Run ID: `compress_20260720213249_3e-5BAhZQ5w`
- Run dir: `midform/test_runs/compress_20260720213249_3e-5BAhZQ5w`

## 1. `transcript_timed.json` — subtitle extraction status

Artifact:

- `midform/test_runs/compress_20260720213249_3e-5BAhZQ5w/transcript_timed.json`

### Verdict

**Pass** — subtitles were extracted successfully.

This is **not** a `SUBTITLE_NOT_FOUND` case.

Evidence:

- `transcript_timed.json` exists
- it contains dense timestamped dialogue from the scene beginning at ~36s

## 2. `heatmap.json` — replay data availability

Artifact:

- `midform/test_runs/compress_20260720213249_3e-5BAhZQ5w/heatmap.json`

Observed:

```json
{
  "status": "unavailable",
  "source": "yt-dlp.info.heatmap",
  "reason": "heatmap_null",
  "items": []
}
```

### Verdict

**No heatmap available.**

This means replay-based cold-open selection cannot be used on this source.

## 3. `narrative_beats.json` — dialogue density / anchor viability

Artifact:

- `midform/test_runs/compress_20260720213249_3e-5BAhZQ5w/narrative_beats.json`

### Summary

This source is **dialogue-rich**.

It is the opposite of a sparse Muse-style clip.

There are multiple beats with strong anchor candidates, including:

- `beat_01`
  - `My plan's changed. I've got three hostages.`
  - `It's got a picture inside. It looks like you.`

- `beat_02`
  - `They want us to think she was one of them.`
  - `Laura. I'm so sorry.`

- `beat_04`
  - `Five Sioux. Circling around to our front.`
  - `We're bait.`

- `beat_05`
  - `What the hell did he mean when he said we were even?`
  - `He said he learned the difference between the Sioux and the Pawnee.`

- `beat_06`
  - `Sun's about to rise. We got to get out of here.`
  - `With my luck, they already killed your pa.`

### Verdict

**Strong pass** on dialogue density.

This source has enough real spoken material for anchors and compressed dialogue selection.

## 4. Title / scene identity

Artifact:

- `midform/test_runs/compress_20260720213249_3e-5BAhZQ5w/source_info.json`

Observed title:

```text
Chaska Kept Jed Alive Long Enough to Make Him Pay (Full Scene) | Catch the Bullet
```

### Interpretation

This appears to be a **hostage / pursuit / ambush / aftermath** scene from the western film **Catch the Bullet**.

The scene identity is clear:

- standoff / hostage leverage
- emotional aftermath around Laura
- ambush / pursuit / Sioux trap

## Suitability judgment

### Strengths

- subtitles exist ✅
- dialogue density is high ✅
- multiple strong anchor lines exist ✅
- scene identity is clear ✅

### Weaknesses

- heatmap is unavailable ❌

### Final verdict

**Suitable enough to continue** if the goal is dialogue/anchor validation.

Reason:

- lack of heatmap hurts replay-driven teaser selection,
- but the source is still strong for testing:
  - subtitle extraction
  - beat segmentation
  - anchor selection
  - dialogue-heavy compression behavior

If the next step specifically depends on replay-peak logic, pick another source.
If the goal is validating compression + anchor quality on a dialogue-heavy scene, this source is good enough.

## Recommendation

- **Continue** if you want a second validation source for dialogue-heavy compression behavior.
- **Replace** only if replay heatmap availability is mandatory for the next test.
