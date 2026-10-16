# politics-hour 안에서 ko 전용으로 박힌 곳 (정치 키트 일반화용) · 2026-10-16

> 보낸 곳: 정치 ko(쟁점브리핑) 19:50 보고. 정본은 `D:/midform/politics-hour`. 값·키는 뺐고 파일 경로와 설정 이름만 적었다.
> 쓰는 곳: 도구개발(정치 템플릿 키트 — ko/JA 공용 뼈대 + 언어별 설정 분리), 정치JA(자기 조립기 `politics-hour-ja/render/ja_render.py`와 대조). ko 파일은 정치 ko만 고친다.

| 영역 | ko 전용으로 박힌 위치 | 키트에서 분리할 것 |
|---|---|---|
| 글꼴 | `assets/fonts/` Paperlogy-8ExtraBold·ROKAFSansMedium·SBAggroB·BMYEONSUNG(한글 전용). 쓰는 곳: `overlay/narration_overlay.py`·`quote_overlay.py`·`cold_overlay.py`·`chrome.py`의 @font-face(Paper/Body/Aggro/Hand), `overlay/motion.py` FONT_BODY·FONT_PAPER, `shorts/briefing_render.py` CSS | 글꼴 역할명(Paper/Body/Aggro/Hand) → 언어별 파일 매핑. JA는 Noto JP 계열(정치JA `assets/fonts`) |
| 목소리·언어 | `overlay/config.py` SUPERTONIC.voice(F2)·speed·gap, `overlay/supertonic_worker.py` tts(..., 'ko', ...), `overlay/tts.py` chunks()(22자 나누기·문장 분리 정규식 [.!?])·google GOOGLE_VOICE | 언어 코드·문장 분리 규칙(JA는 。！？·「」)·조각 길이·목소리 ID 를 설정으로 |
| 당 색표 | `episodes/<날짜>/common.py` COLOR(A 여당·B 국민의힘·P 시사 스피커·N 무소속) + docstring | 진영 틀(frames JSON: ours/other/third)에서 색을 끌어오게 |
| 화면 문구 | `overlay/chrome.py` brand('쟁점 브리핑')·'NEWS' 라벨·#follow(후속)·ticker; `episodes/<날짜>/build_episode.py` chrome.brand·date·ticker, 인트로·아웃트로 text(«쟁점 브리핑입니다…»), TITLES, COLD_OPEN.phrases | 브랜드·라벨·인트로/아웃트로 문구를 언어 파일로 |
| 화면 유형 이름표 | `overlay/narration_overlay.py` visual type(issue·facts·timeline·versus·number·followup·bridge) 안 한글 라벨('정리', '이것부터 확인합니다'는 원고 쪽 문자열) | type 키는 공용, 라벨만 언어 파일 |
| 출처 표기 | 원고·issues JSON의 source(«영상: 채널 날짜»), BROLL_SOURCE | JA는 官邸 PDL 표기 «出典：首相官邸ホームページ…を加工して作成» 등 권리별 형식 |
| 썸네일 | `episodes/<날짜>/thumb/make_thumb.py`(글꼴·노랑 반응 글자·칩 문구); 규칙은 메모리 politics-thumbnail-less-text | 글꼴·칩 문구 분리, A/B style 태그 유지 |
| 메타 | `episodes/<날짜>/make_meta.py` 제목 틀(«\| 국정감사 쟁점 브리핑 MM.DD»)·설명란 머리말 «■ 인용 영상 출처/■ 참고 보도»·면책 문구, upload.json defaultLanguage 'ko'·categoryId 25·tags | 제목 틀·머리말·면책·언어·태그를 언어 파일로. JA 제목 16~30자 |
| 쇼츠 | `shorts/briefing_render.py`(#title·.cap·.fl 말풍선·safe-zone 수치), `scripts/shorts_safe.py --tpl`(1080x1920 공용, 언어 무관) | shorts_safe는 그대로 공용 |
| 사실확인 | `episodes/<날짜>/factcheck/make_prompts.py` HEAD(한국어 프롬프트·«국민의힘 전체 일반화» 등 ko 금지 규칙) | 프롬프트 머리·금지 규칙을 진영 틀/언어별로 (JA는 명예훼손 3요건) |
| 업로드·태그 | `scripts/yt-upload.js --purpose politics`, `politics-hour/yt_tags.js`(purpose 'politics' 고정) | **JA는 purpose 분리(예: politics_ja)** — 채널 토큰이 다르다 |
| 렌더 표시 | `politics-hour/render_episode.py` RENDERING.lock | JA는 `politics-hour-ja/RENDERING-ja.lock` 그대로. 두 락 다 보고 한 편씩 |

## 메모
- 정치JA는 10-16 첫 편을 ko 코드 복제 없이 자기 조립기(`ja_render.py`, 하이퍼프레임 0.8.140+ffmpeg)로 렌더했다. 키트는 «둘의 공통 뼈대»를 뽑는 작업이지, JA에 ko 코드를 심는 작업이 아니다(소유주 10-16: ko 템플릿과 다르게).
- 공유 scripts(`silence_gap.py`·`title_lint`·`shorts_safe.py`·`ja_politics_script_check.py`)는 이미 언어 무관 또는 `--lane` 분기.
