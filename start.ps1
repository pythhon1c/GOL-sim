param([string]$Config = 'config.toml')
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
if (-not (Test-Path -LiteralPath '.venv\Scripts\python.exe') -or -not (Test-Path -LiteralPath 'native\target\release\life_native.dll')) {
    throw 'Run .\setup.ps1 first.'
}
if (-not (Test-Path -LiteralPath $Config)) {
    if ($Config -eq 'config.toml') { Copy-Item -LiteralPath config.example.toml -Destination config.toml }
    else { throw "Configuration file does not exist: $Config" }
}
& .\.venv\Scripts\python.exe -m life --config $Config
exit $LASTEXITCODE

