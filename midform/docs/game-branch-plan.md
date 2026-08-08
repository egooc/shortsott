# 게임 소스 브랜치 설계 (AutoShorts 접근 독립 구현)

작성: 2026-08-09. 상태: **배관 완료 / 본체는 첫 실소스 런이 끌고 간다** (per-source 검증 교리 —
영화 파이프라인의 모든 불변식이 실소스가 적발한 구멍에서 나왔듯, 게임 브랜치도 실소스 없이
깊게 지으면 추측 코드가 된다).

## 영화 파이프라인과의 근본 차이

| 축 | 영화 클립 | 게임 영상 |
|---|---|---|
| 좌표계 | 자막 큐 (발화가 구조) | **없음** — 비전 장면 지도 + 에너지 피크가 유일한 구조 |
| 고유값 | 발화 보존 (대사 DROP 금지) | 해당 없음 — 전량 나레이션 |
| 편집 교리 | 덜어내기 (내부 아크에서 파편 제거) | 동일하게 적용 — 플레이 아크(탐색→시도→실패→성공)에서 덜어냄 |
| 콜드오픈 | 대사 훅 / 히트맵 피크 | 에너지 피크 scene hook (원본 오디오 티저) — 이미 있는 경로 |
| 자막 | 대사 자막 + 나레이션 | 나레이션 자막만 (+ 필요 시 화면 텍스트 캡션) |

## 이미 완료된 배관 (2026-08-09)

1. 템플릿 frontmatter `source.kind: game` → `normalizedRequest.source.kind` → `runCompression({sourceKind})`.
2. `extractTimedTranscript`: game 모드에서 자막 부재 시 SUBTITLE_NOT_FOUND 차단 대신 **빈 transcript 반환**.
3. `profileSourceCase` 결과에 `case_type: 'game_no_dialogue'` 강제.
4. 검증 확인(테스트 존재, tests/gameSourceBranch.test.js):
   - `validateBeats`는 footage 경계 기반이라 빈 transcript에도 동작 (대사 없는 비트 허용은 기존 동작).
   - `finalizeEditPlan`은 빈 transcript + 전량 NARRATE 플랜에서 생존.

## 첫 실소스 런에서 확인/구축할 것 (예상 작업 지도)

1. **비트 프롬프트**: 빈 transcript일 때 비전 장면 지도 + 에너지 섹션만으로 비트가 서는지.
   아마 game 전용 프롬프트 변형 필요 (플레이 아크 언어: 시도/실패/성공, 오버레이 텍스트 읽기).
2. **비전 장면 지도**: 게임 화면은 장면 전환 문법이 다름 (컷 아님, 로딩/메뉴/전투 상태 전환).
   `ensureVisionSceneMap`의 contentType 파라미터가 이미 있음 — game 힌트 추가 검토.
3. **slot_fills**: 나레이션 전용 원고. 영화용 "대사 사이 이음매" 규칙 대신 AutoShorts식
   "행동 서술 최소, 긴장 서술" 지침 필요. 게임 고유 금지: 조작 튜토리얼화, HUD 수치 낭독.
4. **bootstrap/게이트**: 전량 NARRATE 스크립트는 `capcut_narration_has_broll` 게이트가 모든 슬롯에
   명시적 b-roll을 요구 — visual_source가 비트에서 나오는지 확인. 대사 게이트들은 자연 통과(0건 대상).
5. **콜드오픈**: scene hook 경로(`source_audio_teaser`)가 기본. 게임 오디오(효과음·보이스라인)가
   티저 오디오로 실리는지 확인. runner_ups 미생성 한계는 rerank 도입 전 flip 경로와 동일.
6. **오디오**: 게임 원본 오디오(BGM+효과음)와 TTS 나레이션의 라우드니스 정렬 — 기존
   `computeLoudnessAlignment`가 dialogue 트랙 없이도 동작하는지 (video vs tts 2트랙 경로).
7. **케이스북**: 첫 런 후 `game_no_dialogue` 사례 추가 + `profileSourceCase` 문서 갱신.

## AutoShorts에서 가져오는 것 / 버리는 것

- **가져옴**: 에너지 기반 하이라이트 선별(이미 이식됨 — ensureEnergyProfile), 나레이션 중심 대본
  구조, 클립당 단일 아이디어 원칙.
- **버림**: 완전 자동 업로드 체인(우리는 검수 게이트 필수), 템플릿 문장 생성(날조 금지 교리 충돌),
  고정 길이 슬롯(길이는 결과값 교리 충돌).

## 실행 방법 (첫 검증 런)

```yaml
# 템플릿 frontmatter에 추가
source:
  url: <게임 영상 URL>
  kind: game
```

이후 `node scripts/midform.js run --template ...` — SUBTITLE_NOT_FOUND 없이 compress가 진행되고
비트 생성에서 무엇이 부족한지가 첫 번째 실측 데이터가 된다.
