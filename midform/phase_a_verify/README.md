# Phase A Asset Channel Verification

This folder verifies large YouTube channel handle lists for midform movie recap asset-channel discovery. It uses `yt-dlp` metadata extraction only. It does not download videos and does not require external API keys.

## Requirements

- Python 3.10+
- yt-dlp

Install `yt-dlp` if needed:

```bash
python -m pip install -U yt-dlp
```

## Input

Put channel handles or URLs in:

```text
input/handles.txt
```

One item per line is supported. Mixed formats are allowed:

```text
@channelname
https://www.youtube.com/@channelname
https://www.youtube.com/channel/UCxxxxxxxxxxxxxxxxxxxxxx
```

## Run

From this folder:

```bash
python verify_light.py
```

Stage 1 compresses the source list by checking channel existence, recent activity within 90 days, and at least 10 videos. It writes progress to `output/stage1_result.json` every 100 processed channels, so interrupted runs can resume.

Then run:

```bash
python verify_deep.py
```

Stage 2 automatically reads PASS channels from `output/stage1_result.json`, collects recent and popular video metadata, grades channels, and extracts legend-video candidates.

## Outputs

- `output/stage1_result.json`: stage 1 status per channel
- `output/stage2_result.json`: stage 2 analysis details per PASS channel
- `output/channels_graded.csv`: final channel grade table
- `output/legend_videos.csv`: legend-video candidates sorted by view multiplier
- `../logs/phase_a_verify_light.log`: stage 1 log
- `../logs/phase_a_verify_deep.log`: stage 2 log

## Tuning

Optional environment variables:

- `VERIFY_LIGHT_WORKERS`: default `6`, clamped to `1..8`
- `VERIFY_DEEP_WORKERS`: default `4`, clamped to `1..6`
- `YTDLP_TIMEOUT_SEC`: per yt-dlp call timeout

Both scripts add a random 0.5-1.5 second delay before each yt-dlp call and pause for 60 seconds after 10 consecutive failures.
