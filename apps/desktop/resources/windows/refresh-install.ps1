# Runs on every packaged launch and after an update applies.
#
# Squirrel keeps every installed app-<version> folder and leaves the previous
# build running. Both copies register the same AppUserModelID, so Explorer can
# keep drawing the old build's taskbar artwork. Keep the newest build plus its
# immediate predecessor: one icon wins, and the previous build stays available
# for the in-app rollback.
param(
  [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA "UsageAtlas"),
  [string]$CurrentExe = ""
)

$ErrorActionPreference = "SilentlyContinue"
if (-not (Test-Path -LiteralPath $InstallRoot)) { exit 0 }

$builds = Get-ChildItem -LiteralPath $InstallRoot -Directory |
  Where-Object { $_.Name -match '^app-\d+\.\d+\.\d+' } |
  Sort-Object { [version]($_.Name -replace '^app-', '') } -Descending
if ($builds.Count -eq 0) { exit 0 }

$newest = $builds[0]
$newestExe = Join-Path $newest.FullName "UsageAtlas.exe"
if (-not (Test-Path -LiteralPath $newestExe)) { exit 0 }

# Never stop the process that asked for the cleanup. Everything else under this
# install root is a previous build, including copies Explorer started earlier.
$current = if ($CurrentExe) { [System.IO.Path]::GetFullPath($CurrentExe) } else { "" }
Get-CimInstance Win32_Process -Filter "Name = 'UsageAtlas.exe'" |
  Where-Object {
    $_.ExecutablePath -and
    $_.ExecutablePath.StartsWith($InstallRoot, [System.StringComparison]::OrdinalIgnoreCase) -and
    [System.IO.Path]::GetFullPath($_.ExecutablePath) -ne $current
  } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Start-Sleep -Milliseconds 900

$keep = @($builds[0].FullName)
if ($builds.Count -gt 1) { $keep += $builds[1].FullName }
# Never delete the folder the running window came from, even after a rollback.
if ($CurrentExe) {
  $currentDir = Split-Path -Parent ([System.IO.Path]::GetFullPath($CurrentExe))
  if ($keep -notcontains $currentDir) { $keep += $currentDir }
}
foreach ($build in $builds) {
  if ($keep -contains $build.FullName) { continue }
  Remove-Item -LiteralPath $build.FullName -Recurse -Force
}

# Every shortcut and the taskbar button read one stable ICO beside the build
# folders. Refresh it from the build that is about to start, so the shell shows
# the new artwork even before the app rewrites its shortcuts, and a shortcut can
# never point into an `app-<version>` folder this script is about to delete.
$icon = Join-Path $newest.FullName "resources\icons\usageatlas.ico"
$stableIcon = Join-Path $InstallRoot "app.ico"
if (Test-Path -LiteralPath $icon) {
  try { Copy-Item -LiteralPath $icon -Destination $stableIcon -Force } catch { }
}

# A development launch drops an `Electron.lnk` in the Start Menu pointing at the
# raw Electron binary. Nothing ever removes it, and its atom artwork is part of
# what the shell resolved for this app before the brand mark existed.
foreach ($stray in @("$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Electron.lnk")) {
  if (Test-Path -LiteralPath $stray) { Remove-Item -LiteralPath $stray -Force }
}

# Explorer caches icons per AppUserModelID. `-show` rewrites the cache files and
# asks the shell to re-read them; without it an update can keep the previous
# build's artwork for a while even though the file on disk is correct.
try { ie4uinit.exe -show } catch { }

# Installers send SHCNE_ASSOCCHANGED once they have written new artwork. It is
# what makes the shell drop the icon it resolved for an app identity earlier in
# the session, which `ie4uinit -show` alone does not always do.
try {
  Add-Type -Namespace Shell32 -Name Native -MemberDefinition '[DllImport("shell32.dll")] public static extern void SHChangeNotify(int eventId, uint flags, System.IntPtr item1, System.IntPtr item2);' -ErrorAction Stop
  [Shell32.Native]::SHChangeNotify(0x08000000, 0x1000, [System.IntPtr]::Zero, [System.IntPtr]::Zero)
} catch { }
