; Kraki for Windows: the built-in Kraki's login entry (see src/tentacle.cjs).

; After an install or update (which stops every Kraki process): start the
; background Kraki again right away when the user had it on. The installer is
; a 32-bit process, so `conhost.exe` from the login entry would resolve to a
; SysWOW64 copy that does not exist; start kraki.exe itself, hidden.
!macro customInstall
  ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Kraki Background"
  ${if} $0 != ""
    ExecShell "" "$INSTDIR\resources\kraki\kraki.exe" "__daemon-worker --managed-by=kraki-windows" SW_HIDE
  ${endIf}
!macroend

; A real uninstall (not the old version's uninstaller during an update):
; drop the login entry so it never points at a removed program.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Kraki Background"
  ${endIf}
!macroend
