# 기업 흥망(ko) 인계 — 10-19 초안

세션: rebuild-midform-baseline-recovery-e0 (소유주 지정 «기업흥망 채널»). 관리자 = 볼케이노 - HOME - 관리자.

**레인의 대리만족 한 문장(Z1):** 늘 곁에 있던 익숙한 물건 뒤에서 무엇이 무너지고 무엇이 남았는지 알게 되는, «그래서 그랬구나» 하는 뒤늦은 납득.
**ep01 해태의 대리만족:** 어릴 적 매일 먹던 과자는 그대로인데 그걸 만들던 회사만 사라진 까닭을, 어른이 되어 숫자 하나로 알아듣는 뒤늦은 납득.
— 원고 첫 70초(«홈런볼 만들던 그 회사는 … 왜 무너졌을까요?»)와 끝맺음(«포장지 뒤쪽의 회사 이름을 한번 보세요»)이 이 문장을 향한다(10-19 확인).

## 1. 상태 (10-19)

- 레인 확정: 소유주 «기업흥망 진행할거고 새채널»(10-19 13:37, 관리자 경유). §5 22 종결.
- 채널: 없음 → **새 채널 «갈림길 경제»**. 생성·전화 인증은 소유주 손. 소유주 체크리스트 항목에 **웜업 여부(업로드 전 5~7일 시청·좋아요, 결정 대기 §5 47 B1, 큰제로 Z10)**. 인증 전 업로드 금지(15분 넘는 영상·맞춤 썸네일).
- 시험편 ep01 = **해태**(관리자 승인). 대우는 기획해체론 등 생존 관료 관련 다툼이 커서 첫 편에서 뺐다. 동양은 레퍼런스(몰랐던 경제)가 이미 했다.
- 시험편 흐름: 완성 → 관리자에 4분 샘플(30MB 이하) → 소유주 화질 확인 → 채널 연결 → 업로드.

## 2. 근거 문서

- 발굴 카드 `docs/category-cards/2026-10-18-fifth-longform-lane.md`, 레퍼런스 `docs/category-cards/2026-10-18-ko-corp-reference.md`
- 사실 조사 `docs/category-cards/ko-corp-facts/해태그룹.md`·`대우그룹.md`·`동양그룹.md` — «미확인»은 원고에 쓰지 않는다
- 기획 가이드 1차(화면·제목) `docs/plans/2026-10-19-ko-corp-planning-guide.md`. 2차(원고 구조·K8 3질문)는 도구개발이 10-20 09시 자막 창 뒤에 채운다 → 나오면 ep01 원고 보정

## 3. 폴더 (D:/midform/ko-corp)

```
render/corp_render.py   조립기 — 연금 렌더러(ja-nenkin/render/nenkin_render.py) 판·시계를 import, 녹판·전용 판만 자체
render/ko_say.py        TTS 입력 숫자 → 한글 읽기(자막은 숫자 그대로)
tools/gen_images.py     img_prompts.json → img/*.png (GPT 창구, 동시 3)
ep01/script.txt         원고 — "## 장" · "@화면id" · 한 줄 한 문장
ep01/make_visuals.py    → visuals.json(화면id → 판)
ep01/img_prompts.json   장면 그림 지시(공통 화풍 _style + 장면별)
ep01/research/          GPT 사실 확인 질의·답
```

실행:
```
python -X utf8 ko-corp/render/corp_render.py ko-corp/ep01 --preview          # TTS 없이 정지 화면(preview/png)
python -X utf8 ko-corp/render/corp_render.py ko-corp/ep01 --tts-only         # 음성만
python -X utf8 ko-corp/render/corp_render.py ko-corp/ep01                    # 전체(관문: 렌더 락 없음 + 빈 메모리 8GB)
```

## 4. 화면 문법 (가이드 §2·§4)

- **그림 장면(pic)**: 손그림풍 생성 그림 한 장을 20~30초 천천히 당기거나 민다(ffmpeg). 인물은 이름 없는 일반인·단순한 얼굴. 실존 로고·포장·읽을 수 있는 글자 없음.
- **녹판(도식)**: 진녹색 바탕 하나로 고정, 왼쪽 위 한 줄 제목(`label`), 오른쪽 위 출처(`source`). 종류: year(연도 카드)·split(두 갈래)·org(조직도)·calendar(만기 달력)·chapter(장 제목, 그림 위) + 연금 판 cards·table·bars·list·flow.
- 자막: 아래 흰 글씨 한 줄(60px, 그림자). 장면 전환 분당 1회 안팎, 빠른 컷 없음.
- 음성: Supertonic ko F2, 속도 1.02, 문장 사이 0.45초. 숫자·연도·금액은 ko_say 로 한글 읽기 → **역전사 대조 필수**(ko TTS 시각 오독 10-19).
- 음량: 마지막에 scripts/loudnorm_final.normalize(−14 LUFS).

## 5. 원고 규칙

- 사실만. 기사·공시·법원 결정으로 확인된 것. 추정은 «~로 알려졌다/보도됐다».
- 실존 인물: 얼굴 0, 이름은 공개 기사 사실만, 평가 낱말(«무능» 류) 금지.
- 영업 중인 회사에 «몰락» 단정 금지. 현 해태제과식품 2026 회계 제재·거래정지 건은 다루지 않는다.
- 썸네일·제목에서 현 브랜드(홈런볼·부라보콘) 이름은 과거 법인을 가리키는 표현으로(«그 과자 회사가 사라진 이유» 식).
- 첫 문장 인사·«오늘은» 금지(카이안 K3), 제품 + 역설 한 줄로 연다.
- E-E-A-T(K7): 고유명사·전문 용어(어음·부도·화의·법정관리·출자전환·순차입금) 밀도 검수.
- 공개 설명란에 소스 URL 금지(관리자 10-19). 출처는 화면 작은 글씨로.
- 소수(«13.3» 등)는 Speechmatics ko 가 «133»으로 붙여 적는다(정치 ko 10-19 실측) → audit 불일치가 소수면 받아쓰기 형식부터 의심하고 귀로 확인. 가능하면 원고에서 반올림.

## 6. 업로드 관문 (연금과 동일)

포장 3묶음(제목·썸네일·키워드·태그·해시태그·설명 첫 두 줄·purpose) → `scripts/packages_gate.py`, 제목 첫 낱말 = 썸네일 큰 글씨 → 비공개 예약 → processingStatus 확인 → 태그 삽입 + yt_tags --gate → 공개 뒤 views_check(politics-hour import) 첫날 4h·매일.

## 6-1. 재부팅 인계 (10-20 07:00 메인 PC 재부팅)

상태(10-19 마감): 원고 v3(장면 73개·약 6,200자), 장면표·그림 27장·포장 3묶음·썸네일 3장 완료, 미리보기 눈 검사 끝(판 글씨·두 갈래 겹침 고침 dd796cc).
채널명 «갈림길 경제» 확정(문구 ko-corp/channel.md), 채널 생성은 소유주가 샘플을 본 뒤. TTS 는 정치 RENDERING.lock(일시정지·유지) 때문에 시작 전 —
대기 루프는 06:50 에 tools/stop_tts_0650.ps1 이 끈다. 밤에 락이 풀려 일부 합성됐으면 ep01/voice/ 에 장면별로 남아 이어 쓴다.

**10-19 밤 변경(관리자):** 07:00 재부팅 보류(릴스 먼저). 음성 73장면은 10-19 17:52 합성 끝, 대기 프로세스 없음.
재합성·렌더는 관리자 «릴스 끝» 알림을 받은 뒤 시작한다. 17시를 넘기면 조각을 저장하고 다음 날 이어 간다.

재개(13:00 창이자 관리자 «릴스 끝» 뒤, 연금JA 우선 — 락 없음·빈 메모리 8GB 확인 후):
```
python -X utf8 ko-corp/render/corp_render.py ko-corp/ep01 --tts-only     # ① 음성(약 20분)
python -X utf8 ko-corp/render/audit.py ko-corp/ep01                       # ② 역전사 대조 — 0불일치까지 원고 고쳐 ①②
python -X utf8 ko-corp/render/corp_render.py ko-corp/ep01                # ③ 렌더(약 2시간, 17시에 끊으면 다음 창에서 이어짐)
python -X utf8 ko-corp/tools/make_sample.py ko-corp/ep01                 # ④ 4구간 샘플(30MB 이하) → 관리자
```
길이: TTS 실측 뒤 20분에 모자라면 원고 보강(새 장면만 합성) — 후보는 research/a2.md 의 1997 그룹 연표·기아 인수 경과.

## 7. 남은 일 (10-19 기준)

1. GPT 사실 확인 답 받기 → 원고 대조·보강(13분 → 20분)
2. 그림 27장 완성 → 미리보기 눈 검사(실존 얼굴·글자·로고)
3. TTS → 역전사 대조 → 렌더(13~17시 창, 연금JA와 공유)
4. 4분 샘플 → 관리자
5. 포장 3묶음·썸네일(아는 제품 그림 + 상징 + 두 줄 큰 글씨, `scripts/thumb_compose.py`)
