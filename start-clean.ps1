$ErrorActionPreference = 'Continue'

Set-Location -LiteralPath $PSScriptRoot

Write-Host "====================================="
Write-Host "Content Pipeline Start (PowerShell)"
Write-Host "Project: $(Get-Location)"
Write-Host "====================================="
Write-Host ""

Write-Host "Node version:"
node -v
if ($LASTEXITCODE -ne 0) {
  Write-Host "[ERROR] node is not available in PATH."
  Read-Host "Press Enter to exit"
  exit 1
}

Write-Host "NPM version:"
npm -v
if ($LASTEXITCODE -ne 0) {
  Write-Host "[ERROR] npm is not available in PATH."
  Read-Host "Press Enter to exit"
  exit 1
}

$ports = @(3001, 5173, 5174, 5175, 5176)

Write-Host ""
Write-Host "Cleaning ports 3001, 5173, 5174, 5175, 5176..."

foreach ($port in $ports) {
  $pids = @()
  try {
    $pids = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop |
      Select-Object -ExpandProperty OwningProcess -Unique
  } catch {
    $pids = @()
  }

  if (-not $pids -or $pids.Count -eq 0) {
    $netstatPids = netstat -ano | Select-String ":$port" | Select-String "LISTENING" | ForEach-Object {
      $parts = ($_ -replace '\s+', ' ').Trim().Split(' ')
      if ($parts.Length -gt 0) { $parts[$parts.Length - 1] }
    }
    $pids = $netstatPids | Where-Object { $_ -match '^\d+$' } | Select-Object -Unique
  }

  if (-not $pids -or $pids.Count -eq 0) {
    Write-Host "Port $port is clean. Skipping."
    continue
  }

  foreach ($pid in $pids) {
    Write-Host "Killing PID $pid on port $port"
    taskkill /PID $pid /F *> $null
    if ($LASTEXITCODE -eq 0) {
      Write-Host "  > Killed PID $pid"
    } else {
      Write-Host "  > Failed or already stopped PID $pid"
    }
  }
}

Write-Host ""
Write-Host "Waiting for backend/frontend readiness in parallel..."
$browserJob = Start-Job -ScriptBlock {
  $maxRetries = 90
  $waitSec = 2
  $backendOk = $false
  $frontendOk = $false

  for ($i = 0; $i -lt $maxRetries; $i++) {
    try {
      $r1 = Invoke-WebRequest -UseBasicParsing -Uri "http://localhost:3001/api/health" -TimeoutSec 2
      if ($r1.StatusCode -ge 200 -and $r1.StatusCode -lt 500) {
        $backendOk = $true
      }
    } catch {
      $backendOk = $false
    }

    try {
      $r2 = Invoke-WebRequest -UseBasicParsing -Uri "http://localhost:5173/" -TimeoutSec 2
      if ($r2.StatusCode -ge 200 -and $r2.StatusCode -lt 500) {
        $frontendOk = $true
      }
    } catch {
      $frontendOk = $false
    }

    if ($backendOk -and $frontendOk) {
      Start-Process "http://localhost:5173/"
      Write-Output "Browser opened at http://localhost:5173/"
      return
    }

    Start-Sleep -Seconds $waitSec
  }

  Write-Output "[WARN] Services were not confirmed within wait timeout. Browser was not auto-opened."
}

Write-Host ""
Write-Host "Starting Content Pipeline..."
Write-Host ""
npm run dev

Write-Host ""
if ($browserJob) {
  Receive-Job -Id $browserJob.Id -Keep | ForEach-Object { Write-Host $_ }
  Remove-Job -Id $browserJob.Id -Force -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "Process exited."
Read-Host "Press Enter to close"
