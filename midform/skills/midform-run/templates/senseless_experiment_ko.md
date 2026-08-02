---
profile: production
analysis_mode: auto
source:
  url: "https://www.youtube.com/watch?v=cOnwFBs6HKg"
  content_type: movie_midform_recap
output:
  target_length_sec: 180
tone: 상황이 점점 통제를 벗어나는 코미디의 리듬을 살리되, 설명으로 웃음을 죽이지 않는 한국어 리캡 톤
opener_policy: cold_open_callback
callback_required: true
spoiler_boundary: clip이 보여주는 범위 안에서만 전개하고, 결말을 미리 설명하지 않는다
must_keep:
  - "핵심 축: 통제된 실험 → 감각이 하나씩 꺼짐 → 상황이 걷잡을 수 없어짐"
  - 감각이 사라진 순간 인물의 반응과 주변의 당황이 드러나는 대사
  - 상대가 상황을 알아채거나 부정하는 순간의 대사
  - 태도가 뒤집히는 순간(여유 → 당황, 또는 그 반대)
prohibitions:
  - 검증되지 않은 인물 관계나 동기 날조 금지
  - clip 밖 사건이나 결말 확장 금지
  - 웃음 포인트를 나레이션이 앞질러 설명하는 것 금지
  - 감정을 이름 붙여 해석하는 나레이션 금지
  - 가독성을 해치는 과장 자막 금지
  - 렌더 결과물의 speaker-color mismatch 금지
subtitle_limits:
  max_chars: 16
render:
  preview_frame_proof: true
  use_capcut_template: true
  audio_path_mode: absolute
  video_placement_mode: source_clips
---

# Source
- clip url: https://www.youtube.com/watch?v=cOnwFBs6HKg
- target length: 120s
- title: Senseless (1998) — He's Losing ALL His Senses
- source audio language: English
- subtitle source: YouTube auto captions

# Editorial Preferences
- keep_dialogue_policy: preserve_scene_force — 선언·반박·태도 전환·이름 호출·권력 역전 대사는 거의 무조건 살린다. 기준은 "요약 가능한가"가 아니라 "이 대사가 장면의 힘을 만드는가"
- dialogue_unit_preference: micro_exchange — 한 줄 + 반응 + 한 줄의 짧은 공방. 한 슬롯에 대사를 몰지 않는다
- narration_density: low — 설명으로 끌고 가지 않는다. 나레이션은 장면 복구용으로만 최소 투입
- cut_anchor: 화자 전환 / 표정 반응 / 감각이 꺼지는 순간 / 관계·주도권이 뒤집히는 순간. 실험 배경 설명이나 사건 정리 컷은 압축
- 리듬 목표: 발화 → 짧은 복구 → 발화 → 반응 → 짧은 복구 → 발화 → payoff
- 첫 30초 안에 "지금 무슨 상황인지"가 대사와 반응으로 읽혀야 한다

# Fixed Facts
- title / year: Senseless (1998)
- one-line premise: 감각을 강화하는 실험에 참여한 인물이, 통제를 벗어나 감각을 하나씩 잃어가는 코미디 장면
- scene position in story: 실험이 역효과를 내며 상황이 무너지기 시작하는 구간
- common misunderstanding to avoid:
  - 진지한 SF 스릴러처럼 설명하지 말 것 — 코미디다
  - transcript에 없는 실험의 원리나 후속 전개를 단정하지 말 것
  - 인물 관계를 추측해서 이름 붙이지 말 것
- unknown or ambiguous points:
  - 자동자막이라 화자 구분이 불완전할 수 있으므로, 누가 말했는지 확실하지 않으면 화자를 단정하지 말 것

# Recap Intent
- one-line recap goal: 통제되던 실험이 어느 순간부터 인물 혼자 감당 못 하는 사태로 번지는 과정을 리듬 있게 전달한다
- cold-open hook: 감각 하나가 꺼진 순간의 반응, 또는 상황을 부정하는 강한 한 마디
- emotional tone:
  - absurd
  - escalating
  - comedic panic
- viewer question to sustain: 이게 어디까지 망가지는가
- what must be paid off by callback:
  - 초반에 던진 대사나 태도가 후반에 실제로 그대로 벌어진다는 점
- preferred ending:
  - cliff

# Dialogue Handling
- preserve original dialogue when:
  - 감각이 꺼진 것을 인물이 처음 알아채는 순간
  - 상대가 상황을 부정하거나 되묻는 순간
  - 태도나 주도권이 뒤집히는 한 마디
- bridge narration allowed when:
  - 누가 누구인지, 지금 무엇을 하는 중인지 한 문장으로 복구할 때
  - 장면이 다른 상황으로 넘어갈 때
- downgrade to narration when:
  - 자동자막 품질이 낮아 오해 소지가 큰 구간

# Narration Rules
- narration should:
  - 장면이 이미 보여주는 것을 다시 말하지 않는다
  - 감정을 이름 붙이지 않고 상황만 짚는다
  - 한 문장 한 아이디어, 짧게 끊어 읽힌다
- narration should not:
  - 웃음 포인트를 앞질러 설명하지 말 것
  - 실험 설정을 길게 늘어놓지 말 것

# Output Preference
- desired opening feel: "어? 지금 뭐가 잘못됐는데?"
- desired midpoint feel: 한 번 무너지기 시작하니 계속 무너진다
- desired ending feel: 아직 끝이 아니라는 불안
- pacing preference:
  - fast
- viewer takeaway in one sentence: 통제하려 할수록 더 크게 망가지는 장면

# Optional Notes
- platform-specific note: 초반 3~5초는 설명보다 강한 반응이나 부정하는 대사가 훅으로 낫다
- speaker alias note: 자동자막 화자 구분이 불완전하므로 화자 색상 확인 필요
