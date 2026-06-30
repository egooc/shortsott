# Common Output Schema

Claude output must preserve the same common JSON structure used by downstream Phase4/Phase5.

Required top-level objects:
- `project`
- `source_ref`
- `story`
- `segments`
- `metadata`
- `quality_check`

Key constraints:
- `segments[].source_clips[]` must include: `scene_id`, `clip_id`, `start`, `end`, `visual_evidence`
- `edit_instruction` should contain at least: `visual_role`, `pace`, `transition`
- `quality_check` should include gate fields used by pipeline verification.

`project.template_id` must be set to the selected template id.
