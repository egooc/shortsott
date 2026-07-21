# 검수/업로드 설명 필드(report_description)에서 EN 가드 제외 — 발행 자막 가드 유지

작성일: 2026-07-22
대상: `server/services/processMetadataService.js` `collectJapaneseCaptionIssues`
연결: [[highlight-full-caption-ko-failure-diagnosis]] (item_008 lost wax 실패 진단)

## 원인 (구성 전환 잔재)

- `report_description` = **YouTube 업로드 설명 / 검수 매칭 필드** (온스크린 자막 아님).
  - `report_description` → `upload_description`/`highlight_upload_description` (발행 설명 메타)
  - `full_metadata_ko`(검수)의 report_description → `korean_review.report_description`
  - 프롬프트(122): "report_description is the actual YouTube upload description."
  - **발행 온스크린 자막은 `onscreen_subtitles`/`onscreen_caption_block`/`full_caption_script_*`** (별개 필드).
- EN 가드 `hasLongLatinWord`(라틴 2자+ 전면 거부)가 이 **설명 필드까지 발행 자막처럼** 검증 →
  영어 기법명("lost wax casting") 소재에서 `highlight_metadata_ko.report_description` 무효 →
  하이라이트 variant failed. 발행 자막은 정상인데 설명 필드 때문에 죽음.

## 수리 (검증 경로만, 발행 자막 가드 불변)

`collectJapaneseCaptionIssues`의 `requireJapaneseField`/`requireKoreanField`에 옵션 추가:
```js
const requireKoreanField = (field, value, opts = {}) => {
  const validationValue = ...;
  const latinContaminated = opts.allowEmbeddedLatin ? false : hasLongLatinWord(validationValue);
  if (!isValidKoreanCaption(validationValue) || latinContaminated) { issues.push({...}); }
};
```
- `report_description` 4개 지점만 `{ allowEmbeddedLatin: true }` 전달:
  - `full_metadata.report_description` (JP full)
  - `highlight_metadata.report_description` (JP highlight)
  - `full_metadata_ko.report_description` (KO full)
  - `highlight_metadata_ko.report_description` (KO highlight)
- **`isValidJapaneseCaption`/`isValidKoreanCaption`은 유지** → report_description은 여전히
  일본어/한국어 내용이 있어야 하고(빈 값·mostly-Latin 거부), **영어 기법명 혼입만 허용**.
- **발행 자막·타이틀 필드는 전부 불변**: short_description, summary_caption, upload_title,
  recommended_titles, onscreen_subtitles, onscreen_caption_block, full_caption_script_*.
  → 거긴 `hasLongLatinWord` 그대로. 영어 안 됨.
- **정리/강제 함수 불변**: `applyLocalMetadataFallbacks`, `enforcePublicMetadataLanguage`는
  손대지 않음(가드 테스트 대상). 즉 정리 단계가 돌면 report_description 영어는 여전히 정리됨;
  단지 **정리 실패/미실행 시에도 held/failed는 안 남**.

## 지난주 교훈 준수

- **발행되는 하이라이트 자막 로직 불변**: onscreen_caption_block/full_caption_script 검증
  미변경. 하이라이트 window 선택(processQueueService)·2층 프리셋 미접촉.
- **검수용 필드 가드만 조정**: report_description 4곳.
- **격리**: 정리/강제 함수·프로덕션 하이라이트 경로 미변경.

## 검증 (결정적, 로그 인용)

### 1. 단위 테스트 (collectJapaneseCaptionIssues 직접 호출) — 5/5 PASS
```
PASS | A: report_description with "lost wax casting" is NOT flagged (fix works)
PASS | B: short_description with English IS still flagged (published guard intact)
PASS | C: pure-English report_description IS still flagged (Korean content required)
PASS | D1: JA report_description with English is NOT flagged (fix works)
PASS | D2: JA short_description with English IS still flagged (published guard intact)
```
- A: `highlight_metadata_ko.report_description`에 "jewelry lost wax casting" 섞여도 통과.
- B/D2: `short_description`(발행 타이틀류)에 영어 → 여전히 차단. **발행 자막 가드 정상.**
- C: 순수 영어 report_description → 여전히 차단. **한국어 내용 필수 유지.**

### 2. item_008 실제 실패값 리플레이
item_008 highlight_generation_details의 **실제 오염값**
("## 1. 작업 개요 jewelry lost wax casting의...")을 그대로 검증에 투입:
```
contaminated report_description contains English: true -> jewelry,lost,wax,casting
report_description in highlight issues: NO (passes) ✓
```
→ **수정 전 하이라이트를 죽였던 그 값이, 수정 후 report_description 이슈에서 사라짐.**
(리플레이 픽스처의 잔여 이슈는 explainer_text_ko 미설정·caption_block 120자 미만 등 픽스처
아티팩트로, 실제 item_008은 그 필드들이 정상이라 report_description만 실패였음.)

### 3. 기존 가드 회귀 없음
```
metadata repair guards ok        # applyLocalMetadataFallbacks/enforcePublicMetadataLanguage 불변
output config contract ok
```
`npm run verify` (check:encoding + check:shortform-highlight + build): **통과** (exit 0)
- `encoding scan ok (84 files)` / `shortform highlight contract ok` / `✓ built in 5.16s`

## 라이브 재실행 관련

- item_008 실제 Gemini 재실행은 현재 DSQ 429 압박(라이브 배치 경쟁)으로 quota-blocked.
  대신 **실제 실패값 리플레이 + 단위 테스트**로 결정적 증명. [[vertex-429-payload-and-quota-state]]
- 쿼터 빈 창에서 재실행 시: report에 영어 있어도 하이라이트 통과 예상(리플레이로 검증됨),
  발행 일본어/한국어 자막은 별개 필드라 불변, 다른 소재는 발행 자막 가드 유지로 회귀 없음.
