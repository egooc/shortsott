# Midform Prompts

These prompts are independent from the Ottogi prompt system under `server/prompts/`.

## Files

- `gemini_analysis_midform.md`  
  Gemini scene extraction for `movie_midform_recap`. It returns a small factual schema: `source`, `story_context`, `scenes`, `characters`, `safety_scan`, and `integrity_check`.

- `claude_script_midform.md`  
  Claude script generation guide. It uses Gemini scenes to write a Korean 60-180 second midform recap, and owns the hook/story reconstruction work.

- `movie_midform_recap_review.md`  
  Review checklist for the thin Gemini scene schema and later Claude scripts. It checks scene timing, safe character labels, safety scan, 9:16 crop notes, Korean quality, and source grounding.

- `../schemas/gemini_response_schema.json`  
  Vertex `responseSchema` for Gemini scene extraction. It intentionally avoids subjective scoring fields and complex schema constructs.

## Difference From Ottogi

Ottogi process prompts focus on manufacturing/process explanation and short output formats. Midform Gemini extraction is thinner: it records observable movie-scene facts only. Narrative selection, hook writing, and recap pacing are deferred to Claude.

## Suggested Order

1. Run Gemini midform scene extraction with `gemini_analysis_midform.md` and `gemini_response_schema.json`.
2. Validate the extraction with `midform/scripts/validate_phase_d.js`.
3. Review the extraction with `movie_midform_recap_review.md`.
4. Generate a Korean midform script with `claude_script_midform.md` after the Claude midform route exists.

## 차용 이력

### Phase E-9 — Claude 대본 프롬프트 강화

- Source reference: verified 냐옹시네마 v6.1 script guide.
- Borrowed only quantitative systems suitable for midform movie recap:
  - ending ratio targets for Korean narration
  - 4-step mystery preservation rhythm
  - character naming consistency
  - expanded yellow-dollar-safe rephrasing
  - two-part closing formula
  - expanded `quality_check.ending_rules_check`
- Intentionally excluded systems that do not fit this midform movie-recap workflow:
  - emotion-filtering/judgment system, because it is channel-specific to emotional content
  - 40s-50s empathy scoring, because the target audience differs
  - 20-second expansion system, because this project rewrites narration rather than preserving source narration
  - forced STEP 0-4 process output, because it adds overhead to asynchronous API/script generation
  - 003/005 pattern classification, because it is specific to 냐옹시네마
