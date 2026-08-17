---
name: draft-audit
description: Check finished drafts before or after they ship - Full length, template titles, manuscripts that circle one arc step, and several videos cut from one source. Use when asked "원고가 잘 나왔어?", "제목 확인해줘", "중복 아니야?", or after a batch finishes.
---

# Draft audit

```bash
node scripts/ops/draft-audit.js --prefix 20260816
```

`--prefix` limits it to one day's drafts; omit it to sweep everything. `--json`
for structured output.

## What it checks, and why each one is here

- **Full shorter than 38s** — the delivered timeline follows the narration, so a
  short manuscript is a short Full. The user accepted 38.96s as enough, so the
  floor is 38, not 40.
- **Template title** — every Korean Full once shipped as "제조 공정의 결정적 순간"
  because the draft read `recommended_titles[0]`, which holds the deterministic
  template, before `upload_title`, which held the title Gemini actually wrote.
  The detector requires a short, punctuation-free title: a real title that
  happens to end the same way ("蚕が紡ぐ奇跡の糸！…ができるまで") is not a template.
- **Arc coverage** — a Full is the whole process summarized. One draft spent 3 of
  5 sentences on sanding while the video ran a band saw, planing, epoxy and
  staining. Only drafts whose script carries `arc_step` can be checked; older
  ones return nothing rather than a false pass.
- **Several Fulls from one source** — a Full is one video per source. Regenerating
  one makes a new dated folder from the same source, and nineteen videos went out
  across three sources before anyone noticed. Two of them waiting in the buffer
  is the dangerous case: the uploader only treats a source as spent once one has
  been published, so until then the pair looks like two ordinary videos in the
  queue and goes out on consecutive turns.

## Reading the result

A flagged Full is not automatically unshippable. Length below the floor is a
judgement call the user has already made once ("40초 안되도 원고에 부족함만 없으면
괜찮은걸로"), so report the number and the script's coverage together and let them
decide. A template title or a duplicate source is a defect either way.

## Acting on it

Drafts still in the buffer: move the mp4 to `_automation factory/held/` so the
uploader skips it - the producer and the retention sweep both treat held as
exported, so it will not be rebuilt or re-swept.

Already published: fixing a title or unlisting a video needs the `youtube` OAuth
scope, which the stored tokens do not have. Both channels must re-consent first;
say so rather than attempting it.
