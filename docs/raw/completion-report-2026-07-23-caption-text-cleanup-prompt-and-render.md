# 완료 보고서 — 자막 표기 정리, 프롬프트 예시 갱신, draft render 1회

## 요약

자막 표시용 텍스트에서 줄표와 화자 전환 기호가 화면에 남지 않도록 보강했고, `buildSlotFillsPrompt`의 좋은 나레이션 예시에서도 줄표를 제거했습니다.

이번 run은 기존 ElevenLabs TTS를 모두 재사용해 자막/원고 표시 텍스트를 재처리한 뒤, draft render를 1회 생성했습니다.

최종 draft:

- `server/output/drafts/pipeline_1784823862`

최종 SRT:

- `server/output/drafts/pipeline_1784823862/subtitles/subtitles.srt`

최종 ZIP:

- `server/output/drafts/pipeline_1784823862.zip`

## 수정 내용

### 1. 자막 표시용 줄표 제거

대상 문자:

- `—`
- `–`
- `ㅡ`

적용 위치:

- `midform/scripts/assemble_slot_draft_input.py`
- `server/utils/captionUnits.js`

처리 방식:

- TTS unit 텍스트는 유지 가능
- 화면 표시용 `captionUnits[].text` 생성 단계에서만 줄표 제거
- 줄표가 자막 분할 기준으로 남아 `그런데 추격 중 — 길잡이가`처럼 출력되는 문제 방지

### 2. 화자 전환 기호 제거

대상 기호:

- `/`
- `>>`

적용 위치:

- `midform/scripts/assemble_slot_draft_input.py`
- `server/utils/captionUnits.js`
- `server/services/midformBootstrapAdapterService.js`

처리 방식:

- `caption_kr_dialogue` / `translated_caption_ko` / `caption_text` 표시용 텍스트에서 제거
- VTT 화자 전환 기호가 `/ 그래,` 또는 `>>` 형태로 화면에 남지 않도록 보강

### 3. 문체 예시 갱신

파일:

- `server/services/midformCompressionService.js`

변경:

- `buildSlotFillsPrompt`의 좋은 나레이션 예시에서 줄표를 제거
- 줄표가 있던 bridge/body/closing 예시를 쉼표 또는 자연 문장 연결로 변경
- prompt 문자열 내부의 설명용 줄표도 일반 문장부호로 교체

예시 변경:

```text
하지만 — 순순히 나올 놈이 아니었습니다.
```

→

```text
하지만 순순히 나올 놈이 아니었습니다.
```

```text
그런데 추격 중 — 길잡이가 이상한 걸 발견합니다.
```

→

```text
그런데 추격 중, 길잡이가 이상한 걸 발견합니다.
```

```text
쫓던 자는 미끼가 됐고 — 아들은 아직, 저들 손에 있습니다.
```

→

```text
쫓던 자는 미끼가 됐고, 아들은 아직 저들 손에 있습니다.
```

### 4. 이 run 원고 표시 필드 정리

대상 run:

- `midform/test_runs/run_20260723_220404_Chaska_Kept_Jed_Alive_Long_Enough_to_Make_Him_Pa`

수정 파일:

- `midform/test_runs/run_20260723_220404_Chaska_Kept_Jed_Alive_Long_Enough_to_Make_Him_Pa/script.json`

정리한 필드:

- `caption_text`
- `translated_caption_ko`

TTS용 `narration`은 유지했습니다. 사용자 조건대로 TTS 입력에는 줄표가 남아도 되며, 이번 작업은 화면/원고 표시용 텍스트 문제 해결에 맞췄습니다.

## 재처리 / render 결과

TTS assembly 재실행 결과:

```json
{
  "captionUnits": 48,
  "ttsFiles": 11,
  "reused": 11,
  "regenerated": 0
}
```

즉, ElevenLabs TTS 파일은 새로 만들지 않고 기존 11개를 모두 재사용했습니다.

draft render 1회 결과:

- draft: `server/output/drafts/pipeline_1784823862`
- ZIP: `server/output/drafts/pipeline_1784823862.zip`
- SRT: `server/output/drafts/pipeline_1784823862/subtitles/subtitles.srt`
- manifest: `server/output/drafts/pipeline_1784823862/edit_manifest.json`
- notes: `server/output/drafts/pipeline_1784823862/capcut_notes.md`

render 결과 요약:

- `audioTrackCount`: 11
- `subtitleTrackCount`: 48
- `totalDurationSec`: 107.276999
- warnings: `[]`

## 자막 검증 결과

확인 대상:

- `server/output/drafts/pipeline_1784823862/subtitles/subtitles.srt`
- `midform/test_runs/run_20260723_220404_Chaska_Kept_Jed_Alive_Long_Enough_to_Make_Him_Pa/draft_input.json`

확인한 금지 기호:

- `—`
- `–`
- `ㅡ`
- `/`
- `>>`

결과:

- SRT 금지 기호: 0건
- `draft_input.json` caption 표시 텍스트 금지 기호: 0건

실제 SRT 예시:

```text
하지만 순순히 나올 놈이

그런데 추격 중 길잡이가

인디언이요? 그래,

조금 전에 습격당했어.
```

화자 전환 기호인 `/`와 `>>`는 최종 자막에 남지 않았습니다.

## 검증

LSP diagnostics:

- `server/services/midformCompressionService.js`: 오류 0건
- `server/utils/captionUnits.js`: 오류 0건
- `server/services/midformBootstrapAdapterService.js`: 오류 0건
- `midform/scripts/assemble_slot_draft_input.py`: 오류 0건

전체 검증:

```bash
npm run verify
```

결과:

- `check:encoding` 통과
- `verify:js` 통과
- `verify:py` 통과
- `verify:fixture` 종료 코드 0으로 통과

참고: `verify:fixture` 내부의 caption balance 리포트에는 기존 fixture 기준 `status: failed` 문자열이 출력되지만, 저장소 검증 명령 자체는 정상 종료했습니다.

## 보고서 위치

- `docs/raw/completion-report-2026-07-23-caption-text-cleanup-prompt-and-render.md`
