# 전체 자동화 파이프라인: 소스 정찰 → 제작 → 캡컷 내보내기 → 예약 업로드

2026-08-19 구축. 소스 채널에서 후보를 골라 검증하고, 만들어진 드래프트를 실제 CapCut으로
내보내 KR/JP 채널에 예약 업로드하는 체인. 각 단계는 독립 실행 가능하고, 상태 파일이
중복 발행을 막는다.

## 체인

```
scout-sources.js ──(--launch)──▶ runMidformFullAutoWorkflow ──▶ 드래프트 설치
                                                                    │
build-upload-metadata.js ◀──(auto-publish가 폴더마다 호출)──────────┘
        │  upload_meta.json (제목·설명·태그·variant)
        ▼
auto-publish.js: CapCut 내보내기 → 길이 검증 → 라우드니스 → private+publishAt 예약 업로드
```

## 단계별

1. **소스 정찰** — `node scripts/scout-sources.js --limit 30 --recon`
   - 채널: `midform/config/source_channels.json` (현재 Clip Empire).
   - Content ID 3층 방어 중 1층(배급사 대장: `movie_catalog.json`의 `distributor_tier`,
     Sony 계열 banned)과 2층(생존 정찰: 같은 영화 서드파티 클립 생존 확인)을 자동화.
   - 카탈로그 미등록 영화는 `needs_research`로 보고 — **배급사·일본 개봉명을 확인해
     카탈로그에 등록한 뒤에만** 후보가 된다(개봉명 날조 금지).
   - `--launch N`으로 상위 N건을 full-auto 제작에 투입.

2. **업로드 메타데이터** — `node scripts/build-upload-metadata.js <드래프트 폴더>`
   - 제목: 발행 패키지(social_posts.<loc>.txt)의 [YouTube] 섹션 = 후킹 패턴 게이트 통과본.
   - 설명: 캡션 + 영화 크레딧 + `영화: 제목 (원제, 연도)` 자동 삽입.
   - 태그: **ja는 일본 개봉명 필수**, ko는 한국 제목+원제. banned 배급사는 빌드 거부.

3. **내보내기+예약 업로드** — `node scripts/auto-publish.js --prefix <설치 프리픽스>`
   - CapCut 내보내기는 화면 자동화(`capcut_export_one.py`): **잠금 해제된 데스크톱**에서만.
     좌표는 `capcut_export_coords.json`(2880×1800, CapCut 최대화 기준) — 해상도가 바뀌면 재보정.
   - 오출력 가드: ffprobe 실측 길이 ≠ 매니페스트 길이(±2s)면 `held/`로 격리
     (검색 오작동으로 다른 프로젝트가 내보내진 사건 방지).
   - 라우드니스: -14 LUFS 계약으로 정규화(fail-open).
   - 업로드: 로케일→채널 매칭(ko→ko_highlight 프로필, ja→jp_highlight 프로필),
     `private + publishAt`. 슬롯은 채널별 08:00·18:00(UTC+9) 고정 — 운영 절 참고.
   - 상태: `server/data/auto_publish_state.json` — 같은 드래프트는 두 번 안 나간다.

## Content ID 프리플라이트 3층 (케이스북 교리)

- 1층(선정)·2층(정찰)은 scout가 자동화.
- **3층(발행)은 자동화 불가**: Studio Checks는 API로 안 열린다. auto-publish가 전부
  비공개+예약으로 올리므로, **공개 시각 전에 Studio > 콘텐츠 > 검사 탭에서 소유권 주장을
  확인**한다. 차단 주장 발견 시 예약 해제 + 케이스북 대장 기록. 리포트 말미에 체크리스트 포함.

## 채널 프로필

- JP: `full_draft_channel` (AIR POINT) — midform에 연결됨.
- KR: **midform 저장소에 미연결.** content-pipeline 프로젝트에 Mansa(ko_highlight) 토큰이
  있음 — 옮기려면 `content-pipeline.../server/data/youtube_upload_profiles.json`의
  ko_highlight 항목을 midform의 같은 파일 `profiles` 배열에 복사(토큰 포함, git 밖).
  또는 서버의 OAuth 연결 플로우(getAuthorizationUrl)로 새로 연결.
- 프로필 purpose ↔ variant: `ko_highlight`↔`ko_highlight`, `jp_highlight`↔`highlight`.

## 운영 (소유주 확정 2026-08-20)

- **야간 배치**: 매일 00:05 Task Scheduler(`midform-nightly`, Interactive only)가
  `scripts/nightly-batch.js` 실행. 자정~07:00 사이에만 작업하고(07:00 데드라인 가드 —
  넘길 작업은 시작하지 않고 다음 밤으로), 밤당 소스 2개 → ko/ja 4편 제작·설치·내보내기.
- **발행 슬롯 고정**: 채널별 08:00·18:00(UTC+9), 하루 2편/채널. auto-publish가 state의
  기예약 슬롯을 피해서 다음 빈 슬롯에 `private+publishAt` 예약. 슬롯 마감 45분 전
  리드타임 미달이면 다음 슬롯으로 밀린다(Studio Checks 확인 창 확보).
- 잠금 해제된 데스크톱 필수(CapCut 화면 자동화). 스케줄 해제: `schtasks /Delete /TN midform-nightly /F`.
- 리포트: `server/output/nightly-reports/`, `scout-reports/`, `auto-publish-reports/`.
