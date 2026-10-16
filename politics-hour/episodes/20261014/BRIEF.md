# 쟁점 브리핑 10/14 편 — 쟁점 자료 모으기 지침

채널 "쟁점 브리핑": 지금 쟁점인 이슈마다 양쪽 입장과 실제 발언을 정리하고, 판단은 시청자에게 맡긴다. 중립이 생명이다.

## 할 일 (쟁점 하나당)
1. 사실 조사: 웹 검색으로 무엇이 쟁점인지, 일지(날짜별), 양쪽 주장, 확인된 사실과 다투는 부분, 앞으로 볼 대목.
   모든 사실에 출처(언론사·날짜·URL)를 붙인다. 확인 안 된 건 "주장"으로 적는다.
2. 발언 영상 찾기: 유튜브에서 양쪽 인물이 직접 말하는 영상(국감 질의, 기자회견, 대변인 브리핑, 방송사 뉴스 클립).
   검색: `yt-dlp "ytsearch15:검색어" --flat-playlist --print "%(id)s|%(title)s|%(channel)s|%(duration)s|%(upload_date)s"`
   방송사·국회·정당 공식 채널 우선. 영상 길이 15분 이하 위주(전체 토론 통째 사용 금지).
3. 받기 (D:/midform/politics-hour/episodes/20261014/src/ 에, 이미 있으면 건너뛰기):
   `yt-dlp -f "bv*[height<=1080][vcodec^=avc1]+ba[ext=m4a]/bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[height<=1080]" --merge-output-format mp4 -o "D:/midform/politics-hour/episodes/20261014/src/%(id)s.%(ext)s" -- <id>`
   소리가 있는지 확인(ffmpeg volumedetect, mean_volume > -40dB).
4. 받아쓰기 (Speechmatics, 유료이니 필요한 영상만):
   `python D:/midform/scripts/rinbox_transcribe.py <mp4> D:/midform/politics-hour/episodes/20261014/transcripts/<id>.json --lang ko`
   결과는 낱말 단위 [[start,end,text],...]. 로컬 whisper 금지.
5. 인용 후보 고르기: 발언자가 화면에 보이며 직접 말하는 구간. 한 구간 15~50초, 문장 처음에서 시작해 문장 끝+0.3초에서 끝낸다.
   **기자 내레이션·앵커 멘트 구간은 인용으로 쓰지 않는다**(발언자 본인 목소리만). 화면에 얼굴이 나오는지 ffmpeg 로 한 장 떠서 눈으로 확인.
   **양쪽 균형**: A측과 B측 인용 합계 시간 차이 20% 이내, 개수도 비슷하게. 쟁점당 인용 합계 6~9분 목표(측마다 3~4.5분).
   인용마다 "센 한마디"(썸네일·자막 강조용, 원문 그대로)를 1~2개 표시.
6. 해설 화면 배경용 구간(b-roll): 자막·사람 얼굴 클로즈업이 덜한 회의장·전경 구간 시각 몇 개.

## 결과 파일: D:/midform/politics-hour/episodes/20261014/issues/<번호>.json (UTF-8, Python write_text(encoding='utf-8'))
{
 "no": 1, "title": "짧은 쟁점 제목(15자 이내)", "sub": "중립적 질문형 부제",
 "summary": "쟁점 요약 3~5문장(평가어 없이)",
 "timeline": [["날짜","일"],...],
 "sides": {"A": {"name":"민주당","position":"입장 한 문장","points":["근거1","근거2","근거3"]},
           "B": {"name":"국민의힘", ...}},
 "facts_confirmed": [["사실", "출처 언론사 날짜"]...], "disputed": ["양쪽이 다투는 부분"...],
 "watch": [["앞으로 볼 대목","상태/날짜"]...],
 "quotes": [{"side":"A","src":"src/<id>.mp4","in":12.3,"out":45.6,"speaker":"이름","role":"정당 직책",
             "tag":"자리·날짜 예: 법사위 국감 · 2026.10.13","text":"받아쓴 원문 전체",
             "phrases":["센 *한마디*"],"source":"영상: <채널명> 2026.10.13","face_check":"ok"}],
 "broll": [{"src":"src/<id>.mp4","start":40}],
 "sources": ["URL",...],
 "notes": "주의할 점(명예훼손 위험, 확인 못 한 것)"
}
phrases 에서 강조할 낱말은 *별표*로 감싼다. 시각은 원본 영상 기준 초.

## 지킬 것
- 출처 표기(영상: 채널 날짜)는 반드시 남긴다. 로고 숨기려고 지우지 않는다.
- 해설·요약에 평가어 금지(궤변, 망언, 정당한, 무리한 등은 인용 안에서만).
- 한쪽 발언만 많은 쟁점이면 반대쪽 공식 반박(대변인 논평 영상 등)을 더 찾는다. 끝내 없으면 notes 에 적는다.
- 개인 범죄 의혹은 "의혹/주장"으로만, 확정처럼 쓰지 않는다.
- 볼케이노 서버·volcano MCP 쓰지 않는다. 키 값을 출력·기록하지 않는다.
- 한국어 파일은 UTF-8로 저장. PowerShell Set-Content/Out-File 금지.
