# NVENC vs x264 benchmark. Run AFTER the NVIDIA driver is >= 610 (ffmpeg 9.0 needs NVENC API 13.1).
#   powershell -ExecutionPolicy Bypass -File D:\midform\tools\nvenc-bench\bench.ps1
# Writes results.txt next to this file. Source: src60.mp4 (1080p60, 60 s). Reference: out_x264.mp4 (medium crf19).
$ErrorActionPreference = 'Continue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$ff = 'C:\Users\urban\AppData\Local\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-9.0-full_build\bin\ffmpeg.exe'
$src = Join-Path $here 'src60.mp4'
$log = Join-Path $here 'results.txt'
$drv = (& nvidia-smi --query-gpu=driver_version --format=csv,noheader) -join ''
"=== $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') driver $drv" | Out-File -FilePath $log -Append -Encoding ascii

function Run-Case($name, $args) {
  $out = Join-Path $here ("out_" + $name + ".mp4")
  if (Test-Path $out) { Remove-Item $out -Force }
  $t = Measure-Command { & $ff -hide_banner -loglevel error -y -i $src @args -an $out }
  $bytes = 0; if (Test-Path $out) { $bytes = (Get-Item $out).Length }
  $ssim = 'n/a'
  if ($bytes -gt 0) {
    $s = & $ff -hide_banner -i $out -i $src -lavfi 'ssim' -f null - 2>&1 | Select-String 'All:' | Select-Object -Last 1
    if ($s) { $ssim = ($s -split 'All:')[1].Trim().Split(' ')[0] }
  }
  $line = ('{0,-14} {1,7:N1}s  {2,8:N1} MB  SSIM {3}  [{4}]' -f $name, $t.TotalSeconds, ($bytes / 1MB), $ssim, ($args -join ' '))
  $line | Tee-Object -FilePath $log -Append
}

# Baseline (what every lane uses today). Skip if out_x264.mp4 already exists from the 10-15 run.
if (-not (Test-Path (Join-Path $here 'out_x264.mp4'))) {
  Run-Case 'x264' @('-c:v','libx264','-preset','medium','-crf','19','-pix_fmt','yuv420p')
} else { 'x264           (kept 10-15 result: 157.0s 57.5 MB SSIM 0.9889 under full CPU load)' | Tee-Object -FilePath $log -Append }

# NVENC candidates. p5 = balanced, p7 = slowest/best. cq 19 roughly matches crf 19 in size.
Run-Case 'nvenc_p5_cq19' @('-c:v','h264_nvenc','-preset','p5','-rc','vbr','-cq','19','-b:v','0','-pix_fmt','yuv420p')
Run-Case 'nvenc_p7_cq19' @('-c:v','h264_nvenc','-preset','p7','-rc','vbr','-cq','19','-b:v','0','-pix_fmt','yuv420p')
Run-Case 'nvenc_p5_cq23' @('-c:v','h264_nvenc','-preset','p5','-rc','vbr','-cq','23','-b:v','0','-pix_fmt','yuv420p')
Run-Case 'hevc_p5_cq21'  @('-c:v','hevc_nvenc','-preset','p5','-rc','vbr','-cq','21','-b:v','0','-pix_fmt','yuv420p')

'' | Out-File -FilePath $log -Append -Encoding ascii
Write-Host "done -> $log"
