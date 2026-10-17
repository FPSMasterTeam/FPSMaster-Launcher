# Prepare app-local VC++ / Universal CRT files for the Windows 7 installer.
#
# windows-latest ships Visual Studio 2026 (18). Its Redist\MSVC\v145 folder is not the classic
# x64\Microsoft.VC*.CRT layout, so this script:
#   1. takes the CRT DLLs from a Visual Studio install that has Microsoft.VC143.CRT (the CI job
#      runs on windows-2022 for this)
#   2. otherwise unpacks the downloaded VS 2015-2022 x64 redistributable with Burn's /layout and
#      extracts the CRT DLLs from its MSIs with an administrative install
#   3. copies UCRT app-local files from the Windows SDK
#
# Output: src-tauri/win7-runtime/*.dll plus vc_redist.x64.exe and Windows6.1-KB2999226-x64.msu.

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
            # Visual Studio's Redist tree also holds x86, arm64, onecore and debug copies under
            # identically named Microsoft.VC*.CRT folders; only the plain x64 set ships.
            $_.DirectoryName -notmatch '\\(x86|arm64|arm64ec|onecore|debug_nonredist)\\' -and
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

# Runs an installer non-interactively and kills it after $TimeoutSeconds. Every external tool
# here must stay quiet: on a CI runner a UI prompt never gets an answer and the job hangs for hours.
function Invoke-Quiet {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $true)][string[]]$ArgumentList,
        [int]$TimeoutSeconds = 300
    )

    $process = Start-Process -FilePath $FilePath -ArgumentList $ArgumentList -PassThru -NoNewWindow
    # Without holding the handle, ExitCode reads back as $null once the process has exited.
    $null = $process.Handle
    if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
        $process.Kill()
        throw "$FilePath $($ArgumentList -join ' ') did not finish within ${TimeoutSeconds}s"
    }
    return $process.ExitCode
}

function Extract-VcRedistCrtDir {
    param(
        [Parameter(Mandatory = $true)]
        [string]$VcRedistPath,
        [Parameter(Mandatory = $true)]
        [string]$ExtractRoot
    )

    # vc_redist is a WiX Burn bundle. It has no /extract switch (Burn treats an unknown switch as
    # a plain install and returns 1638 when the runtime is already present); /layout copies the
    # embedded MSI and CAB payloads to a directory without installing anything.
    $layoutDir = Join-Path $ExtractRoot "vc_redist"
    New-Item -ItemType Directory -Force -Path $layoutDir | Out-Null
    Write-Host "Laying out $VcRedistPath to $layoutDir"
    $burnLog = Join-Path $ExtractRoot "vc_redist_layout.log"
    $exitCode = Invoke-Quiet -FilePath $VcRedistPath -ArgumentList @("/layout", "`"$layoutDir`"", "/quiet", "/norestart", "/log", "`"$burnLog`"")
    $msis = @(Get-ChildItem -Path $layoutDir -Recurse -Filter "*.msi" -File -ErrorAction SilentlyContinue)
    if ($exitCode -ne 0 -or -not $msis) {
        Write-Host "----- files under $ExtractRoot -----"
        Get-ChildItem -Path $ExtractRoot -Recurse -File -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "$($_.FullName) $($_.Length)" }
        Get-ChildItem -Path (Split-Path -Parent $burnLog) -Filter "vc_redist_layout*.log" -File -ErrorAction SilentlyContinue | ForEach-Object {
            Write-Host "----- $($_.Name) (tail) -----"
            Get-Content $_.FullName -Tail 60 | ForEach-Object { Write-Host $_ }
        }
        throw "vc_redist /layout exited with code $exitCode and produced $($msis.Count) MSI packages"
    }
    foreach ($msiFile in $msis) {
        $msiOut = Join-Path $ExtractRoot ("msi_" + $msiFile.BaseName)
        New-Item -ItemType Directory -Force -Path $msiOut | Out-Null
        Write-Host "Administrative install of $($msiFile.Name)"
        $exitCode = Invoke-Quiet -FilePath "msiexec.exe" -ArgumentList @("/a", "`"$($msiFile.FullName)`"", "/qn", "TARGETDIR=`"$msiOut`"")
        if ($exitCode -ne 0) {
            Write-Warning "msiexec /a $($msiFile.Name) exited with code $exitCode"
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

# Prefer Visual Studio 2022's Microsoft.VC143.CRT (the CI job runs on windows-2022). Unpacking
# vc_redist only works where the machine's own VC++ runtime is not newer than the bundle; otherwise
# Burn marks every package obsolete and lays out nothing.
$crtDir = Find-VcRedistCrtDirFromVisualStudio
if (-not $crtDir) {
    Write-Warning "No Microsoft.VC14x.CRT under Visual Studio; unpacking vc_redist.x64.exe"
    $crtDir = Extract-VcRedistCrtDir -VcRedistPath $vcRedistPath -ExtractRoot $workDir
}
if (-not $crtDir) {
    throw "Could not locate vcruntime140.dll / msvcp140.dll from vc_redist.x64.exe or Visual Studio redistributables"
}

$ucrtDir = Find-UcrtDir
Write-Host "VC++ CRT: $crtDir"
Write-Host "UCRT:     $ucrtDir"

Copy-Item -Path (Join-Path $crtDir "*.dll") -Destination $OutputDir -Force
Copy-Item -Path (Join-Path $ucrtDir "*.dll") -Destination $OutputDir -Force

# Microsoft Download Center, "Update for Windows 7 for x64-based Systems (KB2999226)", id=49093.
# The old download.windowsupdate.com path now 404s. The installer verification step requires this
# file, so a failed or altered download stops the build instead of being skipped.
$kbUrl = "https://download.microsoft.com/download/1/1/5/11565a9a-ea09-4f0a-a57e-520d5d138140/Windows6.1-KB2999226-x64.msu"
$kbSha256 = "43234D2986CA9B0DE75D5183977964D161A8395C3396279DDFC9B20698E5BC34"
$kbPath = Join-Path $OutputDir "Windows6.1-KB2999226-x64.msu"
Write-Host "Downloading Universal CRT update KB2999226"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
for ($attempt = 1; $attempt -le 3; $attempt++) {
    try {
        Invoke-WebRequest -Uri $kbUrl -OutFile $kbPath -UseBasicParsing
        break
    } catch {
        if ($attempt -eq 3) { throw "KB2999226 download failed after 3 attempts: $_" }
        Write-Warning "KB2999226 download attempt $attempt failed: $_"
        Start-Sleep -Seconds (5 * $attempt)
    }
}
$kbHash = (Get-FileHash -Path $kbPath -Algorithm SHA256).Hash
if ($kbHash -ne $kbSha256) {
    throw "KB2999226 checksum mismatch: expected $kbSha256, got $kbHash"
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
    "vc_redist.x64.exe",
    "Windows6.1-KB2999226-x64.msu"
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
