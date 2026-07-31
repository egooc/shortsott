대상 영상: "It Has Been My Honor, My Friend": Charon's Last Words | John Wick: Chapter 4
영상 길이: 467초. 설명상 Marquis가 Charon을 죽이는 장면입니다. 생성 자막 사용 가능. Source

Copy---
skill: midform_recap
version: 1
source:
  url: "https://www.youtube.com/watch?v=OUfXQIaycPE"
  type: auto
output:
  target_length_sec: 120
  language: ko
  mode: production
  draft: capcut
profile:
  name: production
content_type: movie_midform_recap
analysis_mode: auto
editorial:
  pattern: auto
  scene_type: emotional_dialogue
  callback_required: true
  keep_dialogue_policy: preserve_high_value
  dialogue_unit_preference: micro_exchange
  narration_density: medium
  spoiler_boundary: clip_first
  fact_priority: clip_grounded
  opener_policy:
    strategy: auto
    prefer_cold_open_callback: true
    incident_first: true
quality:
  acceptance_gates: strict
  subtitle_limits:
    max_chars: 16
    max_units_per_segment: 5
  first_dialogue_max_sec: 5
  callback_window_sec: [18, 45]
  max_continuous_narration_sec: 20
  high_context_teaser_recovery_required: true
  rendered_speaker_color_match_required: true
  first_30_conflict_clarity_required: true
render:
  speaker_colors: true
  preview_frame_proof: true
  export_mp4: false
  audio_path_mode: absolute
  video_placement_mode: source_clips
runtime:
  resume_from: auto
  preserve_artifacts: true
  fail_on_gate_error: true
---

# Source
- clip_url: https://www.youtube.com/watch?v=OUfXQIaycPE
- target_length_sec: 120
- source_title: "It Has Been My Honor, My Friend": Charon's Last Words | John Wick: Chapter 4
- source_duration_sec: 467
- subtitle_language: en_generated

# Fixed Facts
- title_year: John Wick: Chapter 4 (2023)
- one_line_premise: 권력을 쥔 Marquis가 Continental을 정리하러 오고, 그 과정에서 Charon이 희생된다.
- scene_position: 질서 장악 선언과 처형을 통해 판을 바꾸는 압박 장면.
- verified_characters:
  - Charon: Continental 쪽 인물, 끝까지 품위를 유지하는 인물
  - Marquis Vincent de Gramont: 권력을 행사하는 압박자
  - Manager: 호텔 측 관리 인물
  - John Wick: 직접 현장 중심은 아니지만 사태 배경의 핵심 원인으로 계속 언급됨
- verified_events:
  - 호텔이 폐쇄/정리 대상으로 선언된다.
  - Marquis는 자신에게 강한 권한이 주어졌다고 말한다.
  - 질서와 규칙, 실패의 책임에 대한 대화가 이어진다.
  - Charon은 끝까지 태도를 유지한다.
  - Charon이 "It has been an honor, my friend"라고 말한 뒤 죽임을 당한다.
  - 장면은 존 윅 개인보다 더 큰 질서 징벌로 framing된다.
- common_misunderstandings_to_avoid:
  - 단순 총격 장면처럼 요약하지 말 것
  - Marquis를 즉흥적 분노형 빌런처럼만 축소하지 말 것
  - 이 장면의 핵심을 "죽음" 하나로만 처리하지 말 것
  - Charon의 마지막 태도를 과장된 영웅 대사로 바꾸지 말 것
- unknown_or_ambiguous_points:
  - generated transcript라 세부 철자/표현은 일부 오차 가능
  - 일부 인물명 표기는 클립 메타 기준 유지

# Recap Intent
- one_line_goal: 한 사람을 죽이는 장면이 아니라, 권력이 어떻게 예의와 규칙의 공간을 짓밟는지 보여주는 압박 장면으로 압축한다.
- cold_open_hook: "영광이었습니다, 친구여."
- emotional_tone: formal, cold, tragic, oppressive
- viewer_question: 왜 이 장면은 단순 처형보다 더 무겁게 느껴지는가
- first_20_sec_must_deliver:
  - Marquis가 질서 위에서 움직이는 인물이라는 점
  - Continental이 무너지는 상황이라는 점
  - Charon의 마지막이 단순 죽음이 아니라 메시지라는 점
- callback_payoff:
  - 오프닝의 마지막 인사가 본문에서는 체념이 아니라 품위와 충성의 끝이라는 점으로 회수
  - 개인 감정이 아니라 체계적 징벌의 결과였음을 연결
- preferred_ending: Charon의 마지막 이후 남는 침묵과 John Wick 쪽 감정 파장을 남기는 방식

# Must Keep
- key_conflict_axis: 권한 선언 → 질서/규칙 압박 → 책임 전가 → Charon 희생
- essential_dialogue:
  - 호텔이 끝났다는 선언 계열
  - 규칙과 결과에 대한 대화
  - "It has been an honor, my friend"
- essential_visual_events:
  - Continental이 더 이상 보호공간이 아니라는 선언 분위기
  - Marquis의 압박
  - Charon의 마지막 순간
- emotional_turn:
  - 제도적 정리 통보가 실제 희생으로 바뀌는 순간
- factual_anchor:
  - 이 장면은 존 윅 개인보다, 그를 둘러싼 세계의 질서 재편 압박을 보여주는 장면이다

# Dialogue Handling
- prioritize_KEEP_DIALOGUE_for:
  - Marquis의 권력 선언
  - 규칙/실패/책임을 말하는 대목
  - Charon의 마지막 한마디
- narration_use:
  - 질서 붕괴와 처형의 의미를 짧게 묶을 때만
  - 긴 설명 금지
- dialogue_sync_priority:
  - 느린 대사 장면이라 자막 후행이 특히 나쁘게 느껴질 수 있으므로 speech-aligned subtitle 유지
  - 감정 여운은 살리되 tail이 질질 끌리지 않게

# Narration Rules
- narration_style: restrained, sharp, heavy
- narration_goal:
  - 감정 과장 없이 무게만 전달
  - 제도적 폭력과 개인적 마지막 인사를 대비시킬 것
- avoid:
  - 지나친 시적 문장
  - 빌런 감상문 톤
  - 세계관 백과사전식 설명

# Scene-Type Guidance
- scene_type_focus: formal_power_to_personal_tragedy
- pacing_rule:
  - 초반은 선언과 분위기 장악
  - 중반은 규칙/책임 대화의 칼날 유지
  - 후반은 Charon의 마지막과 잔향으로 압축
- structure_preference:
  - cold open
  - context reset
  - authority escalation
  - personal cost payoff

# Prohibitions
- 존 윅 시리즈 전체 맥락을 과하게 끌어오지 말 것
- Charon의 심리를 클립 밖 설정으로 과잉 해석하지 말 것
- Marquis의 동기를 새로 만들어 붙이지 말 것
- 마지막 대사를 과장 번안하지 말 것
- 느린 장면이라고 내레이션으로 메우지 말 것
- 자막 밀도 과다 금지

# Output Preference
- opening_style: 마지막 인사 한 줄로 바로 잡아끄는 구조
- pacing: 느리되 무겁고 단단하게
- subtitle_style:
  - 짧고 차갑게
  - 존칭/품위 톤 유지
- ending_style: 마지막 인사의 여운이 남도록 정리
- viewer_takeaway: 이 장면은 죽음의 충격보다, 규칙의 세계가 어떻게 충성심까지 짓밟는지 보여주는 장면이다

# Optional Notes
- 추천 포지셔닝:
  - "총보다 무서운 건, 이 세계의 규칙이 사람을 처리하는 방식이었다"
- 운영 포인트:
  - emotional dialogue 계열 검증용 샘플로 적합
  - 자막 후행, pre-roll, tail trimming 과보정 여부 확인에 유리