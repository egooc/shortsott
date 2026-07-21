# 롱폼 하이라이트 2층 프리셋 (깊은 크롭 + 소스특성) — 격리 구현·검증

작성일: 2026-07-21
상태: **사용자 CapCut 육안 통과 → 프로덕션 활성화 완료.** wide 16:9 롱폼 소스에 자동 적용
(kill switch: 아이템에 `highlight_two_layer_longform: false` 주면 generic core_crop 폴백).
숏폼 무회귀.

## 프로덕션 활성화 (2026-07-21, 육안 통과 후)

격리 검증(플래그 OFF) 통과 + 사용자 재생 육안 통과(깊게 크롭돼 꽉 참 + 특성 움직임 살아있음)
→ 플래그를 **기본 자동 적용 + 명시적 opt-out**으로 전환:
```
isLongformHighlightTwoLayerEnabled: highlight_two_layer_longform !== false  // 기본 ON
buildHighlightHookZoomOutPreset:
  if (analysis.wide_longform_core_crop && analysis.shortform_preset_id && enabled)
    → buildLongformHighlightTwoLayerPreset   // wide 롱폼 자동 2층
```
재검증(결정적): 숏폼→`highlight_impact_punch_cut`(불변), wide 롱폼(플래그 없음)→
`highlight_longform_core_crop__highlight_impact_punch_cut`@2.28x(자동 2층), kill switch
false→`highlight_longform_core_crop`(generic 폴백). 3/3 PASS + `npm run verify` 통과.

## 원칙 준수

- **숏폼 하이라이트 경로 절대 불변**: `classifyHighlightHook`, `buildHighlightPresetById`
  둘 다 8f97458와 **byte-identical**(md5 `80b6031…`, `d54706d…` 일치). 수정 안 함.
- **격리**: 2층 로직은 아이템 플래그 `highlight_two_layer_longform`(기본 **OFF**) 뒤에만
  발동. OFF면 현재 프로덕션(숏폼 + wide 롱폼 core_crop) 동작 100% 그대로.
- **2-하이라이트 동시 진행 안 함.**

## 구현 (processQueueService.js, 롱폼 분기만 추가)

`buildHighlightHookZoomOutPreset`에 플래그 게이트 분기 1개 추가:
```
const analysis = classifyHighlightHook(itemConfig, window);   // ← 불변, 재사용
if (analysis.wide_longform_core_crop === true
    && analysis.shortform_preset_id
    && isLongformHighlightTwoLayerEnabled(itemConfig)) {        // ← 기본 OFF
  return buildLongformHighlightTwoLayerPreset(analysis, basePreset);   // ← 신규 2층
}
return buildHighlightPresetById(analysis.preset_id, basePreset, analysis);  // ← 기존 경로
```

`buildLongformHighlightTwoLayerPreset` (신규):
- **베이스(크롭 레이어)**: `highlight_longform_core_crop`의 깊은 크롭 파라미터
  (global scale 2.28, max_zoom 3.05, pan_limit 0.33, crop_mode vertical_fill).
- **특성 레이어**: `classifyHighlightHook`이 이미 고른 `shortform_preset_id`
  (손→`highlight_human_hand_focus`, 임팩트→`highlight_impact_punch_cut` 등)의
  pan/rotation/speed/duration pattern을 가져와, scale만 깊은 크롭 범위[2.28, 3.05]로
  리맵. → 깊은 크롭 + 특성 움직임을 한 프리셋에 합성.
- 크롭은 프리셋 내장이라 자동 적용(별도 처리 없음).

## 검증 (인용값)

### 1. 결정적 로직 테스트 (`__test.buildHighlightHookZoomOutPreset` 직접 호출) — 9/9 PASS
```
PASS | shortform not two-layer
PASS | shortform preset is a highlight_* content/fallback preset
PASS | longform hand -> two-layer with hand_focus
PASS | longform hand -> deep crop scale 2.28
PASS | longform hand -> two_layer evidence present
PASS | longform impact -> two-layer with impact_punch_cut (differentiated)
PASS | hand vs impact produce DIFFERENT presets
PASS | longform pattern min scale >= 2.0 (deep crop floor applied)
PASS | flag OFF -> generic core_crop (isolation, unchanged)
```
- 손 scene → `highlight_longform_core_crop__highlight_human_hand_focus`, global 2.28x,
  pattern [2.713, 3.05, 2.569, 2.28] (hand 4세그 모션 + 깊은 크롭).
- 임팩트 scene → `highlight_longform_core_crop__highlight_impact_punch_cut`,
  pattern [2.638, 3.05, 2.423, 2.853, 2.28] (punch 5세그). **손≠임팩트 확인.**
- 플래그 OFF → `highlight_longform_core_crop`(generic) 그대로 = 격리 확인.
- 숏폼 → `highlight_human_hand_focus`(1.82x) = 숏폼 프리셋 불변.

### 2. 실제 edit_manifest.json (worker 생성, end-to-end) — 임팩트 케이스 인용
격리 롱폼 테스트 아이템(source_type=longform, 16:9 wide 메타, 플래그 ON) →
worker 드래프트 → `edit_manifest.json`:
```
video_transform_preset_id: highlight_longform_core_crop__highlight_impact_punch_cut
two_layer_longform_highlight: {
  enabled: true, crop_base_preset_id: highlight_longform_core_crop,
  crop_base_scale: 2.28, crop_base_max_zoom: 3.05,
  characteristic_preset_id: highlight_impact_punch_cut,
  characteristic_preset_name: "Highlight Impact Punch Cut",
  pattern_scale_range: [2.28, 3.05]
}
pattern scales: [2.638, 3.05, 2.423, 2.853, 2.28]
```
→ **manifest에 크롭 배율(2.28~3.05) + 적용 특성 이름(Highlight Impact Punch Cut)
둘 다 실제로 기록됨.**

### 3. 숏폼 회귀 없음
`classifyHighlightHook` / `buildHighlightPresetById` byte-identical + 플래그 OFF 기본값
→ 숏폼·현재 wide-롱폼 경로 동작 불변(결정적 테스트로 재확인).

## 미완 / 정직한 한계

- **실제 hand_focus manifest는 못 뽑음**: 검증에 쓴 격리 아이템은 item_016
  (금属棒/press/볼트 = 임팩트 지배 소재)을 복제한 것이라, scene·guide 텍스트를
  손작업으로 덮어도 `classifyHighlightHook`이 계속 임팩트로 판정(impact가 if/else
  우선). 즉 **hand vs impact 실제-manifest 대조는 못 했고, 대신 결정적 테스트로 증명**.
  진짜 손작업 지배 16:9 롱폼 소스가 있으면 실제 hand_focus manifest도 나온다.
- **CapCut 육안 미완**: 테스트 draft는 세로 소스를 강제 wide 처리한 것이라 시각적으로
  대표성이 없음(정리 시 삭제함). **진짜 16:9 롱폼 소스로 2층 draft를 뽑아 육안 확인
  필요** — 이게 프로덕션 반영 전 마지막 관문.

## 다음 (사용자 결정 대기 — 프로덕션 미반영 유지)

1. **진짜 16:9 롱폼 소스 1개**를 큐에 넣고, 그 아이템에 `highlight_two_layer_longform: true`
   플래그를 준 뒤 하이라이트 생성 → 실제 hand/impact 다른 manifest + CapCut 육안
   (깊게 크롭돼 꽉 차면서 특성 움직임 살아있나) 확인.
2. 육안 통과 시 → 플래그를 프로덕션 기본 ON으로 전환(또는 wide-롱폼 자동 적용) + 커밋.
3. 현재 코드는 uncommitted(플래그 OFF라 프로덕션 무영향). 체크포인트로 먼저 커밋할지는
   사용자 지시 대기.
