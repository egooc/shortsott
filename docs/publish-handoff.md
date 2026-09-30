# 업로드 인수인계 — 린박스 세션용

**린박스는 생산부터 업로드까지 그쪽 세션이 전부 한다.** 이 문서는 «올리는 쪽» 정보만 넘긴다 —
채널·계정·문지기·슬롯·Content ID 방어다. 명화관 생산 방식은 여기 없다(그쪽과 무관하다).

린박스 완성본도 명화관과 **같은 발행 경로**를 쓸 수 있다.
새로 만들 것은 「완성본 mp4 + 드래프트 폴더」 하나뿐이고, 그 뒤는 이 경로가 알아서 한다.

작성 2026-09-28. 근거가 되는 사례 번호는 `docs/source-casebook.md` 를 보면 된다.

---

## 1. 무엇을 만들어 놓으면 되나

두 자리에 파일을 놓는다. 이름이 **정확히 같아야** 한다.

```
~/Desktop/캡컷아웃풋/CapCut Drafts/_automation factory/<드래프트이름>.mp4   ← 올릴 완성본
~/Desktop/캡컷아웃풋/CapCut Drafts/<드래프트이름>/                          ← 드래프트 폴더
        draft_content.json      (필수 — 없으면 아예 목록에 안 잡힌다)
        edit_manifest.json      (필수 — 없으면 아예 목록에 안 잡힌다)
        upload_meta.json        (필수 — 제목·설명·태그·variant)
        social_posts.<ko|ja>.txt (타 플랫폼 본문)
```

**드래프트 이름 규칙은 정규식으로 강제된다**: `^\d{8}[a-z]?-.+-(ko|ja)$`
```
20260928c-sh_collateral-ko      ← 맞다
20260928c-sh_collateral-ko-ko   ← 이것도 통과하지만 로케일이 두 번 붙은 «알려진 버그»다.
                                   새로 만들 때는 한 번만 붙여라.
```

## 2. `upload_meta.json` — 여기서 제일 많이 깨진다

```json
{
  "locale": "ko",
  "variant": "ko_highlight",
  "title": "...",
  "description": "...",
  "tags": ["..."],
  "movie": { "key": "<movie_catalog.json 의 키>" }
}
```

★**`variant` 가 틀리면 그 배치 전체가 죽는다.** ko 는 `ko_highlight`, ja 는 `highlight` 다.
다른 값이면 `createUploadJob` 이 던지고 **같은 회차의 다른 편들까지 같이 못 올라간다**
(2026-09-25 실측: 군림보 드래프트 하나가 38시간짜리 발행 정지를 만들었다).
지금은 per-item 필터가 있어 mismatch 를 건너뛰지만, 애초에 맞춰서 넣어라.

★**손으로 쓰지 마라.** 정본 생성기가 있다:
```
node D:\midform\scripts\build-upload-metadata.js <드래프트이름>
```
직접 써 넣었다가 `meta.title.slice` 에서 업로드가 터진 적이 있다(2026-09-24).

★`movie.key` 는 `midform/config/movie_catalog.json` 에 실제로 있는 키여야 한다.
없으면 크레딧·금지 판정이 전부 헛돈다.

## 3. 올라가기 전에 통과해야 하는 문지기 — 순서대로

`node D:\midform\scripts\auto-publish.js` 가 이 순서로 검사한다. **전부 fail-closed** 다.

| 순 | 문지기 | 막히면 |
|---|---|---|
| 1 | **금지 영화 실시간 조회** | 카탈로그의 `distributor_tier: banned` 를 **그 자리에서** 다시 읽는다. `upload_meta.json` 에 박제된 tier 는 낡을 수 있어서다 |
| 2 | **variant 필터** | 채널과 안 맞는 편만 건너뛴다(§2) |
| 3 | **동기화 감사** | `audit_sync.py` 가 Groq STT 로 **자막 시각 전수**를 실제 발화와 대조한다. 어긋나면 mp4 를 `_held/` 로 옮기고 멈춘다 |
| 4 | **검수 승인** | `publish_approvals.json` 에 없으면 멈춘다 |
| 5 | **빌드 해시 결속** | 승인은 `draft_content.json` + `edit_manifest.json` 의 바이트에 묶인다. **매니페스트를 한 글자라도 고치면 승인이 자동 무효화**되고 재승인이 필요하다 |

승인:
```
node D:\midform\scripts\approve-publish.js <드래프트이름> [<드래프트이름> ...]
node D:\midform\scripts\approve-publish.js --list      대기 목록
node D:\midform\scripts\approve-publish.js --revoke <이름>
```
★승인은 «mp4 를 본 사람」이 하는 것이다. 기계 검사를 통과했다고 승인이 아니다.

## 4. 언제 올라가나

- 슬롯 고정: **08:00 · 12:00 · 18:00 (KST/JST)**, 채널당 하루 3편
- 슬롯마다 `SLOT_LEAD_MIN = 45분`의 여유가 필요하다. 업로드가 끝나고 Content ID 가 훑을 시간이다
- 업로드는 항상 **비공개 + publishAt** 으로 들어간다. 공개 전 창이 3층 방어의 자리다
- 자동 실행: 작업 스케줄러 `midform-auto-publish`(06:45) · `-1045` · `-1445`

## 5. Content ID 방어 3층 — 3층만 한 번도 안 뚫렸다

```
1층  배급사 등급(카탈로그)        → 자주 틀린다. 믿지 마라
2층  claim-probe (사전 프로브)    → 절반쯤 놓친다
3층  check-claims (업로드 후)     → 23편+ 잡는 동안 공개로 샌 것 0편
```

```
node D:\midform\scripts\claim-probe.js <완성본.mp4> --locale ko|ja --start 0 --len <길이> --wait-min 30
node D:\midform\scripts\claim-probe.js --recheck
node D:\midform\scripts\check-claims.js --all --unschedule
```

★**프로브에는 «완성본」을 줘라.** `--middle` 로 원본 소스 조각을 올리면 CLEAR 가 나와도 의미가 없다 —
실제로 2/2 차단된 영화들(트랜스포머·영 셸든·북 오브 엘라이)의 소스 조각 프로브가 나흘째 CLEAR 다.
막히는 것은 소스가 아니라 **우리가 만든 그 물건**이다. (사례 111 정정)

★`check-claims --unschedule` 은 차단된 편의 `publishAt` 을 `blockedPublishAt` 으로 옮긴다.
유튜브에서는 안 나가지만 **타 플랫폼 발행기는 그 값을 보고 그대로 내보낸다** — 버려지지 않는다.

## 6. 채널과 타 플랫폼

`midform/config/blotato_accounts.json` 이 정본이다.

```
ko  냐옹시네마        youtube · tiktok · instagram · facebook · threads · naver_clip
ja  沼落ちシネマ       youtube · facebook · instagram · tiktok · threads
```

- `role: monetize` 는 유튜브와 틱톡 둘뿐이다. 나머지는 `reach`(확산 축)다
- ★**틱톡 크리에이터 리워드가 2026-10-27 까지 정지 상태다**(30일 내 5편 자격 박탈).
  게시물이 내려간 건 아니고 수익 자격만 빠졌다. 이의 제기 기회가 **한 번** 남아 있다
- 유튜브에서 차단돼도 나머지 플랫폼으로는 나간다(§5의 `blockedPublishAt`)

## 7. 길이 — 막지 않는다

```
node D:\midform\scripts\check-length.js <완성본.mp4>
```
- 소유주 규정: **61초 초과**. 180초는 숏츠 하드 한도
- 61~70초가 저위험 구간, 70~88초는 주의, 88초+ 는 실측 차단 구간이다
- ★**명화관 엔진은 85초 미만을 못 낸다**(서버가 `duration_repair` 로 반려) + 후킹 3~4초 필수
  → 명화관 최종본은 90~100초에 앉는 것이 정상이고, 이 검사는 **기록만** 한다 (사례 178)
- 린박스는 서버 상한이 50초(`duration_limits {target:45, min:40, max:50}`)라 이 대역에 못 온다.
  **60초 규정을 린박스에도 적용할지는 소유주 미결이다** — 올리기 전에 확인해라

## 8. 알아두면 시간 버는 것들

- **윈도우 `.cmd` 는 ASCII + CRLF 여야 한다.** OEM 코드페이지라 한글 주석이 깨져 파일 전체가 안 돈다
- **bash heredoc 으로 파일을 만들지 마라.** 백슬래시가 뭉개진다. Write 도구를 써라
- `schtasks /fo LIST` 는 OEM 한글이라 깨진다. `/xml ONE` 로 받아 파싱해라
- 작업 폴더의 완료 판정은 브리핑 문구가 아니라 `.volcano_drive_state.json` 의
  `status: done` + `step: rinbox_finish` 다
- 유료 열쇠를 새로 발급하지 마라. TTS 재사용이 깨진다. `paid/` 폴더도 지우지 마라

## 9. 계정·열쇠가 어디 있나

```
midform/config/blotato_accounts.json     채널·플랫폼·accountId 매핑 (정본)
server/data/youtube_upload_profiles.json 유튜브 OAuth 프로필 (purpose: ko_highlight / jp_highlight)
.env                                     BLOTATO_API_KEY · YOUTUBE_OAUTH_* · GROQ_API_KEY 등
~/.volcano/keys/                         볼케이노 쪽 열쇠(typecast · speechmatics · gemini …)
```
★**열쇠를 새로 발급하지 마라.** 기존 TTS 재사용이 깨진다. 공유할 때도 파일 경로만 알려라.

## 10. 작업 스케줄러에 이미 도는 것들

린박스 편이 같은 폴더에 들어오면 **이것들이 자동으로 집어간다.** 원치 않으면 이름 규칙을
피하거나(§1) 승인을 안 하면 된다 — 승인 없이는 아무것도 안 올라간다.
```
midform-auto-publish / -1045 / -1445    06:45 · 10:45 · 14:45  업로드+예약
midform-claim-guard-0740 / -1140 / -1740               발행 전 차단 재확인
midform-claim-watch                     12:05           업로드 후 감시
midform-probe-recheck                   12:25           프로브 재확인
midform-fanout-backfill-*               10·14·16·20·22시 타 플랫폼 누락분 보충
midform-webpublish-0800 / -1200 / -1800                네이버 클립
```
