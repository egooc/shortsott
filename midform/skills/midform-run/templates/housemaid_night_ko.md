---
profile: production
analysis_mode: auto
source:
  url: "https://www.youtube.com/watch?v=EdSQ4rNB6QU"
  content_type: movie_midform_recap
output:
  target_length_sec: 175
review:
  pause_before_tts: true
subtitle_limits:
  max_chars: 16
tone: 선을 넘는 밤. 긴장은 대사와 침묵이 만들고, 나레이션은 관계를 단정하지 않는다
opener_policy: cold_open_callback
spoiler_boundary: clip이 보여주는 범위 안에서만. 이후 전개·최종 결말 언급 금지
must_keep:
  - 핵심 축 - 가까워짐 → 경계를 넘는 순간 → 돌이킬 수 없는 선택
  - 앤드류와 밀리의 결정적 대사 교환
  - 전환점의 침묵과 표정
prohibitions:
  - 검증되지 않은 인물 관계·동기 날조 금지
  - clip 밖 사건이나 원작 설정 확장 금지
  - 선정적·노골적 묘사 금지 (노딱 안전 어휘 엄수)
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
- clip url: https://www.youtube.com/watch?v=EdSQ4rNB6QU
- target length: 175s (상한)
- title: The Night Everything Changes Between Andrew And Millie | The Housemaid
- source audio language: English
- subtitle source: 자동자막 (en) — 게이트 프레임 대조
- speech density: 중간 추정 - 대화와 긴 침묵 교차
- 유의: 2025 스릴러, 관계 전환 장면. 선정성 배제·노딱 어휘

# Editorial Preferences
- keep_dialogue_policy: preserve_scene_force — 전환점 대사는 원음
- dialogue_unit_preference: micro_exchange
- narration_density: low — 침묵을 나레이션으로 메우지 않는다
- cut_anchor: 가까워짐 / 경계의 순간 / 선택 / 직후
- 편집 교리: 덜어내기 — 이 장면은 긴장이 느리게 쌓인다, 반복만 덜고 전환점은 살린다

# Fixed Facts
- title / year: The Housemaid (2025)
- one-line premise: 고용주와 가정부 사이의 선이 무너지는 밤
- common misunderstanding to avoid:
  - 인물 이름은 대사에서 확인될 때만
  - 두 사람의 관계는 화면과 대사가 말한 만큼만 - 감정을 단정하지 않는다
- unknown or ambiguous points:
  - 자동자막 화자 구분 없음 - 화면 기준

# Recap Intent
- one-line recap goal: 돌이킬 수 없는 선을 넘는 밤의 긴장을 절제로 전달
- cold-open hook: 선을 넘기 직전의 대사 또는 침묵
- emotional tone:
  - forbidden tension
  - hesitation
  - point of no return
- viewer question to sustain: 이 선을 넘으면 무엇이 무너지는가
- preferred ending:
  - cliff
- title-hook note: 후킹 패턴 - forbidden/turning_point 계열

# Narration Rules
- narration should:
  - 국면 전환만 짚는다
- narration should not:
  - 관계·감정 단정 금지
  - 이후 전개 예고 금지

# Output Preference
- desired opening feel: 평범한 밤이 아니다
- desired midpoint feel: 물러설 수 있는 마지막 순간
- desired ending feel: 넘어버린 선
- pacing preference:
  - slow tension build
- viewer takeaway in one sentence: 어떤 선은, 넘는 순간 되돌아갈 곳이 사라진다
