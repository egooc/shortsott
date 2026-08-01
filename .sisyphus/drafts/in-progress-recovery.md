# Draft: In-Progress Recovery

## Requirements (confirmed)
- User asked in Korean: "아까 완료 못한것들이 있어 진행중이던 작업 찾아줘" — find the previously unfinished/in-progress work.
- User selected continuation path: **Wave 4 후속** — plan the production-readiness follow-up after Wave 4.

## Research Findings
- Active Sisyphus boulder: `.sisyphus/plans/midform-editorial-generalization.md` (`plan_name`: `midform-editorial-generalization`).
- Older plan: `.sisyphus/plans/dialogue-selection-timing-and-speaker-colors.md` appears implementation-complete at task level, but its final verification wave still has unchecked F1-F4 boxes.
- Active plan file still has unchecked tasks T1-T18 and F1-F4, but later completion reports indicate Waves 1-4 were executed offline through production-hardening evidence.
- Latest completion report: `docs/raw/completion-report-2026-07-28-midform-editorial-generalization-wave4.md`.
- Wave 4 report lists remaining production gaps: real CapCut-app exported MP4 pixel validation, real TTS instead of silent placeholder MP3s, live LLM full-copy regeneration, and reconfirming timing with real TTS durations.
- Git working tree has many uncommitted changes across midform schemas, scripts, server services, tests, docs reports, and generated/config assets.

## Technical Decisions
- Treat the active recoverable work as `midform-editorial-generalization` unless user chooses the older dialogue/color final verification task.
- Do not implement or modify source code in this recovery turn; only identify current state and ask which continuation path to plan.
- Next planning focus should be the final production-readiness gap from Wave 4, not the older dialogue/color-only plan.

## Open Questions
- Confirm whether the next work plan should include live external API execution steps (`Gemini/Vertex`, GPT/Codex, ElevenLabs) or only local/offline hooks that can be run when credentials/network are available.
- Confirm whether CapCut exported MP4 pixel validation must be automated inside the repo, or whether the plan should create an evidence protocol for an agent/operator to export then validate the resulting MP4.
- Confirm whether cleanup/commit partitioning for existing uncommitted Waves 1-4 changes should be included in the same single plan.

## Scope Boundaries
- INCLUDE: Recover current task state, identify active plan, surface remaining gaps and likely next steps.
- EXCLUDE: Running implementation, changing source files, committing, or modifying non-markdown files.
