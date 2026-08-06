---
name: run-diagnose
description: midform 실행 실패를 분류·진단한다. 실패 stage별로 읽을 아티팩트, 일시 오류와 구조 문제의 구분, 이 프로젝트에서 반복된 함정들의 대응.
---

# 실행 실패 진단

## 0. 철칙

- **고치기 전에 그 코드가 실행되는지 확인한다.** 이 프로젝트에서 다섯 번, 실행되지 않는 자리를 고치고 "됐다"고 보고했다. 값이 안 변하면 수정이 아니라 경로/측정을 의심.
- 수정 후 검증은 코드 diff가 아니라 **재생성된 산출물**로 한다 (`/draft-verify`).

## 1. 어디서 죽었나

최신 `template_runs/*/run_summary.json`의 `failure_reason.stage`:

| stage | 읽을 것 | 흔한 원인 |
|---|---|---|
| ingest | message의 yt-dlp 오류 | YouTube 403(일시—재시도), 자막 없음(소스 교체) |
| analysis | message | 검증기 거부(구체 메시지 있음), LLM JSON 실패(재시도 1회) |
| bootstrap | `internal.bootstrap_preflight.preflight.checks`의 FAIL 항목; stderr의 Python traceback | 겹침 게이트, EPERM(CapCut 잠금) |
| draft | pipeline run의 `pipeline_state.json` → `error` | **TTS 키**(ElevenLabs `sk_` 오류), 렌더 검증 |
| acceptance_gates | `gate_results.results`의 fail 항목 | 색상 매칭(재질 부재=자막이 드래프트에 없음), 갈등 명료성 |
| final_draft_overlap | details의 pair/score | KO/JA 중복 |
| multimodal_escalation | details | Vertex 429(일시) — 1차 결과 폴백이 정상 동작하는지 확인 |

## 2. 일시 vs 구조

**일시 (재시도가 답)**: YouTube 403 · DNS · Vertex 429(쿼터) · Codex CLI 비정상 종료 · EPERM(CapCut 잠금 — 3단 폴백 있음: 삭제→개명→`_new` 생성; 사용자에게 CapCut 닫기 요청 가능).

**구조 (코드/프롬프트)**: 같은 stage에서 같은 메시지로 2회 이상 → 재시도 금지, 원인 추적. 검증기 거부는 메시지에 slot_id가 있으니 해당 아티팩트(`edit_plan.json`, `compression_slot_fills.json`)에서 그 슬롯을 직접 본다.

## 3. 반복된 함정

- **조용한 대체**: preflight 실패 시 옛 compression run으로 폴백한다. `compression_run_id !== bootstrap_source_run_id`면 경고를 읽고, 거부 사유(`bootstrap_fallback_rejected.failed_checks`)를 원인으로 추적.
- **캐시된 프로세스/산출물**: Node 서비스는 프로세스 시작 시 로드 — 수정 후엔 새 실행. `--resume` 단계가 수정 지점보다 뒤면 수정이 반영 안 됨(비트 수정→`ingest`부터, 계획→`analysis`, 원고→`slot_fill`, 조립→`bootstrap`).
- **한 값을 바꾸면 그 값을 전제한 검증기도 바꾼다** (줄 수 상한 5→8 때 검증기가 5로 남아 실패).
- **미실행 경로의 잠복 버그**: 처음 켜는 플래그(예: pauseBeforeTts)는 그 경로의 코드가 한 번도 안 돌았을 수 있다 — TDZ, 빈 파일, 잘못된 스키마 가정.
