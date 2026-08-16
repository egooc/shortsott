---
name: export-doctor
description: Diagnose CapCut export failures - read the real error, inspect the failure screenshot, unblock drafts written off by a transient fault, and restart the drain. Use when exports fail, the buffer stops growing, or drafts are being given up on.
---

# Export doctor

The export drives CapCut through its GUI, so failures are visual and the log
alone rarely explains them. Work in this order.

## 1. Read the actual error

```bash
node scripts/ops/pipeline-status.js
```

The producer records the export script's own JSON on failure. If a failure line
shows only `Command failed: python ...`, the run predates that logging - rerun
the draft by hand to get the detail:

```bash
python scripts/capcut_export_one.py --draft-name "<draft>" --export-dir "$USERPROFILE/Desktop/캡컷아웃풋/CapCut Drafts/_automation factory"
```

Read the whole output, not the last lines. The step log (`maximize`,
`home_ready`, `searched`, `researched`) says how far it got.

## 2. Look at the screenshot

On failure the script writes `_export_failure.png` next to the drafts folder.
**Open it.** Every export bug found so far was invisible from the outside and
obvious in that image:

- the editor open and maximized while the run reported "editor did not open" -
  the teal probe had landed on the white label painted on the button
- the editor open on a *different* project - the grid had not filtered yet and
  the double-click hit the unfiltered first row
- the home screen unfiltered with black thumbnails - CapCut was still painting

When a coordinate is suspect, measure the pixel rather than guessing:

```bash
python -c "from PIL import Image; im=Image.open(r'<png>').convert('RGB'); print(im.getpixel((1769,17)))"
```

## 3. Do not verify by window title

CapCut paints its own title bar. The project name is on screen, but every Qt
window reports the title `CapCut`. Two attempts to check which draft opened this
way rejected correctly opened drafts instead.

## 4. Unblock and restart

A draft written off by a transient fault stays skipped until its ledger entry is
cleared. `server/data/export_failures.json` keeps six genuinely dead entries -
four whose media an old retention sweep removed, plus two sample drafts. Clear
everything else, then let the producer drain:

```bash
node scripts/hourly-produce.js
```

It takes a pid lock, so it is safe to run while the hourly task exists; a second
producer exits immediately.

## 5. Confirm from a scheduled run

A hand-run proves little here: exports failed for thirteen hours under the
scheduler while the same drafts exported first try by hand. Wait for the :30 task
and check its result before calling it fixed.
