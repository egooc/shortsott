---
profile: production
analysis_mode: auto
source:
  url: "https://www.youtube.com/watch?v=GWeSi5rzPBI"
  content_type: movie_midform_recap
output:
  target_length_sec: 140
review:
  pause_before_tts: true
subtitle_limits:
  max_chars: 16
tone: 정신병동의 어린 살인자와 그를 이해하려는 의사. 공포는 아이의 평온함에서 나온다 - 나레이션은 그 온도차만 짚는다
opener_policy: cold_open_callback
spoiler_boundary: clip이 보여주는 범위 안에서만. 이후 성장·탈출·본편 전개 언급 금지
must_keep:
  - 핵심 축 - 병동의 마이클 → 의사와의 대화 → 아이의 내면이 드러나는 순간 → 면회의 파국
  - 마이클과 루미스 박사의 대화 원음
  - 어머니 면회 장면의 감정 원음
prohibitions:
  - 실제 범죄 미화·모방 유발 표현 금지 - 살상 절차 묘사 금지 (노딱 안전 어휘 엄수)
  - 검증되지 않은 심리 진단·동기 단정 금지 - 영화가 보여주는 만큼만
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
- clip url: https://www.youtube.com/watch?v=GWeSi5rzPBI
- target length: 140s (상한)
- title: Young Michael Myers in the Psych Ward | Halloween (롭 좀비판 2007)
- source audio language: English
- subtitle source: 자동자막 (en) — 낮은 목소리 대화 위주, 게이트에서 프레임 대조
- speech density: 높음 추정 - 의사-환자 대화극
- 유의: 호러지만 이 장면은 대화극 - 액션 파이는 낮게 나올 것(측정 공식이 판단)

# Editorial Preferences
- keep_dialogue_policy: preserve_scene_force — 마이클의 말과 침묵, 루미스의 질문은 원음
- dialogue_unit_preference: micro_exchange
- narration_density: low
- cut_anchor: 병동 도착 / 대화의 전환점 / 가면 이야기 / 면회 파국
- 편집 교리: 덜어내기 — 대화의 반복을 덜고 온도차가 드러나는 교환만

# Fixed Facts
- title / year: Halloween (2007, Rob Zombie)
- one-line premise: 병동에 수용된 어린 마이클과 그를 진단하는 의사, 그리고 어머니의 면회
- common misunderstanding to avoid:
  - 1978년 오리지널이 아닌 롭 좀비 리메이크 - 설정 혼동 금지
  - 인물 이름은 대사에서 들릴 때만
- unknown or ambiguous points:
  - 자동자막 화자 구분 없음 - 화면 기준

# Recap Intent
- one-line recap goal: 아이의 평온한 얼굴과 그 안의 어둠 사이의 온도차를 전달한다
- cold-open hook: 가장 서늘한 한 마디 직전
- emotional tone:
  - quiet dread
  - clinical distance
  - maternal grief
- viewer question to sustain: 이 아이는 무엇이 되어가는가
- preferred ending:
  - cliff
- title-hook note: 후킹 패턴 - witness_pov/origin/unsettling_calm 계열 유력

# Narration Rules
- narration should:
  - 장면 전환과 시간 경과만 짚는다
- narration should not:
  - 심리 진단·판정 금지
  - 살상 절차 묘사 금지
  - 본편 확장 금지

# Output Preference
- desired opening feel: 너무 조용한 병동
- desired midpoint feel: 대화가 닿지 않는 곳
- desired ending feel: 돌이킬 수 없는 이별
- pacing preference:
  - slow clinical build
- viewer takeaway in one sentence: 가장 무서운 것은 괴성이 아니라 평온함이다
