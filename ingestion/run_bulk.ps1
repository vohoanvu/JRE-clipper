# Unattended bulk runner. Every step resumes from state.json, so it is safe to stop and relaunch at any time.
#
#   text      new episodes: captions -> chunk (a few hours); import/mark stay manual so each batch is reviewed
#   download  new episodes: 480p MP4s -> gs://jre-all-episodes (days, limited by upload bandwidth)
#   backfill  empty-2025-transcript episodes: captions -> Whisper transcribe (~9 min each) -> chunk (a day or more)
#
# Launch detached so it survives closing the terminal / Claude session (from the repo root):
#   Start-Process powershell -WindowStyle Minimized -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','ingestion\run_bulk.ps1','download'
# Progress: python -m ingestion status, or F:\jre-all-episodes\ingestion\ingestion.log
param([Parameter(Mandatory)][ValidateSet('text', 'download', 'backfill')][string]$Pipeline)

Set-Location (Split-Path $PSScriptRoot)
$py = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
$Host.UI.RawUI.WindowTitle = "run_bulk $Pipeline"

# A click in a console with QuickEdit on starts a selection that blocks all output, which freezes
# the runner mid-step (happened 2026-10-24). Turn QuickEdit off for this window.
Add-Type -Namespace Win32 -Name Console -MemberDefinition @'
[DllImport("kernel32.dll")] public static extern IntPtr GetStdHandle(int nStdHandle);
[DllImport("kernel32.dll")] public static extern bool GetConsoleMode(IntPtr h, out uint mode);
[DllImport("kernel32.dll")] public static extern bool SetConsoleMode(IntPtr h, uint mode);
'@
$stdin = [Win32.Console]::GetStdHandle(-10)
$mode = 0
if ([Win32.Console]::GetConsoleMode($stdin, [ref]$mode)) {
    # clear ENABLE_QUICK_EDIT_MODE (0x40); ENABLE_EXTENDED_FLAGS (0x80) is required for the change to stick
    [void][Win32.Console]::SetConsoleMode($stdin, ($mode -band (-bnot 0x40)) -bor 0x80)
}

# $filter: Python expression over v (state record) selecting the episodes this pipeline works on
function Get-Pending([string]$step, [string]$filter) {
    $cond = if ($step -eq 'transcribe') { 'needs_transcription(v)' } else { "(v.get('$step') or {}).get('status') not in ('done', 'empty', 'no_captions')" }
    & $py -c "from ingestion.state import State; from ingestion.transcribe import needs_transcription; s = State(); print(sum(1 for v in s.videos.values() if ($filter) and $cond))"
}

# A step exits early after repeated failures (usually YouTube throttling); wait and resume.
function Invoke-UntilDone([string]$step, [string[]]$stepArgs, [string]$filter = "not v.get('backfill')") {
    for ($attempt = 1; $attempt -le 8; $attempt++) {
        & $py -m ingestion $step @stepArgs
        $left = [int](Get-Pending $step $filter)
        if ($left -eq 0) { return }
        Write-Host "$(Get-Date -Format s) $step stopped with $left pending; resuming in 30 min (attempt $attempt/8)"
        Start-Sleep -Seconds 1800
    }
}

if ($Pipeline -eq 'text') {
    Invoke-UntilDone 'captions' @('--new-only')
    & $py -m ingestion chunk --new-only
} elseif ($Pipeline -eq 'backfill') {
    # New episodes are all captioned/chunked already, so plain (non --new-only) runs only touch the backfill.
    Invoke-UntilDone 'captions' @() "v.get('backfill')"
    Invoke-UntilDone 'transcribe' @() "v.get('backfill')"
    & $py -m ingestion chunk
} else {
    Invoke-UntilDone 'download' @()
}
