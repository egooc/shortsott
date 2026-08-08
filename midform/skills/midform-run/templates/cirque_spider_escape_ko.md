---
profile: production
analysis_mode: auto
source:
  url: "https://www.youtube.com/watch?v=KMN1hfNjdEc"
  content_type: movie_midform_recap
  promo_tail_sec: 20
output:
  target_length_sec: 110
review:
  pause_before_tts: true
subtitle_limits:
  max_chars: 16
tone: 학교라는 일상 공간에 맹독 거미가 풀려나는 크리처 서스펜스의 리듬. 설명하지 말고 정적과 비명의 낙차가 공포를 만들게 둔다
opener_policy: cold_open_callback
callback_required: true
spoiler_boundary: clip이 보여주는 범위 안에서만 전개하고, 이후 전개나 결말을 미리 설명하지 않는다
must_keep:
  - 핵심 축 - 몰래 숨겨둔 거미 확인 → 탈출 → 학교 안 추적과 정적 → 물림 → 창밖으로 사라짐
  - 거미가 사라진 걸 처음 알아채는 순간의 대사
  - 추적 중 서로 다그치거나 경고하는 순간의 대사
  - 물림 직후의 반응이 드러나는 대사나 비명
prohibitions:
  - 검증되지 않은 인물 관계나 동기 날조 금지
  - clip 밖 사건이나 결말 확장 금지 - 뱀파이어·서커스 등 본편 설정 언급 금지
  - 공포 포인트를 나레이션이 앞질러 설명하는 것 금지
  - 감정을 이름 붙여 해석하는 나레이션 금지
  - 인물 소개 나레이션 금지 - 관계와 위치는 대사와 장면으로만
  - 물림·상처의 절차적 묘사 금지 - 반응과 컷 전환으로만 (노딱 안전 어휘 준수)
  - 렌더 결과물의 speaker-color mismatch 금지
render:
  preview_frame_proof: true
  use_capcut_template: true
  audio_path_mode: absolute
  video_placement_mode: source_clips
---

# Source
- clip url: https://www.youtube.com/watch?v=KMN1hfNjdEc
- target length: 110s (상한 - 클립 내부 아크가 길이를 정한다)
- title: The Spider Escapes! | Cirque du Freak: The Vampire's Assistant | Fear
- source audio language: English
- subtitle source: YouTube auto captions
- 대체 업로드 경위: 사용자가 준 Movieclips판(BH7wnt7f7aM)은 자막이 전혀 없어 실행 불가. 같은 장면의 Fear 채널 풀버전(229s)으로 대체.

# Editorial Preferences
- keep_dialogue_policy: preserve_scene_force — 발견·경고·다그침·물림 반응의 대사는 거의 무조건 살린다
- dialogue_unit_preference: micro_exchange — 한 줄 + 반응 + 한 줄. 한 슬롯에 대사를 몰지 않는다
- narration_density: low — 나레이션은 장면 이음매에만. 추적과 정적은 원음이 끌고 간다
- cut_anchor: 거미가 사라진 걸 아는 순간 / 정적이 깨지는 순간 / 물림 / 창밖 탈출
- 리듬 목표: 은닉 → 발각 위기 → 탈출 → 추적과 정적 → 물림 → 사라짐
- 편집 교리: 덜어내기 — 클립 내부 아크(거미 탈출 소동)만 남기고, 본편(뱀파이어 서사)과 이어지는 파편은 뺀다

# Fixed Facts
- title / year: Cirque du Freak: The Vampire's Assistant (2009)
- one-line premise: 학교에 몰래 숨겨둔 맹독 거미가 탈출해 소동 끝에 한 학생이 물려 쓰러지는 장면
- scene position in story: 거미를 훔쳐온 직후, 위험이 학교라는 일상 공간으로 번지는 구간
- common misunderstanding to avoid:
  - 거미의 이름이나 출처는 대사에 나올 때만 사용할 것
  - 물린 학생과 주인공의 관계(친구 등)는 대사가 말할 때만 단정할 것
  - 본편의 뱀파이어·서커스 설정을 이 클립에 끌어오지 말 것 - 이 클립의 위협은 거미 한 마리다
- unknown or ambiguous points:
  - 자동자막이라 화자 구분이 불완전할 수 있으므로, 누가 말했는지 확실하지 않으면 화자를 단정하지 말 것
  - 소동·비명 구간은 큐 품질이 낮을 수 있음 - 확신 없는 줄은 나레이션으로 강등

# Recap Intent
- one-line recap goal: 숨겨둔 위험이 통제를 벗어나 일상을 무너뜨리는 과정을 정적과 낙차로 전달한다
- cold-open hook: 거미가 사라진 걸 깨닫는 순간, 또는 물림 직전의 정적
- emotional tone:
  - creeping dread
  - helpless panic
  - suburban horror
- viewer question to sustain: 저 거미가 누구에게 닿는가
- what must be paid off by callback:
  - 초반의 은닉·불안이 실제 사고로 현실이 된다는 점
- preferred ending:
  - cliff

# Dialogue Handling
- preserve original dialogue when:
  - 거미가 사라진 걸 처음 알아채는 순간
  - 추적 중 서로 경고하거나 다그치는 순간
  - 물림 직후의 반응
- bridge narration allowed when:
  - 장소가 바뀌어 한 문장 복구가 필요할 때만
- downgrade to narration when:
  - 비명과 겹쳐 자동자막 품질이 낮은 구간

# Narration Rules
- narration should:
  - 눈이 못 보는 것만 말한다: 시간 도약, 화면 밖 사건
  - 감정을 이름 붙이지 않고 상황만 짚는다
  - 한 문장 한 아이디어, 짧게 끊어 읽힌다
- narration should not:
  - 인물을 소개하지 말 것 - 누구인지는 시청자가 대사에서 읽는다
  - 공포 포인트를 앞질러 설명하지 말 것
  - 물림 결과를 의학적으로 단정하지 말 것 - 화면의 반응만

# Output Preference
- desired opening feel: 있어서는 안 될 것이, 있어서는 안 될 곳에
- desired midpoint feel: 아무도 모르는 사이에 가까워진다
- desired ending feel: 사라졌다고 끝난 게 아니라는 예감
- pacing preference:
  - slow-burn then spike
- viewer takeaway in one sentence: 위험은 숨긴 순간부터 이미 통제 밖이다
