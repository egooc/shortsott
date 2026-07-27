# 완료 보고서 — ElevenLabs 실측 계수 교정 후 전체 render

## 요약

요청하신 방식대로 나머지 3개 샘플을 추가 합성해, 총 4개 샘플의 `(글자수 ÷ 실제길이)` 평균으로 **실측 자/초 계수**를 계산했습니다.

- 실측 평균 계수: `6.03775 chars/sec`

이 값을 설정과 코드의 단일 유효 계수로 반영한 뒤:

1. `compress-refresh`로 edit plan 시간을 다시 계산
2. `preflight-only` 통과 확인
3. 전체 render 1회 실행

까지 완료했습니다.

## 샘플 4개 실측 결과

대상 run:

- `midform/test_runs/compress_20260721224323_3e-5BAhZQ5w`

샘플 파일:

- `tts/slot_1_elevenlabs_sample.mp3`
- `tts/slot_2_elevenlabs_sample.mp3`
- `tts/slot_5_elevenlabs_sample.mp3`
- `tts/slot_closing_elevenlabs_sample.mp3`

실측 결과:

| slot | 글자수(공백 제외) | 실제 길이(sec) | 글자수/실제길이 |
|---|---:|---:|---:|
| `slot_1` | 22 | 3.291 | 6.684 |
| `slot_2` | 72 | 12.617 | 5.707 |
| `slot_5` | 136 | 23.484 | 5.791 |
| `slot_closing` | 75 | 12.565 | 5.969 |

평균(사용자 요청 방식: 4개 샘플의 `(글자수 ÷ 실제길이)` 평균):

- **`6.03775 chars/sec`**

참고로 전체 글자수 / 전체 시간의 가중 평균은 `5.870176 chars/sec`였지만, 이번 반영은 **사용자 요청대로 샘플별 비율의 단순 평균**을 사용했습니다.

## 반영 내용

### 설정 파일

파일:

- `midform/config/tts.json`

추가:

```json
"effective_chars_per_sec": 6.03775
```

### Python TTS / 조립 경로

파일:

- `midform/scripts/assemble_slot_draft_input.py`

변경:

- `effective_chars_per_sec`가 있으면 `base_chars_per_sec × speed`보다 **우선** 사용
- provider 전환은 그대로 유지
- ElevenLabs 샘플 모드 유지

### 압축 길이 추정 경로

파일:

- `server/services/midformCompressionService.js`

변경:

- `effective_chars_per_sec`가 있으면 그 값을 우선 사용

### 파이프라인 미리보기/길이 추정 경로

파일:

- `server/services/midformPipelineService.js`

변경:

- `effective_chars_per_sec`가 있으면 그 값을 우선 사용

### refresh 경로 보강

파일:

- `server/services/midformCompressionService.js`

변경:

- `compress-refresh`가 기존 `compression_slot_fills.json`까지 읽어 `recalculateNarrationDurations(...)`를 다시 수행하도록 연결

즉, 이제 계수를 바꾸면 **refresh만으로 narration duration이 다시 계산**됩니다.

## refresh 결과

실행 명령:

```bash
node scripts/midform.js compress-refresh compress_20260721224323_3e-5BAhZQ5w
```

결과:

- `edit_plan_path: midform/test_runs/compress_20260721224323_3e-5BAhZQ5w/edit_plan.json`
- `estimated_total_sec: 329.138`

예시 반영:

- `slot_1 narration_estimated_duration_sec: 3.52`
- `slot_2 narration_estimated_duration_sec: 11.095`

## preflight-only 결과

실행 명령:

```bash
node scripts/midform.js bootstrap compress_20260721224323_3e-5BAhZQ5w --preflight-only
```

결과:

- `preflight_ok: true`
- 모든 gate PASS
- `startRun NOT invoked`

## 전체 render 1회 결과

실행 명령:

```bash
node scripts/midform.js bootstrap compress_20260721224323_3e-5BAhZQ5w
```

생성된 pipeline run:

- `midform/test_runs/run_20260723_220404_Chaska_Kept_Jed_Alive_Long_Enough_to_Make_Him_Pa`

생성된 draft:

- draft 폴더: `server/output/drafts/pipeline_1784811903`
- ZIP: `server/output/drafts/pipeline_1784811903.zip`
- manifest: `server/output/drafts/pipeline_1784811903/edit_manifest.json`
- notes: `server/output/drafts/pipeline_1784811903/capcut_notes.md`
- subtitle: `server/output/drafts/pipeline_1784811903/subtitles/subtitles.srt`

## 무음 / 프리즈 확인

확인 파일:

- `midform/test_runs/run_20260723_220404_Chaska_Kept_Jed_Alive_Long_Enough_to_Make_Him_Pa/pipeline_state.json`
- `server/output/drafts/pipeline_1784811903/capcut_notes.md`
- `server/output/drafts/pipeline_1784811903/edit_manifest.json`

확인 결과:

- pipeline state: `status = completed`
- draft warnings: `[]` (없음)
- `capcut_notes.md`의 `Known Warnings`: `none`
- `Duration Diff Sec (TTS-Video): 0.0`
- `Video Timeline Aligned To TTS: true`
- `freeze_applied: false`
- `freeze_duration_sec: 0.0`
- `audioTrackCount: 11`
- `subtitleTrackCount: 49`

즉, 로그 기준으로는:

- **프리즈 징후 없음**
- **무음/오디오 누락 경고 없음**
- **TTS 길이 기준 타임라인 정렬 정상**

## 저장소 검증

실행 명령:

```bash
npm run verify
```

결과:

- `check:encoding` ✅
- `verify:js` ✅
- `verify:py` ✅
- `verify:fixture` ✅ 명령 종료 성공

참고로 `verify:fixture` 출력에는 기존 fixture 리포트의 `status: failed` 문자열이 남아 있지만, 저장소의 필수 검증 명령 전체는 종료 코드 0으로 성공했습니다.

## 관련 경로

- TTS 설정: `midform/config/tts.json`
- TTS 조립/provider 전환: `midform/scripts/assemble_slot_draft_input.py`
- 길이 추정(압축): `server/services/midformCompressionService.js`
- 길이 추정(파이프라인): `server/services/midformPipelineService.js`
- 샘플 mp3들: `midform/test_runs/compress_20260721224323_3e-5BAhZQ5w/tts/`
- 최종 draft: `server/output/drafts/pipeline_1784811903`
- 이 보고서: `docs/raw/completion-report-2026-07-23-elevenlabs-measured-cps-render.md`
