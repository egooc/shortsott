---
name: draft-verify
description: 완성된 midform 드래프트를 고정 지표로 측정·검증하고, 통과 시 데스크톱에 검수용으로 설치한다. 측정 함정(동결 폴더, 잘못된 좌표계, 조용한 대체) 회피 절차 포함.
---

# 드래프트 검증 · 설치

수정 후 "됐다"고 보고하기 전에 반드시 이 절차로 산출물을 측정한다. 코드 diff가 아니라 산출물이 근거다.

## 0. 함정 회피 (이걸 어겨서 하루를 날린 적이 있다)

- **폴더 선택**: `draft_ko`와 `draft_ko_new`가 공존하면 반드시 `draft_content.json`의 **mtime이 최신인 쪽**. `_new`는 CapCut 잠금 시의 우회 산출물이라 낡았을 수 있다. 검증 후 낡은 `_new`는 삭제.
- **좌표계**: 자막 공백은 `edit_manifest.json`의 **`video_timeline_start/end_sec`** 기준으로 대조. `timeline_*`로 재면 "화면에 아무것도 없음"으로 오독한다.
- **대체 확인**: `run_summary.json`에서 `internal.compression_run_id === internal.bootstrap_source_run_id` 확인. 다르면 이 영상은 이번 실행 산출물이 아니므로 **측정 자체가 무의미**하다.
- **동결 감지**: 수치가 이전 측정과 소수점까지 동일하면 수정 무효가 아니라 **측정 대상이 갱신 안 된 것**부터 의심.
- **텍스트 권위 = compress run** (2026-08-11, 하루를 여기 날림): 옛 소스의 나레이션·대사·화자를 고칠 때 **반드시 `compress_*/compression_slot_fills.json`(+`.ja.json`)부터** 고친다. pipeline run의 `slot_fills.json`/`script.json`/`draft_input.*.json`을 고쳐도 bootstrap resume가 compress에서 재생성하며 덮는다. 수술 순서: compress 수정 → refresh → bootstrap → review-resume → draft.
- **화자 색 = config 이름 등록** (2026-08-11): draft는 `midform/config/caption_colors.json`에서 **화자명으로** 색을 재계산한다 — 업스트림 speaker_color_key는 무시. 미등록 인물은 fallback 해시 충돌로 collapse(제이콥·세스 둘 다 초록). 새 소스 등장인물은 config `speakers`에 먼저 등록(role: 남주/여주/남조연/여조연 또는 기타1~4). 색이 붙되 브랜드색이 아니면 미등록 신호.
- **ja만 재생성**: ko를 얼린 채 ja fills만 다시 만들려면 `node scripts/midform.js compress-regenerate-ja <compress-run>`. 전체 apply는 ko도 재생성해 프레임 진실 수술을 지운다. 이 CLI는 수술된 ko 나레이션을 프롬프트에 핀해서 ja가 화면 진실을 상속한다.
- **ja 스킵 ≠ 차별화 실패**: `japanese_locale_skipped`는 대개 차별화 과다가 아니라 ①ko 빈자리 세그먼트를 ja 누락으로 오판 ②도입 자유클립 1개 LCS 자동 1.0 — 둘 다 코드 수정됨(2026-08-12). skip 사유(`japanese_locale_skipped_reason`)를 먼저 읽는다.
- **기계 눈 실패는 일괄 처리 (크레딧 절감)**: `narration_visual_match` 실패 시 `run_summary` 메시지는 앞 3개만 보인다. 워크스페이스의 `narration_mismatch_report.md`(전체 실패 + `suggested_rewrite`)를 열어 **모든 문장을 한 번에 수술 → 재빌드 1회**. 하나씩 재빌드하면 실패 문장마다 판정 토큰을 매번 다시 쓴다(통과분은 캐시라 무료).
- **엔드카드 자동 감지**: Clip Empire 등 오버레이형 추천 카드는 `detect_visual_endcard.py`가 잡아 usable_end를 앞당긴다(자막 감지는 오디오가 끝까지라 못 잡음). 클로징이 끝에 붙는 소스는 usable_end 클램프로 클로징이 앞당겨지니, 그 화면과 클로징 문장이 맞는지 기계 눈으로 확인.

## 1. 측정 (KO/JA 각각)

JA는 KO와 **동일 지표로** 측정한다 — 특히 핵심 장면 커버(리빌·클라이맥스)가 KO와 동급인지. ja 창 시프트는 다음 대사 창을 넘지 못하게 코드 강제(2026-08-09)되어 있으므로, ja 커버 0은 회귀 신호다.

워크스페이스: 최신 `midform/test_runs/template_runs/<템플릿>_*/`. `run_summary.json`의 status와 failure_reason 먼저.

`draft_content.json`의 텍스트 트랙(`subtitle`, `subtitle_*`)에서 세그먼트(start, end, clip.transform.y, 텍스트)를 모아:

| 지표 | 기준 |
|---|---|
| 같은 높이(y) 동시 겹침 | **0건** (글자 위에 글자 = 판독 불가) |
| 다른 높이 레인 간 겹침 | 0보다 큼 (의도된 기능 — 0이면 직렬화 재발) |
| 0초(<0.05s) 자막 | **0건** |
| 문장 조각 연속 | 같은 대사의 `_cap_00N` 조각들이 공백 없이 연결 |
| **뒷줄 자막 지연** | 같은 줄의 다음 청크가 앞 청크 시작+읽기시간(글자수/8초)×2+1.5s 안에 등장 — 게이트 `dialogue_caption_chunk_lateness` 자동 검사 |
| 공백(>0.5s) | 대사 클립 위 공백 최소화, 나레이션 겹침 0 |
| 화자 색 | 화자 수 == 고유 색 수, 대사 세그먼트 메타데이터 누락 0 |
| 마지막 클립 | `edit_manifest.json` 마지막 세그먼트의 source_clips 길이 ≥ 1초 (0.25초 조각 금지) |

추가로 `edit_manifest.json`에서: 총 길이, 대사 vs 나레이션 초·개수 (대사 우위가 하우스 스타일).

## 1.5 프레임 육안 검증 (수치가 못 잡는 것)

수치 측정과 별개로, 최종 `draft_content.json`의 비디오 세그먼트 소스 구간을 ffmpeg로 프레임 추출해 **직접 눈으로** 확인한다 (compress run의 source.mp4 사용):
- 사용자가 지적했던 장면이 실제 화면으로 들어갔는가 (예: 습격 장면 프레임 존재)
- 각 나레이션 구간의 화면이 원고 주장과 일치하는가
- 마지막 클립·freeze 프레임이 어색하지 않은가

불일치 발견 시 설치하지 말고 보고. 검증 몽타주는 스크래치패드에 만들고 필요 시 사용자 보고에 첨부.

## 1.5 나레이션 b-roll 육안 검증 (의무 — 2026-08-10 사고로 승격)

수치 지표만으로 부족하다: "뒤엉켜 싸운다" 나레이션 밑에 키스씬이, "다시 달려든다" 밑에 폭발이
실려도 겹침·자막 지표는 전부 통과했다. **모든 recap 세그먼트**에 대해:
1. edit_manifest에서 세그먼트별 source_clips 중앙 시각을 뽑아 ffmpeg로 프레임 추출, hstack 몽타주로 Read.
2. 각 프레임을 그 슬롯의 나레이션 문장과 대조 — 문장이 말하는 장면이 맞는가 (비전 장면 지도 visible_action 참조).
3. `narration_broll_semantic_bounds` 게이트(플랜 창 ±8s + usable end)가 코드 방어선이지만, 창 안에서도 의미가 어긋날 수 있으므로 육안이 최종 판정.

## 2. 설치 (측정 통과 시)

```
대상: C:\Users\sejun\Desktop\캡컷아웃풋\CapCut Drafts\<YYYYMMDD순번>-<소스명>-<ko|ja>
```

mtime 최신 폴더를 복사. 같은 날 재설치는 접미사(b, c, ...)를 올린다. 설치 후 사용자에게 **지표 표 + 이전 판 대비 변화**를 보고한다.

## 3. 보고 원칙

- 문제가 남았으면 통과 항목과 함께 **정직하게** 남은 항목을 명시한다.
- 사용자가 특정 대사/장면을 지적했었다면 그 사례가 이번 판에서 어떻게 나오는지 **텍스트를 직접 인용**해 보여준다.
