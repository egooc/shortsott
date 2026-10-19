# 린박스 운영 문서 — 드라마 클립 숏폼 라인

작성 2026-09-30. **ja = 일본 드라마 · ko = 한국 드라마** (소유주 결정 2026-09-30).
생산부터 발행까지 이 세션이 전부 한다. 업로드 루트만 명화관과 공유한다.

---

## 0. ★로케일마다 권리가 다르다 — 이게 제일 비싼 교훈

같은 작품(「닥터스」)을 같은 시각에 ko/ja 양쪽에 올렸더니:

| | ko `EQH_kK266Qg` | ja `qYfuehawnck` |
|---|---|---|
| `regionRestriction.blocked` | 없음 | **없음** |
| `licensedContent` | false | **true** |
| 조회수 | 2,847 | **4** |

ja 채널은 구독자 15,200(ko의 8.6배)인데 최근 20편이 **전부** 소유권 매칭 상태였고 도달이 죽어 있었다.
ko 는 같은 기간 매칭 0건에 편당 1,000~3,700회로 정상.

**차단 신호는 둘이다. 하나만 보면 놓친다.**
1. `contentDetails.regionRestriction.blocked` — 명화관에서 쓰던 신호
2. **`contentDetails.licensedContent === true`** — 차단 국가가 안 적혀도 도달이 죽는다

`check-claims.js` · `claim-probe.js` · `_claims-by-id.js` 세 곳 모두 이 신호를 보도록 고쳤고
(`--unschedule` 도 이 경우 예약을 내린다), `rinbox_catalog.works[*].locale_block` 을 두어
`rinbox-publish.js` 가 발행 직전에 막는다. 실제로 막히는 것을 확인했다.

**그리고 구간별로 걸린다** — 작품 전체가 아니다.
「サムギョプサルですが」 실측: 대사 구간 `CLEAR-21min`, 같은 회차 **군무 구간 `BLOCKED-2` (2분 만에)**.
→ 음악·군무·주제가 구간은 쓰지 마라.

---

## 1. 소재

### ko — 한국 드라마
SBS Catch 공식 유튜브의 **`#모았캐치` 계열**(`[요약]` 계열은 요약 자막이 박혀 있다).
현재 쓰는 것: 「닥터스」 `cSq6GzcVs9A` (19.4분 · 1920×1080).

### ja — 일본 드라마
**テレ東公式 ドラマチャンネル이 본편을 전화 무료 공개한다.** 예고편이 아니라 본편이라 훨씬 낫다.
현재 쓰는 것: 木ドラ24「サムギョプサルですが」 제1화 `KX--vzOb7zY`
(24분 · 1920×1080 · 2025-09-11 방영 · 주연 小田惟真 · 공식 무료 배포 「ネットもテレ東」).
2~4화도 같은 채널에 있다.
★한국어 대사 구간에만 일본어 자막이 구워져 있다 — 그 구간은 피한다.

### 고르는 순서
1. `ffprobe` 로 **1920×1080** 확인
2. `python D:/volcano-runs/_preset_trials/소스_화면검사2.py <파일>` — 레터박스·번인·고정표식
3. **눈으로** 컨택트 시트 확인 (검사기는 네 번 틀렸다)
4. **`claim-probe.js` 로 로케일별 탐침** — 대사 구간과 음악 구간을 따로 던져라
```
node scripts/claim-probe.js <source.mp4> --locale ja --start 460 --len 150 --wait-min 20
```
   판정: `CLEAR-<n>min` 만 통과. `MATCHED-licensedContent` 나 `BLOCKED-*` 면 그 구간은 버린다.

---

## 2. 제작 (볼케이노 `린박스` 프리셋 · `film-editor-v1`)

```
python <wd>/runner/volcano_drive.py --workdir <wd> --step <단계> \
       --payload <wd>\next_payload.json --tool volcano_video --max-steps 20
```
단계: `start → env → probed → rinbox_source → rinbox_plan → rinbox_camera →
rinbox_preview → rinbox_review → rinbox_finish`
완료 판정: `.volcano_drive_state.json` 의 `status: "done"`.

- 출입증은 **이틀 만에 만료**. MCP 도구로 `step='assets'` 를 부르면 새로 나온다.
  받은 JSON 을 한 글자도 고치지 말고 `.volcano_runner_key.json` 에 쓰고 sha256 을 대조하라.
- 새 작업 폴더에는 `runner/ fonts/ volcano_src.mp4 .volcano_runner_key.json` 만 복사한다.
  ★**`paid/` 와 `.volcano-asr` 를 복사하지 마라.** 비용을 아끼려고 rinbox04 의 것을 옮겼다가
  엔진이 「이미 유료 나레이션 기록이 있다」며 같은 자리를 돌았다(2026-09-29). 처음부터 다시 세우는 게 싸다.
- ja 는 `source_lang` 과 `lang` 을 **둘 다** `ja` 로 준다.

### 편집표(`rinbox_edit`) — 세 가지를 동시에 만족해야 한다

1. **컷 하나는 샷 하나 안에** — `boundary-picture-*.json` 의 `source_shots` 를 가로지르면
   「원본 컷 앞뒤에 일부 장면이 남거나 같은 장면의 시간이 건너뜁니다」
2. **자막 단어가 컷 안에 완전히** — 0.01초만 삐져나가도
   「Caption phrase does not match complete measured words inside this clip」.
   시작은 내림·끝은 올림으로 잡고 단어보다 0.05초 여유를 둬라.
   ★장면 전환이 **단어 한가운데**를 지나가면 그 단어는 자막에서 빼라(어느 컷에도 못 들어간다).
3. **앞으로만 간다** — 0.01초라도 겹치면 「이미 선택한 구간을 되돌린다」

이 셋을 자동으로 맞추는 도구: `D:/volcano-runs/rinbox05/_snap_cuts.py`
(`_edit_ko.json` 을 읽어 `_edit_ko_snapped.json` 을 낸다).

### `same_shot_source_gap`
내레이션 그림과 다음 컷이 같은 샷인데 프레임이 비면 난다.
**다음 컷 시작 프레임 − 내레이션 프레임 수** 로 붙인다. ★`round()` 하지 마라 — `frames/30` 그대로.
그 샷에 내레이션 프레임 수만큼 자리가 없으면, 거꾸로 **다음 컷을 내레이션 그림 끝으로 당겨라**
(rinbox05 에서 이 방법으로 풀었다).

### 카메라(cx)
`camera_brief.template.source_shots` 의 `points` 에 `[원본초, cx]` 를 넣는다.
★**검수 시트를 실제로 열어 얼굴 위치를 재라.** 격자선(0.3~0.7)을 그려 붙인 시트를 만들면 빠르다
(`rinbox05/_cam_sheets.py`).
★닥터스 소스는 **cx ≤ 0.50** — 넘기면 SBS CATCH 워터마크가 크롭에 들어온다(0.57 에서 샜다).
크롭 폭은 고정이 아니므로 숫자로 계산하지 말고 미리보기로 정하라.

### 미리보기·검수
`rinbox_preview` 는 원본|크롭 쌍 시트를 준다 — **전부 열어 봐라**. 워터마크 누출과 잘린 얼굴을 본다.
`rinbox_review` 는 완성본 프레임 수백 장을 준다. 압축 스캔 시트로 훑되,
`audio_listened` 는 **false 로 정직하게** 적어라(우리는 소리를 못 듣는다).

---

## 3. 발행

```
node scripts/rinbox-publish.js --approve <완성본.mp4>
node scripts/rinbox-publish.js <완성본.mp4> [--dry-run]
```
곁딸린 파일 `<완성본>.mp4.rinbox.json` 이 필요하다:
```json
{ "work": "<rinbox_catalog 의 키>", "locale": "ko|ja", "title": "...",
  "description": "...", "tags": ["..."], "workdir": "D:/volcano-runs/<wd>" }
```

게이트 순서(전부 fail-closed):
작품 카탈로그(실시간 재조회) → **로케일 차단** → 길이(기록만·180초 하드) → 작업폴더 결속
→ **Speechmatics 동기화 감사**(낱말 전수 대조) → 검수 승인(mp4 sha256 에 결속) → 라우드니스 → 슬롯 → 업로드

슬롯: 08:30 · 12:30 · 18:30 (KST). 명화관보다 30분 뒤.
**공개 전에 반드시** `node scripts/check-claims.js --all --unschedule`.

권리 표기(매 편):
작품명 + 풀버전 감상 권유 + 줄거리 + 출연 + **「★저작권자 요청 시 즉시 삭제합니다」** + 출처 URL.
★확인 안 된 OTT·배급사를 적지 마라. 작품은 **전사에 나온 등장인물 이름**으로 확인한다
(2026-09-26 에 「질투의 화신」을 「슬기로운 의사생활」로 잘못 적을 뻔했다).

---

## 4. 지금 상태 (2026-09-30)

| 런 | 로케일 | 상태 |
|---|---|---|
| rinbox04 | ko | 공개됨 `EQH_kK266Qg` · 2,847회 |
| rinbox04ja | ja | 공개됨 `qYfuehawnck` · **4회(소유권 매칭)** — 이 노선 폐기 |
| rinbox05 | ko | **예약 `nns-c9bGh2g` · 09-30 08:30** |
| rinbox06ja | ja | 제작 중 — 「サムギョプサルですが」 |

★ja 채널에 쌓인 `[private]` 미발행분은 전부 한국 소재이고 소유권 매칭 상태다. 발행해도 같은 결과다.

## 5. 도구

| 경로 | 용도 |
|---|---|
| `D:/volcano-runs/_preset_trials/소스_화면검사2.py` | 번인·레터박스·고정표식 검사 |
| `D:/volcano-runs/_preset_trials/화면검사_회귀.py` | 위 검사기 회귀 세트 — 고칠 때마다 돌려라 |
| `D:/volcano-runs/rinbox05/_snap_cuts.py` | 컷·자막을 샷 경계에 맞추기 |
| `D:/volcano-runs/rinbox05/_cam_sheets.py` | cx 판단용 격자 시트 |
| `D:/midform/scripts/claim-probe.js` | 제작 전 클레임 탐침(로케일별·구간별) |
| `D:/midform/scripts/check-claims.js` | 공개 전 확인 + 예약 해제 |
| `D:/midform/scripts/_claims-by-id.js` | 영상 ID 로 즉석 확인 |
| `D:/midform/scripts/_channel-trend.js` | 채널 조회수 추이(매칭 여부 포함) |
| `D:/midform/scripts/rinbox-publish.js` | 발행 |
| `D:/midform/scripts/rinbox-fanout.js` | Blotato 팬아웃 (★2026-09-29 현재 **구독 만료**) |

---

## 6. ★10-20 07:00 재부팅 인계 (10-19 작성) — 위 §4 상태표는 낡았다, 여기부터

**레인:** ja(沼落ちシネマ, 일본 65세+ 남성) 하루 3편 08/12/18시. ko 린박스는 10-14 중단(롱투숏으로).
**재고:** 10-25 18:00까지 예약 끝(유튜브 서버 예약 — 재부팅 영향 없음). 다음 빈 칸 10-26 08:00(23Z 10-25).

**자동화는 전부 윈도우 예약 작업(재부팅 뒤 자동 복귀):** `midform-rinbox-social`·`midform-rinbox-web`·`midform-rinbox-coverage`·`midform-low-views-private`(저조회 비공개)·`rinbox-feed-watch`.
태그 삽입·확인(tagGate)·가이드 관문은 `rinbox-publish.js` 발행 명령 안에서 돈다(별도 루프 없음). 세션 루프·cron 없음.

**진행 중 — 해설 2줄 시험편 rinbox133ja (style nar2, 10-19 소유주 «해설 한 줄 섞어서»):**
- 편집표 `D:/volcano-runs/rinbox133ja/plan_local.json`(地獄の辰 1화 902~955초, 컷마다 카메라 네 칸 `shot`), 업로드 정보 `_render/rinbox133ja-local.mp4.rinbox.json`(가이드 통과).
- 렌더는 RENDERING.lock 해제·빈 메모리 8GB 대기 루프로 걸어 둠(10-20 06:00 이후 시작 금지). 재부팅 전 못 했으면 **재개 명령 한 줄:**
  `cd /d/midform && PYTHONIOENCODING=utf-8 .venv-vision/Scripts/python.exe scripts/rinbox_render.py /d/volcano-runs/rinbox133ja/plan_local.json --out /d/volcano-runs/rinbox133ja/rinbox133ja-local.mp4`
- 렌더 뒤: `_render/` 로 옮기기 → 해설 역전사 대조 → `lufs_table.py`(−14 확인, 렌더러 목표 10-19에 −16→−14) → `rinbox-publish.js --approve` → `--publish-at 2026-10-25T23:00:00.000Z` → `rinbox-social.js --only rinbox133ja-local.mp4` → 관리자에 30MB 이하 샘플.

**소유주 결정 대기:** 118(DwttmzAhyYY, 10-21 03Z) 화면에 박힌 「弓も鉄砲も」 재렌더 교체 여부 · SAMURAI VS NINJA(일본만 차단) 소재 사용 여부.
**보류:** 必殺仕事人Ⅴ·激闘編(원본 `_sources/hissatsu5g03` 보관, 쓰지 않음). 10-19 이 PC 유튜브 자막 요청 429 — 다음 날 09시 창부터.
