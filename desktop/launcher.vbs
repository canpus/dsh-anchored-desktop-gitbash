' Launch helper (0.4.2): run desktop\node.exe launcher.js HIDDEN (window
' style 0) so no console window ever shows — launcher.js pipes electron's
' output into launch.log. wscript is a GUI-subsystem binary: the bat returns
' immediately and nothing flashes.
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
Set sh = CreateObject("WScript.Shell")
sh.Run """" & dir & "\node.exe"" """ & dir & "\launcher.js""", 0, False
