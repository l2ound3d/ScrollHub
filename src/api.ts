import { invoke } from "@tauri-apps/api/core";
import type { AppSettings, ComicMeta, LibraryEntry, PageData } from "./types";

export async function openCbz(path: string): Promise<ComicMeta> {
  return invoke("open_cbz_file", { path });
}

export async function getPage(path: string, index: number): Promise<PageData> {
  return invoke("get_page", { path, index });
}

export async function listLibraryDirectory(
  path: string,
  foldersOnly = false,
): Promise<LibraryEntry[]> {
  return invoke("list_library_directory", { path, foldersOnly });
}

export async function pickAndroidLibraryFolder(): Promise<string | null> {
  return invoke<string | null>("pick_library_folder");
}

export async function pickAndroidCbzFile(): Promise<string | null> {
  return invoke<string | null>("pick_cbz_file");
}

export async function smbConnect(
  host: string,
  username: string,
  password: string,
): Promise<LibraryEntry[]> {
  return invoke("smb_connect", { host, username, password });
}

export async function smbDisconnect(): Promise<void> {
  await invoke("smb_disconnect");
}

export async function getPlatform(): Promise<string> {
  return invoke<string>("get_platform");
}

export async function getProgress(path: string): Promise<number | null> {
  const page = await invoke<number | null>("get_progress", { path });
  return page;
}

export async function saveProgress(path: string, page: number): Promise<void> {
  await invoke("save_progress", { path, page });
}

export async function getSettings(): Promise<AppSettings> {
  return invoke("get_settings");
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  await invoke("save_settings_cmd", { settings });
}
