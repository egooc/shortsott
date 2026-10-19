# 쇼핑 채널 인수인계 — 볼케이노 `쇼핑` 프리셋

작성 2026-09-29. 이 문서 하나만 주면 다른 세션이 이어받을 수 있게 썼다.
**결론부터**: 파이프라인은 렌더 직전까지 뚫었다. 막고 있는 것은 기술이 아니라 **비용**이다
(§8). 그 판단이 먼저다.

## ★현재(2026-10-19) — ff 레인 운영 요약·재부팅 재개

아래 §0 이후는 9월 볼케이노 프리셋 시절 기록이다. 지금은 자체 렌더러 `scripts/ff_render.py`(최종 -14 LUFS) 레인으로 돈다.

**돌아가는 것 — 윈도우 예약 작업(schtasks, 재부팅 뒤 자동 복귀)**
| 작업 | 시각 | 하는 일 |
|---|---|---|
| midform-shop-produce-0030 / -0330 | 00:30 · 03:30 | `scripts/tasks/shop-produce.cmd` → `shop-produce-guard.js --claim` → `claude -p scripts/shop-produce-prompt.md`(재고 목표 4, 하룻밤 2편, 회차 3시간 한도). 보고서 `D:/volcano-runs/_upload/produce.log` |
| midform-shop-fill | 07:20 | `shop_schedule.js fill 2` — 재고(`stock_new_channel.json` ready)에서 08·18시 유튜브 예약, 태그 관문(`shop_yt_tags.js`), Blotato·Zernio(틱톡)·네이버 클립 작업 등록, 장부. 로그 `_upload/fill.log` |
| midform-shop-naver-<편> | 그 편 공개 시각 | 네이버 클립 업로드(편마다 1회, fill 이 만든다) |
| midform-shop-comments-0805 / -1805 | 08:05 · 18:05 | 고정 댓글 |
| midform-shop-metrics | 23:30 | 성과 수집 |
| midform-shop-weekly | 월 07:00 | 주간 보고 |

10/19: fill·comments-0805·네이버 작업에 «놓친 회차는 켜진 뒤 실행»(StartWhenAvailable)을 켰다. 새 네이버 작업도 shop_fanout 이 켠다. 모든 작업은 로그온 상태에서만 돈다(Interactive) — 재부팅 뒤 로그인해야 돈다.

**세션 안 cron(재부팅이면 사라짐 → 세션이 다시 만든다)**: 매일 03:13 밤 생산 점검, 07:37 fill 점검. 점검이 끝날 때마다 다음 날 것을 새로 만든다.

**재부팅 뒤 재개(쇼핑 세션)**
1. `tail -30 D:/volcano-runs/_upload/fill.log` — 오늘 08·18시 예약이 됐는지. 안 돌았으면 `D:\midform\scripts	asks\shop-fill.cmd` 1회.
2. `node scripts/shop_yt_tags.js --audit --days 3` — 태그 0개 편 없는지.
3. `schtasks /query /tn midform-shop-naver-<편>` — 오늘 편 네이버 작업 남아 있는지.
4. 관리자에게 새 주소로 첫 메시지, 다음 03:13·07:37 cron 재등록.

**소유주 결정 대기(10/19)**: 쇼핑 틱톡 Blotato 복귀(연결 뒤 accountId 교체·Zernio 매핑 62703 삭제), 2계정 분리(키우기/팔기)·이름·브랜드 표시, 하룻밤 3편(MAX_PER_NIGHT 3·TARGET 6), 키우기 100% 전환, 롱폼(발굴 레퍼런스 카드 docs/category-cards/2026-10-19-shopping-longform-reference.md 뒤 착수, 설명란 고지·직접 촬영 여부), 인포크 플랫폼별 분리 방식, 조회 0 자동 비공개 허락.

**유튜브 쇼핑 제휴 목표(10/19)**: 구독 500 + 롱폼 3,000시간(또는 90일 쇼츠 300만). 10/19 실측 구독 56·유효 시청 0시간(전부 쇼츠)·90일 쇼츠 36,524·YPP 미가입.

---

## 0. 지금 상태 요약

| 작업 폴더 | 소재 | 어디까지 | 남은 것 |
|---|---|---|---|
| `D:/volcano-runs/shop03` | 곰표 밀맥주 (한국 유튜브 2편) | 대본까지, **폐기** | — 소재가 전부 번인 |
| `D:/volcano-runs/shop04` | 알리 상품영상 1편 1280×720 | 배치 **0/19**, **폐기** | — 해상도 미달(§2) |
| `D:/volcano-runs/shop05` | 틱톡 3편 1080×1920 | 배치 19/19 · 컷검수 통과 · 주피사체 19컷 중 18컷 | 컷 1 재검이 18.7MB → HTTP 500 |
| `D:/volcano-runs/shop06` | 틱톡 5편 1080×1920 | 배치 21/21 · 컷검수 통과 · 주피사체 **13/21** | **EvoLink 잔액 소진** |

shop06 이 가장 앞서 있다. 충전하면 남은 8컷(7, 12, 16~21)부터 이어진다 —
완료된 13컷은 보존돼 재요청하지 않는다.

---

## 1. 돌리는 법

```
python D:/volcano-runs/<wd>/runner/volcano_drive.py \
       --workdir D:\volcano-runs\<wd> --step <단계> \
       --payload D:\volcano-runs\<wd>\next_payload.json \
       --tool volcano_video --max-steps 30
```

- 파이썬은 반드시 `C:/Users/urban/.volcano/venv/Scripts/python.exe`
- **종료 코드**: `3` = 사람이 채울 차례(정상 멈춤) · `1` = 진짜 오류 · `0` = 끝
- 단계 순서: `start → env → probed → transcript → shop_footage → shop_shots →
  shop_onepass → shop_script → shop_voice → shop_align → shop_caption →
  shop_place → shop_frame → shop_cuts → shop_render → shop_deliver`
- 출입증(`.volcano_runner_key.json`)은 **이틀 만에 만료**된다. 만료되면 MCP 도구로
  `step='assets'` 를 부르면 새로 나온다. 받은 JSON 을 **한 글자도 고치지 말고** 그 파일에
  쓰고 sha256 을 대조하라.
- 새 작업 폴더를 만들 때는 앞 폴더에서 `runner/ fonts/ framevision/ .volcano_runner_key.json`
  을 복사하면 된다.

---

## 2. ★소재 해상도 바닥 — 가장 비싸게 배운 것

**1280×720 소재는 자막을 한 장도 못 얹는다.**

| 런 | 소재 | 샷 | 1.06초 넘는 구간 | 얹힘 |
|---|---|---|---|---|
| shop03 | 1920×1048 + 1920×1080 | 50 | 43 | 13/20 |
| shop04 | 1280×720 | 80 | 74 | **0/19 · 대본 두 벌 모두** |
| shop05 | 1080×1920 ×3 | 43 | — | **19/19** |
| shop06 | 1080×1920 ×5 | 69 | — | **21/21** |

샷 개수·샷 길이·샷 간 중복도를 전부 재서 배제했다 — shop04 가 세 지표 모두 shop03 보다
나았는데도 0장이었다. 완성본이 1080×1920 이라 720p 에서 9:16 띠를 뽑으면 405×720 →
**2.67배** 확대가 필요하고, 1920×1080 이면 607×1080 → 1.78배다. shop02 반려문이 1920
소재에서도 「걸러진 사유 **확대율 2**」를 찍은 걸 보면 상한이 2배 근처다.

**규칙**: 소재를 고르기 전에 `ffprobe` 로 폭부터 본다.
가로는 **1920 이상**, 세로는 **1080×1920**(확대율 1.0 — 가장 좋다).
720×1280 세로는 1.5배라 통과 가능하지만 화질이 떨어진다.

---

## 3. 소재를 어디서 가져오나

### 3-1. 틱톡이 정답이다
1080×1920 네이티브라 확대가 없다. `yt-dlp` 가 그대로 받는다.
```
yt-dlp -f "bv*+ba/b" --merge-output-format mp4 -o "tt_%(id)s.%(ext)s" "<url>"
```
- 받은 뒤 **H.264 로 변환**해라. 틱톡은 HEVC 로 준다:
  `ffmpeg -i in.mp4 -c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p -c:a aac -b:a 128k -movflags +faststart -y out.mp4`
- URL 은 `WebSearch` 로 찾는다(`allowed_domains: ["tiktok.com"]`). 일부는 `Your IP address
  is blocked` 가 나온다 — 그건 건너뛰고 다음 후보로 간다.
- **크리에이터 자막이 박힌 것이 절반 이상이다.** 반드시 §4 로 거른다.

### 3-2. 알리·타오바오 상품 영상
`D:/midform/scripts/product-video-grab.js` (이번에 만들었다)
```
cd D:/midform
node scripts/product-video-grab.js --out <저장폴더> "<상품URL>" ["<상품URL>" ...]
```
- 알리는 순수 `curl` 에 **봇 차단 셸 75KB** 만 준다. Playwright + Chrome(프로필 `shopgrab`)
  으로 진짜 브라우저를 띄운다.
- ★**갤러리 첫 섬네일에 마우스를 올려야(hover)** 영상이 로드된다. 클릭만으로는 네트워크
  요청이 안 나간다. 이걸 몰라서 6개 상품 중 4개를 「영상 없음」으로 잘못 판정했다.
- 진단 줄(`html/videoId/.mp4/<video>`)이 전부 0 이면 **정말로 영상 없는 상품**이다.
- 내려받기: `video.aliexpress-media.com/play/u/<uid>/p/1/e/6/t/10301/<videoId>.mp4` 를
  `curl -e https://ko.aliexpress.com/` 로. `definition=` 을 뭘 넣든 화질은 안 바뀐다 —
  **판매자가 올린 해상도가 상한**이고 대개 720p 이하라 §2 바닥을 못 넘는다.
- 상품 제목·구매 후기도 같이 긁어 `_grab.json` 에 넣는다. `payload.transcript` 에 쓰면
  대본이 좋아진다. ★배송·결제 상투어가 섞이니 골라 써라.

### 3-3. 소재가 몇 개 필요한가
서버가 「소재가 모자랍니다 — 하나를 평균 N번씩 씁니다」로 경고한다(막지는 않는다).
shop05 3편 → 6.3회, shop06 5편 → 4.2회. 서버 권장은 8편(2.6회).
**제품 외형이 같은 것만 섞어라** — 흰색 기기 영상에 검은색 기기를 섞으면 다른 제품으로 보인다.
실제로 「전기 목욕 브러시(몸 씻는 것)」를 「욕실 청소 브러시」로 착각해 섞을 뻔했다.
제목을 반드시 확인해라.

---

## 4. 박힌 자막 검사 — 네 번 틀렸다

`D:/volcano-runs/_preset_trials/소스_화면검사2.py` 를 쓴다.
```
python D:/volcano-runs/_preset_trials/소스_화면검사2.py <파일> --samples 24
```
고칠 때마다 **회귀 세트**를 돌린다:
```
python D:/volcano-runs/_preset_trials/화면검사_회귀.py
```

**왜 회귀 세트가 있나** — 같은 자를 네 번 틀렸다.

| 틀린 판 | 증상 |
|---|---|
| ① 파란색을 찾게 만듦 | 흰 자막판을 못 봄. 크롭 84개에 「누출 0」이라 보고 |
| ② 밝은 글자 + 어두운 주변 | **노란 띠 위 검은 글자**(한국 리뷰·예능의 표준)를 통째로 놓침 |
| ③ 같은 자 | 어두운 시네마틱 광고에서 글자 없는 구간까지 64% 로 오탐 |
| ④ 가로로 긴 같은 색 | 살결·거품 같은 평평한 면을 자막 띠로 오인 |

②가 실제 사고를 냈다. shop03 에서 그 소재로 **13장을 얹은 뒤에야** 서버 비전이 글자를
읽어 들통났다. ★**`shop_place` 는 번인 구간을 거르지 않는다** — `shop_frame` 이 사후에
잡을 뿐이라, 검사기가 놓치면 남의 자막이 그대로 완성본에 실린다.

**v2 가 쓰는 자(극성과 무관한 것만)**
- 글자줄: 한 줄의 **획 경계 수**(밝기 부호가 바뀌는 횟수)
- 단색 띠: 줄의 **중앙값 색과 가까운(L1≤70) 화소의 점유율**
  - ★「이어진 길이」로 재면 안 된다 — 띠 안 글자가 바탕을 끊어 정작 글자 있는 줄을 놓친다
  - ★「똑같은 색(16단계 양자화)」으로도 안 된다 — 그라데이션·압축 잡음에 흩어져 0.2 로 나온다
- 띠 조건 셋: 높이 ≤16%H · 위아래 색이 뚝 끊김 · **띠 안에 글자가 있음**(결정적)

**지켜야 할 성질은 하나** — *더러운 소재를 OK 라고 말하지 않는 것*.
NG 대신 CHECK 가 나오는 건 「눈으로 보라」는 뜻이라 안전하다. 현재 5개 중 4개 정확 · 안전 위반 0.
★**최종 판정은 눈이다.** 보고서의 y 좌표로 프레임을 뽑아 직접 봐라. 컷 4장을 가로로 붙인
컨택트 시트를 만들면 영상 한 편을 이미지 한 장으로 볼 수 있다.

---

## 5. 번인이 조금 있는 소재는 잘라 쓴다

`onepass.analysis.burned` 가 글자 구간의 `t0/t1` 을 정확히 준다.
`D:/volcano-runs/shop05/_cut_burned.py` 로 그 구간을 파일에서 잘라 낸다.
```
python _cut_burned.py <workdir> <source_id> <입력 상대경로> <출력 상대경로>
```
- 대본을 갈아타며 재배치를 시도하면 TTS·ASR 이 매번 나가지만, **잘라 내면 다시는 선택될 수
  없다.** 훨씬 싸고 확실하다.
- shop05 S-02: 60.3초(글자 26.9초) → 1차 31.9초(글자 7.7초) → 2차 24.3초(**글자 0**)
- ★앞뒤로 0.2초씩 더 잘라라 — 비전의 t0/t1 은 프레임에 딱 안 맞아 한두 프레임이 남는다
- ★concat 은 **재인코딩**해야 한다
- 소재를 바꿨으면 §7 의 상태 초기화를 반드시 해라

---

## 6. 대본 — 자막 끊는 자리 설계법 (3연속 통과)

서버의 두 요구가 서로 당긴다: ①「더 길게 쓰세요」 ②「말이 닫히는 자리에서 끊으세요」.
자막 나눔은 **탐욕적**(앞에서부터 담다가 16자를 넘으면 거기서 끊음)이므로,
「문장」이 아니라 **「조각」을 먼저** 쓰면 끊기는 자리를 내가 정할 수 있다.

조각이 성립하는 조건 두 가지:
- **닫힘** — 끝말이 조사(J\*)·종결어미(EF)·절을 맺는 연결어미
- **재현** — `조각 길이 + 1 + 다음 낱말 길이 > 16`.
  빼먹으면 내가 정한 자리가 아니라 엉뚱한 데서 끊긴다

검산기: `D:/volcano-runs/shop06/_polish_check.py` (CHUNKS 만 바꿔 쓴다)
결과: shop02·shop04·shop05·shop06 에서 **「다듬은 대본이 같은 규격 게이트를 통과해 채택」**.
안 닫히는 자리 0%(반려선 22%).

★**길이 창이 좁다** — 원본 대비 **+4% 면 「너무 깁니다」**, −8% 면 「너무 짧습니다」.
원본 글자 수에 바짝 붙여라(shop05: 원본 255 → 257 채택 · shop06: 254 → 251 채택).
★kiwi 가 「사면」을 명사(斜面)로 읽는다. 「으려고·느라·려고」는 닫힘 목록에 넣어라.
끝말은 반드시 실제 태그로 확인해라.

**대본 고르기**: `onepass.analysis.versions` 5벌 중 하나.
서버가 「위에 있는 것일수록 화면에 있는 것을 말한다」로 순위를 매긴다.
★**확인 안 된 주장이 든 벌은 빼라.** 실제로 걸러낸 것들:
「단돈 몇만 원」「반영구적인 브러시」「전문 업체처럼」「배터리가 오래」「가벼운 무게」
「청소 시간이 반으로」「십 분 만에」「물기가 닿아도 안심」(방수 등급 미확인)
「내돈내산」(사지 않았다) 「부모님이 좋아하세요」(지어낸 제3자 후기).
`transcript` 에 **[확인 안 된 것]** 절을 넣어 두면 onepass 가 그 수치를 덜 지어낸다.

---

## 7. 함정 모음

| # | 함정 | 대처 |
|---|---|---|
| 1 | `pick` 번호는 **표시 순서가 아니라 원래 번호** | 「── 1 [기능]」로 보여도 원래 2번일 수 있다. **축 이름**(`'기능'`)으로 지정해라 |
| 2 | 문장 수·소재가 바뀌면 옛 상태가 남아 죽는다 | `wav_secs, narr_levels, narr_pause, words, edges, voiced, captions, polish, chosen, shot_scan, onepass, pos, pick, tried_picks, cuts, frames, burn, sources_probed, review_requests, review_replies` 를 **직접 지우고** `narr/` 도 옆으로 치워라. 안 그러면 `StepError: 재야 할 파일이 없다: narr/n006.wav` |
| 3 | 소재 코덱 | VP9·AV1·mp4 속 Opus/Vorbis 는 편집기에서 「미디어 오프라인」. HEVC 도 H.264 로 바꿔라 |
| 4 | `coupang_ack` | `false` 로 두면 된다(shop03~06 모두 정상 동작) |
| 5 | 영수증 파일명이 280자 | 윈도우 MAX_PATH 초과. 확인할 땐 `\\?\` 접두를 붙여라(러너 자신은 붙인다) |
| 6 | bash heredoc | 백슬래시가 뭉개진다. 파일은 **Write 도구**로 만들어라. 이번에도 두 번 당했다 |

---

## 8. ★막고 있는 것 — `shop_cuts` AV 검수 비용

### 무엇이 문제인가
`shop_cuts`(주피사체 검수)는 응답에 `reviewed_video_sha256`·`reviewed_audio_sha256` 확인을
요구한다. **Claude·Codex 검수 전송은 영상·음성을 못 읽는다** — 지시문이 「**직접 들어**
화자를 확인하라, 대본 문맥은 실제 음성의 대체물이 아니다」라고 못박으므로, 안 들은 것을
들었다고 답할 수 없다. 따라서 **EvoLink 유료 검수가 사실상 필수**다.

### 값
- 컷당 약 **4.6건** · 한 건 약 **18.5 크레딧 ≈ $0.27**
- **21컷 한 편에 약 97건 ≈ $26** — 이 단계 **하나**의 값이고 onepass·TTS·ASR 은 그 위에 더 붙는다
- 대본을 갈아타거나 컷을 다시 놓으면 **처음부터 다시** 든다
- 실측: shop05 87건/19컷 · shop06 89건으로 13컷

### 운영상 주의
- `review_policy = {"provider":"evolink","max_requests":N}` 의 N 은 **작업 폴더 누적**이고
  실패·재시도를 포함하며 **재개해도 초기화되지 않는다**. 한 번에 넉넉히(컷 수 × 5 + 여유) 잡아라
- ★진행 상황을 **영수증으로 판단하지 마라.** `volcano_run.py:4137` 의 모델 호출 블록에
  `not any(request.get(f) for f in ('video','audio','videos','audios'))` 조건이 있어 AV 요청은
  그 경로를 안 탄다. 그래서 `*.client-receipt.json` 은 계속 이전 답의 `pending` 을 들고 있고
  「완료 0건」처럼 보인다. **다음 실행의 오류 목록에서 빠진 컷 번호**가 진짜 완료 신호다
- 현재 잔액: **18.15 크레딧(≈$0.27)** — 한 건 값에 미달. https://evolink.ai/dashboard/credits

### 남은 기술 문제 하나
shop05 컷 1, shop06 컷 7 이 같은 증상이다:
```
selection_unresolved, object_unverified, subject_outside_source, tracking_incomplete
검수 호출 실패: HTTP 500/400 — 요청 18,731,210 바이트
```
1차 검수 요청은 0.03~0.14MB 인데 **재검(refine) 요청만 18.7MB** 로 불어나 제공자가 거절한다.
실패가 영수증에 저장돼 **같은 request id 가 그대로 재생**되므로 재시도로는 안 풀린다.

### 서버에 보고한 것
두 번 보냈다(`feedback` 단계, `kind='rejected'` 와 `kind='result'`). 요청한 것:
1. **프레임만으로 판정하는 경로** — 나레이션이 TTS 라 화면 속 화자가 없는 편은 소리 확인 면제
2. 컷당 요청을 1건으로(지금은 재시도가 4~5건)
3. 시작 전에 **예상 요청 수·비용** 고지

---

## 9. 대안 — 이 값이 부담이면

| | 내용 | 근거 |
|---|---|---|
| **① 군림보로 우회** | 쇼핑 소재를 군림보 편으로 만든다. AV 게이트가 없다 | **검증됨** — 곰표 건을 이 경로로 돌린 적 있다(korim04) |
| ② 컷 수 줄이기 | 나레이션을 짧게 → 자막 적게 → 컷 적게. 12컷이면 약 $15 | 비용이 컷 수에 비례하는 건 확인됨 |
| ③ 사람 없는 소재만 | 얼굴이 0이면 「누가 말하나」 판정이 사라져 재시도가 줄 수 있다 | **추측** — shop05 는 「얼굴로 잡은 것 5」였다. 테스트 필요 |
| ④ 서버 수정 대기 | §8 의 세 요청 | 보고 완료 |

소유주 반응(2026-09-29): 「너무 비싼거같은데? 영상 하나에 26달러」.
**충전 전까지 쇼핑에 추가 지출 금지.**

---

## 10. 이번에 만든 도구

| 경로 | 용도 |
|---|---|
| `D:/volcano-runs/_preset_trials/소스_화면검사2.py` | 박힌 자막·레터박스·고정표식 검사(v2) |
| `D:/volcano-runs/_preset_trials/화면검사_회귀.py` | 위 검사기의 회귀 세트. **고칠 때마다 돌려라** |
| `D:/midform/scripts/product-video-grab.js` | 알리·타오바오 상품영상 + 제목·후기 수집 |
| `D:/volcano-runs/shop05/_cut_burned.py` | 번인 구간을 파일에서 잘라 내기 |
| `D:/volcano-runs/shop06/_polish_check.py` | 자막 조각 설계·검산(닫힘 + 재현) |
| `D:/volcano-runs/shop05/_receipt_scan.py` | 검수 영수증을 `\\?\` 로 전부 읽어 상태 세기 |
| `D:/volcano-runs/shop06/_focus_sheets.py` | 컷별 후보 사진 9장을 한 줄로 붙이기 |
| `D:/volcano-runs/shop06/_send_cost_feedback.py` | 서버에 막힘·비용 보고 보내기 |

관련 메모리: `shopping-source-resolution-floor` · `burned-subtitle-screening` ·
`product-video-grab` · `shopping-av-review-cost` · `volcano-shop-flow-on-hold`
자세한 경위는 `D:/volcano-runs/_preset_trials/LOG.md` 끝부분(2026-09-28~29 절).
