import { open } from "@tauri-apps/plugin-dialog";
import { type as osType } from "@tauri-apps/plugin-os";
import {
  getPage,
  getProgress,
  getSettings,
  listLibraryDirectory,
  openCbz,
  saveProgress,
  saveSettings,
} from "./api";
import type { AppSettings, ComicMeta, LibraryEntry, View } from "./types";

type FitMode = AppSettings["fitMode"];
type ReadingMode = AppSettings["readingMode"];

interface ReaderState {
  comic: ComicMeta | null;
  currentPage: number;
  loading: boolean;
}

const WEBTOON_PREFETCH = 2;
const LIBRARY_CACHE = new Map<string, LibraryEntry[]>();

const state: ReaderState = {
  comic: null,
  currentPage: 0,
  loading: false,
};

const webtoon = {
  observer: null as IntersectionObserver | null,
  loaded: new Set<number>(),
  loading: new Set<number>(),
  scrollSaveTimer: null as ReturnType<typeof setTimeout> | null,
  scrollListener: null as (() => void) | null,
};

let settings: AppSettings = {
  theme: "dark",
  readingDirection: "ltr",
  readingMode: "single",
  fitMode: "width",
  libraryFolder: null,
};

let libraryItems: LibraryEntry[] = [];
let libraryCurrentPath: string | null = null;
let currentView: View = "reader";
let chromeHidden = false;
let drawerOpen = false;
let chromeRevealTimer: ReturnType<typeof setTimeout> | null = null;
let isMobile = false;

const els = {
  app: document.getElementById("app")!,
  chrome: document.getElementById("chrome")!,
  drawer: document.getElementById("drawer")!,
  drawerBackdrop: document.getElementById("drawer-backdrop")!,
  readerView: document.getElementById("reader-view")!,
  libraryView: document.getElementById("library-view")!,
  settingsView: document.getElementById("settings-view")!,
  pageContainer: document.getElementById("page-container")!,
  pageInfoWrap: document.getElementById("page-info-wrap")!,
  pageInfoBtn: document.getElementById("page-info-btn") as HTMLButtonElement,
  pageJumpInput: document.getElementById("page-jump-input") as HTMLInputElement,
  comicTitle: document.getElementById("comic-title")!,
  libraryList: document.getElementById("library-list")!,
  libraryEmpty: document.getElementById("library-empty")!,
  libraryBreadcrumb: document.getElementById("library-breadcrumb")!,
  pageSlider: document.getElementById("page-slider") as HTMLInputElement,
  settingsForm: document.getElementById("settings-form") as HTMLFormElement,
  themeSelect: document.getElementById("theme-select") as HTMLSelectElement,
  directionSelect: document.getElementById("direction-select") as HTMLSelectElement,
  modeSelect: document.getElementById("mode-select") as HTMLSelectElement,
  fitSelect: document.getElementById("fit-select") as HTMLSelectElement,
  libraryFolderInput: document.getElementById("library-folder") as HTMLInputElement,
  chromeToggle: document.getElementById("chrome-toggle") as HTMLButtonElement,
  prevPageBtn: document.getElementById("prev-page-btn") as HTMLButtonElement,
  nextPageBtn: document.getElementById("next-page-btn") as HTMLButtonElement,
};

function applyMobileUi() {
  if (!isMobile) return;

  document.body.dataset.platform = "mobile";
  document.getElementById("open-folder-btn")?.setAttribute("hidden", "");
  document.querySelector('.nav-btn[data-view="library"]')?.setAttribute("hidden", "");
  document.getElementById("library-folder")?.closest("label")?.setAttribute("hidden", "");
  document.querySelector(".drawer-hint")!.textContent = "Tap edges to turn pages · Menu for settings";

  const emptySub = document.querySelector(".empty-sub");
  if (emptySub) {
    emptySub.textContent = "Tap the folder icon to open a .cbz file";
  }
}

function detectMobilePlatform(): boolean {
  try {
    const platform = osType();
    return platform === "android" || platform === "ios";
  } catch {
    return /Android|iPhone|iPad/i.test(navigator.userAgent);
  }
}

function applyTheme() {
  document.documentElement.dataset.theme = settings.theme;
}

function applyReadingMode() {
  document.body.dataset.readingMode = settings.readingMode;
  document.body.dataset.fitMode = settings.fitMode;
  document.body.dataset.direction = settings.readingDirection;
  const isWebtoon = settings.readingMode === "webtoon";
  els.prevPageBtn.hidden = isWebtoon;
  els.nextPageBtn.hidden = isWebtoon;
}

function setReadingActive(active: boolean) {
  document.body.classList.toggle("reading-active", active);
}

function setChromeHidden(hidden: boolean) {
  chromeHidden = hidden;
  document.body.classList.toggle("chrome-hidden", hidden);
  els.chromeToggle.textContent = hidden ? "▾" : "▴";
  els.chromeToggle.title = hidden ? "Show UI (H)" : "Hide UI (H)";
}

function revealChromeBriefly() {
  if (!chromeHidden || !state.comic) return;
  document.body.classList.add("chrome-reveal");
  if (chromeRevealTimer) clearTimeout(chromeRevealTimer);
  chromeRevealTimer = setTimeout(() => {
    document.body.classList.remove("chrome-reveal");
  }, 2500);
}

function openDrawer() {
  drawerOpen = true;
  els.drawer.hidden = false;
  els.drawerBackdrop.hidden = false;
}

function closeDrawer() {
  drawerOpen = false;
  els.drawer.hidden = true;
  els.drawerBackdrop.hidden = true;
}

function toggleDrawer() {
  if (drawerOpen) closeDrawer();
  else openDrawer();
}

function toggleChrome() {
  setChromeHidden(!chromeHidden);
  document.body.classList.remove("chrome-reveal");
}

function setView(view: View) {
  currentView = view;
  els.readerView.hidden = view !== "reader";
  els.libraryView.hidden = view !== "library";
  els.settingsView.hidden = view !== "settings";
  document.body.classList.toggle("library-active", view === "library");
  document.body.classList.toggle("settings-active", view === "settings");
  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.getAttribute("data-view") === view);
  });
  if (view === "reader") {
    setReadingActive(!!state.comic);
  } else {
    setReadingActive(false);
    setChromeHidden(false);
  }
}

function formatPageLabel(pageIndex: number): string {
  if (!state.comic) return "";
  const total = state.comic.pageCount;
  const displayPage = pageIndex + 1;
  if (settings.readingMode === "double" && pageIndex + 1 < total) {
    return `${displayPage}-${displayPage + 1} / ${total}`;
  }
  return `${displayPage} / ${total}`;
}

function updatePageInfo() {
  if (!state.comic) {
    els.pageInfoWrap.hidden = true;
    els.comicTitle.textContent = "ScrollHub";
    els.pageSlider.hidden = true;
    return;
  }

  els.pageInfoWrap.hidden = false;
  els.pageInfoBtn.textContent = formatPageLabel(state.currentPage);
  els.comicTitle.textContent = state.comic.title;

  els.pageSlider.hidden = false;
  els.pageSlider.min = "0";
  els.pageSlider.max = String(Math.max(0, state.comic.pageCount - 1));
  els.pageSlider.value = String(state.currentPage);
}

function resetWebtoonState() {
  webtoon.observer?.disconnect();
  webtoon.observer = null;
  webtoon.loaded.clear();
  webtoon.loading.clear();
  if (webtoon.scrollSaveTimer) clearTimeout(webtoon.scrollSaveTimer);
  if (webtoon.scrollListener) {
    els.pageContainer.removeEventListener("scroll", webtoon.scrollListener);
    webtoon.scrollListener = null;
  }
}

function beginPageJump() {
  if (!state.comic || els.pageJumpInput.hidden === false) return;
  els.pageInfoBtn.hidden = true;
  els.pageJumpInput.hidden = false;
  els.pageJumpInput.value = String(state.currentPage + 1);
  els.pageJumpInput.max = String(state.comic.pageCount);
  els.pageJumpInput.focus();
  els.pageJumpInput.select();
}

function cancelPageJump() {
  els.pageJumpInput.hidden = true;
  els.pageInfoBtn.hidden = false;
}

async function commitPageJump() {
  if (!state.comic) {
    cancelPageJump();
    return;
  }

  const raw = Number(els.pageJumpInput.value);
  cancelPageJump();

  if (!Number.isFinite(raw)) return;
  const pageIndex = Math.min(state.comic.pageCount - 1, Math.max(0, Math.round(raw) - 1));
  if (pageIndex === state.currentPage) return;

  state.currentPage = pageIndex;
  if (settings.readingMode === "webtoon") {
    scrollToWebtoonPage(pageIndex);
    updatePageInfo();
    await saveProgress(state.comic.path, pageIndex);
  } else {
    await renderReader();
  }
}

async function renderReader() {
  if (!state.comic) {
    resetWebtoonState();
    setReadingActive(false);
    els.pageContainer.innerHTML = "";
    return;
  }

  if (settings.readingMode === "webtoon") {
    await renderWebtoon();
  } else {
    resetWebtoonState();
    await renderPaginatedPage();
  }
}

async function renderPaginatedPage() {
  if (!state.comic) return;

  setReadingActive(true);
  state.loading = true;
  els.pageContainer.classList.remove("webtoon-mode");
  els.pageContainer.classList.add("loading");

  try {
    const indices =
      settings.readingMode === "double" && state.currentPage + 1 < state.comic.pageCount
        ? [state.currentPage, state.currentPage + 1]
        : [state.currentPage];

    const pages = await Promise.all(indices.map((index) => getPage(state.comic!.path, index)));

    els.pageContainer.innerHTML = pages
      .map(
        (page) =>
          `<img class="page-image fit-${settings.fitMode}" src="${page.dataUrl}" alt="Page ${page.index + 1}" draggable="false" />`,
      )
      .join("");

    await saveProgress(state.comic.path, state.currentPage);
    updatePageInfo();
  } catch (error) {
    els.pageContainer.innerHTML = `<p class="error">${String(error)}</p>`;
  } finally {
    state.loading = false;
    els.pageContainer.classList.remove("loading");
  }
}

function scrollToWebtoonPage(pageIndex: number) {
  const slot = els.pageContainer.querySelector(
    `[data-page-index="${pageIndex}"]`,
  ) as HTMLElement | null;
  slot?.scrollIntoView({ block: "start" });
}

function updateWebtoonCurrentPage() {
  if (!state.comic || settings.readingMode !== "webtoon") return;

  const slots = Array.from(
    els.pageContainer.querySelectorAll<HTMLElement>(".webtoon-page-slot"),
  );
  if (slots.length === 0) return;

  const containerTop = els.pageContainer.scrollTop;
  const containerHeight = els.pageContainer.clientHeight;
  const midpoint = containerTop + containerHeight * 0.35;

  let bestIndex = state.currentPage;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const slot of slots) {
    const index = Number(slot.dataset.pageIndex);
    const slotMid = slot.offsetTop + slot.offsetHeight / 2;
    const distance = Math.abs(slotMid - midpoint);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  }

  if (bestIndex !== state.currentPage) {
    state.currentPage = bestIndex;
    updatePageInfo();
    if (state.comic && webtoon.scrollSaveTimer) clearTimeout(webtoon.scrollSaveTimer);
    webtoon.scrollSaveTimer = setTimeout(() => {
      if (state.comic) void saveProgress(state.comic.path, state.currentPage);
    }, 400);
  }
}

async function loadWebtoonPage(index: number) {
  if (!state.comic || index < 0 || index >= state.comic.pageCount) return;
  if (webtoon.loaded.has(index) || webtoon.loading.has(index)) return;

  webtoon.loading.add(index);
  try {
    const page = await getPage(state.comic.path, index);
    webtoon.loaded.add(index);

    const slot = els.pageContainer.querySelector(
      `[data-page-index="${index}"]`,
    ) as HTMLElement | null;
    if (slot) {
      slot.innerHTML = `<img class="page-image webtoon-image fit-${settings.fitMode}" src="${page.dataUrl}" alt="Page ${index + 1}" draggable="false" />`;
      slot.classList.remove("webtoon-slot-pending");
    }
  } catch {
    const slot = els.pageContainer.querySelector(
      `[data-page-index="${index}"]`,
    ) as HTMLElement | null;
    if (slot) slot.innerHTML = `<p class="error">Failed to load page ${index + 1}</p>`;
  } finally {
    webtoon.loading.delete(index);
  }
}

function prefetchWebtoonAround(index: number) {
  for (let offset = -WEBTOON_PREFETCH; offset <= WEBTOON_PREFETCH; offset += 1) {
    void loadWebtoonPage(index + offset);
  }
}

function setupWebtoonObserver() {
  webtoon.observer?.disconnect();
  webtoon.observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const index = Number((entry.target as HTMLElement).dataset.pageIndex);
        prefetchWebtoonAround(index);
      }
      updateWebtoonCurrentPage();
    },
    { root: els.pageContainer, rootMargin: "900px 0px" },
  );

  els.pageContainer.querySelectorAll(".webtoon-page-slot").forEach((slot) => {
    webtoon.observer!.observe(slot);
  });
}

async function renderWebtoon() {
  if (!state.comic) return;

  const startPage = state.currentPage;
  resetWebtoonState();
  setReadingActive(true);
  state.loading = true;
  els.pageContainer.classList.add("webtoon-mode", "loading");
  els.pageContainer.innerHTML = "";

  const fragment = document.createDocumentFragment();
  for (let i = 0; i < state.comic.pageCount; i += 1) {
    const slot = document.createElement("div");
    slot.className = "webtoon-page-slot webtoon-slot-pending";
    slot.dataset.pageIndex = String(i);
    fragment.appendChild(slot);
  }
  els.pageContainer.appendChild(fragment);

  setupWebtoonObserver();
  webtoon.scrollListener = () => updateWebtoonCurrentPage();
  els.pageContainer.addEventListener("scroll", webtoon.scrollListener, { passive: true });

  prefetchWebtoonAround(startPage);
  updatePageInfo();

  requestAnimationFrame(() => {
    scrollToWebtoonPage(startPage);
    updateWebtoonCurrentPage();
  });

  await saveProgress(state.comic.path, startPage);
  state.loading = false;
  els.pageContainer.classList.remove("loading");
}

async function openComic(path: string) {
  resetWebtoonState();
  const meta = await openCbz(path);
  const savedPage = await getProgress(path);
  state.comic = meta;
  state.currentPage = savedPage ?? 0;
  if (state.currentPage >= meta.pageCount) {
    state.currentPage = Math.max(0, meta.pageCount - 1);
  }
  closeDrawer();
  setView("reader");
  setChromeHidden(true);
  applyReadingMode();
  await renderReader();
}

async function pickCbzFile() {
  const selected = await open({
    multiple: false,
    directory: false,
    filters: [{ name: "Comic Book", extensions: ["cbz"] }],
  });

  if (typeof selected === "string") {
    await openComic(selected);
  }
}

async function pickLibraryFolder() {
  const selected = await open({
    multiple: false,
    directory: true,
  });

  if (typeof selected === "string") {
    settings.libraryFolder = selected;
    libraryCurrentPath = selected;
    LIBRARY_CACHE.clear();
    els.libraryFolderInput.value = selected;
    await saveSettings(settings);
    await refreshLibrary();
    setView("library");
    closeDrawer();
  }
}

function renderLibraryBreadcrumb() {
  if (!settings.libraryFolder || !libraryCurrentPath) {
    els.libraryBreadcrumb.innerHTML = "";
    return;
  }

  const root = settings.libraryFolder.replace(/\\/g, "/");
  const current = libraryCurrentPath.replace(/\\/g, "/");
  const rootLabel = root.split("/").filter(Boolean).pop() ?? "Library";

  if (current.toLowerCase() === root.toLowerCase()) {
    els.libraryBreadcrumb.innerHTML = `<span class="crumb current">${escapeHtml(rootLabel)}</span>`;
    return;
  }

  const relative = current.slice(root.length).replace(/^[/\\]/, "");
  const parts = relative.split(/[/\\]/).filter(Boolean);
  let builtPath = root;

  const crumbs = [
    `<button type="button" class="crumb crumb-btn" data-path="${encodeURIComponent(root)}">${escapeHtml(rootLabel)}</button>`,
  ];

  parts.forEach((part, index) => {
    builtPath = `${builtPath}\\${part}`;
    const isLast = index === parts.length - 1;
    if (isLast) {
      crumbs.push(`<span class="crumb sep">/</span><span class="crumb current">${escapeHtml(part)}</span>`);
    } else {
      crumbs.push(
        `<span class="crumb sep">/</span><button type="button" class="crumb crumb-btn" data-path="${encodeURIComponent(builtPath)}">${escapeHtml(part)}</button>`,
      );
    }
  });

  els.libraryBreadcrumb.innerHTML = crumbs.join("");
}

async function navigateLibraryTo(path: string) {
  libraryCurrentPath = path;
  await refreshLibrary();
}

function isLibraryRoot(path: string): boolean {
  if (!settings.libraryFolder) return false;
  return (
    path.replace(/\\/g, "/").toLowerCase() ===
    settings.libraryFolder.replace(/\\/g, "/").toLowerCase()
  );
}

async function refreshLibrary() {
  if (!settings.libraryFolder) {
    libraryItems = [];
    libraryCurrentPath = null;
    els.libraryList.innerHTML = "";
    els.libraryEmpty.hidden = false;
    els.libraryEmpty.textContent =
      "No folder selected. Open Menu → Open Folder or set one in Settings.";
    renderLibraryBreadcrumb();
    return;
  }

  if (!libraryCurrentPath) {
    libraryCurrentPath = settings.libraryFolder;
  }

  const atRoot = isLibraryRoot(libraryCurrentPath);
  const cacheKey = `${libraryCurrentPath}|${atRoot ? "folders" : "all"}`;

  let entries = LIBRARY_CACHE.get(cacheKey);
  if (!entries) {
    entries = await listLibraryDirectory(libraryCurrentPath, atRoot);
    LIBRARY_CACHE.set(cacheKey, entries);
  }

  libraryItems = entries;

  renderLibraryBreadcrumb();
  els.libraryEmpty.hidden = libraryItems.length > 0;
  els.libraryEmpty.textContent = atRoot
    ? "No folders found in this library directory."
    : "This folder is empty.";

  els.libraryList.innerHTML = libraryItems
    .map((item) => {
      const meta =
        item.kind === "folder"
          ? `<span class="library-item-meta">Folder</span>`
          : `<span class="library-item-meta">CBZ</span>`;
      const icon = item.kind === "folder" ? "📁" : "📖";
      return `<button class="library-item" data-kind="${item.kind}" data-path="${encodeURIComponent(item.path)}">
          <span class="library-item-title">${icon} ${escapeHtml(item.name)}</span>
          ${meta}
        </button>`;
    })
    .join("");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function pageStep(): number {
  if (settings.readingMode === "double") {
    const remaining = state.comic ? state.comic.pageCount - state.currentPage : 1;
    return remaining > 1 ? 2 : 1;
  }
  return 1;
}

async function goNext() {
  if (!state.comic || state.loading) return;

  if (settings.readingMode === "webtoon") {
    const next = Math.min(state.comic.pageCount - 1, state.currentPage + 1);
    state.currentPage = next;
    scrollToWebtoonPage(next);
    updatePageInfo();
    await saveProgress(state.comic.path, next);
    return;
  }

  const step = pageStep();
  const next = settings.readingDirection === "rtl"
    ? state.currentPage - step
    : state.currentPage + step;

  if (next >= 0 && next < state.comic.pageCount) {
    state.currentPage = next;
    await renderReader();
  }
}

async function goPrev() {
  if (!state.comic || state.loading) return;

  if (settings.readingMode === "webtoon") {
    const prev = Math.max(0, state.currentPage - 1);
    state.currentPage = prev;
    scrollToWebtoonPage(prev);
    updatePageInfo();
    await saveProgress(state.comic.path, prev);
    return;
  }

  const step = pageStep();
  const prev = settings.readingDirection === "rtl"
    ? state.currentPage + step
    : state.currentPage - step;

  if (prev >= 0 && prev < state.comic.pageCount) {
    state.currentPage = prev;
    await renderReader();
  }
}

async function applySettingsFromForm() {
  settings = {
    theme: els.themeSelect.value as AppSettings["theme"],
    readingDirection: els.directionSelect.value as AppSettings["readingDirection"],
    readingMode: els.modeSelect.value as ReadingMode,
    fitMode: els.fitSelect.value as FitMode,
    libraryFolder: els.libraryFolderInput.value || null,
  };
  applyTheme();
  applyReadingMode();
  await saveSettings(settings);
  if (settings.libraryFolder !== libraryCurrentPath) {
    LIBRARY_CACHE.clear();
  }
  libraryCurrentPath = settings.libraryFolder;
  if (state.comic) {
    await renderReader();
  }
}

function isCbzPath(path: string): boolean {
  return path.toLowerCase().endsWith(".cbz");
}

async function handleDroppedPaths(paths: string[]) {
  const cbz = paths.find(isCbzPath);
  if (cbz) {
    await openComic(cbz);
  }
}

function bindEvents() {
  document.getElementById("menu-toggle")?.addEventListener("click", toggleDrawer);
  document.getElementById("drawer-close")?.addEventListener("click", closeDrawer);
  els.drawerBackdrop.addEventListener("click", closeDrawer);

  document.getElementById("open-file-btn")?.addEventListener("click", () => {
    void pickCbzFile();
  });

  document.getElementById("open-folder-btn")?.addEventListener("click", () => {
    void pickLibraryFolder();
  });

  els.prevPageBtn.addEventListener("click", () => void goPrev());
  els.nextPageBtn.addEventListener("click", () => void goNext());
  els.chromeToggle.addEventListener("click", toggleChrome);

  els.pageInfoBtn.addEventListener("click", beginPageJump);

  els.pageJumpInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void commitPageJump();
    } else if (event.key === "Escape") {
      event.preventDefault();
      cancelPageJump();
    }
  });

  els.pageJumpInput.addEventListener("blur", () => {
    void commitPageJump();
  });

  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const view = btn.getAttribute("data-view") as View;
      setView(view);
      closeDrawer();
      if (view === "library") {
        void refreshLibrary();
      }
    });
  });

  els.libraryList.addEventListener("click", (event) => {
    const target = (event.target as HTMLElement).closest(".library-item") as HTMLElement | null;
    if (!target) return;
    const path = decodeURIComponent(target.dataset.path ?? "");
    const kind = target.dataset.kind;
    if (kind === "folder") {
      void navigateLibraryTo(path);
    } else {
      void openComic(path);
    }
  });

  els.libraryBreadcrumb.addEventListener("click", (event) => {
    const target = (event.target as HTMLElement).closest(".crumb-btn") as HTMLElement | null;
    if (!target) return;
    const path = decodeURIComponent(target.dataset.path ?? "");
    void navigateLibraryTo(path);
  });

  els.pageSlider.addEventListener("input", () => {
    if (!state.comic || state.loading) return;
    const page = Number(els.pageSlider.value);
    if (settings.readingMode === "double" && page % 2 === 1 && page > 0) {
      els.pageSlider.value = String(page - 1);
    }
    const nextPage = Number(els.pageSlider.value);
    if (nextPage !== state.currentPage) {
      els.pageInfoBtn.textContent = formatPageLabel(nextPage);
    }
  });

  els.pageSlider.addEventListener("change", () => {
    if (!state.comic || state.loading) return;
    const page = Number(els.pageSlider.value);
    if (page === state.currentPage) return;
    state.currentPage = page;
    if (settings.readingMode === "webtoon") {
      scrollToWebtoonPage(page);
      prefetchWebtoonAround(page);
      updatePageInfo();
      void saveProgress(state.comic.path, page);
    } else {
      void renderReader();
    }
  });

  els.settingsForm.addEventListener("change", () => {
    void applySettingsFromForm();
  });

  document.getElementById("browse-library-folder")?.addEventListener("click", () => {
    void pickLibraryFolder();
  });

  window.addEventListener("keydown", (event) => {
    if (event.key === "h" || event.key === "H") {
      if (currentView === "reader" && state.comic) {
        event.preventDefault();
        toggleChrome();
      }
      return;
    }

    if (event.key === "m" || event.key === "M") {
      event.preventDefault();
      toggleDrawer();
      return;
    }

    if (event.key === "Escape") {
      if (!els.pageJumpInput.hidden) {
        cancelPageJump();
        return;
      }
      if (drawerOpen) closeDrawer();
      else if (chromeHidden) setChromeHidden(false);
      return;
    }

    if (currentView !== "reader" || !state.comic) return;
    if (settings.readingMode === "webtoon") return;

    if (event.key === "ArrowRight" || event.key === "PageDown") {
      event.preventDefault();
      void goNext();
    } else if (event.key === "ArrowLeft" || event.key === "PageUp") {
      event.preventDefault();
      void goPrev();
    } else if (event.key === "Home") {
      event.preventDefault();
      state.currentPage = 0;
      void renderReader();
    } else if (event.key === "End") {
      event.preventDefault();
      state.currentPage = Math.max(0, state.comic.pageCount - 1);
      void renderReader();
    }
  });

  window.addEventListener("mousemove", (event) => {
    if (chromeHidden && state.comic && currentView === "reader" && event.clientY <= 8) {
      revealChromeBriefly();
    }
  });

  window.addEventListener("wheel", (event) => {
    if (currentView !== "reader" || !state.comic) return;
    if (settings.readingMode === "webtoon") return;
    if (Math.abs(event.deltaY) < 20) return;
    event.preventDefault();
    if (event.deltaY > 0) void goNext();
    else void goPrev();
  }, { passive: false });

  let touchStartX = 0;
  window.addEventListener("touchstart", (event) => {
    touchStartX = event.changedTouches[0]?.clientX ?? 0;
  });

  window.addEventListener("touchend", (event) => {
    if (currentView !== "reader" || !state.comic || settings.readingMode === "webtoon") return;
    const touchEndX = event.changedTouches[0]?.clientX ?? 0;
    const delta = touchEndX - touchStartX;
    if (Math.abs(delta) < 50) {
      if (isMobile && chromeHidden) revealChromeBriefly();
      return;
    }
    if (delta < 0) void goNext();
    else void goPrev();
  });

  window.addEventListener("dragover", (event) => {
    if (isMobile) return;
    event.preventDefault();
  });

  window.addEventListener("drop", (event) => {
    if (isMobile) return;
    event.preventDefault();
    const files = Array.from(event.dataTransfer?.files ?? []);
    const paths = files
      .map((file) => (file as File & { path?: string }).path)
      .filter((path): path is string => typeof path === "string");
    if (paths.length > 0) void handleDroppedPaths(paths);
  });
}

export async function initApp() {
  isMobile = detectMobilePlatform();
  applyMobileUi();

  settings = await getSettings();
  if (!["single", "double", "webtoon"].includes(settings.readingMode)) {
    settings.readingMode = "single";
  }
  els.themeSelect.value = settings.theme;
  els.directionSelect.value = settings.readingDirection;
  els.modeSelect.value = settings.readingMode;
  els.fitSelect.value = settings.fitMode;
  els.libraryFolderInput.value = settings.libraryFolder ?? "";

  applyTheme();
  applyReadingMode();
  bindEvents();
  setView("reader");
  setReadingActive(false);
  updatePageInfo();

  if (settings.libraryFolder && !isMobile) {
    libraryCurrentPath = settings.libraryFolder;
    await refreshLibrary();
  }
}
