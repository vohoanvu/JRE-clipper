# Unattended bulk runner for newly discovered episodes (backfill episodes are skipped).
# Every step resumes from state.json, so it is safe to stop and relaunch at any time.
#
#   text      captions -> chunk (a few hours); import/mark stay manual so each batch is reviewed
#   download  480p MP4s -> gs://jre-all-episodes (days, limited by upload bandwidth)
#
# Launch detached so it survives closing the terminal / Claude session (from the repo root):
#   Start-Process powershell -WindowStyle Minimized -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','ingestion\run_bulk.ps1','download'
# Progress: python -m ingestion status, or F:\jre-all-episodes\ingestion\ingestion.log
param([Parameter(Mandatory)][ValidateSet('text', 'download')][string]$Pipeline)

Set-Location (Split-Path $PSScriptRoot)
$py = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'

function Get-Pending([string]$step) {
    & $py -c "from ingestion.state import State; s = State(); print(sum(1 for v in s.videos.values() if not v.get('backfill') and (v.get('$step') or {}).get('status') not in ('done', 'empty', 'no_captions')))"
}

# A step exits early after repeated failures (usually YouTube throttling); wait and resume.
function Invoke-UntilDone([string]$step, [string[]]$stepArgs) {
    for ($attempt = 1; $attempt -le 8; $attempt++) {
        & $py -m ingestion $step @stepArgs
        $left = [int](Get-Pending $step)
        if ($left -eq 0) { return }
        Write-Host "$(Get-Date -Format s) $step stopped with $left pending; resuming in 30 min (attempt $attempt/8)"
        Start-Sleep -Seconds 1800
    }
}

if ($Pipeline -eq 'text') {
    Invoke-UntilDone 'captions' @('--new-only')
    & $py -m ingestion chunk --new-only
} else {
    Invoke-UntilDone 'download' @()
}
