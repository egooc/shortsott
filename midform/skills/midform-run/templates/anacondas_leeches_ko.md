---
profile: production
analysis_mode: auto
source:
  url: "https://www.youtube.com/watch?v=lX9SDbhnYYU"
  content_type: movie_midform_recap
output:
  target_length_sec: 75
review:
  pause_before_tts: true
subtitle_limits:
  max_chars: 16
tone: 정글 한복판에서 상황이 한순간에 뒤집히는 크리처 호러의 리듬. 설명하지 말고 비명과 반응이 공포를 만들게 둔다
opener_policy: cold_open_callback
callback_required: true
spoiler_boundary: clip이 보여주는 범위 안에서만 전개하고, 이후 전개나 결말을 미리 설명하지 않는다
must_keep:
  - 핵심 축 - 평온한 이동 → 이상 징후 발견 → 습격 → 필사의 탈출
  - 위험을 처음 알아채는 순간의 대사
  - 서로에게 소리치며 상황이 무너지는 순간의 대사
  - 태도가 뒤집히는 순간(여유 → 공포)
prohibitions:
  - 검증되지 않은 인물 관계나 동기 날조 금지
  - clip 밖 사건이나 결말 확장 금지
  - 공포 포인트를 나레이션이 앞질러 설명하는 것 금지
  - 감정을 이름 붙여 해석하는 나레이션 금지
  - 인물 소개 나레이션 금지 — 관계와 위치는 대사와 장면으로만
  - 상처·출혈의 절차적 묘사 금지 — 반응과 컷 전환으로만 (노딱 안전 어휘 준수)
  - 렌더 결과물의 speaker-color mismatch 금지
render:
  preview_frame_proof: true
  use_capcut_template: true
  audio_path_mode: absolute
  video_placement_mode: source_clips
---

# Source
- clip url: https://www.youtube.com/watch?v=lX9SDbhnYYU
- target length: 75s
- title: Anacondas 2 (2004) - Bloodsucking Leeches Scene (2/10) | Movieclips
- source audio language: English
- subtitle source: YouTube auto captions

# Editorial Preferences
- keep_dialogue_policy: preserve_scene_force — 위험 감지·경고·비명 섞인 외침은 거의 무조건 살린다. 반응이 이 장면의 전부다
- dialogue_unit_preference: micro_exchange — 한 줄 + 반응 + 한 줄. 한 슬롯에 대사를 몰지 않는다
- narration_density: low — 나레이션은 장면 이음매에만. 습격 장면은 원음과 대사가 끌고 간다
- cut_anchor: 화자 전환 / 이상 징후를 처음 보는 표정 / 습격이 시작되는 순간 / 물속·물 밖 전환
- 리듬 목표: 평온 → 징후 → 발화 → 반응 → 습격 → 필사 탈출
- 첫 30초 안에 "뭔가 잘못되고 있다"가 대사와 반응으로 읽혀야 한다

# Fixed Facts
- title / year: Anacondas: The Hunt for the Blood Orchid (2004)
- one-line premise: 정글 탐사대가 강을 건너던 중 거머리 떼의 습격을 받는 장면
- scene position in story: 탐사 초반, 정글의 위험이 처음 실체를 드러내는 구간
- common misunderstanding to avoid:
  - transcript에 없는 인물 이름이나 서열을 단정하지 말 것
  - 아나콘다 본편 전개를 이 장면에 끌어오지 말 것 — 이 clip의 위협은 거머리다
- unknown or ambiguous points:
  - 자동자막이라 화자 구분이 불완전할 수 있으므로, 누가 말했는지 확실하지 않으면 화자를 단정하지 말 것
  - 비명·겹치는 외침은 큐 품질이 낮을 수 있음 — 확신 없는 줄은 나레이션으로 강등

# Recap Intent
- one-line recap goal: 평온하던 도강이 몇 초 만에 아비규환이 되는 과정을 반응의 온도로 전달한다
- cold-open hook: 위험을 처음 알아챈 순간의 외침, 또는 습격 직전의 이상한 정적
- emotional tone:
  - creeping dread
  - sudden panic
  - visceral
- viewer question to sustain: 누가 어떤 대가를 치르고 빠져나오는가
- what must be paid off by callback:
  - 초반의 징후나 경고가 실제 습격으로 현실이 된다는 점
- preferred ending:
  - cliff

# Dialogue Handling
- preserve original dialogue when:
  - 이상 징후를 처음 알아채고 알리는 순간
  - 서로를 부르며 탈출을 다그치는 순간
  - 습격의 실체가 드러나는 순간의 외침
- bridge narration allowed when:
  - 장소·시간이 바뀌어 한 문장 복구가 필요할 때만
- downgrade to narration when:
  - 비명과 겹쳐 자동자막 품질이 낮은 구간

# Narration Rules
- narration should:
  - 눈이 못 보는 것만 말한다: 시간 도약, 화면 밖 사건
  - 감정을 이름 붙이지 않고 상황만 짚는다
  - 한 문장 한 아이디어, 짧게 끊어 읽힌다
- narration should not:
  - 인물을 소개하지 말 것 — 누구인지는 시청자가 대사에서 읽는다
  - 공포 포인트를 앞질러 설명하지 말 것
  - 상처와 출혈을 절차적으로 묘사하지 말 것 — 반응과 컷 전환으로 처리

# Output Preference
- desired opening feel: 뭔가 이상하다, 지금
- desired midpoint feel: 한 번 시작되니 걷잡을 수 없다
- desired ending feel: 아직 정글은 시작도 안 했다는 예감
- pacing preference:
  - fast
- viewer takeaway in one sentence: 정글에서 진짜 무서운 건 큰 놈이 아니라 보이지 않는 작은 놈들이다
