# Phase 3 업로드 UI의 한국어 검수(highlight_metadata_ko) 표기 (읽기 전용, 원문)

작성일: 2026-07-22
연결: [[config-transition-audit]] (highlight_metadata_ko 잔재 판단 확증용)
방식: 클라(OttogiUpload.jsx) + 서버(youtubeUploadService.js TXT 파서, processQueueService.js TXT 작성기) 원문. 수정 없음.

## 흐름 요약

highlight_metadata_ko는 UI가 **필드명으로 직접 안 읽는다**. 대신:
1. 서버가 draft별 **TXT 메타데이터**를 쓴다(`formatMetadataVariantSection`, processQueueService):
   `<!-- METADATA_VARIANT -->`(발행) + `<!-- REVIEW_VARIANT -->`(검수) 마커로 분리.
2. Phase 3에서 사용자가 영상+TXT를 올려 **매칭**한다.
3. 서버 파서 `inferReviewFromMetadata`(youtubeUploadService:1347)가 REVIEW 섹션을
   `{rawText, caption, titles, reportDescription}`로 뽑아 `candidate.review`에 담는다.
4. 클라 `ReviewBlock`(OttogiUpload.jsx:396)이 읽기 전용으로 표시.

## highlight_metadata_ko 하위필드 → TXT 헤딩 → UI 매핑 (원문)

| highlight_metadata_ko 필드 | TXT REVIEW 헤딩(작성기) | 클라 파싱(1355-1357) | UI 표시(ReviewBlock) | 표시/편집 |
|---|---|---|---|---|
| `onscreen_caption_block` | `### SCREEN_CAPTION_KO` (+`_BLOCK_KO`) 4499-4503 = `onscreenSubtitleTextKo`(4448-4449) | `caption` ← /SCREEN_CAPTION_KO\|화면 자막/ | **"화면 자막 번역"** 407-408 | **전문·읽기전용** |
| `report_description` | `### REPORT_DESCRIPTION_KO` 4559-4560 = `reportDescriptionKo`(4462) | `reportDescription` ← /REPORT_DESCRIPTION_KO\|리포트/ | **"리포트 설명 번역"** 419-420 | **전문·읽기전용** |
| `recommended_titles_ko` (`upload_title`은 ''=미사용) | `### TITLE_CANDIDATES_KO` 4556-4557 | `titles` ← /TITLE_CANDIDATES_KO\|제목/ | **"제목 번역"** 413-414 | **전문·읽기전용** |
| `summary_caption` | `### SUMMARY_CAPTION_KO` 4553-4554 (TXT엔 있음) | **파서가 안 뽑음** | **UI 미표시**(rawText fallback시만) | — |
| `short_description` | 독립 헤딩 없음 | — | **미표시**(단 onscreen_caption_block 비면 caption 폴백 소스 4449) | — |

## 질문 직접 답

### 1. 각 하위필드가 UI에 뜨나
- `report_description` → **뜬다** ("리포트 설명 번역" 열, 전문 스크롤).
- `onscreen_caption_block` → **뜬다** ("화면 자막 번역" 열, 전문).
- `short_description` → **독립 표시 없음**. onscreen_caption_block가 비었을 때만 caption 폴백 소스.
- `summary_caption` → **UI 미표시**. TXT엔 SUMMARY_CAPTION_KO로 쓰이지만 클라 파서가 그 섹션을
  뽑지 않음(구조 파싱이 caption/titles/reportDescription 3개뿐).
- `upload_title` → titles로 접힘. 단 highlight_metadata_ko.upload_title은 빌더에서 ''(4276),
  그래서 실제 titles는 recommended_titles_ko.

### 2. 검수 표기 방식
- **나란히(side-by-side) 아님**. 접이식 `<details>` "**설명/검수 상세 열기**"(2042) 안에
  세로로: 위=**편집 가능한 "업로드 설명" textarea**(일본어 발행, form.description, 2046),
  아래=**읽기 전용 ReviewBlock**(한국어 검수, 2048).
- ReviewBlock 헤더: "**한국어 검수용 보기**" + "**업로드 설명에는 포함되지 않음**"(401-402).
  안은 3열 그리드(md:grid-cols-3): 화면 자막 번역 / 제목 번역 / 리포트 설명 번역(404-422).
- `onscreen_caption_block`(검수) 형태 = **전문(full text)**. `whitespace-pre-wrap` +
  `max-h-32 overflow-auto`(408) → 요약·매칭체크가 아니라 **스크롤되는 전문 참고 표시**. 사용자가
  눈으로 대조하는 용도(자동 필드 매칭 아님).

### 3. 읽기용인지
- **읽기 전용 확정**. ReviewBlock에 input/textarea/onChange **전무**(순수 `<div>` 표시).
  사용자는 이 한국어 검수 필드를 **편집하지 않고 대조만** 한다.
- 반면 **발행(일본어) 설명은 편집 가능**: "업로드 설명" textarea(2046, onChange→updateForm),
  제목(2029)·태그(2034)도 편집 입력. 그리고 `stripReviewOnlySections`(클라 167, 서버 1185)가
  한국어 검수 마커 섹션을 발행 설명에서 제거 → 검수 텍스트가 유튜브 설명에 새지 않음.
- 관계 표시: 같은 패널에 **발행 설명(편집) 바로 아래 한국어 검수(읽기)** 를 두고, "업로드 설명에는
  포함되지 않음" 라벨로 "이건 대조용, 발행 안 됨"을 명시.

## 감사 함의 (config-transition-audit 확증)

이 UI는 highlight_metadata_ko 필드를 **읽기 전용 자유 텍스트(전문)로만** 보여주고 **구조를 전혀
파싱/강제하지 않는다**: 120~340자 길이 요구 없음, long_bottom_explainer 모드 요구 없음, 문자셋
검사 없음. 즉 서버의 발행급 검증(`validateHighlightCaptionBlock(...,true)` 120-340,
`hasLongLatinWord`)은 **이 UI의 목적(눈 대조)엔 불필요**하다. → 감사에서 낸 잔재 판단
(highlight_metadata_ko 하위필드 발행급 guard = 과엄격, report_description과 동일 패턴)을 **확증**.
검수 UI가 필요로 하는 건 "있는 텍스트를 그대로 대조 표시"뿐이므로, 발행 자막급 구조/EN 가드로
variant를 held/failed 시키는 건 목적과 안 맞는다.
