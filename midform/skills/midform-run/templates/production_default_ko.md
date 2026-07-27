---
profile: production
source:
  url: https://youtu.be/REPLACE_ME
  content_type: movie_midform_recap
output:
  target_length_sec: 150
tone: 긴박하고 호기심을 끌되, 과설명은 피하는 한국어 리캡 톤
must_keep:
  - 초반 이해 가능한 accusation/rebuttal 또는 question/answer 교환
  - teaser 질문을 실제로 회수하는 callback 대사 또는 payoff 구간
prohibitions:
  - 검증되지 않은 인과, 의도, 관계 날조 금지
  - cold open에서 답을 먼저 말하는 설명형 도입 금지
  - closing을 사건 요약문처럼 길게 마무리하는 방식 금지
opener_policy:
  strategy: auto
  prefer_cold_open_callback: true
  incident_first: true
callback_required: true
subtitle_limits:
  max_chars: 16
  max_units_per_segment: 5
spoiler_boundary: teaser의 정답은 callback/payoff 이전 narration에서 먼저 풀지 않는다
render:
  preview_frame_proof: true
  preview_limit: 8
  use_capcut_template: true
  audio_path_mode: absolute
  video_placement_mode: source_clips
---

운영 기본 규칙:

- 별도 override가 없으면 이 템플릿을 표준 입력 계약으로 사용한다.
- 첫 30초 안에 갈등 축이 읽혀야 한다.
- confrontation 장면이면 cold_open_callback을 우선하되, scene type이 다르면 억지로 callback 구조를 강제하지 않는다.
- KEEP_DIALOGUE는 의미 보존이 우선이고, narration은 setup / consequence / interpretation만 맡긴다.
- narration caption은 짧고 끊어 읽히게 쓴다. 한 caption unit에 설명을 몰아넣지 않는다.
- bridge/context reset은 인물/상황을 이해시키되, teaser tension을 미리 해설하지 않는다.
- closing은 2~3 짧은 beat 이내로 정리하고, 다음 감정이나 위협의 여운 하나만 남긴다.

품질 우선순위:

1. acceptance gates 통과
2. subtitle readability 경고 최소화
3. speaker-color validation 유지
4. preview-frame proof에서 읽기 쉬운 caption 길이 유지
