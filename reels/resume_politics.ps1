Add-Type -Name NtR -Namespace W -MemberDefinition '[DllImport("ntdll.dll")] public static extern int NtResumeProcess(IntPtr h);'
foreach ($id in 20576,24432,24432,20708,25692,13668,11344,21536,22596,3780,5560,10376,20676,6384,8436) { $p=Get-Process -Id $id -ErrorAction SilentlyContinue; if ($p) { "$id resume=" + [W.NtR]::NtResumeProcess($p.Handle) } }
Remove-Item D:\midform\politics-hour\PAUSED_BY_REELS.json -ErrorAction SilentlyContinue
