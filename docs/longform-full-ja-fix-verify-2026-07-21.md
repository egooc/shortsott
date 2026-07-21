# 롱폼 풀 검증 일본어 필수 제거 — 수리·검증

작성일: 2026-07-21

진단: [longform-full-ja-too-short-diagnosis-2026-07-21.md](longform-full-ja-too-short-diagnosis-2026-07-21.md)

## 수리 (풀드래프트 검증만)

`validateLongformVariantFinalGuide('full')` (processMetadataService.js) — 일본어 풀 필드
필수 검증을 한국어 기준으로 정렬:
- 제거: `full_caption_script_ja_too_short`(ja≥20), `missing_full_metadata`(JP metadata),
  `full_metadata_onscreen_subtitles_too_short`(JP 자막).
- 유지(완화 없음): `full_caption_script_ko_too_short`(ko≥20), `missing_full_review_metadata`
  (full_metadata_ko), 한국어 onscreen_subtitles 체크(→ full_metadata_ko 기준).

프롬프트는 이미 일본어 금지("Do not create ... full_caption_script_ja. Full drafts are
Korean only." — 3751행; "Do not create or require full_caption_script_ja" — 1740행) →
프롬프트 변경 불필요(확인만).

미변경: 한국어 파편/예산/문장 성립성 검증(별도 경로), 하이라이트 경로, midform 검증.

## 검증 (인용)

### 1. 결정적 검증기 테스트 (`__test.validateLongformVariantFinalGuide`, Gemini 무관)
```
PASS  A: ko=20, ja=0, full_metadata_ko present (400초 실패 형태) -> 통과
FAIL  B: ko=5 -> full_caption_script_ko_too_short (한국어 검증 유지)
FAIL  C: no full_metadata_ko -> missing_full_review_metadata (한국어 검토 metadata 필수)
PASS  D: ja absent, ko=20 -> 통과 (일본어 불필요)
```
→ 400초 실패 형태(ko=20/ja=0)는 이제 **통과**. 한국어 검증(ko<20 실패, 한국어 metadata
필수)은 **그대로**.

### 2. 실제 로그 (item_001·item_002, job_20260721123827) — end-to-end 거동 변화 (2/3 확인)
```
item_001 (474s): 12:47:32 KO Full 원고 문체 재생성: 금지 문체 3개 감지   ← 한국어 파편 게이트 진입
item_002 (727s): 12:56:43 KO Full 원고 문체 재생성: 금지 문체 1개 감지   ← 한국어 파편 게이트 진입
```
→ 두 항목 모두 full 출력이 **`ja_too_short` 없이 롱폼 full 검증을 통과**하고 다음 단계인
**한국어 파편 게이트**로 넘어감. (수정 전 동일 지점 로그: `11:45:22 longform_final_full
검증 실패 (missing missing_full_metadata|full_caption_script_ja_too_short|...)`.) → 일본어
필수 검증이 풀드래프트를 죽이던 것이 제거됨을 **2개 소스에서 실측 확인**.
- 단 두 항목 다 그 직후 `Gemini 일시 오류`(rate limit)로 실패, item_003(944s)은 job이
  rate limit에 걸려 미처리. → **green/held 최종은 쿼터 회복 후 재실행 필요**(아래 미완 참조).

### 3. 가드/빌드
`npm run verify` 전체 통과(encoding, shortform-highlight, metadata-repair, output-config,
caption-tts-alignment, korean-full-speech-budget, script-review-integrity, build).

## 미완 (정직)

- **400초 3개 green end-to-end는 아직 미확인**: 재실행(job_20260721123827)이 **Gemini
  rate limit(호출 제한/일시 오류)**에 걸려 item_001은 한국어 파편 게이트 진입 후
  `Gemini 일시 오류`로, item_002/003도 rate limit 재시도(60/120/180초) 중 실패. 이는
  **환경(Gemini 쿼터) 문제이지 이 수리와 무관**. 쿼터 회복 후 재실행하면 3개 모두
  일본어 필수 검증에 안 걸리고 한국어 원고로 진행(파편이면 held — 기존 수리 유지).
- 하이라이트 무회귀: 이 수리는 processMetadataService(메타 검증)만 건드렸고
  `validateLongformVariantFinalGuide`의 highlight variant는 early-return이라 불변.
  하이라이트 프리셋 경로(processQueueService)는 이 커밋에 미포함.

## 다음

- Gemini 쿼터 회복 시 400초 3개 재실행으로 green end-to-end + (파편 시)held 로그 인용 보강.
