# 완료 보고서 — 자막 표시용 특수문자 정리 및 기존 run 자막 재생성

## 요약

자막 표시용 텍스트에서만 특수문자를 제거하도록 수정했습니다.

- TTS 입력 텍스트: 유지
- 자막 표시 텍스트: 줄표와 VTT 화자 기호 제거
- 기존 run의 TTS 파일: 전부 재사용
- 새 TTS API 호출: 없음
- 재생성 draft: `server/output/drafts/pipeline_1784814190`

## 수정한 규칙

### 1. 나레이션/자막 표시용 줄표 제거

자막 표시용 텍스트에서 아래 문자를 제거합니다.

- `—`
- `–`
- `ㅡ`

예시:

- 변경 전: `하지만 — 순순히 나올 놈이`
- 변경 후: `하지만 순순히 나올 놈이`

TTS 문장에는 줄표가 남아도 되도록, 표시용 caption chunk 생성 단계에서만 정리했습니다.

### 2. 대사 자막 화자 전환 기호 제거

대사 자막 표시용 텍스트에서 아래 기호를 제거/분리합니다.

- `>>`
- `/`

예시:

- 변경 전: `인디언이요? / 그래, 조금 전에 습격당했어.`
- 변경 후:
  - `인디언이요?`
  - `그래,`
  - `조금 전에 습격당했어.`

즉, 한 캡션에 합쳐지더라도 `/`나 `>>`가 화면에 나오지 않도록 했고, 이번 run에서는 자연 분할 규칙에 따라 별도 캡션으로 나뉘었습니다.

## 변경 파일

### 표시용 caption unit 생성

- `midform/scripts/assemble_slot_draft_input.py`

변경 내용:

- `sanitize_display_caption_text(...)` 추가
- `split_display_caption_sources(...)` 추가
- TTS unit 텍스트는 유지
- caption unit 텍스트만 표시용으로 정리
- dialogue segment에서는 `/` 기준으로 표시 source를 분리한 뒤 caption split 수행

### JS caption unit 경로 보강

- `server/utils/captionUnits.js`

변경 내용:

- `sanitizeDisplayCaptionText(...)` 추가
- `splitDisplayCaptionSources(...)` 추가
- JS 경로로 caption unit을 만들 때도 줄표와 `>>`, `/`가 표시 자막에 남지 않게 보강

### bootstrap dialogue 후처리 보강

- `server/services/midformBootstrapAdapterService.js`

변경 내용:

- `caption_kr_dialogue`에서 생성되는 `translated_caption_ko` / `caption_text`에 표시용 정리 적용

## 기존 run 자막 재생성

대상 run:

- `midform/test_runs/run_20260723_220404_Chaska_Kept_Jed_Alive_Long_Enough_to_Make_Him_Pa`

재조립 결과:

```json
{
  "captionUnits": 49,
  "ttsFiles": 11,
  "reused": 11,
  "regenerated": 0
}
```

즉, 기존 TTS mp3 11개를 모두 재사용했고 새 TTS는 생성하지 않았습니다.

재생성 draft:

- draft 폴더: `server/output/drafts/pipeline_1784814190`
- ZIP: `server/output/drafts/pipeline_1784814190.zip`
- SRT: `server/output/drafts/pipeline_1784814190/subtitles/subtitles.srt`
- manifest: `server/output/drafts/pipeline_1784814190/edit_manifest.json`
- notes: `server/output/drafts/pipeline_1784814190/capcut_notes.md`

## 자막 검증 결과

전용 검증:

```json
{
  "srt_bad_matches": [],
  "caption_unit_bad_count": 0,
  "caption_units": 49
}
```

확인 대상:

- `server/output/drafts/pipeline_1784814190/subtitles/subtitles.srt`
- `midform/test_runs/run_20260723_220404_Chaska_Kept_Jed_Alive_Long_Enough_to_Make_Him_Pa/draft_input.json`

확인한 금지 기호:

- `—`
- `–`
- `ㅡ`
- `>>`
- `/`

결과:

- SRT 금지 기호: 0건
- captionUnits 금지 기호: 0건

실제 SRT 예시:

```text
하지만 순순히 나올 놈이

그런데 추격 중 길잡이가

인디언이요?

그래,

조금 전에 습격당했어.

됐고 아들은 아직,
```

## draft 상태

`capcut_notes.md` 기준:

- `Caption Units Count`: 49
- `Caption Split Warnings Count`: 0
- `Duration Diff Sec (TTS-Video)`: 0.0
- `Video Timeline Aligned To TTS`: true
- `Audio Track Count`: 11
- `Subtitle Track Count`: 49
- `Known Warnings`: none

## 저장소 검증

실행 명령:

```bash
npm run verify
```

결과:

- `check:encoding` 통과
- `verify:js` 통과
- `verify:py` 통과
- `verify:fixture` 종료 코드 0으로 통과

## 보고서 위치

- `docs/raw/completion-report-2026-07-23-caption-display-sanitization.md`
