# Source Video 프레이밍 조사 보고서

- 작성일: 2026-07-25
- 대상 draft: `server/output/drafts/pipeline_1784906226/draft_content.json`
- 대상 manifest: `server/output/drafts/pipeline_1784906226/edit_manifest.json`
- 비교 템플릿: `templates/capcut/channel_default/실패한 아내를 질책한 남편의 숨겼던 진심/draft_content.json`
- 조사 범위: 최종 draft의 `source_video` 세그먼트 `scale`, `transform`, `crop`, 캔버스/표시 영역, 값의 출처, 템플릿 수정 반영 여부
- 코드 수정 여부: 없음

## 결론

현재 최종 draft의 실제 `source_video` 배율은 **8개 세그먼트가 1.8**, **1개 세그먼트가 2.0**입니다. 모든 `source_video` 세그먼트는 `crop: null`이며, `clip.scale`과 `uniform_scale.value`가 같은 값으로 들어갑니다.

이 값은 템플릿에서 그대로 복제된 값이 아니라, `scripts/capcut_draft.py`의 `apply_midform_portrait_crops_to_draft(...)` 단계에서 렌더 때마다 다시 계산/덮어쓰기 됩니다. 따라서 사용자가 CapCut에서 템플릿의 `source_video` 클립 크기나 위치를 조정해 저장해도, 현재 midform render에서는 다음 draft의 활성 `source_video` 프레이밍에 그대로 반영되지 않습니다.

## 1. 최종 draft `source_video` 세그먼트 값 덤프

최종 draft에는 `source_video` 비디오 트랙 세그먼트가 9개 있습니다.

| # | target start | duration | source start | scale | transform.x | transform.y | crop | uniform_scale |
|---:|---:|---:|---:|---:|---:|---:|---|---:|
| 1 | 0.000s | 6.191s | 325.331s | 1.8 | -0.091100 | 0.028000 | null | 1.8 |
| 2 | 6.191s | 8.464s | 3.199s | 1.8 | 0.047031 | 0.028000 | null | 1.8 |
| 3 | 14.655s | 13.610s | 95.280s | 1.8 | -0.039512 | 0.028000 | null | 1.8 |
| 4 | 28.265s | 3.510s | 261.720s | 1.8 | -0.083581 | 0.028000 | null | 1.8 |
| 5 | 31.775s | 10.450s | 282.560s | 1.8 | -0.071367 | 0.028000 | null | 1.8 |
| 6 | 42.225s | 12.801s | 332.260s | 2.0 | -0.053913 | 0.028000 | null | 2.0 |
| 7 | 55.026s | 2.020s | 402.530s | 1.8 | -0.039284 | 0.028000 | null | 1.8 |
| 8 | 57.046s | 4.441s | 412.629s | 1.8 | 0.083718 | 0.028000 | null | 1.8 |
| 9 | 61.487s | 13.166s | 417.070s | 1.8 | -0.058151 | 0.028000 | null | 1.8 |

요약:

- `scale` 분포: `{1.8: 8, 2.0: 1}`
- `transform.y`: 전부 `0.028`
- `transform.x`: `-0.091100` ~ `0.083718`
- `crop`: 전부 `null`
- `uniform_scale.on`: 전부 `true`

## 2. 값의 출처

### 코드 위치

프레이밍을 최종 적용하는 함수는 다음입니다.

- `scripts/capcut_draft.py:2407`  
  `apply_midform_portrait_crops_to_draft(draft_content_path, video_cut_placements, segment_type_map, canvas_width, canvas_height, source_video_path="", gemini_analysis=None)`

현재 상수는 다음 위치에 있습니다.

- `scripts/capcut_draft.py:1776` `MIDFORM_CROP_FINAL_SCALE_CAP = 2.0`
- `scripts/capcut_draft.py:1777` `MIDFORM_MULTI_PERSON_FINAL_SCALE_TARGET = 1.8`
- `scripts/capcut_draft.py:1778` `MIDFORM_SINGLE_PERSON_FINAL_SCALE_TARGET = 2.0`
- `scripts/capcut_draft.py:1779` `MIDFORM_NARRATION_FINAL_SCALE_MIN = 1.8`
- `scripts/capcut_draft.py:1780` `MIDFORM_NARRATION_FINAL_SCALE_TARGET = 1.8`
- `scripts/capcut_draft.py:1781` `MIDFORM_DIALOGUE_FINAL_SCALE_MIN = 1.8`
- `scripts/capcut_draft.py:1782` `MIDFORM_DIALOGUE_FINAL_SCALE_TARGET = 2.0`
- `scripts/capcut_draft.py:1783` `MIDFORM_DIALOGUE_SHOT_SCALE_BONUS = 0.0`

실제 덮어쓰기 지점은 다음입니다.

- `scripts/capcut_draft.py:2510`  
  얼굴 감지 결과가 있으면 `faces_count > 1`은 `1.8`, 단독은 `2.0`으로 재지정합니다.
- `scripts/capcut_draft.py:2515`  
  `transform_x = round((0.5 - anchor_x) * 0.35, 6)`
- `scripts/capcut_draft.py:2516`  
  `transform_y = round((0.5 - anchor_y) * 0.35, 6)`
- `scripts/capcut_draft.py:2520`  
  `clip["scale"] = {"x": applied_scale, "y": applied_scale}`
- `scripts/capcut_draft.py:2521`  
  `clip["transform"] = {"x": transform_x, "y": transform_y}`
- `scripts/capcut_draft.py:2522`  
  `segment["uniform_scale"] = {"on": True, "value": applied_scale}`

이 함수는 템플릿 clone/passthrough 처리 뒤에 호출됩니다.

- `scripts/capcut_draft.py:10790-10816`: 템플릿 clone/passthrough
- `scripts/capcut_draft.py:10817-10825`: `apply_midform_portrait_crops_to_draft(...)` 호출

즉, 템플릿 기반 구조를 만든 뒤 최종 `source_video` 프레이밍은 별도 portrait crop 단계에서 다시 확정됩니다.

### 템플릿과 최종 draft 비교

템플릿의 `source_video` 트랙에는 18개 세그먼트가 있고, 값 분포는 다음입니다.

- 템플릿 scale 분포: `{1.8: 13, 1.5: 5}`
- 템플릿 transform 분포:
  - `(x=0, y=0.0455)`: 13개
  - `(x=0, y=0.028)`: 5개

최종 draft는 9개 세그먼트이며, 값 분포가 다음처럼 달라졌습니다.

- 최종 draft scale 분포: `{1.8: 8, 2.0: 1}`
- 최종 draft transform.y: 전부 `0.028`
- 최종 draft transform.x: 얼굴 anchor 기반으로 세그먼트별 가변

따라서 현재 최종 draft의 `source_video` clip 값은 템플릿 `source_video` 세그먼트를 단순 복제한 결과가 아닙니다.

## 3. 캔버스 크기와 영상 표시 영역 실측

최종 draft 기준:

- 캔버스: `1080 x 1920`
- 소스 영상: `3840 x 2160`
- 소스 비율: 16:9
- 캔버스 비율: 9:16
- manifest의 crop method: `portrait_180_multi_200_single_uniform_vertical_face_anchor`
- 얼굴 anchor 감지: 9개 세그먼트 모두 감지됨
- anchor.y: 전부 `0.42`

16:9 소스를 9:16 캔버스에 세로 기준으로 채우면, base vertical-fill 상태에서 표시 영상은 대략 `3413.333 x 1920px`로 캔버스를 덮고 좌우가 잘리는 구조입니다.

현재 적용 scale별 계산은 다음과 같습니다.

| scale | 캔버스 위 표시 영상 크기 추정 | 캔버스 실제 커버 영역 | 소스에서 보이는 샘플 영역 추정 |
|---:|---:|---:|---:|
| 1.8 | 약 `6144 x 3456px` | `1080 x 1920px` 전체 | 약 `675 x 1200px` |
| 2.0 | 약 `6826.667 x 3840px` | `1080 x 1920px` 전체 | 약 `607.5 x 1080px` |

해석:

- 화면에서 영상은 여전히 세로 캔버스 `1920px` 전체를 덮습니다.
- 다만 `scale`이 커질수록 원본에서 실제로 보이는 영역은 더 좁아집니다.
- 1.8은 원본 세로 약 `1200px` 범위를 사용하고, 2.0은 원본 세로 약 `1080px` 범위를 사용합니다.
- 별도의 CapCut `crop` 오브젝트는 쓰지 않고, `scale + transform`으로 프레이밍합니다.

## 4. 템플릿에서 소스 클립 크기·위치를 조정하면 다음 render에 반영되는가?

현재 구조에서는 **활성 midform `source_video` 프레이밍에는 반영되지 않는다고 보는 것이 맞습니다.**

근거:

1. `is_template_passthrough_track(...)`에서 `source_video`, `video`, `main_video`, `source footage` 계열 트랙은 passthrough 대상에서 제외됩니다.  
   - 위치: `scripts/capcut_draft.py:1589-1600`
2. 템플릿 clone/passthrough 이후 `apply_midform_portrait_crops_to_draft(...)`가 항상 호출됩니다.  
   - 위치: `scripts/capcut_draft.py:10817-10825`
3. 이 함수가 최종 draft의 `source_video` 세그먼트마다 `clip.scale`, `clip.transform`, `uniform_scale`을 직접 덮어씁니다.  
   - 위치: `scripts/capcut_draft.py:2520-2522`
4. 실제 결과에서도 템플릿 값과 최종 값이 다릅니다. 템플릿에는 1.5 scale 세그먼트가 남아 있지만, 최종 draft에는 1.5가 없습니다.

따라서 CapCut에서 템플릿의 `source_video` 클립을 수동 조정해 저장하더라도, 현재 render 경로에서는 코드의 portrait crop 정책이 우선합니다. 템플릿에서 조정한 source geometry를 반영하려면, 별도 코드 변경으로 `source_video` 템플릿 geometry를 읽어 적용하거나 portrait crop override를 끄는 설정이 필요합니다.

## 5. 현재 상태 요약

- 요청된 조사는 read-only로 수행했습니다.
- `scripts/capcut_draft.py` 등 코드 파일은 이번 조사에서 수정하지 않았습니다.
- 보고서 파일만 새로 작성했습니다.
- 최종 판단: 지금 실제 배율은 `1.8/2.0`이고, 값의 출처는 템플릿이 아니라 `apply_midform_portrait_crops_to_draft(...)`의 계산/상수/얼굴 anchor 결과입니다.
