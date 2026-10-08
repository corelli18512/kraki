; Kraki for Windows: the built-in Kraki's login entry (see src/tentacle.cjs).

; After an install or update (which stops every Kraki process): when this PC
; was online, start Kraki again in the tray; it brings the service back up.
!macro customInstall
  ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Kraki Background"
  ${if} $0 != ""
    ExecShell "" "$INSTDIR\Kraki.exe" "--login"
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
