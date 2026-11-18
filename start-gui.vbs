' Launch bot-console with no console window, then open it in an app-style window.
' Double-click this file. The server keeps running after you close the window;
' use the "close service" button in the page (or stop-gui.vbs) to stop it.
Option Explicit

Dim fso, shell, root, tokenFile, token, url, i, edge, chrome
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
root = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = root

Function IsUp()
  Dim req
  IsUp = False
  On Error Resume Next
  Set req = CreateObject("MSXML2.XMLHTTP")
  req.Open "GET", "http://127.0.0.1:8787/healthz", False
  req.Send
  If Err.Number = 0 Then
    If req.Status = 200 Then IsUp = True
  End If
  On Error GoTo 0
End Function

If Not IsUp() Then
  shell.Run "cmd /c """"" & root & "\start.bat"""" --no-open", 0, False
  For i = 1 To 30
    WScript.Sleep 500
    If IsUp() Then Exit For
  Next
End If

If Not IsUp() Then
  MsgBox "??????????????? Node 20+?", vbCritical, "bot-console"
  WScript.Quit 1
End If

tokenFile = root & "\.token"
If Not fso.FileExists(tokenFile) Then
  MsgBox "??? .token???????????", vbCritical, "bot-console"
  WScript.Quit 1
End If
Dim ts
Set ts = fso.OpenTextFile(tokenFile, 1)
token = Trim(ts.ReadAll)
ts.Close

url = "http://127.0.0.1:8787/?token=" & token

edge = shell.ExpandEnvironmentStrings("%ProgramFiles(x86)%") & "\Microsoft\Edge\Application\msedge.exe"
chrome = shell.ExpandEnvironmentStrings("%ProgramFiles%") & "\Google\Chrome\Application\chrome.exe"
If fso.FileExists(edge) Then
  shell.Run """" & edge & """ --app=" & url, 1, False
ElseIf fso.FileExists(chrome) Then
  shell.Run """" & chrome & """ --app=" & url, 1, False
Else
  shell.Run url, 1, False
End If
