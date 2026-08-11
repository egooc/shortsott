---
profile: production
analysis_mode: auto
source:
  url: "https://www.youtube.com/watch?v=OUfXQIaycPE"
  content_type: movie_midform_recap
output:
  target_length_sec: 140
review:
  pause_before_tts: true
subtitle_limits:
  max_chars: 16
tone: 오래 함께한 사람들의 작별. 절제된 대사 사이의 침묵이 본체 - 나레이션은 그 침묵을 설명하지 않는다
opener_policy: cold_open_callback
spoiler_boundary: clip이 보여주는 범위 안에서만. 이후 전개·본편 결말 언급 금지
must_keep:
  - 핵심 축 - 이별의 예감 → 마지막 대화 → "It has been my honor, my friend" → 작별
  - 샤론과 윈스턴의 마지막 교환 원음 전량
  - 침묵과 표정의 간격 (나레이션으로 채우지 않는다)
prohibitions:
  - 죽음·희생의 절차적 묘사 금지 (노딱 안전 어휘 준수)
  - 검증되지 않은 과거사 날조 금지 - 두 사람의 세월은 대사와 표정이 말한 만큼만
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
- clip url: https://www.youtube.com/watch?v=OUfXQIaycPE
- target length: 140s (상한)
- title: "It Has Been My Honor, My Friend": Charon's Last Words | John Wick: Chapter 4
- source audio language: English
- subtitle source: 자동자막 (en) — 낮고 느린 대사, 게이트에서 프레임 대조
- speech density: 중간 추정 - 절제된 대화와 긴 침묵
- 유의: 액션 프랜차이즈지만 이 장면은 이별극 - 액션 파이 낮게 나올 것(측정 공식이 판단)

# Editorial Preferences
- keep_dialogue_policy: preserve_scene_force — 마지막 교환은 전량 원음
- dialogue_unit_preference: micro_exchange
- narration_density: low — 침묵 구간을 나레이션으로 메우지 않는다
- cut_anchor: 예감의 순간 / 마지막 대화 / 제목 대사 / 작별
- 편집 교리: 덜어내기 — 이 장면은 이미 느리다. 덜어낼 것은 반복이지 침묵이 아니다

# Fixed Facts
- title / year: John Wick: Chapter 4 (2023)
- one-line premise: 오랜 세월을 함께한 두 사람이 결전을 앞두고 나누는 마지막 인사
- common misunderstanding to avoid:
  - 인물 이름은 대사에서 들릴 때만
  - 두 사람의 관계는 화면과 대사가 말한 만큼만
- unknown or ambiguous points:
  - 자동자막 화자 구분 없음 - 화면 기준

# Recap Intent
- one-line recap goal: 말보다 큰 침묵의 작별을 원음 그대로 전달한다
- cold-open hook: 제목 대사 직전의 침묵 또는 제목 대사 자체
- emotional tone:
  - quiet farewell
  - dignity
  - foreboding
- viewer question to sustain: 이 인사가 왜 마지막인가
- preferred ending:
  - lingering silence
- title-hook note: 후킹 패턴 - last_words/farewell 계열 유력. 제목 대사가 소재

# Narration Rules
- narration should:
  - 상황의 무게만 짚고 물러난다
- narration should not:
  - 침묵 해설 금지
  - 판정·감정 명명 금지
  - 이후 전개 예고 금지

# Output Preference
- desired opening feel: 평소와 같은 인사, 평소와 다른 공기
- desired midpoint feel: 서로 알고 있는 사람들의 마지막 예의
- desired ending feel: 문이 닫힌 뒤에도 남는 것
- pacing preference:
  - slow and dignified
- viewer takeaway in one sentence: 어떤 작별은 총성보다 크다
