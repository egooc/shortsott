# 미드폼/볼케이노 상시 운영 스케줄을 윈도우 작업 스케줄러에 건다.
#
#   powershell -ExecutionPolicy Bypass -File D:\midform\scripts\install-schedule.ps1
#   powershell -ExecutionPolicy Bypass -File D:\midform\scripts\install-schedule.ps1 -List
#   powershell -ExecutionPolicy Bypass -File D:\midform\scripts\install-schedule.ps1 -Remove
#
# 왜 세션 크론이 아니라 작업 스케줄러인가: Claude 세션 안의 크론은 세션이 닫히면 사라진다.
# 발행·검사는 사람이 자리에 없어도 돌아야 하므로 OS 스케줄러에 건다.
#
# 왜 .cmd 래퍼를 거치나: schtasks /tr 에 "C:\Program Files\nodejs\node.exe ..." 처럼 공백이 든 문자열을
# 그대로 넘기면 PowerShell→schtasks 사이에서 따옴표가 벗겨져 'Files\nodejs\...' 로 잘린다(2026-09-18 실측).
# 공백 없는 .cmd 경로 하나만 넘기면 그 문제가 사라지고, 작업 내용도 파일로 남아 읽고 고치기 쉽다.
#
# 거는 작업 (모두 KST):
#   midform-claim-watch       매시    check-claims --all --unschedule   차단되면 예약을 실제로 내린다
#   midform-probe-recheck     매시    claim-probe --recheck             프로브 판정은 몇 시간 뒤 바뀌기도 한다
#   midform-claim-guard-0740  07:40   공개 45분 전 확인 (08:00 슬롯)
#   midform-claim-guard-1140  11:40   공개 45분 전 확인 (12:00 슬롯)  ← 슬롯이 3개로 늘며 비어 있던 자리
#   midform-claim-guard-1740  17:40   공개 45분 전 확인 (18:00 슬롯)
#   midform-webpublish-0800   08:00   네이버·페이스북 중 '지금이 그 시각'인 것 발행
#   midform-webpublish-1200   12:00   같음
#   midform-webpublish-1800   18:00   같음
#   midform-scout-nightly     01:30   소스 정찰 — 아침에 후보가 준비돼 있게
#   midform-survivor-signal   02:10   정찰 결과에서 «살아남은 클립 수»를 카탈로그에 적는다(정찰 뒤에 와야 한다)
#
# 생산(볼케이노 편집)은 여기 없다. 원고·카메라·검수를 서버가 사람에게 묻는 구조라 무인 실행이 불가능하다.
param([switch]$List, [switch]$Remove)

$node = "C:\Program Files\nodejs\node.exe"
$root = "D:\midform"
$taskDir = Join-Path $root "scripts\tasks"

$tasks = @(
  @{ n = "midform-claim-watch";      t = "00:05"; hourly = $true;  s = "check-claims.js";    a = "--all --unschedule" },
  @{ n = "midform-probe-recheck";    t = "00:25"; hourly = $true;  s = "claim-probe.js";     a = "--recheck" },
  @{ n = "midform-claim-guard-0740"; t = "07:40"; hourly = $false; s = "check-claims.js";    a = "--all --unschedule" },
  @{ n = "midform-claim-guard-1140"; t = "11:40"; hourly = $false; s = "check-claims.js";    a = "--all --unschedule" },
  @{ n = "midform-claim-guard-1740"; t = "17:40"; hourly = $false; s = "check-claims.js";    a = "--all --unschedule" },
  @{ n = "midform-webpublish-0800";  t = "08:00"; hourly = $false; s = "web-publish-due.js"; a = "" },
  @{ n = "midform-webpublish-1200";  t = "12:00"; hourly = $false; s = "web-publish-due.js"; a = "" },
  @{ n = "midform-webpublish-1800";  t = "18:00"; hourly = $false; s = "web-publish-due.js"; a = "" },
  @{ n = "midform-scout-nightly";    t = "01:30"; hourly = $false; s = "scout-sources.js";   a = "--recon" },
  @{ n = "midform-survivor-signal";  t = "02:10"; hourly = $false; s = "survivor-signal.js"; a = "" },
  @{ n = "midform-demand-gap";       t = "02:20"; hourly = $false; s = "demand-gap.js";      a = "" },
  @{ n = "midform-rival-backlog";   t = "02:30"; hourly = $false; s = "rival-backlog.js";  a = "" }
)

# 생산은 스크립트가 아니라 클로드 세션이 돈다(원고·컷 경계·카메라·검수 판단이 필요하다).
# 그 .cmd 는 손으로 관리하므로 여기서는 등록/해제/조회만 한다.
$produceName = "midform-produce-hourly"
$produceCmd = Join-Path $root "scripts\tasks\midform-produce-hourly.cmd"

if ($List) {
  foreach ($x in $tasks) {
    $q = schtasks /query /tn $x.n /fo LIST 2>$null | Select-String -Pattern "Next Run Time|Status"
    $info = (($q | ForEach-Object { $_.ToString().Trim() }) -join "  |  ")
    if (-not $info) { $info = "(등록 안 됨)" }
    Write-Output ("{0,-28} {1}" -f $x.n, $info)
  }
  $q = schtasks /query /tn $produceName /fo LIST 2>$null | Select-String -Pattern "Next Run Time|Status"
  $info = (($q | ForEach-Object { $_.ToString().Trim() }) -join "  |  ")
  if (-not $info) { $info = "(등록 안 됨)" }
  Write-Output ("{0,-28} {1}" -f $produceName, $info)
  exit 0
}

if ($Remove) {
  foreach ($x in $tasks) { schtasks /delete /f /tn $x.n 2>$null | Out-Null; Write-Output "삭제: $($x.n)" }
  schtasks /delete /f /tn $produceName 2>$null | Out-Null; Write-Output "삭제: $produceName"
  exit 0
}

New-Item -ItemType Directory -Force -Path $taskDir | Out-Null
foreach ($x in $tasks) {
  # 로그를 남긴다 — 무인 실행이라 실패해도 화면에 아무것도 안 뜬다.
  $cmdPath = Join-Path $taskDir "$($x.n).cmd"
  $log = "$root\server\output\task-logs\$($x.n).log"
  $body = @"
@echo off
rem 자동 생성: scripts\install-schedule.ps1 — 직접 고치지 말고 그 스크립트를 고칠 것
cd /d "$root"
if not exist "$root\server\output\task-logs" mkdir "$root\server\output\task-logs"
echo ---- %DATE% %TIME% >> "$log"
"$node" "$root\scripts\$($x.s)" $($x.a) >> "$log" 2>&1
"@
  Set-Content -Path $cmdPath -Value $body -Encoding OEM

  if ($x.hourly) { schtasks /create /f /tn $x.n /tr $cmdPath /sc hourly /st $x.t | Out-Null }
  else { schtasks /create /f /tn $x.n /tr $cmdPath /sc daily /st $x.t | Out-Null }

  if ($LASTEXITCODE -eq 0) { Write-Output ("등록: {0,-28} {1} {2}" -f $x.n, $x.t, $(if ($x.hourly) { "매시" } else { "매일" })) }
  else { Write-Output "실패: $($x.n)" }
}

# 생산(클로드 세션) — 매시 :45. 가드가 재고·일일상한·중복실행을 보고 건너뛸지 판단한다.
if (Test-Path $produceCmd) {
  schtasks /create /f /tn $produceName /tr $produceCmd /sc hourly /st "00:45" | Out-Null
  if ($LASTEXITCODE -eq 0) { Write-Output ("등록: {0,-28} {1} {2}" -f $produceName, "00:45", "매시") }
  else { Write-Output "실패: $produceName" }
} else {
  Write-Output "건너뜀: $produceCmd 가 없다"
}

# 예전 캡컷 야간 배치는 볼케이노로 넘어오며 쓰지 않는다. 꺼진 채로 둔다.
schtasks /change /tn "midform-nightly" /disable 2>$null | Out-Null
Write-Output "midform-nightly 는 비활성 유지(캡컷 시절 배치 — 볼케이노 전환으로 미사용)"
