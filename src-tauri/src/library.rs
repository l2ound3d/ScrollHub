use serde::Serialize;
use std::fs;
use std::path::Path;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryEntry {
    pub name: String,
    pub path: String,
    pub kind: String,
}

pub fn list_directory(folder: &Path, folders_only: bool) -> Result<Vec<LibraryEntry>, String> {
    if !folder.is_dir() {
        return Err("Path is not a folder.".into());
    }

    let mut folders = Vec::new();
    let mut comics = Vec::new();

    for entry in fs::read_dir(folder).map_err(|e| format!("Failed to read folder: {e}"))? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();

        if path.is_dir() {
            folders.push(LibraryEntry {
                name,
                path: path.to_string_lossy().into_owned(),
                kind: "folder".into(),
            });
        } else if !folders_only && path.is_file() {
            if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                if ext.eq_ignore_ascii_case("cbz") {
                    comics.push(LibraryEntry {
                        name,
                        path: path.to_string_lossy().into_owned(),
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
