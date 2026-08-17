---
profile: production
analysis_mode: auto
source:
  url: "https://www.youtube.com/watch?v=5qWm_kVDhQQ"
  content_type: movie_midform_recap
output:
  target_length_sec: 180
review:
  pause_before_tts: true
subtitle_limits:
  max_chars: 16
tone: 서로를 속여온 두 여자의 마지막 대치. 반전은 대사가 흘리고, 나레이션은 판을 앞질러 말하지 않는다
opener_policy: cold_open_callback
spoiler_boundary: clip이 보여주는 범위 안에서만. 결말의 최종 반전을 나레이션이 미리 공개 금지
must_keep:
  - 핵심 축 - 대치 → 진실의 폭로 → 서로의 패 공개 → 뒤틀린 결말
  - 니나와 밀리의 결정적 폭로·응수 대사
  - 반전을 여는 핵심 대사
prohibitions:
  - 검증되지 않은 인물 관계·동기 날조 금지 - 대사가 말한 만큼만
  - clip 밖 사건이나 원작 소설 설정 확장 금지
  - 결말 반전을 나레이션이 앞질러 설명 금지 (info_gap 유지)
  - 감정을 이름 붙여 해석하는 나레이션 금지
  - 인물 소개 나레이션 금지
  - 폭력·범죄 절차적 묘사 금지 (노딱 안전 어휘)
  - 렌더 결과물의 speaker-color mismatch 금지
render:
  preview_frame_proof: true
  use_capcut_template: true
  audio_path_mode: absolute
  video_placement_mode: source_clips
---

# Source
- clip url: https://www.youtube.com/watch?v=5qWm_kVDhQQ
- target length: 180s (상한)
- title: Nina and Millie's Twisted Ending (Full Scene) | The Housemaid
- source audio language: English
- subtitle source: 자동자막 (en) — 게이트 프레임 대조 필수
- speech density: 높음 추정 - 두 인물 대치 대화극
- 유의: 2025 스릴러. 반전 구조라 나레이션이 결말을 앞지르면 스포일러 - info_gap 엄수

# Editorial Preferences
- keep_dialogue_policy: preserve_scene_force — 폭로·응수의 교환은 무조건 원음
- dialogue_unit_preference: micro_exchange
- narration_density: low
- cut_anchor: 대치 개시 / 첫 폭로 / 패 공개 / 뒤틀린 결말 직전
- 편집 교리: 덜어내기 — 대치의 반복을 덜고 판이 뒤집히는 폭로만

# Fixed Facts
- title / year: The Housemaid (2025)
- one-line premise: 서로를 속여온 두 여자가 마지막으로 진실을 주고받는 대치 장면
- common misunderstanding to avoid:
  - 인물 이름은 대사에서 확인될 때만
  - 두 사람의 과거는 대사가 말한 만큼만
- unknown or ambiguous points:
  - 자동자막 화자 구분 없음 - 화면(니나/밀리 컷)으로 화자 판단

# Recap Intent
- one-line recap goal: 두 사람이 서로의 패를 뒤집는 반전의 긴장을 대사로 전달
- cold-open hook: 가장 서늘한 폭로 한 마디
- emotional tone:
  - mutual deception
  - reveal tension
  - twist
- viewer question to sustain: 누가 누구를 속이고 있었는가
- preferred ending:
  - cliff
- title-hook note: 후킹 패턴 - info_gap/betrayal/twist 계열

# Narration Rules
- narration should:
  - 판 전환만 짚는다
- narration should not:
  - 반전 결말 선공개 금지
  - 판정·감정 명명 금지

# Output Preference
- desired opening feel: 웃고 있지만 칼을 쥔 두 사람
- desired midpoint feel: 진실이 하나씩 뒤집힌다
- desired ending feel: 이긴 쪽이 누구인지 모를 마지막
- pacing preference:
  - tense reveal rhythm
- viewer takeaway in one sentence: 속인 자와 속은 자의 자리는, 마지막 순간까지 뒤집힌다
