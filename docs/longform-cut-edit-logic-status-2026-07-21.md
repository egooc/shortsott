# 롱폼 컷 편집 로직 현황 (읽기 전용, 원문)

작성일: 2026-07-21

코드 수정 없음. 전부 소스코드 원문 + git + 실제 draft manifest에서 인용.

## 1. 롱폼 full 편집이 숏폼과 어떻게 다르게 들어가나

### 분기점 (원문): `selectFullDraftVideoTransformPreset` (processQueueService.js:5908)

```
isLongformSource = source_workflow_mode === 'longform_to_shorts' || source_type === 'longform'

1) requiresLongformCoreCrop (source_window_strategy === 'longform_full_from_highlight_candidates')
   → 'full_longform_core_crop'
2) else if (!isLongformSource)  ← 숏폼 분기
   → buildShortformFullTemplateSafePreset(...)  # zoom ≤1.5x 캡
3) else (롱폼)
   → classifyFullDraftTransform가 고른 full_process_* 프리셋 (또는 wide면 core_crop)
```

`classifyFullDraftTransform`(5828)의 롱폼 wide 분기:
```
isWideLongformSource = isLongformSource && width > height*1.2
  → 'full_longform_core_crop'  (16:9 가로 소스를 세로 9:16 코어공정으로 크롭)
```

하이라이트는 완전히 다른 빌더(`buildHighlightHookZoomOutPreset`, 8054) 사용.

### 프리셋 파라미터 원문 (processEditService.js `VIDEO_TRANSFORM_PRESETS`)

| 항목 | 롱폼 wide `full_longform_core_crop` | 롱폼 non-wide 예: `full_process_hand_focus` | 숏폼 full `full_shortform_template_safe_zoom` |
|---|---|---|---|
| global scale | **2.05** | ~1.36 | **1.18** |
| max_zoom_scale | **2.85** | (캡 없음) | **1.50** (하드캡) |
| pattern scale 범위 | 2.12~2.62 | 1.42~1.88 | 1.18~1.48 |
| pan_limit_x | 0.32 | — | 0.12 |
| distortion | strong_rotation 1.4° | — | soft_rotation 1.0° |
| crop_intent | core_process_close_crop_from_wide_longform_full | — | shortform_full_template_safe_under_50_percent_zoom |
| 이유(원문) | "crop into one core process area for a vertical 9:16 edit instead of shrinking the full horizontal frame" | "hands_or_workers_dominate_full_draft" | "keep visual zoom at 1.50x or lower because the CapCut template supplies the stronger motion layer" |

**핵심 차이**: 숏폼 full은 CapCut 템플릿이 모션을 담당하므로 zoom을 **1.5x로
하드캡**하고 약한 회전(soft 1.0°). 롱폼 full은 가로 원본을 세로로 **깊게 크롭
(2.05~2.85x)**하고 강한 회전(strong 1.4°)·큰 pan(0.32)으로 리프레이밍. 숏폼은
"이미 세로인 소스 + 템플릿 보강", 롱폼은 "가로 소스를 세로 공정샷으로 재구성".

### 적용 메커니즘

`capcut_draft.py`가 `get_process_zoom_scale`/`get_process_speed_value`/
`get_process_crop_mode`로 프리셋의 scale/speed/crop을 읽어 세그먼트별 트랜스폼으로
조립. (Node가 프리셋 선택 → Python이 실제 적용)

## 2. 이 로직이 8f97458(복원 기준)에 살아있나

| 확인 | 결과 |
|---|---|
| 워킹트리 | **clean** (uncommitted 없음) |
| `capcut_draft.py` vs 8f97458 | **diff 0** (완전 복원 — 조립/적용 경로 baseline) |
| `selectFullDraftVideoTransformPreset` vs 8f97458 | **byte-identical** (md5 04156d63… 일치) |
| `classifyFullDraftTransform` / `buildShortformFullTemplateSafePreset` | HEAD↔8f97458 diff에 미포함 = 불변 |
| `VIDEO_TRANSFORM_PRESETS` (프리셋 정의) | 불변 (processEditService.js 29줄 변경은 **전부 Korean Full SRT/자막 배송** 관련, 트랜스폼 프리셋 미포함) |

**exact 모드 사태 영향 없음**: 그 사태는 하이라이트 window **선택**
(`pickHighlightWindow` 계열, `variant_policy_id: *_exact`) 경로였고, full 트랜스폼
선택은 별개 함수라 손대지 않았음. → 현재 워킹트리에서 롱폼 full 편집은 원래대로 돔.

## 3. 현재 롱폼 draft가 실제로 그 편집을 타는지

### 실제 적용된 프리셋 (manifest 원문 인용)

**롱폼 소스 (2026-06-27, 素材が変わる工場, `source_type: longform` / `longform_to_shorts`):**
```
APPLIED preset_id: full_process_hand_focus
global scale: 1.36 | pattern scales: [1.42,1.74,1.88,1.52,1.66]
analysis reason: hands_or_workers_dominate_full_draft
```
→ 롱폼 브랜치가 실제로 발동해 숏폼보다 깊은 zoom(1.42~1.88, ≤1.5 캡 없음) 적용.

**숏폼 소스 (2026-07-21, item_004 크리켓 공, `source_type: shortform` / `shortform_direct`):**
```
APPLIED preset_id: full_shortform_template_safe_zoom
global scale: 1.18 | max_zoom: 1.5 | pattern scales: [1.18,1.32,1.48,1.26,1.42]
analysis reason: shortform_full_uses_capcut_template_so_zoom_is_capped_under_50_percent
```
→ 숏폼 브랜치가 발동해 ≤1.5x 캡 적용.

**결론: 숏폼과 다른 편집이 실제 draft에 들어감** — 소스 분류에 따라 롱폼은 deep-zoom
프리셋, 숏폼은 template-safe 캡 프리셋이 manifest에 실제로 기록·적용됨.

### 주의점 2가지

1. **현재 큐엔 롱폼 소스가 0개.** 큐 17개 전부 `source_type: shortform` /
   `shortform_direct` (11~59s). 따라서 **지금 생성되는 full draft는 전부
   `full_shortform_template_safe_zoom`(≤1.5x)** 만 적용됨. 롱폼 편집은 코드상
   살아있으나 현재 소스로는 발동 안 함(롱폼 draft는 6/27~7/1 옛 것뿐, 지금 recycle_bin).

2. **`full_longform_core_crop`(wide 세로크롭)이 실제 선택 프리셋으로 적용된 draft는
   0개.** 발견된 모든 케이스에서 `full_longform_core_crop`은 `base_preset_id`(항목의
   수동 설정값)로만 존재하고, 소스가 shortform으로 분류돼 `!isLongformSource` 분기가
   `full_shortform_template_safe_zoom`으로 **덮어씀**. 예: 팜유 수확(16:9로 보이는
   가로 영상)도 `shortform_direct`로 분류돼 core_crop 대신 template-safe 적용.
   → wide-longform 세로크롭 편집은 코드엔 있으나 실무에서 한 번도 발동 안 함
   (진짜 longform 분류 + wide 조건을 동시 충족한 소스가 없었음).

## 요약

| 질문 | 답 |
|---|---|
| 롱폼 full이 숏폼과 다른 편집인가 | 예. 롱폼=deep zoom(1.4~2.85x)·강회전·세로크롭, 숏폼=≤1.5x 캡·약회전(템플릿 보강). 분기: `selectFullDraftVideoTransformPreset`의 `!isLongformSource` |
| 8f97458에 살아있나 | 예. capcut_draft.py diff 0, selectFullDraftVideoTransformPreset byte-identical. exact 사태(하이라이트 선택)와 무관 |
| 현재 draft가 타나 | 로직은 탐(6/27 롱폼→hand_focus 실적용 확인). 단 **현재 큐는 전부 숏폼**이라 지금은 template-safe만 적용. wide-longform core_crop은 실적용 이력 0 |

## 다음 제안

1. **롱폼 소스로 실검증**: 현재 큐에 롱폼(16:9, ≥90s 또는 `longform_to_shorts`)
   소스가 없어 core_crop/deep-zoom이 라이브로 안 돈다. 롱폼 소스 1개를 넣어
   `full_longform_core_crop`(wide) 및 `full_process_*`(non-wide)가 manifest에
   실제로 적용되는지 확인 권장.
2. **소스 분류 재점검**: 16:9 가로 영상(팜유 등)이 `shortform_direct`로 분류돼
   롱폼 세로크롭을 못 타는 게 의도인지 확인. 의도가 "가로 롱폼은 core_crop으로
   세로 전환"이라면, 분류기가 이런 소스를 longform으로 잡도록 조정이 필요할 수 있음.
3. **core_crop 미발동 가시화**: `full_longform_core_crop`이 base로 설정됐는데
   shortform-safe로 덮이는 경우, manifest/로그에 "요청된 롱폼 크롭이 숏폼 분류로
   덮임"을 명시하면 운영자가 분류 오판을 조기에 발견할 수 있음.
