# Registers (or updates) the daily Task Scheduler task that runs `run_bulk.ps1 new`:
# discover -> captions -> Whisper fallback -> chunk -> download for newly released episodes.
# Import and mark stay manual (reviewed dry runs).
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File ingestion\register_task.ps1 [-At 06:00]
#
# Runs as the current user, only while logged on (no stored password); the PC never sleeps on AC.
# A run still going when the next one is due is left alone (MultipleInstances IgnoreNew).
# Remove with: Unregister-ScheduledTask -TaskName 'JRE ingestion new episodes' -Confirm:$false
param([string]$At = '06:00')

$taskName = 'JRE ingestion new episodes'
$runner = Join-Path $PSScriptRoot 'run_bulk.ps1'

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Minimized -File `"$runner`" new"
$trigger = New-ScheduledTaskTrigger -Daily -At $At
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 23) `
    -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
    -Description 'JRE clipper: daily new-episode ingestion (discover, captions, chunk, download). Logs: F:\jre-all-episodes\ingestion\ingestion.log' `
    -Force | Out-Null
Get-ScheduledTask -TaskName $taskName | Get-ScheduledTaskInfo | Select-Object TaskName, NextRunTime
