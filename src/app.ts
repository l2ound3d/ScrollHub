import { open } from "@tauri-apps/plugin-dialog";
import {
  getPage,
  getProgress,
  getSettings,
  listLibraryDirectory,
  openCbz,
  pickAndroidLibraryFolder,
  smbConnect,
  saveProgress,
  saveSettings,
  getPlatform,
} from "./api";
import type { AppSettings, ComicMeta, LibraryEntry, LibrarySource, View } from "./types";

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
  librarySource: null,
  networkHost: null,
  networkUsername: null,
  networkPassword: null,
  lastReadPath: null,
};

let libraryNavStack: { name: string; path: string }[] = [];
let libraryItems: LibraryEntry[] = [];
let libraryCurrentPath: string | null = null;
let currentView: View = "reader";
let chromeHidden = false;
let drawerOpen = false;
let chromeRevealTimer: ReturnType<typeof setTimeout> | null = null;
let isMobile = false;
let isAndroid = false;
let librarySource: LibrarySource = "local";
let networkConnected = false;
let networkConnecting = false;
let networkShareList: LibraryEntry[] = [];
let showLibrarySetup = false;
let appPlatform = "desktop";

const els = {
  app: document.getElementById("app")!,
  chrome: document.getElementById("chrome")!,
  drawer: document.getElementById("drawer")!,
  drawerBackdrop: document.getElementById("drawer-backdrop")!,
  readerView: document.getElementById("reader-view")!,
  libraryView: document.getElementById("library-view")!,
  settingsView: document.getElementById("settings-view")!,
  pageContainer: document.getElementById("page-container")!,
  pageTapZones: document.getElementById("page-tap-zones")!,
  pageZonePrev: document.getElementById("page-zone-prev") as HTMLButtonElement,
  pageZoneNext: document.getElementById("page-zone-next") as HTMLButtonElement,
  pageInfoWrap: document.getElementById("page-info-wrap")!,
  pageInfoBtn: document.getElementById("page-info-btn") as HTMLButtonElement,
  pageJumpInput: document.getElementById("page-jump-input") as HTMLInputElement,
  comicTitle: document.getElementById("comic-title")!,
  libraryList: document.getElementById("library-list")!,
  libraryEmpty: document.getElementById("library-empty")!,
  libraryBreadcrumb: document.getElementById("library-breadcrumb")!,
  libraryPickFolderBtn: document.getElementById("library-pick-folder-btn") as HTMLButtonElement,
  librarySetupPanel: document.getElementById("library-setup-panel")!,
  librarySourceTabs: document.getElementById("library-source-tabs")!,
  libraryNetworkPanel: document.getElementById("library-network-panel")!,
  networkHostInput: document.getElementById("network-host") as HTMLInputElement,
  networkUsernameInput: document.getElementById("network-username") as HTMLInputElement,
  networkPasswordInput: document.getElementById("network-password") as HTMLInputElement,
  networkConnectBtn: document.getElementById("network-connect-btn") as HTMLButtonElement,
  libraryChangeBtn: document.getElementById("library-change-btn") as HTMLButtonElement,
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

function isContentUri(path: string): boolean {
  return path.startsWith("content://");
}

function isSmbPath(path: string): boolean {
  return path.startsWith("smb://");
}

function isNetworkShareRoot(path: string): boolean {
  if (!isSmbPath(path)) return false;
  const rest = path.slice("smb://".length);
  const parts = rest.split("/").filter(Boolean);
  return parts.length === 2;
}

function normalizeSmbPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

function smbParentDirectory(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const lastSlash = normalized.lastIndexOf("/");
  if (lastSlash <= "smb://".length) return normalized;
  return normalized.slice(0, lastSlash);
}

function buildSmbNavStackFromPath(targetPath: string): { name: string; path: string }[] {
  const rest = targetPath.slice("smb://".length);
  const parts = rest.split("/").filter(Boolean);
  if (parts.length === 0) return [];

  const stack: { name: string; path: string }[] = [];
  let built = `smb://${parts[0]}`;
  stack.push({ name: parts[0], path: `${built}/` });

  for (let i = 1; i < parts.length; i++) {
    built += `/${parts[i]}`;
    stack.push({ name: parts[i], path: built });
  }
  return stack;
}

function inferLibrarySource(): LibrarySource {
  if (settings.librarySource) return settings.librarySource;
  if (settings.libraryFolder && isSmbPath(settings.libraryFolder)) return "network";
  return "local";
}

function hasConfiguredLibrary(): boolean {
  if (!settings.libraryFolder) return false;
  if (librarySource === "network") return isSmbPath(settings.libraryFolder);
  return !isSmbPath(settings.libraryFolder);
}

function usesMobileLibrarySetup(): boolean {
  return isMobile || usesAndroidStorage();
}

function applyDesktopLibraryUi() {
  if (usesMobileLibrarySetup()) return;
  els.librarySourceTabs.hidden = true;
  els.libraryNetworkPanel.hidden = true;

  const emptySub = document.querySelector(".empty-sub");
  if (emptySub) {
    emptySub.textContent = "Click 📂 to choose a library folder, or drag and drop a CBZ file.";
  }
}

function updateLibrarySetupUi() {
  const configured = hasConfiguredLibrary();
  const showSetup = showLibrarySetup || !configured;
  const mobileSetup = usesMobileLibrarySetup();

  els.librarySetupPanel.hidden = !showSetup;
  els.libraryChangeBtn.hidden = !configured || showSetup;
  els.librarySourceTabs.hidden = !mobileSetup;

  if (!mobileSetup) {
    els.libraryNetworkPanel.hidden = true;
    els.libraryPickFolderBtn.hidden = !showSetup;
    if (showSetup) {
      els.libraryPickFolderBtn.textContent = settings.libraryFolder
        ? "Change library folder"
        : "Choose library folder";
    }
    return;
  }

  if (librarySource === "network") {
    els.libraryNetworkPanel.hidden = !showSetup;
    els.libraryPickFolderBtn.hidden = true;
  } else {
    els.libraryNetworkPanel.hidden = true;
    els.libraryPickFolderBtn.hidden = !showSetup || !usesAndroidStorage();
    if (showSetup && usesAndroidStorage()) {
      els.libraryPickFolderBtn.textContent = settings.libraryFolder
        ? "Change library folder"
        : "Choose library folder";
    }
  }
}

async function ensureNetworkConnected(): Promise<boolean> {
  if (networkConnected) return true;
  if (!settings.networkHost) return false;

  try {
    const shares = await smbConnect(
      settings.networkHost,
      settings.networkUsername ?? "",
      settings.networkPassword ?? "",
    );
    networkConnected = true;
    networkShareList = shares;
    return true;
  } catch {
    networkConnected = false;
    return false;
  }
}

async function saveNetworkLibraryFolder(dirPath: string) {
  const normalized = normalizeSmbPath(dirPath);
  if (settings.libraryFolder === normalized) return;

  settings.libraryFolder = normalized;
  settings.librarySource = "network";
  librarySource = "network";
  libraryCurrentPath = normalized;
  libraryNavStack = buildSmbNavStackFromPath(normalized);
  LIBRARY_CACHE.clear();
  showLibrarySetup = false;
  await saveSettings(settings);
  updateLibrarySetupUi();
}

function showAppMessage(message: string) {
  window.alert(message);
}

function usesAndroidStorage(): boolean {
  return isAndroid || appPlatform === "android";
}

function applyMobileUi() {
  if (!isMobile) return;

  document.body.dataset.platform = "mobile";

  document.getElementById("library-nav-btn")?.removeAttribute("hidden");
  document.querySelector('.nav-btn[data-view="library"]')?.removeAttribute("hidden");

  if (usesAndroidStorage()) {
    document.getElementById("library-folder")?.closest("label")?.setAttribute("hidden", "");
  }

  const drawerHint = document.getElementById("drawer-hint");
  if (drawerHint) {
    drawerHint.textContent = "ScrollHub v0.1.1-android";
  }

  const emptySub = document.querySelector(".empty-sub");
  if (emptySub) {
    emptySub.textContent = "Tap 📂 in the toolbar or Menu → Library";
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
  updatePageTapZones();
}

function updatePageTapZones() {
  const show =
    isMobile &&
    state.comic !== null &&
    currentView === "reader" &&
    settings.readingMode !== "webtoon";
  els.pageTapZones.hidden = !show;
  els.pageTapZones.setAttribute("aria-hidden", show ? "false" : "true");
}

const EDGE_SWIPE_MIN = 48;

function bindEdgeNav(
  element: HTMLElement,
  onTap: () => void,
  onSwipe: (direction: "left" | "right") => void,
) {
  let startX = 0;
  let multiTouch = false;
  let suppressClick = false;

  element.addEventListener("click", (event) => {
    if (suppressClick) {
      suppressClick = false;
      event.preventDefault();
      return;
    }
    onTap();
  });

  element.addEventListener(
    "touchstart",
    (event) => {
      multiTouch = event.touches.length > 1;
      startX = event.touches[0]?.clientX ?? 0;
    },
    { passive: true },
  );

  element.addEventListener(
    "touchmove",
    (event) => {
      if (event.touches.length > 1) multiTouch = true;
    },
    { passive: true },
  );

  element.addEventListener(
    "touchend",
    (event) => {
      if (multiTouch || event.changedTouches.length !== 1) {
        multiTouch = false;
        return;
      }
      const endX = event.changedTouches[0]?.clientX ?? 0;
      const delta = endX - startX;
      if (Math.abs(delta) < EDGE_SWIPE_MIN) return;
      suppressClick = true;
      onSwipe(delta < 0 ? "left" : "right");
    },
    { passive: true },
  );
}

function handleEdgeSwipe(direction: "left" | "right") {
  if (currentView !== "reader" || !state.comic || settings.readingMode === "webtoon") return;
  if (direction === "left") void goNext();
  else void goPrev();
}

function handleLeftEdgeTap() {
  if (currentView !== "reader" || !state.comic || settings.readingMode === "webtoon") return;
  if (settings.readingDirection === "rtl") void goNext();
  else void goPrev();
}

function handleRightEdgeTap() {
  if (currentView !== "reader" || !state.comic || settings.readingMode === "webtoon") return;
  if (settings.readingDirection === "rtl") void goPrev();
  else void goNext();
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
  updatePageTapZones();
}

function normalizeDoublePageIndex(pageIndex: number): number {
  if (settings.readingMode !== "double") return pageIndex;
  if (settings.readingDirection === "rtl") {
    if (pageIndex <= 0) return 0;
    if (pageIndex % 2 === 0) return pageIndex - 1;
    return pageIndex;
  }
  if (pageIndex % 2 !== 0) return pageIndex - 1;
  return pageIndex;
}

function getDoubleSpreadIndices(pageIndex: number): number[] {
  if (!state.comic || settings.readingMode !== "double") return [pageIndex];
  const total = state.comic.pageCount;
  const normalized = normalizeDoublePageIndex(pageIndex);
  if (settings.readingDirection === "rtl") {
    if (normalized === 0) return [0];
    if (normalized % 2 === 1 && normalized + 1 < total) return [normalized, normalized + 1];
    return [normalized];
  }
  if (normalized % 2 === 0 && normalized + 1 < total) return [normalized, normalized + 1];
  return [normalized];
}

function forwardPageStep(): number {
  if (!state.comic || settings.readingMode !== "double") return 1;
  if (settings.readingDirection === "rtl") {
    return state.currentPage === 0 ? 1 : 2;
  }
  return state.comic.pageCount - state.currentPage > 1 ? 2 : 1;
}

function backwardPageStep(): number {
  if (!state.comic || settings.readingMode !== "double") return 1;
  if (settings.readingDirection === "rtl") {
    return state.currentPage <= 1 ? 1 : 2;
  }
  return state.currentPage <= 1 ? 1 : 2;
}

function formatPageLabel(pageIndex: number): string {
  if (!state.comic) return "";
  const total = state.comic.pageCount;
  const indices = getDoubleSpreadIndices(pageIndex);
  const displayPage = indices[0] + 1;
  if (settings.readingMode === "double" && indices.length === 2) {
    return `${displayPage}-${indices[1] + 1} / ${total}`;
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
    state.currentPage = normalizeDoublePageIndex(state.currentPage);
    const indices = getDoubleSpreadIndices(state.currentPage);
    const displayOrder =
      settings.readingDirection === "rtl" && indices.length === 2
        ? [indices[1], indices[0]]
        : indices;

    const pages = await Promise.all(displayOrder.map((index) => getPage(state.comic!.path, index)));

    els.pageContainer.classList.toggle(
      "rtl-spread-single",
      settings.readingDirection === "rtl" && indices.length === 1,
    );

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

async function openComic(path: string, options?: { silent?: boolean }) {
  resetWebtoonState();
  if (isSmbPath(path)) {
    document.body.classList.add("network-loading");
    await saveNetworkLibraryFolder(smbParentDirectory(path));
  }
  try {
    const meta = await openCbz(path);
    const savedPage = await getProgress(path);
    state.comic = meta;
    state.currentPage = savedPage ?? 0;
    if (state.currentPage >= meta.pageCount) {
      state.currentPage = Math.max(0, meta.pageCount - 1);
    }
    state.currentPage = normalizeDoublePageIndex(state.currentPage);
    settings.lastReadPath = path;
    await saveSettings(settings);
    closeDrawer();
    setView("reader");
    setChromeHidden(true);
    setReadingActive(true);
    applyReadingMode();
    await renderReader();
  } catch (error) {
    if (!options?.silent) {
      showAppMessage(`Could not open comic: ${String(error)}`);
    }
  } finally {
    document.body.classList.remove("network-loading");
  }
}

async function restoreLastSession(): Promise<boolean> {
  const path = settings.lastReadPath;
  if (!path) return false;

  if (isSmbPath(path)) {
    if (!settings.networkHost) return false;
    const ok = await ensureNetworkConnected();
    if (!ok) return false;
  }

  await openComic(path, { silent: true });
  return state.comic !== null;
}

function openLibrary() {
  closeDrawer();
  if (!usesMobileLibrarySetup() && !hasConfiguredLibrary()) {
    void pickLibraryFolder();
    return;
  }
  if (hasConfiguredLibrary()) {
    showLibrarySetup = false;
    librarySource = inferLibrarySource();
    libraryCurrentPath = settings.libraryFolder;
    if (settings.libraryFolder && isSmbPath(settings.libraryFolder)) {
      libraryNavStack = buildSmbNavStackFromPath(settings.libraryFolder);
    } else if (settings.libraryFolder && usesAndroidStorage() && isContentUri(settings.libraryFolder)) {
      libraryNavStack = [{ name: "Library", path: settings.libraryFolder }];
    }
  } else {
    showLibrarySetup = true;
  }
  updateLibrarySetupUi();
  setView("library");
  void refreshLibrary();
}

function setLibrarySource(source: LibrarySource) {
  librarySource = source;
  settings.librarySource = source;
  void saveSettings(settings);

  els.librarySourceTabs.querySelectorAll("[data-source]").forEach((btn) => {
    btn.classList.toggle("active", btn.getAttribute("data-source") === source);
  });

  if (source === "network") {
    if (hasConfiguredLibrary() && settings.libraryFolder && isSmbPath(settings.libraryFolder)) {
      libraryCurrentPath = settings.libraryFolder;
      libraryNavStack = buildSmbNavStackFromPath(settings.libraryFolder);
    } else {
      libraryCurrentPath = networkConnected && settings.networkHost
        ? `smb://${settings.networkHost}/`
        : null;
      libraryNavStack = [];
    }
  } else {
    libraryCurrentPath = settings.libraryFolder;
    if (usesAndroidStorage() && settings.libraryFolder && isContentUri(settings.libraryFolder)) {
      libraryNavStack = [{ name: "Library", path: settings.libraryFolder }];
    } else {
      libraryNavStack = [];
    }
  }

  updateLibrarySetupUi();
  void refreshLibrary();
}

async function connectNetworkLibrary() {
  if (networkConnecting) return;
  const host = els.networkHostInput.value.trim();
  if (!host) {
    showAppMessage("Enter your NAS IP address or hostname (e.g. 192.168.1.50).");
    return;
  }

  networkConnecting = true;
  els.networkConnectBtn.disabled = true;
  els.networkConnectBtn.textContent = "Connecting…";

  try {
    const username = els.networkUsernameInput.value.trim();
    const password = els.networkPasswordInput.value;
    const shares = await smbConnect(host, username, password);
    settings.networkHost = host;
    settings.networkUsername = username || null;
    settings.networkPassword = password || null;
    await saveSettings(settings);
    networkConnected = true;
    networkShareList = shares;
    showLibrarySetup = false;

    if (settings.libraryFolder && isSmbPath(settings.libraryFolder)) {
      libraryCurrentPath = settings.libraryFolder;
      libraryNavStack = buildSmbNavStackFromPath(settings.libraryFolder);
      updateLibrarySetupUi();
      await refreshLibrary();
      return;
    }

    libraryCurrentPath = `smb://${host}/`;
    libraryNavStack = [{ name: host, path: libraryCurrentPath }];
    libraryItems = shares;
    LIBRARY_CACHE.clear();
    renderLibraryBreadcrumb();
    els.libraryEmpty.hidden = shares.length > 0;
    els.libraryEmpty.textContent = shares.length > 0
      ? ""
      : "No shared folders found on this server.";
    els.libraryList.innerHTML = shares
      .map((item) => {
        return `<button class="library-item" data-kind="${item.kind}" data-path="${encodeURIComponent(item.path)}">
          <span class="library-item-title">📁 ${escapeHtml(item.name)}</span>
          <span class="library-item-meta">Share</span>
        </button>`;
      })
      .join("");
    updateLibrarySetupUi();
  } catch (error) {
    networkConnected = false;
    showAppMessage(`Network connection failed: ${String(error)}`);
  } finally {
    networkConnecting = false;
    els.networkConnectBtn.disabled = false;
    els.networkConnectBtn.textContent = "Connect";
  }
}

async function applyLibraryFolderSelection(selected: string) {
  settings.libraryFolder = selected;
  settings.librarySource = "local";
  librarySource = "local";
  libraryCurrentPath = selected;
  libraryNavStack = [{ name: "Library", path: selected }];
  LIBRARY_CACHE.clear();
  showLibrarySetup = false;
  els.libraryFolderInput.value = usesAndroidStorage()
    ? "Connected (Android storage)"
    : selected;
  await saveSettings(settings);
  updateLibrarySetupUi();
  await refreshLibrary();
  setView("library");
  closeDrawer();
}

async function pickLibraryFolder() {
  try {
    if (usesAndroidStorage()) {
      const selected = await pickAndroidLibraryFolder();
      if (!selected) return;
      await applyLibraryFolderSelection(selected);
      return;
    }

    const selected = await open({
      multiple: false,
      directory: true,
    });

    if (typeof selected === "string") {
      settings.libraryFolder = selected;
      settings.librarySource = "local";
      librarySource = "local";
      libraryCurrentPath = selected;
      libraryNavStack = [];
      LIBRARY_CACHE.clear();
      showLibrarySetup = false;
      els.libraryFolderInput.value = selected;
      await saveSettings(settings);
      updateLibrarySetupUi();
      await refreshLibrary();
      setView("library");
      closeDrawer();
    }
  } catch (error) {
    showAppMessage(`Could not open folder picker: ${String(error)}`);
  }
}

function renderLibraryBreadcrumb() {
  if (librarySource === "network") {
    if (!settings.networkHost || !libraryCurrentPath) {
      els.libraryBreadcrumb.innerHTML = "";
      return;
    }

    if (libraryNavStack.length === 0) {
      libraryNavStack = [{ name: settings.networkHost, path: `smb://${settings.networkHost}/` }];
    }

    const crumbs = libraryNavStack.map((item, index) => {
      const isLast = index === libraryNavStack.length - 1;
      if (isLast) {
        return `<span class="crumb current">${escapeHtml(item.name)}</span>`;
      }
      return `<button type="button" class="crumb crumb-btn" data-stack-index="${index}">${escapeHtml(item.name)}</button>`;
    });
    els.libraryBreadcrumb.innerHTML = crumbs.join('<span class="crumb sep">/</span>');
    return;
  }

  if (!settings.libraryFolder || !libraryCurrentPath) {
    els.libraryBreadcrumb.innerHTML = "";
    return;
  }

  if (usesAndroidStorage() && isContentUri(settings.libraryFolder)) {
    if (libraryNavStack.length === 0) {
      libraryNavStack = [{ name: "Library", path: settings.libraryFolder }];
    }
    const crumbs = libraryNavStack.map((item, index) => {
      const isLast = index === libraryNavStack.length - 1;
      if (isLast) {
        return `<span class="crumb current">${escapeHtml(item.name)}</span>`;
      }
      return `<button type="button" class="crumb crumb-btn" data-stack-index="${index}">${escapeHtml(item.name)}</button>`;
    });
    els.libraryBreadcrumb.innerHTML = crumbs.join('<span class="crumb sep">/</span>');
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

async function navigateLibraryTo(path: string, folderName?: string) {
  libraryCurrentPath = path;
  if (librarySource === "network" && isSmbPath(path) && folderName) {
    const existingIndex = libraryNavStack.findIndex((item) => item.path === path);
    if (existingIndex >= 0) {
      libraryNavStack = libraryNavStack.slice(0, existingIndex + 1);
    } else {
      libraryNavStack.push({ name: folderName, path });
    }
  } else if (usesAndroidStorage() && isContentUri(path) && folderName) {
    const existingIndex = libraryNavStack.findIndex((item) => item.path === path);
    if (existingIndex >= 0) {
      libraryNavStack = libraryNavStack.slice(0, existingIndex + 1);
    } else {
      libraryNavStack.push({ name: folderName, path });
    }
  }
  await refreshLibrary();
}

function isLibraryRoot(path: string): boolean {
  if (!settings.libraryFolder) return false;
  if (isSmbPath(path) || isSmbPath(settings.libraryFolder)) {
    return normalizeSmbPath(path) === normalizeSmbPath(settings.libraryFolder);
  }
  if (isContentUri(path)) {
    return path === settings.libraryFolder;
  }
  return (
    path.replace(/\\/g, "/").toLowerCase() ===
    settings.libraryFolder.replace(/\\/g, "/").toLowerCase()
  );
}

function beginLibrarySetupChange() {
  if (!usesMobileLibrarySetup()) {
    void pickLibraryFolder();
    return;
  }
  showLibrarySetup = true;
  updateLibrarySetupUi();
  if (librarySource === "network" && !networkConnected) {
    void ensureNetworkConnected().then((ok) => {
      if (ok) void refreshLibrary();
    });
  }
}

async function refreshLibrary() {
  updateLibrarySetupUi();

  if (librarySource === "network") {
    if (!settings.networkHost) {
      libraryItems = [];
      libraryCurrentPath = null;
      els.libraryList.innerHTML = "";
      els.libraryEmpty.hidden = false;
      els.libraryEmpty.textContent = "Connect to your NAS to browse comics over the network.";
      els.libraryBreadcrumb.innerHTML = "";
      return;
    }

    if (!networkConnected) {
      const ok = await ensureNetworkConnected();
      if (!ok) {
        libraryItems = [];
        libraryCurrentPath = null;
        els.libraryList.innerHTML = "";
        els.libraryEmpty.hidden = false;
        els.libraryEmpty.textContent = "Could not reach your NAS. Tap Change library to update connection details.";
        els.libraryBreadcrumb.innerHTML = "";
        return;
      }
    }

    if (hasConfiguredLibrary() && !showLibrarySetup) {
      if (!libraryCurrentPath) {
        libraryCurrentPath = settings.libraryFolder!;
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
      return;
    }

    if (!libraryCurrentPath) {
      libraryCurrentPath = `smb://${settings.networkHost}/`;
    }

    const hostRoot = `smb://${settings.networkHost}/`;
    if (normalizeSmbPath(libraryCurrentPath) === normalizeSmbPath(hostRoot)) {
      libraryCurrentPath = hostRoot;
      libraryItems = networkShareList;
      renderLibraryBreadcrumb();
      els.libraryEmpty.hidden = networkShareList.length > 0;
      els.libraryEmpty.textContent = networkShareList.length > 0
        ? ""
        : "No shared folders found on this server.";
      els.libraryList.innerHTML = networkShareList
        .map((item) => `<button class="library-item" data-kind="${item.kind}" data-path="${encodeURIComponent(item.path)}">
          <span class="library-item-title">📁 ${escapeHtml(item.name)}</span>
          <span class="library-item-meta">Share</span>
        </button>`)
        .join("");
      return;
    }

    const atShareRoot = isNetworkShareRoot(libraryCurrentPath);
    const cacheKey = `${libraryCurrentPath}|${atShareRoot ? "folders" : "all"}`;

    let entries = LIBRARY_CACHE.get(cacheKey);
    if (!entries) {
      entries = await listLibraryDirectory(libraryCurrentPath, atShareRoot);
      LIBRARY_CACHE.set(cacheKey, entries);
    }

    libraryItems = entries;
    renderLibraryBreadcrumb();
    els.libraryEmpty.hidden = libraryItems.length > 0;
    els.libraryEmpty.textContent = atShareRoot
      ? "No folders found in this share."
      : "This folder is empty.";
    els.libraryList.innerHTML = libraryItems
      .map((item) => {
        const meta =
          item.kind === "folder"
            ? `<span class="library-item-meta">${atShareRoot && isNetworkShareRoot(item.path) ? "Share" : "Folder"}</span>`
            : `<span class="library-item-meta">CBZ</span>`;
        const icon = item.kind === "folder" ? "📁" : "📖";
        return `<button class="library-item" data-kind="${item.kind}" data-path="${encodeURIComponent(item.path)}">
          <span class="library-item-title">${icon} ${escapeHtml(item.name)}</span>
          ${meta}
        </button>`;
      })
      .join("");
    return;
  }

  if (!settings.libraryFolder) {
    libraryItems = [];
    libraryCurrentPath = null;
    els.libraryList.innerHTML = "";
    els.libraryEmpty.hidden = false;
    els.libraryEmpty.textContent = usesMobileLibrarySetup()
      ? "Pick a folder on this device, or use the Network tab for your NAS."
      : "No folder selected. Click Choose library folder or set one in Settings.";
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

  const step = forwardPageStep();
  const next = state.currentPage + step;

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

  const step = backwardPageStep();
  const prev = state.currentPage - step;

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
    librarySource: settings.librarySource,
    networkHost: settings.networkHost,
    networkUsername: settings.networkUsername,
    networkPassword: settings.networkPassword,
    lastReadPath: settings.lastReadPath,
  };
  applyTheme();
  applyReadingMode();
  await saveSettings(settings);
  if (settings.libraryFolder !== libraryCurrentPath) {
    LIBRARY_CACHE.clear();
  }
  libraryCurrentPath = settings.libraryFolder;
  if (state.comic) {
    state.currentPage = normalizeDoublePageIndex(state.currentPage);
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

  document.getElementById("open-library-btn")?.addEventListener("click", () => {
    openLibrary();
  });

  els.prevPageBtn.addEventListener("click", () => void goPrev());
  els.nextPageBtn.addEventListener("click", () => void goNext());

  bindEdgeNav(els.pageZonePrev, handleLeftEdgeTap, handleEdgeSwipe);
  bindEdgeNav(els.pageZoneNext, handleRightEdgeTap, handleEdgeSwipe);

  els.pageContainer.addEventListener("click", (event) => {
    if (!isMobile || !chromeHidden || !state.comic || settings.readingMode === "webtoon") return;
    const target = event.target as HTMLElement;
    if (!target.closest(".page-image")) return;
    const x = (event as MouseEvent).clientX;
    const edge = window.innerWidth * 0.22;
    if (x >= edge && x <= window.innerWidth - edge) revealChromeBriefly();
  });

  let centerTouchStart: { x: number; y: number; multi: boolean } | null = null;
  els.pageContainer.addEventListener(
    "touchstart",
    (event) => {
      if (!isMobile || !state.comic || settings.readingMode === "webtoon") return;
      centerTouchStart = {
        x: event.touches[0]?.clientX ?? 0,
        y: event.touches[0]?.clientY ?? 0,
        multi: event.touches.length > 1,
      };
    },
    { passive: true },
  );
  els.pageContainer.addEventListener(
    "touchmove",
    (event) => {
      if (centerTouchStart && event.touches.length > 1) centerTouchStart.multi = true;
    },
    { passive: true },
  );
  els.pageContainer.addEventListener(
    "touchend",
    (event) => {
      if (!centerTouchStart || !isMobile || !chromeHidden || !state.comic) {
        centerTouchStart = null;
        return;
      }
      if (centerTouchStart.multi || event.changedTouches.length !== 1) {
        centerTouchStart = null;
        return;
      }
      const x = event.changedTouches[0]?.clientX ?? 0;
      const y = event.changedTouches[0]?.clientY ?? 0;
      const dx = x - centerTouchStart.x;
      const dy = y - centerTouchStart.y;
      centerTouchStart = null;
      if (Math.hypot(dx, dy) > 16) return;
      const edge = window.innerWidth * 0.22;
      if (x >= edge && x <= window.innerWidth - edge) revealChromeBriefly();
    },
    { passive: true },
  );

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
        if (hasConfiguredLibrary()) {
          showLibrarySetup = false;
          libraryCurrentPath = settings.libraryFolder;
        }
        updateLibrarySetupUi();
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
      const folderName = target.querySelector(".library-item-title")?.textContent?.replace(/^📁\s*/, "") ?? "Folder";
      void navigateLibraryTo(path, folderName);
    } else {
      void openComic(path);
    }
  });

  els.libraryBreadcrumb.addEventListener("click", (event) => {
    const stackTarget = (event.target as HTMLElement).closest(
      ".crumb-btn[data-stack-index]",
    ) as HTMLElement | null;
    if (stackTarget) {
      const index = Number(stackTarget.dataset.stackIndex ?? "0");
      libraryNavStack = libraryNavStack.slice(0, index + 1);
      libraryCurrentPath =
        libraryNavStack[index]?.path ??
        (librarySource === "network" && settings.networkHost
          ? `smb://${settings.networkHost}/`
          : settings.libraryFolder);
      void refreshLibrary();
      return;
    }

    const target = (event.target as HTMLElement).closest(".crumb-btn") as HTMLElement | null;
    if (!target) return;
    const path = decodeURIComponent(target.dataset.path ?? "");
    void navigateLibraryTo(path);
  });

  els.pageSlider.addEventListener("input", () => {
    if (!state.comic || state.loading) return;
    const page = normalizeDoublePageIndex(Number(els.pageSlider.value));
    els.pageSlider.value = String(page);
    if (page !== state.currentPage) {
      els.pageInfoBtn.textContent = formatPageLabel(page);
    }
  });

  els.pageSlider.addEventListener("change", () => {
    if (!state.comic || state.loading) return;
    const page = normalizeDoublePageIndex(Number(els.pageSlider.value));
    els.pageSlider.value = String(page);
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

  els.libraryPickFolderBtn.addEventListener("click", () => {
    void pickLibraryFolder();
  });

  els.librarySourceTabs.querySelectorAll("[data-source]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const source = btn.getAttribute("data-source") as LibrarySource;
      setLibrarySource(source);
    });
  });

  els.networkConnectBtn.addEventListener("click", () => {
    void connectNetworkLibrary();
  });

  els.libraryChangeBtn.addEventListener("click", () => {
    beginLibrarySetupChange();
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

    const rtl = settings.readingDirection === "rtl";
    if (event.key === "ArrowRight" || event.key === "PageDown") {
      event.preventDefault();
      void (rtl ? goPrev() : goNext());
    } else if (event.key === "ArrowLeft" || event.key === "PageUp") {
      event.preventDefault();
      void (rtl ? goNext() : goPrev());
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
  try {
    appPlatform = await getPlatform();
  } catch {
    appPlatform = /Android/i.test(navigator.userAgent) ? "android" : "desktop";
  }
  isAndroid = appPlatform === "android";
  isMobile = appPlatform === "android" || appPlatform === "ios";

  document.getElementById("library-nav-btn")?.removeAttribute("hidden");
  document.querySelector('.nav-btn[data-view="library"]')?.removeAttribute("hidden");
  applyMobileUi();
  applyDesktopLibraryUi();

  settings = await getSettings();
  if (!["single", "double", "webtoon"].includes(settings.readingMode)) {
    settings.readingMode = "single";
  }
  els.themeSelect.value = settings.theme;
  els.directionSelect.value = settings.readingDirection;
  els.modeSelect.value = settings.readingMode;
  els.fitSelect.value = settings.fitMode;
  els.libraryFolderInput.value = settings.libraryFolder ?? "";
  els.networkHostInput.value = settings.networkHost ?? "";
  els.networkUsernameInput.value = settings.networkUsername ?? "";
  els.networkPasswordInput.value = settings.networkPassword ?? "";

  librarySource = inferLibrarySource();
  settings.librarySource = librarySource;
  els.librarySourceTabs.querySelectorAll("[data-source]").forEach((btn) => {
    btn.classList.toggle("active", btn.getAttribute("data-source") === librarySource);
  });
  showLibrarySetup = !hasConfiguredLibrary();
  updateLibrarySetupUi();

  applyTheme();
  applyReadingMode();
  bindEvents();
  updatePageInfo();

  if (librarySource === "network" && settings.networkHost) {
    await ensureNetworkConnected();
  }

  const restored = await restoreLastSession();
  if (!restored) {
    setView("reader");
    setReadingActive(false);
  }

  if (settings.libraryFolder) {
    libraryCurrentPath = settings.libraryFolder;
    if (isSmbPath(settings.libraryFolder)) {
      libraryNavStack = buildSmbNavStackFromPath(settings.libraryFolder);
    } else if (usesAndroidStorage() && isContentUri(settings.libraryFolder)) {
      libraryNavStack = [{ name: "Library", path: settings.libraryFolder }];
    }
    await refreshLibrary();
  }
}
