use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Serialize;
use std::fs::File;
use std::io::{BufReader, Read};
use std::path::Path;
use zip::ZipArchive;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComicMeta {
    pub path: String,
    pub title: String,
    pub page_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageData {
    pub index: usize,
    pub mime_type: String,
    pub data_url: String,
}

fn is_image(name: &str) -> bool {
    let lower = name.to_lowercase();
    [
        ".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".avif",
    ]
    .iter()
    .any(|ext| lower.ends_with(ext))
}

pub fn mime_for_name(name: &str) -> &'static str {
    let lower = name.to_lowercase();
    if lower.ends_with(".png") {
        "image/png"
    } else if lower.ends_with(".webp") {
        "image/webp"
    } else if lower.ends_with(".gif") {
        "image/gif"
    } else if lower.ends_with(".bmp") {
        "image/bmp"
    } else if lower.ends_with(".avif") {
        "image/avif"
    } else {
        "image/jpeg"
    }
}

pub fn list_pages(path: &Path) -> Result<Vec<String>, String> {
    let file = File::open(path).map_err(|e| format!("Failed to open CBZ: {e}"))?;
    let reader = BufReader::new(file);
    let mut archive = ZipArchive::new(reader).map_err(|e| format!("Invalid CBZ archive: {e}"))?;

    let mut pages = Vec::new();
    for i in 0..archive.len() {
        let entry = archive
            .by_index(i)
            .map_err(|e| format!("Failed to read archive entry: {e}"))?;
        let name = entry.name().to_string();
        if !entry.is_dir() && is_image(&name) {
            pages.push(name);
        }
    }

    pages.sort_by(|a, b| natord::compare(a, b));
    Ok(pages)
}

pub fn open_cbz(path: &Path) -> Result<ComicMeta, String> {
    let pages = list_pages(path)?;
    if pages.is_empty() {
        return Err("No image pages found in this CBZ file.".into());
    }

    let title = path
        .file_stem()
        .and_then(|s| s.to_os_string().into_string().ok())
        .unwrap_or_else(|| "Untitled".into());

    Ok(ComicMeta {
        path: path.to_string_lossy().into_owned(),
        title,
        page_count: pages.len(),
    })
}

pub fn get_page_data(path: &Path, index: usize) -> Result<PageData, String> {
    let pages = list_pages(path)?;
    if index >= pages.len() {
        return Err(format!("Page index {index} out of range ({} pages)", pages.len()));
    }

    let page_name = &pages[index];
    let file = File::open(path).map_err(|e| format!("Failed to open CBZ: {e}"))?;
    let reader = BufReader::new(file);
    let mut archive = ZipArchive::new(reader).map_err(|e| format!("Invalid CBZ archive: {e}"))?;

    let mut entry = archive
        .by_name(page_name)
        .map_err(|e| format!("Failed to read page: {e}"))?;

    let mut bytes = Vec::new();
    entry
        .read_to_end(&mut bytes)
        .map_err(|e| format!("Failed to decode page: {e}"))?;

    let mime_type = mime_for_name(page_name).to_string();
    let encoded = STANDARD.encode(bytes);
    let data_url = format!("data:{mime_type};base64,{encoded}");

    Ok(PageData {
        index,
        mime_type,
        data_url,
    })
}
