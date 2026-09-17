---
name: source-scout
description: 소스 채널을 정찰해 채널 평균 이상 고성과 클립을 후보로 뽑고, 미등록 영화를 조사 큐로 집계해 movie_catalog.json에 등록하는 표준 절차. 등록이 곧 후보 공급이다(0→137 실측).
---

# 소스 정찰 · 영화 등록 (스카우트 이후의 당연한 과정)

소유주 지시(2026-08-30): 스카우트 후 needs_research 상위 작품의 **배급사·일본 개봉명 조사 → 카탈로그 등록**은
선택이 아니라 표준 후속 단계다. 채널만 추가해서는 후보가 0건이다 — `movie_catalog.json` 등록이 후보를 만든다
(등록 전 0건 → 트와일라잇 2편 등록 30건 → 15편 트랜치 137건, 전부 같은 날 실측).

## 1. 정찰 실행

```
cd D:\midform
node scripts\scout-sources.js            # 리포트만
node scripts\nightly-batch.js --dry-run --sources N   # 배치 문맥에서 후보 수 확인
```

산출물: `server/output/scout-reports/scout-<stamp>.{json,md}`
- `channels[].avg_views` — 채널별 평균 조회수(전체 리스팅 기준, 이미 생산된 것 포함)
- `candidates[]` — 등록·통과된 후보. `above_channel_avg: true`(▲)가 소유주의 선택 규칙
  "채널 평균 이상 고성과"의 기계 판정이다. 정렬: recon → ▲ → 조회수 → 길이.
- `research_queue[]` — **미등록 클립을 영화별 집계, 총 조회수 랭킹 상위 25**. 이 리스트가 조사 대상이다.
- `needs_research[]` — 원본(읽지 말 것, 수백 건). `dropped[]` — banned 배급사·길이 미달.

## 2. 조사 큐 상위 작품 등록 (핵심 단계)

research_queue 상위부터, 작품마다 3가지를 **검증**한다:

1. **배급사 티어**: Sony 계열(Columbia/Screen Gems/TriStar/Sony Pictures)이 국내·해외 어느 쪽이든
   관여하면 `distributor_tier: "banned"`로 **등록한다**(스킵하지 말 것 — 등록해야 조사 큐에 재부상하지
   않고 dropped로 흘러간다. 에린 브로코비치 사례). 그 외는 `"preflight"`.
2. **일본 개봉명(title_ja)**: 반드시 실제 개봉명. **날조 절대 금지** — 확신 없으면 웹 검색으로
   映画.com/シネマトゥデイ/ja.wikipedia에서 확증한다(ディクテーター 身元不明でニューヨーク처럼
   부제가 붙는 경우가 흔하다). ja 해시태그·크레딧이 이 값을 그대로 쓴다.
3. **스타일 적합**: 하우스 스타일은 대사 주도다. 대사 빈곤 소스(콰이어트 플레이스류, 순수 액션 몽타주)는
   등록해도 `MIDFORM_PLAN_NARRATION_INFEASIBLE`(밀도 하한>2.5/분)로 떨어진다 — 등록 보류하고 큐 노트에
   사유를 남긴다. 애니메이션도 보류. 비영어 원어는 note 필드에 경고를 남긴다(소림축구 사례).

등록 항목 형식은 기존 항목을 복사한다 (`midform/config/movie_catalog.json`):
`match`(정규식) / `title_ko` / `title_en` / `title_ja` / `year` / `distributor` / `distributor_tier` /
`credit_ko` / `credit_ja` (+ 선택 `note`).

## 3. match 정규식 함정 (전부 실사고, 2026-08-30 하루에 3건)

classify()는 **등록 순서대로** 첫 매치를 쓴다. 새 항목은 기존 항목 뒤에 추가되므로 기존 매치를 깨지 않지만,
프랜차이즈·동명 작품은 정규식으로 방어해야 한다:

- **부분 문자열 충돌**: "Casino"는 Casino Royale(Sony!)에, "Gladiator"는 Gladiator II에 매치된다 →
  `\bcasino\b(?!.*royale)`, `gladiator(?!\s*(ii|2))`.
- **lookbehind는 단어가 두 번 나오면 뚫린다**: "Top Gun: Maverick (2022): Maverick Goes Down"은
  `(?<!top gun )maverick`을 두 번째 Maverick으로 우회했다. **앵커형 부정 lookahead**를 쓴다:
  `^(?!.*top ?gun).*maverick`. 그리고 가능하면 충돌 작품 자체를 별도 등록한다(탑건: 매버릭도 Paramount).
- 등록 후 반드시 **분류 스모크 테스트**: 대표 제목 + 충돌 위험 제목으로 classify를 직접 호출해 OK/MISMATCH
  확인 (node -e 한 줄이면 된다). 그리고 정찰을 한 번 더 돌려 실데이터에서 오분류를 잡는다 —
  탑건 버그는 스모크가 아니라 실데이터 재실행이 잡았다.

## 4. 검증 및 마무리

1. `node --check scripts/scout-sources.js` (코드를 건드렸다면)
2. 정찰 재실행 → 후보 수 증가 확인, ▲ 플래그 일관성(▲인데 채널 평균 이하인 후보 0건) 확인
3. 커밋: 카탈로그 + 코드 변경을 근거(후보 수 변화)와 함께
4. 채널 추가 시: `midform/config/source_channels.json`에 id/name/url/note — 추가만으로는 후보가 늘지
   않는다는 것을 기억하고, 그 채널의 주력 영화들을 곧바로 2번 절차로 등록한다.

## 참고 수치 (2026-08-30 기준)

- 채널: Clip Empire(평균 20.6만뷰) + Binge Society(평균 66.3만뷰, 풀 장면 전문)
- 소스 하한: MIN_SOURCE_DURATION_SEC (짧으면 컷 런타임 미달로 드롭)
- 등록 26편 / 조사 큐 잔여 상위: How to Lose a Guy in 10 Days·빅쇼트·브레이브하트·우주전쟁(Paramount 계열 무난),
  Halloween(1978/2018 판 모호 — 클립별 확인), 콰이어트 플레이스 2(대사 빈곤 보류)

## 5. 유휴 루틴 (소유주 지시 2026-08-30: 아무 작업이 없을 때는 항상)

대기 틱·배치 감시 중 손이 비면 아래 중 하나를 돈다:

1. **채널 발굴 스윕**: `yt-dlp --flat-playlist -J "ytsearch40:movie full scene"` 류 검색 여러 개로
   채널명 수집(2회 이상 노출만) → 리스티클(WatchMojo)·트레일러 전문·애니/TV 위주는 제외 →
   생존 후보를 `/videos` 프로브(길이 적합 110~660s 비율, 평균 조회수, 상위 제목이 대사 장면인지) →
   적합하면 소유주에게 표로 제시하고 승인분만 `source_channels.json` 등록.
   핸들 추정(@Name)은 자주 틀린다 — 검색 결과의 `channel_url`에서 실제 채널 id를 회수한다.
2. **조사 큐 소화**: 최신 scout 리포트의 research_queue 상위를 2번 절차로 등록.

채널 등록 직후 needs_research가 수백 건 늘어나는 것이 정상이다(새 카탈로그 유입) — 그것이 다음
조사 큐 재료다.

## 6. 볼케이노 적합 태그 (소유주 지시 2026-09-17)

정찰 리포트의 `candidates[].volcano_fit`(md에서 🌋)은 **명화관cinema 프리셋 후보** 표식이다.
판정: 길이 240~660s + 단일 장면 제목(`Movie (year): Scene` / `Full Scene` / `Movie CLIP`).
채널 등록부 `tags`: `volcano`=완주 실측 채널(Binge Society), `volcano-candidate`=풀 장면 위주라 적합 예상.

볼케이노로 보내기 전 체크: ①en 자막 있거나 대사가 명료(Speechmatics 무료 480분/월) ②한 사건이 결말까지
담김(서버 지시 1·9번) ③로고·워터마크는 `C:\Users\urban\volcano-runs\tools\prescan_overlay.py <src> --apply`로
선크롭한 `.precrop.mp4`를 `local_video`로 start ④애니메이션·몽타주 제외(미드폼과 같음).
볼케이노 산출물은 CapCut 드래프트 후보정에서 감상·감성 해설과 두 줄 자막을 얹는다 — 볼케이노 원고는 인과 연결만
(tools/명화관_원고규칙_서버지시.md).
