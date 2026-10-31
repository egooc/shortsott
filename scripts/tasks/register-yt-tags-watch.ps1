# Registers the tag gate watch task: every 10 minutes, runs midform-yt-tags-watch.cmd. No API calls when the list is empty.
# Run by the owner: powershell -ExecutionPolicy Bypass -File D:\midform\scripts\tasks\register-yt-tags-watch.ps1
# Remove: Unregister-ScheduledTask -TaskName midform-yt-tags-watch -Confirm:$false
$tn = 'midform-yt-tags-watch'
$a = New-ScheduledTaskAction -Execute 'D:\midform\scripts\tasks\midform-yt-tags-watch.cmd'
$t = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 10)
$p = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
$s = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 8)
Register-ScheduledTask -TaskName $tn -Action $a -Trigger $t -Principal $p -Settings $s -Description 'Tag gate watch every 10 minutes' -Force | Out-Null
Start-ScheduledTask -TaskName $tn
Start-Sleep 5
$i = Get-ScheduledTaskInfo -TaskName $tn
"registered: last=$($i.LastRunTime) result=$($i.LastTaskResult) next=$($i.NextRunTime)"
