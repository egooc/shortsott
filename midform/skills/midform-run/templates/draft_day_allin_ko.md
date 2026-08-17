---
profile: production
analysis_mode: auto
source:
  url: "https://www.youtube.com/watch?v=EA-lJxd2NGs"
  content_type: movie_midform_recap
output:
  target_length_sec: 170
review:
  pause_before_tts: true
subtitle_limits:
  max_chars: 16
tone: 모든 걸 건 마지막 한 수. 리듬은 협상 대사가 만들고 나레이션은 판 전환만 짚는다
opener_policy: cold_open_callback
spoiler_boundary: clip이 보여주는 범위 안에서만. 이후 드래프트 결과 확장 금지
must_keep:
  - 핵심 축 - 압박 → 승부수 결정 → 협상 실행 → 판의 결말
  - 소니의 결정적 승부수 대사
  - 상대·주변의 반응 대사
prohibitions:
  - 검증되지 않은 인물 관계·동기 날조 금지
  - clip 밖 사건·실제 NFL 결과 확장 금지
  - 감정을 이름 붙여 해석하는 나레이션 금지
  - 인물 소개 나레이션 금지 (직책은 대사가 말할 때만)
  - 렌더 결과물의 speaker-color mismatch 금지
render:
  preview_frame_proof: true
  use_capcut_template: true
  audio_path_mode: absolute
  video_placement_mode: source_clips
---

# Source
- clip url: https://www.youtube.com/watch?v=EA-lJxd2NGs
- target length: 170s (상한)
- title: Sonny Weaver Goes All In on Draft Day (Kevin Costner) | Draft Day
- source audio language: English
- subtitle source: 자동자막 (en) — 빠른 협상 대사, 큐 뭉침 주의, 게이트 프레임 대조
- speech density: 매우 높음 추정 - 협상 대화극 (NYSM/Anger 유형)
- 케이스북 대조: 대사 밀집 - 자막 대사 훅, 협상 리듬 보존

# Editorial Preferences
- keep_dialogue_policy: preserve_scene_force — 승부수·조건 교환은 무조건 원음
- dialogue_unit_preference: micro_exchange
- narration_density: low
- cut_anchor: 압박 상황 / 승부수 결정 / 협상 실행 / 결말
- 편집 교리: 덜어내기 — 협상 반복을 덜고 판이 결정되는 순간만

# Fixed Facts
- title / year: Draft Day (2014)
- one-line premise: 드래프트 당일, 단장이 모든 걸 건 마지막 승부수를 던지는 장면
- common misunderstanding to avoid:
  - 인물 이름·팀은 대사에서 들릴 때만
  - 드래프트 용어는 몰라도 이해되게 (승부의 긴장만 전달)
- unknown or ambiguous points:
  - 자동자막 화자 구분 없음 - 화면(전화 컷백)으로 화자 판단

# Recap Intent
- one-line recap goal: 모든 걸 건 한 수가 판을 결정짓는 승부의 긴장을 대사로 전달
- cold-open hook: 가장 대담한 승부수 대사
- emotional tone:
  - all-in stakes
  - nerve
  - decisive move
- viewer question to sustain: 이 도박이 성공할 것인가
- preferred ending:
  - stakes resolved
- title-hook note: 후킹 패턴 - all_in/high_stakes 계열

# Narration Rules
- narration should:
  - 승부 국면의 전환만 짚는다
- narration should not:
  - 결과를 앞질러 말하지 말 것
  - 판정·감정 명명 금지

# Output Preference
- desired opening feel: 물러설 곳 없는 단장
- desired midpoint feel: 판돈을 다 건 한 수
- desired ending feel: 승부가 갈린 순간
- pacing preference:
  - rapid negotiation rhythm
- viewer takeaway in one sentence: 물러설 수 없을 때, 승부는 배짱이 가른다
