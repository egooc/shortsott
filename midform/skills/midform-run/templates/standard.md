---
profile: production
source:
  url: https://youtu.be/REPLACE_ME
output:
  target_length_sec: 150
tone: tense and curiosity-led
must_keep:
  - strongest accusation/rebuttal exchange
  - the callback line that resolves the teaser question
prohibitions:
  - no invented motive beyond verified source and research
  - no long explanatory cold open
opener_policy: incident first, context second
callback_required: true
subtitle_limits:
  max_chars: 18
  max_units_per_segment: 6
spoiler_boundary: do not answer the teaser before the callback lands
render:
  preview_frame_proof: true
  preview_limit: 8
---

Use the existing cold_open_callback logic when the scene supports it, but stay grounded if the source turns out to be non-confrontational.
