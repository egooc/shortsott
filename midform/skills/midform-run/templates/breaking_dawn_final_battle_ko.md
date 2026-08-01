---
profile: production
analysis_mode: auto
source:
  url: "https://www.youtube.com/watch?v=MzY2tsuy9RE"
  content_type: movie_midform_recap
output:
  target_length_sec: 120
tone: urgent하고 violent한 전환의 충격을 살리되, 과설명 없이 escalation을 따라가는 한국어 리캡 톤
opener_policy: cold_open_callback
callback_required: true
spoiler_boundary: clip 근거(clip_first) 밖 정보로 스포일러를 확장하지 않으며, teaser의 정답은 callback/payoff 이전 narration에서 먼저 풀지 않는다
must_keep:
  - "핵심 갈등 축: 증거 제시/판단 불변 → 대치 붕괴 → 최종 전투 폭발"
  - "must-keep dialogue: “I have evidence...”"
  - "must-keep dialogue: “Even when you see, you still won't change your decision.”"
  - Jacob이 반복 호출되는 위기 포인트
  - 대치 분위기가 깨지고 전투가 시작되는 순간
  - Cullen 진영과 Volturi가 전면 충돌하는 스케일
  - 협상처럼 보이던 공기가 실제 전쟁으로 바뀌는 감정 전환
  - "factual anchor: 아이(Renesmee)가 위험하다는 판단/오해가 충돌의 직접 원인"
  - "factual anchor: Alice의 증거 제시 시도 직후에도 갈등은 멈추지 않음"
prohibitions:
  - 검증되지 않은 인물 관계 날조 금지
  - clip 밖 off-screen 사건 날조 금지
  - clip 근거를 넘어서는 가짜 인과 금지
  - clip이 명확히 뒷받침하지 않는 스포일러 확장 금지
  - 가독성을 해치는 과長 자막 금지
  - 렌더 결과물의 speaker-color mismatch 금지
  - 시청자 노출 자막에 debug tag 금지
  - recap 전체를 lore 설명으로 채우지 말 것
  - transcript 근거가 약한 구간에서 전투 결과를 단정하지 말 것
subtitle_limits:
  max_chars: 16
render:
  preview_frame_proof: true
  use_capcut_template: true
  audio_path_mode: absolute
  video_placement_mode: source_clips
---

# Source
- clip url: https://www.youtube.com/watch?v=MzY2tsuy9RE
- target length: 120s
- optional title: The Final Vampire Battle
- optional episode / scene name: Breaking Dawn Part 2 final battle
- optional language of source audio: English
- optional subtitle source: YouTube generated English transcript

# Editorial Preferences
- pattern: auto / scene_type: auto (본체는 action escalation)
- keep_dialogue_policy: preserve_scene_force — 선언·반박·태도 전환·이름 호출 경고·권력 역전 대사는 거의 무조건 살린다. 판단 기준은 "요약 가능한가"가 아니라 "이 대사가 장면의 힘을 만드는가"
- dialogue_unit_preference: micro_exchange — 긴 설명형 대사 블록보다 한 줄 + 반응 + 한 줄의 짧은 공방
- narration_density: low — 설명으로 끌고 가지 않는다. 나레이션은 장면 복구용으로만 최소 투입
- cut_anchor: speaker switch / 표정 반응 / 선언·반박 라인 / 관계 역전 순간. 사건 정리·배경 회수·설정 설명 컷은 압축
- fact_priority: clip_grounded
- rewrite_priority: clarity > rhythm > hook_strength > readability
- subtitle max lines: 2
- first dialogue는 5초 이내 등장
- callback window: 18~45초 구간에서 회수
- 연속 narration 20초 초과 금지
- high-context teaser는 회수(recovery) 필수
- 첫 30초 안에 갈등 축이 명확히 읽혀야 함

# Fixed Facts
- title / year: The Twilight Saga: Breaking Dawn - Part 2 (2012)
- one-line premise: Renesmee를 둘러싼 오해로 인해 Cullen 진영과 Volturi가 정면 충돌하는 최종 대치 장면
- scene position in story: 영화 후반부 클라이맥스급 최종 전투/대치 장면
- verified characters:
  - name: Alice
    role: Cullen 측 핵심 인물
    relationship note: Volturi에게 child risk가 아니라는 증거를 보여주려는 쪽
  - name: Bella Swan
    role: Cullen 진영 인물
    relationship note: 가족과 아이를 지키는 중심 인물 중 하나
  - name: Edward Cullen
    role: Cullen 진영 인물
    relationship note: Bella와 함께 Renesmee를 지키는 쪽
  - name: Renesmee
    role: 보호 대상 아이
    relationship note: Volturi 충돌의 직접적 원인으로 지목되는 존재
  - name: Jacob Black
    role: Cullen 측 협력 진영
    relationship note: 전투 구간에서 이름이 직접 반복 호출되는 핵심 위험 포인트가 있음
  - name: Volturi
    role: 대치 상대 세력
    relationship note: 아이가 위험이 될 수 있다는 판단 아래 대결을 밀어붙이는 진영
- verified events:
  - Alice가 아이가 위험하지 않다는 증거가 있다고 말한다
  - 상대는 그 증거를 봐도 판단을 바꾸지 않을 거라는 반응이 나온다
  - 전투가 실제로 시작된다
  - 전투 도중 여러 인물들이 큰 타격을 입는 듯한 장면이 이어진다
  - Jacob의 이름이 반복 호출되는 위기 구간이 있다
  - 전체 장면은 대치에서 전면 충돌로 급격히 전환된다
- common misunderstanding to avoid:
  - 초반의 말 몇 줄만 보고 협상 장면처럼 설명하지 말 것
  - 전투가 단순 난전이라고만 뭉개지 말 것
  - clip 바깥 정보로 캐릭터의 미래/정체/후속 반전까지 과하게 설명하지 말 것
  - transcript에 없는 세부 전투 결과를 단정적으로 늘리지 말 것
- unknown or ambiguous points:
  - generated transcript가 드문드문 비어 있으므로, 개별 타격/사망/정확한 전개를 자막만으로 단정하지 말 것
  - 시각 정보 없이 판단이 흔들리는 순간은 과한 서술 대신 중립적으로 처리할 것

# Recap Intent
- one-line recap goal: “증거로 끝낼 줄 알았던 대치가 순식간에 피 튀기는 최종 전투로 폭발한다”는 감각을 강하게 전달한다
- cold-open hook: 증거를 보여주겠다는 말이 끝나자마자, 이 싸움은 멈추는 대신 진짜 전쟁으로 바뀐다
- emotional tone:
  - urgent
  - violent
  - shocking
  - escalating
- viewer question to sustain: 이 장면이 단순 협상 결렬이 아니라 왜 이렇게까지 처절한 최종 전투로 폭발했는가
- what must be understood within first 20 seconds:
  - 이 충돌은 아이를 둘러싼 판단에서 시작됐고
  - 상대는 증거를 봐도 물러서지 않으며
  - 그래서 말로 끝날 상황이 실제 전투로 넘어간다는 점
- what must be paid off by callback:
  - 초반의 “증거”와 “판단을 안 바꾼다”는 말이 실제 전면전의 신호였다는 점
  - 이 장면의 핵심이 단순 액션이 아니라 협상 실패 이후 폭발이라는 점
- preferred ending:
  - cliff

# Dialogue Handling
- preserve original dialogue when:
  - 충돌의 이유를 짧게 압축해 보여주는 라인일 때
  - 전투 전환의 의미를 바꾸는 핵심 대사일 때
  - 이름 호출이나 경고가 장면 긴장을 크게 올릴 때
- bridge narration allowed when:
  - 초반 협상 구간과 전투 구간을 짧게 연결해야 할 때
  - generated transcript만으로는 장면 의미가 끊기는 경우
  - 누가 누구와 맞서는지 빠르게 복구해야 할 때
- downgrade to narration when:
  - 대사 단독으로는 문맥이 약할 때
  - 액션 장면인데 자막으로 정보량만 과하게 늘어날 때
  - generated transcript 품질이 낮아 오해 가능성이 큰 경우

# Narration Rules
- narration style:
  - direct
  - compressed
  - cinematic
  - easy to follow
- narration should:
  - 초반엔 “협상 실패 직전의 대치”라는 맥락을 짧게 잡아줘야 한다
  - 이후엔 전투 스케일과 충격 전환을 우선해야 한다
  - 세부 액션을 다 설명하려 하지 말고 큰 감정축과 전환축을 따라가야 한다
  - generated transcript의 빈 구간은 과장 없이 중립적으로 메워야 한다
- narration should not:
  - 싸움 디테일을 과도하게 invented 하지 말 것
  - 누가 정확히 어떻게 끝났는지 clip-grounded evidence 없이 단정하지 말 것
  - lore 설명으로 전투의 긴장감을 죽이지 말 것
  - 인물 소개를 길게 늘어놓지 말 것

# Scene-Type Guidance
- if confrontation:
  - 초반 대사 몇 줄은 confrontation처럼 처리할 수 있지만, 전체 장면을 대사 충돌 위주로만 설명하지 말 것
- if reveal:
  - “증거를 보여주겠다”와 “그래도 안 바뀐다”는 부분은 reveal-like hook으로 사용 가능
- if action escalation:
  - 이 장면의 본체는 action escalation이다
  - 초반 설명은 최소화하고 전투 전환과 위기 포인트를 중심으로 끌고 가야 한다
  - 텍스트보다 화면 에너지와 전환 감각을 살리는 편집을 우선한다

# Output Preference
- desired opening feel: “증거로 끝날 줄 알았는데 갑자기 전쟁이 열린다”는 충격
- desired midpoint feel: 누가 밀리고 있는지보다 ‘이 싸움이 얼마나 처절한지’가 먼저 와닿는 느낌
- desired ending feel: 큰 위기 한가운데서 끊기는 불안감
- pacing preference:
  - fast
- viewer takeaway in one sentence: 이 장면의 핵심은 최종 전투 그 자체보다, 말로 끝낼 마지막 기회가 무너진 직후 전쟁이 터졌다는 점이다

# Optional Notes
- franchise / film context note: Twilight 시리즈 후반부 클라이맥스 성격이 강한 장면
- platform-specific note: 초반 3~5초는 “증거”보다 “그래도 판단을 안 바꾼다” 쪽이 훅으로 더 셀 수 있다
- pronunciation note: Renesmee / Volturi / Jacob 표기 통일 필요
- title localization note: “최종 뱀파이어 전투”보다 “증거도 못 막은 최후의 전쟁” 계열이 클릭 훅에 유리할 수 있음
- speaker alias note: Alice, Jacob, Bella, Edward, Volturi 계열 alias/color 확인 필요
- anything the generator must respect:
  - 초반은 대치, 본체는 전투
  - generated transcript 약한 구간은 과장하지 말고 큰 전환축 중심으로 정리
  - 업로드용 결과는 완벽 요약보다 충격감과 가독성을 우선
