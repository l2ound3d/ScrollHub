use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub theme: String,
    pub reading_direction: String,
    pub reading_mode: String,
    pub fit_mode: String,
    pub library_folder: Option<String>,
    #[serde(default)]
    pub library_source: Option<String>,
    #[serde(default)]
    pub network_host: Option<String>,
    #[serde(default)]
    pub network_username: Option<String>,
    #[serde(default)]
    pub network_password: Option<String>,
    #[serde(default)]
    pub last_read_path: Option<String>,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            theme: "dark".into(),
            reading_direction: "ltr".into(),
            reading_mode: "single".into(),
            fit_mode: "width".into(),
            library_folder: None,
            library_source: None,
            network_host: None,
            network_username: None,
            network_password: None,
            last_read_path: None,
        }
    }
}

fn settings_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("settings.json")
}

pub fn load_settings(app_data_dir: &Path) -> AppSettings {
    let path = settings_path(app_data_dir);
    if !path.exists() {
        return AppSettings::default();
    }

    fs::read_to_string(path)
        .ok()
        .and_then(|content| serde_json::from_str(&content).ok())
        .unwrap_or_default()
}

pub fn save_settings(app_data_dir: &Path, settings: &AppSettings) -> Result<(), String> {
    fs::create_dir_all(app_data_dir).map_err(|e| e.to_string())?;
    let content = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    fs::write(settings_path(app_data_dir), content).map_err(|e| e.to_string())
}
