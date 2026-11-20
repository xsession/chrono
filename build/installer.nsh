; Chrono NSIS additions: TortoiseGit-style Explorer submenu (per user, HKCU).
; Mirrors shell-integration/windows/install-context-menu.ps1 so the menu is
; available right after installation and removed on uninstall.

!macro ChronoMenuRoot ROOT ARG
  WriteRegStr HKCU "Software\Classes\${ROOT}\shell\Chrono" "MUIVerb" "Chrono"
  WriteRegStr HKCU "Software\Classes\${ROOT}\shell\Chrono" "SubCommands" ""
  WriteRegStr HKCU "Software\Classes\${ROOT}\shell\Chrono" "Icon" '"$INSTDIR\Chrono.exe",0'
  !insertmacro ChronoMenuItem "${ROOT}" "01commit" "Git Commit…" "commit" "${ARG}"
  !insertmacro ChronoMenuItem "${ROOT}" "02log" "Show log" "log" "${ARG}"
  !insertmacro ChronoMenuItem "${ROOT}" "03diff" "Diff" "diff" "${ARG}"
  !insertmacro ChronoMenuItem "${ROOT}" "04diffprev" "Diff with previous version" "diffprev" "${ARG}"
  !insertmacro ChronoMenuItem "${ROOT}" "05blame" "Blame" "blame" "${ARG}"
  !insertmacro ChronoMenuItem "${ROOT}" "06modifications" "Check for modifications" "modifications" "${ARG}"
  !insertmacro ChronoMenuItem "${ROOT}" "07revert" "Revert…" "revert" "${ARG}"
  !insertmacro ChronoMenuItem "${ROOT}" "08add" "Add…" "add" "${ARG}"
  !insertmacro ChronoMenuItem "${ROOT}" "09resolve" "Resolve" "resolve" "${ARG}"
  !insertmacro ChronoMenuItem "${ROOT}" "10cleanup" "Clean up…" "cleanup" "${ARG}"
  !insertmacro ChronoMenuItem "${ROOT}" "11stash" "Stash save…" "stash" "${ARG}"
  !insertmacro ChronoMenuItem "${ROOT}" "12patch" "Create patch…" "patch" "${ARG}"
  !insertmacro ChronoMenuItem "${ROOT}" "13sync" "Git Sync…" "sync" "${ARG}"
  !insertmacro ChronoMenuItem "${ROOT}" "14properties" "Properties" "properties" "${ARG}"
  !insertmacro ChronoMenuItem "${ROOT}" "15explore" "Open in Chrono Explorer" "explore" "${ARG}"
  !insertmacro ChronoMenuItem "${ROOT}" "16graph" "Show in Chrono graph" "graph" "${ARG}"
  !insertmacro ChronoMenuItem "${ROOT}" "17terminal" "Open Git terminal here" "terminal" "${ARG}"
!macroend

!macro ChronoMenuItem ROOT KEY LABEL ACTION ARG
  WriteRegStr HKCU "Software\Classes\${ROOT}\shell\Chrono\shell\${KEY}" "MUIVerb" "${LABEL}"
  WriteRegStr HKCU "Software\Classes\${ROOT}\shell\Chrono\shell\${KEY}\command" "" '"$INSTDIR\Chrono.exe" --tgit=${ACTION} "${ARG}"'
!macroend

!macro customInstall
  !insertmacro ChronoMenuRoot "*" "%1"
  !insertmacro ChronoMenuRoot "Directory" "%1"
  !insertmacro ChronoMenuRoot "Directory\Background" "%V"
!macroend

!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\*\shell\Chrono"
  DeleteRegKey HKCU "Software\Classes\Directory\shell\Chrono"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\Chrono"
!macroend
