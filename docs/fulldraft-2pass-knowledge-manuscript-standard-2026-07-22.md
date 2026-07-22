# 풀드래프트 2-pass 지식 원고 (STANDARD/숏폼 경로) — 구현

작성일: 2026-07-22
범위: **STANDARD 파이프라인만**(`runStandardGeminiPipeline`). 롱폼
(`buildLongformVariantFinalPrompt`)은 별도 턴. 하이라이트 경로 불변.

## 경로 확정 (증거)

- 현재 큐 전 아이템이 `source_type: shortform` / `source_workflow_mode: shortform_direct`
  → 라우팅(9363 `sourceWorkflowMode==='longform_to_shorts' || sourceType==='longform'`)에서
  **STANDARD**. 성공한 풀 원고(item_003 ko=121, item_005=60, item_008=25)도 STANDARD 산출.
- 큐의 "30.00초"는 다운로드 전 placeholder(실제 46~55초); 라우팅은 duration이 아니라
  source_type 기준이므로 STANDARD가 이들의 실제 생산 경로.
- 따라서 사용자 순차 원칙("생산 경로 하나 먼저")에 따라 **STANDARD부터**.

## Pass 1 — story_outline (신규 text-only Gemini 호출)

- 삽입: `runStandardGeminiPipeline` scene(1/3) 완료 직후 ~ metadata(2/3) 시작 전. Full 경로
  (`effectiveMetadataVariantMode !== 'highlight_only'`)에서만.
- `buildStoryOutlinePrompt` (신규): scene_transitions + 소재 → `story_outline`
  `{ premise, arc, key_moments:[{scene_id, knowledge_point}×3], knowledge_angle }`.
  영상 미첨부(includeVideo:false), 카메라·편집 용어 금지.
- `OTTOGI_STORY_OUTLINE_SCHEMA` (신규): key_moments minItems/maxItems 3.
- `validateFullStoryOutline` (신규): premise/arc/knowledge_angle 존재, key_moments 정확히 3,
  각 scene_id가 **실제 scene_transitions ID**, 카메라·편집 용어 0. 실패 시 throw.
- **Best-effort 격리**: Pass 1 실패(검증/429)면 `storyOutline=null`로 강등하고 Pass 2는 강화된
  규칙으로 진행(아이템 차단 안 함). 로그: `Gemini 2/3-0 ...` / `... 스토리 아웃라인 생략`.
- **429**: Pass 1은 text-only 1콜 추가. 기존 rate limiter(11b8940 `throttleGeminiCall`)가 표준
  generateJson에 이미 적용되어 자동 스로틀. 추가 조치 불요.

## Pass 2 — 원고 배분 (기존 호출 개편: buildMetadataPrompt + seed)

- `buildMetadataPrompt`에 `storyOutline` 파라미터 추가. 있으면 full 원고 규칙에 주입:
  - 첫 캡션 = role "hook", 마지막 = role "closing".
  - key_moments 3곳 = 그 scene_id에 role "scene_observation" 정확히 1개씩(= 전체 3개뿐) =
    화면이 보여주는 것 + knowledge_point.
  - 나머지 = 지식 나레이션(원리·이유·수치·의미), 화면 받아쓰기 금지.
  - scene_transitions = 모순 방지 참고이지 설명 대상 아님. 카메라·편집 용어 금지.
- 기존 scene_observation 규칙을 **정확히 3 + key_moments 앵커**로 정합화(무조건):
  "descriptive not a quota"/"25·50·75%"/"30% 이하" 문구 → "정확히 3, key_moments에 배치"로 교체.
- `buildInitialFullCaptionScriptSeedPrompt`(누락 보충 seed)에도 동일 storyOutline 규칙 주입.

## 검증 게이트 (Korean Full만, 기존 유지 + 추가)

`validateFullCaptionScript`의 `korean && !isMidform && field==='full_caption_script_ko'`에 추가
(모두 `style_regeneration_required:true` → 기존 재생성 경로 → 3회 후 held; `full_caption_script_ko`
포함이라 held-eligible):
- scene_observation 정확히 3 (`ko_full_scene_observation_not_3`): 초과/미달 재생성.
- 첫=hook (`ko_full_first_not_hook`), 마지막=closing (`ko_full_last_not_closing`).
- 카메라·편집 용어 0 (`ko_full_camera_editing_terms`, `collectCameraEditingTermHits`).
- 유지: 파편 게이트(`collectKoreanFullRepairGateIssues`), speech budget, held 경로, 한국어 검증.

## 격리 확인

- **하이라이트 경로 불변**: diff에 `validateHighlightCaptionBlock`/`highlight_metadata`/window/
  2층 프리셋/`hook_clip`/`onscreen_caption_block` 변경 0건. 새 게이트는 `korean && !isMidform`
  가드 안에만.
- Pass 1은 highlight_only에서 미실행. buildMetadataPrompt의 highlight 규칙(1576-1587 등) 미변경.

## 검증 (결정적, 단위테스트 20/20 PASS)

```
story_outline: valid passes / 2 key_moments·fake scene_id·camera term·empty premise 각각 실패
camera detector: 클로즈업·close-up 감지 / clean 통과
gate: exactly 3 scene_observation -> 무이슈 / 5·1 -> flagged
gate: first!=hook·last!=closing -> flagged / hook·closing -> 무이슈
gate: camera term in caption -> flagged / clean -> 무이슈
prompt: buildMetadataPrompt가 story_outline+exactly-3 규칙 주입 / buildStoryOutlinePrompt 실제 scene id 나열
```
가드 회귀 없음: `metadata repair guards ok`, `korean full speech budget ... passed`,
`output config contract ok`, `npm run verify`(encoding 84 files / shortform highlight / build 3.26s).

## 미완 (정직한 한계)

- **실측 재생성 검증 quota-blocked**: 사용자 요청의 "24초+ 소스 2~3개 재생성 → script_review.txt
  전문 인용(장면 설명 3회/나머지 지식 나레이션/hook·closing/파편 0/budget)"은 현재 DSQ 429
  압박(라이브 배치 경쟁)으로 실행 불가. 쿼터 빈 창에서 실배치 재생성 후 script_review.txt
  전문 인용 + 육안 확인 필요. [[vertex-429-payload-and-quota-state]]
- **regeneration 프롬프트에 outline 미주입**: 새 게이트 위반 시 재생성은 이슈 reason으로 요구를
  전달(효과 있음)하지만, story_outline 자체를 재생성 프롬프트까지 스레딩하진 않음(후속 개선 여지).
- **발견한 기존 버그(미수정, 범위 밖)**: non-korean 폴백 객체에 `weakSentenceGroups` 누락(7086)
  → dormant JA-full 경로(`includeJapaneseFull:true`, 프로덕션 미사용)에서만 크래시. 내 변경 아님.
  config-transition JA-full dead 브랜치 정리 턴에서 함께 처리 권장.
