# 10-20 07:00 재부팅 전 기업 흥망 TTS 대기 루프 종료(관리자 10-19). 이미 만든 장면 음성은 ko-corp/ep01/voice/ 에 남는다.
$t = Get-Date -Hour 6 -Minute 50 -Second 0
if ($t -lt (Get-Date)) { $t = $t.AddDays(1) }
Start-Sleep -Seconds ([int]($t - (Get-Date)).TotalSeconds)
Get-CimInstance Win32_Process -Filter "Name='python.exe'" | Where-Object { $_.CommandLine -match 'corp_render.py ko-corp/ep01 --tts-only' } | ForEach-Object {
  Stop-Process -Id $_.ProcessId -Force
  Add-Content -Path 'D:/midform/ko-corp/ep01/tts_run.log' -Value "[06:50] 재부팅 전 종료(pid $($_.ProcessId))" -Encoding utf8
}
