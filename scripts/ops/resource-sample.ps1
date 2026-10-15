# 5-minute resource sample for the daily report (2026-10-15 manager request). ASCII only.
# WMI instead of Get-Counter (Get-Counter hangs under Task Scheduler).
$ErrorActionPreference = 'SilentlyContinue'
$root = Join-Path $env:USERPROFILE 'volcano-channel\server\output\metrics'
New-Item -ItemType Directory -Force $root | Out-Null
$cpu = (Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter "Name='_Total'").PercentProcessorTime
$os = Get-CimInstance Win32_OperatingSystem
$ramUsed = [math]::Round(($os.TotalVisibleMemorySize - $os.FreePhysicalMemory) / 1MB, 2)
$ramTotal = [math]::Round($os.TotalVisibleMemorySize / 1MB, 2)
$top = Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | Where-Object { $_.Name -ne '_Total' -and $_.Name -ne 'Idle' } |
  Sort-Object PercentProcessorTime -Descending | Select-Object -First 5 | ForEach-Object { @{ name = $_.Name; cpu = $_.PercentProcessorTime; ws_mb = [math]::Round($_.WorkingSetPrivate / 1MB) } }
$rec = @{ at = (Get-Date).ToString('o'); cpu_pct = $cpu; ram_used_gb = $ramUsed; ram_total_gb = $ramTotal; top = @($top) }
$line = $rec | ConvertTo-Json -Compress -Depth 4
$file = Join-Path $root ('resources-' + (Get-Date -Format 'yyyyMMdd') + '.jsonl')
[System.IO.File]::AppendAllText($file, $line + "`n", (New-Object System.Text.UTF8Encoding($false)))
