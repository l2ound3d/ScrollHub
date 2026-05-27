# ScrollHub

A lightweight CBZ comic reader for Windows, built with Rust and Tauri.

## Features

- Open `.cbz` files and folder libraries
- Single, double-page, and webtoon scroll reading modes
- Fit width / height / original
- Reading progress saved per comic
- Minimal UI with hideable chrome

## Development

```bash
npm install
npm run tauri dev
```

## Build

```bash
npm run tauri build
```

Portable executable: `src-tauri/target/release/scrollhub.exe`

## Requirements

- Node.js 20+
- Rust (stable)
- Visual Studio C++ Build Tools (Windows)
- WebView2 runtime (usually preinstalled on Windows 10/11)
