# Movie Midform Recap Review Checklist

Use this checklist before approving a Gemini scene extraction or Claude midform script.

## Gemini Scene Extraction
- source.duration_sec is greater than 0.
- source.aspect_ratio exists.
- story_context.content_guess exists; "?? ?? ??" is acceptable.
- story_context.content_confidence is a valid enum value.
- story_context.plot_summary_neutral is at least 20 Korean characters or equivalent detail.
- story_context.genre is one of the allowed enum values.
- story_context.language_of_dialogue exists.
- scenes count is 3-20.
- Each scene has start_sec, end_sec, duration_sec, visible_action, dialogue_or_caption, shot_type, characters_visible, and vertical_crop_note.
- duration_sec equals end_sec - start_sec within 100ms.
- visible_action is at least 15 Korean characters or equivalent detail.
- characters_visible values exist in characters[].safe_display_name.
- safety_scan has violence, sexual, gore, minor_safety, and sensitive_topic.
- integrity_check.total_scenes_count equals scenes.length.

## Claude Script
- Final planned duration is 60-180 seconds.
- The five story roles are present: hook, setup, conflict, reveal_or_climax, ending.
- Every source scene reference exists in Gemini scenes.
- No single source scene exceeds 30 seconds in use.
- The script preserves the source result and major event order.
- No unsupported accusation, motive, or event is invented.
- Character labels remain safe and do not use real names.

## Korean Script Quality
- Korean sounds natural for YouTube narration.
- Forbidden endings are absent: ~??, ~???, ~??, ~??, ~??.
- The hook is understandable on first listen.
- The ending clearly matches the source.

## Vertical 9:16 Readiness
- Important scenes have usable vertical_crop_note values.
- Key faces, reactions, text, or actions can fit vertical crop.
- Top/bottom caption space does not hide critical action.

## Risk Review
- Safety scan has been reviewed.
- Violence, gore, sexual content, minor safety, and sensitive topics are marked.
- The recap stays inside factual movie-story summary.
