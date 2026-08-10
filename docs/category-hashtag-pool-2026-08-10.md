# 카테고리별 해시태그 풀 (2026-08-10 수집)

수집 방법: `scripts/collect_category_hashtags.py` — 적격 카테고리 6종 × JA/KO
YouTube 검색(롱폼 4분+ 필터, 카테고리당 10~12편) + 우리 큐의 성공 소스 28편.
yt-dlp 메타데이터만 사용(다운로드·API 비용 0원). 원본 빈도 데이터:
`server/output/hashtag-research/category_hashtags_20260810.json` (로컬).
채널 고유 브랜드 태그와 `yt:cc=on` 등 시스템 태그는 아래 표에서 제외했다.

## 1. 코어 풀 — 성공 소스 28편이 실제로 달고 있던 태그

빈도순: `한국공장(6)` `제조과정(6)` `mass production(6)` `process(6)`
`#process(6)` `factory(5)` `making process(4)` `manufacturing(4)`
`台灣工廠(4)` `#factory(4)` `#massproduction(4)` `#processvideo(3)`
`korean factory(3)` `how it's made(3)` `#processingplant(3)`

- 우리 하이라이트가 나오는 영상의 공통 어휘 = **업로드 해시태그이자 Phase 1 검색 키워드**.
- 주목: `台灣工廠` 4건 — 성공 풀에 대만 공장 영상 비중이 있다. Phase 1 검색에
  중국어권 키워드(台灣工廠, 工廠 제조 등)도 유효하다는 신호.

## 2. JP 업로드용 (JP Highlight 채널)

| 카테고리 | 검색에서 확인된 실사용 해시태그 |
|---|---|
| 공통/발견 | #工場見学 #factorytour #製造工程 |
| 금속 가공 | #鋳造 #機械加工 #金型 #アルミダイカスト #精密金型 |
| 공예 | #伝統的工芸品 #tewaza #densan (전통공예 공식 계열) |
| 농수산 | #収穫 #農業 #農業技術 #farming #agriculture |
| 기계/조립 | #エンジンオーバーホール 系 — 표본 약함, 재수집 필요 |

## 3. KO 업로드용 (KR 채널)

| 카테고리 | 검색에서 확인된 실사용 태그 |
|---|---|
| 공통/발견 | 제조과정, 대량생산, 공장, **#극한직업** (KR 공정 콘텐츠 소비의 최대 관문 — EBS 다큐 문법) |
| 식품 | 식품공장, korean food factory, mass production, korean street food |
| 공예 | **#asmr** (KR 공예 공정 영상은 ASMR 소비 맥락이 지배적 — 7/11편) |
| 농수산 | 수확, 농기계, 스마트팜, 첨단농업, 유기농 |
| 기계/조립 | #자동차공장 #생산공장 #전기차 |

주의: `#골라듄다큐`(빈도 1위권)는 EBS 브랜드 태그라 우리 업로드에 다는 건
무임승차 리스크 — 태그로 쓰지 말고 **검색 유입 문법의 참고**로만.

## 4. EN/글로벌 (소스 발굴 + 도달 보조)

`mass production` `process of making` `how it's made` `making process`
`factory tour` `#massproduction` `#processvideo` `#processingplant`

## 5. 활용처

1. **Phase 1 검색 키워드**: 코어 풀 + 카테고리 키워드 → 소재 발굴 검색어 확장
   (특히 台灣工廠 등 중국어권).
2. **업로드 해시태그 보강**: 현재 Gemini가 영상별 해시태그를 생성하는데, 이
   풀을 프롬프트에 "선호 어휘"로 주입하면 발견성 태그(#工場見学, #극한직업류
   문법, #asmr)가 섞인다 — **프로덕션 프롬프트 수정이므로 별도 승인 필요.**
3. 재수집: `python scripts/collect_category_hashtags.py --json <out>` (카테고리
   쿼리는 스크립트 상수; machine_assembly 쿼리는 개선 여지).
