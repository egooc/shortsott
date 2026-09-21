# 어랍숏을 새 PC 에서 돌리려면 (인수인계 목록)

작성 2026-09-21. 이 문서 하나만 들고 가면 새 PC 에서 어랍숏이 돈다.
**좋은 소식: 볼케이노 엔진은 원격 서버(Cloudflare Worker)다. 설치할 게 없다.**
옮겨야 하는 건 ① 열쇠 ② 도구 ③ 레시피 ④ 대장(기록) 네 가지뿐이다.

---

## 1. 반드시 복사해야 하는 것 (이게 없으면 못 돈다)

| 무엇 | 지금 이 PC 위치 | 왜 필요한가 |
|---|---|---|
| **볼케이노 열쇠** | `C:\Users\urban\.volcano\keys\` (typecast · evolink · gladia · speechmatics) | TTS·검수 유료 호출의 신분증. **새로 발급하지 말고 그대로 복사**해야 기존 요청이 재사용되어 돈이 안 나간다 |
| **MCP 등록** | `~/.claude.json` 의 `mcpServers.volcano` = `https://volcano-mcp.groove1027.workers.dev` (http 타입) | 엔진 본체. 새 PC 에서 `claude mcp add` 로 같은 URL 만 등록하면 끝 |
| **미드폼 저장소** | `D:\midform` (git) | 정찰기·문지기·레시피가 전부 여기 있다 |
| **`.env`** | `D:\midform\.env` | git 에 없다. **따로 복사**해야 한다 (Blotato·유튜브 OAuth·ASR 키) |
| **헬퍼 두 개** | `C:\Users\urban\volcano-runs\tools\vol_edit.py`, `mix_ambient.py` | 편집표 제출과 현장음 믹싱. 저장소 밖에 있으니 잊기 쉽다 |

## 2. 새 PC 에 설치해야 하는 것

| 무엇 | 확인 명령 | 비고 |
|---|---|---|
| Python 3.12 + 가상환경 | `C:\Users\urban\.volcano\venv\Scripts\python.exe -V` | 필요한 건 **pillow · numpy · fonttools** 셋. (opencv·onnxruntime 은 다른 채널용) |
| ffmpeg / ffprobe | `ffmpeg -version` | **ASS 필터 포함본**이어야 한다(gyan.dev full build). 자막이 안 구워지면 이것부터 의심 |
| yt-dlp | `yt-dlp --version` | 레딧 소스 받기 |
| Node 20+ | `node -v` | 정찰기·문지기 |
| Claude Code CLI | `C:\Users\urban\.local\bin\claude.exe` | 무인 생산이 이걸 `-p` 로 부른다 |

폰트(BMDOHYEON 등)는 **서버가 작업 폴더에 직접 넣어 준다.** 따로 설치하지 않는다.

## 3. 옮기면 좋은 것 (없어도 돌지만 손해가 크다)

- `D:\midform\docs\source-casebook.md` — **사례 60~71.** 여기 적힌 함정을 모르면 같은 데서 반나절씩 태운다.
- `D:\midform\server\data\social_source_queue.json` — 정찰 대장. 이미 쓴 소재(`fetchedAt`)가 표시돼 있어 중복 제작을 막는다.
- `C:\Users\urban\volcano-runs\arab*\` — 지난 작업 폴더. **완성본(`final_tight.mp4`)만 챙기면 된다.** `edits/`·`paid/` 는 수십 GB 이고 다시 만들 수 있다.
  - 단, `paid/` 를 버리면 **같은 원고를 다시 돌릴 때 TTS 를 새로 산다.** 원고를 바꿀 생각이 없으면 `paid/` 도 가져가라.
- `D:\midform\server\data\arabshot_produce.lock` — **가져가지 마라.** 옛 락이 있으면 새 PC 의 모든 시간이 건너뛴다.

## 4. 새 PC 에서 한 번만 하는 설정

```
cd D:\midform
node scripts\reddit-scout.js --list            # 대장이 읽히는지
node scripts\arabshot-guard.js                 # "진행: 재고 n/7편" 이 나오면 정상
```

무인 생산을 붙이려면 작업 스케줄러에 등록한다(**PowerShell 에서** 실행할 것, Git Bash 는 `/create` 를 망친다):

```
schtasks /create /tn midform-arabshot-hourly /tr "D:\midform\scripts\tasks\midform-arabshot-hourly.cmd" /sc hourly /mo 2 /f
```

`.cmd` 래퍼는 **ASCII 전용**이다. 한글 주석을 넣으면 cmd.exe 가 파싱을 깬다 — 한글 레시피는
`scripts\produce-arabshot-prompt.md` 에 둔다.

## 5. 손으로 한 편 만들어 보는 순서 (연결 확인용)

```
node scripts\reddit-scout.js --period week --limit 10      # 정찰
node scripts\reddit-scout.js --fetch <permalink>           # 받기
# 1080x1920·30fps 로 재인코딩해서 <wd>\volcano_src.mp4 로 둔다
# 같은 이름의 volcano_src.vtt 를 만들어 두면 ASR 실비가 0원이다
python tools\vol_edit.py submit <wd> <wd>\edit.json
python tools\vol_edit.py cam    <wd> <wd>\cam.json          # 세로 원본이면 전 샷 cx=0.5
python tools\vol_edit.py preview <wd>
python tools\vol_edit.py drive  <wd> --step rinbox_review   # 시트를 전부 열고 판정
python tools\mix_ambient.py <wd> <final-*.mp4> <wd>\final_tight.mp4 --gain -6
```

완료 판정은 `<wd>\.volcano_drive_state.json` 의 `status: done` + `step: rinbox_finish`.

## 6. 두 대가 동시에 돌 때 주의

- **작업 폴더 이름이 겹치면 안 된다.** 이 PC 는 `arab01~arab13` 을 썼다. 새 PC 는 `arab51` 부터 시작해라.
- 정찰 대장(`social_source_queue.json`)을 각자 고치면 갈라진다. **한쪽만 정찰**하고 다른 쪽은 받아 쓰거나,
  git 으로 주고받아라.
- 유료 호출은 요청 내용이 같으면 서버가 재사용한다. 두 PC 가 **같은 원고**를 돌리면 두 번 사지 않는다.
  반대로 원고를 한 글자라도 바꾸면 새 요청이다.

---

**한 줄 요약**: `~/.volcano/keys` + `D:\midform`(＋`.env`) + `volcano-runs\tools` 세 덩어리를 복사하고,
새 PC 에 python/ffmpeg/yt-dlp/node/claude 를 깔고, MCP URL 하나 등록하면 끝이다.
