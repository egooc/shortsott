# 대사 자막 효과 제거 A안 완료 보고서

## 보고서 위치

- `docs/raw/completion-report-2026-07-24-caption-effect-removal-a-plan.md`

## 최종 산출물

- 최종 draft: `server/output/drafts/pipeline_1784898451`
- 최종 ZIP: `server/output/drafts/pipeline_1784898451.zip`
- 최종 notes: `server/output/drafts/pipeline_1784898451/capcut_notes.md`
- 최종 manifest: `server/output/drafts/pipeline_1784898451/edit_manifest.json`

## 적용한 A안

대사 자막에 한해서 아래 효과 레이어를 제거했다.

- `content.styles[].effectStyle`
- `extra_material_refs` 안의 `effects/text_effect`
- `extra_material_refs` 안의 `effects/bloom`

유지한 항목:

- 글자 본체 fill 색상
- `useLetterColor=true`
- `use_effect_default_color=false`
- 기본 border 계열 필드
- `material_animations/sticker_animation` ref
- 제목/제목 하단/timed subtitle 구조

## 코드 수정

파일:

```text
scripts/capcut_draft.py
```

추가한 처리:

```text
remove_text_effect_layers_for_colored_caption()
```

동작:

1. 색 지정된 대사 자막 material의 `content.styles[].effectStyle`를 제거한다.
2. `content.effect`가 있으면 제거한다.
3. 해당 segment의 `extra_material_refs`에서 `effects/text_effect`, `effects/bloom`만 제거한다.
4. 나머지 ref, 특히 `material_animations`는 유지한다.

적용 위치:

```text
rebuild_midform_caption_track_from_template()
```

색상이 적용된 caption에만 후처리한다.

## render 결과

TTS 재사용으로 render 1회를 실행했다.

```text
server/output/drafts/pipeline_1784898451
```

render 결과:

- warnings: 없음
- audio track count: `11`
- subtitle track count: `48`
- duration: `107.276999`초
- template markers found: `TEMPLATE_SUBTITLE`, `TEMPLATE_TITLE`, `TEMPLATE_TITLE_SUBLINE`

## 최종 draft 검증

검증 대상:

```text
server/output/drafts/pipeline_1784898451/draft_content.json
```

### 남조연/제드/챠스카 계열 예시

```json
{
  "text": "인질이 셋 있다.",
  "text_color": "#37FF3D",
  "use_effect_default_color": false,
  "useLetterColor": true,
  "hasEffectStyle": false,
  "fill": {
    "content": {
      "render_type": "solid",
      "solid": {
        "color": [0.21568627450980393, 1, 0.23921568627450981],
        "alpha": 1
      }
    },
    "alpha": 1
  },
  "border_color": "",
  "border_width": 0.08,
  "extraRefDetails": [
    {
      "cat": "material_animations",
      "type": "sticker_animation"
    }
  ]
}
```

### 브릿 계열 예시

```json
{
  "text": "로라, 날 떠나지 마.",
  "text_color": "#00A9F7",
  "use_effect_default_color": false,
  "useLetterColor": true,
  "hasEffectStyle": false,
  "fill": {
    "content": {
      "render_type": "solid",
      "solid": {
        "color": [0, 0.6627450980392157, 0.9686274509803922],
        "alpha": 1
      }
    },
    "alpha": 1
  },
  "border_color": "",
  "border_width": 0.08,
  "extraRefDetails": [
    {
      "cat": "material_animations",
      "type": "sticker_animation"
    }
  ]
}
```

## 제거 확인

최종 draft의 색 지정 대사 자막에서 아래가 제거됐다.

- `content.styles[].effectStyle`: 없음
- `extra_material_refs`의 `text_effect`: 없음
- `extra_material_refs`의 `bloom`: 없음

따라서 이전에 보이던 검은 글로우/흰색 재덮임을 만들던 템플릿 효과 레이어는 대사 자막에서 제거됐다.

## 검증 명령

최종 수정 후 아래 명령을 실행했다.

```bash
npm run verify
```

결과:

- `check:encoding`: 통과
- `verify:js`: 통과
- `verify:py`: 통과
- `verify:fixture`: 통과

참고: `report_caption_balance.py`는 기존 fixture 통계에서 `status: failed` JSON을 출력하지만, npm 명령 자체는 정상 종료했다. 이번 수정으로 새로 발생한 실패가 아니다.
