# Creates a "PhoneCam" shortcut on the Desktop and (optionally) starts the
# PhoneCam server automatically, minimized, when you log in to Windows.
#
#   powershell -ExecutionPolicy Bypass -File install-shortcuts.ps1             # both
#   powershell -ExecutionPolicy Bypass -File install-shortcuts.ps1 -NoStartup  # desktop only
#   powershell -ExecutionPolicy Bypass -File install-shortcuts.ps1 -Remove     # undo

param([switch]$NoStartup, [switch]$Remove)

$root = $PSScriptRoot
$bat = Join-Path $root 'start.bat'
$icon = Join-Path $root 'phonecam.ico'
$desktopLink = Join-Path ([Environment]::GetFolderPath('Desktop')) 'PhoneCam.lnk'
$startupLink = Join-Path ([Environment]::GetFolderPath('Startup')) 'PhoneCam.lnk'

if ($Remove) {
  Remove-Item $desktopLink, $startupLink -ErrorAction SilentlyContinue
  Write-Host 'PhoneCam shortcuts removed.'
  return
}

# Icon: a .ico that wraps the extension's 128px PNG (Windows accepts PNG inside ICO).
if (-not (Test-Path $icon)) {
  $png = [IO.File]::ReadAllBytes((Join-Path $root 'extension\public\icons\icon128.png'))
  $ms = New-Object IO.MemoryStream
  $w = New-Object IO.BinaryWriter $ms
  $w.Write([UInt16]0); $w.Write([UInt16]1); $w.Write([UInt16]1)          # header: icon, 1 image
  $w.Write([Byte]128); $w.Write([Byte]128); $w.Write([Byte]0); $w.Write([Byte]0)
  $w.Write([UInt16]1); $w.Write([UInt16]32)                               # planes, bpp
  $w.Write([UInt32]$png.Length); $w.Write([UInt32]22)                     # size, offset
  $w.Write($png)
  [IO.File]::WriteAllBytes($icon, $ms.ToArray())
}

$shell = New-Object -ComObject WScript.Shell

function New-Link($path, $arguments, $windowStyle) {
  $link = $shell.CreateShortcut($path)
  $link.TargetPath = $bat
  $link.Arguments = $arguments
  $link.WorkingDirectory = $root
  $link.IconLocation = $icon
  $link.WindowStyle = $windowStyle   # 1 = normal, 7 = minimized
  $link.Description = 'PhoneCam - use your phone as a webcam in Google Meet'
  $link.Save()
}

New-Link $desktopLink '' 7
Write-Host "Desktop shortcut: $desktopLink"

if (-not $NoStartup) {
  New-Link $startupLink '--background' 7
  Write-Host "Starts with Windows: $startupLink"
}
