---
profile: production
analysis_mode: auto
source:
  url: "https://www.youtube.com/watch?v=jwyHe0XYmgU"
  content_type: movie_midform_recap
output:
  target_length_sec: 130
review:
  pause_before_tts: true
subtitle_limits:
  max_chars: 16
tone: 위기의 순간에 벌어지는 코미디. 웃음은 대사가 만들고, 나레이션이 웃음 포인트를 앞질러 설명하지 않는다
opener_policy: cold_open_callback
spoiler_boundary: clip이 보여주는 범위 안에서만
must_keep:
  - 핵심 축 - 중대한 상황 → 예상 밖 상태 → 위기를 넘기려는 분투 → 반전 결과
  - 결정적 웃음 대사와 응수 (말장난은 구조를 살려 번역)
  - 러닝 개그의 셋업-페이오프
prohibitions:
  - 검증되지 않은 인물 관계·동기 날조 금지
  - clip 밖 사건 확장 금지
  - 웃음 포인트를 나레이션이 앞질러 설명 금지
  - 감정을 이름 붙여 해석하는 나레이션 금지
  - 인물 소개 나레이션 금지
  - 약물 미화·조장 표현 금지 (상황 코미디로만, 노딱 안전 어휘)
  - 렌더 결과물의 speaker-color mismatch 금지
render:
  preview_frame_proof: true
  use_capcut_template: true
  audio_path_mode: absolute
  video_placement_mode: source_clips
---

# Source
- clip url: https://www.youtube.com/watch?v=jwyHe0XYmgU
- target length: 130s (상한)
- title: "We're On Molly Right Now" (Charlize Theron) | Long Shot
- source audio language: English
- subtitle source: 자동자막 (en) — 빠른 코미디 대사, 큐 뭉침 주의, 게이트 프레임 대조
- speech density: 높음 추정 - 상황 코미디 대화극
- 케이스북 대조: 대사 밀집 코미디(Anger Management 유형) - 자막 대사 훅, 러닝 개그 전량 보존, 나레이션 판정 금지

# Editorial Preferences
- keep_dialogue_policy: preserve_scene_force — 웃음 대사와 응수는 무조건 원음
- dialogue_unit_preference: micro_exchange
- narration_density: low — 여닫는 이음매 2곳
- cut_anchor: 중대 상황 개시 / 예상 밖 상태 드러남 / 위기 분투 / 반전
- 편집 교리: 덜어내기 — 상황의 반복을 덜고 온도차·반전이 드러나는 교환만

# Fixed Facts
- title / year: Long Shot (2019)
- one-line premise: 중대한 순간에 예상 밖 상태로 위기를 넘겨야 하는 상황 코미디
- common misunderstanding to avoid:
  - 인물 이름·직책은 대사에서 들릴 때만
  - 부조리한 상황은 대사가 직접 보여준다 - 나레이션 판정 금지
- unknown or ambiguous points:
  - 자동자막 화자 구분 없음 - 화면 기준
  - 말장난 오인식 가능 - 게이트 원문 대조

# Recap Intent
- one-line recap goal: 최악의 타이밍에 벌어지는 위기 극복의 웃음을 대사 리듬으로 전달
- cold-open hook: 가장 황당한 상황 대사 한 줄
- emotional tone:
  - awkward crisis
  - improvised save
  - comedic reversal
- viewer question to sustain: 이 상태로 어떻게 이 순간을 넘기는가
- preferred ending:
  - punchline
- title-hook note: 후킹 패턴 - wrong_timing/against_odds 계열

# Narration Rules
- narration should:
  - 상황 전환만 짚는다
- narration should not:
  - 웃음 선설명·판정 금지

# Output Preference
- desired opening feel: 하필 지금, 하필 이 상태로
- desired midpoint feel: 무너지기 직전에서 버틴다
- desired ending feel: 어떻게든 넘겼다
- pacing preference:
  - rapid comedic rhythm
- viewer takeaway in one sentence: 최악의 타이밍도, 배짱으로 밀어붙이면 넘어간다
