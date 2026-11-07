$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$recordPath = Join-Path $PSScriptRoot '.run\server.json'
if (-not (Test-Path -LiteralPath $recordPath)) { throw 'No background server record. A foreground server can be stopped with Ctrl+C.' }
$record = Get-Content -LiteralPath $recordPath -Raw | ConvertFrom-Json
$serverProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$record.pid)"
if (-not $serverProcess) { Write-Host 'The recorded server is already stopped.'; return }
$recordedTicks = if ($record.created_ticks) { [long]$record.created_ticks } else { ([DateTime]$record.created).ToUniversalTime().Ticks }
if ($serverProcess.CreationDate.ToUniversalTime().Ticks -ne $recordedTicks -or $serverProcess.CommandLine -ne $record.command) {
    throw 'The process ID has been reused; refusing to stop a different process.'
}
Stop-Process -Id $serverProcess.ProcessId
Write-Host 'GOL sim stopped. Saved checkpoints remain available.'
