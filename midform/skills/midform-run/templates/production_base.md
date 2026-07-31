---
profile: production
analysis_mode: auto
source:
  url: https://youtu.be/REPLACE_ME
  content_type: movie_midform_recap
output:
  target_length_sec: 160
tone: evidence-led, cinematic, grounded
callback_required: true
subtitle_limits:
  max_chars: 18
  max_units_per_segment: 6
prohibitions:
  - Do not invent facts outside the URL-specific evidence pack, transcript, metadata, comments, heatmap, or movie research.
  - Do not reuse character names, events, dialogue, or scene details from another source URL.
  - Do not use English fallback narration for KO/JA output.
  - Do not make JA a caption-only duplicate of KO; edit structure should diverge when evidence allows.
render:
  preview_frame_proof: true
  preview_limit: 8
  use_capcut_template: true
  audio_path_mode: absolute
  video_placement_mode: source_clips
---

# Neutral Production Scaffold

## Field structure

- `source.url` is supplied by the current run or batch URL.
- `output.target_length_sec` may be overridden by CLI or manifest.
- KO and JA template bodies must be generated per URL from that URL's evidence pack.

## Generation instructions

- Build recap intent from current URL metadata, transcript, comments, heatmap, and movie research only.
- Derive character references only from verified evidence for the current URL.
- Derive event claims only from verified scene candidates, transcript lines, and source metadata for the current URL.
- Use public Most Replayed windows as editorial signals, not as proof of off-screen plot facts.
- Preserve required dialogue only when it is grounded in current URL transcript evidence.

## Validation rules

- Reject unsupported character names, relationships, motives, and plot causality.
- Keep source references within the current URL's usable source ranges.
- Keep KO/JA outputs grounded in the same evidence pack while avoiding caption-only duplicate edits.
- Record warnings instead of inventing missing facts when evidence is incomplete.

## Output schema

- Produce URL-specific KO and JA template bodies.
- Preserve `evidence_pack.json`, `template_body.ko.md`, and `template_body.ja.md` in the current run workspace.
- Do not share generated template bodies or evidence across URLs.
