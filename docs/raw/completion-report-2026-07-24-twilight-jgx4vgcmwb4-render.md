# Twilight (2008) 미드폼 리캡 생성 완료 보고

## 파일 위치

- 보고서: `docs/raw/completion-report-2026-07-24-twilight-jgx4vgcmwb4-render.md`
- 사용자 컨텍스트: `midform/test_runs/compress_20260724234621_Jgx4vgcMWb4/context.md`
- compression run: `midform/test_runs/compress_20260724234621_Jgx4vgcMWb4/`
- render run: `midform/test_runs/run_20260724_235644_The_Cullens_Legendary_Vampire_Baseball_Game_Full/`
- 최종 CapCut draft: `server/output/drafts/pipeline_1784905027/`
- 최종 ZIP: `server/output/drafts/pipeline_1784905027.zip`
- CapCut notes: `server/output/drafts/pipeline_1784905027/capcut_notes.md`
- edit manifest: `server/output/drafts/pipeline_1784905027/edit_manifest.json`

## 실행 소스

- URL: `https://youtu.be/Jgx4vgcMWb4`
- 명시 target: `180`초
- 컨텍스트: Twilight (2008), Bella / Edward / Cullen 가족 / Laurent / Victoria / James 사실 범위 고정

## 실행 요약

1. Compression Phase 1 실행

```bash
node scripts/midform.js compress --source "https://youtu.be/Jgx4vgcMWb4" --target 180
```

결과:

- run id: `compress_20260724234621_Jgx4vgcMWb4`
- heatmap status: `available`
- edit plan: `midform/test_runs/compress_20260724234621_Jgx4vgcMWb4/edit_plan.json`
- estimated_total_sec: `100.735`

2. 사용자 제공 Twilight 컨텍스트 저장

- 저장 위치: `midform/test_runs/compress_20260724234621_Jgx4vgcMWb4/context.md`
- 최초 `compress-apply`는 업로드 제목 후보가 질문형 검증에 걸려 중단됐습니다.
- 같은 컨텍스트 파일의 업로드 제목 지시만 더 엄격하게 보강한 뒤 1회 재시도했습니다.

3. `compress-apply` 실행

```bash
node scripts/midform.js compress-apply compress_20260724234621_Jgx4vgcMWb4
```

결과:

- slot fills: `midform/test_runs/compress_20260724234621_Jgx4vgcMWb4/compression_slot_fills.json`
- upload text: `midform/test_runs/compress_20260724234621_Jgx4vgcMWb4/upload_text.md`
- apply state: `midform/test_runs/compress_20260724234621_Jgx4vgcMWb4/compress_apply_state.json`
- durationWarnings: `[]`

4. bootstrap preflight-only 실행

```bash
node scripts/midform.js bootstrap compress_20260724234621_Jgx4vgcMWb4 --preflight-only
```

결과: 통과

- `no_slot_map_key`: PASS
- `dialogue_line_window_ok`: PASS
- `coverage_slotmap_eq_script`: PASS
- `coordinate_parity_dialogue`: PASS
- `cold_open_no_reserved_overlap`: PASS
- `source_video_exists`: PASS
- `source_duration_covers_timestamps`: PASS
- `capcut_reserved_range`: PASS
- `capcut_slot_map_mode_false`: PASS
- `capcut_story_sync_skipped`: PASS
- `capcut_narration_has_broll`: PASS
- `capcut_cross_segment_overlap`: PASS

비차단 warning:

- `6 VTT cue(s) excluded from transcript for overlapping a dialogue-line window`

5. full render 실행

```bash
node scripts/midform.js bootstrap compress_20260724234621_Jgx4vgcMWb4
```

결과:

- pipeline run id: `run_20260724_235644_The_Cullens_Legendary_Vampire_Baseball_Game_Full`
- pipeline status: `completed`
- 최종 draft: `server/output/drafts/pipeline_1784905027/`
- 최종 ZIP: `server/output/drafts/pipeline_1784905027.zip`

## 최종 draft 정보

- 총 길이: `74.653`초
- caption units: `37`
- audio tracks: `14`
- subtitle tracks: `37`
- template clone mode: `true`
- template markers found: `TEMPLATE_SUBTITLE`, `TEMPLATE_TITLE`, `TEMPLATE_TITLE_SUBLINE`
- missing template markers: `TEMPLATE_PRETITLE`, `TEMPLATE_MOVIE_TITLE`
- 화면 overlay title:
  - top: `뱀파이어 야구`
  - bottom: `사냥의 시작`
- duration guide: `ok`
  - min: `60`
  - max: `160`
  - measured: `74.653`
- portrait crop method: `portrait_210_240pct_face_anchor_with_fallback`
- portrait crop records: `9`
- CapCut warnings: 없음

## 업로드 텍스트

파일: `midform/test_runs/compress_20260724234621_Jgx4vgcMWb4/upload_text.md`

제목 후보:

1. `번개 치는 날, 왜 벨라가 사냥감이 됐을까?`
2. `뱀파이어들의 야구 경기, 어쩌다 사냥터로 변했을까?`
3. `그날 에드워드는 왜 벨라를 필사적으로 숨겨야 했을까?`

## 검증 메모

- bootstrap preflight는 통과했습니다.
- full render는 완료됐습니다.
- `validate_slot_draft.py`를 새 draft에 직접 실행하면 `slot_map_mode is not true` / `slot_order` 오류가 납니다. 이 render는 bootstrap path라 `slot_map_mode: false`가 의도된 구조입니다. bootstrap preflight의 `capcut_slot_map_mode_false`, `coverage`, `reserved_range`, `cross_segment_overlap` 게이트가 이 경로의 검증 기준입니다.
- 최종 `npm run verify`: 별도 실행 결과를 완료 메시지에 기록합니다.

## API / render 사용

- Compression / compress-apply 과정에서 Vertex/Gemini 계열 생성 호출이 사용됐습니다.
- full render는 1회 실행했습니다.
- 실패한 `compress-apply`는 제목 검증 실패로 중단됐고, 컨텍스트 제목 지시 보강 후 1회만 재시도했습니다. 무한 재시도는 하지 않았습니다.
