export interface ComicMeta {
  path: string;
  title: string;
  pageCount: number;
}

export interface LibraryEntry {
  name: string;
  path: string;
  kind: "folder" | "cbz";
}

export interface PageData {
  index: number;
  mimeType: string;
  dataUrl: string;
}

export interface AppSettings {
  theme: "light" | "dark";
  readingDirection: "ltr" | "rtl";
  readingMode: "single" | "double" | "webtoon";
  fitMode: "width" | "height" | "original";
  libraryFolder: string | null;
}

export type View = "reader" | "library" | "settings";
