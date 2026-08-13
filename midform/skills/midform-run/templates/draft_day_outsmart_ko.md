---
profile: production
analysis_mode: auto
source:
  url: "https://www.youtube.com/watch?v=NlNUM5YctEo"
  content_type: movie_midform_recap
output:
  target_length_sec: 130
review:
  pause_before_tts: true
subtitle_limits:
  max_chars: 16
tone: 드래프트 당일 전화 한 통으로 판을 뒤집는 협상극. 리듬은 대사가 만들고 나레이션은 판 전환만 짚는다
opener_policy: cold_open_callback
spoiler_boundary: clip이 보여주는 범위 안에서만. 이후 드래프트 결과·다른 픽 언급 금지
must_keep:
  - 핵심 축 - 불리한 위치 → 전화 협상 → 상대의 허를 찌름 → 주도권 역전
  - 소니의 결정적 협상 대사(픽 교환 조건)
  - 상대 GM들의 반응 대사
prohibitions:
  - 검증되지 않은 인물 관계·동기 날조 금지
  - clip 밖 사건이나 실제 NFL 드래프트 결과 확장 금지
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
- clip url: https://www.youtube.com/watch?v=NlNUM5YctEo
- target length: 130s (상한)
- title: Sonny Weaver Outsmarts Every GM in the Room (Kevin Costner) | Draft Day
- source audio language: English
- subtitle source: 자동자막 (en) — 빠른 협상 대사·전화 통화, 큐 뭉침 주의, 게이트 프레임 대조
- speech density: 매우 높음 추정 - 전화 협상 대화극 (NYSM/Anger 유형)
- 케이스북 대조: 대사 밀집 - 자막 대사 훅, 러닝 개그/반복 협상 리듬 보존

# Editorial Preferences
- keep_dialogue_policy: preserve_scene_force — 협상의 핵심 조건 교환은 무조건 원음
- dialogue_unit_preference: micro_exchange
- narration_density: low — 여닫는 이음매 + 판 전환만
- cut_anchor: 불리한 상황 / 첫 협상 전화 / 조건 역전 / 주도권 확보
- 편집 교리: 덜어내기 — 협상의 반복을 덜고 판이 뒤집히는 순간만

# Fixed Facts
- title / year: Draft Day (2014)
- one-line premise: NFL 드래프트 당일, 불리한 위치의 단장이 전화 협상으로 판을 뒤집는 장면
- common misunderstanding to avoid:
  - 인물 이름·팀은 대사에서 들릴 때만
  - 스포츠/드래프트 전문 용어는 시청자가 몰라도 이해되게 (조건 교환의 긴장만 전달)
- unknown or ambiguous points:
  - 자동자막 화자 구분 없음 - 화면(전화 상대 컷백)으로 화자 판단

# Recap Intent
- one-line recap goal: 전화 한 통으로 주도권이 뒤집히는 협상의 쾌감을 대사 리듬으로 전달
- cold-open hook: 가장 대담한 협상 조건 제시 대사
- emotional tone:
  - high-stakes negotiation
  - underdog leverage
  - reversal
- viewer question to sustain: 불리한 그가 어떻게 판을 뒤집는가
- preferred ending:
  - power secured
- title-hook note: 후킹 패턴 - underdog/reversal/outsmart 계열

# Narration Rules
- narration should:
  - 협상 국면의 전환만 짚는다
- narration should not:
  - 협상 결과를 앞질러 말하지 말 것
  - 판정·감정 명명 금지

# Output Preference
- desired opening feel: 벼랑 끝에 몰린 단장
- desired midpoint feel: 전화기 너머로 판이 움직인다
- desired ending feel: 방 안 모두를 이긴 한 사람
- pacing preference:
  - rapid negotiation rhythm
- viewer takeaway in one sentence: 카드가 나빠도, 배짱과 수읽기가 판을 뒤집는다
