# 장면 증거 아키텍처 — 설계 계약 (소유주 스펙 2026-09-07)

> 핵심 문장: **"문장이 화면을 데려온다"를 버리고, "선택된 화면 증거가 문장을 제한한다"로.**
> 퀄리티 저하의 핵심 원인은 프레임 수가 아니라, '원본을 이해하는 지도'와
> '실제 편집에 쓰는 장면-문장 결합표'를 하나로 쓰고 있기 때문이다.

## 왜 어긋나는가 (소유주 진단)
1. 30장 프레임은 사건이 아니라 정지 상태만 보여줌 — 명사·상태는 맞지만 **동사의 시간상**이 틀림
   (샘플이 100.8s·102.5s에만 걸리면 "총격을 시작합니다"를 끝난 화면에 얹게 됨)
2. STT 타임스탬프가 틀리면 전체 지도가 연쇄로 틀어짐 — VTT 큐 직접 신뢰 금지
3. "문장 먼저, 앵커 초 지정" 순서가 근본적으로 불안정 — 자동편집은 화면이 문장을 제한해야 함
4. 앵커 한 점으론 사건의 전/중/후를 구분 못 함

## 지도 3분리
| 지도 | 역할 | 금지 |
|---|---|---|
| `source_evidence_map.json` | 원본 전체 관찰 기록: 샷 경계, 인물 ID, 행동 전 상태/발생점/결과, 대사·화자, 장소, 신뢰도 | 요약·내레이션·조기 제외 금지 (제외는 아크 단계 몫) |
| `selected_arc_map.json` | 300초 안에 쓸 사건 선정: event_id+role(hook/setup/escalation/turn/payoff), required_context, 원인→선택→행동→결과 유지, 건너뛴 구간엔 BRIDGE 명시 | 시간순 나열만 하기 |
| `render_bindings.json` | **편집의 유일한 진실**: 문장↔event↔clips↔sync | 이것 없이 렌더 |

## 사건 객체
```json
{"event_id":"E042","source_window":{"start":100.0,"end":104.2},
 "event_points":{"setup":100.0,"onset":100.8,"peak":101.7,"result":102.5},
 "visible_action":"남자가 총을 꺼내 상대를 향해 발사한다.",
 "before_state":"두 사람이 마주 보고 있다.","after_state":"상대가 쓰러져 있다.",
 "visible_entities":["P03","P07"],"confidence":0.91}
```

## 렌더 결합표 항목
```json
{"sentence_id":"N07","event_id":"E042","narration_type":"literal_action",
 "text":"남자는 총을 꺼내 그대로 방아쇠를 당깁니다.",
 "source_clips":[{"start":100.15,"end":103.80}],
 "temporal_phase":"onset_to_peak",
 "sync_phrase":"방아쇠를 당깁니다","source_sync_sec":101.70,
 "must_show":["총을 꺼냄","발사 순간"],"must_not_show":["쓰러진 이후 화면만 표시"],
 "max_tts_duration_sec":3.65}
```

## 의미 동기점 (semantic_sync_point)
TTS 핵심어 발화 시작(렌더 t초)에 원본 사건 시각이 오도록 역산:
`클립 시작 = 원본 사건 시각 − TTS 핵심어 오프셋 × 재생 배속`

## 내레이션 4분류 (검수 기준 분리)
- **LITERAL_ACTION**: 행동·시간상이 화면에 정확히 보여야 함
- **CONTEXTUAL_FACT**: 직접 안 보여도 됨 — 당사자/장소 등장 + 모순 없음 검사
- **BRIDGE**: 시간 점프 — 중립 장면 허용
- **DIALOGUE_SETUP**: 바로 다음 대사·화자와 정확 연결

## 프레임 샘플링 (고정 30장 폐기)
- 정적 샷: 시작/중간/끝 3장 · 행동 샷: 전/시작/중간/최고점/결과 5장+ · 짧은 액션: 0.3~0.5s 스트립 5~8장
- 시트: 12~16셀, 셀마다 timestamp+shot_id+event_candidate_id — 관건은 장수가 아니라 시간 순서 판독성

## 최소 수정 6순서 (구현 트래킹)
1. **A1 STT 좌표 정화**: VTT 큐 직접 사용 금지, 단어별 STT+음성 에너지 대조, 스미어 큐 재정렬 → 원시/정규화 분리
2. **A3 지도에 사건 상태**: before_state/action_onset/action_peak/after_state/visible_entities/event_window/confidence
3. **A6 앵커 폐기→확장**: narration_event_id/clip_windows/temporal_phase/sync_phrase/source_sync_sec/must_show/must_not_show
4. **화면 선택 후 작문 (2회 호출)**: 1차 event 선택 → 2차 선택 증거 안에서만 작문, 못 쓰면 `NO_SAFE_NARRATION`
5. **B1 추론 픽커 폴백 금지(제작본)**: event binding 없으면 빌드 실패
6. **독립 최종 검수기**: 최종 렌더에서 문장 구간 7프레임(시작/25/50/75/끝/이전끝/다음첫)+문장 → 버딕트 {PASS, REWRITE_NARRATION, RESELECT_CLIP, SHIFT_SYNC_POINT, SPLIT_SENTENCE, HUMAN_REVIEW}. 캐시 키 = 문장h+소스h+클립구간+렌더프레임h+TTSh+모델·프롬프트 버전

## 기존 산출물의 재역할
- 현행 vision_scene_map = **탐색용 원본 지도의 전신** (버리지 않되 편집 결합 역할 박탈)
- narration_anchor_secs(09-07 오전 구현) = 과도기 — 3번에서 확장·대체
