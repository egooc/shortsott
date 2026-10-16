# politics-hour 설치 확인 + 시험 렌더. 노트북에서 한 번 실행한다.
#   powershell -ExecutionPolicy Bypass -File setup.ps1 [-SkipRender]
param([switch]$SkipRender)
$ErrorActionPreference = 'Stop'
$Home2 = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Home2
if (-not (Test-Path config.json)) { Copy-Item config.example.json config.json; "config.json 생성(기본값)" }
$cfg = Get-Content config.json -Raw -Encoding UTF8 | ConvertFrom-Json
$py = $cfg.python

"== 도구 확인"
foreach ($t in 'node','npx','ffmpeg','ffprobe','yt-dlp') {
  $c = Get-Command $t -ErrorAction SilentlyContinue
  if (-not $c) { throw "$t 가 PATH 에 없습니다" } else { "  $t : $($c.Source)" }
}
& $py -c "import numpy, cv2; assert hasattr(cv2,'FaceDetectorYN'); print('  python numpy', numpy.__version__, 'cv2', cv2.__version__)"
if ($LASTEXITCODE -ne 0) { & $py -m pip install --user numpy opencv-python; if ($LASTEXITCODE -ne 0) { throw 'numpy/opencv 설치 실패' } }
"  hyperframes " + (npx --yes "hyperframes@$($cfg.hyperframes)" --version)

"== 시험 소스 받기"
$s = Join-Path $Home2 'samples\test2\src'
New-Item -ItemType Directory -Force $s | Out-Null
foreach ($id in Get-Content samples\test2\sources.txt) {
  if (-not (Test-Path "$s\$id.mp4")) {
    yt-dlp -f "bv*[height<=1080][vcodec^=avc1]+ba[ext=m4a]/bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[height<=1080]" --merge-output-format mp4 -o "$s\%(id)s.%(ext)s" -- $id
  }
}
if ($SkipRender) { "렌더 생략"; exit 0 }

"== 시험 렌더 (해설 5 + 인용 2, 약 2분짜리)"
$t0 = Get-Date
& $py overlay\assemble_hour.py samples\test2\episode.json --tts none
"걸린 시간: " + ((Get-Date) - $t0).ToString()
