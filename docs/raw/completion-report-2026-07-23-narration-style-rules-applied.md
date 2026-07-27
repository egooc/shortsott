# 완료 보고서 — 나레이션 문체 규칙 반영

## 요약

요청하신 나레이션 문체 규칙 5가지를 `compress-apply`의 `slot_fills` 프롬프트와 검증 로직에 반영했습니다.

핵심 방향은 다음입니다.

1. **인물은 역할 중심으로 부르기**
2. **한 문장에 한 정보만 담고 짧게 쓰기**
3. **화면에 이미 보이는 것을 설명하지 않기**
4. **설명보다 접착 중심으로 쓰기**
5. **closing은 정리하지 말고 짧은 미해결 위협 하나만 남기기**

## 수정 파일

- `server/services/midformCompressionService.js`

## 프롬프트 반영 내용

파일: `server/services/midformCompressionService.js`

### 1) 역할 중심 호칭

```js
'- Refer to characters by role first: 보안관, 아들, 무법자, 길잡이. Avoid listing full names and formal titles inside narration. Use a short name only when truly necessary for clarity, and do not stack multiple full names in one narration slot.',
```

### 2) 짧은 문장 / 한 문장 한 정보

```js
'- Keep sentences short. Prefer roughly one idea per sentence, often around 15 Korean characters or a short clause. Mix in occasional noun-ending fragments like "그때 들려온 의문의 소리." instead of explaining everything in long complete sentences.',
```

### 3) 화면에 보이는 것 설명 금지

```js
'- Do not narrate what the viewer can already see on screen. Use narration for hidden stakes, what is about to happen, what a line means, or why the moment matters — not a plain play-by-play of visible action.',
```

### 4) 설명보다 접착

```js
'- Do not over-explain cause and effect with lecture-like connectors. Prefer brief linked beats such as "경고는 현실이 됐죠. 그리고—" and let the cut carry the visible action.',
```

### 5) closing 최소화

```js
'- The closing should NOT fully summarize the story. Keep it short, leave one unresolved threat or dangling consequence, and end on that. Good style: "아들은, 아직 저들 손에 있습니다."',
```

## 검증 로직 보강

프롬프트만으로 closing이 길어지거나 결말 요약으로 흐를 수 있어서, 검증기에 최소 제약을 추가했습니다.

### closing 문장 수 제한

- `closing` 나레이션은 최대 2문장까지만 허용

### closing 길이 제한

- 공백 제외 90자 초과 시 실패

이 검증은 스타일을 강제하되, 일반 body/bridge narration까지 과도하게 깨뜨리지 않도록 **closing에만** 직접 적용했습니다.

## 추가된 헬퍼

```js
function splitNarrationSentences(text) {
  return String(text || '')
    .split(/[.!?…。！？]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}
```

이 함수로 closing 문장 수를 계산합니다.

## 검증

실행 명령:

```bash
npm run verify
```

결과:

- `check:encoding` ✅
- `verify:js` ✅
- `verify:py` ✅
- `verify:fixture` ✅ 명령 종료 성공

참고로 `verify:fixture` 출력에는 기존 fixture 리포트의 `status: failed` 문자열이 계속 표시되지만, 저장소의 필수 검증 명령 전체는 종료 코드 0으로 성공했습니다.

## 관련 경로

- 프롬프트/검증 코드: `server/services/midformCompressionService.js`
- 이 보고서: `docs/raw/completion-report-2026-07-23-narration-style-rules-applied.md`
