# 워킹트리 커밋 정리 + CLAUDE.md 교훈 반영 보고

작성일: 2026-07-21

## 배경

지난 사건의 구조적 원인은 "잘 되던 상태가 미커밋 워킹트리로만 존재 →
그 위에 변경이 계속 덮임"이었다. 하이라이트 selector 복원을 마친 시점의
상태(하이라이트 = 8f97458 복원 + 풀드래프트 수리 보존)를 즉시 커밋해서
되돌아올 지점을 만들고, 재발 방지 규칙을 CLAUDE.md에 박아두는 작업.

## 1. 논리 단위 커밋 (5개)

diff를 파일 단위로 전수 확인해서 분류했다. 사용자가 지정한 3버킷 외에,
diff 내용상 명확히 분리되는 "Track B/실험 코드" 버킷을 하나 더 만들었다
(이미 "격리 코드"로 보존 대상이었던 영역과 정확히 일치).

| 순서 | 커밋 | 핵심 내용 | 비고 |
|---|---|---|---|
| ① | `d27ebc0` docs: record highlight window selector restore | 하이라이트 복원/진단 관련 문서 7개만 | **코드 diff 없음** — 복원이 8f97458과 완전히 일치해서 그 로직에 대해선 diff 자체가 존재하지 않음. 이게 복원 성공의 증거. |
| ② | `572578e` Preserve Korean Full draft repair pipeline | processQueueService/processMetadataService/processEditService/processJobService/capcutService/srtGenerator/processQueue route, `fullDraftRules.js`, script review·SRT·speech-budget 가드 스크립트 9개, package.json | 검수 게이트/SRT 전달/생성 수리 전부 |
| ③ | `761f801` Unify Vertex ADC auth + timeline clamp | `geminiService.js`, `action_timeline_extraction.txt` 프롬프트, item_030 clamp 검증 문서 | Vertex 우선 + API key fallback, `MEDIA_RESOLUTION_LOW`, `normalizeActionTimelineEvents` 좌표 clamp |
| ④ | `2e15e52` Isolate Highlight Pattern research (Track B) | `highlightSlicerService.js`, `highlightPatternDbService.js`, `abExperimentService.js`, `highlightPatterns` route, `trackb-*.js` 7개 | 사전등록 실험(H1/H2/H3), 프로덕션 셀렉터와 무관함을 diff로 재확인 |
| — | `8015df5` CLAUDE.md: codify lessons | CLAUDE.md 규칙 추가 | 아래 2번 항목 |

각 파일이 실제로 어느 버킷에 속하는지는 추측이 아니라 `git diff 8f97458 -- <file>`
전체를 읽고 판단했다. 애매했던 것들:

- `package.json`: 대부분 풀드래프트 가드 스크립트 등록이지만 `trackb:daily` 1줄도
  섞여 있음 → ②에 포함, 커밋 메시지에 명시하지 않음(사소한 혼입, hunk 단위 분리는
  리스크 대비 이득이 낮다고 판단).
- `server/services/processMetadataService.js`: 풀드래프트 로직(대부분) 안에
  `buildMultimodalGenerationConfig`(미디어 해상도 헬퍼) 같은 인프라성 코드가
  소수 섞여 있음 → 지배적 목적 기준으로 ②에 포함.
- `server/prompts/action_timeline_extraction.txt`: clamp 지시문 추가라 ③에 포함
  (현재 이 함수의 유일한 런타임 호출자는 ④의 `highlightSlicerService.js`지만,
  변경의 성격 자체는 좌표 clamp이므로 ③).

커밋 후 `git status --short`는 완전히 비어 있음을 확인했다.

## 2. CLAUDE.md 규칙 추가 (커밋 `8015df5`)

`## 다음 제안`으로 언급했던 회귀 방지 아이디어를 실제로 CLAUDE.md에 반영했다.
추가된 4개 섹션:

1. **프로덕션 하이라이트 경로 수정 금지**: `pickHighlightWindow` /
   `capcut_draft.py` 및 관련 상수는 검증된 수익 시스템 — 사용자의 명시적
   승인 없이 새 셀렉터 추가·스코어링 "개선"·duration 상수 변경 금지.
2. **실험 코드 격리**: Highlight Pattern/Track B류 신규 연구 코드는 별도
   파일에만 존재해야 하며 프로덕션 경로(`processQueueService.js` 등)의
   의존성이 되어서는 안 됨. 프로덕션 헬퍼를 읽기 전용으로 재사용하는 건 허용.
3. **완료 보고는 원문 인용 필수**: `edit_manifest.json`/`draft_content.json`에서
   세그먼트 수, window 구간, 셀렉터 필드를 실제로 읽어 인용해야 유효한 보고.
4. **작업 단위마다 즉시 커밋**: 이번 사건이 정확히 "미커밋 워킹트리 위에 계속
   변경이 쌓인" 구조적 원인이었다는 점을 근거로 명시.

이 규칙들은 세션이 리셋되거나 에이전트(코덱스/클로드코드 무관)가 바뀌어도
레포에 고정되어 유지된다.

## 결과

- 워킹트리: 클린 (커밋 전 17개 modified + 26개 untracked → 커밋 후 0)
- 커밋 5개, 브랜치 `main`은 origin 대비 19 커밋 앞섬(푸시는 하지 않음 — 명시적
  요청 없이는 원격에 반영하지 않는다는 기본 원칙 유지)
- CLAUDE.md에 4개 규칙 영구 반영

## 다음 제안

1. **원격 반영 여부 확인**: 로컬 커밋만 쌓여 있고 `origin/main` 대비 19 커밋
   앞선 상태다. push 시점과 대상 브랜치(바로 main인지, PR 경유인지)를 정해야 한다.
2. **하이라이트 회귀 가드 스크립트**: CLAUDE.md에 규칙을 적었지만 기계적으로
   강제하는 가드는 아직 없다. `check:shortform-highlight` 처럼
   `pickHighlightWindow`/`selectBestHighlightWindow`가 하이라이트 선택의
   유일한 진입점임을 문자열 계약으로 고정하는
   `scripts/check-highlight-window-selector-contract.js` 추가를 권장한다.
3. **Track B와 프로덕션 경로의 향후 동기화 정책 결정**: 지금은 완전히 분리됐지만,
   만약 Track B 실험 결과(H1/H2/H3 유의성)가 실제로 프로덕션 셀렉터에
   반영되어야 하는 시점이 오면, 그 반영 자체도 "사용자 명시 승인" 프로세스를
   거치도록 CLAUDE.md 1번 규칙과 연결해서 진행할 것을 제안한다.
