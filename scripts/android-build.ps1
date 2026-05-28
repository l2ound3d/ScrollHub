# Build ScrollHub Android APK on Windows without Developer Mode / symlink privileges.
# Uses a hard link for the native library and Gradle with Rust tasks skipped.

$ErrorActionPreference = "Stop"

$env:ANDROID_HOME = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { "$env:LOCALAPPDATA\Android\Sdk" }
$env:NDK_HOME = if ($env:NDK_HOME) { $env:NDK_HOME } else { "$env:ANDROID_HOME\ndk\26.1.10909125" }
$env:JAVA_HOME = if ($env:JAVA_HOME) { $env:JAVA_HOME } else { "C:\Program Files\Microsoft\jdk-17.0.19.10-hotspot" }

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

Write-Host "Building frontend..."
npm run build

Write-Host "Building Rust library for aarch64 (embeds frontend via custom-protocol)..."
Push-Location src-tauri
cargo build --release --target aarch64-linux-android --lib --features "tauri/custom-protocol"
Pop-Location

$src = Join-Path $root "src-tauri\target\aarch64-linux-android\release\libscrollhub_lib.so"
$destDir = Join-Path $root "src-tauri\gen\android\app\src\main\jniLibs\arm64-v8a"
$dest = Join-Path $destDir "libscrollhub_lib.so"
New-Item -ItemType Directory -Force -Path $destDir | Out-Null
Remove-Item $dest -Force -ErrorAction SilentlyContinue
cmd /c mklink /H "$dest" "$src" | Out-Null
Write-Host "Linked native library into jniLibs"

$assetDir = Join-Path $root "src-tauri\gen\android\app\src\main\assets"
New-Item -ItemType Directory -Force -Path $assetDir | Out-Null
Copy-Item (Join-Path $root "src-tauri\tauri.conf.json") (Join-Path $assetDir "tauri.conf.json") -Force

Write-Host "Running Gradle (universal release APK)..."
Push-Location src-tauri\gen\android
.\gradlew.bat assembleUniversalRelease `
  -x rustBuildUniversalRelease `
  -x rustBuildArm64Release `
  -x rustBuildArmRelease `
  -x rustBuildX86Release `
  -x rustBuildX86_64Release
Pop-Location

$apkSrc = Join-Path $root "src-tauri\gen\android\app\build\outputs\apk\universal\release\app-universal-release-unsigned.apk"
$apkOutDir = Join-Path $root "src-tauri\target\android"
New-Item -ItemType Directory -Force -Path $apkOutDir | Out-Null
$apkDest = Join-Path $apkOutDir "ScrollHub-universal-unsigned.apk"
Copy-Item $apkSrc $apkDest -Force

Write-Host ""
Write-Host "APK ready: $apkDest"
Write-Host "Install on a connected device: adb install -r `"$apkDest`""
