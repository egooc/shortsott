# window 호출 400초 영상 첨부 + LOW 조사 (읽기 전용) — 및 간격-8초 재실행 결과

작성일: 2026-07-21

코드 원문 + job 로그(job_20260721123827 진단배치 / job_20260721143932 간격-8초 재실행) 인용.

## 결론 (사용자 결정트리 갱신)

- **간격 8초만으로는 완주 못 함** (재실행 여전히 429).
- **하지만 원인은 video-window가 아님**: 이 배치들에서 window 호출은 **후보 재사용
  (text-only, video 미첨부)**이고, 후보 스캔도 **생략**된다. 400초 영상이 안 붙는다.
- **LOW는 video 첨부 시 이미 적용**된다(빠져있지 않음). 여기선 video가 없어 moot.
- 429는 **text 호출(longform_final_*, regeneration)의 지속적 쿼터 소진(RPM/TPM/RPD)**이다.
  60~240초 백오프에도 계속 429 → 순간 버스트가 아니라 gemini-2.5-flash 쿼터 자체가
  분 단위로 안 풀리는 상태. → **LOW도 간격도 이걸 못 고친다. 쿼터 측 문제.**

## 1. 13개 window 호출이 400초 전체를 붙이나 → 이 배치에선 아니오 (text)

- `buildVertexVideoPart` (line 8203): 로컬 파일을 **통째로 base64 inline 첨부**
  (`fs.readFileSync(filePath).toString('base64')`) — **구간 자르기 없음**. 붙일 땐 400초 전체.
  (memoize: 한 분석 호출 내 1회 read 후 재사용하지만, 매 video 콜마다 전송/입력토큰 계상.)
- **그러나 window 호출이 video를 붙이는지는 조건부**: `selectWindow` (line 8523-8546) —
  `candidatePrompt`(후보 스캔 결과)가 있으면 `includeVideo: false`(후보 텍스트로 선택),
  없으면 `includeVideo: true`(Vision, 400초 첨부).
- **실측 (두 배치 모두)**:
  ```
  Longform 1/5 생략: 기존 후보 10/11개 재사용     ← 후보 스캔 생략(=video scan 안 함)
  Highlight 2/5: 후보 중 Highlight 구간을 선택     ← 후보 기반(=video 미첨부)
  Full 2/5: 후보 중 Full 구간을 선택               ← 후보 기반(=video 미첨부)
  ```
  → **window 호출들이 "후보 중 선택"(text)이지 "Vision으로 선택"이 아니다. 400초 영상 미첨부.**
- 사용자가 센 "full_window 8 + highlight_window 5 = 13"은 **재시도 포함 `요청 시작` 카운트**
  이고, 전부 **text 호출**이다(13번 영상 첨부가 아님).
- 400초 영상이 붙는 경우: **최초 스캔(캐시된 후보 없음)의 scene 분석 + candidate 스캔**
  뿐(≈2~3콜, LOW 적용). 이 배치들은 그마저 재사용으로 생략.

## 2. mediaResolution LOW 적용 여부 → video 콜엔 이미 적용

- `buildMultimodalGenerationConfig({ responseSchema, includeVideo })` (line 873-877):
  `includeVideo`면 `mediaResolution: DEFAULT_MULTIMODAL_MEDIA_RESOLUTION`(=`MEDIA_RESOLUTION_LOW`,
  line 12) 추가.
- 롱폼 Vertex `generateJson` (line 9227)이 모든 콜에서 이걸 쓴다 → **video 붙는 콜
  (scene/candidate/Vision-window)은 전부 LOW**.
- → **"LOW가 window 호출엔 안 됐을 수 있음" 가설은 틀림.** video 붙는 곳엔 이미 LOW.
  단 이 배치들은 window에 video 자체를 안 붙이므로 LOW는 무관.

## 3. 호출 간격 → 이미 넓은데도 429 (버스트 아님)

- `longform_final_*` 429 백오프: `base(60s) × attempt` (60/120/180/240s, retryDelayMs:5809).
  재실행 로그: `longform_final_full ... 60초/120초/180초 후 재시도` — **콜이 분 단위로 벌어져
  있는데도 계속 429.**
- 즉 **순간 TPM 스파이크(연속 발사)가 아니라, 벌어진 콜에도 안 풀리는 지속적 쿼터 소진.**
  간격을 더 벌려도(재생성 8초 간격 추가함) 해결 안 됨 — 재실행이 그 증거.

## 간격-8초 재실행 결과 (job_20260721143932) 인용

```
item_001: 14:42:18 KO Full 원고 문체 재생성: 금지 문체 1개 감지
          14:42:21 full_caption_script_regeneration 호출 제한/일시 오류: 10초 후 재시도(2/3)
          14:42:33 ... 20초 후 재시도(3/3)
          14:43:20 Gemini 분석 실패: Gemini 일시 오류        ← 재생성 콜 자체가 429로 실패
item_002: 14:43:34 longform_final_highlight 호출 제한 60초 재시도
          14:47:39 longform_final_full 호출 제한 60초 재시도
          14:48:41 ... 120초 재시도  14:50:50 ... 180초 재시도   ← text final 지속 429
```
→ **간격만으로 완주 안 됨. 그리고 죽는 지점이 text 호출(regeneration, longform_final)**이라
video-window/LOW 문제가 아님을 재확인.

## 산출 (질문 직접 답)

| 질문 | 답 |
|---|---|
| 13개 호출이 400초 전체를 붙이나 | **이 배치에선 아니오.** window는 후보 재사용(text, includeVideo:false), 후보 스캔도 생략. 영상 미첨부. (buildVertexVideoPart는 붙일 땐 전체·구간없음, 단 최초 스캔에서만) |
| LOW 적용됐나 | **video 붙는 콜엔 이미 적용**(buildMultimodalGenerationConfig). window엔 video 자체가 없어 무관. **"LOW 붙이는 작은 수리"는 대상이 없음.** |
| 호출 간격 | final은 이미 60~240s 백오프인데도 429 → 버스트 아님, 지속적 쿼터 소진 |
| 결론 | **video-TPM/LOW 문제 아님. text 호출의 gemini-2.5-flash 쿼터(RPM/TPM/RPD) 지속 소진.** LOW·간격으로 안 고쳐짐 |

## 다음 (사용자 판단 필요)

간격/LOW 둘 다 이 429의 해법이 아니다(video 미첨부·이미 넓은 간격). 남는 건 **쿼터 측**:
1. Vertex 콘솔에서 해당 project/location의 gemini-2.5-flash **요청/토큰 per-minute·per-day
   한도 확인·상향** (현재 값 확인이 우선).
2. 다른 동시 사용(다른 배치/스케줄)이 같은 쿼터를 쓰는지 확인 → 직렬화.
3. 정 필요하면 **429 payload 로깅**(response.error.status/quotaId)을 켜서 RPM인지 RPD인지
   확증 (현재 body에 metric 이름 없어 코드로는 미상).

참고: 재생성 8초 간격 자체는 무해한 소소한 개선이라 남겨둘 수 있으나, **429의 해결책은
아니다**(커밋 여부는 사용자 결정).

---

## 후속 (2026-07-22): 버스트 재발견 + 전역 throttle 수리

추가 로그 분석으로 429가 **per-item 호출 버스트의 꼬리 콜**에 떨어짐을 확인:
- item_001(내 재실행): full_final 응답(14:42:18) **직후 0초**에 regeneration 요청 → 429.
- item_004(사용자 라이브 356a61): review 실패(16:09:18) **같은 초**에 regeneration 요청 → 429.
- 즉 한 아이템이 scene→metadata→window→final→(review)→regeneration을 **초 단위로 연달아
  발사**하고, 버스트 뒤쪽 콜(주로 regeneration)이 429. (일부는 갭 후에도 429라 쿼터 자체가
  빠듯한 정황도 있어, throttle이 self-inflicted 부분을 줄이되 완전 해결은 쿼터 상향이 필요할 수 있음.)

**수리 (processMetadataService, 풀드래프트 경로만)**:
- `GEMINI_MIN_CALL_INTERVAL_MS`(기본 6000ms, env `PROCESS_METADATA_GEMINI_MIN_INTERVAL_MS`
  로 조정) + `throttleGeminiCall()` 슬롯 예약 rate limiter를 **두 generateJson(Vertex/API-key)
  의 매 콜 앞**에 삽입 → 워커 프로세스 전역으로 모든 full-draft Gemini 콜을 최소 간격으로 분산.
- 재생성 루프엔 추가로 attempt 간 8초 간격(`FULL_DRAFT_REGENERATION_MIN_INTERVAL_MS`).
- job은 레인 로직으로 이미 **1개씩 순차**(동시 워커 없음), 아이템도 for-loop 순차 → throttle이
  그 순차 콜들을 벌린다.
- LOW/분리 호출 안 함(토큰 문제 아님 확정), 하이라이트 경로 불변.

**검증**: 사용자 라이브 배치(script_review_live)가 동시에 돌며 쿼터를 쓰고 있어(현재 429 중)
깨끗한 400초 3개 green 재실행은 **쿼터가 빈 창**에서 해야 함 — 그 창에서 재실행해 로그로
완주 여부를 보강 예정.
