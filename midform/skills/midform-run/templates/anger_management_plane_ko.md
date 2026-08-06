---
profile: production
analysis_mode: auto
source:
  url: "https://www.youtube.com/watch?v=DzUc3Eqzzos"
  content_type: movie_midform_recap
output:
  target_length_sec: 90
tone: 아무 잘못 없는 남자가 점점 가해자로 몰리는 부조리의 리듬. 설명하지 말고 대사의 온도 차이가 웃음을 만들게 둔다
opener_policy: cold_open_callback
callback_required: true
spoiler_boundary: clip이 보여주는 범위 안에서만 전개하고, 이후 전개나 결말을 미리 설명하지 않는다
must_keep:
  - "핵심 축: 평범한 요청 → 사소한 오해 → 주변이 그를 위험인물로 단정 → 상황이 통제를 벗어남"
  - 그가 침착하게 말하는데 상대가 과잉 반응하는 순간의 대사
  - 진정하라는 말과 실제로 침착한 그의 대비가 드러나는 대사
  - 태도가 뒤집히는 순간(친절 → 위협, 억울 → 체념)
prohibitions:
  - 검증되지 않은 인물 관계나 동기 날조 금지
  - clip 밖 사건이나 결말 확장 금지
  - 웃음 포인트를 나레이션이 앞질러 설명하는 것 금지
  - 감정을 이름 붙여 해석하는 나레이션 금지
  - 인물 소개 나레이션 금지 — 관계와 위치는 대사와 장면으로만
  - 렌더 결과물의 speaker-color mismatch 금지
subtitle_limits:
  max_chars: 16
review:
  pause_before_tts: true
render:
  preview_frame_proof: true
  use_capcut_template: true
  audio_path_mode: absolute
  video_placement_mode: source_clips
---

# Source
- clip url: https://www.youtube.com/watch?v=DzUc3Eqzzos
- target length: 90s
- title: Anger Management (1/8) Movie CLIP - Rage on a Plane (2003) HD
- source audio language: English
- subtitle source: YouTube auto captions

# Editorial Preferences
- keep_dialogue_policy: preserve_scene_force — 온도 차이가 드러나는 대사는 거의 무조건 살린다. 침착한 요청과 과잉 반응의 대비가 이 장면의 전부다
- dialogue_unit_preference: micro_exchange — 한 줄 + 반응 + 한 줄의 짧은 공방. 한 슬롯에 대사를 몰지 않는다
- narration_density: low — 나레이션은 장면 이음매에만. 이 클립은 한 장소라 나레이션이 거의 필요 없다
- cut_anchor: 화자 전환 / 표정 반응 / 오해가 한 단계 커지는 순간 / 권위(승무원·보안관)가 개입하는 순간
- 리듬 목표: 발화 → 반응 → 발화 → 반응 → 발화 → payoff
- 첫 30초 안에 "그가 아무 잘못도 안 했다"는 게 대사로 읽혀야 한다

# Fixed Facts
- title / year: Anger Management (2003)
- one-line premise: 기내에서 조용히 있던 남자가 사소한 요청을 계기로 점점 난동꾼으로 몰리는 코미디 장면
- scene position in story: 사건의 발단이 되는 기내 구간
- common misunderstanding to avoid:
  - 그가 실제로 화를 낸 것처럼 서술하지 말 것 — 침착함과 주변의 과잉 반응의 대비가 핵심이다
  - transcript에 없는 인물 이름을 단정하지 말 것
- unknown or ambiguous points:
  - 자동자막이라 화자 구분이 불완전할 수 있으므로, 누가 말했는지 확실하지 않으면 화자를 단정하지 말 것

# Recap Intent
- one-line recap goal: 아무 잘못 없는 남자가 기내에서 위험인물이 되기까지의 과정을 대사의 온도 차이로 전달한다
- cold-open hook: 침착한 그에게 쏟아지는 과잉 반응, 또는 "진정하라"는 부조리한 한 마디
- emotional tone:
  - absurd
  - escalating
  - deadpan
- viewer question to sustain: 이 오해가 어디까지 커지는가
- what must be paid off by callback:
  - 초반의 사소한 요청이 후반의 결정적 사태로 이어진다는 점
- preferred ending:
  - cliff

# Dialogue Handling
- preserve original dialogue when:
  - 침착한 요청과 과잉 반응이 맞부딪히는 순간
  - "진정하라"류의 부조리한 대사가 나오는 순간
  - 권위가 개입해 상황이 한 단계 커지는 순간
- bridge narration allowed when:
  - 시간이 점프하거나 화면 밖 사건을 복구할 때만
- downgrade to narration when:
  - 자동자막 품질이 낮아 오해 소지가 큰 구간

# Narration Rules
- narration should:
  - 눈이 못 보는 것만 말한다: 시간 도약, 화면 밖 사건
  - 감정을 이름 붙이지 않고 상황만 짚는다
  - 한 문장 한 아이디어, 짧게 끊어 읽힌다
- narration should not:
  - 인물을 소개하지 말 것 — 누구인지는 시청자가 대사에서 읽는다
  - 웃음 포인트를 앞질러 설명하지 말 것
  - 그가 화났는지 아닌지를 나레이션이 판정하지 말 것 — 시청자가 판단하게 둔다

# Output Preference
- desired opening feel: "어? 이 사람 아무것도 안 했는데?"
- desired midpoint feel: 착하게 굴수록 더 몰린다
- desired ending feel: 이게 시작일 뿐이라는 예감
- pacing preference:
  - fast
- viewer takeaway in one sentence: 침착할수록 더 위험한 사람으로 보이는 부조리
