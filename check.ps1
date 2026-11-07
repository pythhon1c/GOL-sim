$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
if (Test-Path -LiteralPath '.tools\cargo\bin\cargo.exe') {
    $env:CARGO_HOME = Join-Path $PSScriptRoot '.tools\cargo'
    $env:RUSTUP_HOME = Join-Path $PSScriptRoot '.tools\rustup'
    $env:PATH = "$env:CARGO_HOME\bin;$env:PATH"
    $env:RUSTFLAGS = '-C linker=rust-lld'
}
& cargo test --release --manifest-path native\Cargo.toml --locked
if ($LASTEXITCODE -ne 0) { throw 'Native correctness tests failed.' }
$previousNativeLibrary = $env:LIFE_NATIVE_LIBRARY
try {
    # cargo test builds the candidate DLL in deps; test that exact version,
    # including while an older release DLL is loaded by the running server.
    $env:LIFE_NATIVE_LIBRARY = Join-Path $PSScriptRoot 'native\target\release\deps\life_native.dll'
    & .\.venv\Scripts\python.exe -m pytest -q
    if ($LASTEXITCODE -ne 0) { throw 'Python/API tests failed.' }
} finally {
    $env:LIFE_NATIVE_LIBRARY = $previousNativeLibrary
}
$frontendTests = @(Get-ChildItem -LiteralPath 'tests' -Filter '*.test.cjs' -File | ForEach-Object { $_.FullName })
& node --test @frontendTests
if ($LASTEXITCODE -ne 0) { throw 'Frontend data tests failed.' }
Write-Host 'All correctness checks passed.'
