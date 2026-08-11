---
profile: production
analysis_mode: auto
source:
  url: "https://www.youtube.com/watch?v=Ym7FrMU6vJc"
  content_type: movie_midform_recap
output:
  target_length_sec: 140
review:
  pause_before_tts: true
subtitle_limits:
  max_chars: 16
tone: 무리의 규율과 개인의 선택이 부딪히는 밤. 나레이션은 세력 구도의 전환만 짚는다
opener_policy: cold_open_callback
spoiler_boundary: clip이 보여주는 범위 안에서만. 이후 전개(임프린팅·전투 등) 언급 금지
must_keep:
  - 핵심 축 - 무리의 결정 → 제이콥의 거부 → 알파 혈통 선언 → 무리 이탈
  - 제이콥의 혈통 선언 대사 원음
  - 늑대 변신/대치의 원음 액션
prohibitions:
  - 검증되지 않은 관계·동기 날조 금지 - 대사가 말한 만큼만
  - clip 밖 사건이나 결말 확장 금지 - 본편 설정 지식 주입 금지
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
- clip url: https://www.youtube.com/watch?v=Ym7FrMU6vJc
- target length: 140s (상한)
- title: The Day Jacob Became the Alpha Wolf (Full Scene) | Twilight: Breaking Dawn Part 1
- source audio language: English
- subtitle source: 자동자막 (en) — 늑대 텔레파시 나레이션 구간과 실제 발화 구분 주의, 게이트에서 프레임 대조
- speech density: 중간 추정 - 선언·논쟁 대사와 늑대 CGI 액션이 교차
- 케이스북 대조: Breaking Dawn Pt2 사례(발화 18%, 액션 훅)와 다름 - 이 장면은 선언 대사가 축. 대사 훅 우선, 액션 비트는 변신/대치에

# Editorial Preferences
- keep_dialogue_policy: preserve_scene_force — 거부와 선언의 교환은 무조건 원음
- dialogue_unit_preference: micro_exchange
- narration_density: low
- cut_anchor: 무리의 결정 / 제이콥의 거부 / 혈통 선언 / 이탈
- 편집 교리: 덜어내기 — 논쟁의 반복을 덜고 국면 전환만

# Fixed Facts
- title / year: Twilight: Breaking Dawn Part 1 (2011)
- one-line premise: 무리의 결정에 맞선 제이콥이 알파의 혈통을 선언하고 무리를 떠나는 장면
- common misunderstanding to avoid:
  - 늑대 상태의 대사는 텔레파시(내레이션형) - 화면과 화자 매칭 주의
  - 인물 이름은 대사에서 확인될 때만
- unknown or ambiguous points:
  - 자동자막 화자 구분 없음 - 화면 기준, 불확실하면 미표기

# Recap Intent
- one-line recap goal: 명령을 거부한 한 명이 혈통을 선언하는 순간의 무게를 전달한다
- cold-open hook: 선언 직전의 대치 또는 선언 대사 자체
- emotional tone:
  - loyalty conflict
  - defiance
  - breakaway
- viewer question to sustain: 무리를 거스른 대가는 무엇인가
- preferred ending:
  - cliff
- title-hook note: 후킹 패턴 - wrong_target/forbidden/breakaway 계열 유력

# Narration Rules
- narration should:
  - 세력 구도의 전환만 짚는다
  - 한 문장 한 아이디어
- narration should not:
  - 판정·해석·감정 명명 금지
  - 본편 설정(임프린팅 등) 언급 금지

# Output Preference
- desired opening feel: 무리에 균열이 가는 밤
- desired midpoint feel: 물러설 수 없는 대치
- desired ending feel: 혼자가 된 알파
- pacing preference:
  - tension build then declaration
- viewer takeaway in one sentence: 혈통은 물려받는 것이 아니라 선언하는 것이다
