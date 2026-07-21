# 롱폼 프리셋 구조: 2층(크롭+특성) vs 단층 (읽기 전용, 원문)

작성일: 2026-07-21

코드 수정 없음. `processEditService.js VIDEO_TRANSFORM_PRESETS` + `classifyFullDraftTransform`
+ `capcut_draft.py` 원문 인용.

## 결론 먼저: **단층 (single-layer). 2층 아님.**

각 프리셋이 크롭과 소스특성을 **하나에 다 담은 자기완결(self-contained)** 구조.
크롭 베이스와 특성 레이어를 겹쳐 적용하는 코드는 **없음**. 선택은 if/else
**상호배타** — 프리셋 하나만 이김.

## 1. 프리셋 12개의 실제 정의 (crop 필드 원문)

`VIDEO_TRANSFORM_PRESETS` (processEditService.js:53) 12개:

| preset_id | global scale | crop_mode / crop_zoom | pattern 성격 | 분류 |
|---|---|---|---|---|
| steady_zoom_process | 1.22 | (없음) | 제너릭 | base |
| technical_clean_process | 1.20 | (없음) | 제너릭 | base |
| punch_zoom_process | 1.25 | (없음) | 제너릭 | base |
| speed_rhythm_process | 1.22 | (없음) | 제너릭 | base |
| hook_replay_process | 1.25 | (없음) | 제너릭+teaser | base |
| **full_process_hand_focus** | 1.36 | **vertical_fill / true** | hand_setup·manual_detail (특성) | 특성 |
| **full_process_punch_detail** | 1.32 | **vertical_fill / true** | anticipation·impact_hold (특성) | 특성 |
| **full_process_flow_follow** | 1.28 | **vertical_fill / true** | flow_entry·flow_track (특성) | 특성 |
| **full_process_rhythm_scan** | 1.26 | **vertical_fill / true** | rhythm_left·slow_detail (특성) | 특성 |
| **full_process_reveal_context** | 1.24 | **vertical_fill / true** | mystery_close·partial_reveal (특성) | 특성 |
| **full_longform_core_crop** | **2.05** | **vertical_fill / true** (+ pan_limit 0.32, max 2.85) | core_process_entry·left_work_area (**제너릭**) | 롱폼크롭 |
| highlight_hook_zoom_out | 1.55 | (highlight용) | | (highlight세트에도 존재) |

**핵심 관찰:**
- **모든 full 프리셋(process_* + core_crop)이 `crop_mode: vertical_fill` + `crop_zoom: true`를
  자체 포함**한다. 크롭은 별도 레이어가 아님.
- `full_longform_core_crop`은 "크롭 베이스"가 아니라 **크롭이 깊고(2.05~2.85x, pan 0.32)
  pattern이 제너릭(작업영역 좌/우 팬)인 독립 프리셋**. 소스특성 튜닝이 없음.
- `full_process_*`는 "특성 레이어"가 아니라 **자체 크롭(1.24~1.36x base, pattern 최대
  1.88x, vertical_fill)까지 담은 독립 프리셋**. 크롭이 core_crop보다 얕을 뿐.

→ 사용자 가설("core_crop=크롭 베이스, process_*=특성 레이어, 겹쳐 적용")과 달리,
**둘은 겹치는 레이어가 아니라 서로 경쟁하는 대안**이다. 각자 크롭+특성을 다 담음.

## 2. 소스특성 선택 로직 (`classifyFullDraftTransform`:5828) — 숏폼/롱폼 공용

점수(원문):
```
human      = 워커/손 용어 hit + human_presence===true scene 수
impact     = 프레스/절단 용어 + camera_move punch_zoom 수
flow       = 흐름/압출 용어 + scan_left/right/speed_up 수
reveal     = 변신/공개 용어
repetition = 반복 용어
threshold: human ≥ max(2, ceil(sceneCount*0.22)), rhythm ≥ max(2, ceil(sceneCount*0.28))

if (isWideLongformSource)            → 'full_longform_core_crop'   // ★ 특성 무시
else if (human ≥ humanThreshold)     → 'full_process_hand_focus'
else if (impact≥2 | highMotion | punch_zoom) → 'full_process_punch_detail'
else if (flow≥2)                     → 'full_process_flow_follow'
else if (repetition≥2 | avgRep≥7 | actionChange) → 'full_process_rhythm_scan'
else if (reveal≥2 | avgVisualHook≥7.5) → 'full_process_reveal_context'
```

- **Hand Focus vs Punch Detail 구분 기준**: 손/작업자 우세면 hand_focus, 프레스/절단/
  고모션이면 punch_detail (if/else 우선순위: human이 impact보다 먼저).
- **롱폼 재사용 가능한가 → 이미 공용.** `classifyFullDraftTransform`은 숏폼·롱폼 둘 다
  이 함수로 특성을 고른다. 차이는 그 뒤 `selectFullDraftVideoTransformPreset`:
  - **롱폼 non-wide** → 고른 특성 프리셋을 **그대로 적용** (6/27 hand_focus가 1.42~1.88
    pattern 실적용 확인).
  - **롱폼 wide** → 특성 무시하고 `full_longform_core_crop`으로 **덮음**.
  - **숏폼** → `buildShortformFullTemplateSafePreset`가 특성 pattern을 버리고 **고정
    template-safe pattern(1.18~1.48)으로 평탄화**. 고른 특성은 `source_base_preset_id`
    라벨로만 남음.

## 3. 조합 가능성 — 현재는 불가(단층), 구조상은 분리 가능

- **현재**: `classifyFullDraftTransform`이 preset_id **하나**를 반환 → capcut_draft.py가
  그 **하나** 프리셋의 crop_mode+pattern을 함께 적용. **crop-base + 특성-overlay를
  겹치는 merge/compose 코드는 없음**(grep: mergeFullPreset/composePreset/crop_base 0건).
  wide-longform은 core_crop을 받고 특성 pattern을 **잃는다**(상호배타).
- **구조상 분리 가능성**: 프리셋 객체의 필드는 분리되어 있음 —
  크롭 계열(`crop_mode`, `crop_zoom`, `global_transform.scale`, `pan_limit_x/y`,
  `max_zoom_scale`) vs 특성 계열(`pattern`, `segment_unit_sec`, `speed`, `distortion`).
  따라서 "core_crop의 크롭 파라미터를 베이스로 + 특성 프리셋의 pattern을 얹는" 2층
  합성은 **새 코드로 만들 수는 있음**. 단 현재 구현엔 없음.

## 산출 (질문 직접 답)

| 질문 | 답 |
|---|---|
| Full Longform Core Crop이 화면비 크롭 담당·베이스인가 | 크롭이 깊은(2.05~2.85x) 프리셋은 맞지만 **"베이스 레이어"가 아니라 제너릭 pattern까지 담은 독립 프리셋**. 특성 튜닝 없음 |
| Full Process 계열이 소스특성 레이어인가 | **아니오. 자체 크롭(vertical_fill, 1.24~1.36x)까지 담은 독립 프리셋**. 별도 레이어가 아님 |
| 각 프리셋이 크롭을 이미 포함하나 | **예. 모든 full 프리셋이 crop_mode/crop_zoom 내장**. 크롭은 별도 아님 |
| 숏폼 특성선택 로직 롱폼 재사용? | **이미 공용**(classifyFullDraftTransform). 롱폼 non-wide는 특성 pattern 실적용, wide는 core_crop이 덮음, 숏폼은 template-safe로 평탄화 |
| 2층인가 단층인가 | **단층(single-layer).** 각 프리셋이 크롭+특성 올인원, 상호배타 선택. 2층 합성 코드 없음 |

**즉 "Full Process Hand Focus"는 이미 크롭(vertical_fill 1.36~1.88x)을 포함**한다.
다만 그 크롭은 core_crop(2.05~2.85x)보다 얕다.

## 다음 제안 (프로덕션 미반영 — 설계 검토용)

1. **2층 합성이 목표라면 신규 코드 필요**: 현재는 wide-longform이 core_crop을 받으며
   특성(hand/punch/flow) 모션을 잃는다. "16:9 깊은 크롭 + 손/프레스 특성 모션"을
   동시에 주려면, core_crop의 크롭 파라미터(scale/pan_limit/crop_mode)를 베이스로 두고
   특성 프리셋의 `pattern`만 얹는 합성기를 추가해야 함. 필드가 이미 분리돼 있어
   구현은 가능. **프로덕션 트랜스폼 선택 변경이므로 승인 후 진행.**
2. **숏폼 특성 평탄화 확인**: 숏폼은 특성을 골라도 template-safe로 평탄화돼 특성 모션이
   실제로는 안 들어간다(source_base_preset_id 라벨만 남음). 이게 의도(템플릿이 모션
   담당)인지 재확인 권장.
3. **하이라이트와의 대칭**: 하이라이트도 동일하게 단층(`highlight_longform_core_crop`이
   특성 프리셋을 override, 별도 문서 참조). full/highlight 모두 2층으로 갈지 정책 통일 검토.
