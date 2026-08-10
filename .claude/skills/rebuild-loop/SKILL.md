---
name: rebuild-loop
description: 수정(코드/플랜/원고)을 기존 소스에 소급 적용하는 표준 재구축 루프. 계보 고정, refresh 순서, 게이트 원고 대조, 실측 검증까지 — 층이 어긋나는 사후 드래프트 수술을 방지한다.
---

# 수술 → 재구축 루프

수정은 **compress 산출물에** 넣고 아래 순서로 재구축한다. 사후 드래프트 수술은 층층이 어긋진다(확립 교리). 이 루프는 2026-08-09~10에 여섯 번 실전 검증됐다.

## 순서 (어기면 조용히 낡은 판이 나온다)

1. **수술**: `edit_plan.json` / `compression_slot_fills.json`(+`.ja.json` — 배열 3원소 병행!) / `transcript_timed.json` 등 compress run 디렉터리 안의 산출물만 수정. 코드 수정이면 코드만.
2. **refresh**: `node scripts/midform.js compress-refresh <compress_run_id>` — finalize가 재실행되며 창 해석·액션 삽입·안전망이 다시 돈다. **플랜/코드가 바뀌었으면 필수** — resume bootstrap은 edit_plan.json을 그대로 읽는다.
3. **재구축**: `node scripts/midform.js run --template <경로> --resume bootstrap --bootstrap-run <compress_run_id>` — 핀이 계보 4필드를 고정하고 파이프라인 포인터를 지운다. 핀 없이 돌리면 preflight 실패 시 **조용히 구계보로 폴백**한다(실사고 2회).
4. **게이트 대조**: `paused_for_script_review`에서 새 pipeline run의 `slot_fills.json`을 **직전 승인본과 diff** (무성 액션 슬롯 제외). NONE이면 사용자 재승인 불필요, 차이가 있으면 계획서로 보고 후 승인 대기.
5. **재개**: `review-resume <pipeline_run_id>` → `run --template ... --resume draft`.
6. **실측**: /draft-verify 절차. 코드 diff가 아니라 산출물이 근거다.

## 함정 (전부 실사고)

- **워크스페이스 해시**: 템플릿 내용이 바뀌면(예: target 변경) 워크스페이스 폴더가 **바뀐다** — 옛 폴더를 읽고 "완료됐다" 오판하지 말 것. 항상 `template_runs`에서 mtime 최신 워크스페이스를 확인.
- **낡은 검수 재사용**: 파이프라인이 bootstrap_script.json mtime보다 오래되면 가드가 새 파이프라인을 강제한다(2026-08-10 봉인). 가드가 없던 시절엔 재작업본이 조용히 출하되지 않았다 — status "passed"가 곧 "새 판"이 아님을 기억.
- **compress run 상태 확인**: `run_summary.json`의 `internal.compression_run_id === internal.bootstrap_source_run_id` — 다르면 측정 자체가 무의미.
- **refresh 멱등성**: 액션 슬롯·채택 창은 refresh마다 재파생된다. 손으로 넣은 항목이 refresh 후 사라지면 코드 규칙에 걸린 것 — 규칙을 확인하지, 다시 손으로 넣지 말 것.
- **fills 배열 정렬**: 대사 줄 추가/삭제 시 caption 배열·speakers 배열·(ja 동일) 3원소가 어긋나면 자막 인덱스가 밀려 빈 자막/줄 소실이 난다.

## 실패 시

프리플라이트 실패는 `failure_reason.details.checks`에서 `ok: false` 항목을 읽는 것에서 시작한다. 격리 재현(`MIDFORM_PACK_DEBUG`, 단독 함수 호출)이 눈먼 전체 재실행보다 빠르다 — 전체 재실행은 원인을 안 알려준다.
