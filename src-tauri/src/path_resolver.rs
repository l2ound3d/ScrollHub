use std::io::copy;
use std::path::{Path, PathBuf};
use tauri::AppHandle;
use tauri::Manager;

#[cfg(target_os = "android")]
use tauri_plugin_android_fs::{AndroidFsExt, FileUri};

fn is_content_uri(path: &str) -> bool {
    path.starts_with("content://")
}

fn cache_key(path: &str) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    let mut hasher = DefaultHasher::new();
    path.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

fn sanitize_filename(name: &str) -> String {
    name.chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            _ => c,
        })
        .collect()
}

#[cfg(target_os = "android")]
fn file_uri(path: &str) -> FileUri {
    FileUri {
        uri: path.to_string(),
        document_top_tree_uri: None,
    }
}

#[cfg(target_os = "android")]
pub fn resolve_read_path(app: &AppHandle, path: &str) -> Result<PathBuf, String> {
    if !is_content_uri(path) {
        return Ok(PathBuf::from(path));
    }

    let uri = file_uri(path);
    let api = app.android_fs();
    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("cbz-cache");
    std::fs::create_dir_all(&cache_dir).map_err(|e| e.to_string())?;

    let display_name = api
        .get_name(&uri)
        .unwrap_or_else(|_| "comic.cbz".to_string());
    let safe_name = sanitize_filename(&display_name);
    let dest = cache_dir.join(format!("{}_{}", cache_key(path), safe_name));

    if !dest.exists() {
        let mut src = api
            .open_file_readable(&uri)
            .map_err(|e| format!("Failed to open selected file: {e}"))?;
        let mut dest_file = std::fs::File::create(&dest)
            .map_err(|e| format!("Failed to cache CBZ file: {e}"))?;
        copy(&mut src, &mut dest_file).map_err(|e| format!("Failed to copy CBZ file: {e}"))?;
    }

    Ok(dest)
}

#[cfg(not(target_os = "android"))]
pub fn resolve_read_path(_app: &AppHandle, path: &str) -> Result<PathBuf, String> {
    Ok(PathBuf::from(path))
}

#[cfg(target_os = "android")]
pub fn display_title_for_path(app: &AppHandle, path: &str, fallback: &str) -> String {
    if !is_content_uri(path) {
        return fallback.to_string();
    }

    let uri = file_uri(path);
    let name = app
        .android_fs()
        .get_name(&uri)
        .unwrap_or_else(|_| fallback.to_string());

    Path::new(&name)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(fallback)
        .to_string()
}

#[cfg(not(target_os = "android"))]
pub fn display_title_for_path(_app: &AppHandle, _path: &str, fallback: &str) -> String {
    fallback.to_string()
}
