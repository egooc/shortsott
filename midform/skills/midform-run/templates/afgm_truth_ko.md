---
profile: production
analysis_mode: auto
source:
  url: "https://www.youtube.com/watch?v=9FnO3igOkOk"
  content_type: movie_midform_recap
  promo_tail_sec: 30.5
output:
  target_length_sec: 75
review:
  pause_before_tts: true
subtitle_limits:
  max_chars: 16
tone: 법정에서 진실을 끌어내는 압박 심문의 리듬. 설명하지 말고 문답의 속도와 폭발이 긴장을 만들게 둔다
opener_policy: cold_open_callback
callback_required: true
spoiler_boundary: clip이 보여주는 범위 안에서만 전개하고, 이후 판결이나 결말을 설명하지 않는다
must_keep:
  - 핵심 축 - 증인 압박 → 문답 가속 → 진실 요구 → 폭발적 자백
  - 진실을 요구하는 문답 교환 전체 (You want answers / I want the truth / You can t handle the truth)
  - 자백이 터지는 순간의 대사
  - 판사의 제지와 법정 소란
prohibitions:
  - 검증되지 않은 인물 관계나 동기 날조 금지
  - clip 밖 사건이나 판결 확장 금지
  - 폭발 포인트를 나레이션이 앞질러 설명하는 것 금지
  - 감정을 이름 붙여 해석하는 나레이션 금지 - 누가 옳은지 판정하지 않는다
  - 인물 소개 나레이션 금지 - 계급과 위치는 대사와 화면으로만
  - 렌더 결과물의 speaker-color mismatch 금지
render:
  preview_frame_proof: true
  use_capcut_template: true
  audio_path_mode: absolute
  video_placement_mode: source_clips
---

# Source
- clip url: https://www.youtube.com/watch?v=9FnO3igOkOk
- target length: 75s (상한 - 클립 내부 아크가 길이를 정한다)
- title: You Can't Handle the Truth! - A Few Good Men (7/8) Movie CLIP (1992) HD
- source audio language: English
- subtitle source: YouTube English subtitles

# Editorial Preferences
- keep_dialogue_policy: preserve_scene_force — 문답 교환이 이 장면의 전부다. 진실 공방 대사는 거의 무조건 살린다
- dialogue_unit_preference: micro_exchange — 질문 + 답 + 반박의 짧은 공방. 한 슬롯에 대사를 몰지 않는다
- narration_density: low — 나레이션은 여닫는 이음매만. 법정 공방은 대사가 끌고 간다
- cut_anchor: 문답이 가속되는 순간 / 어조가 뒤집히는 순간 / 자백 / 판사의 제지
- 리듬 목표: 압박 → 문답 가속 → 진실 요구 → 폭발 → 자백 → 체포
- 편집 교리: 덜어내기 — 클립 내부 아크(심문→자백)만, 본편 사건 배경 설명은 뺀다

# Fixed Facts
- title / year: A Few Good Men (1992)
- one-line premise: 법정에서 젊은 군법무관이 대령을 압박해 명령 사실을 자백받는 장면
- scene position in story: 재판의 클라이맥스, 진실이 공개되는 순간
- common misunderstanding to avoid:
  - 명령의 이름(코드 레드)은 대사에 나올 때만 사용할 것
  - 계급·직책은 화면과 대사가 보여주는 만큼만
- unknown or ambiguous points:
  - 법정 소란 구간은 겹치는 발화로 큐 품질이 낮을 수 있음 - 확신 없는 줄은 나레이션으로 강등하지 말고 드롭

# Recap Intent
- one-line recap goal: 침착한 질문이 오만한 권력자를 폭발시켜 진실을 끌어내는 과정을 문답의 속도로 전달한다
- cold-open hook: 진실 공방의 정점 문답, 또는 자백 직전의 정적
- emotional tone:
  - escalating pressure
  - explosive
  - courtroom tension
- viewer question to sustain: 이 대령이 무엇을 자백하게 되는가
- what must be paid off by callback:
  - 초반의 압박 문답이 실제 자백으로 완성된다는 점
- preferred ending:
  - payoff
# Dialogue Handling
- preserve original dialogue when:
  - 진실을 요구하는 문답 교환
  - 자백이 터지는 순간
  - 판사의 제지와 명령
- bridge narration allowed when:
  - 심문의 국면이 바뀌어 한 문장 복구가 필요할 때만
- downgrade to narration when:
  - 사용하지 않는다 - 이 장면은 전부 대사다

# Narration Rules
- narration should:
  - 눈이 못 보는 것만 말한다: 심문의 국면 전환
  - 한 문장 한 아이디어, 짧게 끊어 읽힌다
- narration should not:
  - 인물을 소개하지 말 것
  - 폭발 포인트를 앞질러 설명하지 말 것
  - 누가 옳은지 판정하지 말 것

# Output Preference
- desired opening feel: 이 질문은 멈추지 않는다
- desired midpoint feel: 한쪽이 무너지기 시작한다
- desired ending feel: 진실은 터졌고, 대가가 남았다
- pacing preference:
  - fast
- viewer takeaway in one sentence: 진실을 감당하지 못한 건 질문자가 아니라 대답한 쪽이었다
