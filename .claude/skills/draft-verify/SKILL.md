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

## 1. 측정 (KO/JA 각각)

워크스페이스: 최신 `midform/test_runs/template_runs/<템플릿>_*/`. `run_summary.json`의 status와 failure_reason 먼저.

`draft_content.json`의 텍스트 트랙(`subtitle`, `subtitle_*`)에서 세그먼트(start, end, clip.transform.y, 텍스트)를 모아:

| 지표 | 기준 |
|---|---|
| 같은 높이(y) 동시 겹침 | **0건** (글자 위에 글자 = 판독 불가) |
| 다른 높이 레인 간 겹침 | 0보다 큼 (의도된 기능 — 0이면 직렬화 재발) |
| 0초(<0.05s) 자막 | **0건** |
| 문장 조각 연속 | 같은 대사의 `_cap_00N` 조각들이 공백 없이 연결 |
| 공백(>0.5s) | 대사 클립 위 공백 최소화, 나레이션 겹침 0 |
| 화자 색 | 화자 수 == 고유 색 수, 대사 세그먼트 메타데이터 누락 0 |
| 마지막 클립 | `edit_manifest.json` 마지막 세그먼트의 source_clips 길이 ≥ 1초 (0.25초 조각 금지) |

추가로 `edit_manifest.json`에서: 총 길이, 대사 vs 나레이션 초·개수 (대사 우위가 하우스 스타일).

## 2. 설치 (측정 통과 시)

```
대상: C:\Users\sejun\Desktop\캡컷아웃풋\CapCut Drafts\<YYYYMMDD순번>-<소스명>-<ko|ja>
```

mtime 최신 폴더를 복사. 같은 날 재설치는 접미사(b, c, ...)를 올린다. 설치 후 사용자에게 **지표 표 + 이전 판 대비 변화**를 보고한다.

## 3. 보고 원칙

- 문제가 남았으면 통과 항목과 함께 **정직하게** 남은 항목을 명시한다.
- 사용자가 특정 대사/장면을 지적했었다면 그 사례가 이번 판에서 어떻게 나오는지 **텍스트를 직접 인용**해 보여준다.
