# Keep-awake wrapper for the nightly batch (2026-08-21: the laptop entered Modern Standby
# eleven minutes into the 00:05 run and the console kill took the whole batch with it —
# zero drafts, no report). SetThreadExecutionState(ES_CONTINUOUS|ES_SYSTEM_REQUIRED) holds
# the system awake exactly while the batch runs, then releases; no global power settings
# are touched. Display may still sleep (no ES_DISPLAY_REQUIRED) — CapCut export is not part
# of the produce-only night, and when it is, the export script manages its own session.
param([string[]]$BatchArgs = @('--produce-only'))

$signature = @'
[DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
public static extern uint SetThreadExecutionState(uint esFlags);
'@
$power = Add-Type -MemberDefinition $signature -Name PowerState -Namespace Midform -PassThru
$ES_CONTINUOUS = [uint32]'0x80000000'
$ES_SYSTEM_REQUIRED = [uint32]'0x00000001'

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
[void]$power::SetThreadExecutionState($ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED)
try {
  & node (Join-Path $root 'scripts\nightly-batch.js') @BatchArgs 2>&1 |
    Add-Content -Path (Join-Path $root 'server\output\nightly-reports\task.log') -Encoding utf8
  exit $LASTEXITCODE
} finally {
  [void]$power::SetThreadExecutionState($ES_CONTINUOUS)
}
