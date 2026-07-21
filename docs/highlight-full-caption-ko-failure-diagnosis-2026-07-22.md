# 매일 발행 하이라이트가 full_caption_script_ko로 실패하는 원인 (읽기 전용, 원문)

작성일: 2026-07-22
대상: item_008 (shortform, output_mode=full_and_highlight, 라이브 배치 e0ce8e)
코드 원문(processMetadataService.js) + item_config + job 로그 인용. 수정 없음.

## 결론 (질문 직접 답)

1. **하이라이트는 full_caption_script_ko를 요구하지 않는다.** highlight 실패의 자기 필드는
   **`highlight_metadata_ko.report_description` 하나뿐**(영어 오염). `full_caption_script_ko`가
   highlight_generation_**details**에 같이 보이는 건 details가 full 검증 전체 덤프를 **양쪽
   variant에 복사**하기 때문(표시 아티팩트).
2. **왜 지금**: 내 최근 커밋 아님. **콘텐츠(파편+영어) + 쿼터(review 콜 즉시 실패)** 조합.
   review LLM 정리가 429로 죽으면 엄격 로컬 검증으로 폴백 → 원본 파편/영어가 그대로 걸림.

## 1. 실패 필드 전체 (item_008, 최종 검증 실패 상세 원문)

`highlight_generation_details.invalid_japanese_captions` = **4개** (full 3 + highlight 1):
```
full_caption_script_ko            value: []   "Full Draft must include an ordered process
                                               narration script ... not only scene labels"
full_metadata_ko.report_description           "## 1. 작업 개요 : 이 영상은 주얼리 제조에..."
                                               "must be natural Korean, not English or empty"
full_metadata_ko.onscreen_subtitles value: [] "full metadata must use scene_based_short_subtitles"
highlight_metadata_ko.report_description       "## 1. 작업 개요 jewelry lost wax casting의..."
                                               "must be natural Korean, not English or empty"
```
- variant 에러 메시지(분리됨):
  - `full_generation_error`: full_caption_script_ko, full_metadata_ko.report_description,
    full_metadata_ko.onscreen_subtitles → **held**
  - `highlight_generation_error`: **highlight_metadata_ko.report_description** → **failed**

## 2. 하이라이트가 full_caption_script_ko를 요구하나 → 아니오 (분류 원문)

`classifyLongformValidationIssues` (4979-5005):
```
variantIssue.highlight = allIssues.filter(issue => /highlight|hook/i.test(issue));  // 4998
variantIssue.full      = allIssues.filter(... /(^|_|\.)full|story|scene_transitions|.../ ...); // 4988
```
- `full_caption_script_ko`는 `/highlight|hook/`에 **안 걸린다** → highlight variant에 **미포함**.
  full variant로만 분류됨.
- 그런데 `markValidationFailedVariants` (5028-5031)가 details를 이렇게 채운다:
  ```
  next[`${variant}_generation_details`] = { missing, invalid_japanese_captions: info.invalidCaptions };
  ```
  → **양쪽 variant 모두 invalidCaptions 전체(4개)를 details에 복사.** 그래서
  highlight_generation_details에도 full_caption_script_ko가 보이지만, **highlight의 실제
  실패 사유(error/status)는 report_description 하나뿐.**
- **하이라이트 report_description이 왜 무효**: `requireKoreanField` (6510) →
  `hasLongLatinWord` (6473, 해시태그·4K/3D 제외 후 `[A-Za-z]{2,}` 존재 시 true). 실패값에
  "jewelry lost wax casting", "Lost Wax Casting"(실납법 = 영어 기법명)이 박혀 있어 무효.
  → **영어 오염 감지가 정상 작동한 것.** 빈 값이 아니라 영어 혼입.

## 3. 언제부터 / 뭐가 바뀌었나 → 코드 회귀 아님, 콘텐츠+쿼터

### 검증 가드는 최근 커밋 아님
| 가드 | 도입 커밋 | 날짜 |
|---|---|---|
| `hasLongLatinWord` + highlight EN 검증 | **003a985** "…EN contamination 0" | 2026-07-14 |
| 파편 게이트 + held | 572578e / 05f1e8e | 2026-07-21 |
| 내 커밋 96c23cc(ja-fix)·11b8940(rate limiter) | — | **롱폼 full·throttle만, shortform highlight 검증 미변경** |

### item_008 로그 인과 (원문, 16:34~16:52)
```
16:34:29 scene 호출 제한/일시 오류(429): 10초 후 재시도       ← 이 아이템에 429 압박 존재
16:37:19 review 요청 시작(1/3)
16:37:23 review 단계 실패: Vertex Gemini review analysis failed / 로컬 검증으로 살립니다  ← 4초만에 즉시 실패(429 정합)
16:37:23 Full 원고 배열 누락: 전용 원고 재요청
16:38:32 repair 응답 KO 20개 → 게이트 차단: "pseudo-sentence groups made only of fragments"  ← 파편
16:39:32 repair 응답 KO 20개 → 게이트 차단: "three or more consecutive non-sentence"         ← 또 파편
16:39:40 최종 검증 실패 상세: full_caption_script_ko / full_metadata_ko.report_description /
         onscreen_subtitles / highlight_metadata_ko.report_description("jewelry lost wax...")
16:40:21 full 포맷 보류(held): 파편 원고, script_review.txt 생성
16:40:21 highlight 포맷 실패: invalid Japanese/Korean captions
16:52:39 드래프트 생성 보류(held)
```

### 해석
- **review 콜이 시작 4초 만에 실패**(타임아웃 아님 = 즉시 거부, 16:34 scene 429와 함께 429
  정합). review는 LLM 기반 정리/검증인데, 죽으면 **엄격 로컬 검증으로 폴백**된다
  ("로컬 검증으로 살립니다"). 폴백 로컬 검증이 **파편(full) + 영어(highlight)** 원본을 그대로
  잡아냄.
- 이 소재는 **"lost wax casting / jewelry"(영어 기법명)** 라, Gemini가 한국어 report에 영어
  기법명을 반복 삽입 → EN 가드가 거부. + 한국어 full 원고가 **파편**으로 나옴(2회 repair도 파편).
- **저장된 최종 `highlight_metadata_ko.report_description`는 지금 영어 0개(깨끗)**. 즉 결정적
  EN 폴백/정규화가 실패 스냅샷 **이후** 값을 정리했지만, variant는 이미 16:40:21에 failed로
  마킹됨. → **failure는 실패 시점 스냅샷 기준이고, 저장본은 사후 정리된 상태.**

### "며칠 전엔 잘 나왔는데"의 가장 정합한 설명
- **review 콜이 성공할 때(쿼터 여유)**: review LLM이 영어/파편을 정리하고 넘겨 로컬 검증 통과
  → 하이라이트 나옴.
- **지금(DSQ 429 압박)**: review 콜이 즉시 429로 죽어 엄격 로컬 검증으로 폴백 → 원본
  파편/영어가 그대로 실패. + 하필 영어 기법명 소재라 EN 가드에 정면으로 걸림.
- **서버 재시작으로 잠재 버그 노출 가설**: 이 실패를 설명하려고 그걸 끌어올 필요 없음. 가드는
  07-14부터 커밋되어 있었고, highlight 분류(report_description만)도 정상. 증거는 **회귀가 아니라
  쿼터(review 실패)+콘텐츠(영어 기법명+파편)** 를 가리킨다.

## 요약표

| 질문 | 원문 기준 답 |
|---|---|
| 하이라이트 실패 필드 | **highlight_metadata_ko.report_description** (영어 "lost wax casting" 혼입) |
| full_caption_script_ko가 왜 highlight에 뜨나 | details가 full 검증 전체를 양쪽 variant에 복사(표시 아티팩트). highlight 분류/에러엔 미포함 |
| report_description 무효 사유 | 빈 값 아님 — `hasLongLatinWord`(영어 2자+) = "jewelry lost wax casting" 등 영어 혼입 |
| 하이라이트가 풀 필드 요구? | **아니오.** classifyLongformValidationIssues가 /highlight|hook/로만 분류 |
| 언제부터 | 가드는 003a985(07-14). 내 최근 커밋(96c23cc/11b8940) 무관 |
| 지금 실패 원인 | review 콜 429 즉시 실패 → 엄격 로컬 폴백 → 파편(full held) + 영어(highlight failed). 영어 기법명 소재가 EN 가드에 직격 |

## 함의 (수정 아님 — 판단 자료)

- 하이라이트 실패는 **콘텐츠 품질(영어 기법명 혼입) + review 콜 쿼터 실패**의 결과. 429가
  간접 원인(review 정리 단계를 죽여 원본 오염이 노출됨). [[vertex-429-payload-and-quota-state]]
- 만약 영어 기법명(고유명사)을 하이라이트 report에 허용하고 싶다면 EN 가드에 화이트리스트/
  고유명사 예외가 필요(현재는 라틴 2자+ 전면 거부). 단 이는 정책 변경이라 별도 승인 대상.
- review 콜이 쿼터로 죽지 않으면(쿼터 여유/재시도 성공) 정리 단계가 살아 통과율이 오른다.
