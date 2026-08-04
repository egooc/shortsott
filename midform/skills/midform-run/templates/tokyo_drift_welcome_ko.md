---
profile: production
analysis_mode: auto
source:
  url: "https://youtu.be/pbYMReX2ci4"
  content_type: movie_midform_recap
output:
  target_length_sec: 180
tone: 낯선 도시에 던져진 주인공이 새로운 세계의 규칙을 몸으로 배우는 리듬. 설명하지 말고 장면의 속도감과 문화 충돌을 그대로 태운다
opener_policy: cold_open_callback
callback_required: true
spoiler_boundary: clip이 보여주는 범위 안에서만 전개하고, 이후 전개나 결말을 미리 설명하지 않는다
must_keep:
  - "핵심 축: 낯선 도시 도착 → 새로운 세계(드리프트 문화)와의 첫 대면 → 주인공의 위치가 정해지는 순간"
  - 주인공이 무시당하거나 시험당하는 순간의 대사
  - 새로운 세계의 규칙이 대사로 드러나는 순간
  - 태도가 뒤집히는 순간(여유 → 당황, 무시 → 도발)
prohibitions:
  - 검증되지 않은 인물 관계나 동기 날조 금지
  - clip 밖 사건이나 결말 확장 금지
  - 자동차·드리프트 용어를 나레이션이 장황하게 설명하는 것 금지
  - 감정을 이름 붙여 해석하는 나레이션 금지
  - 인물 소개 나레이션 금지 — 관계와 위치는 대사와 장면으로만
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
- clip url: https://youtu.be/pbYMReX2ci4
- target length: 180s
- title: The Fast and The Furious - Tokyo Drift: Welcome to Tokyo
- source audio language: English
- subtitle source: YouTube auto captions

# Editorial Preferences
- keep_dialogue_policy: preserve_scene_force — 도발·시험·무시·규칙 선언 대사는 거의 무조건 살린다. 기준은 "이 대사가 장면의 힘을 만드는가"
- dialogue_unit_preference: micro_exchange — 한 줄 + 반응 + 한 줄의 짧은 공방. 한 슬롯에 대사를 몰지 않는다
- narration_density: low — 나레이션은 장면 이음매(장소 이동, 시간 도약)에만. 인물 소개와 문화 설명 금지
- cut_anchor: 화자 전환 / 표정 반응 / 주인공이 시험당하는 순간 / 서열이 드러나는 순간. 풍경·이동 컷은 압축
- 리듬 목표: 발화 → 짧은 복구 → 발화 → 반응 → 짧은 복구 → 발화 → payoff
- 첫 30초 안에 "주인공이 어떤 상황에 던져졌는지"가 대사와 반응으로 읽혀야 한다

# Fixed Facts
- title / year: The Fast and the Furious: Tokyo Drift (2006)
- one-line premise: 미국에서 사고를 치고 도쿄로 온 고등학생이, 도착하자마자 낯선 드리프트 레이싱 세계와 마주하는 구간
- scene position in story: 주인공의 도쿄 도착과 새로운 세계 진입부
- common misunderstanding to avoid:
  - transcript에 없는 인물 이름이나 서열을 단정하지 말 것
  - 드리프트 문화를 다큐멘터리처럼 해설하지 말 것
- unknown or ambiguous points:
  - 자동자막이라 화자 구분이 불완전할 수 있으므로, 누가 말했는지 확실하지 않으면 화자를 단정하지 말 것
  - 이 클립이 정확히 어느 장면들을 포함하는지는 transcript 기준으로만 판단할 것

# Recap Intent
- one-line recap goal: 낯선 도시에 던져진 주인공이 새로운 세계의 규칙 앞에서 어떤 위치에 서게 되는지를 리듬 있게 전달한다
- cold-open hook: 주인공이 시험당하거나 무시당하는 강한 한 마디, 또는 새로운 세계의 규칙이 선언되는 순간
- emotional tone:
  - displaced
  - charged
  - rising tension
- viewer question to sustain: 이 낯선 세계에서 주인공은 어디까지 밀려나고 어디서 되받아치는가
- what must be paid off by callback:
  - 초반에 던진 대사나 태도가 후반에 실제로 그대로 벌어진다는 점
- preferred ending:
  - cliff

# Dialogue Handling
- preserve original dialogue when:
  - 주인공이 시험당하거나 도발당하는 순간
  - 새로운 세계의 규칙·서열이 대사로 선언되는 순간
  - 태도나 주도권이 뒤집히는 한 마디
- bridge narration allowed when:
  - 장소나 시간이 바뀌어 한 문장으로 복구가 필요할 때
- downgrade to narration when:
  - 자동자막 품질이 낮아 오해 소지가 큰 구간

# Narration Rules
- narration should:
  - 눈이 못 보는 것만 말한다: 시간 도약, 장소 이동, 화면 밖 사건
  - 감정을 이름 붙이지 않고 상황만 짚는다
  - 한 문장 한 아이디어, 짧게 끊어 읽힌다
- narration should not:
  - 인물을 소개하지 말 것 — 누구인지는 시청자가 대사에서 읽는다
  - 드리프트나 일본 문화를 해설하지 말 것
  - 웃음이나 긴장 포인트를 앞질러 설명하지 말 것

# Output Preference
- desired opening feel: "여긴 규칙이 다르다"
- desired midpoint feel: 주인공이 계속 밀리는데 물러서지는 않는다
- desired ending feel: 이제 시작이라는 예감
- pacing preference:
  - fast
- viewer takeaway in one sentence: 낯선 세계에 던져진 순간, 실력을 증명하기 전까지 아무도 너를 인정하지 않는다
