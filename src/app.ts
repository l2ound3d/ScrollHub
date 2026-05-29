import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  getPage,
  getProgress,
  getSettings,
  listLibraryDirectory,
  openCbz,
  pickAndroidCbzFile,
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
let mobileChromeAutoHideTimer: ReturnType<typeof setTimeout> | null = null;
let isMobile = false;
let isAndroid = false;
let librarySource: LibrarySource = "local";
let networkConnected = false;
let networkConnecting = false;
let networkShareList: LibraryEntry[] = [];
let showLibrarySetup = false;
let appPlatform = "desktop";
let desktopWindow: ReturnType<typeof getCurrentWindow> | null = null;

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
  mobileTopTapStrip: document.getElementById("mobile-top-tap-strip")!,
  pageInfoWrap: document.getElementById("page-info-wrap")!,
  pageInfoBtn: document.getElementById("page-info-btn") as HTMLButtonElement,
  pageJumpInput: document.getElementById("page-jump-input") as HTMLInputElement,
  comicTitle: document.getElementById("comic-title")!,
  libraryList: document.getElementById("library-list")!,
  libraryEmpty: document.getElementById("library-empty")!,
  libraryBreadcrumb: document.getElementById("library-breadcrumb")!,
  libraryPickFolderBtn: document.getElementById("library-pick-folder-btn") as HTMLButtonElement,
  libraryPhoneHint: document.getElementById("library-phone-hint")!,
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
  fullscreenBtn: document.getElementById("fullscreen-btn") as HTMLButtonElement,
  openLibraryBtn: document.getElementById("open-library-btn") as HTMLButtonElement,
  openComicSheet: document.getElementById("open-comic-sheet")!,
  openComicBackdrop: document.getElementById("open-comic-backdrop") as HTMLButtonElement,
  openComicLocalBtn: document.getElementById("open-comic-local-btn") as HTMLButtonElement,
  openComicNetworkBtn: document.getElementById("open-comic-network-btn") as HTMLButtonElement,
  openComicCancelBtn: document.getElementById("open-comic-cancel-btn") as HTMLButtonElement,
  prevPageBtn: document.getElementById("prev-page-btn") as HTMLButtonElement,
  nextPageBtn: document.getElementById("next-page-btn") as HTMLButtonElement,
  pageZonePrev: document.getElementById("page-zone-prev") as HTMLButtonElement,
  pageZoneNext: document.getElementById("page-zone-next") as HTMLButtonElement,
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
  if (!usesMobileLibrarySetup() && isSmbPath(settings.libraryFolder)) return false;
  if (librarySource === "network") return isSmbPath(settings.libraryFolder);
  return !isSmbPath(settings.libraryFolder);
}

function usesMobileLibrarySetup(): boolean {
  return isMobile || usesAndroidStorage();
}

function normalizeDesktopLibrarySettings() {
  if (usesMobileLibrarySetup()) return;
  librarySource = "local";
  settings.librarySource = "local";
  if (settings.libraryFolder && isSmbPath(settings.libraryFolder)) {
    settings.libraryFolder = null;
  }
}

function applyDesktopLibraryUi() {
  if (usesMobileLibrarySetup()) return;
  document.body.dataset.platform = "desktop";
  els.librarySourceTabs.hidden = true;
  els.libraryNetworkPanel.hidden = true;
  els.libraryChangeBtn.hidden = true;

  const emptySub = document.querySelector(".empty-sub");
  if (emptySub) {
    emptySub.textContent = "Click 📂 to choose a library folder, or drag and drop a CBZ file.";
  }
}

function updateLibrarySetupUi() {
  const configured = hasConfiguredLibrary();
  const showSetup = showLibrarySetup || !configured;
  const mobileSetup = usesMobileLibrarySetup();

  if (!mobileSetup) {
    els.librarySetupPanel.hidden = false;
    els.librarySourceTabs.hidden = true;
    els.libraryNetworkPanel.hidden = true;
    els.libraryChangeBtn.hidden = true;
    els.libraryPhoneHint.hidden = true;
    els.libraryPickFolderBtn.hidden = false;
    els.libraryPickFolderBtn.textContent = configured
      ? "Change library folder"
      : "Choose library folder";
    return;
  }

  els.librarySetupPanel.hidden = !showSetup;
  els.libraryChangeBtn.hidden = !configured || showSetup;
  els.librarySourceTabs.hidden = false;

  if (librarySource === "network") {
    els.libraryNetworkPanel.hidden = !showSetup;
    els.libraryPickFolderBtn.hidden = true;
    els.libraryPhoneHint.hidden = true;
  } else {
    els.libraryNetworkPanel.hidden = true;
    els.libraryPickFolderBtn.hidden = !showSetup || !usesAndroidStorage();
    els.libraryPhoneHint.hidden = !showSetup || !usesAndroidStorage();
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

function isDesktopApp(): boolean {
  return !isMobile && !usesAndroidStorage();
}

function getDesktopWindow() {
  if (!isDesktopApp()) return null;
  if (!desktopWindow) {
    try {
      desktopWindow = getCurrentWindow();
    } catch {
      return null;
    }
  }
  return desktopWindow;
}

async function syncWindowFullscreenState() {
  const win = getDesktopWindow();
  if (!win) return;
  try {
    const active = await win.isFullscreen();
    document.body.classList.toggle("window-fullscreen", active);
    els.fullscreenBtn.classList.toggle("active", active);
  } catch {
    document.body.classList.remove("window-fullscreen");
    els.fullscreenBtn.classList.remove("active");
  }
}

async function toggleWindowFullscreen() {
  const win = getDesktopWindow();
  if (!win) return;
  try {
    const active = await win.isFullscreen();
    await win.setFullscreen(!active);
    document.body.classList.toggle("window-fullscreen", !active);
    els.fullscreenBtn.classList.toggle("active", !active);
    if (!active && currentView === "reader" && state.comic) {
      setChromeHidden(true);
    }
  } catch {
    showAppMessage("Could not toggle fullscreen.");
  }
}

async function exitWindowFullscreen(): Promise<boolean> {
  const win = getDesktopWindow();
  if (!win) return false;
  try {
    if (!(await win.isFullscreen())) return false;
    await win.setFullscreen(false);
    document.body.classList.remove("window-fullscreen");
    els.fullscreenBtn.classList.remove("active");
    return true;
  } catch {
    return false;
  }
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
    drawerHint.textContent = "ScrollHub v0.1.3-android";
  }

  const emptySub = document.querySelector(".empty-sub");
  if (emptySub) {
    emptySub.textContent =
      "Tap 📂 to open a comic. Double-tap the top edge while reading to show or hide controls.";
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
  updateMobileTopTapStrip();
}

const MOBILE_TAP_SLOP_PX = 24;
const MOBILE_SWIPE_THRESHOLD_PX = 48;
const MOBILE_DOUBLE_TAP_MS = 320;
const MOBILE_CHROME_AUTO_HIDE_MS = 3500;
const MOBILE_TOP_TAP_ZONE_PX = 56;

function getMobileTopTapZoneBottom(): number {
  const safeTop = Number.parseFloat(
    getComputedStyle(document.body).getPropertyValue("--safe-top"),
  );
  return MOBILE_TOP_TAP_ZONE_PX + (Number.isFinite(safeTop) ? safeTop : 0);
}

function isMobileTopEdge(clientY: number): boolean {
  return clientY <= getMobileTopTapZoneBottom();
}
const MOBILE_MAX_ZOOM = 5;
const MOBILE_PINCH_ACTIVATION_PX = 18;
const MOBILE_PAN_MOMENTUM_MIN_VELOCITY = 0.04;
const MOBILE_PAN_MOMENTUM_MAX_VELOCITY = 8;
const MOBILE_PAN_MOMENTUM_FRICTION = 0.0005;

let mobileZoomScale = 1;
let mobileZoomPanX = 0;
let mobileZoomPanY = 0;
let mobileZoomTouchIds = new Map<number, { x: number; y: number }>();
let mobileZoomPinching = false;
let mobileZoomPanning = false;
let mobileZoomPanLastX = 0;
let mobileZoomPanLastY = 0;
let mobileZoomLastPinchDistance = 0;
let mobileZoomRafId = 0;
let mobileZoomPinchT1: { x: number; y: number } | null = null;
let mobileZoomPinchT2: { x: number; y: number } | null = null;
let mobileZoomPanDeltaX = 0;
let mobileZoomPanDeltaY = 0;
let mobileZoomVelocityX = 0;
let mobileZoomVelocityY = 0;
let mobileZoomPanLastTime = 0;
let mobileZoomFrameLastTime = 0;
let mobileZoomMomentumActive = false;
let mobileZoomCachedViewW = 0;
let mobileZoomCachedViewH = 0;
let mobileZoomCachedContentW = 0;
let mobileZoomCachedContentH = 0;
let mobileZoomTargetContent: HTMLElement | null = null;
let mobileZoomTargetViewport: HTMLElement | null = null;
let mobileZoomTargetSlot: HTMLElement | null = null;
let mobileZoomContentAnchored = false;
let mobileZoomAnchorX = 0;
let mobileZoomAnchorY = 0;
let mobileZoomPanCandidate = false;
let mobileZoomPinchAwaitingActivation = false;
let mobileZoomPinchInitialSpan = 0;
let webtoonPersistedZoomScale = 1;
let webtoonGlobalPanX = 0;
let paginatedPersistedZoomScale = 1;
let paginatedPersistedPanX = 0;
let paginatedPersistedPanY = 0;

function isMobileWebtoonZoom(): boolean {
  return settings.readingMode === "webtoon";
}

function isMobilePaginatedZoom(): boolean {
  return isMobile && settings.readingMode !== "webtoon";
}

function usesMobileOriginalFit(): boolean {
  return isMobilePaginatedZoom() && settings.fitMode === "original";
}

function readMobileZoomContentSize(content: HTMLElement) {
  return {
    w: Math.max(content.scrollWidth, content.offsetWidth),
    h: Math.max(content.scrollHeight, content.offsetHeight),
  };
}

function computeOriginalFitScale(): number {
  const viewport = getMobileZoomViewport();
  const content = getMobileZoomContent();
  if (!viewport || !content) return 1;

  const viewW = viewport.clientWidth;
  const viewH = viewport.clientHeight;
  if (viewW <= 0 || viewH <= 0) return 1;

  const { w, h } = readMobileZoomContentSize(content);
  if (w <= 0 || h <= 0) return 1;

  return Math.min(1, viewW / w, viewH / h);
}

function mobileZoomRestScale(): number {
  if (!usesMobileOriginalFit()) return 1;
  return computeOriginalFitScale();
}

function getMobileMinZoomScale(): number {
  return mobileZoomRestScale();
}

function mobilePaginatedContentExceedsViewport(scale = mobileZoomScale): boolean {
  const viewport = getMobileZoomViewport();
  const content = getMobileZoomContent();
  if (!viewport || !content) return false;

  const { w, h } = readMobileZoomContentSize(content);
  return (
    w * scale > viewport.clientWidth + 1 ||
    h * scale > viewport.clientHeight + 1
  );
}

function isMobilePaginatedPanEligible(): boolean {
  if (isMobileWebtoonZoom()) return mobileZoomScale > 1.01;
  return (
    mobilePaginatedContentExceedsViewport() ||
    mobileZoomScale > mobileZoomRestScale() + 0.01
  );
}

function applyOriginalFitZoom() {
  refreshPaginatedZoomTargets();
  const viewport = getMobileZoomViewport();
  const content = getMobileZoomContent();
  if (!viewport || !content) return;

  cancelMobileZoomRaf();
  mobileZoomPinching = false;
  mobileZoomPanning = false;
  mobileZoomPanCandidate = false;
  stopMobileZoomMomentum();

  // Drop any active zoom transform before anchoring so layout is flex-centered.
  content.style.transform = "";
  content.style.transformOrigin = "";
  releaseMobileZoomContentAnchor(content);
  content.removeAttribute("data-zoom-anchored");
  mobileZoomContentAnchored = false;
  mobileZoomPanX = 0;
  mobileZoomPanY = 0;

  void viewport.offsetHeight;

  cacheMobileZoomMetrics();
  const rest = computeOriginalFitScale();
  mobileZoomScale = rest;

  if (rest < 0.999) {
    anchorPaginatedZoomContent(viewport, content);
    clampMobileZoomPan();
    markMobileZoomContentActive(true);
    els.pageContainer.classList.add("mobile-zoomed");
    content.style.transformOrigin = "0 0";
    content.style.transform = `translate3d(${mobileZoomPanX}px, ${mobileZoomPanY}px, 0) scale(${rest})`;
  } else {
    markMobileZoomContentActive(false);
    mobileZoomContentAnchored = false;
    releaseMobileZoomContentAnchor(content);
    content.style.transform = "";
    content.style.transformOrigin = "";
    content.removeAttribute("data-zoom-anchored");
    els.pageContainer.classList.remove("mobile-zoomed");
  }
}

function setupPaginatedZoomAfterRender() {
  refreshPaginatedZoomTargets();
  cacheMobileZoomMetrics();
  const rest = mobileZoomRestScale();

  if (usesMobileOriginalFit()) {
    if (paginatedPersistedZoomScale > rest + 0.01) {
      applyPersistedPaginatedZoom();
    } else {
      applyOriginalFitZoom();
    }
    return;
  }

  if (paginatedPersistedZoomScale > 1.01) {
    applyPersistedPaginatedZoom();
  } else {
    resetMobileZoom();
  }
}

function clearPaginatedPersistedZoom() {
  paginatedPersistedZoomScale = 1;
  paginatedPersistedPanX = 0;
  paginatedPersistedPanY = 0;
}

function syncPaginatedPersistedZoomFromActive() {
  if (!isMobilePaginatedZoom() || mobileZoomScale <= mobileZoomRestScale() + 0.01) return;
  paginatedPersistedZoomScale = mobileZoomScale;
  paginatedPersistedPanX = mobileZoomPanX;
  paginatedPersistedPanY = mobileZoomPanY;
}

function refreshPaginatedZoomTargets() {
  mobileZoomTargetSlot = null;
  mobileZoomTargetViewport = els.pageContainer.querySelector(
    ".page-zoom-viewport:not(.webtoon-slot-viewport)",
  );
  mobileZoomTargetContent =
    mobileZoomTargetViewport?.querySelector(".page-zoom-content") ?? null;
}

function anchorPaginatedZoomContent(viewport: HTMLElement, content: HTMLElement) {
  const { anchorX, anchorY } = anchorWebtoonSlotContent(viewport, content);
  mobileZoomAnchorX = anchorX;
  mobileZoomAnchorY = anchorY;
  mobileZoomContentAnchored = true;
  content.dataset.zoomAnchored = "1";
}

function applyPersistedPaginatedZoom() {
  const rest = mobileZoomRestScale();
  if (paginatedPersistedZoomScale <= rest + 0.01) return;

  refreshPaginatedZoomTargets();
  const viewport = getMobileZoomViewport();
  const content = getMobileZoomContent();
  if (!viewport || !content) return;

  mobileZoomScale = paginatedPersistedZoomScale;
  mobileZoomPanX = paginatedPersistedPanX;
  mobileZoomPanY = paginatedPersistedPanY;
  anchorPaginatedZoomContent(viewport, content);
  cacheMobileZoomMetrics();
  clampMobileZoomPan();
  els.pageContainer.classList.add("mobile-zoomed");
  content.style.transformOrigin = "0 0";
  content.style.transform = `translate3d(${mobileZoomPanX}px, ${mobileZoomPanY}px, 0) scale(${mobileZoomScale})`;
}

function ensureWebtoonSlotZoomDom(slot: HTMLElement): boolean {
  if (slot.querySelector(".page-zoom-content")) return true;
  const img = slot.querySelector("img.webtoon-image, img.page-image");
  if (!img) return false;

  const viewport = document.createElement("div");
  viewport.className = "page-zoom-viewport webtoon-slot-viewport";
  const content = document.createElement("div");
  content.className = "page-zoom-content";
  img.replaceWith(viewport);
  content.appendChild(img);
  viewport.appendChild(content);
  slot.appendChild(viewport);
  return true;
}

function resetWebtoonSlotZoom(slot: HTMLElement, unwrap = true) {
  slot.classList.remove("webtoon-slot-has-zoom");
  slot.style.minHeight = "";

  const viewport = slot.querySelector(".page-zoom-viewport.webtoon-slot-viewport") as HTMLElement | null;
  if (viewport) viewport.style.minHeight = "";

  const content = slot.querySelector(".page-zoom-content") as HTMLElement | null;
  const img = content?.querySelector("img");
  if (content) {
    releaseMobileZoomContentAnchor(content);
    content.style.transform = "";
    content.style.transformOrigin = "";
    content.classList.remove("mobile-zoom-active");
    content.removeAttribute("data-zoom-anchored");
  }

  if (unwrap && viewport && content && img) {
    viewport.replaceWith(img);
  }
}

function ensureAllLoadedWebtoonSlotsWrapped() {
  els.pageContainer.querySelectorAll<HTMLElement>(".webtoon-page-slot").forEach((slot) => {
    if (slot.querySelector("img")) ensureWebtoonSlotZoomDom(slot);
  });
}

function anchorWebtoonSlotContent(viewport: HTMLElement, content: HTMLElement) {
  const vpRect = viewport.getBoundingClientRect();
  const contentRect = content.getBoundingClientRect();
  const anchorX = contentRect.left - vpRect.left;
  const anchorY = contentRect.top - vpRect.top;
  content.style.position = "absolute";
  content.style.left = `${anchorX}px`;
  content.style.top = `${anchorY}px`;
  content.style.margin = "0";
  return { anchorX, anchorY };
}

function prepareWebtoonSlotForZoom(slot: HTMLElement) {
  ensureWebtoonSlotZoomDom(slot);
  const viewport = slot.querySelector(".page-zoom-viewport") as HTMLElement | null;
  const content = slot.querySelector(".page-zoom-content") as HTMLElement | null;
  if (!viewport || !content) return null;
  if (!content.dataset.zoomAnchored) {
    anchorWebtoonSlotContent(viewport, content);
    content.dataset.zoomAnchored = "1";
  }
  return { viewport, content };
}

function applyTransformToWebtoonSlot(slot: HTMLElement, scale: number, panX: number) {
  if (!slot.querySelector("img") && !slot.querySelector(".page-zoom-content")) return;
  if (scale <= 1.01) {
    resetWebtoonSlotZoom(slot, true);
    return;
  }

  const prepared = prepareWebtoonSlotForZoom(slot);
  if (!prepared) return;
  const { content } = prepared;

  content.style.transformOrigin = "0 0";
  content.style.transform = `translate3d(${panX}px, 0, 0) scale(${scale})`;
  syncWebtoonSlotExpandedHeight(slot, content, scale);
  slot.classList.add("webtoon-slot-has-zoom");
}

function clampWebtoonGlobalPanX() {
  const slot = mobileZoomTargetSlot ?? getPrimaryWebtoonSlot();
  if (!slot) return;
  mobileZoomPanX = clampWebtoonPanXValue(mobileZoomPanX, mobileZoomScale, slot);
  webtoonGlobalPanX = mobileZoomPanX;
}

function clampWebtoonPanXValue(panX: number, scale: number, slot: HTMLElement): number {
  const viewWidth = els.pageContainer.clientWidth;
  const img =
    (slot.querySelector(".page-zoom-content img") as HTMLElement | null) ??
    (slot.querySelector("img") as HTMLElement | null);
  if (!img) return panX;

  const contentWidth = img.offsetWidth * scale;
  const anchorX = mobileZoomContentAnchored ? mobileZoomAnchorX : 0;

  if (contentWidth <= viewWidth) {
    return (viewWidth - contentWidth) / 2 - anchorX;
  }
  return Math.min(-anchorX, Math.max(viewWidth - contentWidth - anchorX, panX));
}

function applyWebtoonScreenFocalZoom(
  prevScale: number,
  newScale: number,
  focalClientX: number,
  focalClientY: number,
) {
  setMobileZoomTargetFromFocal(focalClientX, focalClientY);

  const slot = mobileZoomTargetSlot;
  if (!slot) return;

  ensureWebtoonSlotZoomDom(slot);
  refreshMobileWebtoonZoomTargets();

  const viewport = getMobileZoomViewport();
  const content = getMobileZoomContent();
  if (!viewport || !content) return;

  if (!content.dataset.zoomAnchored) {
    captureWebtoonPinchBaseline(viewport, content);
  } else {
    syncWebtoonPinchAnchorFromTarget();
  }

  const vpRect = viewport.getBoundingClientRect();
  const anchorX = mobileZoomAnchorX;
  const prevPanX = webtoonGlobalPanX;

  const localX = (focalClientX - vpRect.left - anchorX - prevPanX) / prevScale;
  let newPanX = focalClientX - vpRect.left - anchorX - localX * newScale;
  newPanX = clampWebtoonPanXValue(newPanX, newScale, slot);

  const container = els.pageContainer;
  const containerRect = container.getBoundingClientRect();
  const focalInContainer = focalClientY - containerRect.top;
  const focalDocY = container.scrollTop + focalInContainer;
  const ratio = newScale / prevScale;

  mobileZoomScale = newScale;
  mobileZoomPanX = newPanX;

  ensureAllLoadedWebtoonSlotsWrapped();
  applyWebtoonGlobalZoom(newScale, newPanX);

  void container.offsetHeight;

  const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight);
  const targetScroll = focalDocY * ratio - focalInContainer;
  container.scrollTop = Math.max(0, Math.min(maxScroll, targetScroll));
}

function finishWebtoonPinchUpdate(
  prevScale: number,
  newScale: number,
  focalClientX: number,
  focalClientY: number,
) {
  if (newScale <= 1.01) {
    mobileZoomScale = 1;
    mobileZoomPanX = 0;
    clearWebtoonGlobalZoom();
    mobileZoomContentAnchored = false;
    return;
  }

  applyWebtoonScreenFocalZoom(prevScale, newScale, focalClientX, focalClientY);
}

function applyWebtoonGlobalZoom(scale: number, panX: number) {
  webtoonPersistedZoomScale = scale;
  webtoonGlobalPanX = panX;
  mobileZoomScale = scale;
  mobileZoomPanX = panX;

  if (scale <= 1.01) {
    clearWebtoonGlobalZoom();
    return;
  }

  els.pageContainer.querySelectorAll<HTMLElement>(".webtoon-page-slot").forEach((slot) => {
    applyTransformToWebtoonSlot(slot, scale, panX);
  });
  mobileZoomPanX = panX;
  webtoonGlobalPanX = panX;
  els.pageContainer.classList.add("webtoon-global-zoomed");
}

function clearWebtoonGlobalZoom(focalClientY?: number) {
  const container = els.pageContainer;
  const scale = webtoonPersistedZoomScale;
  let scrollRestore: number | null = null;

  if (scale > 1.01) {
    const containerRect = container.getBoundingClientRect();
    const focalOffset =
      focalClientY !== undefined
        ? focalClientY - containerRect.top
        : containerRect.height * 0.5;
    const focalDocY = container.scrollTop + focalOffset;
    scrollRestore = focalDocY / scale - focalOffset;
  }

  webtoonPersistedZoomScale = 1;
  webtoonGlobalPanX = 0;
  cleanupInFlowWebtoonZoomWraps();
  els.pageContainer.classList.remove("webtoon-global-zoomed");

  if (scrollRestore !== null) {
    void container.offsetHeight;
    const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight);
    container.scrollTop = Math.max(0, Math.min(maxScroll, scrollRestore));
  }
}

function syncWebtoonPinchAnchorFromTarget() {
  const viewport = getMobileZoomViewport();
  const content = getMobileZoomContent();
  if (!viewport || !content) return;

  const anchorLeft = Number.parseFloat(content.style.left);
  const anchorTop = Number.parseFloat(content.style.top);
  if (Number.isFinite(anchorLeft) && Number.isFinite(anchorTop)) {
    mobileZoomAnchorX = anchorLeft;
    mobileZoomAnchorY = anchorTop;
    mobileZoomContentAnchored = true;
    return;
  }

  const vpRect = viewport.getBoundingClientRect();
  const contentRect = content.getBoundingClientRect();
  const scale = mobileZoomScale > 1.01 ? mobileZoomScale : 1;
  mobileZoomAnchorX = (contentRect.left - vpRect.left - mobileZoomPanX) / scale;
  mobileZoomAnchorY = (contentRect.top - vpRect.top) / scale;
  mobileZoomContentAnchored = true;
}

function captureWebtoonPinchBaseline(viewport: HTMLElement, content: HTMLElement) {
  const { anchorX, anchorY } = anchorWebtoonSlotContent(viewport, content);
  mobileZoomAnchorX = anchorX;
  mobileZoomAnchorY = anchorY;
  mobileZoomContentAnchored = true;
  content.dataset.zoomAnchored = "1";
}

function syncWebtoonSlotExpandedHeight(slot: HTMLElement, content: HTMLElement, scale: number) {
  const img = content.querySelector("img");
  if (!img) return;
  const expandedHeight = Math.ceil(img.offsetHeight * scale);
  slot.style.minHeight = `${expandedHeight}px`;
  const viewport = slot.querySelector(".page-zoom-viewport.webtoon-slot-viewport") as HTMLElement | null;
  if (viewport) viewport.style.minHeight = `${expandedHeight}px`;
}

function clearWebtoonPersistedZoom(focalClientY?: number) {
  clearWebtoonGlobalZoom(focalClientY);
}

function stopMobileZoomMomentum() {
  mobileZoomMomentumActive = false;
  mobileZoomVelocityX = 0;
  mobileZoomVelocityY = 0;
  mobileZoomFrameLastTime = 0;
}

function trackMobilePanVelocity(clientX: number, clientY: number) {
  const now = performance.now();
  if (mobileZoomPanLastTime > 0) {
    const dt = Math.max(now - mobileZoomPanLastTime, 8);
    const vx = (clientX - mobileZoomPanLastX) / dt;
    const vy = (clientY - mobileZoomPanLastY) / dt;
    mobileZoomVelocityX = mobileZoomVelocityX * 0.35 + vx * 0.65;
    mobileZoomVelocityY = mobileZoomVelocityY * 0.35 + vy * 0.65;
  }
  mobileZoomPanLastTime = now;
}

function startMobilePanMomentum() {
  if (isMobileWebtoonZoom()) {
    mobileZoomVelocityY = 0;
  }

  const speed = Math.hypot(mobileZoomVelocityX, mobileZoomVelocityY);
  if (speed < MOBILE_PAN_MOMENTUM_MIN_VELOCITY) {
    stopMobileZoomMomentum();
    return;
  }

  if (speed > MOBILE_PAN_MOMENTUM_MAX_VELOCITY) {
    const scale = MOBILE_PAN_MOMENTUM_MAX_VELOCITY / speed;
    mobileZoomVelocityX *= scale;
    mobileZoomVelocityY *= scale;
  }

  mobileZoomMomentumActive = true;
  mobileZoomFrameLastTime = 0;
  scheduleMobileZoomFrame();
}

function clampMobileZoomPanWithMomentumStop() {
  const beforeX = mobileZoomPanX;
  const beforeY = mobileZoomPanY;
  if (isMobileWebtoonZoom()) {
    clampWebtoonGlobalPanX();
  } else {
    clampMobileZoomPan();
  }
  if (mobileZoomPanX === beforeX) {
    mobileZoomVelocityX = 0;
  }
  if (mobileZoomPanY === beforeY) {
    mobileZoomVelocityY = 0;
  }
}

function cancelMobileZoomRaf() {
  if (mobileZoomRafId) {
    cancelAnimationFrame(mobileZoomRafId);
    mobileZoomRafId = 0;
  }
  mobileZoomPinchT1 = null;
  mobileZoomPinchT2 = null;
  mobileZoomPanDeltaX = 0;
  mobileZoomPanDeltaY = 0;
  stopMobileZoomMomentum();
}

function scheduleMobileZoomFrame() {
  if (mobileZoomRafId) return;
  mobileZoomRafId = requestAnimationFrame((timestamp) => {
    mobileZoomRafId = 0;

    if (mobileZoomPinching && mobileZoomPinchT1 && mobileZoomPinchT2) {
      updateMobilePinchGesture(
        mobileZoomPinchT1.x,
        mobileZoomPinchT1.y,
        mobileZoomPinchT2.x,
        mobileZoomPinchT2.y,
      );
      return;
    }

    if (mobileZoomPanning && (mobileZoomPanDeltaX !== 0 || mobileZoomPanDeltaY !== 0)) {
      mobileZoomPanX += mobileZoomPanDeltaX;
      if (!isMobileWebtoonZoom()) {
        mobileZoomPanY += mobileZoomPanDeltaY;
      }
      mobileZoomPanDeltaX = 0;
      mobileZoomPanDeltaY = 0;
      clampMobileZoomPanWithMomentumStop();
      applyMobileZoomTransform();
      return;
    }

    if (mobileZoomMomentumActive && isMobilePaginatedPanEligible() && getMobileZoomContent()) {
      if (!mobileZoomFrameLastTime) {
        mobileZoomFrameLastTime = timestamp;
      }
      const dt = Math.min(timestamp - mobileZoomFrameLastTime, 32);
      mobileZoomFrameLastTime = timestamp;

      const beforeX = mobileZoomPanX;
      const beforeY = mobileZoomPanY;
      mobileZoomPanX += mobileZoomVelocityX * dt;
      if (!isMobileWebtoonZoom()) {
        mobileZoomPanY += mobileZoomVelocityY * dt;
      }

      const decay = Math.exp(-MOBILE_PAN_MOMENTUM_FRICTION * dt);
      mobileZoomVelocityX *= decay;
      mobileZoomVelocityY *= decay;

      clampMobileZoomPanWithMomentumStop();
      if (mobileZoomPanX === beforeX) {
        mobileZoomVelocityX = 0;
      }
      if (mobileZoomPanY === beforeY) {
        mobileZoomVelocityY = 0;
      }

      applyMobileZoomTransform();

      const speed = Math.hypot(mobileZoomVelocityX, mobileZoomVelocityY);
      if (speed < MOBILE_PAN_MOMENTUM_MIN_VELOCITY) {
        stopMobileZoomMomentum();
      } else {
        scheduleMobileZoomFrame();
      }
    }
  });
}

function cacheMobileZoomMetrics() {
  const viewport = getMobileZoomViewport();
  const content = getMobileZoomContent();
  if (!viewport || !content) return;
  mobileZoomCachedViewW = viewport.clientWidth;
  mobileZoomCachedViewH = viewport.clientHeight;
  const size = readMobileZoomContentSize(content);
  mobileZoomCachedContentW = size.w;
  mobileZoomCachedContentH = size.h;
}

function markMobileZoomContentActive(active: boolean) {
  const content = getMobileZoomContent();
  if (!content) return;
  content.classList.toggle("mobile-zoom-active", active);
}

function findWebtoonSlotAtPoint(clientX: number, clientY: number): HTMLElement | null {
  const hit = document.elementFromPoint(clientX, clientY);
  const fromHit = hit?.closest(".webtoon-page-slot") as HTMLElement | null;
  if (fromHit?.querySelector("img")) return fromHit;

  const containerRect = els.pageContainer.getBoundingClientRect();
  const slots = els.pageContainer.querySelectorAll<HTMLElement>(".webtoon-page-slot");

  for (const slot of slots) {
    if (!slot.querySelector("img")) continue;
    const rect = slot.getBoundingClientRect();
    const visibleTop = Math.max(rect.top, containerRect.top);
    const visibleBottom = Math.min(rect.bottom, containerRect.bottom);
    if (visibleBottom <= visibleTop) continue;
    if (
      clientX >= rect.left &&
      clientX <= rect.right &&
      clientY >= visibleTop &&
      clientY <= visibleBottom
    ) {
      return slot;
    }
  }

  return null;
}

function getPrimaryWebtoonSlot(): HTMLElement | null {
  if (!state.comic || settings.readingMode !== "webtoon") return null;
  return els.pageContainer.querySelector(
    `.webtoon-page-slot[data-page-index="${state.currentPage}"]`,
  ) as HTMLElement | null;
}

function cleanupInFlowWebtoonZoomWraps() {
  els.pageContainer.querySelectorAll<HTMLElement>(".webtoon-page-slot").forEach((slot) => {
    if (slot.querySelector(".page-zoom-viewport.webtoon-slot-viewport")) {
      resetWebtoonSlotZoom(slot, true);
    }
  });
}

function clearMobileZoomTargetStyles() {
  cleanupInFlowWebtoonZoomWraps();
  els.pageContainer.querySelectorAll<HTMLElement>(".page-zoom-content").forEach((el) => {
    if (el.closest(".webtoon-page-slot")) return;
    releaseMobileZoomContentAnchor(el);
    el.style.transform = "";
    el.style.transformOrigin = "";
  });
  mobileZoomTargetContent = null;
  mobileZoomTargetViewport = null;
  mobileZoomTargetSlot = null;
  mobileZoomContentAnchored = false;
  mobileZoomAnchorX = 0;
  mobileZoomAnchorY = 0;
  mobileZoomPinchAwaitingActivation = false;
}

function refreshMobileWebtoonZoomTargets() {
  if (!mobileZoomTargetSlot) return;
  mobileZoomTargetContent = mobileZoomTargetSlot.querySelector(".page-zoom-content");
  mobileZoomTargetViewport = mobileZoomTargetSlot.querySelector(".page-zoom-viewport");
}

function setMobileZoomTargetFromFocal(focalX: number, focalY: number) {
  if (isMobileWebtoonZoom()) {
    const slot = findWebtoonSlotAtPoint(focalX, focalY);
    if (slot) {
      mobileZoomTargetSlot = slot;
      refreshMobileWebtoonZoomTargets();
      if (webtoonPersistedZoomScale > 1.01) {
        mobileZoomScale = webtoonPersistedZoomScale;
        mobileZoomPanX = webtoonGlobalPanX;
      }
      return;
    }
  }

  mobileZoomTargetSlot = null;
  mobileZoomTargetContent = els.pageContainer.querySelector(
    ".page-zoom-viewport:not(.webtoon-slot-viewport) > .page-zoom-content",
  );
  mobileZoomTargetViewport = els.pageContainer.querySelector(
    ".page-zoom-viewport:not(.webtoon-slot-viewport)",
  );
}

function getMobileZoomViewport(): HTMLElement | null {
  return mobileZoomTargetViewport;
}

function getMobileZoomContent(): HTMLElement | null {
  return mobileZoomTargetContent;
}

function anchorMobileZoomContent(viewport: HTMLElement, content: HTMLElement) {
  const vpRect = viewport.getBoundingClientRect();
  const contentRect = content.getBoundingClientRect();
  mobileZoomAnchorX = contentRect.left - vpRect.left;
  mobileZoomAnchorY = contentRect.top - vpRect.top;
  content.style.position = "absolute";
  content.style.left = `${mobileZoomAnchorX}px`;
  content.style.top = `${mobileZoomAnchorY}px`;
  content.style.margin = "0";
  mobileZoomPanX = 0;
  mobileZoomPanY = 0;
  mobileZoomContentAnchored = true;
}

function releaseMobileZoomContentAnchor(content: HTMLElement) {
  content.style.position = "";
  content.style.left = "";
  content.style.top = "";
  content.style.margin = "";
}

function capturePinchBaseline(viewport: HTMLElement, content: HTMLElement) {
  anchorMobileZoomContent(viewport, content);
}

function resetMobileZoom(focalClientY?: number) {
  cancelMobileZoomRaf();
  markMobileZoomContentActive(false);
  mobileZoomScale = 1;
  mobileZoomPanX = 0;
  mobileZoomPanY = 0;
  mobileZoomPinching = false;
  mobileZoomPanning = false;
  mobileZoomPanCandidate = false;
  mobileZoomLastPinchDistance = 0;
  clearWebtoonPersistedZoom(focalClientY);
  clearPaginatedPersistedZoom();
  clearMobileZoomTargetStyles();
  els.pageContainer.classList.remove("mobile-zoomed");
}

function exitMobileZoom(focalClientY?: number) {
  if (usesMobileOriginalFit()) {
    clearPaginatedPersistedZoom();
    clearWebtoonPersistedZoom(focalClientY);
    applyOriginalFitZoom();
    return;
  }
  mobileZoomScale = 1;
  mobileZoomPanX = 0;
  mobileZoomPanY = 0;
  resetMobileZoom(focalClientY);
}

function snapMobileZoomAtRest() {
  if (isMobileWebtoonZoom()) {
    if (mobileZoomScale > 1.01) return;
    resetMobileZoom();
    return;
  }
  if (usesMobileOriginalFit()) {
    if (mobileZoomScale > mobileZoomRestScale() + 0.01) return;
    clearPaginatedPersistedZoom();
    applyOriginalFitZoom();
    return;
  }
  if (mobileZoomScale > 1.01) return;
  resetMobileZoom();
}

function applyMobileZoomTransform() {
  if (isMobileWebtoonZoom()) {
    if (mobileZoomScale <= 1.01) {
      snapMobileZoomAtRest();
      return;
    }
    clampWebtoonGlobalPanX();
    applyWebtoonGlobalZoom(mobileZoomScale, mobileZoomPanX);
    return;
  }

  const viewport = getMobileZoomViewport();
  const content = getMobileZoomContent();
  if (!viewport || !content) return;

  const rest = mobileZoomRestScale();
  const minScale = getMobileMinZoomScale();

  if (!usesMobileOriginalFit()) {
    if (mobileZoomScale <= 1.01) {
      snapMobileZoomAtRest();
      return;
    }
  } else if (mobileZoomScale < minScale - 0.01) {
    applyOriginalFitZoom();
    return;
  }

  if (
    usesMobileOriginalFit() &&
    mobileZoomScale <= rest + 0.01 &&
    mobileZoomScale >= rest - 0.01 &&
    Math.abs(mobileZoomPanX) < 0.5 &&
    Math.abs(mobileZoomPanY) < 0.5
  ) {
    applyOriginalFitZoom();
    return;
  }

  if (!mobileZoomContentAnchored) {
    anchorPaginatedZoomContent(viewport, content);
  }

  clampMobileZoomPan();
  els.pageContainer.classList.add("mobile-zoomed");
  content.style.transformOrigin = "0 0";
  content.style.transform = `translate3d(${mobileZoomPanX}px, ${mobileZoomPanY}px, 0) scale(${mobileZoomScale})`;
  syncPaginatedPersistedZoomFromActive();
}

function applyFocalPinchPan(
  prevScale: number,
  newScale: number,
  focalVpX: number,
  focalVpY: number,
) {
  const focalRelX = focalVpX - mobileZoomAnchorX;
  const focalRelY = focalVpY - mobileZoomAnchorY;
  const ratio = prevScale > 0 ? newScale / prevScale : newScale;

  mobileZoomPanX += focalRelX * (1 - ratio);
  if (!isMobileWebtoonZoom()) {
    mobileZoomPanY += focalRelY * (1 - ratio);
  }

  mobileZoomScale = newScale;
}

function beginMobilePinchGesture(touch1: Touch, touch2: Touch) {
  const focalX = (touch1.clientX + touch2.clientX) / 2;
  const focalY = (touch1.clientY + touch2.clientY) / 2;
  const initialSpan = Math.hypot(touch2.clientX - touch1.clientX, touch2.clientY - touch1.clientY);

  setMobileZoomTargetFromFocal(focalX, focalY);

  if (isMobileWebtoonZoom()) {
    if (!mobileZoomTargetSlot) {
      mobileZoomPinching = false;
      return;
    }
    ensureWebtoonSlotZoomDom(mobileZoomTargetSlot);
    refreshMobileWebtoonZoomTargets();
  } else if (mobileZoomTargetSlot) {
    ensureWebtoonSlotZoomDom(mobileZoomTargetSlot);
    refreshMobileWebtoonZoomTargets();
  }

  const viewport = getMobileZoomViewport();
  const content = getMobileZoomContent();
  if (!viewport || !content) return;

  const rest = mobileZoomRestScale();
  const continuingZoom = isMobileWebtoonZoom()
    ? webtoonPersistedZoomScale > 1.01
    : paginatedPersistedZoomScale > rest + 0.01 ||
      (mobileZoomContentAnchored &&
        mobileZoomTargetSlot?.querySelector(".page-zoom-content") === content &&
        (mobileZoomScale > rest + 0.01 ||
          (usesMobileOriginalFit() && Math.abs(mobileZoomScale - rest) > 0.01)));

  if (continuingZoom) {
    mobileZoomPinchAwaitingActivation = false;
    if (isMobileWebtoonZoom()) {
      mobileZoomScale = webtoonPersistedZoomScale;
      mobileZoomPanX = webtoonGlobalPanX;
      refreshMobileWebtoonZoomTargets();
      syncWebtoonPinchAnchorFromTarget();
    } else {
      mobileZoomScale = paginatedPersistedZoomScale;
      mobileZoomPanX = paginatedPersistedPanX;
      mobileZoomPanY = paginatedPersistedPanY;
      refreshPaginatedZoomTargets();
    }
  } else {
    mobileZoomContentAnchored = false;
    mobileZoomPinchAwaitingActivation = true;
    mobileZoomPinchInitialSpan = initialSpan;
    mobileZoomPanX = isMobileWebtoonZoom()
      ? webtoonGlobalPanX
      : paginatedPersistedZoomScale > rest + 0.01
        ? paginatedPersistedPanX
        : 0;
    mobileZoomPanY = isMobileWebtoonZoom()
      ? 0
      : paginatedPersistedZoomScale > rest + 0.01
        ? paginatedPersistedPanY
        : 0;
    mobileZoomScale = isMobileWebtoonZoom()
      ? webtoonPersistedZoomScale > 1.01
        ? webtoonPersistedZoomScale
        : 1
      : paginatedPersistedZoomScale > rest + 0.01
        ? paginatedPersistedZoomScale
        : usesMobileOriginalFit()
          ? mobileZoomScale
          : 1;
  }

  cacheMobileZoomMetrics();
  markMobileZoomContentActive(true);

  mobileZoomLastPinchDistance = initialSpan;
}

function updateMobilePinchGesture(x1: number, y1: number, x2: number, y2: number) {
  if (mobileZoomLastPinchDistance <= 0) return;

  const distance = Math.hypot(x2 - x1, y2 - y1);
  const viewport = getMobileZoomViewport();
  const content = getMobileZoomContent();
  if (!viewport || !content) return;

  const focalClientX = (x1 + x2) / 2;
  const focalClientY = (y1 + y2) / 2;
  const vpRect = viewport.getBoundingClientRect();
  const focalVpX = focalClientX - vpRect.left;

  if (mobileZoomPinchAwaitingActivation) {
    if (Math.abs(distance - mobileZoomPinchInitialSpan) < MOBILE_PINCH_ACTIVATION_PX) {
      mobileZoomLastPinchDistance = distance;
      return;
    }
    mobileZoomPinchAwaitingActivation = false;

    const baseScale = mobileZoomScale;
    if (isMobileWebtoonZoom()) {
      if (!content.dataset.zoomAnchored) {
        captureWebtoonPinchBaseline(viewport, content);
      } else {
        syncWebtoonPinchAnchorFromTarget();
      }
    } else if (!mobileZoomContentAnchored) {
      capturePinchBaseline(viewport, content);
    }
    cacheMobileZoomMetrics();

    const activationRatio = distance / mobileZoomPinchInitialSpan;
    const newScale = clampMobileZoomScale(baseScale * activationRatio);
    mobileZoomLastPinchDistance = distance;

    if (isMobileWebtoonZoom()) {
      finishWebtoonPinchUpdate(baseScale, newScale, focalClientX, focalClientY);
      return;
    }

    if (newScale <= getMobileMinZoomScale() + 0.01) {
      snapMobileZoomAtRest();
      return;
    }

    const focalVpY = focalClientY - vpRect.top;
    applyFocalPinchPan(baseScale, newScale, focalVpX, focalVpY);
    applyMobileZoomTransform();
    return;
  }

  const scaleFactor = distance / mobileZoomLastPinchDistance;
  const prevScale = mobileZoomScale;
  const newScale = clampMobileZoomScale(mobileZoomScale * scaleFactor);
  mobileZoomLastPinchDistance = distance;

  if (isMobileWebtoonZoom()) {
    finishWebtoonPinchUpdate(prevScale, newScale, focalClientX, focalClientY);
    return;
  }

  if (newScale <= getMobileMinZoomScale() + 0.01) {
    snapMobileZoomAtRest();
    return;
  }

  const focalVpY = focalClientY - vpRect.top;
  applyFocalPinchPan(prevScale, newScale, focalVpX, focalVpY);
  applyMobileZoomTransform();
}

function isMobileReaderCenter(clientX: number, clientY: number): boolean {
  const edge = window.innerWidth * 0.14;
  if (clientX < edge || clientX > window.innerWidth - edge) return false;
  const topZone = 72;
  return clientY >= topZone;
}

function usesMobileZoomReader(): boolean {
  return isMobile && currentView === "reader" && !!state.comic;
}

function usesMobilePaginatedReader(): boolean {
  return usesMobileZoomReader() && settings.readingMode !== "webtoon";
}

function clampMobileZoomScale(scale: number): number {
  return Math.min(MOBILE_MAX_ZOOM, Math.max(getMobileMinZoomScale(), scale));
}

function clampMobileZoomPan() {
  const anchorX = mobileZoomContentAnchored ? mobileZoomAnchorX : 0;
  const anchorY = mobileZoomContentAnchored ? mobileZoomAnchorY : 0;
  let viewWidth = mobileZoomCachedViewW;
  let viewHeight = mobileZoomCachedViewH;
  let contentWidth = mobileZoomCachedContentW * mobileZoomScale;
  let contentHeight = mobileZoomCachedContentH * mobileZoomScale;

  if (viewWidth <= 0 || viewHeight <= 0 || contentWidth <= 0 || contentHeight <= 0) {
    const viewport = getMobileZoomViewport();
    const content = getMobileZoomContent();
    if (!viewport || !content) return;
    viewWidth = viewport.clientWidth;
    viewHeight = viewport.clientHeight;
    const size = readMobileZoomContentSize(content);
    contentWidth = size.w * mobileZoomScale;
    contentHeight = size.h * mobileZoomScale;
  }

  const rest = mobileZoomRestScale();
  const atRestScale = mobileZoomScale <= rest + 0.01;
  const fitsInViewport =
    contentWidth <= viewWidth + 0.5 && contentHeight <= viewHeight + 0.5;

  if (atRestScale && fitsInViewport) {
    if (usesMobileOriginalFit() && mobileZoomScale < 0.999) {
      mobileZoomPanX = (viewWidth - contentWidth) / 2 - anchorX;
      mobileZoomPanY = (viewHeight - contentHeight) / 2 - anchorY;
    } else {
      mobileZoomPanX = 0;
      mobileZoomPanY = 0;
    }
    return;
  }

  if (contentWidth <= viewWidth) {
    mobileZoomPanX = (viewWidth - contentWidth) / 2 - anchorX;
  } else {
    mobileZoomPanX = Math.min(
      -anchorX,
      Math.max(viewWidth - contentWidth - anchorX, mobileZoomPanX),
    );
  }

  if (contentHeight <= viewHeight) {
    mobileZoomPanY = (viewHeight - contentHeight) / 2 - anchorY;
  } else {
    mobileZoomPanY = Math.min(
      -anchorY,
      Math.max(viewHeight - contentHeight - anchorY, mobileZoomPanY),
    );
  }
}

function syncMobileZoomTouchIds(event: TouchEvent) {
  mobileZoomTouchIds.clear();
  for (const touch of Array.from(event.touches)) {
    mobileZoomTouchIds.set(touch.identifier, { x: touch.clientX, y: touch.clientY });
  }
}

function cancelMobileChromeAutoHide() {
  if (mobileChromeAutoHideTimer) {
    clearTimeout(mobileChromeAutoHideTimer);
    mobileChromeAutoHideTimer = null;
  }
}

function scheduleMobileChromeAutoHide() {
  if (!isMobile || chromeHidden || currentView !== "reader" || !state.comic || drawerOpen) return;
  cancelMobileChromeAutoHide();
  mobileChromeAutoHideTimer = setTimeout(() => {
    mobileChromeAutoHideTimer = null;
    if (isMobile && currentView === "reader" && state.comic && !drawerOpen && !chromeHidden) {
      setChromeHidden(true);
    }
  }, MOBILE_CHROME_AUTO_HIDE_MS);
}

function noteMobileChromeActivity() {
  if (isMobile && currentView === "reader" && state.comic && !chromeHidden && !drawerOpen) {
    scheduleMobileChromeAutoHide();
  }
}

function toggleMobileReaderChrome() {
  if (chromeHidden) {
    setChromeHidden(false);
  } else {
    cancelMobileChromeAutoHide();
    setChromeHidden(true);
  }
}

function handleMobileTopEdgeDoubleTap(clientX: number, clientY: number, startX: number, startY: number) {
  if (!isMobile || currentView !== "reader" || !state.comic) return false;
  if (!isMobileTopEdge(clientY) || !isMobileTopEdge(startY)) return false;
  if (Math.hypot(clientX - startX, clientY - startY) > MOBILE_TAP_SLOP_PX) return false;
  return true;
}

function handleMobileHorizontalSwipe(dx: number) {
  if (settings.readingDirection === "rtl") {
    if (dx < 0) void goPrev();
    else void goNext();
  } else if (dx < 0) {
    void goNext();
  } else {
    void goPrev();
  }
}

function updateMobileTopTapStrip() {
  const show = isMobile && state.comic !== null && currentView === "reader";
  els.mobileTopTapStrip.hidden = !show;
  els.mobileTopTapStrip.setAttribute("aria-hidden", show ? "false" : "true");
}

function bindMobileEdgeZone(el: HTMLElement, zone: "left" | "right") {
  let touchActive = false;
  let startX = 0;
  let startY = 0;

  el.addEventListener(
    "touchstart",
    (event) => {
      if (!usesMobilePaginatedReader()) return;
      if (event.touches.length > 1) {
        touchActive = false;
        return;
      }
      const touch = event.touches[0];
      if (!touch) return;
      touchActive = true;
      startX = touch.clientX;
      startY = touch.clientY;
    },
    { passive: true },
  );

  el.addEventListener(
    "touchend",
    (event) => {
      if (!touchActive || event.touches.length > 0) return;
      touchActive = false;

      const touch = event.changedTouches[0];
      if (!touch) return;

      const dx = touch.clientX - startX;
      const dy = touch.clientY - startY;

      if (Math.abs(dx) > MOBILE_SWIPE_THRESHOLD_PX && Math.abs(dx) > Math.abs(dy)) {
        handleMobileHorizontalSwipe(dx);
        return;
      }

      if (Math.hypot(dx, dy) > MOBILE_TAP_SLOP_PX) return;

      if (zone === "left") handleLeftEdgeTap();
      else handleRightEdgeTap();
    },
    { passive: true },
  );

  el.addEventListener("touchcancel", () => {
    touchActive = false;
  });
}

function isMobileZoomTouchTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return !!target.closest("#page-container") && !target.closest(".page-tap-zone");
}

function bindMobileReaderGestures() {
  bindMobileEdgeZone(els.pageZonePrev, "left");
  bindMobileEdgeZone(els.pageZoneNext, "right");

  let mobileCenterTapStartX = 0;
  let mobileCenterTapStartY = 0;
  let mobileCenterLastTapTime = 0;

  const onZoomTouchStart = (event: TouchEvent) => {
    if (!usesMobileZoomReader()) return;
    if (!isMobileZoomTouchTarget(event.target)) return;

    stopMobileZoomMomentum();
    syncMobileZoomTouchIds(event);

    if (event.touches.length === 2) {
      const touch1 = event.touches[0];
      const touch2 = event.touches[1];
      if (!touch1 || !touch2) return;
      mobileZoomPinching = true;
      mobileZoomPanning = false;
      beginMobilePinchGesture(touch1, touch2);
      return;
    }

    if (event.touches.length === 1 && isMobilePaginatedPanEligible() && getMobileZoomContent()) {
      const touch = event.touches[0];
      if (!touch) return;
      mobileCenterTapStartX = touch.clientX;
      mobileCenterTapStartY = touch.clientY;
      mobileZoomPanCandidate = true;
      mobileZoomPanning = false;
      mobileZoomPinching = false;
      return;
    }

    if (event.touches.length === 1) {
      const touch = event.touches[0];
      if (!touch) return;
      mobileCenterTapStartX = touch.clientX;
      mobileCenterTapStartY = touch.clientY;
    }
  };

  const onZoomTouchMove = (event: TouchEvent) => {
    if (!usesMobileZoomReader()) return;

    if (mobileZoomPinching && event.touches.length >= 2) {
      event.preventDefault();
      const touch1 = event.touches[0];
      const touch2 = event.touches[1];
      if (!touch1 || !touch2) return;
      mobileZoomPinchT1 = { x: touch1.clientX, y: touch1.clientY };
      mobileZoomPinchT2 = { x: touch2.clientX, y: touch2.clientY };
      scheduleMobileZoomFrame();
      return;
    }

    if (event.touches.length === 1 && isMobilePaginatedPanEligible()) {
      const touch = event.touches[0];
      if (!touch) return;

      if (mobileZoomPanCandidate) {
        const dx = touch.clientX - mobileCenterTapStartX;
        const dy = touch.clientY - mobileCenterTapStartY;
        if (Math.hypot(dx, dy) > MOBILE_TAP_SLOP_PX) {
          mobileZoomPanCandidate = false;
          if (isMobileWebtoonZoom()) {
            if (Math.abs(dx) > Math.abs(dy) * 1.15) {
              mobileZoomPanning = true;
              markMobileZoomContentActive(true);
              mobileZoomPanLastX = touch.clientX;
              mobileZoomPanLastY = touch.clientY;
              mobileZoomPanLastTime = 0;
              mobileZoomVelocityX = 0;
              mobileZoomVelocityY = 0;
            }
          } else {
            mobileZoomPanning = true;
            markMobileZoomContentActive(true);
            mobileZoomPanLastX = touch.clientX;
            mobileZoomPanLastY = touch.clientY;
            mobileZoomPanLastTime = 0;
            mobileZoomVelocityX = 0;
            mobileZoomVelocityY = 0;
          }
        }
      }

      if (mobileZoomPanning) {
        event.preventDefault();
        trackMobilePanVelocity(touch.clientX, touch.clientY);
        mobileZoomPanDeltaX += touch.clientX - mobileZoomPanLastX;
        if (!isMobileWebtoonZoom()) {
          mobileZoomPanDeltaY += touch.clientY - mobileZoomPanLastY;
        }
        mobileZoomPanLastX = touch.clientX;
        mobileZoomPanLastY = touch.clientY;
        scheduleMobileZoomFrame();
      }
    }
  };

  const onZoomTouchEnd = (event: TouchEvent) => {
    if (!usesMobileZoomReader()) return;

    const wasPinching = mobileZoomPinching;
    syncMobileZoomTouchIds(event);

    if (mobileZoomTouchIds.size < 2) {
      mobileZoomPinching = false;
    }

    if (mobileZoomTouchIds.size === 0) {
      const touch = event.changedTouches[0];
      const dx = touch ? touch.clientX - mobileCenterTapStartX : 0;
      const dy = touch ? touch.clientY - mobileCenterTapStartY : 0;
      const isCenterTap =
        !!touch &&
        Math.hypot(dx, dy) <= MOBILE_TAP_SLOP_PX &&
        isMobileReaderCenter(touch.clientX, touch.clientY);

      const endedPanning = mobileZoomPanning;
      mobileZoomPanning = false;
      mobileZoomPanCandidate = false;

      if (mobileZoomScale <= mobileZoomRestScale() + 0.01 && (wasPinching || endedPanning)) {
        snapMobileZoomAtRest();
      } else if (isMobilePaginatedPanEligible()) {
        cacheMobileZoomMetrics();
        if (isMobileWebtoonZoom()) {
          clampWebtoonGlobalPanX();
        } else {
          clampMobileZoomPan();
        }
        applyMobileZoomTransform();
        if (endedPanning) {
          startMobilePanMomentum();
        }
      }

      if (wasPinching) {
        mobileZoomPinchAwaitingActivation = false;
      }

      if (isCenterTap && touch && isMobileZoomTouchTarget(touch.target)) {
        const now = Date.now();
        if (now - mobileCenterLastTapTime <= MOBILE_DOUBLE_TAP_MS) {
          mobileCenterLastTapTime = 0;
          if (isMobilePaginatedPanEligible()) {
            exitMobileZoom(touch.clientY);
          }
        } else {
          mobileCenterLastTapTime = now;
        }
      }

      if (endedPanning || wasPinching) return;
      return;
    }

    if (mobileZoomTouchIds.size === 1 && isMobilePaginatedPanEligible()) {
      const touch = event.touches[0];
      if (!touch) return;
      mobileZoomPanCandidate = true;
      mobileZoomPanning = false;
      mobileZoomPanLastX = touch.clientX;
      mobileZoomPanLastY = touch.clientY;
      mobileCenterTapStartX = touch.clientX;
      mobileCenterTapStartY = touch.clientY;
    }
  };

  els.pageContainer.addEventListener("touchstart", onZoomTouchStart, { passive: true });
  els.pageContainer.addEventListener("touchmove", onZoomTouchMove, { passive: false });
  els.pageContainer.addEventListener("touchend", onZoomTouchEnd, { passive: true });
  els.pageContainer.addEventListener("touchcancel", onZoomTouchEnd, { passive: true });

  window.addEventListener("orientationchange", () => {
    if (isMobilePaginatedPanEligible()) {
      exitMobileZoom();
      return;
    }
    cacheMobileZoomMetrics();
  });

  let topStripTouchStartY = 0;
  let topStripTouchStartX = 0;
  let mobileTopLastTapTime = 0;

  const onMobileTopEdgeTouchStart = (event: TouchEvent) => {
    if (!isMobile || currentView !== "reader" || !state.comic || drawerOpen) return;
    if (!els.openComicSheet.hidden) return;
    const touch = event.touches[0];
    if (!touch || !isMobileTopEdge(touch.clientY)) return;
    topStripTouchStartY = touch.clientY;
    topStripTouchStartX = touch.clientX;
  };

  const onMobileTopEdgeTouchEnd = (event: TouchEvent) => {
    if (!isMobile || currentView !== "reader" || !state.comic || drawerOpen) return;
    if (!els.openComicSheet.hidden) return;
    if (event.touches.length > 0) return;
    const touch = event.changedTouches[0];
    if (!touch) return;
    if (
      !handleMobileTopEdgeDoubleTap(
        touch.clientX,
        touch.clientY,
        topStripTouchStartX,
        topStripTouchStartY,
      )
    ) {
      return;
    }

    const now = Date.now();
    if (now - mobileTopLastTapTime <= MOBILE_DOUBLE_TAP_MS) {
      mobileTopLastTapTime = 0;
      toggleMobileReaderChrome();
    } else {
      mobileTopLastTapTime = now;
    }
  };

  document.addEventListener("touchstart", onMobileTopEdgeTouchStart, { passive: true, capture: true });
  document.addEventListener("touchend", onMobileTopEdgeTouchEnd, { passive: true, capture: true });

  els.chrome.addEventListener(
    "touchstart",
    () => {
      noteMobileChromeActivity();
    },
    { passive: true },
  );

  els.pageSlider.addEventListener("input", () => {
    noteMobileChromeActivity();
  });
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
  if (hidden) {
    document.body.classList.remove("chrome-reveal");
    cancelMobileChromeAutoHide();
  } else if (isMobile && currentView === "reader" && state.comic) {
    scheduleMobileChromeAutoHide();
  }
  updateMobileTopTapStrip();
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
  cancelMobileChromeAutoHide();
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

function updateLibraryToggleUi() {
  if (isMobile) {
    els.openLibraryBtn.classList.remove("active");
    els.openLibraryBtn.title = "Open comic";
    els.openLibraryBtn.setAttribute("aria-label", "Open comic");
    return;
  }

  const inLibrary = currentView === "library";
  els.openLibraryBtn.classList.toggle("active", inLibrary);
  els.openLibraryBtn.title = inLibrary ? "Back to reader (Esc)" : "Library";
  els.openLibraryBtn.setAttribute("aria-label", inLibrary ? "Back to reader" : "Open library");
}

function openComicPickerSheet() {
  closeDrawer();
  els.openComicSheet.hidden = false;
}

function closeComicPickerSheet() {
  els.openComicSheet.hidden = true;
}

async function openLocalCbzPicker() {
  closeComicPickerSheet();
  try {
    if (usesAndroidStorage()) {
      const path = await pickAndroidCbzFile();
      if (path) await openComic(path);
      return;
    }

    const selected = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "Comic", extensions: ["cbz"] }],
    });
    if (typeof selected === "string") await openComic(selected);
  } catch (error) {
    showAppMessage(`Could not open file picker: ${String(error)}`);
  }
}

function openNetworkCbzBrowser() {
  closeComicPickerSheet();
  closeDrawer();
  librarySource = "network";
  settings.librarySource = "network";
  void saveSettings(settings);
  setLibrarySource("network");
  showLibrarySetup = !networkConnected;
  updateLibrarySetupUi();
  setView("library");
  void refreshLibrary();
}

function handleOpenComicToolbarClick() {
  if (isMobile) {
    openComicPickerSheet();
    return;
  }
  toggleLibraryView();
}

function returnToReader() {
  closeDrawer();
  setView("reader");
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
  updateLibraryToggleUi();
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

  syncPaginatedPersistedZoomFromActive();

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

    if (isMobile) {
      const images = els.pageContainer.innerHTML;
      els.pageContainer.innerHTML = `<div class="page-zoom-viewport"><div class="page-zoom-content">${images}</div></div>`;
      requestAnimationFrame(() => {
        setupPaginatedZoomAfterRender();
      });
    }

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

  const containerRect = els.pageContainer.getBoundingClientRect();
  const midpoint = containerRect.top + containerRect.height * 0.35;

  let bestIndex = state.currentPage;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const slot of slots) {
    const index = Number(slot.dataset.pageIndex);
    const slotRect = slot.getBoundingClientRect();
    const slotMid = slotRect.top + slotRect.height / 2;
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
      if (isMobile && settings.readingMode === "webtoon") {
        ensureWebtoonSlotZoomDom(slot);
        prepareWebtoonSlotForZoom(slot);
      }
      if (isMobile && webtoonPersistedZoomScale > 1.01) {
        requestAnimationFrame(() => {
          if (slot.isConnected) {
            applyTransformToWebtoonSlot(slot, webtoonPersistedZoomScale, webtoonGlobalPanX);
          }
        });
      }
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

  const slots: HTMLElement[] = [];
  for (let i = 0; i < state.comic.pageCount; i += 1) {
    const slot = document.createElement("div");
    slot.className = "webtoon-page-slot webtoon-slot-pending";
    slot.dataset.pageIndex = String(i);
    slots.push(slot);
  }

  const fragment = document.createDocumentFragment();
  slots.forEach((slot) => fragment.appendChild(slot));
  els.pageContainer.appendChild(fragment);
  resetMobileZoom();

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
  const previousPath = state.comic?.path ?? null;
  resetWebtoonState();
  if (isSmbPath(path)) {
    document.body.classList.add("network-loading");
    await saveNetworkLibraryFolder(smbParentDirectory(path));
  }
  try {
    const meta = await openCbz(path);
    if (previousPath !== path) {
      clearPaginatedPersistedZoom();
    }
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
  if (!usesMobileLibrarySetup()) {
    librarySource = "local";
    showLibrarySetup = false;
  } else if (!hasConfiguredLibrary()) {
    void pickLibraryFolder();
    return;
  }
  if (hasConfiguredLibrary()) {
    showLibrarySetup = false;
    if (!usesMobileLibrarySetup()) {
      librarySource = "local";
    } else {
      librarySource = inferLibrarySource();
    }
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

function toggleLibraryView() {
  if (currentView === "library") {
    returnToReader();
    return;
  }
  openLibrary();
}

function setLibrarySource(source: LibrarySource) {
  if (!usesMobileLibrarySetup() && source === "network") return;

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

  if (librarySource === "network" && usesMobileLibrarySetup()) {
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

  els.openLibraryBtn.addEventListener("click", () => {
    handleOpenComicToolbarClick();
  });

  els.openComicBackdrop.addEventListener("click", closeComicPickerSheet);
  els.openComicCancelBtn.addEventListener("click", closeComicPickerSheet);
  els.openComicLocalBtn.addEventListener("click", () => void openLocalCbzPicker());
  els.openComicNetworkBtn.addEventListener("click", openNetworkCbzBrowser);

  els.prevPageBtn.addEventListener("click", () => void goPrev());
  els.nextPageBtn.addEventListener("click", () => void goNext());

  bindMobileReaderGestures();

  els.chromeToggle.addEventListener("click", toggleChrome);
  els.fullscreenBtn.addEventListener("click", () => void toggleWindowFullscreen());

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

  window.addEventListener("keydown", async (event) => {
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

    if (event.key === "F11") {
      if (isDesktopApp()) {
        event.preventDefault();
        void toggleWindowFullscreen();
      }
      return;
    }

    if (event.key === "Escape") {
      if (!els.pageJumpInput.hidden) {
        cancelPageJump();
        return;
      }
      if (currentView === "library" || currentView === "settings") {
        event.preventDefault();
        returnToReader();
        return;
      }
      if (isDesktopApp() && (await exitWindowFullscreen())) return;
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
  void syncWindowFullscreenState();
  const desktopWin = getDesktopWindow();
  if (desktopWin) {
    void desktopWin.onResized(() => {
      void syncWindowFullscreenState();
    });
  }

  settings = await getSettings();
  if (!["single", "double", "webtoon"].includes(settings.readingMode)) {
    settings.readingMode = "single";
  }
  normalizeDesktopLibrarySettings();
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

  if (usesMobileLibrarySetup() && librarySource === "network" && settings.networkHost) {
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
