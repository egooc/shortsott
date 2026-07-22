# highlight_metadata_ko 검수 필드에서 발행급 가드 제거 (검수 필드만)

작성일: 2026-07-22
연결: [[phase3-upload-korean-review-ui]] (UI 확인) · [[config-transition-audit]] (잔재 판단) ·
[[report-description-en-guard-relax]] (동일 패턴 선행 수정)

## 근거 (UI 확인으로 확증)

- `highlight_metadata_ko` = **검수 전용**(OUTPUT_CONFIG reviewMetadataKey; 프롬프트 "not upload
  metadata"). Phase 3 업로드 UI(ReviewBlock)에서 **읽기 전용 자유 텍스트(전문)로만** 표시되고
  **구조/길이/문자셋을 전혀 파싱 안 함**(whitespace-pre-wrap 스크롤). `stripReviewOnlySections`가
  발행 설명에서 검수 섹션 제거 → 발행에 안 샘.
- 그런데 서버가 **발행급 검증**으로 variant를 held/failed 시킴(영어 기법명·짧은 리뷰 블록 소재에서).

## 수리 (processMetadataService.js `collectJapaneseCaptionIssues`, 검수 필드만)

1. `validateHighlightCaptionBlock`에 **korean(=검수) 분기 추가**: onscreen_caption_block가
   korean일 때는 **비어있지 않음 + `isValidKoreanCaption`(읽을 수 있는 한국어)** 만 검사.
   `caption_mode==='long_bottom_explainer'`, `120~340자` 구조 강제 **제거**.
   - **일본어(발행) 분기는 그대로**: `caption_mode` + `120~340자` + `isValidJapaneseCaption` strict 유지.
2. `highlight_metadata_ko`의 `short_description`/`summary_caption`/`upload_title`에
   **`allowEmbeddedLatin: true`** 추가(report_description과 동일). `hasLongLatinWord`(영어 전면
   거부)만 해제, `isValidKoreanCaption`은 유지.

### 절대 불변 (발행 필드)
- `highlight_metadata`(JA) `onscreen_caption_block`: 120~340 + long_bottom_explainer strict 유지.
- `full_metadata_ko`(발행 KR full)의 short_description/onscreen_subtitles/report 등: **미변경**
  (검수 아님, 발행이라 strict 유지).
- `full_caption_script_ko`, window 선택, 2층 프리셋, capcut 조립: 미접촉.

## 검증 (단위테스트 11/11 PASS)

```
REVIEW: short(<120) KO-dominant+EN caption_block passes
REVIEW: KO-dominant short_description with EN name passes
REVIEW: KO-dominant summary_caption with EN passes
REVIEW: KO-dominant upload_title with EN passes
REVIEW: KO-dominant report_description with EN passes
REVIEW: empty caption_block still flagged
REVIEW: pure/mostly-English caption_block still flagged (isValidKoreanCaption kept)
REVIEW: mostly-English short_description still flagged (Korean required)
PUBLISH JA: short caption_block STILL flagged (120-340 strict intact)
PUBLISH JA: English caption_block STILL flagged (JA language guard intact)
PUBLISH full_metadata_ko: English short_description STILL flagged (not relaxed)
```
- **검수**: 한국어-우세 + 영어 기법명("lost wax casting"), 120자 미만 블록 → 통과.
- **유지**: 빈 값·mostly-English → 여전히 실패(`isValidKoreanCaption` — UI 대조용이라 읽을 수 있어야).
- **발행 불변**: JA caption_block 120-340/언어 strict, full_metadata_ko EN strict 그대로.
- item_008류(KO-우세 report + 짧은 검수 블록) 통과 — 위 REVIEW 케이스가 그 형태.

### 회귀 없음
`metadata repair guards ok`, `output config contract ok`, `npm run verify` 통과
(`encoding scan ok (84 files)` / `shortform highlight contract ok` / `✓ built in 4.25s`).

## 범위 밖 (별도 판단)

- `highlight_explainer_text_ko`(top-level, 검수 caption 폴백 소스)는 `requireKoreanField`
  strict인데 이번 사용자 명시 목록(검수 metadata 4필드)에 없어 **미변경**. 같은 검수 계열이라
  향후 동일 완화 후보이나, "검수 필드만·명시분만" 원칙으로 이번엔 손대지 않음.
