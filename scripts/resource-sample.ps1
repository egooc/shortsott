# Every 5 minutes: one JSON line of machine load, so the manager report can say
# where the bottleneck is and which hours pile up (owner 2026-10-15: needed for
# hardware upgrade and schedule de-conflict decisions).
# Output: D:\midform\server\output\metrics\resources-YYYYMMDD.jsonl (ASCII keys only).
$ErrorActionPreference = 'SilentlyContinue'
$root = 'D:\midform'
$outDir = Join-Path $root 'server\output\metrics'
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Force $outDir | Out-Null }
$now = Get-Date
$file = Join-Path $outDir ("resources-" + $now.ToString('yyyyMMdd') + ".jsonl")

# Get-Counter hangs under Task Scheduler (observed 2026-10-15); WMI perf data returns instantly.
$cpu = (Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter "Name='_Total'").PercentProcessorTime
$os = Get-CimInstance Win32_OperatingSystem
$ramTotalMb = [math]::Round($os.TotalVisibleMemorySize / 1024)
$ramUsedMb = [math]::Round(($os.TotalVisibleMemorySize - $os.FreePhysicalMemory) / 1024)

$gpuUtil = $null; $gpuMemMb = $null; $gpuMemTotalMb = $null; $gpuTemp = $null
$smi = & nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu --format=csv,noheader,nounits 2>$null
if ($smi) {
  $p = ($smi -split ',') | ForEach-Object { $_.Trim() }
  $gpuUtil = [int]$p[0]; $gpuMemMb = [int]$p[1]; $gpuMemTotalMb = [int]$p[2]; $gpuTemp = [int]$p[3]
}
$gpuProcs = @()
$smiP = & nvidia-smi --query-compute-apps=process_name,used_memory --format=csv,noheader,nounits 2>$null
foreach ($line in @($smiP)) {
  if (-not $line) { continue }
  $q = ($line -split ',') | ForEach-Object { $_.Trim() }
  $gpuProcs += @{ name = (Split-Path -Leaf $q[0]); mem_mb = [int]$q[1] }
}

$diskD = Get-PSDrive D
$diskFreeGb = if ($diskD) { [math]::Round($diskD.Free / 1GB, 1) } else { $null }

# Processes by total CPU seconds; the report differences consecutive samples to get load per process.
# Wide list (top 40 + every renderer) so a fresh ffmpeg/python with little cumulative CPU is not missed.
$renderers = 'ffmpeg','python','node','codex','claude','ffprobe','Orca'
$top = Get-Process | Where-Object { $_.CPU -gt 1 -and ($_.CPU -gt 30 -or $renderers -contains $_.ProcessName) } | Sort-Object CPU -Descending | Select-Object -First 40 |
  ForEach-Object { @{ pid = $_.Id; name = $_.ProcessName; cpu_s = [math]::Round($_.CPU); ws_mb = [math]::Round($_.WorkingSet64 / 1MB) } }

$markers = @{
  politics_render_lock = (Test-Path (Join-Path $root 'politics-hour\RENDERING.lock'))
  ffmpeg = @(Get-Process ffmpeg).Count
  python = @(Get-Process python).Count
  node = @(Get-Process node).Count
  codex = @(Get-Process codex).Count
  claude = @(Get-Process claude).Count
  gpt_ask_slots = @(Get-ChildItem (Join-Path $root 'tools\gpt-ask-work\slot*.lock')).Count
}

$rec = [ordered]@{
  at = $now.ToString('o')
  cpu_pct = [math]::Round($cpu)
  ram_used_mb = $ramUsedMb
  ram_total_mb = $ramTotalMb
  gpu_pct = $gpuUtil
  gpu_mem_mb = $gpuMemMb
  gpu_mem_total_mb = $gpuMemTotalMb
  gpu_temp_c = $gpuTemp
  gpu_procs = $gpuProcs
  disk_d_free_gb = $diskFreeGb
  markers = $markers
  top = $top
}
$json = ($rec | ConvertTo-Json -Compress -Depth 5)
[IO.File]::AppendAllText($file, $json + "`n", (New-Object System.Text.UTF8Encoding($false)))
