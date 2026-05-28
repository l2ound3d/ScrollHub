mod cbz;
#[cfg(target_os = "android")]
mod android_library;
mod library;
mod path_resolver;
mod progress;
mod settings;
mod smb_library;

use cbz::{get_page_data, open_cbz, ComicMeta, PageData};
use library::{list_directory, LibraryEntry};
use settings::{load_settings, save_settings, AppSettings};
use smb_library::{SmbState, SMB_PREFIX};
use std::path::PathBuf;
use tauri::Manager;
use tauri::State;

#[tauri::command]
fn open_cbz_file(app: tauri::AppHandle, path: String) -> Result<ComicMeta, String> {
    let read_path = path_resolver::resolve_read_path(&app, &path)?;
    let mut meta = open_cbz(read_path.as_path())?;
    let title = path_resolver::display_title_for_path(&app, &path, &meta.title);
    meta.title = title;
    meta.path = path;
    Ok(meta)
}

#[tauri::command]
fn get_page(app: tauri::AppHandle, path: String, index: usize) -> Result<PageData, String> {
    let read_path = path_resolver::resolve_read_path(&app, &path)?;
    get_page_data(read_path.as_path(), index)
}

#[tauri::command]
async fn smb_connect(
    host: String,
    username: String,
    password: String,
    state: State<'_, SmbState>,
) -> Result<Vec<LibraryEntry>, String> {
    state
        .connect_and_list_shares(host.trim(), username.trim(), password.as_str())
        .await
}

#[tauri::command]
async fn smb_list_directory(
    path: String,
    folders_only: bool,
    state: State<'_, SmbState>,
) -> Result<Vec<LibraryEntry>, String> {
    state.list_directory(&path, folders_only).await
}

#[tauri::command]
async fn smb_disconnect(state: State<'_, SmbState>) -> Result<(), String> {
    state.disconnect().await
}

#[tauri::command]
fn pick_cbz_file(app: tauri::AppHandle) -> Result<Option<String>, String> {
    #[cfg(target_os = "android")]
    {
        return android_library::pick_cbz(&app);
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Err("Use the desktop file dialog instead.".into())
    }
}

#[tauri::command]
fn list_library_directory(
    app: tauri::AppHandle,
    path: String,
    folders_only: bool,
    state: State<'_, SmbState>,
) -> Result<Vec<LibraryEntry>, String> {
    if path.starts_with(SMB_PREFIX) {
        return tauri::async_runtime::block_on(state.list_directory(&path, folders_only));
    }
    if path.starts_with("content://") {
        #[cfg(target_os = "android")]
        {
            return android_library::list_directory(&app, &path, folders_only);
        }
        #[cfg(not(target_os = "android"))]
        {
            return Err("Content folder paths are only supported on Android.".into());
        }
    }
    list_directory(PathBuf::from(path).as_path(), folders_only)
}

#[tauri::command]
fn get_platform() -> String {
    if cfg!(target_os = "android") {
        "android".into()
    } else if cfg!(target_os = "ios") {
        "ios".into()
    } else {
        "desktop".into()
    }
}

#[tauri::command]
fn pick_library_folder(app: tauri::AppHandle) -> Result<Option<String>, String> {
    #[cfg(target_os = "android")]
    {
        return android_library::pick_folder(&app);
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Err("Use the desktop folder dialog instead.".into())
    }
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
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init());

    #[cfg(target_os = "android")]
    {
        builder = builder.plugin(tauri_plugin_android_fs::init());
    }

    builder
        .manage(SmbState::default())
        .invoke_handler(tauri::generate_handler![
            open_cbz_file,
            get_page,
            list_library_directory,
            get_platform,
            pick_library_folder,
            pick_cbz_file,
            smb_connect,
            smb_list_directory,
            smb_disconnect,
            get_progress,
            save_progress,
            get_settings,
            save_settings_cmd,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
