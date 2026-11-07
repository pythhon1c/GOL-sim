param(
    [string]$Config = 'config.toml',
    [ValidateRange(10, 3600)][int]$StartupTimeoutSeconds = 300
)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
if (-not (Test-Path -LiteralPath '.venv\Scripts\python.exe')) { throw 'Run .\setup.ps1 first.' }
if (-not (Test-Path -LiteralPath $Config)) { throw 'Configuration missing. Run .\setup.ps1 first.' }
$resolvedConfig = (Resolve-Path -LiteralPath $Config).Path
$serverConfig = & .\.venv\Scripts\python.exe -c 'import json,sys,tomllib; print(json.dumps(tomllib.load(open(sys.argv[1],"rb"))["server"]))' $resolvedConfig | ConvertFrom-Json
if ($serverConfig.host -notin @('127.0.0.1', 'localhost', '0.0.0.0')) { throw 'Use start.ps1 for an explicitly selected external interface.' }
$baseUrl = "http://127.0.0.1:$($serverConfig.port)"
$headers = @{}
if ($env:LIFE_ACCESS_TOKEN) { $headers.Authorization = "Bearer $env:LIFE_ACCESS_TOKEN" }
try {
    $existing = Invoke-RestMethod -Uri "$baseUrl/api/status" -Headers $headers -TimeoutSec 2
} catch { $existing = $null }
if ($existing -and $existing.rule -eq 'B3/S23') {
    Write-Host "GOL sim is already running: $baseUrl"
    return
}
New-Item -ItemType Directory -Force -Path .run | Out-Null
$pythonExecutable = (Resolve-Path -LiteralPath '.venv\Scripts\python.exe').Path
$launched = Start-Process -FilePath $pythonExecutable -ArgumentList @('-m', 'life', '--config', ('"' + $resolvedConfig + '"')) -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput '.run\server.out.log' -RedirectStandardError '.run\server.err.log' -PassThru
$deadline = [DateTime]::UtcNow.AddSeconds($StartupTimeoutSeconds)
do {
    Start-Sleep -Milliseconds 200
    try { $status = Invoke-RestMethod -Uri "$baseUrl/api/status" -Headers $headers -TimeoutSec 1 } catch { $status = $null }
} while (-not $status -and [DateTime]::UtcNow -lt $deadline)
if (-not $status.resources.process_id) { throw 'Server did not start. See .run\server.err.log.' }
$serverProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $($status.resources.process_id)"
if (-not $serverProcess.CommandLine.Contains($resolvedConfig)) { throw 'The port belongs to another process; no stop record was written.' }
@{ pid = $serverProcess.ProcessId; created_ticks = $serverProcess.CreationDate.ToUniversalTime().Ticks.ToString(); command = $serverProcess.CommandLine; url = $baseUrl } | ConvertTo-Json | Set-Content -LiteralPath '.run\server.json' -Encoding utf8
Write-Host "GOL sim is running: $baseUrl"
Write-Host 'Stop it with .\stop.ps1. Logs: .run\server.err.log'

