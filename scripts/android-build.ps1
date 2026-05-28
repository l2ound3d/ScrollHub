# Build ScrollHub Android APK on Windows without Developer Mode / symlink privileges.

$ErrorActionPreference = "Stop"

$env:ANDROID_HOME = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { "$env:LOCALAPPDATA\Android\Sdk" }
$env:NDK_HOME = if ($env:NDK_HOME) { $env:NDK_HOME } else { "$env:ANDROID_HOME\ndk\26.1.10909125" }
$env:JAVA_HOME = if ($env:JAVA_HOME) { $env:JAVA_HOME } else { "C:\Program Files\Microsoft\jdk-17.0.19.10-hotspot" }

$ndkBin = Join-Path $env:NDK_HOME "toolchains\llvm\prebuilt\windows-x86_64\bin"
$env:PATH = "$ndkBin;$env:PATH"
$clang = Join-Path $ndkBin "aarch64-linux-android21-clang.cmd"
$clangxx = Join-Path $ndkBin "aarch64-linux-android21-clang++.cmd"
$llvmAr = Join-Path $ndkBin "llvm-ar.exe"
$llvmRanlib = Join-Path $ndkBin "llvm-ranlib.exe"

$env:CC_aarch64_linux_android = $clang
$env:CXX_aarch64_linux_android = $clangxx
$env:AR_aarch64_linux_android = $llvmAr
$env:RANLIB_aarch64_linux_android = $llvmRanlib
$env:CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER = $clang
$env:CARGO_TARGET_AARCH64_LINUX_ANDROID_AR = $llvmAr

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Invoke-Checked([scriptblock]$Block, [string]$Label) {
    & $Block
    if ($LASTEXITCODE -ne 0) {
        throw "$Label failed with exit code $LASTEXITCODE"
    }
}

Write-Host "Syncing launcher icons..."
Invoke-Checked { powershell -ExecutionPolicy Bypass -File scripts/sync-android-icons.ps1 } "Icon sync"

Write-Host "Building frontend..."
Invoke-Checked { npm run build } "Frontend build"

Write-Host "Syncing web assets into Android APK assets..."
$assetDir = Join-Path $root "src-tauri\gen\android\app\src\main\assets"
if (Test-Path $assetDir) {
    Get-ChildItem $assetDir -Exclude "tauri.conf.json" | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
}
New-Item -ItemType Directory -Force -Path $assetDir | Out-Null
Copy-Item -Path (Join-Path $root "dist\*") -Destination $assetDir -Recurse -Force
Copy-Item (Join-Path $root "src-tauri\tauri.conf.json") (Join-Path $assetDir "tauri.conf.json") -Force

Write-Host "Building Rust library for aarch64 (force re-embed frontend)..."
Push-Location src-tauri
Invoke-Checked { cargo clean -p scrollhub } "Cargo clean"
Invoke-Checked { cargo build --release --target aarch64-linux-android --lib --features "tauri/custom-protocol" } "Cargo Android build"
Pop-Location

$src = Join-Path $root "src-tauri\target\aarch64-linux-android\release\libscrollhub_lib.so"
if (-not (Test-Path $src)) {
    throw "Missing native library: $src"
}
$destDir = Join-Path $root "src-tauri\gen\android\app\src\main\jniLibs\arm64-v8a"
$dest = Join-Path $destDir "libscrollhub_lib.so"
New-Item -ItemType Directory -Force -Path $destDir | Out-Null
Copy-Item -Path $src -Destination $dest -Force
Write-Host "Copied native library into jniLibs"

Write-Host "Running Gradle (universal release APK)..."
Push-Location src-tauri\gen\android
Invoke-Checked { .\gradlew.bat assembleUniversalRelease -x rustBuildUniversalRelease -x rustBuildArm64Release -x rustBuildArmRelease -x rustBuildX86Release -x rustBuildX86_64Release } "Gradle build"
Pop-Location

$apkSrc = Join-Path $root "src-tauri\gen\android\app\build\outputs\apk\universal\release\app-universal-release-unsigned.apk"
$apkOutDir = Join-Path $root "src-tauri\target\android"
New-Item -ItemType Directory -Force -Path $apkOutDir | Out-Null
$apkUnsigned = Join-Path $apkOutDir "ScrollHub-universal-unsigned.apk"
$apkSigned = Join-Path $apkOutDir "ScrollHub-universal-signed.apk"
Copy-Item $apkSrc $apkUnsigned -Force

Write-Host "Signing APK for sideload install..."
$ks = Join-Path $apkOutDir "scrollhub-debug.jks"
if (-not (Test-Path $ks)) {
    & "$env:JAVA_HOME\bin\keytool.exe" -genkeypair -v -keystore $ks -storepass scrollhub -keypass scrollhub `
        -alias scrollhub-debug -keyalg RSA -keysize 2048 -validity 10000 `
        -dname "CN=ScrollHub Debug, OU=Dev, O=ScrollHub, C=US"
}
$apksigner = Get-ChildItem -Path "$env:ANDROID_HOME\build-tools" -Recurse -Filter "apksigner.bat" |
    Sort-Object FullName -Descending | Select-Object -First 1
if (-not $apksigner) { throw "apksigner not found in Android SDK build-tools" }
Copy-Item $apkUnsigned $apkSigned -Force
& $apksigner.FullName sign --ks $ks --ks-pass pass:scrollhub --key-pass pass:scrollhub `
    --ks-key-alias scrollhub-debug --out $apkSigned $apkUnsigned
if ($LASTEXITCODE -ne 0) { throw "APK signing failed" }
& $apksigner.FullName verify $apkSigned | Out-Null
if ($LASTEXITCODE -ne 0) { throw "APK verification failed" }

Write-Host ""
Write-Host "Signed APK ready (install this one): $apkSigned"
Write-Host "Install on a connected device: adb install -r `"$apkSigned`""
