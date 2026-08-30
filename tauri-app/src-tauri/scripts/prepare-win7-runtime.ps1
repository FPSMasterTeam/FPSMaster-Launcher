# Prepare app-local VC++ / Universal CRT files for the Windows 7 installer.
#
# windows-latest currently ships Visual Studio 2026 (18). Its Redist\MSVC\v145
# folder is not the classic x64\Microsoft.VC*.CRT layout, so this script:
#   1. downloads the VS 2015-2022 x64 redistributable and extracts CRT DLLs
#   2. falls back to any VS install that still has Microsoft.VC143.CRT (or later)
#   3. copies UCRT app-local files from the Windows SDK
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
$workDir = Join-Path $OutputDir ".extract"
New-Item -ItemType Directory -Force -Path $workDir | Out-Null

function Find-CrtDirectoryInTree {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Root
    )

    if (-not (Test-Path $Root)) {
        return $null
    }

    $candidates = @(Get-ChildItem -Path $Root -Recurse -Filter "vcruntime140.dll" -File -ErrorAction SilentlyContinue |
        Where-Object {
            (Test-Path (Join-Path $_.DirectoryName "msvcp140.dll")) -and
            (
                $_.Directory.Name -like "Microsoft.VC*.CRT" -or
                (Test-Path (Join-Path $_.DirectoryName "vcruntime140_1.dll"))
            )
        })

    if (-not $candidates) {
        return $null
    }

    $ranked = $candidates | Sort-Object @{
        Expression = {
            if ($_.Directory.Name -match "VC143") { 0 }
            elseif ($_.Directory.Name -match "VC142") { 1 }
            elseif ($_.Directory.Name -match "VC141") { 2 }
            elseif ($_.Directory.Name -match "VC14") { 3 }
            else { 4 }
        }
    }, @{
        Expression = { $_.DirectoryName }
        Descending = $true
    }

    return $ranked[0].Directory.FullName
}

function Find-VcRedistCrtDirFromVisualStudio {
    $roots = @()
    if ($env:VCTOOLS_REDIST_DIR -and (Test-Path $env:VCTOOLS_REDIST_DIR)) {
        $roots += $env:VCTOOLS_REDIST_DIR
    }

    $vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
    if (Test-Path $vswhere) {
        $installs = @(& $vswhere -all -products * -property installationPath)
        foreach ($install in $installs) {
            if ($install) {
                $roots += (Join-Path $install "VC\Redist\MSVC")
            }
        }
    }

    foreach ($root in $roots) {
        $found = Find-CrtDirectoryInTree -Root $root
        if ($found) {
            Write-Host "Found VC++ CRT under Visual Studio: $found"
            return $found
        }
    }

    return $null
}

function Extract-VcRedistCrtDir {
    param(
        [Parameter(Mandatory = $true)]
        [string]$VcRedistPath,
        [Parameter(Mandatory = $true)]
        [string]$ExtractRoot
    )

    $extractDir = Join-Path $ExtractRoot "vc_redist"
    New-Item -ItemType Directory -Force -Path $extractDir | Out-Null
    Write-Host "Extracting $VcRedistPath to $extractDir"
    $process = Start-Process -FilePath $VcRedistPath -ArgumentList @("/quiet", "/norestart", "/extract:$extractDir") -Wait -PassThru -NoNewWindow
    if ($process.ExitCode -ne 0 -and $process.ExitCode -ne 3010) {
        Write-Warning "vc_redist /extract exited with code $($process.ExitCode); trying without /quiet"
        $process = Start-Process -FilePath $VcRedistPath -ArgumentList @("/extract:$extractDir") -Wait -PassThru -NoNewWindow
        if ($process.ExitCode -ne 0 -and $process.ExitCode -ne 3010) {
            Write-Warning "vc_redist /extract failed with exit code $($process.ExitCode)"
        }
    }

    $found = Find-CrtDirectoryInTree -Root $extractDir
    if ($found) {
        return $found
    }

    Get-ChildItem -Path $extractDir -Recurse -Filter "*.cab" -File -ErrorAction SilentlyContinue | ForEach-Object {
        $cabOut = Join-Path $ExtractRoot ("cab_" + $_.BaseName)
        New-Item -ItemType Directory -Force -Path $cabOut | Out-Null
        & expand.exe $_.FullName -F:* $cabOut | Out-Null
    }

    Get-ChildItem -Path $extractDir -Recurse -Filter "*.msi" -File -ErrorAction SilentlyContinue | ForEach-Object {
        $msiOut = Join-Path $ExtractRoot ("msi_" + $_.BaseName)
        New-Item -ItemType Directory -Force -Path $msiOut | Out-Null
        $msi = Start-Process -FilePath "msiexec.exe" -ArgumentList @("/a", $_.FullName, "/qn", "TARGETDIR=$msiOut") -Wait -PassThru -NoNewWindow
        if ($msi.ExitCode -ne 0) {
            Write-Warning "msiexec /a $($_.Name) exited with code $($msi.ExitCode)"
        }
    }

    return (Find-CrtDirectoryInTree -Root $ExtractRoot)
}

function Find-UcrtDir {
    $candidates = @()
    $kitRoots = @(
        (Join-Path ${env:ProgramFiles(x86)} "Windows Kits\10\Redist"),
        (Join-Path ${env:ProgramFiles} "Windows Kits\10\Redist")
    )
    foreach ($kitRedist in $kitRoots) {
        if (Test-Path $kitRedist) {
            $candidates += Get-ChildItem -Path $kitRedist -Directory -ErrorAction SilentlyContinue |
                ForEach-Object { Join-Path $_.FullName "ucrt\DLLs\x64" }
            $candidates += (Join-Path $kitRedist "ucrt\DLLs\x64")
        }
    }

    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path (Join-Path $candidate "ucrtbase.dll"))) {
            return $candidate
        }
    }

    throw "Windows SDK Universal CRT redistributable was not found (Redist\ucrt\DLLs\x64)"
}

$vcRedistPath = Join-Path $OutputDir "vc_redist.x64.exe"
Write-Host "Downloading Visual C++ 2015-2022 redistributable"
Invoke-WebRequest -Uri "https://aka.ms/vs/17/release/vc_redist.x64.exe" -OutFile $vcRedistPath
if ((Get-Item $vcRedistPath).Length -lt 1MB) {
    throw "vc_redist.x64.exe download looks truncated"
}

$crtDir = Extract-VcRedistCrtDir -VcRedistPath $vcRedistPath -ExtractRoot $workDir
if (-not $crtDir) {
    Write-Warning "Could not extract CRT DLLs from vc_redist.x64.exe; searching Visual Studio installs"
    $crtDir = Find-VcRedistCrtDirFromVisualStudio
}
if (-not $crtDir) {
    throw "Could not locate vcruntime140.dll / msvcp140.dll from vc_redist.x64.exe or Visual Studio redistributables"
}

$ucrtDir = Find-UcrtDir
Write-Host "VC++ CRT: $crtDir"
Write-Host "UCRT:     $ucrtDir"

Copy-Item -Path (Join-Path $crtDir "*.dll") -Destination $OutputDir -Force
Copy-Item -Path (Join-Path $ucrtDir "*.dll") -Destination $OutputDir -Force

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

Remove-Item -Path $workDir -Recurse -Force -ErrorAction SilentlyContinue

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
