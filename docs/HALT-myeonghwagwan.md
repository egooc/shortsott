# ★2026-10-06 재개 — 유튜브만 빼고 (소유주: "명화관 스타일 재개하는데 유튜브는 안올릴게")

아래 중지 기록은 **유튜브 부분만 유효하다.** 생산과 소셜 발행은 다시 돈다.

## 지금 도는 것
```
생산     midform-produce-hourly
승인     midform-auto-approve
소셜     midform-fanout-backfill-1000/1400/1600/2000/2200   (블로타토 4곳)
웹       midform-webpublish-0800/1200/1800                  (네이버클립 · 페이스북 프로필)
수리     midform-blotato-repair
소재     midform-catalog-pool · rival-scout · rival-backlog · survivor-signal
         scout-nightly · demand-gap
```

## 계속 꺼 둔 것 — 되켜지 마라
```
midform-auto-publish · -1045 · -1445     유튜브 업로드
midform-claim-guard-0740/1140/1740       Content ID 감시(유튜브 전용)
midform-claim-watch · midform-social-claims
midform_claim_guard_am · _pm
```
클레임 감시까지 끈 이유: 유튜브에 안 올리면 감시할 대상이 없고, `check-claims.js` 는
**영상을 비공개로 바꾸는 쪽**이라 켜 두면 손해만 난다(아래 원인 1).

## 소셜은 유튜브 없이 돈다 — 확인함
`blotato-publish.js` 의 `youtubePublishAt()` 이 유튜브 이력이 없으면 «지금»으로 떨어진다.
2026-09-23 수정(소유주: "타 플랫폼은 재사용 컨텐츠에 대해 상대적으로 다른 정책을 가지고
있기도 하고. 올려야 돼 버리지 말고")으로 이미 들어가 있던 길이다. 구조를 고칠 필요가 없었다.

## 재개 시점의 재고
9/30 에 만들어 놓고 못 나간 10편(등급 A 작품 5편 × ko·ja)이 남아 있었다 —
셰임리스 · 프리덤 라이터스 · 벤자민 버튼 · 백만 가지 방법으로 죽기 · 룸.
블로타토 4곳에는 9/30 에 이미 나갔고(즉시 발행), **네이버클립 · 페이스북 프로필만** 빠져 있었다.
재개 첫 작업으로 그 둘을 메웠다.

---

# ★명화관cinema 중지 (2026-09-30)

소유주 지시: **"명화관은 업로드 및 생산 중지."**

계기 — 소유주: "4주 전부터 올리기 시작한 명화관 컨텐츠 전부다 비공개되고 차단됬는데?"

## 지금 멈춰 있는 것

Windows 예약 작업 27개를 `Disable-ScheduledTask` 로 내렸다:

```
생산       midform-produce-hourly
유튜브     midform-auto-publish · -1045 · -1445 · midform-auto-approve
소셜       midform-fanout-backfill-1000/1400/1600/2000/2200
           midform-webpublish-0800/1200/1800
클레임     midform-claim-guard-0740/1140/1740 · midform-claim-watch
           midform-social-claims · midform-blotato-repair
           midform_claim_guard_am · midform_claim_guard_pm
소재발굴   midform-catalog-pool · midform-rival-scout · midform-rival-backlog
           midform-survivor-signal · midform-scout-nightly · midform-demand-gap
```

Blotato 예약 18건(meow_cinema21 · numaochicinema)도 전부 삭제했다 — 예약 0건.

**그대로 둔 것**(명화관이 아니다): `midform-catalog-audit` · `midform-chain-status` ·
`midform-metrics` · `midform-report-*` (읽기 전용) · `midform-facebook_profile-…mp4` ·
`midform-naverclip-…mp4` (린박스 rinbox04 수동 업로드) · 어랍숏/쇼핑 파이프라인.

## 다시 켜지 마라 — 켜기 전에 아래 둘을 먼저 해결해야 한다

### 1. 「전부 비공개」는 유튜브가 아니라 **우리 스크립트**가 한 것이다

`check-claims.js` 의 `unschedule()` 이 차단 판정 시 이렇게 한다:

```js
async function unschedule(token, item) {
  const status = { ...(item.status || {}) };
  delete status.publishAt;
  status.privacyStatus = 'private';      // ★여기
  ...
}
```

업로드는 `private` + `publishAt`(예약) 으로 올라간다. 차단 판정이 나면 이 함수가
`publishAt` 을 지우고 `private` 을 박는다. **되돌리는 코드는 어디에도 없다.**
그래서 차단 판정된 편은 영구 비공개로 남는다. 장부 96편 중 **72편이 공개 API 에서
아예 안 돌아온다**(= 비공개 또는 삭제). 돌아온 24편은 전부 public · 차단 0 ·
licensedContent false 로 깨끗하다.

즉 소유주가 본 「전부 비공개」는 **설계된 동작의 누적**이다. 차단 자체는 진짜지만
(차단율 68%, 사례 154), 「비공개로 만든 주체」는 유튜브가 아니라 우리다.
재개 전에 정해야 할 것: 차단 판정된 편을 비공개로 **남겨 둘 것인가**, 지울 것인가,
아니면 지역 차단만 받은 편은 그대로 공개할 것인가.

### 2. 유튜브 OAuth 갱신 토큰이 양쪽 다 죽었다

```
토큰 실패 jp_highlight: {"error":"invalid_grant","error_description":"Bad Request"}
토큰 실패 ko_highlight: {"error":"invalid_grant","error_description":"Bad Request"}
```

`server/data/youtube_upload_profiles.json` 의 `oauthRefreshToken` 둘 다 거부된다.
마지막 성공 업로드는 2026-09-30T01:45 이므로 그 뒤에 죽었다. 원인은 확인하지 못했다 —
후보: OAuth 클라이언트가 테스트 모드(7일 만료) · 사용자가 접근 권한 철회 ·
계정 비밀번호 변경 · **채널 단위 조치**. 앞의 세 개는 재발급으로 풀리지만 마지막이면
재발급해도 안 풀린다. **비공개 72편의 실제 상태를 확인하려면 이 토큰이 필요하다** —
공개 API 키로는 비공개 영상이 안 보인다.

★토큰을 새로 발급할 때 **볼케이노 유료 열쇠(`~/.volcano/keys/*`)는 건드리지 마라** —
  그건 별개이고, 새로 발급하면 TTS 재사용이 깨진다(소유주 상시 지시).

## 중지 전까지 쌓아 둔 것 (버리지 마라)

- 화이트리스트 144작품 · 등급 A 17 / B 11 (★단 신호 하나로만 잰 값 — 사례 159)
- 소스까지 두들겨 본 「만들 수 있는」 작품 15건(등급 A 9건) — `clip_candidates.json` 의
  `verified: true`
- 레퍼런스 채널 442곳 중 수확 완료 32곳, 큐 130곳 남음(`harvest_queue.json`)
- 생산 완료·미업로드: 셰임리스 · 프리덤 라이터스 · 벤자민 버튼(등급 A 3편)
