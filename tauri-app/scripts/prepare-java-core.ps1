$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$tauriAppDir = Split-Path -Parent $scriptDir
$javaCoreDir = [System.IO.Path]::GetFullPath((Join-Path $tauriAppDir "..\\java-core"))
$gradleWrapper = Join-Path $javaCoreDir "gradlew.bat"

if (-not (Test-Path -LiteralPath $gradleWrapper)) {
    throw "Gradle wrapper not found: $gradleWrapper"
}

Write-Host "Building java-core fat jar..."
Push-Location $javaCoreDir
try {
    & $gradleWrapper fatJar
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }
}
finally {
    Pop-Location
}

$libsDir = Join-Path $javaCoreDir "build\\libs"
if (-not (Test-Path -LiteralPath $libsDir)) {
    throw "java-core libs directory not found: $libsDir"
}

$jar = Get-ChildItem -LiteralPath $libsDir -Filter "*-all.jar" -File |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

if (-not $jar) {
    $jar = Get-ChildItem -LiteralPath $libsDir -Filter "*.jar" -File |
        Where-Object { $_.Name -notlike "*-plain.jar" } |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1
}

if (-not $jar) {
    throw "No java-core jar was produced under $libsDir"
}

$resourceDir = Join-Path $tauriAppDir "src-tauri\\resources\\java"
New-Item -ItemType Directory -Force -Path $resourceDir | Out-Null

$targetJar = Join-Path $resourceDir "java-core.jar"
Copy-Item -LiteralPath $jar.FullName -Destination $targetJar -Force

Write-Host "Bundled java-core jar: $targetJar"
