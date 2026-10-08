# 명화관 렌더 명세 — 자체 렌더러가 맞춰야 할 모양

소유주 지시 (2026-10-08)
> "편집표는 양쪽 공통이 아니라 **볼케이노 명화관이 맞고 그걸 기준으로 우리 스타일을 지켜야지**"
> "우리 ko랑 ja 스타일로 유지되게끔 하고 **볼케이노 서버 없이도 계속 되야지.** 업데이트는 반영하고"

기준은 볼케이노 명화관이 **실제로 낸 결과물**이다. 말이 아니라 숫자다.
뽑는 도구: `python scripts/render_contract.py <워크디렉토리>`
기준선: `server/data/render_contracts/myeonghwagwan-{ko,ja}.json`
(2026-10-08 `lsr01`(KO) · `lsr02-ja`(JA) 실측 — 둘 다 AGY 없이 완주한 판)

---

## 1. 화면·소리 — ko·ja 공통

```
해상도      1080 x 1920
프레임율    30/1  (CFR)
영상코덱    h264
소리        48000 Hz · 2ch · aac
라우드니스  -13.5 ~ -13.6 LUFS   (LRA 4.7~5.6)
자막 좌표계 PlayResX 1080 · PlayResY 1920 · WrapStyle 2 · ScaledBorderAndShadow yes
```

★`-13.5 LUFS` 는 두 편이 각각 -13.6/-13.5 로 나온 값이다. **목표값으로 삼되 ±0.5 는 같다고 본다.**

## 2. 자막 스타일 — 글꼴만 다르고 나머지는 똑같다

견줘 보니 ko·ja가 어긋나는 항목은 **글꼴 5줄이 전부**였다.

| 스타일 | 크기 | 색 | 외곽선 | 정렬 | ko 글꼴 | ja 글꼴 |
|---|---:|---|---:|---:|---|---|
| `Head` | 99 | `&H00FCFBFC` | 4 | 8 | Cafe24 Ohsquare | Noto Sans JP **Bold** |
| `Narr` | 82 | `&H00FCFCFC` | 5.5 | 5 | Cafe24 Ohsquare | Noto Sans JP **Medium** |
| `Dialogue` | 82 | `&H0019FFF7` | 5.5 | 5 | **SeoulHangang M** | Noto Sans JP **Medium** |
| `Effect` | 70 | `&H0002FEF6` | 4 | 5 | Cafe24 Ohsquare | Noto Sans JP **Medium** |
| `Credit` | 64 | `&H00999999` | 0 | 8 | Cafe24 Ohsquare | Noto Sans JP **Bold** |

여백은 다섯 스타일 모두 `MarginL 20 · MarginR 20 · MarginV 0`, `SecondaryColour &H000000FF`,
`OutlineColour`·`BackColour` 는 `&H00000000`, Bold/Italic 플래그는 전부 0 (ja 는 글꼴 이름으로 굵기를 낸다).

★**ko 의 `Dialogue` 만 다른 글꼴(SeoulHangang M)이다.** 해설(Narr)과 원음 대사(Dialogue)를
  글꼴로 구분하는 것이 ko 스타일이다. ja 는 굵기로만 구분한다. 이걸 통일하지 마라 — 우리 스타일이다.

## 3. 자막 배치

```
Head   \pos(540, 211) 과 \pos(540, 298)   — 제목 두 줄, 위쪽 정렬(8)
Narr   \pos(540, 1305)                    — 해설, 가운데 정렬(5)
Dialogue 같은 아래쪽 띠
```
`Head` 둘째 줄은 색이 다르다 — 첫 줄 `&H00FCFBFC`(흰색), 둘째 줄 `&H001BFFF6`(노랑).
즉 **제목 둘째 줄이 강조색**이다. 인라인 `{\c&H...&}` 로 준다.

## 4. 편집표(입력) 모양

`edit.json` — 볼케이노가 정한 형식이고 **우리가 바꾸지 않는다.**

```
title       ["윗줄", "아랫줄"]            2줄
credit      "작품명"                      화면 크레딧
editorial   { version, premise, title_promise,
              beats: [{role, what, evidence, sequence_indices}] }
              role 순서: setup → escalation → reversal → payoff
narration[] { id, text, cards[], source }  source = 해설 밑에 깔 그림의 소스 시각
sequence[]  { narration: "nN" }  |  { source_in, source_out, captions[] }
```

실측 분포(2편): 해설 3개 · 원음컷 3~4개 · 큐 80~100개 · 길이 124~172초.

## 5. 쓰는 법

```bash
# 기준선 뽑기 / 갱신
python scripts/render_contract.py D:/volcano-runs/<wd> --save myeonghwagwan-ko

# 자체 렌더러 결과를 기준선과 견주기
python scripts/render_contract.py <우리_렌더_폴더> --against myeonghwagwan-ko

# 두 결과를 직접 견주기 (ko↔ja, 또는 볼케이노↔자체)
python scripts/render_contract.py <A> --compare <B>
```

견줄 때 **스타일·화면 규격만** 본다. 길이·프레임 수·라우드니스 LRA 는 편집표가 다르면
당연히 달라지므로 따로 «참고»로만 찍는다.

## 6. 업데이트를 어떻게 따라가나

1. `scripts/volcano_runner_watch.py` 가 07:00·19:00 에 실행기 변화를 잡는다(사례 166).
2. 렌더에 직접 영향 주는 파일이 바뀌면(`film_*` · `shorts_framing` · `subject_*`) **크게 알린다.**
3. 그 뒤 첫 볼케이노 회차의 결과로 `render_contract.py --against` 를 돌린다.
   - 계약서가 **안 바뀌면** 우리 렌더러는 그대로 둔다.
   - 바뀌면 바뀐 항목만 우리 렌더러에 옮긴다.

★**볼케이노 내부 코드를 부르지 않는다.** `film_editor.py` 를 직접 import 하면 그쪽 갱신에
  우리가 깨진다(린박스 세션 판단, 동의). 형식과 결과만 맞추고 코드는 우리 것으로 둔다.

## 7. 아직 계약서에 안 들어간 것

정직하게 적어 둔다 — 이 명세만으로는 아직 똑같이 못 만든다.

- **컷 경계의 실제 프레임 정렬** — 편집표의 `source_in/out` 과 결과물 프레임의 대응을 아직 안 쟀다.
- **해설 그림 구간의 화면 처리** — 확대/정지/패닝 여부. AGY 를 안 쓰는 판에서 무엇이 되는지 더 봐야 한다.
- **`flash_aliases`** — 1~2프레임짜리 원본 장면 처리. 2026-10-08 서버가 새로 넣었다(사례 166).
  23.976fps 소스에서 나오는 경우라 자체 렌더러도 처리해야 한다.
- **BGM·효과음** — 이번 두 편에는 `Effect` 큐가 0개였다. 쓰는 편으로 한 번 더 재야 한다.

---

## 8. 화면 치수 — **엔진 자산에서 가져온 값** (2026-10-09 정정)

★처음엔 완성본 화소를 재서 그림 창을 `y 516~1501` 로 적었다. **틀렸다.**
  편집 폴더에 엔진이 쓰는 **`chrome.png` 원본이 그대로 들어 있었고**(1080x1920 RGBA,
  ko·ja 동일 311,404B), 그 투명 영역이 진짜 창이다. 화소 측정이 작게 나온 것은
  창 가장자리의 부드러운 알파 때문이다. **자산이 있으면 자산이 정답이다.**

```
그림 창   y 420 ~ 1499 · x 0 ~ 1079 · **1080 x 1080 정사각형**
틀        assets/myeonghwagwan_chrome.png  (엔진 원본 그대로)
          위 = 붉은 커튼 · 아래 = 객석 · 가운데 투명
```

### 글꼴 — 편집 폴더에 동봉돼 있다
```
ko  body.ttf / bold.ttf   카페24 아네모네 Bold
    dialogue.ttf          서울한강체 M
ja  body.otf / bold.otf / dialogue.otf   Noto Sans JP
→ assets/fonts/ 에 복사해 뒀다. 시스템 글꼴에 기대지 않는다.
```

### 크기·위치 — ASS 값이 맞다 (시험 렌더로 역산 확인)
```
             ASS    시험렌더   실제 완성본   배율
제목         99pt    74px      73px        0.986
해설·대사    82pt    60px      59px        0.983   x 410~668 완전 일치
크레딧       64pt      —         —
위치   제목1 y211 · 제목2 y298 · 자막 y1305   ← ASS 값 그대로
```

### 색 — **ASS 가 맞다** (2026-10-09 정정)
```
제목1      RGB(240,240,240)  흰색    &H00FCFBFC
제목2      RGB(240,224,0)    노랑    &H001BFFF6
해설       흰색                      &H00FCFCFC
원음 대사   노랑                      &H0019FFF7
```
★한때 «제목2는 주황빨강 RGB(240,64,32), 10편 전부 그렇다»고 적었다. **틀렸다.**
  그 10편은 전부 **캡컷 출력 폴더의 발행본**이었고, 발행본은 우리 캡컷 파이프라인
  산물이지 볼케이노 명화관 완성본이 아니다. 같은 편(dh01)으로 맞대 보면 분명하다
  — 볼케이노 159.1초/노랑 vs 발행본 163.4초/주황빨강. **아예 다른 편집본이다.**
  주황빨강+노랑 조합은 **린박스** 스타일이다(rinbox67~71 실측).

  교훈: «완성본»이라 할 때 **어느 완성본인지** 먼저 확인하라.
  볼케이노 명화관의 기준은 `D:/volcano-runs/<wd>/edits/<id>/final-*.mp4` 다.
  볼케이노 회차 8편 실측(lsr01·lsr02-ja·cg01-ja·cg02·wf01·wf01-ja…) 전부 흰색/노랑이었다.

### 정렬 — 스타일마다 다르다 ★
```
Head    8 (위 기준)      Credit  8 (위 기준)
Narr    5 (가운데)       Dialogue 5      Effect 5
여백    다섯 스타일 모두 L20 R20 V0
```
5 로 통일하면 **제목이 반 줄만큼 아래로 내려간다**(실측 확인). 2항 표에 적어 두고도
구현을 빠뜨려 첫 렌더가 그렇게 나왔다.

### 글꼴 이름이 ASS 와 파일이 다르다
ASS 는 `Cafe24 Ohsquare` 라고 적는데 동봉된 `body.ttf` 의 실제 가족 이름은
**카페24 아네모네**다. 우리는 **파일의 실제 이름**을 쓴다 — 그래야 libass 가 찾는다.

### 재는 법
```
틀·창     편집 폴더의 chrome.png 알파를 본다 (화소 측정보다 정확하다)
글꼴 크기  같은 글자를 시험 렌더해 글자 높이를 견준다
색        완성본 여러 편에서 재고, 편마다 같은지 확인한다
```

---

## 9. 자체 렌더러 — **돈다** (2026-10-09)

`scripts/myeonghwagwan_render.py` · 린박스 뼈대를 명화관 치수로 갈아 끼운 것이다.

```bash
python scripts/myeonghwagwan_render.py <plan.json> --out <out.mp4>
```

### 첫 완주 결과 — lsr01 편집표를 볼케이노 없이 렌더
```
             볼케이노      자체          판정
해상도       1080x1920     1080x1920     같다
프레임율     30/1 CFR      30/1 CFR      같다
영상코덱     h264          h264          같다
소리         aac 48k 2ch   aac 48k 2ch   같다
길이         171.54초      174.80초      3.3초 차 (해설 음성 길이 차)
라우드니스   -13.6 LUFS    (-16.0 → 고침) ★린박스 값이 남아 있었다
```

★**라우드니스를 베껴 오면 안 된다.** 린박스는 `-16/LRA 11`, 명화관은 `-13.5/LRA 5` 다.
  그대로 가져와서 2.4dB 작게 나왔다. 뼈대를 옮길 때 **숫자는 채널마다 다시 재라.**

### plan.json — 볼케이노 edit.json + 셋
```
source      원본 영상 경로
transcript  전사 [[시작, 끝, 글], ...]
cx          가로 어디를 가운데로 둘지(0~1) — 시퀀스마다
나머지는 edit.json 그대로 (title/credit/narration/sequence)
```

### 자막 시각을 어떻게 잡나 — 린박스와 다르다
명화관 자막은 **번역문**이다(영어 원음 → 한국어/일본어). 글자를 전사에 맞춰 볼 수 없다.
편집표가 칸마다 `word_ids` 를 다는데 **그 개수가 «이 칸이 전사 낱말 몇 개를 먹는가»**다.
(`bind_ko.json` 이 같은 것을 `[낱말수, 글]` 짝으로 적어 둔다 — 2026-10-09 실측 확인.)
해설 자막은 Typecast 가 돌려준 낱말 시각에서 잰다.

### 틀·글꼴은 저장소에 안 넣는다 — 스스로 챙긴다
`assets/**` 는 이 repo 규칙상 제외다(로컬 미디어). 글꼴 17MB 를 커밋하는 대신
`ensure_assets()` 가 **없으면 볼케이노 편집 폴더에서 가져온다** — 회차마다
`edits/<id>/chrome.png` 와 `edits/<id>/fonts/` 가 같이 떨어져 있기 때문이다.
한 번 챙기면 그 뒤로는 볼케이노 없이 돈다. (2026-10-09 자산을 지우고 시험 — 되찾았다.)

### ja — 글꼴·색은 확인했다, 끝까지는 아직
시험 렌더로 ja 다섯 스타일을 다 찍어 봤다(제목2줄·해설·원음·크레딧 + 극장 틀).
**Noto Sans JP 가 일본어를 제대로 낸다.** 색·위치도 ko 와 같은 값으로 맞는다.

다만 **ja 편을 끝까지 돌리지는 못했다.** 쓸 만한 ja 회차가 없다 —
`lsr02-ja` 는 전사가 디스크에 없고, `acct-ja` 는 전사 형식이 다르다(아래).
다음 ja 회차가 나오면 그때 끝까지 돌린다.

### ★전사 형식이 두 가지다 (2026-10-09 발견)
```
낱말 단위   [[0.24, 0.72, "Pizza"], ...]                      ← 우리가 쓴다
겹침 토막   [[12.72, 15.51, "That's enough. He's in the goddamn house. Get out..."],
            [15.51, 15.52, "house. Get out there and end this. Give"], ...]
            스트리밍 부분결과라 앞 것이 뒤에 통째로 또 나온다. 시각을 못 잰다.
```
겹침 토막을 그냥 받으면 **자막이 엉뚱한 데 붙는다.** `check_transcript()` 가
형식을 보고 분명히 서게 했다 — 조용히 틀리느니 서는 게 낫다.

### 아직 안 한 것
- `flash_aliases` · BGM/효과음 (7항 그대로 남아 있다)
- 컷 경계 프레임 정렬을 볼케이노와 직접 견주지 않았다

---

## 10. 엔진 코드에서 가져온 규칙 (2026-10-09)

소유주 지시
> "린박스 랜더러 지금 더 만들고있어서 그거 어느정도 만들어지고 참조를 하되
>  **볼케이노의 명화관 작업 방식을 최대한 가져오는게 더 중요한거잖아**"

맞는 지적이었다. 린박스 뼈대를 기준으로 삼았더니 **거기서 베껴 온 값 여섯이 틀렸다.**
린박스 렌더러는 아직 만들어지는 중이라 기준이 될 수 없다. 기준은
`D:/volcano-runs/*/runner/film_editor.py` 와 볼케이노 완성본이다.

### 1. 해설 그림은 편집표가 정한 자리에서 시작한다
```python
# film_editor.py 662 · 728
a = narration[clip["narration"]]["source"] if "narration" in clip else clip["source_in"]
narration[n["id"]] = {"kind": "N", "source_in": n["source"], ...}
```
린박스는 «앞 컷 끝에서 이어서» 잡는다. **명화관은 `narration[].source` 를 쓴다.**
편집표가 정해 준 자리를 무시하고 있었다.

### 2. 음량은 2패스다
```python
# film_editor.py 1815~1820
norm = f"loudnorm=I={lufs}:TP={tp}:LRA={lra}"
... print_format=json 으로 재고 ...
norm += ":linear=true:" + "measured_I=…:measured_TP=…:measured_LRA=…:measured_thresh=…:offset=…"
```
1패스로 하면 -13.8 이 나왔다(목표 -13.5). 2패스로 바꾸니 **-13.6 — 볼케이노와 같다.**
무음일 때는 측정을 지어내지 않는다(엔진 주석: "Digital silence has no finite loudness").

### 3. 검은 띠를 먼저 걷어낸다
```python
# film_editor.py 786~804  measure_content()
컷 8개를 1초씩 cropdetect=24:2:0 → 최빈값
원본 절반보다 작은 표본은 버린다 → 없으면 통짜 프레임
```
그리고 cx 를 **그 알맹이 안에서** 센다(`content['x']`, `content['width']`).
통짜 프레임에서 세면 레터박스 원본에서 검은 띠째로 창에 들어가고 피사체도 밀린다.

### 4. 정렬이 스타일마다 다르다
`Head`·`Credit` 은 8(위 기준), 나머지는 5(가운데). 5 로 통일하면 제목이 반 줄 내려간다.

### 5. ASS Format 줄은 글자 하나까지 같아야 한다
린박스 뼈대의 Format 에는 `SecondaryColour` 가 빠져 있는데 Style 줄은 색을 넷 쓴다.
칸 수가 어긋나 **libass 가 스타일을 통째로 버리고 제목이 아예 안 그려졌다.**
→ `scripts/ass_diff.py` 로 렌더 전에 견준다. 3분짜리 렌더를 돌리고 화면을 봐야
  알던 것을 1초에 잡는다.

### 6. 제목 강조색은 인라인으로 준다
볼케이노는 두 줄 다 `Head` 스타일(흰색)을 쓰고 둘째 줄에만 `{\c&H001BFFF6&}` 를 박는다.
스타일 색을 바꿔도 결과는 같지만 **방식을 맞춰 둔다.**

### `flash_aliases` 는 **우리에게 해당 없다** (확인 완료)
`shorts_framing.py:88~100` 을 읽어 보니 전부 **AGY 영수증 경로 안**이다
(`from_focus_receipt` · `focus` 키가 있을 때만 돈다). 우리는 AGY 를 안 쓰고
맨 `cx` 점만 주므로 이 길로 들어가지 않는다. 7항의 빈칸 하나가 지워졌다.

### 아직 안 가져온 것
- 카메라 점 형식 — 엔진은 `[프레임번호, cx]`, 우리는 `[원본시각, cx]`
- `view_width` / `crop` (샷별 확대 창) — AGY 영수증이 있을 때만 쓰는 길
- BGM(`mix_music_bed`) · 효과음(`mix_extra`)
