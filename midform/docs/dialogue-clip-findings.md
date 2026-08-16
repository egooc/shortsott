# 대사 클립 오디오 검증 — 발견 대장

`align_dialogue_lines.py` + `verify_dialogue_clips.js`가 출하 직전 드래프트에서 찾은 것들.
플랜(`edit_plan.json`)은 git 밖에 있으므로 **여기가 그 수정의 되돌릴 수 있는 기록**이다. 각 항목은
증거(오디오 시각) → 수정 → 재검증 수치 순으로 적는다.

측정 명령:

```
python midform/scripts/align_dialogue_lines.py --audio <source.mp4|wav> --plan <edit_plan.json> --out align.json
node  midform/scripts/verify_dialogue_clips.js <draft_ko/edit_manifest.json> align.json --asr <whisper.json>
```

## 2026-08-16 최종 (5개 소스, 설치본 `20260816e-*`, 골든 동결)

경계를 단어에 스냅한 뒤:

| 소스 | FAIL | WARN | 비고 |
|---|---|---|---|
| draftday-allin | 0 | **0** | 단어중간 절단 5 → 0 |
| draftday-outsmart | 0 | 1 | 자막 병합 꼬리(정상) |
| housemaid-ending | 0 | 2 | 이웃 자막이 담는 꼬리 |
| housemaid-night | 0 | 2 | |
| longshot-molly | 0 | **0** | 절단 3 → 0 |

5개 합계 단어중간 절단 **12 → 0**(신뢰도 미달 정렬 줄은 스냅도 경고도 하지 않음 — 판정과 조치가
같은 기준을 쓴다). 골든은 이 구간으로 다시 동결했고 `clip_baseline.js check` 드리프트 0.

### 스냅 이전 (설치본 `20260816d-*`)

두 결함을 고치고 파서·병합·floor 수정이 모두 들어간 판으로 전수 재검증:

| 소스 | 대사 클립 | 타임라인 포함률 p50 | FAIL | WARN |
|---|---|---|---|---|
| draftday-allin | 23 | 0.99 | **0** | 5 (단어중간 절단) |
| draftday-outsmart | 26 | 1.00 | **0** | 2 |
| housemaid-ending | 22 | 1.00 | **0** | 2 |
| housemaid-night | 25 | 1.00 | **0** | 5 |
| longshot-molly | 27 | 1.00 | **0** | 3 |

`midform/docs/goldens/*.json`에 이 구간들을 동결했고, 설치 전 `clip_baseline.js check`로 드리프트 0을
확인했다. 남은 WARN은 전부 단어중간 절단(경계가 단어 안에서 끊김)과 자막 병합 꼬리다 — 다음 개선 후보.

### 중간 기준선 (수정 전, `20260816b-*`)

플랜 좌표와 강제정렬의 차이: **p50 0.07~0.11s**, p90 0.13~4.0s(반복 구절이 많은 소스일수록 큼).
전수에서 FAIL 2건, 나머지는 WARN(단어중간 절단 12건, 자막 병합 꼬리 3건).

### [수정 완료] housemaid-ending · slot_01_L02 — 대사 후반이 클립 밖

- 증거: 자막 "못 가. 나 이제 펄이잖아, 잊었어?"(= "Can't run. I'm Pearl, remember?")는
  488.75~491.44에 발화. 클립은 **488.91~490.56**에서 끝나 "I'm Pearl, remember?"가 통째로 밖.
  whisper도 "Can't run."(488.94) / "I'm poor(Pearl), remember?"(490.66)로 두 조각을 확인.
- 원인: 창의 end가 앞 조각에만 맞춰져 있었음(재타이밍 로케이터가 뒷조각을 못 붙임).
- 수정: `edit_plan.json`의 해당 window `end_sec`/`raw_end_sec` 490.56 → **491.6**.
  되돌리려면 490.56으로 되돌리고 `--resume bootstrap --bootstrap-run compress_20260813110559_5qWm_kVDhQQ` 재실행.
- 재검증: FAIL **1 → 0**, 최소 포함률 **0.21 → 0.64**. 원고 diff NONE. 설치 `20260816c-housemaid-ending-*`.

### [수정 완료] longshot-molly · slot_008_L01 — 자막 없는 발화가 클립 안에 있음

- 증거: 클립 399.94~406.02가 세 발화를 재생한다.
  399.13 "We just re-upped." / **400.91 "You kept saying you wanted to take more, so we did."** /
  403.09 "So we have another maybe four or five hours."
  자막은 첫·셋째만 담는다("We just re-upped... we have another maybe four or five hours").
  검증기: 클립 안에서 들리는 11단어 중 **8단어가 어떤 자막에도 없음**.
- 성격: 자막의 `...`가 이미 생략을 뜻한다 — 즉 **자막은 맞고 오디오가 생략을 따라가지 않는다.**
- **진짜 원인은 창이 아니라 floor였다**: 플랜 창은 399.94~401.4(1.46초)인데, 11단어 자막이라
  floor가 `wordCount/3.2 = 3.4초`를 채우려고 end를 **406.02까지** 밀었다. 그 사이의 다른 발화를
  그대로 삼킨 것. 클램프는 큐 기준이고 floor보다 먼저 돌기 때문에 막을 수 없었다.
- 수정(커밋 `9d98462`): floor가 transcript를 받아 **창 시작 이후 첫 "남의 큐" 앞에서 멈춘다**
  (0.15초 여유). 창 **끝**이 아니라 **시작** 기준으로 재는 이유는, 이미 남의 발화에 걸쳐 있는 창이면
  끝 기준 탐색이 그 발화를 건너뛰어 버리기 때문. 테스트 2건 추가(tests/dialogueClipOwnCueClamp.test.js).
- 재검증: 클립 399.94~406.02 → **399.94~401.40**, uncaptioned_speech FAIL **1 → 0**, 원고 diff NONE.

## 판정을 믿기 전에 알아야 할 오탐 3종 (전부 실제로 겪음)

1. **숫자**: 정렬 어휘는 글자뿐이라 "30 million, Sonny."가 두 단어로 줄어 3초 뒤 "30 million."에 붙었다.
   → 숫자를 철자로 편다(`number_to_words`).
2. **반복 구절**: 넓은 창에서는 같은 말의 다른 등장이 진짜보다 높은 점수를 받는다.
   → 근접창 우선, 원거리 매칭은 점수가 뚜렷이 높을 때만. 근접·원거리가 1초 넘게 어긋나면 `ambiguous`로 표시하고
   그 줄로는 절대 빌드를 실패시키지 않는다.
3. **자막 병합 꼬리**: 자동자막이 두 발화를 한 줄로 합치고 다음 줄에서 겹치는 말을 반복한다.
   잘려나간 꼬리가 이웃 자막 아래에서 다시 들리면 결함이 아니다(`containment_split`).

신뢰도 하한 0.6은 117줄로 보정: 플랜이 이미 0.3초 이내로 맞힌 줄은 p10 0.6, 2초 이상 어긋난 줄은
p50 0.56이며 그중 92%가 `ambiguous`였다.
