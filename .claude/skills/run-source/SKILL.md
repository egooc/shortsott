---
name: run-source
description: 새 YouTube 소스로 midform 실행을 시작하는 표준 절차. 자막 유무 확인 → 케이스북 대조 → 템플릿 작성 → 실행 → 소스 프로파일 확인 → 완료 후 케이스북 사례 추가.
---

# 새 소스 실행 절차

## 1. 자막부터 확인 (필수 선행)

```
yt-dlp --js-runtimes node --no-playlist --skip-download --print "%(title)s | %(duration)s sec" --list-subs <URL>
```

해상도도 함께 확인: 720p 미만이면 compress가 차단한다(SOURCE_RESOLUTION_TOO_LOW), 1080p 미만이면 경고. 파이프라인은 자막 큐 기반이다. **자동자막조차 없으면 실행 불가** — 같은 장면의 다른 업로드를 사용자에게 요청한다(STT 폴백은 스코프 밖). 제목·길이도 여기서 확보.

예외: **게임 영상**은 자막이 없는 게 정상 — frontmatter에 `source.kind: game`을 선언하면 자막 없이 진행된다 (비전+에너지 구조, 전량 나레이션). 첫 실행 전 `midform/docs/game-branch-plan.md`를 읽을 것 — 브랜치는 배관만 완료 상태다.

## 2. 케이스북 대조

`midform/docs/source-casebook.md`를 읽고 가장 가까운 사례를 찾는다. 판별 축: 발화 밀도(대략), 히트맵 피크가 대사인지 액션인지, 길이. 사례의 "접근"과 "주의"를 템플릿에 반영한다.

## 3. 템플릿 작성

`midform/skills/midform-run/templates/<소스명>_ko.md`. 확립된 구조:

- frontmatter: `profile: production`, **`source.promo_tail_sec`** — 고정값 금지, 반드시 프레임 분석으로 잰다: `ffmpeg -ss <t> -i source.mp4 -frames:v 1 f.jpg`를 마지막 60초에서 이분탐색해 엔드카드 시작을 찾고 `duration - 경계`를 적는다. 자막 감지는 예고편 대사에 뚫리고, 어림값은 진짜 영화 대사를 자른다(둘 다 실제 사고), `source.url`, `output.target_length_sec`(소스의 ~절반 이하; 길이보다 완성도), **`review.pause_before_tts: true`** (원고 검수 게이트 — 항상 켠다), `subtitle_limits.max_chars: 16`
- `must_keep`: **핵심 축 한 줄**("A → B → C" 형태) + 살릴 대사 유형 3~4개 (따옴표로 시작하는 YAML 항목 금지 — 파싱 깨짐)
- `prohibitions`: 날조 금지, clip 밖 확장 금지, 웃음 포인트 선설명 금지, 감정 명명 금지, **인물 소개 나레이션 금지**, speaker-color mismatch 금지
- 본문: 발화 중심 지침(keep_dialogue_policy: preserve_scene_force, micro_exchange, narration_density: low, 이음매 원칙), Fixed Facts(추측 금지 항목 포함), 콜드오픈 훅 방향, 러닝 개그가 있으면 셋업-페이오프 보존 명시

## 4. 실행과 확인

```
node scripts/midform.js run --template <경로>   (백그라운드, ~10분 예상)
```

완료 후 확인 순서:
1. `run_summary.json` status — `paused_for_script_review`가 정상 (검수 게이트)
2. compress run의 `source_case.json` — 자동 프로파일이 케이스북 판단과 일치하는지
3. 이후 `/script-review` → 사용자 승인 → `review-resume` → `/draft-verify`

실패 시 `/run-diagnose`.

## 5. 완료 후 케이스북 갱신 (잊기 쉬움 — 필수)

`source-casebook.md`에 사례 추가: 프로필 / 이 소스에서만 드러난 것 / 콜드오픈 선택과 근거 / 사용자 검수 지적과 소스 성격의 연관. 새 유형이면 `profileSourceCase` 코드와 문서를 함께 갱신.
