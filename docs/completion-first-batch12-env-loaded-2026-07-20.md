# 완결 컷 로직 실배치 검증 보고서 (env-loaded)

작성일: 2026-07-20

## 실행 조건

- `.env` 로드 상태로 실행
- `GEMINI_AUTH_MODE=vertex_adc`
- `GOOGLE_CLOUD_PROJECT=project-b341a363-4d35-4813-a99`
- 배치 ID: `completion_first_batch12_env_loaded_v2`
- 대상 아이템: `item_025 ~ item_036`
- 실행 모드: `highlight_only`

## 사전 수정

이번 배치 전에 다음 두 가지를 정리했다.

1. **timeline 추출 인증 경로 통일**
   - timeline 추출도 metadata와 동일하게 **Vertex ADC 우선**
   - `GEMINI_API_KEY`는 **ADC가 아닐 때만 fallback**
   - 더 이상 timeline 호출부가 `requireApiKey('GEMINI_API_KEY')`로 선행 실패하지 않음

2. **배치 노트/설정 표기 일치화**
   - `queue/process/queue_config.json`의 `highlight_duration_sec`를 `23.999`로 갱신
   - 배치 노트 표기를 `23.999 (<24s hard cap)`로 수정

추가로, 이번 보고서에서 **held 비율**이 실제로 보이도록 창 자체를 못 찾은 경우 `highlight_status=held`로 맞췄다.

## 배치 결과 요약

- 총 아이템 수: **12**
- 성공: **7**
- held: **5**
- held 비율: **41.7%**
- failed: **0**

## selection_strategy 분포

- `loop_complete_reset_cycle`: **0**
- `result_reveal_completion_cut`: **7**
- 없음(`held`): **5**

해석:

- 이번 12개 실배치에서는 **루프 완결로 살아난 케이스가 0개**였다.
- 살아난 7개는 전부 **result reveal 완결 컷**이었다.
- 즉 현재 실소스군에서는 `RESULT_REVEAL` 기반 생존률이 더 높고, 루프 규칙은 아직 너무 보수적이거나 실제 timeline event 품질이 루프 판별에 불리한 상태다.

## held 아이템과 적격률

held 아이템:

- `item_027`
- `item_028`
- `item_030`
- `item_031`
- `item_035`

공통 사유:

- `highlight ineligible: no loop-complete cycle or RESULT_REVEAL completion window found`

실제 적격률:

- 적격(발행 가능): **7 / 12 = 58.3%**
- 부적격(held): **5 / 12 = 41.7%**

질문에 대한 직접 답:

- `item_024`처럼 held에서 살아나는 케이스는 **존재한다**.
- 하지만 이번 12개 기준으로 보면 **여전히 held가 적지 않다**.
- 즉 “대부분이 살아난다” 단계는 아직 아니다.

## draft 길이 분포

성공한 7개 길이:

- `item_025`: 7.5s
- `item_026`: 23.0s
- `item_029`: 10.0s
- `item_032`: 7.0s
- `item_033`: 23.5s
- `item_034`: 19.0s
- `item_036`: 9.0s

구간별 분포:

- `3 ~ 5.99s`: **0**
- `6 ~ 9.99s`: **3**
- `10 ~ 14.99s`: **1**
- `15 ~ 19.99s`: **1**
- `20 ~ 23.999s`: **2**

해석:

- 3초대 극단 숏은 없었다.
- `6~10초`대가 기본층이지만,
- `19~23.5초`까지 길어지는 하이라이트도 이미 꽤 나온다.
- 특히 `item_026`, `item_033`은 사실상 **풀드래프트 직전 길이의 하이라이트**에 가깝다.

## result_reveal 오판 체크

이번 배치에서 성공한 7개는 전부 `result_reveal_completion_cut`였다.

대표 프레임 시트(contact sheet)로 육안 판정한 결과:

- `item_025`: **오판 가능성 높음**
  - 마지막이 분명한 결과 샷이라기보다 작업 손동작/트레이 조작에 가까움
- `item_026`: **오판 가능성 높음**
  - 오븐 투입/베이킹 진행 중 장면이 많고, 끝쪽이 완성 결과로 명확히 닫히지 않음
- `item_029`: **오판 가능성 높음**
  - 마지막이 worker carrying tray로 읽혀 결과 샷이 약함
- `item_032`: **오판 가능성 높음**
  - 초콜릿을 붓고 펴는 과정에서 끝나며, 완성 결과 샷이 약함
- `item_033`: **오판 가능성 높음**
  - raw chicken handling/feeding 위주로 읽혀 결과 노출이 분명하지 않음
- `item_034`: **오판 가능성 높음**
  - ongoing handling/packing 위주로 보이고 finished reveal이 약함
- `item_036`: **오판 가능성 높음**
  - filling/setup 단계처럼 보여 완료 결과 노출이 불명확함

### 판정

이번 배치의 성공 7개는 **기술적으로는 result_reveal로 분류됐지만, 육안상 “결과가 정말 보이는 완결점”으로 보기 어려운 비율이 높다.**

즉 지금 첫 실배치 데이터가 말해주는 건:

1. Vertex ADC 경로는 정상화됐다.
2. 완결 컷 배치는 실제로 돈다.
3. 하지만 **RESULT_REVEAL event 품질이 아직 거칠어서, 성공으로 찍힌 컷 중 상당수가 사람이 보기엔 완결점 오판**이다.

## 실무 해석

현재 단계에서는 조회수/리텐션 실험 이전에, 다음 보정이 필요하다.

우선순위:

1. `RESULT_REVEAL` 검증 강화
   - 마지막 20~30% 구간에 실제 결과 정지/안정 샷이 있는지 추가 확인
   - 단순 동작 전환이나 worker carry-away는 result로 인정하지 않기

2. `loop_complete` 완화 또는 보강
   - 이번 12개에서 0건이라면 너무 엄격할 가능성이 큼
   - 실제 루프형 소스를 놓치고 있을 수 있음

3. `result_reveal_completion_cut`의 후반 안정성 체크
   - 마지막 프레임 근처가 finished state인지
   - ongoing action인지

## 생성/검증 산출물

- 실배치 리포트:
  - `C:\Users\sejun\Documents\Codex\2026-05-26\content-pipeline-prd-product-requirements-document\server\output\process_batches\completion_first_batch12_env_loaded_v2\batch_report.json`
- 실배치 노트:
  - `C:\Users\sejun\Documents\Codex\2026-05-26\content-pipeline-prd-product-requirements-document\server\output\process_batches\completion_first_batch12_env_loaded_v2\batch_notes.md`

## 검증

- `npm run verify` 통과
- 포함:
  - encoding
  - shortform highlight contract
  - metadata repair guards
  - output config contract
  - caption/TTS alignment
  - Korean full speech budget
  - script review integrity
  - build

## 최종 결론

이번이 **진짜 첫 실배치 데이터**다.

- 적격률: **58.3%**
- held 비율: **41.7%**
- 성공 전략: **100% result_reveal_completion_cut**
- loop_complete: **0건**
- 길이 분포는 `7~10초`와 `19~23.5초` 양극화 조짐
- 가장 중요한 문제: **result_reveal 오판 비율이 높아 보인다**

따라서 다음 단계는 “완결 컷이 돈다”가 아니라,
**“결과 노출을 정말 결과처럼 읽게 만드는 검증 게이트를 붙이는 것”**이다.
