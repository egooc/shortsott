# 풀드래프트 파편 수리 구현·검증 보고

작성일: 2026-07-21

하이라이트 경로는 일절 수정하지 않음. 풀드래프트(Korean Full) 경로만 수정.
진단 원문은 [fulldraft-fragment-diagnosis-2026-07-21.md](fulldraft-fragment-diagnosis-2026-07-21.md) 참조.

## 문제 (진단 결과)

1. 파편 원고가 3회 repair 실패 후 `held`가 아니라 `error`로 빠지고, `full_only`
   배치에서 아이템 전체가 하드 실패했다.
2. 검수 게이트(`assertKoreanFullScriptReviewApproved`)가 실제 배치 경로에
   배선되지 않아, 파편 원고가 검수 없이 처리됐다.
3. Gemini 프롬프트가 "완결 문장"과 "짧은 연결 파편 허용"을 동시에 지시하고,
   few-shot "Good" 예시 자체가 자신이 금지한 "3연속 파편"을 위반했다.

## 수리 내용

### A. 파편 → held (자막 콘텐츠 실패는 재검토 가능)
- `markValidationFailedVariants` (processMetadataService.js): full 변형의 실패
  이슈가 전부 Korean full 콘텐츠 필드(`full_caption_script_ko` 또는
  `full_metadata_ko.*`)이면 `failed`가 아닌 `held`로 표시. 구조/스키마/장면/API
  실패는 held 대상이 아님.
- `validateGuide` (processMetadataService.js): 어떤 변형이 `held`면
  `all_variant_generation_failed`를 발생시키지 않음 — full_only에서 full held일 때
  "모든 변형 실패"로 오판해 하드 throw하던 버그 차단.

### B. Network/일시 예외 격리 + 재생성 상한
- 재생성 상한은 이미 3회(`validateOrRepairJapaneseCaptions` 루프,
  `for attempt<=3`)로 존재함을 진단에서 확인. 3회 후 held(A) 처리.
- 배치 격리는 이미 존재: `generateQueue`는 아이템별 try/catch로 감싸
  `stop_on_error=false`면 다음 아이템으로 계속 진행. `runDraftStage`/`runMetadataStage`도
  아이템별 try/catch. worker(`processJobWorker.js`)는 최상위 try/catch로 job 단위
  격리. → 한 아이템의 파편/일시오류가 배치 전체를 죽이지 않음(로그로 재확인).

### C. held 원고를 script_review.txt로 (사람 수정 워크플로 복원)
- `validateOrRepairJapaneseCaptions`: 게이트가 거부한 마지막 파편 시도를
  `lastRejectedFullCaptionScriptKo`에 보존하고, 3회 실패 throw 시 `error.guide`에
  실어 보냄 — held guide가 빈 배열이 아니라 파편 원고를 갖게 함.
- `createKoreanFullDraftScriptReview` (processQueueService.js): 적격성 필터가
  held 아이템을 항상 포함하도록 수정(기존엔 `decideOutputModeForItem`의
  skip 판정이 held 아이템을 제외해 `no_eligible_items`로 빠졌음).
- `runMetadataStage` (processJobService.js): full이 held로 오면 자동으로
  `createKoreanFullDraftScriptReview([item])`를 호출해 script_review.txt를 쓰고,
  아이템 상태를 held로 기록한 뒤 다음 아이템으로 진행.
- `updateGuideForApprovedScript` (processQueueService.js): 승인 시
  `full_generation_status: held → ready`로 복구(안 하면 승인 후에도 드래프트
  게이트가 계속 막음).
- `generateQueue`/`runDraftStage`: held 상태를 `failed`가 아닌 별도 `held`로
  집계하고(`held_count`), 드래프트 단계에서 held는 실패가 아니라 보류로 로그.

### D. 프롬프트 모순 제거
- `ottogi_process_metadata.txt` + repair/regeneration/seed 프롬프트 3종
  (processMetadataService.js): "짧은 연결 파편 허용" 문구 삭제. "각 항목은 자체
  완결 절 — 조사(을/를/은/는/이/가)나 미완 수식어로 끝내지 말 것" 규칙(v3)으로
  통일. few-shot "Good" 예시를 각 항목이 술어를 갖는 완결 문장으로 교체하고,
  "Bad(파편)" 예시를 별도 제시.

## 검증 (로그/파일 원문 인용)

### 1. 배치 구조: held + 계속 진행 + 정상 드래프트 (batch `job_20260721061534_8782a8`)

```
06:47:39 success 드래프트 생성 종료: 성공 2개, 보류(held) 3개, 실패 0개
06:47:39 warning 서버 작업 종료: 드래프트 성공 2개, 경고 3개, 실패 0개
```
- item_002, item_008 → `Full 드래프트 생성 완료` (정상 → 드래프트)
- item_004, item_005, item_006 → `full 포맷 보류(held): 파편 원고 감지` → `드래프트 생성 보류(held)`
- **실패 0개, crash 없이 완주** (파편 3개가 각각 held되고 배치는 계속 진행)

### 2. 배치 격리: 실패/일시오류도 다음 아이템 계속 (batch `job_20260721071037_3cff86`)

```
07:13:13 error item_002 Gemini 분석 실패: Gemini 일시 오류
07:18:44 success item_004 Gemini 분석 완료
07:26:16 success item_005 Gemini 분석 완료
07:27:34 error item_006 Gemini 분석 실패: Gemini 일시 오류
07:33:26 warning 드래프트 생성 종료: 성공 1개, 보류(held) 0개, 실패 1개
```
- item_002/006의 transient Gemini 오류가 배치를 죽이지 않고 item_004/005/008로 진행.
- 이 배치는 Gemini 비결정성으로 파편 held가 안 나옴(004/005는 이번엔 정상 생성).

### 3. held 원고 → 비어있지 않은 script_review.txt (item_004 held guide 직접 호출)

held된 item_004(파편 20개 보존, `full_caption_script_needs_review: true`)에
`createKoreanFullDraftScriptReview(['item_004'])` 호출 결과
`queue/process/item_004/script_review.txt` (1674 bytes):

```
# BLOCKED: scene_01 분량 4자 초과 (현재 9자) — 해당 문장 축약 필요
...
# BLOCKED: Anchored occupied timeline 37.498s exceeds actual video timeline 35.7s + 1.5s

[scene_01] 폐고무가 다시 태어나 가치를 만드는 과정 과정을 보시죠.
[scene_05] 롤러로 고무를 연하게 반죽해요.
[scene_07] 균일하게 펴줍니다.
...
[scene_15] 크리켓 공이 됩니다.
```
- 상단 `# BLOCKED` = held 사유(분량/타임라인 초과) 안내.
- `[scene_id] 문장` = 사람이 고칠 파편 원고("과정 과정" 중복 등 파편 흔적 보임).
- 파편 보존 수정 전에는 이 파일이 1바이트(빈 줄)였음 → 수정 후 편집 가능한 원고 수록.

### 4. normalizeGuide 파편 보존 (순수 함수 테스트)

22개 파편 배열 → `normalizeGuide` 후 22개 유지(status held 유지). 20개 미만이면
0으로 필터되지만 실제 거부된 repair는 항상 20~24개라 보존됨.

### 5. 프롬프트 개선 효과

item_002는 1차 배치에서 파편으로 held/error였으나, 프롬프트 수정 후
`job_20260721061534`에서 파편 없이 `Gemini 분석 완료`(정상 생성) → 드래프트 완료.
프롬프트가 파편 발생을 줄이고, 남는 파편은 held+script_review가 잡는 이중 방어.

### 6. 가드/빌드

`npm run verify` 전체 통과: encoding ok, shortform-highlight ok, metadata-repair ok,
output-config ok, caption-tts-alignment ok, korean-full-speech-budget ok,
script-review-integrity ok, build ✓.

## 알려진 범위 밖 사항

- item_005가 배치 `job_20260721071037`의 드래프트 단계에서 "did not produce any
  draft"로 실패한 것은 **shortform 소스에 `full_only` 모드를 요청한 테스트
  아티팩트**다. `decideOutputModeForItem`(오늘 수정 안 함)이 shortform의 자연
  출력을 하이라이트로 판정해 full을 skip하는데, `full_only`엔 하이라이트 fallback이
  없어 에러가 됨. 정상 `all` 모드면 하이라이트로 빠져 에러 안 남. 파편 수리와 무관.

## 다음 제안

1. **결정적 held 재현 테스트**: Gemini 비결정성 때문에 라이브 배치에서 파편 held를
   매번 재현하기 어렵다. `collectKoreanFullRepairGateIssues`가 파편으로 판정하는
   고정 입력을 주입해 held→script_review 전 경로를 Gemini 없이 도는 통합 테스트
   스크립트(`scripts/check-*`) 추가를 권장.
2. **script_review UI가 report_description도 커버**: held 사유에
   `full_metadata_ko.report_description`가 포함될 수 있으나 현재 승인 흐름은 자막만
   재구성한다. 승인 후 드래프트에서 report_description가 여전히 막힐 수 있으니,
   리뷰 대상에 설명 필드도 포함할지 검토.
3. **item_005류 shortform+full_only 처리**: 실제 운영이 `full_only`를 shortform에
   쓸 일이 있는지 확인하고, 있다면 그 조합에서 "did not produce any draft" 대신
   명시적 skip 처리로 바꿀지 결정.
