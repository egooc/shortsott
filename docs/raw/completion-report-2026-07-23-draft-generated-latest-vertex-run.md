# 완료 보고서 — 최신 Vertex run 드래프트 생성

## 실행 대상

- 압축 run: `midform/test_runs/compress_20260721224323_3e-5BAhZQ5w`
- 파이프라인 run: `midform/test_runs/run_20260723_194156_Chaska_Kept_Jed_Alive_Long_Enough_to_Make_Him_Pa`

## 실행 내용

아래 명령으로 최신 Vertex run을 부트스트랩해서 실제 CapCut 드래프트 생성까지 진행했습니다.

```bash
node scripts/midform.js bootstrap compress_20260721224323_3e-5BAhZQ5w
```

## 결과

Preflight는 전부 통과했습니다.

- `no_slot_map_key` PASS
- `dialogue_line_window_ok` PASS
- `coverage_slotmap_eq_script` PASS
- `coordinate_parity_dialogue` PASS
- `cold_open_no_reserved_overlap` PASS
- `source_video_exists` PASS
- `source_duration_covers_timestamps` PASS
- `capcut_reserved_range` PASS
- `capcut_slot_map_mode_false` PASS
- `capcut_story_sync_skipped` PASS
- `capcut_narration_has_broll` PASS
- `capcut_cross_segment_overlap` PASS

## 생성 산출물

파이프라인 상태 파일 기준:

- 파이프라인 상태: `midform/test_runs/run_20260723_194156_Chaska_Kept_Jed_Alive_Long_Enough_to_Make_Him_Pa/pipeline_state.json`
- draft 폴더: `server/output/drafts/pipeline_1784803333`
- draft ZIP: `server/output/drafts/pipeline_1784803333.zip`
- manifest: `server/output/drafts/pipeline_1784803333/edit_manifest.json`
- 자막: `server/output/drafts/pipeline_1784803333/subtitles/subtitles.srt`
- 오디오 폴더: `server/output/drafts/pipeline_1784803333/audio`
- CapCut 메모: `server/output/drafts/pipeline_1784803333/capcut_notes.md`
- import 체크리스트: `server/output/drafts/pipeline_1784803333/capcut_import_checklist.md`

## 화면 검수 준비

검수 편의를 위해 draft 폴더를 Explorer로 열었습니다.

- 열린 폴더: `C:\Users\sejun\Documents\Codex\2026-05-26\midform\server\output\drafts\pipeline_1784803333`

## 참고

- 이번 드래프트는 최신 Vertex run의 보정된 `compress-apply` 결과를 기반으로 생성됐습니다.
- 부트스트랩 단계에서 경고 1건이 있었지만(`VTT cue` 일부 제외), preflight gate는 모두 PASS였습니다.
