' Stop the bot-console service (windowless). Reads the token and calls /api/shutdown.
Option Explicit

Dim fso, shell, root, tokenFile, token, req, ts
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
root = fso.GetParentFolderName(WScript.ScriptFullName)
tokenFile = root & "\.token"

If Not fso.FileExists(tokenFile) Then
  MsgBox "??????????? .token??", vbInformation, "bot-console"
  WScript.Quit 0
End If

Set ts = fso.OpenTextFile(tokenFile, 1)
token = Trim(ts.ReadAll)
ts.Close

On Error Resume Next
Set req = CreateObject("MSXML2.XMLHTTP")
req.Open "POST", "http://127.0.0.1:8787/api/shutdown", False
req.setRequestHeader "x-token", token
req.Send
If Err.Number <> 0 Then
  MsgBox "????????", vbInformation, "bot-console"
ElseIf req.Status = 200 Then
  MsgBox "????????????????", vbInformation, "bot-console"
Else
  MsgBox "?????????" & req.Status, vbExclamation, "bot-console"
End If
On Error GoTo 0
