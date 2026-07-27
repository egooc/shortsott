# 자막 이중 테두리/글로우 원인 조사 보고서

## 보고서 위치

- `docs/raw/investigation-report-2026-07-24-caption-double-outline-glow.md`

## 현상

최종 draft에서 대사 자막이 아래처럼 보이는 문제가 확인됐다.

```text
검은 글로우/외곽 → 화자색 → 흰색 또는 밝은 내부 레이어
```

사용자 표현 기준:

```text
테두리가 2개다. 글로우가 블랙으로 잡혀 있고 그 안에 지정 색상, 그리고 다시 화이트.
```

## 조사 대상

최종 draft:

```text
server/output/drafts/pipeline_1784897263/draft_content.json
```

템플릿 source:

```text
templates/capcut/channel_default/실패한 아내를 질책한 남편의 숨겼던 진심/draft_content.json
```

## 핵심 결론

원인은 `border_color` 하나가 아니다.

현재 대사 자막은 같은 텍스트에 아래 효과가 동시에 적용된다.

1. 본문 글자 fill 색상
2. `content.styles[].effectStyle` 안의 텍스트 효과
3. `segment.extra_material_refs` 안의 `text_effect`
4. `segment.extra_material_refs` 안의 `bloom`
5. 같은 `text_effect`가 extra refs에 중복으로 한 번 더 들어감

즉, 화면의 3중 구조는 “테두리 하나”가 아니라 템플릿의 텍스트 효과 레이어가 중복 렌더링되는 구조다.

## 최종 draft 증거

예시 자막:

```text
인질이 셋 있다.
```

최종 material:

```json
{
  "text_color": "#37FF3D",
  "use_effect_default_color": false,
  "border_color": "",
  "border_width": 0.08
}
```

본문 fill:

```json
{
  "content": {
    "styles": [
      {
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
        "useLetterColor": true,
        "effectStyle": {
          "id": "7337691116579327237",
          "path": "C:/Users/sejun/AppData/Local/CapCut/User Data/Cache/effect/7337691116579327237/43037b8f074685657acc1fe10c00e82e"
        }
      }
    ]
  }
}
```

segment extra refs:

```json
[
  {
    "cat": "material_animations",
    "type": "sticker_animation"
  },
  {
    "cat": "effects",
    "name": "简约-黑投影",
    "type": "text_effect",
    "effect_id": "7337691116579327237"
  },
  {
    "cat": "effects",
    "name": "빛나는 네온",
    "type": "bloom",
    "effect_id": "7194814295517958657"
  },
  {
    "cat": "effects",
    "name": "简约-黑投影",
    "type": "text_effect",
    "effect_id": "7337691116579327237"
  }
]
```

중요한 점:

- `简约-黑投影`가 `content.styles[].effectStyle`에도 있다.
- 같은 `简约-黑投影`가 `extra_material_refs`에도 있다.
- `extra_material_refs` 안에서는 같은 `text_effect`가 두 번 반복된다.
- 그 사이에 `빛나는 네온` bloom도 들어 있다.

따라서 화면에 보이는 검은 glow/외곽은 `border_color`보다 `简约-黑投影`와 `빛나는 네온` 조합에서 나올 가능성이 높다.

## 템플릿 source도 같은 구조

`TEMPLATE_SUBTITLE` 원본도 같은 구조를 갖고 있다.

템플릿 source:

```json
{
  "text": "TEMPLATE_SUBTITLE",
  "border_color": "",
  "border_width": 0.08,
  "use_effect_default_color": true,
  "content.styles[0].effectStyle.id": "7337691116579327237"
}
```

템플릿 extra refs:

```json
[
  "material_animations/sticker_animation",
  "effects/简约-黑投影/text_effect",
  "effects/빛나는 네온/bloom",
  "effects/简约-黑投影/text_effect"
]
```

즉, 현재 코드는 템플릿 source를 충실히 복제하면서 이 효과 구조까지 그대로 가져오고 있다.

## 왜 흰색이 다시 보이는가

현재 글자 본체 fill은 `#37FF3D` 또는 `#00A9F7`로 들어가 있다.

하지만 `简约-黑投影` 텍스트 효과가 `effectStyle`과 `extra_material_refs` 양쪽에 존재하고, 템플릿 원본의 기본 색 계열이 흰색이다.

가능성이 높은 렌더 순서:

1. bloom/text effect가 외곽 glow를 만든다.
2. 본문 fill이 화자색으로 칠해진다.
3. text effect 내부의 기본 fill/하이라이트 계층이 다시 밝은색 또는 흰색 레이어를 얹는다.

따라서 `use_effect_default_color=false`와 `useLetterColor=true`만으로는 충분하지 않다. 글자 본체 fill은 바뀌었지만, text effect 자체가 별도의 기본색/하이라이트 레이어를 렌더링한다.

## 왜 “테두리 2개”처럼 보이는가

JSON상 명시 border는 다음 상태다.

```json
{
  "border_color": "",
  "border_width": 0.08,
  "border_alpha": 1,
  "border_mode": 0
}
```

그러나 실제 시각적 외곽은 이 border만이 아니다.

추가로 아래가 있다.

- `content.styles[].effectStyle`: `简约-黑投影`
- `extra_material_refs`: `简约-黑投影`
- `extra_material_refs`: `빛나는 네온`
- `extra_material_refs`: 중복 `简约-黑投影`

그래서 CapCut 화면에서는 border 하나가 아니라 effect 기반 외곽/글로우가 겹쳐 보인다.

## 코드상 복제 경로

파일:

```text
scripts/capcut_draft.py
```

관련 경로:

- `rebuild_midform_caption_track_from_template()`
  - `TEMPLATE_SUBTITLE` material을 clone한다.
  - `apply_text_material_fill_color()`로 fill 색을 바꾼다.
  - 이후 `clone_material_dependencies()`로 `extra_material_refs`를 그대로 복제한다.

핵심 흐름:

```text
TEMPLATE_SUBTITLE source material
→ cloned_material
→ fill/text_color/useLetterColor만 변경
→ effectStyle는 유지
→ extra_material_refs도 유지
```

이 때문에 본문 fill만 바꾸고 text effect/bloom 레이어는 그대로 남는다.

## 결론

현재 문제는 “색이 stroke에 들어갔다”만의 문제가 아니라, 템플릿 subtitle source가 가진 effect 구조가 너무 강하게 살아 있어서 발생한다.

정확한 원인:

```text
TEMPLATE_SUBTITLE의 effectStyle + 중복 text_effect extra refs + bloom이 그대로 복제되어,
화자색 fill 위/아래로 검은 글로우와 흰색 효과 레이어가 같이 렌더링된다.
```

## 다음 수정 방향 제안

선택지는 두 가지다.

### A안 — 대사 자막만 text effect 제거, 기본 border 유지

가장 확실하다.

- 대사 자막 material에서 `content.styles[].effectStyle` 제거
- 대사 자막 segment에서 `extra_material_refs` 중 `text_effect`, `bloom` 제거
- `border_width`, `border_color`는 템플릿 기본 또는 정책값 유지
- 글자 fill은 화자색 유지

장점:

- 검은 glow/흰색 재덮임 제거 가능성이 가장 높다.
- 글자 본체 색이 가장 선명해진다.

단점:

- 기존 템플릿의 네온/그림자 느낌이 사라진다.

### B안 — `effectStyle`만 제거하고 extra refs 유지

중간안이다.

- material 내부 `content.styles[].effectStyle`만 제거
- extra refs는 유지

장점:

- 일부 템플릿 효과를 유지할 수 있다.

단점:

- `extra_material_refs`에 같은 `text_effect`가 두 번 있고 bloom도 있어서, 문제 재발 가능성이 있다.

### 추천

A안을 추천한다.

이번 목적이 “화자색 자막을 명확하게 보이게 하는 것”이라면, 대사 자막에 한해서 text effect/bloom을 제거하고 border만 단순하게 유지하는 편이 가장 안정적이다.
