use crate::library::LibraryEntry;
use tauri::AppHandle;
use tauri_plugin_android_fs::{AndroidFsExt, Entry, PublicDir, PublicGeneralPurposeDir};

use crate::path_resolver::file_uri;

fn library_folder_initial_location(app: &AppHandle) -> Option<tauri_plugin_android_fs::FileUri> {
    let api = app.android_fs();
    api.public_storage()
        .resolve_initial_location(
            None,
            PublicDir::GeneralPurpose(PublicGeneralPurposeDir::Documents),
            "ScrollHub",
            true,
        )
        .ok()
}

pub fn pick_folder(app: &AppHandle) -> Result<Option<String>, String> {
    let api = app.android_fs();
    let initial_location = library_folder_initial_location(app);
    let selected = api
        .file_picker()
        .pick_dir(initial_location.as_ref(), false)
        .map_err(|e| format!("Failed to open folder picker: {e}"))?;

    let Some(uri) = selected else {
        return Ok(None);
    };

    api.file_picker()
        .persist_uri_permission(&uri)
        .map_err(|e| format!("Failed to persist folder access: {e}"))?;

    Ok(Some(uri.uri))
}

pub fn pick_cbz(app: &AppHandle) -> Result<Option<String>, String> {
    let api = app.android_fs();
    let selected = api
        .file_picker()
        .pick_file(
            None,
            &["application/x-cbz", "application/vnd.comicbook+zip", "application/zip", "*/*"],
            false,
        )
        .map_err(|e| format!("Failed to open file picker: {e}"))?;

    let Some(uri) = selected else {
        return Ok(None);
    };

    api.file_picker()
        .persist_uri_permission(&uri)
        .map_err(|e| format!("Failed to persist file access: {e}"))?;

    Ok(Some(uri.uri))
}

pub fn list_directory(
    app: &AppHandle,
    path: &str,
    folders_only: bool,
) -> Result<Vec<LibraryEntry>, String> {
    let uri = file_uri(path);
    let api = app.android_fs();
    let entries = api
        .read_dir(&uri)
        .map_err(|e| format!("Failed to read folder: {e}"))?;

    let mut folders = Vec::new();
    let mut comics = Vec::new();

    for entry in entries {
        match entry {
            Entry::Dir { uri, name, .. } => {
                if name.starts_with('.') {
                    continue;
                }
                folders.push(LibraryEntry {
                    name,
                    path: uri.uri,
                    kind: "folder".into(),
                });
            }
            Entry::File { uri, name, mime_type, .. } => {
                if folders_only {
                    continue;
                }
                if name.starts_with('.') {
                    continue;
                }
                let is_cbz = name.to_lowercase().ends_with(".cbz")
                    || mime_type == "application/x-cbz"
                    || mime_type == "application/vnd.comicbook+zip";
                if is_cbz {
                    comics.push(LibraryEntry {
                        name,
                        path: uri.uri,
                        kind: "cbz".into(),
                    });
                }
            }
        }
    }

    folders.sort_by(|a, b| natord::compare(&a.name, &b.name));
    comics.sort_by(|a, b| natord::compare(&a.name, &b.name));
    folders.append(&mut comics);
    Ok(folders)
}

pub fn folder_display_name(app: &AppHandle, path: &str) -> Result<String, String> {
    let uri = file_uri(path);
    app.android_fs()
        .get_name(&uri)
        .map_err(|e| e.to_string())
}
