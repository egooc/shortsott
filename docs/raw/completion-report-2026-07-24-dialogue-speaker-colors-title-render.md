# 완료 보고서 — 대사 자막 화자별 색상 적용 및 draft 제목 변경

## 요약

CapCut draft의 자막 text material이 개별 색상을 지원하는지 먼저 확인한 뒤, 대사 자막에만 화자별 색상을 적용했습니다. 나레이션 자막은 기존 템플릿 흰색을 유지했습니다.

이번 run은 기존 ElevenLabs TTS를 전부 재사용했고, draft render를 1회 생성했습니다.

최종 draft:

- `server/output/drafts/pipeline_1784826254`

최종 SRT:

- `server/output/drafts/pipeline_1784826254/subtitles/subtitles.srt`

최종 ZIP:

- `server/output/drafts/pipeline_1784826254.zip`

## 구현 전 확인 결과

CapCut draft의 자막 세그먼트는 개별 텍스트 색상을 지원합니다.

확인한 구조:

- `draft_content.json`의 `materials.texts[]`
- 각 text material의 `content` 필드 내부 JSON
- `content.styles[].fill.content.solid.color`

색상 저장 방식:

```json
"fill": {
  "content": {
    "solid": {
      "color": [0.494118, 0.784314, 0.890196]
    }
  }
}
```

적용 지점:

- `scripts/capcut_draft.py`
- `rebuild_midform_caption_track_from_template(...)`

이 함수는 템플릿의 `TEMPLATE_SUBTITLE` text material을 각 자막마다 복제합니다. 따라서 각 자막이 별도 text material을 갖고, 해당 material의 fill 색만 바꾸면 개별 자막 색상 적용이 가능합니다.

## 구현 내용

### 1. 색상 설정 파일 추가

파일:

- `midform/config/caption_colors.json`

설정:

```json
{
  "roles": {
    "남주": "#7EC8E3",
    "여주": "#FFB6C1",
    "남조연": "#A8D96C",
    "여조연": "#FFD93D"
  },
  "speakers": {
    "제드": "남조연",
    "브릿": "남주",
    "챠스카": "남조연"
  }
}
```

이번 run에서 실제 사용된 색:

- 제드: `#A8D96C`
- 브릿: `#7EC8E3`
- 챠스카: `#A8D96C`

미사용이지만 규칙에 포함된 색:

- 여주: `#FFB6C1`
- 여조연: `#FFD93D`

### 2. speaker 필드 전달

수정 파일:

- `midform/scripts/assemble_slot_draft_input.py`
- `server/services/midformBootstrapAdapterService.js`
- `scripts/capcut_draft.py`

처리 흐름:

```text
script.json dialogue segment speaker
→ draft_input.json captionUnits[].speaker
→ edit_manifest.json caption_units[].speaker / caption_color
→ draft_content.json text material fill color
```

나레이션 자막은 `caption_color`가 비어 있으므로 기존 흰색 템플릿 색을 유지합니다.

### 3. 이번 run 화자 지정

수정 파일:

- `midform/test_runs/run_20260723_220404_Chaska_Kept_Jed_Alive_Long_Enough_to_Make_Him_Pa/script.json`

지정 내용:

| 대사 | speaker | 색상 |
|---|---|---|
| 인질이 셋 있다. | 제드 | `#A8D96C` |
| 우릴 보내주면 살려주지. | 제드 | `#A8D96C` |
| 인질 중 하나가 로켓을... / 안에 네놈 사진이 있고. | 제드 | `#A8D96C` |
| 로라, 날 떠나지 마. | 브릿 | `#7EC8E3` |
| 제발, 정신 차려. | 브릿 | `#7EC8E3` |
| 로라, 정말 미안해. | 브릿 | `#7EC8E3` |
| 방금 그건 뭐였지? | 브릿 | `#7EC8E3` |
| 축제 소리요. | 챠스카 | `#A8D96C` |

사용자 확인 대기 항목은 speaker를 빈 값으로 유지했습니다.

- `우린 미끼였소.`
- `이제 쌤쌤이라는 게 대체 무슨 뜻이었을까?`
- `인디언이요? 그래, 조금 전에 습격당했어.`
- 이후 같은 슬롯의 미지정 대사들

## draft 제목 변경

요청 제목:

```text
아들을 쫓던 보안관은 왜 수우족의 미끼가 되었나?
```

반영 위치:

- `script.json`의 `title_block.full_title`
- `script.json`의 `metadata.title_candidates[0]`
- CapCut 고정 오버레이 `TITLE` / `SUBTITLE`

CapCut 템플릿은 제목을 두 줄 오버레이로 표시하므로 실제 draft에는 아래처럼 들어갔습니다.

```json
"title": "아들을 쫓던",
"subtitle": "보안관은 왜 수우족의"
```

전체 제목 문자열은 `script.json`에 보존되어 있습니다.

## TTS 재사용 및 render 결과

TTS assembly 결과:

```json
{
  "captionUnits": 48,
  "ttsFiles": 11,
  "reused": 11,
  "regenerated": 0
}
```

즉, ElevenLabs TTS는 새로 생성하지 않았고 기존 11개 mp3를 모두 재사용했습니다.

render 1회 결과:

- draft: `server/output/drafts/pipeline_1784826254`
- ZIP: `server/output/drafts/pipeline_1784826254.zip`
- SRT: `server/output/drafts/pipeline_1784826254/subtitles/subtitles.srt`
- manifest: `server/output/drafts/pipeline_1784826254/edit_manifest.json`
- notes: `server/output/drafts/pipeline_1784826254/capcut_notes.md`

render summary:

- `audioTrackCount`: 11
- `subtitleTrackCount`: 48
- `totalDurationSec`: 107.276999
- warnings: `[]`

## 색상 적용 검증

`edit_manifest.json` 기준:

```json
{
  "badMarks": [],
  "coloredCaptions": 10,
  "narrationColored": 0,
  "colors": ["#A8D96C", "#7EC8E3"]
}
```

`draft_content.json` text material fill color 기준:

```json
{
  "0.658824,0.850980,0.423529": 6,
  "0.494118,0.784314,0.890196": 4
}
```

해석:

- 연두 `#A8D96C`: 6개 text material
  - 제드 대사 5개 caption chunk
  - 챠스카 대사 1개 caption chunk
- 하늘 `#7EC8E3`: 4개 text material
  - 브릿 대사 4개 caption chunk
- 나레이션 색 적용: 0개

## 자막 기호 검증

확인 대상:

- `server/output/drafts/pipeline_1784826254/subtitles/subtitles.srt`

금지 기호:

- `—`
- `–`
- `ㅡ`
- `/`
- `>>`

결과:

- 금지 기호 0건

## 검증

LSP diagnostics:

- `scripts/capcut_draft.py`: 오류 0건
- `midform/scripts/assemble_slot_draft_input.py`: 오류 0건
- `server/services/midformBootstrapAdapterService.js`: 오류 0건
- `server/services/midformCompressionService.js`: 오류 0건

전체 검증:

```bash
npm run verify
```

결과:

- `check:encoding` 통과
- `verify:js` 통과
- `verify:py` 통과
- `verify:fixture` 종료 코드 0으로 통과

참고: 내부 explore agent 2개는 opencode 결제 오류로 실패했지만, 외부 librarian 결과와 직접 파일 검증으로 구현 전 확인을 완료했습니다.

## 보고서 위치

- `docs/raw/completion-report-2026-07-24-dialogue-speaker-colors-title-render.md`
