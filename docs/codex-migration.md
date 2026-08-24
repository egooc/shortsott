# Vertex → Codex 전환

2026-08-24. Vertex 프로젝트가 과청구로 `PERMISSION_DENIED`(dunning) 상태가 되어 이관했다.
경위는 케이스북 36~38.

## 전환 스위치

| 환경변수 | 값 | 덮는 경로 |
|---|---|---|
| `MIDFORM_COMPRESS_LLM` | `codex` | 텍스트 3콜 — beats / edit_plan / slot_fills(ko·ja) |
| `MIDFORM_VISION_LLM` | `codex` | 프레임 판정기(기계 눈) + vision_scene_map |

**둘 다 기본값이 `vertex`다.** 설정하기 전까지 동작은 이전과 완전히 같다.

## 선행 조건

```
npm install -g @openai/codex     # codex-cli 0.149.1 이상
codex login                      # 브라우저 OAuth
```

**로그인은 반드시 기본 홈(`~\.codex`)으로 한다.** 셸에 `CODEX_HOME`이 걸려 있으면 인증이
거기 저장되는데, 야간 배치·schtasks가 spawn 하는 `codex`는 그 변수를 못 봐서
**대화형에선 되고 배치에서만 "Not logged in"** 이 된다. 확인:

```
codex login status
dir %USERPROFILE%\.codex\auth.json
```

## 경로별 대체 방식

- **텍스트 3콜**: `runJsonGeneration` 한 곳에 분기가 있어 세 호출을 전부 덮는다.
  검증·재시도·게이트 로직은 공급자와 무관하게 공유된다.
- **프레임 판정기**: Vertex는 `inlineData`, Codex는 `codex exec --image`. 판정 브리프는
  `buildFrameJudgeInstructions()` **한 곳**에서 만들어 두 공급자가 같은 문구를 읽는다 —
  공급자마다 문구가 다르면 다른 판정기가 되고, 그 차이는 오류가 아니라 판정 표류로 나타난다.
- **vision_scene_map**: Codex엔 비디오 입력이 없어 **7초 간격 프레임 샘플링**으로 재구현.
  주기는 캐시된 Vertex 지도(76씬/534초 ≈ 7초)를 재서 정했다. 대사는 모델이 아니라
  **전사에서** 창 겹침으로 채운다.
  - `story_context`와 `characters`는 **재구성하지 않는다.** 영상 전체를 본 추론이라
    스틸에서 지어내면 관측이 있던 자리에 추측이 들어간다. 하류는 `scenes[]`를 읽는다.

## 아직 Vertex에 남는 것

- `midformSocialPostService` — `generateVertexJson` 직접 호출, 분기 없음. 야간 제작
  경로가 아니라 우선순위를 뒤로 뒀다.
- `judgeDialogueTranslation` — 번역 감사. 실패 시 `{fixed:0, issues:[]}`로 조용히 degrade
  하므로 파이프라인을 막지 않는다.

## 되돌리기

두 환경변수를 지우거나 `vertex`로 바꾸면 즉시 원복된다. 코드 경로가 양쪽 다 살아 있다.
