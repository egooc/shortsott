# compress LLM Codex → Vertex(Gemini) 이관 — 완료 + 품질 검증

Date: 2026-07-21

## 결론

compress의 세 LLM 호출(비트분할 / edit_plan / 나레이션+caption)을 Codex CLI → Vertex(Gemini) 이관 완료. 두 검증 영상(Catch the Bullet, Twilight)에서 Codex 프롬프트 그대로 Gemini가 품질 재현. **프롬프트 재조정 불필요.** Codex 주간 쿼터에서 완전 탈출.

## 코드 변경

- `server/services/geminiMidformService.js`: `toVertexResponseSchema`(JSON Schema → Vertex OpenAPI subset, additionalProperties/$schema/$ref/definitions 제거) + `generateVertexJson`(text-only structured JSON, 기존 씬분석 auth/endpoint 재사용). export.
- `server/services/midformCompressionService.js`: `runJsonGeneration`에 provider 스위치 — `MIDFORM_COMPRESS_LLM=vertex`(기본) | `codex`(폴백 유지). provider별 재시도 분류. `VERTEX_COMPRESS_MODEL`(기본 gemini-2.5-pro). Codex 경로 + fresh-node 폴백 그대로 보존.
- `llm_provider`(edit_plan) / `llmProvider`(manifest, compress-apply manifest) 기록.
- `scripts/midform.js`: `.env` 로딩 추가(CLI 단독 실행 시 Vertex 도달).
- 기존 코드 수정은 전부 줄 범위/앵커 스크립트 교체. 각 단계 `node --check` + `require` 검증. diagnostic 무해 확인.

## 검증 (실물 산출물, 두 영상)

Catch(`compress_20260721224323_3e-5BAhZQ5w`), Twilight(`compress_20260721233234_ngYmFVO_bzM`) 둘 다 Vertex로 compress → compress-apply.

| 항목 | Catch | Twilight |
|---|---|---|
| 콜드오픈 재프레이밍 | "추격하던 보안관은 어쩌다 미끼가 되었나?" | "내가 영웅이 아니라, 악당이라면 어떨까?" |
| anchor/핵심대사 | hostages/locket/bait | wolves/**treaty**/what-are-they-really 전부 |
| 나레이션 후킹 톤 | ✓ | ✓ |
| caption 1:1 | 전 슬롯 match=true | 전 슬롯 match=true |
| caption 구어체 | "우린 미끼였어." "피장파장이라니, 대체 무슨 뜻이야?" | "걔네 정체가 뭔데?" "그래서 그들과 조약을 맺었어." |
| 곁가지 제외 | 204s mega-beat 핵심만(잡담 없음) | ✓ |

### 특이점 / 관찰

- **비트분할 거침**: Vertex 5개 vs Codex 8개(동일 영상). 프롬프트 "5-9개" 범위 안이나 Codex보다 coarse. **그러나 downstream 품질 손실 없음** — per-line 매칭이 큰 beat 안에서도 핵심 대사만 골라 각 시점에 자막을 붙임(옵션 A로 확정, 프롬프트 조정 안 함).
- **reveal 비트 anchor 2개**: Vertex가 Twilight reveal에 anchor 2개(wolves + what-are-they-really)만 부여(Codex는 treaty 포함 3개). **하지만 treaty가 payoff 자막에 최종 생존** — Vertex가 `dialogue_focus_quotes`(anchor보다 넓은 3-5줄)에 treaty를 스스로 포함시켰기 때문. 밀집 reveal 약점 우려는 실측상 문제 없음.
- **지연**: gemini-2.5-pro edit_plan ~78s/콜, compress(2콜)+compress-apply(1콜) ≈ 영상당 3-4분. 배치 허용.
- **`editPlanSource` 라벨**: 여전히 'codex'/'local_fallback'로 표기(LLM 생성 여부 의미). 정확한 provider는 `llmProvider` 필드. 향후 라벨 'llm'으로 개명 고려(cosmetic).

## 스코프 준수

게이트/검증 로직 무변경, compress 외 단계(씬분석) 무변경, 프롬프트 내용 무변경(품질 재현되어 조정 불필요), Codex 경로 유지.

## 즉시 이어질 것

이제 Vertex로 caption 생성 가능 → Catch render(task #9)의 쿼터 블로커 해소. Vertex 런(`compress_20260721224323_3e-5BAhZQ5w`, caption 포함)으로 `bootstrap --preflight-only`(11/11 재확인) → 실제 render → 정지 → CapCut 확인.
