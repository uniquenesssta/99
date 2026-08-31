!ifndef BUILD_UNINSTALLER
!include LogicLib.nsh

Var HfmInstallLockIsClear
Var HfmCleanupFindHandle
Var HfmCleanupFindName
Var HfmCleanInstallHadError

Function HfmProbeInstallFilesUnlocked
  StrCpy $HfmInstallLockIsClear "1"
  IfFileExists "$INSTDIR\字体管理器.exe" 0 hfmProbeDone

  Delete "$INSTDIR\字体管理器.exe.hfm-lock-test"
  ClearErrors
  Rename "$INSTDIR\字体管理器.exe" "$INSTDIR\字体管理器.exe.hfm-lock-test"
  IfErrors hfmProbeLocked

  ClearErrors
  Rename "$INSTDIR\字体管理器.exe.hfm-lock-test" "$INSTDIR\字体管理器.exe"
  IfErrors hfmProbeLocked
  Goto hfmProbeDone

hfmProbeLocked:
  StrCpy $HfmInstallLockIsClear "0"

hfmProbeDone:
FunctionEnd

Function HfmClearOldInstallRegistryForCleanInstall
  ; electron-builder 25 exposes UNINSTALL_APP_KEY, but does not expose
  ; INSTALL_REGISTRY_KEY / UNINSTALL_REGISTRY_KEY to included custom scripts.
  ; Use the concrete Windows uninstall registry path to avoid NSIS warning 6000.
  ClearErrors
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}"
  ClearErrors
  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}"
FunctionEnd

Function HfmPurgeOldInstallFilesForOverwrite
hfmPurgeRetry:
  StrCpy $HfmCleanInstallHadError "0"
  IfFileExists "$INSTDIR\*.*" 0 hfmPurgeDone

  DetailPrint "正在清理旧安装文件，并保留待迁移的 data 目录..."
  FindFirst $HfmCleanupFindHandle $HfmCleanupFindName "$INSTDIR\*"

hfmPurgeLoop:
  StrCmp $HfmCleanupFindName "" hfmPurgeClose
  StrCmp $HfmCleanupFindName "." hfmPurgeNext
  StrCmp $HfmCleanupFindName ".." hfmPurgeNext
  ; Keep the legacy in-install data directory. The app migrates it to
  ; %LOCALAPPDATA%\字体管理器\data on first launch of the new version.
  StrCmp $HfmCleanupFindName "data" hfmPurgeNext

  ClearErrors
  RMDir /r "$INSTDIR\$HfmCleanupFindName"
  IfErrors hfmTryDeleteFile hfmPurgeNext

hfmTryDeleteFile:
  ClearErrors
  Delete "$INSTDIR\$HfmCleanupFindName"
  IfErrors hfmMarkPurgeError hfmPurgeNext

hfmMarkPurgeError:
  StrCpy $HfmCleanInstallHadError "1"
  DetailPrint "旧安装文件删除失败：$INSTDIR\$HfmCleanupFindName"

hfmPurgeNext:
  FindNext $HfmCleanupFindHandle $HfmCleanupFindName
  Goto hfmPurgeLoop

hfmPurgeClose:
  FindClose $HfmCleanupFindHandle
  ${If} $HfmCleanInstallHadError == "1"
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "有旧安装文件仍被占用，无法继续覆盖。请关闭字体管理器以及 Photoshop、Illustrator 等可能占用临时字体或程序文件的软件，然后点击“重试”。安装器会在当前流程中继续，不需要重新打开。" IDRETRY hfmPurgeRetry IDCANCEL hfmAbortPurge
hfmAbortPurge:
    Abort
  ${EndIf}

hfmPurgeDone:
FunctionEnd

!macro customInit
  IfFileExists "$INSTDIR\字体管理器.exe" 0 hfmInstallOverwriteReady

  DetailPrint "正在检查已安装的字体管理器是否仍在运行..."
  nsExec::ExecToLog `"$INSTDIR\字体管理器.exe" --hfm-quit-for-install`
  Sleep 800

hfmInstallLockCheckLoop:
  ${For} $R8 1 40
    Call HfmProbeInstallFilesUnlocked
    ${If} $HfmInstallLockIsClear == "1"
      ${Break}
    ${EndIf}
    Sleep 500
  ${Next}

  ${If} $HfmInstallLockIsClear != "1"
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "检测到字体管理器仍在运行，安装程序不能安全覆盖正在使用的文件。请先退出字体管理器；如果正在使用临时激活字体，也请先关闭 Photoshop、Illustrator 等可能占用字体的软件，然后点击“重试”。安装器会继续等待并安装，不需要重新打开。" IDRETRY hfmRetryInstallOverwrite IDCANCEL hfmAbortInstallOverwrite

hfmRetryInstallOverwrite:
    nsExec::ExecToLog `"$INSTDIR\字体管理器.exe" --hfm-quit-for-install`
    Sleep 800
    Goto hfmInstallLockCheckLoop

hfmAbortInstallOverwrite:
    Abort
  ${EndIf}

hfmInstallOverwriteReady:
  IfFileExists "$INSTDIR\字体管理器.exe" 0 hfmInstallCleanDone
  Call HfmPurgeOldInstallFilesForOverwrite
  Call HfmClearOldInstallRegistryForCleanInstall

hfmInstallCleanDone:
!macroend
!endif
