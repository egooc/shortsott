# Common Rules

- Ground every claim in Gemini analysis JSON, especially `clips`, `visual_evidence`, `safe_in`, `safe_out`, and `dopamine_anchors`.
- Do not invent scenes, actions, or facts that are not present in Gemini analysis.
- `selected_source` and `validated_source` are operational metadata only. They must not override frame-grounded evidence from Gemini clips.
- Do not copy source narration verbatim. Rewrite as original Korean narration style.
- Every `source_clips[].clip_id` must exist in Gemini `clips`.
- Every `source_clips[].start/end` must stay within the referenced clip safe range (`safe_in/safe_out`).
- Output JSON only.
- Do not output markdown, explanations, or code fences.
