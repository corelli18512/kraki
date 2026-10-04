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
    ; Give the background service back to a separately installed CLI.
    nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -Command "$$h = if ($$env:KRAKI_HOME) { $$env:KRAKI_HOME } else { Join-Path $$env:USERPROFILE '.kraki' }; $$p = Join-Path $$h 'managed-by.json'; if ((Get-Content -Raw $$p -ErrorAction SilentlyContinue) -match '\"by\":\s*\"kraki-windows\"') { Remove-Item $$p }"`
    Pop $0
  ${endIf}
!macroend
