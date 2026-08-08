# OSS 코드 감사 통합 이식 계획 (2026-08-07)

감사 대상: ClippyMe / OpenShorts / AI-Youtube-Shorts-Generator / ClipsAI (전부 MIT — 코드 이식 가능), AutoShorts (MIT). Clips Studio·HotClip은 AGPL — 구조 참고만, 코드 복사 금지.
방법: 에이전트 4개가 그들 코드와 우리 코드를 **둘 다 읽고** 함수·상수 단위로 비교.

## 결론 요약

- 그들이 앞선 곳은 **신호와 불변식**이다: 우리에게 없는 측정(오디오 에너지·모션·LUFS·해상도)과, 우리가 사후 검증하는 것을 생성 시점에 봉쇄하는 규율.
- 우리가 앞선 곳은 **편집 판단**이다: 자막 청킹 최적화기, 결정론 훅 점수(관측 가능), 중점 분할 충돌 중재, visual/caption 이중 좌표계, 콘텐츠 인지형 패딩, 히트맵·비전 그라운딩 — 네 감사 모두 대응물 없음 판정.
- 최대 구조적 약점 2개: ①무대사 구간에 대한 **측정 신호 0개** (히트맵 없으면 장님 — `profileSourceCase`가 근거 없이 `action_peak` 선언하는 실버그 포함) ②롤링 VTT 큐라는 **입력 정밀도 천장**.

## 오늘 이미 이식 완료

- **어택/릴리스 가드** (ClippyMe 1위): 컷을 발화 경계가 아니라 무음 골 안쪽에(lead 0.04 / tail 0.06). 지금까지 매 대사의 첫 자음·끝음이 -26dB 아래에서 구조적으로 잘렸음. `trimDialogueWindowsToSpeech` 수정, 테스트 259 통과.
- (그 전) **샷 경계 스냅**: ffmpeg scene 필터 — OpenShorts 감사에서 "캐시는 우리가 앞섬" 판정.

## 1차 이식 묶음 (S급) — 2026-08-08 승인·이식 완료

7건 전부 반영, 테스트 259 통과. 실측 스모크: 에너지(오디오 1.2s/모션 25s, 캐시), 라우드니스(Cirque 나레이션 -17.0 vs 대사 -17.8 = Δ0.9LU 통과).

| # | 항목 | 출처 | 효과 | 삽입 지점 |
|---|---|---|---|---|
| 1 | **에너지 프로파일**: ffmpeg로 오디오 RMS(+가능하면 모션 fps=6·scale=256·tblend) → `energy_profile.json` → 비트·편집계획 프롬프트에 히트맵 옆 주입 | AutoShorts | **무대사 시각 피크가 측정값으로 후보에 오름** — 거머리 사고의 구조적 재발 방지 2중화. 토큰 0 | compression service, 비전 지도 옆 |
| 2 | `profileSourceCase` 히트맵 부재 시 근거 없는 `action_peak` 선언 → 에너지 피크를 증거로 사용, `peak_evidence` 필드 | AutoShorts 감사가 발견한 실버그 | 위험한 무근거 가이던스 제거 | `:1234-1240` |
| 3 | 0초·음수 자막을 **생성 시점 불변식으로** (사후 측정→봉쇄 승격) | OpenShorts | draft-verify 지표 1개 구조적 소멸 | assemble_slot_draft_input.py + capcut_draft.py |
| 4 | **라우드니스 게이트**: 나레이션 vs 원본 대사 LUFS 측정(`loudnorm print_format=json`), 차이 >3LU 경고/>6LU 실패 | OpenShorts (실측 근거 포함) | 새 결함 클래스 개방 — "나레이션만 얇게 들림" | acceptance gates |
| 5 | **소스 해상도 프리플라이트**: 실행 전 최대 해상도 정찰, <720p 실패 | OpenShorts quality_probe | 360p 소스에 전체 실행 낭비 방지 | preflight + run-source 스킬 |
| 6 | 콜드오픈 후보 **시간축 NMS dedupe** + 후보 전량 `cold_open_candidates.json` 보존 | Shorts-Gen | rerank 전제조건 + 진단 가능성 | compression service |
| 7 | silencedetect **전역 1회** (현재 큐당 ffmpeg 스폰 — 수백 배 감속 원인) | ClippyMe | 성능, 로직 등가 | detectSpeechRanges 재작성 |

## 2차 묶음 (M급)

- **콜드오픈 listwise rerank** (Clips Studio 구조 독립구현): 결정론 점수로 상위 K=5~6 컷 → LLM 1회 상대평가(점수 숨김) → 실패 시 현행 argmax 폴백. 현행 `+120` LLM 편향·`hook<4` 절단 제거. + 3턴 마이크로 익스체인지 후보 (ClipsAI 다중 해상도 발상)
- **샷 경계 최소 길이 병합**(0.4s 미만 마이크로샷 제거) + 스냅 실패 명시 로깅 — "0.25초 조각"의 상류 원인 제거 (OpenShorts)
- **프레임 증빙 자동 판정**: preview proof에 mean<16(블랙)/std<6(동결) — 육안 검증 일부 자동화 (OpenShorts)
- non-speech 마스킹(대사 라우드니스 오탐 제거) + cumsum 슬라이딩 윈도 피크 픽커 (AutoShorts — sum→mean 보정 필수)
- 비전 스키마에 `visual_intensity(1-5)` + `moment_type` 필드 추가 — 추가 API 호출 0
- half-gap 리드인(컷을 전환 직전 무음 안쪽에), 상대 오디오 플로어(절대 -26dB 보완)

## 3차 / 보류 (L급)

- **Whisper 워드 타임스탬프 배관** (ClippyMe 4위): VTT 문자비례 근사의 정밀도 천장을 걷어냄. 문장 경계 확장(5위)의 선행 조건. `transcribe_source.py`가 이미 있어 배관만 문제
- **게임 소스 브랜치** (AutoShorts 설계 스케치 확보): transcript-optional + 에너지·비전 비트 생성 + 7종 분류
- TransNetV2 신경망 샷 검출: **비권장** (torch 의존 비용 > 디졸브 오스냅 실측 전 이득)
- 필러 워드 제거: 우리 아키텍처(창 내부 비압축)와 충돌 — 보류

## 포팅 시 주의 (그들의 버그 — 그대로 베끼지 말 것)

- AutoShorts `scene_action_score`: 합(sum) 기반이라 긴 씬 편향 → **평균으로**; 오디오 86Hz vs 모션 6Hz 샘플 불균형으로 명목 0.6:0.4가 실효 0.95:0.05 → 샘플레이트 정규화 후 가중합; 모션 스무딩 `int(fps)` 샘플(≈5초) quirk → 초 단위 명시
- Shorts-Gen 청킹의 비대칭 오버랩(끝쪽 60s만) → 대칭으로
- ClippyMe -30dB를 가져오지 말 것 — 우리 -26dB는 영화 음악 베드에 실측 튜닝된 값

## 방법론 채택 (코드 아님)

- **상수 옆에 측정표를 주석으로 고정** (OpenShorts 전반): 왜 이 값인지 다음 사람이 보게. 선택 기준은 중앙값이 아니라 **최악 케이스 스프레드**
- **프리스크린 패턴** (ClippyMe): 비싼 연산 전에 의도적 과대추정 상한으로 스킵 판정 — 거짓 스킵 원리적 배제
