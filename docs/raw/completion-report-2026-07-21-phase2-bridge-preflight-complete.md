# Phase 2 — 브릿지 + preflight 완료, render는 Codex 쿼터 리셋 대기

Date: 2026-07-21

## 상태 요약

Phase 2(압축 파이프라인 → 기존 조립 파이프라인 접점)의 **코드와 caption-무관 검증은 전부 완료**. 남은 것은 실제 render(task #9) 하나이며, 이는 **Codex 주간 쿼터 소진**으로 막혀 있음(외부 요인, 리셋되면 풀림). caption 없이 render로 밀지 않음.

## 완료된 것

### 코드
- `server/services/midformCompressionService.js`
  - caption_kr_dialogue 프롬프트 규칙 + 검증(`validateSlotFillsDialogueCaptions`, 개수 1:1)
  - 콜드오픈 겹침 회피(`subtractReservedRanges`/`pickBestFreeWindow`/`tryColdOpenVisualSourceForBeat`)
  - 대사 줄 단위 창 매칭(`resolveDialogueLineWindows`) — 롤링 VTT 중복(첫~끝 등장 클러스터), 짧은 cue 자동 확장, 몬스터 cue 캡, 겹침/미달 플래그
  - `downloadCompressionSourceVideo` — 실제 소스 영상 다운로드
- `server/services/midformBootstrapAdapterService.js` (신규)
  - `buildBootstrapTranscript` — per-line utterance(start/end) + 원본 cue(대사창 겹침 제외)
  - `buildBootstrapSlotMapAndScript` — script.json에 slot_map 키 없음, 대사=줄 단위 세그먼트, narration_background:true, 좌표 저장값 단일 소스
  - `assembleBootstrapArtifacts` / `runBootstrapPreflight` / `runBootstrapToPipeline`(브릿지)
- `midform/scripts/preflight_bootstrap_gates.py` (신규) — capcut 게이트를 importable로 실행
- `scripts/midform.js` — `bootstrap <runId> [--preflight-only]` 명령
- `midform/schemas/midform_slot_fills_schema.json` — caption_kr_dialogue 추가

### 핵심 설계 결정 (실행으로 검증됨)
- **script.json에 slot_map 키 없음** → `slot_map_mode=False` → 단조성 게이트 `not_applicable`(콜드오픈 역행 허용) + b-roll 오토피커 활성. 딜레마 없음(둘 다 같은 스위치).
- **midformPipelineService.js 수정 불필요** — 파이프라인이 bootstrap 경로를 네이티브 지원. gemini/movie_research 빈 경로도 `{}`로 안전 처리. 데어데블 4종 중 셋(출력위치/좌표계/커버리지)은 파이프라인 쪽에서 발생 여지 없음.
- **direct 실행**(`pauseBeforeTts:false`) — resume/normalize 경로가 slot_map을 재임베드해 단조성을 되살리는 것 회피.

## 검증 (실물 다운로드 영상 기준, Catch the Bullet)

`node scripts/midform.js bootstrap compress_20260720213249_3e-5BAhZQ5w --preflight-only` → **11/11 PASS**:

```
[PASS] no_slot_map_key
[PASS] dialogue_line_window_ok
[PASS] coverage_slotmap_eq_script
[PASS] coordinate_parity_dialogue
[PASS] cold_open_no_reserved_overlap
[PASS] source_video_exists — source.mp4 (실제 다운로드)
[PASS] source_duration_covers_timestamps — dur 608.301s >= max ts 598.200s
[PASS] capcut_reserved_range — 0 violations (실제 게이트 실행)
[PASS] capcut_monotonicity — not_applicable
[PASS] capcut_broll_placement — 0 narration without b-roll (실제 피커 실행)
[PASS] capcut_broll_avoids_speech — 0 b-roll over speech
```

세 capcut 게이트(reserved-range/단조성/b-roll)를 importable로 실제 실행해 통과 확인. 데어데블은 게이트를 렌더링 때 처음 만나 터졌는데, 이번엔 렌더 전에 게이트만 따로 돌려 통과시킴.

## 유일한 블로커: Codex 주간 쿼터

- `compress-apply` 재실행(caption 생성)이 `GPT_CLI_FAILED`로 실패 — Codex 주간 쿼터 소진(외부 요인). 리셋되면 풀림.
- 현재 Catch slot_fills는 caption_kr_dialogue 이전 생성물이라 대사 자막 0/10. preflight는 caption 내용을 안 봐서 11/11 통과하지만, 실제 render는 대사 자막이 빈 채로 나옴.

## 쿼터 리셋 후 순서

1. `compress-apply compress_20260720213249_3e-5BAhZQ5w` → caption_kr_dialogue 채움, 개수 1:1 검증 통과 확인
2. `bootstrap <run> --preflight-only` → 자막 채운 상태로 11/11 재확인
3. `bootstrap <run>` (--preflight-only 제거) → 실제 render (Catch 한 영상)
4. 완주 후 STOP → server/output/drafts 산출물 + 렌더 로그 무음/프리즈 보고 → 사용자가 CapCut에서 확인
5. 좋으면 Twilight(`compress_20260721021138_ngYmFVO_bzM`) 동일 순서

## 남은 리스크 (task #9에서 처음 실측될 것)
- NARRATE 한국어 나레이션 실제 TTS 길이 vs 앞단 추정치
- 콜드오픈 replay(같은 구간 2회) 실제 렌더
- 최종 draft/SRT/ZIP 생성 + 출력 경로
