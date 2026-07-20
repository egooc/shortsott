# loop 0건 진단 보고서 (읽기 전용)

작성일: 2026-07-20

## 질문

1. 이번 12개 소재가 원래 루프형 공정인지, 결과가 뚜렷한 일회성 공정인지
2. `item_022`, `item_023`(루프 성공)과 이번 12개의 RESET 개수 비교
3. RESET이 여러 개인데도 루프 실패한 케이스가 있으면 그 사유

## 결론 한 줄

**이번 12개에서 loop 0건이 나온 주원인은 소재 성격 쪽이 더 크다.**
다만 `item_030`처럼 **timeline event 품질(시간축 불일치)** 문제도 최소 1건 섞여 있다.

## 1) 이번 12개 소재 성격: 루프형인가, 결과형인가

배치 대상: `item_025 ~ item_036`

성공한 7개는 전부 `result_reveal_completion_cut`이었고, loop는 0건이었다.

각 소재를 event 구조 기준으로 보면:

- **결과형/일회성 공정에 가까운 것**
  - `item_026` 빵: `RESET 0`, `RESULT_REVEAL 5`
  - `item_029` 테니스공: `RESET 0`, `RESULT_REVEAL 6`
  - `item_032` 초콜릿: `RESET 0`, `RESULT_REVEAL 4`
  - `item_033` 치킨: `RESET 0`, `RESULT_REVEAL 5`
  - `item_035` 식기세척기 바: `RESET 0`, `RESULT_REVEAL 3`

- **반복 동작은 있으나, 안정된 loop 완결보다는 공정 전개/결과 노출 쪽이 더 강한 것**
  - `item_025` 키보드: `RESET 1`, `RESULT_REVEAL 1`
  - `item_034` 네일 폴리시: `RESET 4`, `RESULT_REVEAL 1`
  - `item_036` 아이스크림 바: `RESET 2`, `RESULT_REVEAL 7`

- **미세 반복/초단기 루프는 있지만 하이라이트용 완결 루프라고 보기 어려운 것**
  - `item_027` 셔츠 프레스: `RESET 2`, `RESULT_REVEAL 2`, 전체 이벤트가 0.10~0.25s 부근에 몰림
  - `item_030` 인솔 커팅: `RESET 7`, `RESULT_REVEAL 7`, 반복은 강하지만 source duration과 event 시간이 어긋남

요약하면:

- 빵/치킨/초콜릿/테니스공류는 **루프형보다 결과형**에 가깝다.
- 이번 12개는 전반적으로 `item_022`, `item_023`처럼 **RESET이 자주 나오고, 한 루프를 여러 번 안정적으로 반복하는 공정군이 아니다.**

## 2) `item_022`, `item_023`와 RESET 개수 비교

루프 성공 샘플:

- `item_022`: `IMPACT 23 / RESET 13 / RESULT_REVEAL 10`
- `item_023`: `IMPACT 12 / RESET 10 / RESULT_REVEAL 6`

이번 12개:

| item | RESET | RESULT_REVEAL | 선택 결과 |
|---|---:|---:|---|
| item_025 | 1 | 1 | result_reveal |
| item_026 | 0 | 5 | result_reveal |
| item_027 | 2 | 2 | held |
| item_028 | 1 | 2 | held |
| item_029 | 0 | 6 | result_reveal |
| item_030 | 7 | 7 | held |
| item_031 | 0 | 1 | held |
| item_032 | 0 | 4 | result_reveal |
| item_033 | 0 | 5 | result_reveal |
| item_034 | 4 | 1 | result_reveal |
| item_035 | 0 | 3 | held |
| item_036 | 2 | 7 | result_reveal |

관찰:

- `item_022/023`의 RESET 개수는 각각 **13, 10**으로 매우 높다.
- 이번 12개는 RESET이 대부분 **0~2개**에 몰려 있다.
- 예외적으로 RESET이 많은 건 `item_030(7)`과 `item_034(4)`뿐이다.

따라서 전체적으로는:

- **이번 배치 소재들이 애초에 RESET이 적은 편**이다 → 소재 요인 강함
- 특히 성공 7개 중 4개(`026/029/032/033`)는 **RESET 0**이라 루프 후보 자체가 거의 없다.

## 3) RESET 여럿인데 루프 실패한 케이스와 사유

### A. `item_027` — RESET 2개인데 held

event:

- `RESET 0.10`
- `IMPACT 0.14`
- `RESULT_REVEAL 0.18`, `0.21`
- `RESET 0.25`

해석:

- RESET은 2개지만, 한 사이클 전체가 **0.15초** 수준으로 너무 짧다.
- 이건 loop 규칙이 못 잡은 게 아니라, **하이라이트 컷으로 쓸 수 있는 물리적 길이가 부족한 소재**에 가깝다.

판정: **소재 문제**

### B. `item_030` — RESET 7개인데 held

event 예시:

- `IMPACT 2.0` → `RESET 2.2` → `RESULT_REVEAL 2.5`
- ... 반복
- 마지막은 `RESULT_REVEAL 8.5`

그런데 source duration은 `4.876s`로 기록되어 있다.

해석:

- event 타임스탬프는 8.5초까지 가는데 source duration은 4.876초다.
- 즉 **timeline event 시간이 실제 source 길이와 맞지 않는다.**
- 이 경우 loop를 못 잡은 건 단순히 규칙 때문이라기보다, **timeline 추출 품질/시간축 불일치** 영향이 크다.

판정: **event 품질 문제**

### C. `item_034` — RESET 4개인데 loop 미선택, result_reveal 성공

RESET 시점:

- `0.3`, `17.3`, `25.8`, `38.8`

RESULT_REVEAL:

- `44.5`

해석:

- RESET 개수는 4개지만, 일정 간격의 반복 사이클이라기보다
  **채우기 → 병 정리 → 캡 씌우기 → 트레이 적재**처럼 단계가 바뀌는 전개형 공정이다.
- 마지막에 `44.5`에서 finished bottles 결과가 한 번 명확히 나온다.

판정: **소재는 결과형, loop 부적합**

### D. `item_036` — RESET 2개인데 loop 미선택, result_reveal 성공

RESET 시점:

- `7`, `9`

주요 IMPACT/RESULT는 그 이후:

- `12` 이후 몰드 주입
- `21, 24, 25, 27, 32` 결과 노출

해석:

- RESET은 있지만 실제 핵심 제조/코팅/포장 흐름을 감싸는 반복 사이클 경계로 보기 어렵다.
- 오히려 후반에 결과 노출이 여러 번 이어지는 **result-driven 구조**다.

판정: **소재는 결과형, loop 부적합**

## 최종 판정

### 주원인

이번 12개에서 loop 0건은 **규칙 문제보다 소재 문제 비중이 더 크다.**

근거:

1. 성공 7개 중 다수가 `RESET 0~1`
2. `item_022/023`처럼 RESET이 10개 이상 쌓이는 소재가 거의 없음
3. RESET이 있어도 `034/036`은 반복 루프보다 단계 전개/결과 노출형 구조

### 예외 / 보조 원인

다만 **event 품질 문제**가 최소 1건 있다.

- `item_030`: source duration 4.876s인데 event는 8.5s까지 감

이건 소재 때문만은 아니고, **timeline 추출 자체가 흔들린 사례**로 보는 게 맞다.

## 실무 결론

현재 상태를 실무적으로 요약하면:

- `loop_complete` 0건은 **대부분 소재군이 결과형이라서** 그렇다.
- 따라서 지금 배치에서 loop 비율을 억지로 올리는 건 맞지 않을 가능성이 높다.
- 대신 다음 단계는 두 갈래다:

1. **결과형 소재군**
   - `result_reveal_completion_cut`의 정확도 개선
   - “진짜 finished result인가?” 검증 게이트 강화

2. **루프 후보 소재군**
   - `item_030` 같은 timeline 품질 불일치 먼저 정리
   - loop 규칙 완화 여부는 그 다음

즉, 이번 batch12의 loop 0건은 **주로 소재**, 일부는 **event 품질** 문제다.
