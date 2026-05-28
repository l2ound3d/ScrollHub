use crate::library::LibraryEntry;
use smb2::client::{ClientConfig, SmbClient};
use smb2::Tree;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::AppHandle;
use tauri::Manager;
use tokio::sync::Mutex;

pub const SMB_PREFIX: &str = "smb://";

pub struct SmbState {
    inner: Mutex<Option<SmbSession>>,
}

struct SmbSession {
    host: String,
    username: String,
    password: String,
    client: SmbClient,
    trees: HashMap<String, Tree>,
}

impl Default for SmbState {
    fn default() -> Self {
        Self {
            inner: Mutex::new(None),
        }
    }
}

pub fn is_smb_path(path: &str) -> bool {
    path.starts_with(SMB_PREFIX)
}

fn normalize_smb_dir(path: &str) -> String {
    if path.is_empty() {
        return String::new();
    }
    path.replace('/', "\\").trim_matches('\\').to_string()
}

pub fn parse_smb_path(path: &str) -> Result<(String, String, String), String> {
    let rest = path
        .strip_prefix(SMB_PREFIX)
        .ok_or_else(|| "Invalid SMB path.".to_string())?;
    let (host, remainder) = rest
        .split_once('/')
        .ok_or_else(|| "SMB path must include a share name.".to_string())?;
    if host.is_empty() {
        return Err("SMB path is missing a host.".into());
    }
    let (share, rel) = remainder.split_once('/').unwrap_or((remainder, ""));
    if share.is_empty() {
        return Err("SMB path is missing a share name.".into());
    }
    Ok((host.to_string(), share.to_string(), normalize_smb_dir(rel)))
}

pub fn build_smb_path(host: &str, share: &str, rel: &str) -> String {
    let rel = rel.replace('\\', "/").trim_matches('/').to_string();
    if rel.is_empty() {
        format!("{SMB_PREFIX}{host}/{share}")
    } else {
        format!("{SMB_PREFIX}{host}/{share}/{rel}")
    }
}

fn smb_addr(host: &str) -> String {
    if host.contains(':') {
        host.to_string()
    } else {
        format!("{host}:445")
    }
}

async fn connect_client(host: &str, username: &str, password: &str) -> Result<SmbClient, String> {
    let config = ClientConfig {
        addr: smb_addr(host),
        timeout: Duration::from_secs(20),
        username: username.to_string(),
        password: password.to_string(),
        domain: String::new(),
        auto_reconnect: true,
        compression: true,
        dfs_enabled: true,
        dfs_target_overrides: HashMap::new(),
    };
    SmbClient::connect(config)
        .await
        .map_err(|e| format!("Could not connect to {host}: {e}"))
}

impl SmbState {
    async fn ensure_session(
        &self,
        host: &str,
        username: &str,
        password: &str,
    ) -> Result<(), String> {
        let mut guard = self.inner.lock().await;
        let needs_new = guard
            .as_ref()
            .map(|s| s.host != host || s.username != username || s.password != password)
            .unwrap_or(true);
        if needs_new {
            let client = connect_client(host, username, password).await?;
            *guard = Some(SmbSession {
                host: host.to_string(),
                username: username.to_string(),
                password: password.to_string(),
                client,
                trees: HashMap::new(),
            });
        }
        Ok(())
    }

    async fn tree_for_share(&self, share: &str) -> Result<(), String> {
        let mut guard = self.inner.lock().await;
        let session = guard
            .as_mut()
            .ok_or_else(|| "Not connected to a network drive.".to_string())?;
        if !session.trees.contains_key(share) {
            let tree = session
                .client
                .connect_share(share)
                .await
                .map_err(|e| format!("Could not open share \"{share}\": {e}"))?;
            session.trees.insert(share.to_string(), tree);
        }
        Ok(())
    }

    pub async fn connect_and_list_shares(
        &self,
        host: &str,
        username: &str,
        password: &str,
    ) -> Result<Vec<LibraryEntry>, String> {
        self.ensure_session(host, username, password).await?;
        let mut guard = self.inner.lock().await;
        let session = guard
            .as_mut()
            .ok_or_else(|| "Network session unavailable.".to_string())?;
        let shares = session
            .client
            .list_shares()
            .await
            .map_err(|e| format!("Could not list shares on {host}: {e}"))?;

        let mut entries = shares
            .into_iter()
            .map(|share| LibraryEntry {
                name: share.name.clone(),
                path: build_smb_path(host, &share.name, ""),
                kind: "folder".into(),
            })
            .collect::<Vec<_>>();
        entries.sort_by(|a, b| natord::compare(&a.name, &b.name));
        Ok(entries)
    }

    pub async fn list_directory(&self, path: &str, folders_only: bool) -> Result<Vec<LibraryEntry>, String> {
        let (host, share, rel) = parse_smb_path(path)?;
        {
            let guard = self.inner.lock().await;
            let session = guard
                .as_ref()
                .ok_or_else(|| "Connect to your network drive first.".to_string())?;
            if session.host != host {
                return Err("Network path belongs to a different server. Reconnect first.".into());
            }
        }
        self.tree_for_share(&share).await?;

        let mut guard = self.inner.lock().await;
        let session = guard
            .as_mut()
            .ok_or_else(|| "Network session unavailable.".to_string())?;
        let tree = session
            .trees
            .get_mut(&share)
            .ok_or_else(|| format!("Share \"{share}\" is not open."))?;

        let entries = session
            .client
            .list_directory(tree, &rel)
            .await
            .map_err(|e| format!("Could not read \"{path}\": {e}"))?;
        drop(guard);

        let mut folders = Vec::new();
        let mut comics = Vec::new();
        for entry in entries {
            if entry.name.starts_with('.') {
                continue;
            }
            let child_rel = if rel.is_empty() {
                entry.name.clone()
            } else {
                format!("{}\\{}", rel, entry.name)
            };
            let child_path = build_smb_path(&host, &share, &child_rel);
            if entry.is_directory {
                folders.push(LibraryEntry {
                    name: entry.name,
                    path: child_path,
                    kind: "folder".into(),
                });
            } else if !folders_only {
                let lower = entry.name.to_lowercase();
                if lower.ends_with(".cbz") {
                    comics.push(LibraryEntry {
                        name: entry.name,
                        path: child_path,
                        kind: "cbz".into(),
                    });
                }
            }
        }
        folders.sort_by(|a, b| natord::compare(&a.name, &b.name));
        comics.sort_by(|a, b| natord::compare(&a.name, &b.name));
        folders.append(&mut comics);
        Ok(folders)
    }

    pub async fn download_to_cache(&self, app: &AppHandle, path: &str) -> Result<PathBuf, String> {
        let (host, share, rel) = parse_smb_path(path)?;
        if rel.is_empty() {
            return Err("Expected a CBZ file, not a folder.".into());
        }

        {
            let guard = self.inner.lock().await;
            if guard.is_none() {
                return Err("Connect to your network drive first.".into());
            }
            if guard.as_ref().map(|s| s.host.as_str()) != Some(host.as_str()) {
                return Err("Network file belongs to a different server. Reconnect first.".into());
            }
        }

        self.tree_for_share(&share).await?;

        let cache_dir = app
            .path()
            .app_cache_dir()
            .map_err(|e| e.to_string())?
            .join("cbz-cache");
        std::fs::create_dir_all(&cache_dir).map_err(|e| e.to_string())?;

        let file_name = Path::new(&rel)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("comic.cbz");
        let safe_name = file_name
            .chars()
            .map(|c| match c {
                '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
                _ => c,
            })
            .collect::<String>();
        let dest = cache_dir.join(format!("smb_{host}_{share}_{safe_name}"));

        if dest.exists() {
            return Ok(dest);
        }

        let mut guard = self.inner.lock().await;
        let session = guard
            .as_mut()
            .ok_or_else(|| "Network session unavailable.".to_string())?;
        let tree = session
            .trees
            .get_mut(&share)
            .ok_or_else(|| format!("Share \"{share}\" is not open."))?;

        let bytes = session
            .client
            .read_file_pipelined(tree, &rel)
            .await
            .map_err(|e| format!("Could not download \"{path}\": {e}"))?;
        drop(guard);

        std::fs::write(&dest, &bytes).map_err(|e| format!("Failed to cache CBZ: {e}"))?;
        Ok(dest)
    }

    pub async fn disconnect(&self) -> Result<(), String> {
        let mut guard = self.inner.lock().await;
        *guard = None;
        Ok(())
    }
}

pub fn display_title_for_smb_path(path: &str) -> String {
    parse_smb_path(path)
        .ok()
        .and_then(|(_, _, rel)| {
            Path::new(&rel)
                .file_name()
                .and_then(|s| s.to_str())
                .map(|name| name.trim_end_matches(".cbz").trim_end_matches(".CBZ").to_string())
        })
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "Comic".into())
}
