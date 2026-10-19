Add-Type -Name NtR2 -Namespace W -MemberDefinition '[DllImport("ntdll.dll")] public static extern int NtResumeProcess(IntPtr h);'
foreach ($id in 20576,24432,18612) { $p=Get-Process -Id $id -ErrorAction SilentlyContinue; if ($p) { "$id resume=" + [W.NtR2]::NtResumeProcess($p.Handle) } }
Remove-Item D:\midform\politics-hour\PAUSED_BY_REELS.json -ErrorAction SilentlyContinue
