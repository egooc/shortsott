---
profile: audit
source:
  url: https://youtu.be/REPLACE_ME
  content_type: movie_midform_recap
output:
  target_length_sec: 180
tone: severe, investigative, and emotionally controlled
must_keep:
  - any line that directly reframes who is to blame
  - at least one exchange that proves the hook is not a standalone rebuttal
prohibitions:
  - no spoiler narration before the callback payoff
  - no invented relationship labels unless movie research confirms them
  - no overlong closing summary
opener_policy:
  strategy: cold_open_callback
  prefer_dialogue_hook: true
callback_required: true
subtitle_limits:
  max_chars: 16
  max_units_per_segment: 6
spoiler_boundary: preserve the teaser tension until the callback slot resolves it
render:
  preview_frame_proof: true
  preview_limit: 12
  use_capcut_template: true
  audio_path_mode: absolute
  video_placement_mode: source_clips
---

Additional intent:

- If the source is a dialogue confrontation, preserve the strongest understandable accusation/rebuttal logic early.
- If the source is not a confrontation scene, do not force callback language where a reveal or setpiece escalation is cleaner.
- Keep acceptance gates strict: fail weak openers rather than smoothing them over.
