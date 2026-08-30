# Prepare app-local VC++ / Universal CRT files for the Windows 7 installer.
# Run from CI or a Windows build machine that has VS 2022 + Windows 10/11 SDK.
#
# Output: src-tauri/win7-runtime/*.dll plus vc_redist.x64.exe (and KB2999226 when available).

[CmdletBinding()]
param(
    [string]$OutputDir = ""
)

$ErrorActionPreference = "Stop"

$srcTauri = Split-Path -Parent $PSScriptRoot
if (-not $OutputDir) {
    $OutputDir = Join-Path $srcTauri "win7-runtime"
}

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

function Find-VcRedistCrtDir {
    if ($env:VCTOOLS_REDIST_DIR -and (Test-Path $env:VCTOOLS_REDIST_DIR)) {
        $direct = Get-ChildItem -Path $env:VCTOOLS_REDIST_DIR -Directory -Filter "Microsoft.VC*.CRT" -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -match '\\x64\\' } |
            Select-Object -First 1
        if ($direct) {
            return $direct.FullName
        }
        $nested = Join-Path $env:VCTOOLS_REDIST_DIR "x64"
        if (Test-Path $nested) {
            $match = Get-ChildItem -Path $nested -Directory -Filter "Microsoft.VC*.CRT" | Select-Object -First 1
            if ($match) {
                return $match.FullName
            }
        }
    }

    $vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
    if (-not (Test-Path $vswhere)) {
        throw "vswhere.exe not found; install Visual Studio 2022 with the C++ redistributable component"
    }

    $vsPath = & $vswhere -latest -products * -property installationPath
    if (-not $vsPath) {
        throw "Visual Studio installation path was not found"
    }

    $redistRoot = Join-Path $vsPath "VC\Redist\MSVC"
    if (-not (Test-Path $redistRoot)) {
        throw "VC redistributable directory not found: $redistRoot"
    }

    $versionDir = Get-ChildItem -Path $redistRoot -Directory |
        Sort-Object Name -Descending |
        Select-Object -First 1
    $crtDir = Get-ChildItem -Path (Join-Path $versionDir.FullName "x64") -Directory -Filter "Microsoft.VC*.CRT" |
        Select-Object -First 1
    if (-not $crtDir) {
        throw "Microsoft.VC*.CRT x64 directory was not found under $($versionDir.FullName)"
    }
    return $crtDir.FullName
}

function Find-UcrtDir {
    $candidates = @(
        (Join-Path ${env:ProgramFiles(x86)} "Windows Kits\10\Redist\ucrt\DLLs\x64"),
        (Join-Path ${env:ProgramFiles} "Windows Kits\10\Redist\ucrt\DLLs\x64")
    )

    $kitRedist = Join-Path ${env:ProgramFiles(x86)} "Windows Kits\10\Redist"
    if (Test-Path $kitRedist) {
        $versioned = Get-ChildItem -Path $kitRedist -Directory -ErrorAction SilentlyContinue |
            ForEach-Object { Join-Path $_.FullName "ucrt\DLLs\x64" }
        $candidates = $versioned + $candidates
    }

    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path (Join-Path $candidate "ucrtbase.dll"))) {
            return $candidate
        }
    }

    throw "Windows SDK Universal CRT redistributable was not found (Redist\ucrt\DLLs\x64)"
}

$crtDir = Find-VcRedistCrtDir
$ucrtDir = Find-UcrtDir
Write-Host "VC++ CRT: $crtDir"
Write-Host "UCRT:     $ucrtDir"

Copy-Item -Path (Join-Path $crtDir "*.dll") -Destination $OutputDir -Force
Copy-Item -Path (Join-Path $ucrtDir "*.dll") -Destination $OutputDir -Force

$vcRedistPath = Join-Path $OutputDir "vc_redist.x64.exe"
Write-Host "Downloading Visual C++ 2015-2022 redistributable"
Invoke-WebRequest -Uri "https://aka.ms/vs/17/release/vc_redist.x64.exe" -OutFile $vcRedistPath
if ((Get-Item $vcRedistPath).Length -lt 1MB) {
    throw "vc_redist.x64.exe download looks truncated"
}

$kbUrl = "https://download.windowsupdate.com/d/msdownload/update/software/updt/2015/11/windows6.1-kb2999226-x64_7da58c4d261ad48a1367c60c81481ea2a8bae7e3.msu"
$kbPath = Join-Path $OutputDir "Windows6.1-KB2999226-x64.msu"
try {
    Write-Host "Downloading Universal CRT update KB2999226 (optional)"
    Invoke-WebRequest -Uri $kbUrl -OutFile $kbPath
    if ((Get-Item $kbPath).Length -lt 100KB) {
        throw "KB2999226 download looks truncated"
    }
} catch {
    Write-Warning "KB2999226 could not be downloaded; app-local UCRT DLLs still cover launch. $_"
    if (Test-Path $kbPath) {
        Remove-Item $kbPath -Force
    }
}

$required = @(
    "ucrtbase.dll",
    "vcruntime140.dll",
    "vcruntime140_1.dll",
    "msvcp140.dll",
    "api-ms-win-crt-runtime-l1-1-0.dll",
    "api-ms-win-crt-math-l1-1-0.dll",
    "api-ms-win-crt-stdio-l1-1-0.dll",
    "api-ms-win-crt-locale-l1-1-0.dll",
    "api-ms-win-crt-heap-l1-1-0.dll",
    "vc_redist.x64.exe"
)

foreach ($name in $required) {
    $path = Join-Path $OutputDir $name
    if (-not (Test-Path $path)) {
        throw "Windows 7 runtime payload is missing required file: $name"
    }
}

$dllCount = @(Get-ChildItem -Path $OutputDir -Filter "*.dll").Count
if ($dllCount -lt 20) {
    throw "Expected a full UCRT + VC++ DLL set, found only $dllCount DLLs in $OutputDir"
}

Write-Host "Prepared $dllCount runtime DLLs in $OutputDir"
