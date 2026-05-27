mod cbz;
mod library;
mod progress;
mod settings;

use cbz::{get_page_data, open_cbz, ComicMeta, PageData};
use library::{list_directory, LibraryEntry};
use settings::{load_settings, save_settings, AppSettings};
use std::path::PathBuf;
use tauri::Manager;

#[tauri::command]
fn open_cbz_file(path: String) -> Result<ComicMeta, String> {
    open_cbz(PathBuf::from(path).as_path())
}

#[tauri::command]
fn get_page(path: String, index: usize) -> Result<PageData, String> {
    get_page_data(PathBuf::from(path).as_path(), index)
}

#[tauri::command]
fn list_library_directory(path: String, folders_only: bool) -> Result<Vec<LibraryEntry>, String> {
    list_directory(PathBuf::from(path).as_path(), folders_only)
}

#[tauri::command]
fn get_progress(app: tauri::AppHandle, path: String) -> Result<Option<u32>, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    Ok(progress::get_progress(&app_data, &path))
}

#[tauri::command]
fn save_progress(app: tauri::AppHandle, path: String, page: u32) -> Result<(), String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    progress::save_progress(&app_data, &path, page)
}

#[tauri::command]
fn get_settings(app: tauri::AppHandle) -> Result<AppSettings, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    Ok(load_settings(&app_data))
}

#[tauri::command]
fn save_settings_cmd(app: tauri::AppHandle, settings: AppSettings) -> Result<(), String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    save_settings(&app_data, &settings)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            open_cbz_file,
            get_page,
            list_library_directory,
            get_progress,
            save_progress,
            get_settings,
            save_settings_cmd,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
