use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct ProgressStore {
    pages: HashMap<String, u32>,
}

fn store_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("progress.json")
}

fn load_store(app_data_dir: &Path) -> ProgressStore {
    let path = store_path(app_data_dir);
    if !path.exists() {
        return ProgressStore::default();
    }

    fs::read_to_string(path)
        .ok()
        .and_then(|content| serde_json::from_str(&content).ok())
        .unwrap_or_default()
}

fn save_store(app_data_dir: &Path, store: &ProgressStore) -> Result<(), String> {
    fs::create_dir_all(app_data_dir).map_err(|e| e.to_string())?;
    let content = serde_json::to_string_pretty(store).map_err(|e| e.to_string())?;
    fs::write(store_path(app_data_dir), content).map_err(|e| e.to_string())
}

pub fn get_progress(app_data_dir: &Path, comic_path: &str) -> Option<u32> {
    let store = load_store(app_data_dir);
    store.pages.get(comic_path).copied()
}

pub fn save_progress(app_data_dir: &Path, comic_path: &str, page: u32) -> Result<(), String> {
    let mut store = load_store(app_data_dir);
    store.pages.insert(comic_path.to_string(), page);
    save_store(app_data_dir, &store)
}
