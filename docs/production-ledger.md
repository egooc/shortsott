# 제작 장부 (production_ledger.jsonl)

관리자 성과 보고(매일 07:40)가 «편수·편당 제작 시간·편당 GPT 호출»을 여기서 읽는다. 소유주 지시 2026-10-15.

파일: `D:/midform/server/data/production_ledger.jsonl` — 편 하나가 **승인(또는 업로드)된 직후** 한 줄을 덧붙인다. UTF-8, 한 줄 = JSON 하나.

```json
{"at":"2026-10-15T12:34:56+09:00","session":"C 린박스","lane":"ja","id":"110ja","title":"手柄を捨てて去る浪人","started_at":"2026-10-15T10:02:00+09:00","finished_at":"2026-10-15T11:48:00+09:00","render_secs":612,"gpt_calls":1,"youtube_id":"zfy6CgQk9-Q","publish_at":"2026-10-16T18:00:00+09:00","rejected":0,"note":""}
```

| 키 | 뜻 |
|---|---|
| session | 보고 세션 이름(C 린박스 · A 롱투숏 · B 팬튜브 · 정치 · 쇼핑 · N100) |
| lane | ja · ko_longshort · fantube · politics_long · politics_short · shop · n100_<키> |
| id | 편 식별자(110ja, ls37, ep10, ffref07, s3, ott168 …) |
| started_at / finished_at | 그 편 작업을 시작한 시각 · 승인(완성)된 시각. 편당 제작 시간 = 차이 |
| prep_started_at (선택) | 소스 준비(받기·crop·전사)를 시작한 시각. 소스 하나로 여러 편을 만들면 첫 편에만 적는다. 있으면 보고서가 제작 시간을 이 시각부터 잰다(10-15 C 제안: 준비 45분이 started_at 에 빠짐) |
| render_secs | 렌더만 걸린 초(모르면 생략) |
| gpt_calls | 이 편에 gpt-ask 를 부른 횟수(0 이면 0) |
| youtube_id / publish_at | 업로드했으면 영상 ID 와 공개 예정 시각(아직이면 생략, 나중에 같은 id 로 한 줄 더 써도 된다 — 마지막 줄이 이긴다) |
| rejected | 눈검사·관문에서 되돌린 횟수 |
| note | 한 줄 메모(소재, 특이점) |

쓰는 법(Node):
```js
fs.appendFileSync('D:/midform/server/data/production_ledger.jsonl', JSON.stringify(rec) + '\n', 'utf8');
```
PowerShell Set-Content/Out-File 로 쓰지 않는다(인코딩). 장부에 안 적힌 편은 보고에 «집계 불가»로 나온다.
