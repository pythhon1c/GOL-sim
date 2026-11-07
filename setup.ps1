param([string]$PythonPath = '')
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

if (-not (Test-Path -LiteralPath '.venv\Scripts\python.exe')) {
    if (-not $PythonPath) {
        $pythonCommand = Get-Command python -ErrorAction SilentlyContinue
        if ($pythonCommand -and $pythonCommand.Source -notlike '*WindowsApps*') { $PythonPath = $pythonCommand.Source }
    }
    if (-not $PythonPath) { throw 'Python 3.11+ required. Run setup.ps1 -PythonPath C:\path\to\python.exe' }
    & $PythonPath -m venv .venv
    if ($LASTEXITCODE -ne 0) { throw 'Could not create the Python environment.' }
}
$requirements = if (Test-Path -LiteralPath 'requirements.lock.txt') { 'requirements.lock.txt' } else { 'requirements.txt' }
& .\.venv\Scripts\python.exe -m pip install -r $requirements
if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }

$localCargo = Join-Path $PSScriptRoot '.tools\cargo'
$localRust = Join-Path $PSScriptRoot '.tools\rustup'
if (-not (Test-Path -LiteralPath "$localCargo\bin\cargo.exe") -and -not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    New-Item -ItemType Directory -Force -Path .tools | Out-Null
    $installer = Join-Path $PSScriptRoot '.tools\rustup-init.exe'
    Invoke-WebRequest -Uri 'https://win.rustup.rs/x86_64' -OutFile $installer
    $env:CARGO_HOME = $localCargo
    $env:RUSTUP_HOME = $localRust
    & $installer -y --default-host x86_64-pc-windows-gnu --profile minimal --no-modify-path
    if ($LASTEXITCODE -ne 0) { throw 'Rust toolchain installation failed.' }
}
if (Test-Path -LiteralPath "$localCargo\bin\cargo.exe") {
    $env:CARGO_HOME = $localCargo
    $env:RUSTUP_HOME = $localRust
    $env:PATH = "$localCargo\bin;$env:PATH"
    $env:RUSTFLAGS = '-C linker=rust-lld'
}
& cargo build --release --manifest-path native\Cargo.toml --locked
if ($LASTEXITCODE -ne 0) { throw 'Native build failed.' }
if (-not (Test-Path -LiteralPath 'config.toml')) { Copy-Item -LiteralPath config.example.toml -Destination config.toml }
Write-Host 'Ready. Run .\start.ps1 to start GOL sim.'

