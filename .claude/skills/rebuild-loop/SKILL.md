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

## 수기 수정을 지키는 방법 (2026-08-17)

`compress-refresh`/`finalize`는 KEEP_DIALOGUE 슬롯의 **줄 선택을 비트에서 다시 도출**하고 `compress-apply`는
**모든 fills를 다시 생성**한다. 그래서 손으로 고친 줄·자막·화자가 다음 실행에서 조용히 사라지곤 했다. 이제
표시하면 지켜진다:

- `edit_plan.json` 슬롯에 **`"authored_lines": true`** → 그 슬롯의 focus 줄/창을 재도출하지 않는다(트림·분리·
  런타임 상한 같은 기하 패스는 계속 돈다). 매칭된 창이 하나도 없으면 플래그는 무시된다 — 해석 불가한 선택을
  얼려두면 슬롯째 사라지므로.
- `compression_slot_fills.json` / `.ja.json` 슬롯에 **`"authored": true`** → apply가 그 슬롯의 자막·화자를
  생성본으로 덮지 않는다.

여전히 유효한 사실: **슬롯의 focus는 연속된 덩이(cluster)로 도출된다.** 흩어진 줄을 새로 넣고 싶으면
`narrative_beats.json`의 `key_dialogue`/`anchor_dialogue`를 고치는 것이 가장 확실하고, 그 뒤 refresh가
자기 좌표로 창을 잡는다. 자막/화자 교정은 **apply 다음**에 하고 `authored`로 표시한다.

## 승인된 원고를 지키는 재타이밍 (2026-08-16)

파서·병합 수정처럼 **transcript 좌표가 바뀌는** 수정을 옛 소스에 소급할 때 `compress-refresh`를 돌리면 대사 줄 선택 자체가 바뀌어(allin 25→31줄) 승인 원고를 다시 써야 한다. 원고를 얼리려면 **창의 시각만** 옮긴다:

```
node midform/scripts/retime_plan_windows.js <edit_plan.json> <transcript_timed.json> \
     --whisper <whisper_words.json> --apply
node scripts/midform.js run --template <tpl> --resume bootstrap --bootstrap-run <compress_run>
# slot_fills diff가 NONE이면 재승인 불필요 → review-resume → --resume draft
```

**먼저 `edit_plan.json`을 백업**한다(실패 시 되돌려야 재적용이 이중 적용되지 않는다). whisper 단어 타임스탬프가 있으면 그것이 1순위 진실이고 교정된 큐가 2순위다. 실전에서 확인된 규칙들:

1. **순서 되돌리기는 같은 슬롯 안에서만**: 콜드오픈은 뒷부분 대사를 일부러 앞에 재생하므로 플랜 순서 ≠ 시간순. 슬롯을 넘어 비교하면 정상 이동까지 되돌린다.
2. **티저 예약구간**: 콜드오픈 `teaser_visual_*` 안으로 들어가면 `cold_open_no_reserved_overlap`. 클립 pre-roll(0.5~0.7s)이 뒤로 당기므로 **아슬아슬하게 비켜서는 안 되고** 0.45s 여유를 둔다.
3. **겹침은 다음 발화 시작까지만 자른다 — 안전 간격을 강제하지 말 것**: rapid-fire 소스에서 0.35s를 예약했더니 클립 11개가 발화 도중 잘려 커버리지 0.93→0.81로 떨어졌다. 패딩 충돌은 floor·패딩 가드가 처리할 문제고, 잘린 말은 복구가 안 된다.
4. **뒷부분이 다른 줄은 접두 4단어로 배치**: 유튜브 자막과 whisper가 문장 끝을 다르게 듣는 경우가 흔하다("kill the trees" vs "revise it"). 전체 점수는 미달해도 앞 4단어 연속 일치면 시작 지점 근거로 충분하다.
5. **문장 중간의 긴 침묵**: "The... number one pick"처럼 첫 단어만 4초 앞에 떨어져 있으면 그 단어를 버리고 침묵 뒤에서 연다. 검증 스크립트도 같은 보정을 해야 정상 클립을 오탐하지 않는다.

## 함정 (전부 실사고)

- **워크스페이스 해시**: 템플릿 내용이 바뀌면(예: target 변경) 워크스페이스 폴더가 **바뀐다** — 옛 폴더를 읽고 "완료됐다" 오판하지 말 것. 항상 `template_runs`에서 mtime 최신 워크스페이스를 확인.
- **낡은 검수 재사용**: 파이프라인이 bootstrap_script.json mtime보다 오래되면 가드가 새 파이프라인을 강제한다(2026-08-10 봉인). 가드가 없던 시절엔 재작업본이 조용히 출하되지 않았다 — status "passed"가 곧 "새 판"이 아님을 기억.
- **compress run 상태 확인**: `run_summary.json`의 `internal.compression_run_id === internal.bootstrap_source_run_id` — 다르면 측정 자체가 무의미.
- **refresh 멱등성**: 액션 슬롯·채택 창은 refresh마다 재파생된다. 손으로 넣은 항목이 refresh 후 사라지면 코드 규칙에 걸린 것 — 규칙을 확인하지, 다시 손으로 넣지 말 것.
- **fills 배열 정렬**: 대사 줄 추가/삭제 시 caption 배열·speakers 배열·(ja 동일) 3원소가 어긋나면 자막 인덱스가 밀려 빈 자막/줄 소실이 난다.
- **앵커 스미어는 이제 자동 병합**(2026-08-12): 자동자막이 명대사를 여러 큐로 쪼개 "KEEP_DIALOGUE must include beat anchor" deadlock이 나면, beats 확정 직후 `mergeAnchorCuesInTranscript`가 단일 큐로 자동 병합한다. 그래도 남으면 anchor_dialogue 텍스트가 transcript 큐와 정말 다른 것 — 큐를 앵커 텍스트로 손수 맞추거나, 정 안 되면 beat anchor를 그 줄만 남기고 완화(key_dialogue엔 유지해 대사는 살림).
- **화자 색 붕괴**(distinct_speakers_not_collapsed): 새 인물이 `caption_colors.json`에 없어 fallback 충돌한 것. compress fills 화자 배정만으론 안 되고 **config `speakers` 등록이 결정론의 유일한 길** — draft가 이름으로 재계산하기 때문.
- **ja만 재생성**: 수술한 ko를 얼린 채 ja를 다시 만들려면 `compress-regenerate-ja <run>` (전체 apply는 ko도 덮음). 이 CLI는 프레임 검증된 ko 나레이션을 ja에 핀해 화면 진실을 상속시킨다 — ja 재생성이 plot summary로 회귀하는 것 방지.
- **일괄 수술 (크레딧 절감 — 2026-08-12 소유주 지시)**: 기계 눈 실패 시 `run_summary`의 메시지는 **앞 3개만** 보여준다. 하나 고치고 재빌드하면 판정 토큰을 매 라운드 다시 쓴다. 반드시 워크스페이스의 **`narration_mismatch_report.md`**(전체 실패 + `suggested_rewrite` 화면 사실 제안)를 열어 **모든 문장을 compress fills에서 한 번에 고친 뒤 재빌드 1회**. `acceptance_gates.json`의 `narration_visual_match.issues`에도 전체가 있다. 기계 눈은 첫 실패에서 멈추지 않고 전 문장을 판정하므로 첫 판정에 이미 다 나와 있다.

## 실패 시

프리플라이트 실패는 `failure_reason.details.checks`에서 `ok: false` 항목을 읽는 것에서 시작한다. 격리 재현(`MIDFORM_PACK_DEBUG`, 단독 함수 호출)이 눈먼 전체 재실행보다 빠르다 — 전체 재실행은 원인을 안 알려준다.
