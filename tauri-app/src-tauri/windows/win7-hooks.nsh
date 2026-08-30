; Windows 7 NSIS hooks for FPSMaster Launcher.
;
; PREINSTALL runs before files are copied. POSTINSTALL runs after the app,
; WebView2 109 fixed runtime, and win7-runtime/* files are on disk.
;
; App-local VC++ / Universal CRT DLLs must end up next to the main exe.
; Microsoft documents that on Windows 7 the UCRT API-set forwarders cannot
; resolve ucrtbase.dll from a plugin subdirectory.

!ifndef WINVER_INCLUDED
  !include "WinVer.nsh"
!endif
!ifndef ___X64__NSH___
  !include "x64.nsh"
!endif

!macro NSIS_HOOK_PREINSTALL
  ${IfNot} ${RunningX64}
    MessageBox MB_OK|MB_ICONSTOP "FPSMaster Launcher (Win7) requires 64-bit Windows.$\r$\n启动器 Windows 7 版本仅支持 64 位系统。"
    Abort
  ${EndIf}

  ${IfNot} ${AtLeastWin7}
    MessageBox MB_OK|MB_ICONSTOP "FPSMaster Launcher requires Windows 7 SP1 x64 or later.$\r$\n启动器需要 64 位 Windows 7 SP1 或更新系统。"
    Abort
  ${EndIf}

  ${If} ${IsWin7}
  ${AndIfNot} ${AtLeastServicePack} 1
    MessageBox MB_OK|MB_ICONSTOP "Windows 7 Service Pack 1 is required (KB976932).$\r$\n请先安装 Windows 7 SP1（KB976932），再运行此安装程序。"
    Abort
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; 32-bit NSIS must read the native 64-bit registry view.
  SetRegView 64

  ${If} ${FileExists} "$INSTDIR\win7-runtime\ucrtbase.dll"
    DetailPrint "Copying app-local Universal CRT and VC++ runtime DLLs next to the launcher"
    CopyFiles /SILENT "$INSTDIR\win7-runtime\*.dll" "$INSTDIR"

    StrCpy $R9 "$INSTDIR\Microsoft.WebView2.FixedVersionRuntime.109.0.1518.78.x64"
    ${If} ${FileExists} "$R9\EBWebView\x64\EmbeddedBrowserWebView.dll"
      DetailPrint "Copying runtime DLLs into the bundled WebView2 109 folder"
      CopyFiles /SILENT "$INSTDIR\win7-runtime\*.dll" "$R9"
    ${EndIf}
  ${Else}
    DetailPrint "WARNING: win7-runtime DLLs were not bundled; launch may fail with missing api-ms-win-crt / vcruntime140"
  ${EndIf}

  ReadRegDWORD $R8 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\X64" "Installed"
  ${If} $R8 != 1
  ${AndIf} ${FileExists} "$INSTDIR\win7-runtime\vc_redist.x64.exe"
    UserInfo::GetAccountType
    Pop $R7
    ${If} $R7 == "Admin"
      DetailPrint "Installing Visual C++ 2015-2022 Redistributable (x64)"
      ExecWait '"$INSTDIR\win7-runtime\vc_redist.x64.exe" /install /quiet /norestart' $R6
      DetailPrint "VC++ redistributable exited with code $R6"
    ${Else}
      DetailPrint "Skipping VC++ redistributable (no Administrator rights); app-local DLLs remain in $INSTDIR"
    ${EndIf}
  ${Else}
    DetailPrint "Visual C++ 14.x runtime already present or redistributable not bundled"
  ${EndIf}

  ${If} ${IsWin7}
  ${AndIfNot} ${FileExists} "$SYSDIR\ucrtbase.dll"
  ${AndIf} ${FileExists} "$INSTDIR\win7-runtime\Windows6.1-KB2999226-x64.msu"
    UserInfo::GetAccountType
    Pop $R7
    ${If} $R7 == "Admin"
      DetailPrint "Installing Universal CRT update KB2999226"
      ExecWait 'wusa.exe "$INSTDIR\win7-runtime\Windows6.1-KB2999226-x64.msu" /quiet /norestart' $R6
      DetailPrint "KB2999226 exited with code $R6"
    ${Else}
      DetailPrint "Skipping KB2999226 (no Administrator rights); app-local UCRT DLLs remain in $INSTDIR"
    ${EndIf}
  ${EndIf}

  SetRegView lastused
!macroend

!macro NSIS_HOOK_PREUNINSTALL
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
!macroend
