# Sync ScrollHub launcher icons into the generated Android project.
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$iconSrc = Join-Path $root "src-tauri\icons\android"
$resDest = Join-Path $root "src-tauri\gen\android\app\src\main\res"

if (-not (Test-Path $iconSrc)) {
    Write-Warning "Icon source not found: $iconSrc"
    exit 0
}

Get-ChildItem $iconSrc -Directory | Where-Object { $_.Name -like "mipmap*" } | ForEach-Object {
    $dest = Join-Path $resDest $_.Name
    New-Item -ItemType Directory -Force -Path $dest | Out-Null
    Copy-Item -Path (Join-Path $_.FullName "*") -Destination $dest -Force
}

$bgColorFile = Join-Path $iconSrc "values\ic_launcher_background.xml"
$colorsFile = Join-Path $resDest "values\colors.xml"
if ((Test-Path $bgColorFile) -and (Test-Path $colorsFile)) {
    $bgLine = Select-String -Path $bgColorFile -Pattern 'ic_launcher_background' | Select-Object -First 1
    if ($bgLine) {
        $colors = Get-Content $colorsFile -Raw
        if ($colors -notmatch "ic_launcher_background") {
            $insert = "    " + ($bgLine.Line.Trim()) + "`n"
            $colors = $colors -replace "</resources>", ($insert + "</resources>")
            Set-Content -Path $colorsFile -Value $colors -NoNewline
        }
    }
}

Write-Host "Synced Android launcher icons to $resDest"
