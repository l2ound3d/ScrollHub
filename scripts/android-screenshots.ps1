# Capture ScrollHub phone screenshots for Google Play.
# Open each screen on your phone, then press Enter here to capture.

$ErrorActionPreference = "Stop"

$adb = if ($env:ADB) { $env:ADB } else { "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe" }
$serial = if ($env:ADB_SERIAL) { $env:ADB_SERIAL } else { "R3CT208P52P" }
$root = Split-Path -Parent $PSScriptRoot
$outDir = Join-Path $root "store-assets\phone-screenshots"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$shots = @(
    @{ File = "01-library.png"; Hint = "Library with CBZ files listed" },
    @{ File = "02-reader-single.png"; Hint = "Single-page reading (portrait, chrome hidden if possible)" },
    @{ File = "03-reader-double.png"; Hint = "Double-page spread (rotate phone to landscape)" },
    @{ File = "04-webtoon.png"; Hint = "Webtoon scroll mode (optional)" },
    @{ File = "05-settings.png"; Hint = "Settings screen (optional)" }
)

Write-Host "ScrollHub Play Store screenshot capture"
Write-Host "Output: $outDir"
Write-Host ""
Write-Host "Google Play phone screenshots:"
Write-Host "  - Upload 2 to 8 images"
Write-Host "  - PNG or JPEG, each side 320-3840 px"
Write-Host "  - Portrait 9:16 works best (e.g. 1080x1920)"
Write-Host ""

function Invoke-Capture([string]$fileName) {
    $remote = "/sdcard/scrollhub_store_cap.png"
    $local = Join-Path $outDir $fileName
    & $adb -s $serial shell screencap -p $remote | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "screencap failed" }
    & $adb -s $serial pull $remote $local | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "adb pull failed" }
    $item = Get-Item $local
    Add-Type -AssemblyName System.Drawing
    $img = [System.Drawing.Image]::FromFile($item.FullName)
    try {
        $w = $img.Width
        $h = $img.Height
        $targetRatio = 16.0 / 9.0
        $currentRatio = $h / [double]$w
        if ($currentRatio -gt $targetRatio + 0.01) {
            $cropH = [int][Math]::Round($w * $targetRatio)
            $cropY = [int][Math]::Round(($h - $cropH) / 2.0)
            $crop = New-Object System.Drawing.Bitmap $w, $cropH
            $g = [System.Drawing.Graphics]::FromImage($crop)
            try {
                $g.DrawImage($img, 0, 0, (New-Object System.Drawing.Rectangle 0, $cropY, $w, $cropH), [System.Drawing.GraphicsUnit]::Pixel)
                $playPath = [System.IO.Path]::ChangeExtension($local, ".play.png")
                $crop.Save($playPath, [System.Drawing.Imaging.ImageFormat]::Png)
                Write-Host "  Play-ready 9:16 crop: $playPath ($w x $cropH)"
            } finally {
                $g.Dispose()
                $crop.Dispose()
            }
        }
        Write-Host "  Saved: $local ($w x $h)"
    } finally {
        $img.Dispose()
    }
}

foreach ($shot in $shots) {
    Write-Host ""
    Write-Host "Next: $($shot.Hint)"
    $key = Read-Host "Press Enter to capture (or type s to skip, q to quit)"
    if ($key -eq "q") { break }
    if ($key -eq "s") { continue }
    Invoke-Capture $shot.File
}

Write-Host ""
Write-Host "Done. Upload the *.play.png files (or raw PNGs) to Play Console > Store listing > Phone screenshots."
