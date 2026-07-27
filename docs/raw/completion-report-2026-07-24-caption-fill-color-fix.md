# 자막 글자색 fill 적용 수정 완료 보고서

## 보고서 위치

- `docs/raw/completion-report-2026-07-24-caption-fill-color-fix.md`

## 최종 산출물

- 최종 draft: `server/output/drafts/pipeline_1784897263`
- 최종 ZIP: `server/output/drafts/pipeline_1784897263.zip`
- 최종 notes: `server/output/drafts/pipeline_1784897263/capcut_notes.md`
- 최종 manifest: `server/output/drafts/pipeline_1784897263/edit_manifest.json`

## 원인 확인

사용자 수동 변경 저장본을 기준으로 CapCut이 “글자색” 변경 시 실제로 쓰는 필드를 확인했다.

기준 파일:

```text
C:/Users/sejun/Desktop/캡컷아웃풋/CapCut Drafts/pipeline_1784884747/draft_content.json
```

확인 결과, CapCut은 글자 본체 색상을 아래 구조에 저장한다.

```json
{
  "content": {
    "styles": [
      {
        "fill": {
          "content": {
            "render_type": "solid",
            "solid": {
              "color": [0.21568627655506134, 1, 0.239215686917305]
            }
          }
        },
        "useLetterColor": true
      }
    ]
  },
  "text_color": "#37ff3d",
  "use_effect_default_color": false
}
```

핵심 필드:

- 글자 본체: `content.styles[].fill.content.solid.color`
- 글자색 사용 플래그: `content.styles[].useLetterColor = true`
- effect 기본색 비활성화: `use_effect_default_color = false`
- 테두리: `border_color`, `border_width` 등은 별도 유지

## 적용 정책

A안으로 적용했다.

- 글자 본체: 화자색 적용
- 테두리: 템플릿 기본 유지
- 그림자/네온 effect: 유지

## 코드 수정

파일:

```text
scripts/capcut_draft.py
```

수정 내용:

- `apply_text_material_fill_color()`에서 `styles[].fill.content.solid.color`에 화자색을 주입한다.
- `styles[].useLetterColor = true`를 추가했다.
- `material.text_color`도 같은 hex 색상으로 맞춘다.
- `material.use_effect_default_color = false`를 유지한다.
- `border_color`, `border_width`, effect refs는 변경하지 않는다.

## 색상 매핑 갱신

파일:

```text
midform/config/caption_colors.json
```

확정 색상:

```json
{
  "남주": "#00A9F7",
  "여주": "#FF55B5",
  "남조연": "#37FF3D",
  "여조연": "#FFC137"
}
```

이번 run 적용:

- 브릿 → `#00A9F7`
- 제드 → `#37FF3D`
- 챠스카 → `#37FF3D`
- 남조연 → `#37FF3D`

## render 결과

TTS 재사용으로 render 1회를 실행했다.

```text
server/output/drafts/pipeline_1784897263
```

render 결과:

- warnings: 없음
- audio track count: `11`
- subtitle track count: `48`
- duration: `107.276999`초
- template markers found: `TEMPLATE_SUBTITLE`, `TEMPLATE_TITLE`, `TEMPLATE_TITLE_SUBLINE`

## 최종 draft 검증

최종 draft에서 대사 자막 material을 확인했다.

### 남조연/제드/챠스카 계열

예시:

```json
{
  "text": "인질이 셋 있다.",
  "text_color": "#37FF3D",
  "use_effect_default_color": false,
  "useLetterColor": true,
  "fill": {
    "content": {
      "render_type": "solid",
      "solid": {
        "color": [0.21568627450980393, 1, 0.23921568627450981],
        "alpha": 1
      }
    },
    "alpha": 1
  }
}
```

### 브릿 계열

예시:

```json
{
  "text": "로라, 날 떠나지 마.",
  "text_color": "#00A9F7",
  "use_effect_default_color": false,
  "useLetterColor": true,
  "fill": {
    "content": {
      "render_type": "solid",
      "solid": {
        "color": [0, 0.6627450980392157, 0.9686274509803922],
        "alpha": 1
      }
    },
    "alpha": 1
  }
}
```

### 테두리/effect 유지

최종 draft에서 대사 자막은 effect를 유지했다.

```json
{
  "extraEffects": ["简约-黑投影", "빛나는 네온", "简约-黑投影"]
}
```

테두리 색은 화자색으로 덮지 않았다. 템플릿 기본 구조를 유지했다.

## 검증 명령

최종 수정 후 아래 검증을 실행했다.

```bash
npm run verify
```

결과:

- `check:encoding`: 통과
- `verify:js`: 통과
- `verify:py`: 통과
- `verify:fixture`: 통과

참고: `report_caption_balance.py`는 기존 fixture 통계에서 `status: failed` JSON을 출력하지만, npm 명령 자체는 정상 종료했다. 이번 수정으로 새로 발생한 실패가 아니다.
