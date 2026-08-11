---
profile: production
analysis_mode: auto
source:
  url: "https://www.youtube.com/watch?v=LAQhfQn_rSw"
  content_type: movie_midform_recap
output:
  target_length_sec: 130
review:
  pause_before_tts: true
subtitle_limits:
  max_chars: 16
tone: 심문하는 자가 놀아나는 취조실. 리듬은 대사가 만들고 나레이션은 판 전환만 짚는다
opener_policy: cold_open_callback
spoiler_boundary: clip이 보여주는 범위 안에서만. 트릭의 전말·이후 전개 언급 금지
must_keep:
  - 핵심 축 - FBI의 압박 → 호스맨의 여유 → 말장난 응수 → 주도권 역전
  - 애틀러스의 도발적 말장난 원음 (말장난은 구조를 살려 번역)
  - 심문자-피심문자 태도 대비 교환
prohibitions:
  - 트릭 원리 해설 금지 - 화면이 보여주는 만큼만
  - 검증되지 않은 인물 관계·동기 날조 금지
  - clip 밖 사건 확장 금지
  - 감정을 이름 붙여 해석하는 나레이션 금지
  - 인물 소개 나레이션 금지
  - 렌더 결과물의 speaker-color mismatch 금지
render:
  preview_frame_proof: true
  use_capcut_template: true
  audio_path_mode: absolute
  video_placement_mode: source_clips
---

# Source
- clip url: https://www.youtube.com/watch?v=LAQhfQn_rSw
- target length: 130s (상한)
- title: FBI Tries to Break the Horsemen (Mark Ruffalo & Jesse Eisenberg) | Now You See Me
- source audio language: English
- subtitle source: 자동자막 (en) — 빠른 말장난 대사, 큐 뭉침 주의(서브큐 슬라이스), 게이트에서 프레임 대조
- speech density: 매우 높음 추정 - 취조실 대화극 (Anger Management 사례 유형)
- 케이스북 대조: 사례 3(대사 밀집·온도차 코미디) - 자막 대사 훅, 러닝 개그 전량 보존

# Editorial Preferences
- keep_dialogue_policy: preserve_scene_force — 도발과 응수 교환은 무조건 원음
- dialogue_unit_preference: micro_exchange
- narration_density: low — 여닫는 이음매 2곳이면 충분
- cut_anchor: 심문 개시 / 첫 도발 / 말장난 정점 / 주도권 역전
- 편집 교리: 덜어내기 — 대화의 반복을 덜고 태도 대비가 드러나는 교환만

# Fixed Facts
- title / year: Now You See Me (2013)
- one-line premise: FBI 심문실에서 마술사들이 오히려 심문자를 가지고 노는 장면
- common misunderstanding to avoid:
  - 인물 이름은 대사에서 들릴 때만
  - 부조리한 여유는 대사가 직접 보여준다 - 나레이션이 "그는 여유로웠다" 식 판정 금지
- unknown or ambiguous points:
  - 자동자막 화자 구분 없음 - 화면 기준
  - 말장난 오인식 가능 - 게이트에서 원문 대조

# Recap Intent
- one-line recap goal: 심문의 주도권이 뒤집히는 쾌감을 대사 리듬으로 전달한다
- cold-open hook: 가장 뻔뻔한 응수 한 줄
- emotional tone:
  - cat-and-mouse
  - smug confidence
  - reversal
- viewer question to sustain: 누가 누구를 심문하고 있는가
- preferred ending:
  - punchline
- title-hook note: 후킹 패턴 - wrong_target/backfire 계열 유력

# Narration Rules
- narration should:
  - 판 전환만 짚는다
- narration should not:
  - 트릭 해설 금지
  - 판정·감정 명명 금지

# Output Preference
- desired opening feel: 심문실인데 편안한 쪽이 이상하다
- desired midpoint feel: 말이 통하지 않는 게 아니라 말로 지고 있다
- desired ending feel: 심문이 끝났을 때 진 쪽은 책상 이쪽이었다
- pacing preference:
  - rapid dialogue rhythm
- viewer takeaway in one sentence: 준비된 자에게 심문실은 무대가 된다
