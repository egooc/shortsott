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

## 8. 화면 치수 — 완성본에서 직접 잰 값 (2026-10-08)

★**ASS 파일만 믿지 마라.** `captions.ass` 의 `Head` 둘째 줄 인라인 색은 `&H001BFFF6`
  (노랑)인데 **실제 화면은 주황빨강**이다. 엔진이 그 위에 다른 처리를 한다.
  린박스 세션이 한 대로 **이미 발행된 우리 영상에서 재는 것**이 맞다.

잰 영상: `20261007-dh_road-ko`(ko) · `20261008b-lsr_safe-ja`(ja) · `fg_hacker` · `wf_fight`

```
화면 1080 x 1920 · 30fps CFR

y    0 ~  213   극장 틀 윗부분 (천장 조명 띠 · 붉은 커튼 가장자리)
y  214 ~  291   제목 1줄   글자 y 218~290   RGB(192,192,192)  밝은 회색
y  292 ~  301   틀 (가는 띠)
y  302 ~  392   제목 2줄   글자 y 307~383   RGB(240, 64, 32)  주황빨강  ← 강조색
y  393 ~  495   틀
y  496 ~ 1503   **그림 창**  (움직이는 영역 실측 y 516~1501 · 전체 폭 x 0~1079)
y 1504 ~ 1599   틀
y 1600 ~ 1615   크레딧 자리
y 1616 ~ 1919   극장 틀 아랫부분 (붉은 객석)

자막  그림 창 안쪽 아래 — ASS 기준 Narr \pos(540,1305)
```

틀은 **편이 바뀌어도 똑같다**(세 편을 겹쳐 확인, 정지 화소 42.5%).
자산으로 뽑아 뒀다: `assets/myeonghwagwan_chrome.png` (RGBA · 알파가 틀 영역)

### 재는 법 (틀이 바뀌면 다시 재라)
```
서로 다른 편 3개 이상에서 프레임을 여러 시각 뽑아 겹친다
  편을 가로질러 안 변하는 화소 = 틀
  한 편 안에서만 안 변하는 화소 = 제목 글자 (틀이 아니다)
움직이는 줄 범위 = 그림 창
```
★한 편만 쓰면 제목 글자가 틀에 섞인다 — 처음에 그렇게 해서 틀에 «대학 견학 가자던»이
  박혀 나왔다.
