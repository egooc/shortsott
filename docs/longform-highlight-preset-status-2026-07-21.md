# 롱폼 하이라이트 프리셋 적용 로직 현황 (읽기 전용, 원문)

작성일: 2026-07-21

코드 수정 없음. 소스코드 원문 + git md5 + 실제 draft manifest 인용.
(FULL 드래프트 트랜스폼은 별도 문서 [longform-cut-edit-logic-status-2026-07-21.md] 참조.
이 문서는 **하이라이트** 프리셋만 다룸.)

## 중요: 프리셋이 두 세트로 나뉨

| 세트 | 정의 위치 | 프리셋 |
|---|---|---|
| **FULL 드래프트** | `processEditService.js` `VIDEO_TRANSFORM_PRESETS` (배열) | Full Longform Core Crop, Full Process Hand Focus/Punch Detail/Flow Follow/Rhythm Scan/Reveal Context, Full Shortform Template Safe Zoom |
| **하이라이트** | `processQueueService.js` `buildHighlightPresetById` (인라인 객체, 7891) | 아래 7종 |

사용자가 나열한 "Full Longform Core Crop / Full Process 계열"은 **FULL 세트**,
"Highlight Hook Zoom Out"은 **하이라이트 세트**. 하이라이트 롱폼 전용은 FULL의
`full_longform_core_crop`이 아니라 **`highlight_longform_core_crop`**(별개).

## 1. 하이라이트 프리셋 정의 (원문 위치 + 파라미터)

`buildHighlightPresetById` (processQueueService.js:7891) 인라인 `presets` 객체:

| preset_id | global scale | max_zoom | 용도 |
|---|---|---|---|
| `highlight_hook_zoom_out` | 1.68 | 2.35 | **fallback** (극단 클로즈업→컨텍스트 줌아웃) |
| **`highlight_longform_core_crop`** | **2.28** | **3.05** | **롱폼 전용** (16:9 가로를 코어공정 세로크롭) |
| `highlight_impact_punch_cut` | 1.84 | 2.45 | 프레스/절단/고모션 |
| `highlight_micro_loop_pulse` | 1.76 | 2.35 | 반복 기계모션 |
| `highlight_flow_tracking` | 1.72 | 2.25 | 압출/컨베이어 흐름 |
| `highlight_human_hand_focus` | 1.82 | 2.45 | 손/작업자 |
| `highlight_mystery_reveal_zoom` | 1.78 | 2.40 | 변신/공개 |

`highlight_longform_core_crop` 원문(7913): `crop_intent: 'core_process_close_crop_from_wide_longform'`,
pattern scale 2.22~2.94, "Treat 16:9 longform as source material, not as a
full-frame vertical video / Crop into the core tool/material interaction at 2.1x to 2.7x".

## 2. 프리셋 선택 로직 (원문): `classifyHighlightHook` (7797)

```
isLongformSource = source_workflow_mode === 'longform_to_shorts'
                || source_type === 'longform'
                || duration_sec >= 90
isWideLongform   = isLongformSource && (!sourceAspect || sourceAspect > 1.25)

// 1) 내용 단서로 프리셋 선택 (impact/repetition/flow/human/mystery)
presetId = 'highlight_hook_zoom_out'  // 기본 fallback
  impact≥1 | punch_zoom | highMotion≥2  → 'highlight_impact_punch_cut'
  repetition≥2 | avgRep≥7 | actionChange≥2 → 'highlight_micro_loop_pulse'
  flow≥1 | speed_up → 'highlight_flow_tracking'
  human≥1 → 'highlight_human_hand_focus'
  mystery≥1 → 'highlight_mystery_reveal_zoom'
shortform_preset_id = presetId  // 위에서 고른 값을 보존

// 2) 롱폼 wide면 OVERRIDE
if (isWideLongform) presetId = 'highlight_longform_core_crop'
```

**답:**
- **롱폼 wide 소스 하이라이트 → `highlight_longform_core_crop` 자동 선택** (2단계 override).
  `shortform_preset_id` 필드에 "wide 아니었으면 골랐을 값"이 남음.
- **숏폼(또는 non-wide) → 내용 단서 기반 프리셋 or `highlight_hook_zoom_out` fallback.**
- **소스 길이/타입 분기 존재**: `≥90s || source_type longform || longform_to_shorts` +
  wide-aspect(`!aspect || aspect>1.25`) 게이트.
- **"Steady Zoom"은 하이라이트에 없음** — 그건 FULL/base 프리셋(`steady_zoom_process`).
  숏폼 하이라이트도 1.68~1.84x로 충분히 공격적(FULL 숏폼 1.18~1.5x와 다름). 즉
  하이라이트에서 "숏폼 프리셋이 롱폼에 잘못 적용"의 형태는 롱폼인데 core_crop 대신
  `highlight_hook_zoom_out`/내용프리셋이 찍히는 것(그 경우가 갭).

## 3. 실제 적용된 프리셋 (manifest 원문 인용)

### 롱폼 소스 하이라이트 (2026-07-11, 最新設備が魅せる材料の高速変形)
```
video_transform_preset_id: highlight_longform_core_crop
global base_scale: 2.28 (applied:true) | max_zoom: 3.05 | pattern scales: [2.58,2.94,2.48,2.82,2.22]
crop_intent: core_process_close_crop_from_wide_longform
hook_analysis.wide_longform_core_crop: true | source_aspect_ratio: 1.778
source_type: longform | source_workflow_mode: longform_to_shorts
shortform_preset_id: highlight_mystery_reveal_zoom   ← wide 아니었으면 이걸 골랐을 것
reason: wide_longform_requires_core_process_crop_for_9_16_highlight
```
→ **롱폼 전용 `highlight_longform_core_crop`이 실제로 적용됨.** 16:9(aspect 1.778) 진짜
롱폼 소스에서 override가 정상 발동. **정상.**

### 현재/최근 하이라이트 (2026-07-19~21, 전부 숏폼 소스)
```
highlight_impact_punch_cut   (ワイヤーがネジ / クリケットボール / プラスチック椅子 등)
highlight_flow_tracking      (ペレットが鍋に)
highlight_human_hand_focus   (丸鋸が石板切断)
```
전부 `wide_longform_core_crop: false`. → 숏폼 소스라 내용 기반 프리셋 적용(정상).
`highlight_longform_core_crop` 아님 — **이건 갭이 아니라 소스가 숏폼이기 때문.**

## 요약

| 질문 | 답 |
|---|---|
| 롱폼 전용 하이라이트 프리셋 존재? | 예. `highlight_longform_core_crop`(global 2.28x, max 3.05x), `buildHighlightPresetById`(7891)에 정의 |
| 롱폼 하이라이트에 자동 선택되나? | 예. `classifyHighlightHook`이 `isWideLongform`이면 override로 자동 선택 |
| 소스 길이/타입 분기? | 예. `≥90s ∥ source_type longform ∥ longform_to_shorts` + wide-aspect 게이트 |
| 실제 적용됐나? | **예 — 2026-07-11 최신設備(16:9 longform)에서 `highlight_longform_core_crop` 실적용 확인.** 현재 큐는 전부 숏폼이라 지금은 내용기반 숏폼 프리셋만 적용(정상) |
| 8f97458 대비 | `classifyHighlightHook` / `buildHighlightPresetById` 둘 다 **byte-identical**(md5 일치). exact 사태 영향 없음 |

**결론: 롱폼 하이라이트 프리셋 선택은 정상.** FULL 경로(core_crop이 선택 프리셋으로
실적용된 적 0회)와 달리, **하이라이트는 롱폼 전용 프리셋이 실제 롱폼 소스에서 발동한
이력이 있음**(2026-07-11). 현재 숏폼-only 큐에선 안 도는 게 정상.

## 다음 제안

1. **롱폼 소스 재검증**: FULL 문서와 동일 — 현재 큐엔 롱폼 소스가 없어 라이브로 안 돈다.
   롱폼(16:9) 소스 1개로 하이라이트 생성 시 `highlight_longform_core_crop`이 다시
   찍히는지 확인하면 현재 워킹트리에서의 실동작을 재확인 가능.
2. **FULL과 하이라이트의 롱폼 실적용 격차**: 하이라이트는 core_crop 실적용 이력이 있는데
   FULL은 없다. FULL의 `isWideLongform`은 width/height 실측이 필요한데(source_dims 비면
   false), 하이라이트의 `isWideLongform`은 `!aspect`도 wide로 간주 → 하이라이트가 더
   쉽게 발동. FULL도 aspect 미상일 때 wide로 볼지 정책 통일 검토(단 프로덕션 변경이므로
   승인 필요).
