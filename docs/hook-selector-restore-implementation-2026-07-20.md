# 발행 하이라이트 selector 훅 앵커 복원 보고서

작성일: 2026-07-20

## 작업 목적

발행 하이라이트 selector를 최근의 completion-cut 우선 자리에서 내리고,
원래 설계였던 **훅 최강 장면 앵커 + 앞뒤 공정 추출** 축으로 복원했다.

핵심 원칙:

- **어디를 자를지**는 훅 점수가 결정
- **어디서 끝낼지**는 completion-cut이 보정
- completion-cut은 삭제하지 않고 selector 자리에서만 강등

## git 이력 확인 결과

`scripts/capcut_draft.py` 기준 git 이력은 아래 두 커밋만 확인됐다.

- `8f97458` — `Clean up CapCut frame and OCR draft generation`
- `632f11f` — `Initialize project skeleton`

또 `jp_highlight_exact`, `kr_highlight_exact`, `trackb_highlight_exact` 문자열은
별도 과거 도입 커밋으로 잡히지 않았고,
현재 작업 트리와 `8f97458` 사이 diff에 포함되어 있었다.

즉 이번 exact copy-only 계열은 **별도 과거 커밋 하나로 들어온 변화라기보다, `8f97458` 이후 워킹트리 단계에서 얹힌 로컬 변경 묶음**으로 보는 쪽이 정확했다.

---

## 변경 요약

### 1) 새 primary selector 추가

파일:

- `server/services/processQueueService.js`

추가/복원한 핵심 함수:

- `getHookPrimaryWindow()`
- `getHighestHookScene()`
- `buildHookSelectionEvidence()`
- `pickHookAnchoredProductionWindow()`

동작:

1. `pickHighlightWindow()`로 원래 strongest hook window를 1차 선택
2. `collectHighlightCandidateWindows()`의 guide candidate / hook candidate / scene-ranked candidate를 함께 수집
3. `selectBestHighlightWindow()`로 훅 점수 기준 최종 primary window 선택
4. 그 다음에만 `pickProductionHighlightWindow()`를 호출해서
   - `completion_refinement_strategy`
   - `completion_refinement_reason`
   - `completion_refinement_window`
   로 끝점 보정

즉 selector 우선순위가 다시 **hook → completion refinement**가 되었다.

### 2) 발행 경로 3곳의 selector 교체

교체 대상:

- `createHighlightDraftForItem()`
- `createKoreanHighlightDraftForItem()`
- `generateQueue()`

변경 전:

- `await pickProductionHighlightWindow(...)`

변경 후:

- `await pickHookAnchoredProductionWindow(...)`

의미:

- completion-cut이 직접 window를 고르지 않음
- hook-anchor primary window를 먼저 잡고,
- completion은 끝점 다듬기만 수행

### 3) manifest / notes에 선택 근거 추가

JP highlight / KR highlight manifest와 notes에 다음을 남기도록 추가했다.

- `hook_selection_evidence`
- `completion_refinement_strategy`
- `completion_refinement_reason`

즉 이후 검증 시

- strongest scene이 window 안에 있었는지
- selector는 hook이었는지
- completion은 보조였는지

를 파일만 보고 확인 가능하다.

---

## completion-cut을 어떻게 강등했는가

`pickProductionHighlightWindow()`는 삭제하지 않았다.

현재 역할:

- `loop_complete_reset_cycle`
- `result_reveal_completion_cut`

중 하나를 찾되,
이 값은 더 이상 발행 highlight의 primary selector가 아니라
`pickHookAnchoredProductionWindow()` 내부에서
**completion endpoint refinement**에만 사용된다.

즉 지금 구조는:

1. 훅 기준으로 시작점/핵심 장면 결정
2. completion 기준으로 끝점 정리

이다.

---

## 하이라이트 / 풀드래프트 동시 추출 구조

이번 변경으로 **full/story 쪽은 건드리지 않았다.**

그대로 살아 있는 부분:

- `applyOttogiGuideToItem()`에서
  - `guide.story_clip_40s?.duration_sec`
  - `guide.recommended_full_window?.duration_sec`
  기반 full draft duration 사용
- longform 보조 함수들
  - `getDefaultLongformHighlightWindows()`
  - `selectBestHighlightWindow()`
  - `getLongformFullCandidateWindows()`

즉 원래의

- scene analysis → highlight(hook window)
- 같은 scene analysis → full(story window)

구조는 이번 복원으로 더 망가지지 않았고,
highlight selector만 원래 축으로 되돌렸다.

---

## 검증 배치

배치 ID:

- `hook_selector_restore_triplet`

대상 (24초+ 소스 3개):

- `item_026` (빵)
- `item_033` (치킨)
- `item_034` (네일 폴리시)

결과:

- 3개 모두 `success`

---

## strongest hook scene 포함 여부

### item_026

- output: `20260720-H-190117-職人のパン作り 生地から黄金の焼き上がりまで`
- primary selection:
  - `selection_strategy: natural_source_repetition_no_artificial_loop`
- window:
  - `0.351s - 24.35s`
- strongest hook evidence:
  - `strongest_scene_id: scene_012`
  - `visual_hook_score: 8`
  - `repetition_potential: 9`
  - `strongest_scene_inside_window: true`

판정:

- strongest hook scene이 window 안에 들어감
- completion은 `result_reveal_completion_cut`으로 후단 보정만 수행

### item_033

- output: `20260720-H-190117-大量チキン製造ライン！止まらない食欲の魔法`
- primary selection:
  - `selection_strategy: natural_source_repetition_no_artificial_loop`
- window:
  - `32.217s - 56.216s`
- strongest hook evidence:
  - `strongest_scene_id: 021`
  - `visual_hook_score: 9`
  - `strongest_scene_inside_window: true`

판정:

- strongest hook scene이 window 안에 들어감
- 다만 content 자체는 여전히 준비/전개 구간 비중이 남는다

### item_034

- output: `20260720-H-190117-指先を彩る魔法 手作業ネイルポリッシュの誕生`
- primary selection:
  - `selection_strategy: natural_source_repetition_no_artificial_loop`
- window:
  - `2.04s - 26.039s`
- strongest hook evidence:
  - `strongest_scene_id: scene_01`
  - `visual_hook_score: 9`
  - `repetition_potential: 9`
  - `strongest_scene_inside_window: true`

판정:

- strongest hook scene이 window 안에 들어감
- 가장 강한 손작업/붉은 액체 fill action이 초반부터 살아남음

---

## 사용자 육안 판정 (contact sheet 기준)

### item_026 (빵)

- **좋아짐**
- 반죽/링 배치/오븐/구워진 빵 beauty shot까지 이어져
  준비만 길게 보는 느낌보다 훅한 액션 중심으로 이동함
- completion도 무난함

### item_033 (치킨)

- **부분적으로만 좋아짐**
- 후반의 튀김/완성 치킨 드레인 쪽이 훅 포인트지만,
  여전히 생닭/투입/코팅 같은 준비 구간 비중이 남아 있음
- completion은 있음
- 셋 중 가장 “훅 복원 효과가 약한” 케이스

### item_034 (네일 폴리시)

- **좋아짐**
- vivid red fill / reveal / grouping이 중심에 와서
  밍밍한 준비보다 시각적 쾌감이 강해짐
- completion도 납득 가능

---

## 이번 복원의 의미

복원 전:

- selection 자체를 completion-cut이 지배
- strongest hook scene은 결과적으로 포함될 수도, 아닐 수도 있었음

복원 후:

- strongest hook scene이 manifest 근거와 함께 window 안에 들어감
- completion은 끝점 refinement로만 남음
- 즉 **선택의 주도권이 다시 훅 앵커로 돌아옴**

---

## 남은 관찰

복원은 성공했지만,
`item_033`처럼 소재 자체가 “준비 → 공정 → 결과”로 길게 퍼져 있는 경우에는
훅 앵커 selector로 돌아와도 완전히 날카롭게 조여지지 않을 수 있다.

즉 현재 남은 과제는 selector 축보다

- scene scoring 품질
- candidate pruning
- scene_transitions 자체의 hook labeling 품질

쪽에 더 가까워 보인다.

---

## 변경 파일

- `server/services/processQueueService.js`

---

## 검증

- `lsp_diagnostics`: 이상 없음
- `npm run verify`: 통과

---

## 최종 결론

요청한 대로,

- 발행 highlight selector는 다시 **원래 훅 앵커 축**이 primary가 되었고
- completion-cut은 **selector에서 내려와 끝점 보정**만 맡는다.

또한 검증한 3개 장기 소스 모두에서

- strongest hook scene이 실제 window 안에 들어갔고
- 그 근거가 manifest에 남는다.

즉 이번 복원은 의도대로 들어갔다.
