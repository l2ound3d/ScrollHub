use std::io::copy;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::AppHandle;
use tauri::Manager;

#[cfg(target_os = "android")]
use crate::android_uri::progress_storage_key;
#[cfg(target_os = "android")]
use tauri_plugin_android_fs::{AndroidFsExt, FileUri};

use crate::smb_library::{self, SmbState};

static ACTIVE_CACHE_FILE: Mutex<Option<PathBuf>> = Mutex::new(None);

fn cbz_cache_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("cbz-cache"))
}

fn is_under_cbz_cache(app: &AppHandle, path: &Path) -> bool {
    cbz_cache_dir(app)
        .ok()
        .and_then(|dir| path.strip_prefix(dir).ok())
        .is_some()
}

fn drop_cached_file() {
    let Ok(mut guard) = ACTIVE_CACHE_FILE.lock() else {
        return;
    };
    if let Some(prev) = guard.take() {
        let _ = std::fs::remove_file(prev);
    }
}

fn activate_cache_file(cache_path: PathBuf) {
    let Ok(mut guard) = ACTIVE_CACHE_FILE.lock() else {
        return;
    };
    if let Some(prev) = guard.as_ref() {
        if prev != &cache_path {
            let _ = std::fs::remove_file(prev);
        }
    }
    *guard = Some(cache_path);
}

fn finish_resolved_path(app: &AppHandle, resolved: PathBuf) -> PathBuf {
    if is_under_cbz_cache(app, &resolved) {
        activate_cache_file(resolved.clone());
    } else {
        drop_cached_file();
    }
    resolved
}

fn is_content_uri(path: &str) -> bool {
    path.starts_with("content://")
}

fn cache_key(path: &str) -> String {
    #[cfg(target_os = "android")]
    {
        if let Some(stable) = progress_storage_key(path).strip_prefix("content-doc:") {
            use std::collections::hash_map::DefaultHasher;
            use std::hash::{Hash, Hasher};
            let mut hasher = DefaultHasher::new();
            stable.hash(&mut hasher);
            return format!("{:016x}", hasher.finish());
        }
    }

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
pub fn file_uri(path: &str) -> FileUri {
    FileUri {
        uri: path.to_string(),
        document_top_tree_uri: None,
    }
}

#[cfg(target_os = "android")]
pub fn resolve_read_path(app: &AppHandle, path: &str) -> Result<PathBuf, String> {
    if smb_library::is_smb_path(path) {
        let state = app.state::<SmbState>();
        let dest = tauri::async_runtime::block_on(state.download_to_cache(app, path))?;
        return Ok(finish_resolved_path(app, dest));
    }
    if !is_content_uri(path) {
        return Ok(finish_resolved_path(app, PathBuf::from(path)));
    }

    let uri = file_uri(path);
    let api = app.android_fs();
    let cache_dir = cbz_cache_dir(app)?;
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

    Ok(finish_resolved_path(app, dest))
}

#[cfg(not(target_os = "android"))]
pub fn resolve_read_path(app: &AppHandle, path: &str) -> Result<PathBuf, String> {
    if smb_library::is_smb_path(path) {
        let state = app.state::<SmbState>();
        let dest = tauri::async_runtime::block_on(state.download_to_cache(app, path))?;
        return Ok(finish_resolved_path(app, dest));
    }
    Ok(finish_resolved_path(app, PathBuf::from(path)))
}

pub fn display_title_for_path(app: &AppHandle, path: &str, fallback: &str) -> String {
    if smb_library::is_smb_path(path) {
        return smb_library::display_title_for_smb_path(path);
    }

    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        return fallback.to_string();
    }

    #[cfg(target_os = "android")]
    {
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
}
