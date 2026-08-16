---
name: pipeline-status
description: Report whether the 오뚝이영상 line is actually running - scheduled tasks, the producer, the upload buffer, pending drafts and the queue. Use when asked "진행중이야?", "돌고 있어?", "업로드 되고 있어?", or before diagnosing anything else.
---

# Pipeline status

Run the check rather than assembling it by hand:

```bash
node scripts/ops/pipeline-status.js
```

`--json` gives the same data as a structure.

## Reading it

- **[스케줄]** — `마지막결과 0` is success. `267009` means the task is running right
  now, not that it failed. Anything else is a real failure.
- **[제작]** — the producer drains continuously and exits when there is nothing
  left, so `대기` with `nothing left to produce` is healthy, not stalled. It is
  only a problem if drafts are waiting or the queue has unanalysed items.
- **[버퍼]** — uploads alternate JP/KR strictly, so the smaller side is what
  decides when the line starves. One channel far ahead of the other is a
  finding worth reporting even when nothing is broken.
- **[드래프트]** — `원장 차단` counts drafts given up on after two failed export
  attempts. Six of those are known-dead (media removed by an old retention
  sweep, plus two sample drafts). A rising count means exports are failing.
- **[큐]** — `미분석` is the producer's remaining work. Zero means the line is
  idle until the next harvest, which is normal after a drain.

## What counts as a problem

Report a problem when: a task's last result is neither 0 nor "running";
`내보내기 대기` is non-zero while the producer is not running; `원장 차단` grew;
or the buffer for one channel is low enough that alternation will starve.

Do not report "the producer is idle" as a fault on its own - check the queue and
the waiting drafts first.

## If exports are failing

Use the `export-doctor` skill; it reads the failure detail and the screenshot the
export script leaves behind.
