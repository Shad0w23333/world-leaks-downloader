desktop.runtime.onInstalled.addListener(initialize);
desktop.runtime.onStartup.addListener(initialize);

desktop.runtime.onMessage.addListener((message) => {
  if (!message || !message.type) {
    return undefined;
  }

  if (message.type === "queue:get-state") {
    return ensureLoaded().then(() => getPublicState());
  }

  if (message.type === "queue:get-tree-children") {
    return ensureLoaded().then(() => ({
      children: getDirectoryChildrenForView(message.path || "")
    }));
  }

  if (message.type === "queue:add") {
    return addQueueItems(message.items || [], message.options || {}, { deferRender: Boolean(message.deferRender) });
  }

  if (message.type === "queue:replace-path-list") {
    return replaceQueueWithPathList(message.options || {});
  }

  if (message.type === "queue:set-catalog-directory-sizes") {
    return setCatalogDirectorySizes(message.directories || []);
  }

  if (message.type === "queue:start") {
    return startQueue(message.options || {});
  }

  if (message.type === "queue:update-options") {
    return updateQueueOptions(message.options || {});
  }

  if (message.type === "queue:pause") {
    return pauseQueue();
  }

  if (message.type === "queue:cancel-downloads") {
    return cancelDownloads();
  }

  if (message.type === "queue:retry-failed") {
    return retryFailed(message.options || {});
  }

  if (message.type === "queue:set-selection") {
    return setSelection(message.target || {}, Boolean(message.selected));
  }

  if (message.type === "queue:set-exclusion") {
    return setExclusion(message.target || {}, Boolean(message.excluded));
  }

  return undefined;
});

desktop.downloads.onChanged.addListener((delta) => {
  if (delta && (delta.bytesReceived || delta.totalBytes || delta.error || delta.state)) {
    reconcileDownload(delta.id);
  }
});

const SHARD_SIZE = 1000;
const ROOT_DIRECTORY_LABEL = "(根目录)";
const MAX_FILENAME_SEGMENT_LENGTH = 120;
const MAX_DOWNLOAD_FILENAME_LENGTH = 240;
const DOWNLOAD_START_TIMEOUT_MS = 60000;
const DOWNLOAD_STALL_TIMEOUT_MS = 120000;
const PROGRESS_REFRESH_INTERVAL_MS = 500;
const SPEED_SMOOTHING_TIME_MS = 3000;
const METADATA_LOOKUP_RETRY_MS = 30000;
const DEFAULT_BASE_URL = "https://worldleaksartrjm3c6vasllvgacbi5u3mgzkluehrzhk2jz4taufuid.onion/";
const DEFAULT_OPTIONS = {
  baseFolder: "Downloads",
  overwrite: true,
  skipExisting: true,
  delayMs: 750,
  maxConcurrent: 3,
  baseUrl: DEFAULT_BASE_URL
};

let state = {
  items: [],
  running: false,
  cursor: 0,
  options: { ...DEFAULT_OPTIONS },
  counts: { total: 0, queued: 0, downloading: 0, done: 0, error: 0 },
  directories: [],
  notice: ""
};

let initialized = false;
let loadingPromise = null;
let saveTimer = null;
let nextTimer = null;
let pollTimer = null;
let broadcastTimer = null;
let nodeUpdateTimer = null;
let downloadTraversalStack = null;
let directoryTreeDirty = false;
let directoryChildrenIndexDirty = true;
let downloadSpeedBps = 0;
let speedWindowBytes = 0;
let speedWindowStartedAt = 0;
let speedSampleInitialized = false;
const knownUrls = new Set();
const knownPaths = new Set();
const knownSourceKeys = new Set();
const knownUrlItems = new Map();
const knownPathItems = new Map();
const knownSourceKeyItems = new Map();
let directoryChildrenIndex = new Map();
let directoryNodeIndex = new Map();
let fileNodeIndex = new Map();
const metadataDirectorySizes = new Map();
const metadataLookupAttempts = new Map();
const metadataSizeRequests = new Map();
const catalogDirectorySizes = new Map();
let metadataViewGeneration = 0;
const pathSelectionOverrides = new Map();
const pathExclusionOverrides = new Map();
const pendingNodeUpdates = new Map();
const activeDownloadIds = new Set();
const downloadIdToItemId = new Map();
const userCancelledDownloadIds = new Set();

initialize();

function initialize() {
  if (initialized) {
    return;
  }

  initialized = true;
  loadingPromise = loadState();
}

async function ensureLoaded() {
  if (loadingPromise) {
    await loadingPromise;
  }
}

async function loadState() {
  const [saved, persistedSelections] = await Promise.all([
    desktop.persistence.load().catch(() => ({ queueOptions: null })),
    desktop.files.loadPathSelections().catch(() => ({ entries: {} }))
  ]);

  state.options = normalizeOptions({ ...DEFAULT_OPTIONS, ...(saved.queueOptions || {}) });
  state.items = [];
  resetViewMetadata();
  state.cursor = 0;
  knownUrls.clear();
  knownPaths.clear();
  knownSourceKeys.clear();
  knownUrlItems.clear();
  knownPathItems.clear();
  knownSourceKeyItems.clear();
  activeDownloadIds.clear();
  downloadIdToItemId.clear();
  userCancelledDownloadIds.clear();
  loadPathSelectionOverrides(persistedSelections);

  rebuildDerivedState();
  broadcastState();
}

function getPublicState() {
  if (directoryTreeDirty || (!state.directories.length && state.counts.total > 0)) {
    updateDirectoryTree();
  }
  return {
    running: state.running,
    options: state.options,
    counts: state.counts,
    downloadSpeedBps: currentDownloadSpeedBps(),
    directories: state.directories,
    notice: state.notice || ""
  };
}

async function addQueueItems(items, options, renderOptions = {}) {
  await ensureLoaded();
  const previousBaseUrl = state.options.baseUrl;
  state.options = normalizeOptions({ ...state.options, ...options });
  if (state.options.baseUrl !== previousBaseUrl) {
    resetViewMetadata();
  }
  let added = 0;
  const changedShards = new Set();
  const localFilesToCheck = [];
  const deferRender = Boolean(renderOptions.deferRender);

  for (const item of items) {
    const normalized = normalizeQueueItem(item, state.options.baseFolder);
    if (!normalized) {
      continue;
    }
    applyPersistedPathSelection(normalized);

    const existing = findKnownQueueItem(normalized);
    if (existing) {
      if (mergeExistingQueueItem(existing, normalized)) {
        changedShards.add(shardIndexFor(existing.storeIndex));
        markDirectoryTreeDirty();
      }
      continue;
    }

    normalized.id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    normalized.storeIndex = state.items.length;
    normalized.addedAt = Date.now() + added;
    state.items.push(normalized);
    indexKnownItem(normalized);
    incrementCountsForItem(normalized);
    markDirectoryTreeDirty();

    changedShards.add(shardIndexFor(normalized.storeIndex));
    localFilesToCheck.push(normalized);
    added += 1;
  }

  if (localFilesToCheck.length) {
    await hydrateLocalFileStatuses(localFilesToCheck, changedShards);
  }

  if (changedShards.size) {
    await saveChangedShards(changedShards);
  }

  if (!added && state.items.length && !deferRender) {
    markDirectoryTreeDirty();
  }

  if (!deferRender && directoryTreeDirty) {
    updateDirectoryTree();
    broadcastState();
  }
  if (added) {
    resetDownloadTraversal();
  }

  saveOptions();
  return { added, state: deferRender ? null : getPublicState(), counts: state.counts };
}

async function hydrateLocalFileStatuses(items, changedShards) {
  const filenames = items.map((item) => item.filename);
  const statuses = desktop.downloads && typeof desktop.downloads.existsLocalFiles === "function"
    ? await desktop.downloads.existsLocalFiles(filenames).catch(() => [])
    : [];

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const status = statuses[index];
    if (!status || status.exists !== true || status.isFile !== true || item.status === "done") {
      continue;
    }

    const fileSize = Number(status.fileSize) || 0;
    item.bytesReceived = fileSize;
    item.completedLocalSize = fileSize;
    item.sessionBytesReceived = 0;
    if (!(Number.isFinite(item.metadataSize) && item.metadataSize >= 0)) {
      item.totalBytes = fileSize;
    }
    item.finishedAt = Date.now();
    item.error = "";
    item.note = "Found existing local file during import.";
    setItemStatus(item, "done");
    changedShards.add(shardIndexFor(item.storeIndex));
  }
}

function isKnownQueueItem(item) {
  return Boolean(findKnownQueueItem(item));
}

function incrementCountsForItem(item) {
  state.counts.total += 1;
  const status = item.status || "queued";
  state.counts[status] = (state.counts[status] || 0) + 1;
}

function findKnownQueueItem(item) {
  const pathKey = itemPathKey(item);
  const sourceKey = itemSourceKey(item);
  return (
    (sourceKey && knownSourceKeyItems.get(sourceKey)) ||
    (pathKey && knownPathItems.get(pathKey)) ||
    (item.url && knownUrlItems.get(item.url)) ||
    null
  );
}

function mergeExistingQueueItem(existing, normalized) {
  const beforeUrl = existing.url;
  const beforePath = itemPathKey(existing);
  const beforeSourceKey = itemSourceKey(existing);

  let changed = false;
  for (const key of ["url", "path", "filename", "label", "sourceType", "sourceKey"]) {
    if (normalized[key] && existing[key] !== normalized[key]) {
      existing[key] = normalized[key];
      changed = true;
    }
  }

  if (!changed) {
    return false;
  }

  existing.normalizedPath = normalizeStoragePath(existing.path || normalized.normalizedPath || "");
  unindexKnownItem(existing, {
    url: beforeUrl,
    pathKey: beforePath,
    sourceKey: beforeSourceKey
  });
  indexKnownItem(existing);

  return true;
}

function indexKnownItem(item) {
  if (item.url) {
    knownUrls.add(item.url);
    knownUrlItems.set(item.url, item);
  }

  const pathKey = itemPathKey(item);
  if (pathKey) {
    knownPaths.add(pathKey);
    knownPathItems.set(pathKey, item);
  }

  const sourceKey = itemSourceKey(item);
  if (sourceKey) {
    knownSourceKeys.add(sourceKey);
    knownSourceKeyItems.set(sourceKey, item);
  }
}

function unindexKnownItem(item, previous = {}) {
  const url = previous.url !== undefined ? previous.url : item.url;
  if (url && knownUrlItems.get(url) === item) {
    knownUrlItems.delete(url);
    knownUrls.delete(url);
  }

  const pathKey = previous.pathKey !== undefined ? previous.pathKey : itemPathKey(item);
  if (pathKey && knownPathItems.get(pathKey) === item) {
    knownPathItems.delete(pathKey);
    knownPaths.delete(pathKey);
  }

  const sourceKey = previous.sourceKey !== undefined ? previous.sourceKey : itemSourceKey(item);
  if (sourceKey && knownSourceKeyItems.get(sourceKey) === item) {
    knownSourceKeyItems.delete(sourceKey);
    knownSourceKeys.delete(sourceKey);
  }
}

function itemPathKey(item) {
  return queueItemPath(item);
}

function itemSourceKey(item) {
  return String(item && item.sourceKey ? item.sourceKey : "").normalize("NFC");
}

function isEffectivelySelectedItem(item) {
  const node = fileNodeForItem(item);
  if (node) {
    return effectiveNodeCheckState(node) === "all" && !effectiveNodeExcluded(node);
  }
  return true;
}

async function setSelection(target, selected) {
  await ensureLoaded();
  ensureDirectoryChildrenIndex();
  const kind = target.kind === "file" ? "file" : "directory";
  const path = sanitizePath(target.path || "");
  const nextState = selected ? "all" : "none";
  let node = null;

  if (kind === "file") {
    node = fileNodeByTarget(target, path);
  } else {
    node = directoryNodeIndex.get(path);
  }

  if (!node) {
    return getSelectionOnlyState();
  }

  materializeAncestorManualStates(node);
  node.manualCheckState = nextState;
  if (node.kind === "file" && node.item) {
    node.item.manualSelected = selected;
  }
  recomputeCalculatedStatesFrom(node);
  await savePathSelectionOverride(node.kind, node.path || path, selected);
  state.cursor = 0;
  resetDownloadTraversal();

  if (!selected) {
    await cancelActiveDownloadsForNode(node);
  }

  return getSelectionOnlyState(node);
}

async function setExclusion(target, excluded) {
  await ensureLoaded();
  ensureDirectoryChildrenIndex();
  const kind = target.kind === "file" ? "file" : "directory";
  const path = sanitizePath(target.path || "");
  let node = null;

  if (kind === "file") {
    node = fileNodeByTarget(target, path);
  } else {
    node = directoryNodeIndex.get(path);
  }

  if (!node) {
    return getExclusionOnlyState();
  }

  await savePathExclusionOverride(node.kind, node.path || path, excluded);
  state.cursor = 0;
  resetDownloadTraversal();
  queueNodeUpdate(node);

  if (excluded) {
    await cancelActiveDownloadsForNode(node, {
      note: "Download cancelled because it was excluded."
    });
  }

  flushNodeUpdatesThrottled();
  broadcastStateThrottled();
  return getExclusionOnlyState(node);
}

function loadPathSelectionOverrides(saved) {
  pathSelectionOverrides.clear();
  pathExclusionOverrides.clear();
  const entries = saved && typeof saved === "object" && saved.entries && typeof saved.entries === "object"
    ? saved.entries
    : {};
  for (const [key, value] of Object.entries(entries)) {
    if (/^(?:dir|file):/.test(key) && typeof value === "boolean") {
      pathSelectionOverrides.set(key, value);
    }
  }
  const exclusions = saved && typeof saved === "object" && saved.exclusions && typeof saved.exclusions === "object"
    ? saved.exclusions
    : {};
  for (const [key, value] of Object.entries(exclusions)) {
    if (/^(?:dir|file):/.test(key) && typeof value === "boolean") {
      pathExclusionOverrides.set(key, value);
    }
  }
}

function applyPersistedPathSelection(item) {
  const path = persistentSelectionPath(queueItemPath(item));
  if (!path) {
    return;
  }
  const fileSelection = pathSelectionOverrides.get(`file:${path}`);
  if (typeof fileSelection === "boolean") {
    item.manualSelected = fileSelection;
    return;
  }

  const parts = path.split("/").filter(Boolean);
  for (let length = parts.length - 1; length > 0; length -= 1) {
    const directorySelection = pathSelectionOverrides.get(`dir:${parts.slice(0, length).join("/")}`);
    if (typeof directorySelection === "boolean") {
      item.manualSelected = directorySelection;
      return;
    }
  }
}

async function savePathSelectionOverride(kind, path, selected) {
  const normalizedPath = persistentSelectionPath(path);
  if (!normalizedPath) {
    return;
  }
  const keyKind = kind === "file" ? "file" : "dir";
  if (keyKind === "dir") {
    const descendantPrefix = `${normalizedPath}/`;
    for (const key of Array.from(pathSelectionOverrides.keys())) {
      const storedPath = key.slice(key.indexOf(":") + 1);
      if (storedPath === normalizedPath || storedPath.startsWith(descendantPrefix)) {
        pathSelectionOverrides.delete(key);
      }
    }
  }
  pathSelectionOverrides.set(`${keyKind}:${normalizedPath}`, Boolean(selected));
  await desktop.files.updatePathSelection({
    kind: keyKind,
    path: normalizedPath,
    selected: Boolean(selected)
  });
}

async function savePathExclusionOverride(kind, path, excluded) {
  const normalizedPath = persistentSelectionPath(path);
  if (!normalizedPath) {
    return;
  }
  const keyKind = kind === "file" ? "file" : "dir";
  if (keyKind === "dir") {
    const descendantPrefix = `${normalizedPath}/`;
    for (const key of Array.from(pathExclusionOverrides.keys())) {
      const storedPath = key.slice(key.indexOf(":") + 1);
      if (storedPath === normalizedPath || storedPath.startsWith(descendantPrefix)) {
        pathExclusionOverrides.delete(key);
      }
    }
  }
  pathExclusionOverrides.set(`${keyKind}:${normalizedPath}`, Boolean(excluded));
  await desktop.files.updatePathExclusion({
    kind: keyKind,
    path: normalizedPath,
    excluded: Boolean(excluded)
  });
}

function persistentSelectionPath(path) {
  return sanitizePath(path || "").normalize("NFC");
}

function parentPathForItem(item) {
  const parts = queueItemParts(item);
  return parts.length > 1 ? parts.slice(0, -1).join("/") : "";
}

function getSelectionOnlyState(changedNode = null) {
  return {
    running: state.running,
    options: state.options,
    counts: { ...state.counts },
    downloadSpeedBps: currentDownloadSpeedBps(),
    directories: [],
    selectionOnly: true,
    selectionUpdates: selectionUpdatesForNode(changedNode)
  };
}

function getExclusionOnlyState(changedNode = null) {
  return {
    running: state.running,
    options: state.options,
    counts: { ...state.counts },
    downloadSpeedBps: currentDownloadSpeedBps(),
    directories: [],
    exclusionOnly: true,
    exclusionUpdates: exclusionUpdatesForNode(changedNode)
  };
}

function exclusionUpdatesForNode(node) {
  if (!node) {
    return [];
  }
  return [serializeDirectoryChild(node)];
}

function selectionUpdatesForNode(node) {
  if (!node) {
    return [];
  }
  const updates = [selectionUpdateForNode(node)];
  for (const ancestor of ancestorDirectoryNodes(node).reverse()) {
    updates.push(selectionUpdateForNode(ancestor));
  }
  return updates;
}

function selectionUpdateForNode(node) {
  return {
    id: node.id,
    kind: node.kind,
    path: node.path || "",
    selection: effectiveNodeCheckState(node),
    excluded: effectiveNodeExcluded(node),
    directExcluded: directNodeExcluded(node)
  };
}

async function startQueue(options) {
  await ensureLoaded();
  const previousBaseUrl = state.options.baseUrl;
  state.options = normalizeOptions({ ...state.options, ...options });
  if (state.options.baseUrl !== previousBaseUrl) {
    resetViewMetadata();
    markDirectoryTreeDirty();
  }
  state.notice = "";
  resetOrphanedDownloadingItems("Reset stale downloading task before starting queue.");
  resetDownloadTraversal();
  state.running = true;
  saveOptions();
  startPolling();
  await runNext();
  broadcastState();
  return getPublicState();
}

async function updateQueueOptions(options) {
  await ensureLoaded();
  const previousBaseUrl = state.options.baseUrl;
  const previousBaseFolder = state.options.baseFolder;
  state.options = normalizeOptions({ ...state.options, ...options });
  if (state.options.baseUrl !== previousBaseUrl) {
    resetViewMetadata();
    markDirectoryTreeDirty();
  }
  if (state.options.baseFolder !== previousBaseFolder) {
    await recalculateLocalFileStatuses();
  }
  saveOptions();
  resetDownloadTraversal();

  if (state.running) {
    clearTimeout(nextTimer);
    nextTimer = null;
    await runNext();
  } else {
    broadcastState();
  }

  return getPublicState();
}

async function pauseQueue() {
  await ensureLoaded();
  state.running = false;
  clearTimeout(nextTimer);
  nextTimer = null;
  stopPolling();
  broadcastState();
  return getPublicState();
}

async function cancelDownloads() {
  await ensureLoaded();
  state.running = false;
  clearTimeout(nextTimer);
  nextTimer = null;
  stopPolling();

  const downloadIds = Array.from(activeDownloadIds);
  for (const downloadId of downloadIds) {
    userCancelledDownloadIds.add(downloadId);
  }
  await Promise.all(downloadIds.map((downloadId) => desktop.downloads.cancel(downloadId).catch(() => {})));

  const changedShards = new Set();
  for (const item of state.items) {
    const isActive =
      item.status === "downloading" ||
      (item.downloadId !== null && item.downloadId !== undefined && activeDownloadIds.has(item.downloadId));
    if (!isActive) {
      continue;
    }

    setItemStatus(item, "queued");
    item.downloadId = null;
    item.error = "";
    item.note = "Download cancelled.";
    item.bytesReceived = 0;
    item.sessionBytesReceived = 0;
    syncIndexedItemProgress(item);
    item.totalBytes = -1;
    item.startedAt = 0;
    item.finishedAt = 0;
    item.lastProgressAt = 0;
    changedShards.add(shardIndexFor(item.storeIndex));
  }

  activeDownloadIds.clear();
  downloadIdToItemId.clear();
  userCancelledDownloadIds.clear();
  resetDownloadTraversal();
  markDirectoryViewDirty();
  await saveChangedShards(changedShards);
  updateDirectoryTree();
  broadcastState();
  return getPublicState();
}

async function cancelActiveDownloadsForNode(node, options = {}) {
  const items = activeDownloadItemsForNode(node);
  if (!items.length) {
    return;
  }

  const changedShards = new Set();
  await Promise.all(items.map((item) => cancelActiveDownloadItem(
    item,
    changedShards,
    options.note || "Download cancelled because it was unchecked."
  )));
  resetDownloadTraversal();
  await saveChangedShards(changedShards);
  if (!options.suppressBroadcast) {
    markDirectoryViewDirty();
    updateDirectoryTree();
  }
  if (!options.suppressBroadcast) {
    broadcastState();
  }

  if (state.running) {
    clearTimeout(nextTimer);
    nextTimer = null;
    if (options.suppressBroadcast) {
      state.running = state.running && Boolean(state.counts.downloading);
    } else {
      await runNext();
    }
  }
}

function activeDownloadItemsForNode(node) {
  if (!node) {
    return [];
  }

  if (node.kind === "file") {
    const item = node.item || null;
    return item && isActiveDownloadItem(item) ? [item] : [];
  }

  const directoryPath = sanitizePath(node.path || "");
  const items = [];
  for (const downloadId of activeDownloadIds) {
    const itemId = downloadIdToItemId.get(downloadId);
    const file = itemId ? fileNodeIndex.get(itemId) : null;
    const item = file && file.item;
    if (item && isActiveDownloadItem(item) && itemIsUnderDirectory(item, directoryPath)) {
      items.push(item);
    }
  }
  return items;
}

function isActiveDownloadItem(item) {
  return Boolean(
    item &&
      (item.status === "downloading" ||
        (item.downloadId !== null && item.downloadId !== undefined && activeDownloadIds.has(item.downloadId)))
  );
}

function itemIsUnderDirectory(item, directoryPath) {
  if (!directoryPath) {
    return true;
  }
  const itemPath = queueItemPath(item);
  return itemPath === directoryPath || itemPath.startsWith(`${directoryPath}/`);
}

async function cancelActiveDownloadItem(item, changedShards, note) {
  const downloadId = item.downloadId;
  if (downloadId !== null && downloadId !== undefined) {
    userCancelledDownloadIds.add(downloadId);
    activeDownloadIds.delete(downloadId);
    downloadIdToItemId.delete(downloadId);
    await desktop.downloads.cancel(downloadId).catch(() => {});
  }

  if (item.status === "downloading") {
    setItemStatus(item, "queued");
  }
  item.downloadId = null;
  item.error = "";
  item.note = note || "Download cancelled.";
  item.bytesReceived = 0;
  syncIndexedItemProgress(item);
  item.totalBytes = -1;
  item.startedAt = 0;
  item.finishedAt = 0;
  item.lastProgressAt = 0;
  changedShards.add(shardIndexFor(item.storeIndex));
}

async function replaceQueueWithPathList(options = {}) {
  await ensureLoaded();
  resetOrphanedDownloadingItems("Reset stale downloading task before importing new path list.");
  if (activeDownloadIds.size || state.items.some((item) => item.status === "downloading")) {
    throw new Error("当前还有下载中的任务，请先暂停并等待下载结束后再导入新的 Path 列表。");
  }

  state.running = false;
  clearTimeout(nextTimer);
  nextTimer = null;
  stopPolling();

  state.options = normalizeOptions({ ...state.options, ...options });
  resetViewMetadata();
  state.items = [];
  state.cursor = 0;
  resetDownloadTraversal();
  knownUrls.clear();
  knownPaths.clear();
  knownSourceKeys.clear();
  knownUrlItems.clear();
  knownPathItems.clear();
  knownSourceKeyItems.clear();
  downloadIdToItemId.clear();
  activeDownloadIds.clear();
  userCancelledDownloadIds.clear();
  markDirectoryTreeDirty();
  rebuildDerivedState();
  saveOptions();
  broadcastState();
  return getPublicState();
}

async function setCatalogDirectorySizes(directories) {
  await ensureLoaded();
  catalogDirectorySizes.clear();
  for (const directory of directories) {
    const path = sanitizePath(directory && (directory.path || directory.name));
    const size = Number(directory && directory.size);
    if (!path || !Number.isFinite(size) || size < 0) {
      continue;
    }
    catalogDirectorySizes.set(path, size);
    metadataDirectorySizes.set(path, size);
  }
  markDirectoryViewDirty();
  broadcastState();
  return getPublicState();
}

async function retryFailed(options = {}) {
  await ensureLoaded();
  const previousBaseUrl = state.options.baseUrl;
  state.options = normalizeOptions({ ...state.options, ...options });
  if (state.options.baseUrl !== previousBaseUrl) {
    resetViewMetadata();
    markDirectoryTreeDirty();
  }
  state.notice = "";
  resetOrphanedDownloadingItems("Reset stale downloading task before retrying failed downloads.");
  await refreshPathListItemsForOptions(new Set(["queued", "error"]));
  const changedShards = new Set();
  for (const item of state.items) {
    if (item.status === "error") {
      setItemStatus(item, "queued");
      item.error = "";
      item.note = "";
      item.downloadId = null;
      item.bytesReceived = item.bytesReceived || 0;
      item.totalBytes = item.totalBytes || -1;
      item.startedAt = 0;
      item.finishedAt = 0;
      item.lastProgressAt = 0;
      item.compactRetry = false;
      changedShards.add(shardIndexFor(item.storeIndex));
    }
  }

  state.cursor = Math.min(state.cursor, firstQueuedIndex());
  resetDownloadTraversal();
  if (changedShards.size) {
    markDirectoryViewDirty();
  }
  saveOptions();
  await saveChangedShards(changedShards);
  broadcastState();
  return getPublicState();
}

function resetOrphanedDownloadingItems(note) {
  const changed = [];
  for (const item of state.items) {
    if (item.status !== "downloading") {
      continue;
    }
    const hasActiveDownload = item.downloadId !== null && item.downloadId !== undefined && activeDownloadIds.has(item.downloadId);
    if (hasActiveDownload) {
      continue;
    }

    setItemStatus(item, "queued");
    item.downloadId = null;
    item.bytesReceived = 0;
    item.sessionBytesReceived = 0;
    syncIndexedItemProgress(item);
    item.totalBytes = -1;
    item.startedAt = 0;
    item.lastProgressAt = 0;
    item.error = "";
    item.note = note || "Reset stale downloading task.";
    changed.push(item);
  }

  if (!changed.length) {
    return 0;
  }

  state.cursor = Math.min(state.cursor, firstQueuedIndex());
  resetDownloadTraversal();
  markDirectoryViewDirty();
  return changed.length;
}

async function runNext() {
  if (!state.running) {
    return;
  }

  const activeSlotCount = state.counts.downloading || 0;
  const availableSlots = Math.max(0, state.options.maxConcurrent - activeSlotCount);
  if (!availableSlots) {
    queueNextTick();
    return;
  }

  const picked = [];
  const changedShards = new Set();
  while (picked.length < availableSlots) {
    const item = getNextDownloadFile();
    if (!item) {
      break;
    }
    if (refreshPathListItemForOptions(item, new Set(["queued", "error", "done"]))) {
      changedShards.add(shardIndexFor(item.storeIndex));
    }
    if (item.status !== "queued") {
      continue;
    }
    setItemStatus(item, "downloading");
    item.error = "";
    item.note = "";
    item.startedAt = Date.now();
    item.downloadId = null;
    item.bytesReceived = 0;
    syncIndexedItemProgress(item);
    item.totalBytes = -1;
    item.lastProgressAt = Date.now();
    picked.push(item);
    changedShards.add(shardIndexFor(item.storeIndex));
  }

  if (!picked.length) {
    if (!state.counts.downloading) {
      state.running = false;
      if (state.counts.queued) {
        state.notice = "没有可下载的选中项目。";
      }
      stopPolling();
      broadcastState();
    } else {
      resetDownloadTraversal();
      broadcastState();
      queueNextTick();
    }
    return;
  }

  await saveChangedShards(changedShards);
  broadcastState();

  for (const item of picked) {
    startDownload(item);
  }
  queueNextTick();
}

function getNextDownloadFile() {
  ensureDirectoryChildrenIndex();
  if (!downloadTraversalStack) {
    downloadTraversalStack = downloadTraversalEntries("", false).reverse();
  }

  while (downloadTraversalStack.length) {
    const entry = downloadTraversalStack.pop();
    const node = entry.node || entry;
    const forced = Boolean(entry.forced);
    if (node.kind === "directory") {
      if (effectiveNodeExcluded(node)) {
        continue;
      }
      const selection = forced ? "all" : effectiveNodeCheckState(node);
      if (selection === "none" || !node.queuedCount) {
        continue;
      }
      downloadTraversalStack.push(...downloadTraversalEntries(node.path, forced || selection === "all").reverse());
      continue;
    }

    const item = node.item;
    if (!item) {
      continue;
    }
    if (item.status !== "queued") {
      continue;
    }
    if (effectiveNodeExcluded(node)) {
      continue;
    }
    if (!forced && effectiveNodeCheckState(node) !== "all") {
      continue;
    }
    return item;
  }
  return null;
}

function downloadTraversalEntries(path, forced) {
  const entries = sortedDirectoryEntries(path);
  if (forced) {
    return entries
      .filter((node) => !effectiveNodeExcluded(node))
      .map((node) => ({ node, forced: true }));
  }
  return entries
    .filter((node) => effectiveNodeCheckState(node) !== "none" && !effectiveNodeExcluded(node))
    .map((node) => ({ node, forced: false }));
}

function sortedDirectoryEntries(path) {
  const bucket = directoryChildrenIndex.get(sanitizePath(path || "")) || createDirectoryBucket();
  return [...bucket.directories.values(), ...bucket.files].sort(compareTreeNodes);
}

async function startDownload(item) {
  if (!state.running) {
    if (item.status === "downloading") {
      setItemStatus(item, "queued");
    }
    await saveItemShard(item);
    broadcastState();
    return;
  }

  try {
    repairItemFilename(item);
    if (state.options.skipExisting) {
      const existingDownload = await findExistingDownload(item);
      if (existingDownload) {
        item.downloadId = existingDownload.id || null;
        item.bytesReceived = existingDownload.bytesReceived || existingDownload.fileSize || existingDownload.totalBytes || 0;
        syncIndexedItemProgress(item);
        item.totalBytes = existingDownload.totalBytes || existingDownload.fileSize || item.bytesReceived || -1;
        item.note = "Skipped: local file already exists.";
        await finishDownload(item, "done");
        return;
      }
    }

    const downloadId = await startBrowserDownload({
      url: item.url,
      filename: item.filename,
      conflictAction: "overwrite",
      saveAs: false
    });

    if (!state.running || item.status !== "downloading") {
      userCancelledDownloadIds.add(downloadId);
      await desktop.downloads.cancel(downloadId).catch(() => {});
      if (item.status === "downloading") {
        setItemStatus(item, "queued");
      }
      item.downloadId = null;
      item.note = "Download start was cancelled before the native backend returned a download id.";
      await saveItemShard(item);
      broadcastState();
      return;
    }

    item.downloadId = downloadId;
    item.lastProgressAt = Date.now();
    activeDownloadIds.add(downloadId);
    downloadIdToItemId.set(downloadId, item.id);
    await saveItemShard(item);
    broadcastState();
    reconcileDownload(downloadId);
  } catch (error) {
    if (item.status !== "downloading") {
      await saveItemShard(item);
      broadcastState();
      return;
    }
    if (shouldRetryWithCompactFilename(error.message || String(error), item)) {
      await retryWithCompactFilename(item, error.message || String(error));
      return;
    }

    const rawError = error.message || String(error);
    const proxyUnavailable = String(rawError).includes("TOR_PROXY_UNAVAILABLE");
    setItemStatus(item, "error");
    item.error = explainDownloadError(rawError);
    item.downloadId = null;
    if (proxyUnavailable) {
      state.notice = item.error;
    }
    await saveItemShard(item);
    if (proxyUnavailable) {
      await cancelDownloads();
      return;
    }
    broadcastState();
    queueNextTick();
  }
}

async function startBrowserDownload(downloadOptions) {
  let timer = null;
  let timedOut = false;
  const downloadPromise = desktop.downloads.download(downloadOptions);
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new Error("DOWNLOAD_START_TIMEOUT"));
    }, DOWNLOAD_START_TIMEOUT_MS);
  });

  try {
    return await Promise.race([downloadPromise, timeoutPromise]);
  } finally {
    clearTimeout(timer);
    if (timedOut) {
      downloadPromise
        .then((downloadId) => desktop.downloads.cancel(downloadId).catch(() => {}))
        .catch(() => {});
    }
  }
}

async function reconcileDownload(downloadId) {
  await ensureLoaded();
  const itemId = downloadIdToItemId.get(downloadId);
  const file = itemId ? fileNodeIndex.get(itemId) : null;
  const item = file && file.item;
  if (!item) {
    userCancelledDownloadIds.delete(downloadId);
    return;
  }

  try {
    if (userCancelledDownloadIds.has(downloadId)) {
      userCancelledDownloadIds.delete(downloadId);
      activeDownloadIds.delete(downloadId);
      downloadIdToItemId.delete(downloadId);
      if (item.status === "downloading") {
        setItemStatus(item, "queued");
      }
      item.downloadId = null;
      item.error = "";
      item.note = "Download cancelled.";
      item.bytesReceived = 0;
      syncIndexedItemProgress(item);
      item.totalBytes = -1;
      item.startedAt = 0;
      item.finishedAt = 0;
      item.lastProgressAt = 0;
      await saveItemShard(item);
      broadcastState();
      return;
    }

    const [download] = await desktop.downloads.search({ id: downloadId });
    if (!download) {
      if (Date.now() - (item.startedAt || Date.now()) > DOWNLOAD_START_TIMEOUT_MS) {
        activeDownloadIds.delete(downloadId);
        downloadIdToItemId.delete(downloadId);
        await finishDownload(item, "error", "DOWNLOAD_LOST: native 后端创建了下载任务编号，但状态查询里找不到这个任务。队列已停止等待，请重试。");
      }
      return;
    }

    const previousBytes = item.bytesReceived || 0;
    const previousSessionBytes = item.sessionBytesReceived || 0;
    const previousTotalBytes = item.totalBytes || -1;
    const nextBytes = Number(download.bytesReceived);
    if (Number.isFinite(nextBytes) && nextBytes >= previousBytes) {
      item.bytesReceived = nextBytes;
    }
    const nextTotalBytes = Number(download.totalBytes);
    if (Number.isFinite(nextTotalBytes) && nextTotalBytes >= 0) {
      item.totalBytes = nextTotalBytes;
    }
    const nextSessionBytes = Number(download.sessionBytesReceived);
    if (Number.isFinite(nextSessionBytes) && nextSessionBytes >= previousSessionBytes) {
      item.sessionBytesReceived = nextSessionBytes;
    }
    recordDownloadProgress(item.sessionBytesReceived - previousSessionBytes);
    if (item.bytesReceived > previousBytes || item.totalBytes !== previousTotalBytes) {
      item.lastProgressAt = Date.now();
      syncIndexedItemProgress(item);
      queueItemNodeUpdates(item, false);
      markDirectoryViewDirty();
    }

    if (download.state === "complete") {
      await finishDownload(item, "done");
      return;
    }

    if (download.state === "interrupted") {
      if (shouldRetryWithCompactFilename(download.error || "download interrupted", item)) {
        await retryWithCompactFilename(item, download.error || "download interrupted");
      } else {
        await finishDownload(item, "error", explainDownloadError(download.error || "download interrupted"));
      }
      return;
    }

    if ((item.bytesReceived || 0) <= 0 && Date.now() - (item.lastProgressAt || item.startedAt || Date.now()) > DOWNLOAD_STALL_TIMEOUT_MS) {
      await desktop.downloads.cancel(downloadId).catch(() => {});
      await finishDownload(item, "error", "DOWNLOAD_STALLED: 下载已经开始，但长时间没有收到任何数据。请确认当前 Tor 标签页能直接打开这个完整文件 URL，然后点“重试失败”。");
      return;
    }

    await saveItemShard(item);
    flushNodeUpdatesThrottled();
    broadcastStateThrottled();
  } catch (error) {
    item.error = explainDownloadError(error.message || String(error));
    await saveItemShard(item);
    queueItemNodeUpdates(item, true);
    flushNodeUpdatesThrottled();
    broadcastStateThrottled();
  }
}

async function refreshPathListItemsForOptions(statuses) {
  const changedShards = new Set();
  for (const item of state.items) {
    if (refreshPathListItemForOptions(item, statuses)) {
      changedShards.add(shardIndexFor(item.storeIndex));
    }
  }

  if (changedShards.size) {
    markDirectoryViewDirty();
    rebuildDerivedState();
  }
  return changedShards;
}

async function recalculateLocalFileStatuses() {
  const eligibleItems = state.items.filter((item) => item.status !== "downloading");
  const changedShards = await refreshPathListItemsForOptions(new Set(["queued", "done", "error"]));

  for (const item of eligibleItems) {
    item.completedLocalSize = null;
    item.sessionBytesReceived = 0;
    if (item.status !== "done") {
      item.bytesReceived = 0;
      syncIndexedItemProgress(item);
    }
    changedShards.add(shardIndexFor(item.storeIndex));
  }

  await hydrateLocalFileStatuses(eligibleItems, changedShards);
  await saveChangedShards(changedShards);
  markDirectoryTreeDirty();
  rebuildDerivedState();
}

function refreshPathListItemForOptions(item, statuses) {
  const normalizedBaseUrl = normalizeBaseUrl(state.options.baseUrl);
  if (!normalizedBaseUrl || (statuses && !statuses.has(item.status)) || item.status === "downloading" || !isPathListItem(item)) {
    return false;
  }

  const beforeUrl = item.url;
  const beforePath = itemPathKey(item);
  const beforeSourceKey = itemSourceKey(item);
  const sourcePath = queueItemPath(item);
  if (!sourcePath) {
    return false;
  }

  const nextUrl = joinUrl(normalizedBaseUrl, sourcePath);
  const nextStoragePath = state.options.baseFolder || DEFAULT_OPTIONS.baseFolder;
  const nextFilename = sanitizeDownloadFilename([nextStoragePath, sourcePath].filter(Boolean).join("/"));
  let changed =
    item.url !== nextUrl ||
    item.storagePath !== nextStoragePath ||
    item.filename !== nextFilename;

  if (changed) {
    unindexKnownItem(item, {
      url: beforeUrl,
      pathKey: beforePath,
      sourceKey: beforeSourceKey
    });
    item.url = nextUrl;
    item.path = sourcePath;
    item.normalizedPath = sourcePath;
    item.pathParts = null;
    item.ancestorPaths = null;
    item.storagePath = nextStoragePath;
    item.filename = nextFilename;
    item.sourceType = "path-list";
    indexKnownItem(item);
  }

  if (changed && item.status === "done") {
    item.bytesReceived = 0;
    item.completedLocalSize = null;
    item.sessionBytesReceived = 0;
    syncIndexedItemProgress(item);
    item.totalBytes = Number.isFinite(item.metadataSize) && item.metadataSize >= 0 ? item.metadataSize : -1;
    item.finishedAt = 0;
    setItemStatus(item, "queued");
    changed = true;
  }
  return changed;
}

function isPathListItem(item) {
  return item.sourceType === "path-list" || (!item.sourceType && item.path && item.label === item.path);
}

function shouldRetryWithCompactFilename(error, item) {
  void error;
  void item;
  return false;
}

async function retryWithCompactFilename(item, reason) {
  const previousDownloadId = item.downloadId;
  if (previousDownloadId !== null && previousDownloadId !== undefined) {
    activeDownloadIds.delete(previousDownloadId);
    downloadIdToItemId.delete(previousDownloadId);
    await desktop.downloads.cancel(previousDownloadId).catch(() => {});
  }

  setItemStatus(item, "queued");
  item.compactRetry = true;
  item.filename = compactDownloadFilename(item);
  item.error = "";
  item.note = `Retrying with a shorter filename after ${String(reason || "download error")}.`;
  item.downloadId = null;
  item.bytesReceived = 0;
  syncIndexedItemProgress(item);
  item.totalBytes = -1;
  item.lastProgressAt = 0;
  updateDirectoryTree();
  await saveItemShard(item);
  broadcastState();
  queueNextTick();
}

function compactDownloadFilename(item) {
  const sourcePath = queueItemPath(item);
  const leaf = sourcePath.split("/").filter(Boolean).pop() || "download";
  const safeLeaf = sanitizePathSegment(leaf, { trimSegments: true, forDownload: true, isLeaf: true });
  const hash = shortHash(sourcePath || item.url || safeLeaf);
  const compactLeaf = truncateSegment(`${hash}-${safeLeaf}`, 120);
  return sanitizeDownloadFilename([state.options.baseFolder || DEFAULT_OPTIONS.baseFolder, "__retry__", compactLeaf].join("/"));
}

function shortHash(value) {
  let hash = 2166136261;
  for (let index = 0; index < String(value).length; index += 1) {
    hash ^= String(value).charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

async function findExistingDownload(item) {
  const localFile = await findExistingLocalFile(item);
  if (localFile) {
    return localFile;
  }

  const searches = [
    { url: item.url, state: "complete", limit: 20, orderBy: ["-startTime"] }
  ];

  const filenameRegex = filenameSuffixRegex(item.filename);
  if (filenameRegex) {
    searches.push({ filenameRegex, state: "complete", limit: 20, orderBy: ["-startTime"] });
  }

  for (const query of searches) {
    let downloads = [];
    try {
      downloads = await desktop.downloads.search(query);
    } catch (_) {
      continue;
    }

    const found = downloads.find((download) => isUsableExistingDownload(download, item));
    if (found) {
      return found;
    }
  }

  return null;
}

async function findExistingLocalFile(item) {
  if (!desktop.downloads || typeof desktop.downloads.existsLocalFile !== "function") {
    return null;
  }

  let status = null;
  try {
    status = await desktop.downloads.existsLocalFile(item.filename);
  } catch (_) {
    return null;
  }

  if (!status || status.exists !== true || status.isFile !== true) {
    return null;
  }

  const fileSize = Number(status.fileSize) || 0;
  return {
    id: null,
    url: item.url,
    filename: status.filename || item.filename,
    state: "complete",
    exists: true,
    bytesReceived: fileSize,
    totalBytes: fileSize || -1,
    fileSize
  };
}

function isUsableExistingDownload(download, item) {
  if (!download || download.state !== "complete" || download.exists !== true) {
    return false;
  }

  const bytesReceived = Number(download.bytesReceived) || 0;
  const fileSize = Number(download.fileSize) || 0;
  const totalBytes = Number(download.totalBytes) || 0;
  const expectedSize = fileSize > 0 ? fileSize : totalBytes;
  if (expectedSize > 0 && bytesReceived < expectedSize) {
    return false;
  }

  if (download.url === item.url) {
    return true;
  }

  return filenameEndsWith(download.filename || "", item.filename || "");
}

function filenameEndsWith(actualFilename, expectedFilename) {
  const actual = normalizeFilenameForCompare(actualFilename);
  const expected = normalizeFilenameForCompare(expectedFilename);
  return Boolean(actual && expected && (actual === expected || actual.endsWith(`/${expected}`)));
}

function normalizeFilenameForCompare(value) {
  return String(value || "")
    .normalize("NFC")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/{2,}/g, "/");
}

function filenameSuffixRegex(filename) {
  const normalized = normalizeFilenameForCompare(filename);
  if (!normalized) {
    return "";
  }
  return `${escapeRegex(normalized).replace(/\\\//g, "[/\\\\]")}$`;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function explainDownloadError(error) {
  const value = String(error || "").trim() || "download failed";
  if (value.includes("TOR_PROXY_UNAVAILABLE")) {
    return "TOR_PROXY_UNAVAILABLE: 无法连接 Tor 代理。请打开 Tor 浏览器，并先连接到 Tor 网络，然后点击“重试失败”。";
  }
  if (value.includes("TOR_PROXY_DISCONNECTED")) {
    return "TOR_PROXY_DISCONNECTED: Tor 代理连接已中断。请打开 Tor 浏览器并重新连接到 Tor 网络，然后点击“重试失败”。";
  }
  if (value === "SERVER_BAD_CONTENT") {
    return "SERVER_BAD_CONTENT: 服务器没有返回可下载文件。通常是 Base URL 拼错、404、登录页/HTML 页面、权限不足，或当前 Tor 会话不能直接访问该文件 URL。";
  }
  if (value === "NETWORK_FAILED") {
    return "NETWORK_FAILED: 网络连接失败。桌面版会在开始/重试时用当前 Base URL 重建 txt 导入项；如果仍失败，请确认 Tor 代理当前能访问该文件 URL。";
  }
  if (value === "DOWNLOAD_START_TIMEOUT") {
    return "DOWNLOAD_START_TIMEOUT: native 后端没有在 60 秒内创建下载任务。请确认 Tor 代理当前能访问这个完整文件 URL，然后点“重试失败”。";
  }
  if (value === "CRASH") {
    return "CRASH: native 下载任务中断。桌面版会自动用更短的安全文件名重试一次；如果仍失败，通常是该 URL 返回内容或本机文件写入路径有问题。";
  }
  if (value === "FILE_FAILED" || value === "FILE_ACCESS_DENIED") {
    return `${value}: native 后端无法写入目标文件，请检查下载目录、文件名长度和权限。`;
  }
  if (/filename must not contain illegal characters/i.test(value)) {
    return "filename must not contain illegal characters: 保存路径里包含不允许的文件名字符，请点“重试失败”。";
  }
  return value;
}

async function finishDownload(item, status, error = "") {
  setItemStatus(item, status);
  item.error = error;
  item.finishedAt = Date.now();
  activeDownloadIds.delete(item.downloadId);
  downloadIdToItemId.delete(item.downloadId);
  updateDirectoryTree();
  await saveItemShard(item);

  if (error.includes("TOR_PROXY_DISCONNECTED") || error.includes("TOR_PROXY_UNAVAILABLE")) {
    state.notice = error;
    await cancelDownloads();
    return;
  }

  if (!state.counts.queued && !state.counts.downloading) {
    state.running = false;
    stopPolling();
    broadcastState();
    return;
  }

  broadcastState();
  queueNextTick();
}

function setItemStatus(item, nextStatus) {
  if (item.status === nextStatus) {
    return;
  }
  const previousStatus = item.status;
  decrementStatus(item.status);
  item.status = nextStatus;
  state.counts[nextStatus] = (state.counts[nextStatus] || 0) + 1;
  syncIndexedItemStatus(item, previousStatus, nextStatus);
  queueItemNodeUpdates(item, true);
  flushNodeUpdatesThrottled();
  markDirectoryViewDirty();
}

function decrementStatus(status) {
  if (state.counts[status] > 0) {
    state.counts[status] -= 1;
  }
}

function queueNextTick() {
  clearTimeout(nextTimer);
  nextTimer = setTimeout(runNext, state.options.delayMs);
}

function startPolling() {
  stopPolling();
  resetDownloadSpeed();
  speedWindowStartedAt = Date.now();
  pollTimer = setInterval(pollActiveDownloads, PROGRESS_REFRESH_INTERVAL_MS);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function pollActiveDownloads() {
  if (state.counts.downloading) {
    sampleDownloadSpeed();
  } else {
    resetDownloadSpeed();
  }
  for (const downloadId of activeDownloadIds) {
    reconcileDownload(downloadId);
  }
  broadcastStateThrottled();
}

function recordDownloadProgress(byteDelta) {
  const delta = Math.max(0, Number(byteDelta) || 0);
  if (!delta) {
    return;
  }

  speedWindowBytes += delta;
}

function sampleDownloadSpeed() {
  const now = Date.now();
  if (!speedWindowStartedAt) {
    speedWindowStartedAt = now;
    return;
  }
  const elapsed = now - speedWindowStartedAt;
  if (elapsed <= 0) {
    return;
  }
  const currentSpeedBps = (speedWindowBytes * 1000) / elapsed;
  const alpha = 1 - Math.exp(-elapsed / SPEED_SMOOTHING_TIME_MS);
  if (speedSampleInitialized) {
    downloadSpeedBps = alpha * currentSpeedBps + (1 - alpha) * downloadSpeedBps;
  } else if (currentSpeedBps > 0) {
    downloadSpeedBps = currentSpeedBps;
    speedSampleInitialized = true;
  }
  speedWindowBytes = 0;
  speedWindowStartedAt = now;
}

function currentDownloadSpeedBps() {
  if (!state.counts.downloading) {
    return 0;
  }
  return Math.round(downloadSpeedBps);
}

function resetDownloadSpeed() {
  downloadSpeedBps = 0;
  speedWindowBytes = 0;
  speedWindowStartedAt = 0;
  speedSampleInitialized = false;
}

function firstQueuedIndex() {
  const index = state.items.findIndex((item) => item.status === "queued" && isEffectivelySelectedItem(item));
  return index < 0 ? state.items.length : index;
}

function rebuildDerivedState() {
  recomputeCounts();
  updateDirectoryTree();
}

function recomputeCounts() {
  state.counts = { total: 0, queued: 0, downloading: 0, done: 0, error: 0 };
  for (const item of state.items) {
    incrementCountsForItem(item);
  }
}

function updateDirectoryTree() {
  state.directories = getDirectoryChildren("");
  directoryTreeDirty = false;
}

function getDirectoryChildren(parentPath = "") {
  return getDirectoryChildNodes(parentPath).map(serializeDirectoryChild);
}

function getDirectoryChildNodes(parentPath = "") {
  const cleanedParentPath = sanitizePath(parentPath === ROOT_DIRECTORY_LABEL ? "" : parentPath);
  ensureDirectoryChildrenIndex();
  const bucket = directoryChildrenIndex.get(cleanedParentPath) || createDirectoryBucket();
  return [...bucket.directories.values(), ...bucket.files]
    .sort(compareTreeNodes);
}

function getDirectoryChildrenForView(parentPath = "") {
  const children = getDirectoryChildNodes(parentPath);
  if (!children.length || !desktop.files || typeof desktop.files.cachedMetadataSizes !== "function") {
    return children.map(serializeDirectoryChild);
  }

  const now = Date.now();
  const targets = [];
  const normalizedParentPath = sanitizePath(parentPath === ROOT_DIRECTORY_LABEL ? "" : parentPath);
  const isRootView = normalizedParentPath === "";
  const aggregatesTopLevel = isTopLevelDirectoryPath(normalizedParentPath);
  if (aggregatesTopLevel) {
    const parent = directoryNodeIndex.get(normalizedParentPath);
    if (parent && metadataDirectorySize(normalizedParentPath) === null) {
      parent.sizeLoading = true;
      queueNodeUpdate(parent);
      flushNodeUpdatesThrottled();
    }
  }
  for (const child of children) {
    const knownSize = child.kind === "directory"
      ? metadataDirectorySize(child.path)
      : itemDisplaySize(child.item);
    child.sizeBytes = knownSize;
    if (isRootView && child.kind === "directory" && isTopLevelDirectoryPath(child.path)) {
      if (knownSize !== null) {
        child.sizeLoading = false;
        continue;
      }
      if (completedLocalNodeSize(child) === null) {
        child.sizeLoading = child.sizeLoading === true;
        continue;
      }
    }
    child.sizeLoading = knownSize === null;
    if (knownSize !== null) {
      continue;
    }
    const key = `${child.kind === "directory" ? "dir" : "file"}:${sanitizePath(child.path)}`;
    if (now - (metadataLookupAttempts.get(key) || 0) < METADATA_LOOKUP_RETRY_MS) {
      continue;
    }
    metadataLookupAttempts.set(key, now);
    targets.push({
      child,
      allowRemote: !(isRootView && child.kind === "directory" && isTopLevelDirectoryPath(child.path)),
      entry: {
        kind: child.kind === "directory" ? "dir" : "file",
        path: sanitizePath(child.path)
      }
    });
  }

  if (targets.length) {
    void loadVisibleMetadataSizes(normalizedParentPath, targets, metadataViewGeneration);
  } else if (aggregatesTopLevel) {
    updateTopLevelDirectorySize(normalizedParentPath);
  }
  return children.map(serializeDirectoryChild);
}

async function loadVisibleMetadataSizes(parentPath, targets, generation) {
  const cachedSizes = await requestMetadataSizes(targets.map(({ entry }) => entry), "");
  if (generation !== metadataViewGeneration) {
    return;
  }

  let updated = false;
  const remoteTargets = [];
  for (let index = 0; index < targets.length; index += 1) {
    const target = targets[index];
    if (applyNodeSize(target, cachedSizes[index], false)) {
      updated = true;
      continue;
    }
    const localSize = completedLocalNodeSize(target.child);
    if (localSize !== null) {
      applyNodeSize(target, localSize, true);
      updated = true;
    } else if (target.allowRemote) {
      remoteTargets.push(target);
    }
  }

  if (remoteTargets.length) {
    const remoteSizes = await requestMetadataSizes(
      remoteTargets.map(({ entry }) => entry),
      state.options.baseUrl
    );
    if (generation !== metadataViewGeneration) {
      return;
    }
    for (let index = 0; index < remoteTargets.length; index += 1) {
      updated = applyNodeSize(remoteTargets[index], remoteSizes[index], false) || updated;
    }
  }

  if (updated) {
    flushNodeUpdatesThrottled();
  }
  if (isTopLevelDirectoryPath(parentPath)) {
    updateTopLevelDirectorySize(parentPath);
  }
}

function requestMetadataSizes(entries, baseUrl) {
  const requestKey = `${baseUrl ? `remote:${baseUrl}` : "cache"}\n${entries
    .map((entry) => `${entry.kind}:${entry.path}`)
    .join("\n")}`;
  let request = metadataSizeRequests.get(requestKey);
  if (!request) {
    request = desktop.files.cachedMetadataSizes(entries, baseUrl ? { baseUrl } : {}).catch(() => []);
    metadataSizeRequests.set(requestKey, request);
    request.finally(() => metadataSizeRequests.delete(requestKey));
  }
  return request;
}

function applyNodeSize(target, rawSize, local) {
  const { child, entry } = target;
  const size = Number(rawSize);
  if (rawSize === null || rawSize === undefined || !Number.isFinite(size) || size < 0) {
    return false;
  }
  metadataLookupAttempts.delete(`${entry.kind}:${entry.path}`);
  child.sizeBytes = size;
  child.sizeLoading = false;
  if (entry.kind === "dir") {
    metadataDirectorySizes.set(entry.path, size);
  } else if (child.item) {
    if (local) {
      child.item.completedLocalSize = size;
    } else {
      child.item.metadataSize = size;
      child.item.totalBytes = size;
    }
  }
  queueNodeUpdate(child);
  return true;
}

function completedLocalNodeSize(node) {
  if (!node) {
    return null;
  }
  const complete = node.kind === "file"
    ? node.status === "done"
    : Number(node.count) > 0 && Number(node.completedCount) >= Number(node.count);
  if (!complete) {
    return null;
  }
  return Math.max(0, Number(node.bytesReceived) || 0);
}

function updateTopLevelDirectorySize(path) {
  if (!isTopLevelDirectoryPath(path)) {
    return;
  }
  const parent = directoryNodeIndex.get(path);
  const children = getDirectoryChildNodes(path);
  if (!parent || !children.length) {
    return;
  }

  let total = 0;
  for (const child of children) {
    const size = child.kind === "directory"
      ? metadataDirectorySize(child.path)
      : itemDisplaySize(child.item);
    if (size === null) {
      parent.sizeBytes = null;
      parent.sizeLoading = true;
      queueNodeUpdate(parent);
      flushNodeUpdatesThrottled();
      return;
    }
    total += size;
  }

  metadataDirectorySizes.set(path, total);
  parent.sizeBytes = total;
  parent.sizeLoading = false;
  queueNodeUpdate(parent);
  flushNodeUpdatesThrottled();
}

function isTopLevelDirectoryPath(path) {
  const normalizedPath = sanitizePath(path || "");
  return normalizedPath !== "" && !normalizedPath.includes("/");
}

function resetViewMetadata() {
  metadataViewGeneration += 1;
  catalogDirectorySizes.clear();
  metadataDirectorySizes.clear();
  metadataLookupAttempts.clear();
  metadataSizeRequests.clear();
}

function ensureDirectoryChildrenIndex() {
  if (!directoryChildrenIndexDirty) {
    return;
  }

  const previousDirectoryStates = snapshotDirectoryCheckStates();
  directoryChildrenIndex = new Map();
  directoryNodeIndex = new Map();
  fileNodeIndex = new Map();
  for (const item of state.items) {
    addItemToDirectoryChildrenIndex(item, previousDirectoryStates);
  }
  recomputeAllDirectoryCalculatedStates();
  directoryChildrenIndexDirty = false;
}

function snapshotDirectoryCheckStates() {
  const states = new Map();
  for (const [path, node] of directoryNodeIndex.entries()) {
    states.set(path, {
      manualCheckState: node.manualCheckState || null
    });
  }
  return states;
}

function createDirectoryBucket() {
  return {
    directories: new Map(),
    files: []
  };
}

function directoryBucket(path) {
  const normalizedPath = sanitizePath(path || "");
  let bucket = directoryChildrenIndex.get(normalizedPath);
  if (!bucket) {
    bucket = createDirectoryBucket();
    directoryChildrenIndex.set(normalizedPath, bucket);
  }
  return bucket;
}

function addItemToDirectoryChildrenIndex(item, previousDirectoryStates = new Map()) {
  const itemPath = queueItemPath(item);
  if (!itemPath) {
    return;
  }

  const parts = itemPath.split("/").filter(Boolean);
  if (!parts.length) {
    return;
  }

  let parentPath = "";
  for (let index = 0; index < parts.length - 1; index += 1) {
    const childPath = parentPath ? `${parentPath}/${parts[index]}` : parts[index];
    const bucket = directoryBucket(parentPath);
    const key = `dir:${childPath}`;
    let directory = bucket.directories.get(key);
    if (!directory) {
      directory = createDirectoryNode(parts[index], childPath, parentPath);
      applyPreviousDirectoryState(directory, previousDirectoryStates);
      directory.hasChildren = true;
      bucket.directories.set(key, directory);
      directoryNodeIndex.set(childPath, directory);
    }
    incrementDirectorySummary(directory, item);
    parentPath = childPath;
  }

  const file = createFileNode(item, parts[parts.length - 1], itemPath, parentPath);
  directoryBucket(parentPath).files.push(file);
  fileNodeIndex.set(file.id, file);
  fileNodeIndex.set(`path:${itemPath}`, file);
}

function applyPreviousDirectoryState(directory, previousDirectoryStates) {
  const previous = previousDirectoryStates.get(directory.path || "");
  if (!previous) {
    return;
  }
  directory.manualCheckState = previous.manualCheckState || null;
}

function incrementDirectorySummary(directory, item) {
  directory.count += 1;
  directory.bytesReceived += Math.max(0, Number(item.bytesReceived) || 0);
  if (item.status === "done") {
    directory.completedCount += 1;
  }
  if (item.status === "queued") {
    directory.queuedCount += 1;
  }
  if (item.status === "downloading") {
    directory.downloadingCount += 1;
  }
  if (item.status === "error") {
    directory.errorCount += 1;
  }
}

function resetDirectorySummary(directory) {
  directory.count = 0;
  directory.completedCount = 0;
  directory.queuedCount = 0;
  directory.downloadingCount = 0;
  directory.errorCount = 0;
  directory.bytesReceived = 0;
  directory.sizeBytes = metadataDirectorySize(directory.path);
  directory.sizeLoading = false;
}

function recomputeIndexedDirectorySummaries() {
  if (directoryChildrenIndexDirty) {
    return;
  }
  for (const directory of directoryNodeIndex.values()) {
    resetDirectorySummary(directory);
  }
  for (const item of state.items) {
    for (const path of queueItemAncestorPaths(item)) {
      const directory = directoryNodeIndex.get(path);
      if (directory) {
        incrementDirectorySummary(directory, item);
      }
    }
  }
  for (const item of state.items) {
    const file = fileNodeForItem(item);
    if (file) {
      syncFileNodeFromItem(file, item);
    }
  }
}

function markDirectoryTreeDirty() {
  directoryTreeDirty = true;
  directoryChildrenIndexDirty = true;
}

function markDirectoryViewDirty() {
  directoryTreeDirty = true;
}

function resetDownloadTraversal() {
  downloadTraversalStack = null;
}

function recomputeAllDirectoryCalculatedStates() {
  const paths = Array.from(directoryNodeIndex.keys()).sort((a, b) => b.length - a.length);
  for (const path of paths) {
    const directory = directoryNodeIndex.get(path);
    if (directory) {
      recomputeDirectoryCalculatedState(directory);
    }
  }
}

function serializeDirectoryChild(child) {
  const localPath = child.kind === "file"
    ? (child.item && child.item.filename) || ""
    : localPathForDirectoryNode(child);
  return {
    id: child.id,
    kind: child.kind,
    name: child.name,
    path: child.path,
    count: child.count,
    completedCount: child.completedCount,
    queuedCount: child.queuedCount || 0,
    downloadingCount: child.downloadingCount || 0,
    selection: effectiveNodeCheckState(child),
    excluded: effectiveNodeExcluded(child),
    directExcluded: directNodeExcluded(child),
    extension: child.extension || "",
    status: child.status || "",
    url: child.url || "",
    bytesReceived: child.bytesReceived || 0,
    totalBytes: child.totalBytes || -1,
    sizeBytes: child.sizeBytes,
    sizeLoading: child.sizeLoading === true,
    localPath,
    hasChildren: child.kind === "directory" ? child.hasChildren !== false : false
  };
}

function localPathForDirectoryNode(directory) {
  const fallback = sanitizeDownloadFilename([state.options.baseFolder, directory.path].filter(Boolean).join("/"));
  const directoryPath = sanitizePath(directory && directory.path);
  const item = state.items.find((candidate) => itemIsUnderDirectory(candidate, directoryPath) && candidate.filename);
  if (!item) {
    return fallback;
  }

  const itemPathParts = queueItemPath(item).split("/").filter(Boolean);
  const directoryPathParts = directoryPath.split("/").filter(Boolean);
  const localParts = String(item.filename || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/\/+$/, "")
    .split("/")
    .filter(Boolean);
  const leafParts = Math.max(0, itemPathParts.length - directoryPathParts.length);
  if (!localParts.length || leafParts >= localParts.length) {
    return fallback;
  }
  return localParts.slice(0, localParts.length - leafParts).join("/");
}

function nodeSelectionState(node) {
  return effectiveNodeCheckState(node);
}

function nodeCheckState(node) {
  if (!node) {
    return "all";
  }
  return node.manualCheckState || node.calculatedCheckState || "all";
}

function effectiveNodeCheckState(node) {
  if (!node) {
    return "all";
  }
  if (node.manualCheckState) {
    return node.manualCheckState;
  }
  const inheritedState = nearestAncestorManualCheckState(node);
  if (inheritedState) {
    return inheritedState;
  }
  return node.calculatedCheckState || "all";
}

function effectiveNodeExcluded(node) {
  if (!node) {
    return false;
  }
  if (directNodeExcluded(node)) {
    return true;
  }
  const paths = ancestorDirectoryPaths(node).reverse();
  for (const path of paths) {
    const ancestor = directoryNodeIndex.get(path);
    if (ancestor && directNodeExcluded(ancestor)) {
      return true;
    }
  }
  return false;
}

function directNodeExcluded(node) {
  if (!node || !node.path) {
    return false;
  }
  const keyKind = node.kind === "file" ? "file" : "dir";
  return pathExclusionOverrides.get(`${keyKind}:${persistentSelectionPath(node.path)}`) === true;
}

function nearestAncestorManualCheckState(node) {
  const paths = ancestorDirectoryPaths(node).reverse();
  for (const path of paths) {
    const ancestor = directoryNodeIndex.get(path);
    if (ancestor && ancestor.manualCheckState) {
      return ancestor.manualCheckState;
    }
  }
  return null;
}

function fileNodeByTarget(target, path) {
  if (target && target.id) {
    const byId = fileNodeIndex.get(target.id);
    if (byId) {
      return byId;
    }
  }
  return fileNodeIndex.get(`path:${path}`) || null;
}

function fileNodeForItem(item) {
  if (!item) {
    return null;
  }
  return fileNodeIndex.get(item.id) || fileNodeIndex.get(`path:${queueItemPath(item)}`) || null;
}

function materializeAncestorManualStates(targetNode) {
  const ancestors = ancestorDirectoryNodes(targetNode);
  for (const ancestor of ancestors) {
    const inheritedState = ancestor.manualCheckState;
    if (!inheritedState) {
      continue;
    }
    materializeStateBelowAncestor(ancestor, targetNode.path, inheritedState);
    ancestor.manualCheckState = null;
  }
}

function materializeStateBelowAncestor(ancestor, targetPath, stateValue) {
  let current = ancestor;
  let currentPath = current.path || "";
  const parts = sanitizePath(targetPath).split("/").filter(Boolean);
  const baseDepth = currentPath ? currentPath.split("/").filter(Boolean).length : 0;

  for (let depth = baseDepth; depth < parts.length; depth += 1) {
    const bucket = directoryChildrenIndex.get(currentPath) || createDirectoryBucket();
    const nextPath = parts.slice(0, depth + 1).join("/");
    for (const child of [...bucket.directories.values(), ...bucket.files]) {
      if (child.path === nextPath || child.path === targetPath) {
        continue;
      }
      child.manualCheckState = stateValue;
      if (child.kind === "file" && child.item) {
        child.item.manualSelected = stateValue === "all";
      }
    }

    const nextDirectory = directoryNodeIndex.get(nextPath);
    if (!nextDirectory) {
      break;
    }
    current = nextDirectory;
    currentPath = current.path;
  }
}

function ancestorDirectoryNodes(node) {
  const paths = ancestorDirectoryPaths(node);
  return paths.map((path) => directoryNodeIndex.get(path)).filter(Boolean);
}

function ancestorDirectoryPaths(node) {
  const sourcePath = node && node.kind === "directory" ? node.parentPath : parentPathForItem(node && node.item);
  const parts = sanitizePath(sourcePath).split("/").filter(Boolean);
  const paths = [];
  for (let index = 0; index < parts.length; index += 1) {
    paths.push(parts.slice(0, index + 1).join("/"));
  }
  return paths;
}

function recomputeCalculatedStatesFrom(node) {
  const paths = ancestorDirectoryPaths(node).reverse();
  if (node && node.kind === "directory") {
    recomputeDirectoryCalculatedState(node);
  }
  for (const path of paths) {
    const directory = directoryNodeIndex.get(path);
    if (directory) {
      recomputeDirectoryCalculatedState(directory);
    }
  }
}

function recomputeDirectoryCalculatedState(directory) {
  const bucket = directoryChildrenIndex.get(directory.path || "");
  const children = bucket ? [...bucket.directories.values(), ...bucket.files] : [];
  if (!children.length) {
    directory.calculatedCheckState = "all";
    return;
  }

  const states = children.map(nodeCheckState);
  if (states.every((stateValue) => stateValue === "all")) {
    directory.calculatedCheckState = "all";
  } else if (states.every((stateValue) => stateValue === "none")) {
    directory.calculatedCheckState = "none";
  } else {
    directory.calculatedCheckState = "partial";
  }
}

function syncIndexedItemStatus(item, previousStatus, nextStatus) {
  if (directoryChildrenIndexDirty) {
    return;
  }

  const file = fileNodeForItem(item);
  if (file) {
    syncFileNodeFromItem(file, item);
  }

  for (const path of queueItemAncestorPaths(item)) {
    const directory = directoryNodeIndex.get(path);
    if (!directory) {
      continue;
    }
    if (previousStatus === "done" && directory.completedCount > 0) {
      directory.completedCount -= 1;
    }
    if (nextStatus === "done") {
      directory.completedCount += 1;
    }
    if (previousStatus === "queued" && directory.queuedCount > 0) {
      directory.queuedCount -= 1;
    }
    if (nextStatus === "queued") {
      directory.queuedCount += 1;
    }
    if (previousStatus === "downloading" && directory.downloadingCount > 0) {
      directory.downloadingCount -= 1;
    }
    if (nextStatus === "downloading") {
      directory.downloadingCount += 1;
    }
    if (previousStatus === "error" && directory.errorCount > 0) {
      directory.errorCount -= 1;
    }
    if (nextStatus === "error") {
      directory.errorCount += 1;
    }
  }
}

function syncIndexedItemProgress(item) {
  if (directoryChildrenIndexDirty) {
    return;
  }

  const file = fileNodeForItem(item);
  if (file) {
    const previousBytes = Math.max(0, Number(file.bytesReceived) || 0);
    syncFileNodeFromItem(file, item);
    const nextBytes = Math.max(0, Number(file.bytesReceived) || 0);
    const delta = nextBytes - previousBytes;
    if (delta) {
      for (const path of queueItemAncestorPaths(item)) {
        const directory = directoryNodeIndex.get(path);
        if (!directory) {
          continue;
        }
        directory.bytesReceived = Math.max(0, (Number(directory.bytesReceived) || 0) + delta);
        queueNodeUpdate(directory);
      }
      flushNodeUpdatesThrottled();
    }
  }
}

function syncFileNodeFromItem(file, item) {
  file.status = item.status;
  file.completedCount = item.status === "done" ? 1 : 0;
  file.queuedCount = item.status === "queued" ? 1 : 0;
  file.downloadingCount = item.status === "downloading" ? 1 : 0;
  file.errorCount = item.status === "error" ? 1 : 0;
  file.bytesReceived = item.bytesReceived || 0;
  file.totalBytes = item.totalBytes || -1;
  file.sizeBytes = itemDisplaySize(item);
  file.url = item.url || file.url || "";
}

function queueItemNodeUpdates(item, includeAncestors) {
  if (directoryChildrenIndexDirty) {
    return;
  }

  const file = fileNodeForItem(item);
  if (file) {
    syncFileNodeFromItem(file, item);
    queueNodeUpdate(file);
  }

  if (!includeAncestors) {
    return;
  }

  for (const path of queueItemAncestorPaths(item)) {
    const directory = directoryNodeIndex.get(path);
    if (directory) {
      queueNodeUpdate(directory);
    }
  }
}

function queueNodeUpdate(node) {
  if (!node) {
    return;
  }
  const key = `${node.kind}:${node.kind === "file" ? node.id : node.path}`;
  pendingNodeUpdates.set(key, serializeDirectoryChild(node));
}

async function saveItemShard(item) {
  void item;
}

async function saveChangedShards(changedShards) {
  void changedShards;
}

function shardIndexFor(storeIndex) {
  return Math.floor(storeIndex / SHARD_SIZE);
}

function normalizeOptions(options) {
  return {
    baseFolder: normalizeBaseFolder(options.baseFolder || DEFAULT_OPTIONS.baseFolder),
    overwrite: options.overwrite !== false,
    skipExisting: options.skipExisting !== false,
    delayMs: clampNumber(options.delayMs, 0, 60000, DEFAULT_OPTIONS.delayMs),
    maxConcurrent: clampNumber(options.maxConcurrent, 1, 100, DEFAULT_OPTIONS.maxConcurrent),
    baseUrl: normalizeBaseUrl(options.baseUrl || DEFAULT_OPTIONS.baseUrl)
  };
}

function normalizeQueueItem(item, baseFolder) {
  const url = String(item.url || "").trim();
  if (!/^https?:\/\//i.test(url)) {
    return null;
  }

  const suggestedPath = normalizeStoragePath(item.path || pathFromUrl(url) || item.label);
  const storagePath = normalizeBaseFolder(baseFolder || DEFAULT_OPTIONS.baseFolder);
  const filename = sanitizeDownloadFilename([storagePath, suggestedPath].filter(Boolean).join("/"));

  if (!filename || hasParentPathSegment(filename)) {
    return null;
  }

  return {
    url,
    path: suggestedPath,
    normalizedPath: suggestedPath,
    storagePath,
    filename,
    label: String(item.label || suggestedPath || url).trim(),
    sourceType: item.sourceType === "path-list" ? "path-list" : item.sourceType === "absolute-url" ? "absolute-url" : "",
    sourceKey: itemSourceKey(item),
    manualSelected: item.manualSelected === true ? true : item.manualSelected === false ? false : null,
    status: "queued",
    error: "",
    note: "",
    downloadId: null,
    compactRetry: false,
    bytesReceived: 0,
    sessionBytesReceived: 0,
    totalBytes: -1,
    metadataSize: null
  };
}

function pathFromUrl(url) {
  try {
    const parsed = new URL(url);
    const path = decodeURIComponent(parsed.pathname || "").replace(/^\/+/, "");
    return path || "download";
  } catch (_) {
    return "download";
  }
}

function normalizeBaseUrl(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    return "";
  }

  try {
    const url = new URL(trimmed);
    if (!/^https?:$/.test(url.protocol)) {
      return "";
    }
    return url.href.endsWith("/") ? url.href : `${url.href}/`;
  } catch (_) {
    return "";
  }
}

function joinUrl(baseUrl, path) {
  return `${baseUrl}${sanitizePath(path).split("/").map(encodeUrlPathSegment).join("/")}`;
}

function encodeUrlPathSegment(segment) {
  return encodeURIComponent(segment)
    .replace(/%21/gi, "!")
    .replace(/%24/gi, "$")
    .replace(/%26/gi, "&")
    .replace(/%27/gi, "'")
    .replace(/%28/gi, "(")
    .replace(/%29/gi, ")")
    .replace(/%2A/gi, "*")
    .replace(/%2B/gi, "+")
    .replace(/%2C/gi, ",")
    .replace(/%3A/gi, ":")
    .replace(/%3B/gi, ";")
    .replace(/%3D/gi, "=")
    .replace(/%40/gi, "@");
}

function sanitizePath(value) {
  return sanitizePathSegments(value, { trimSegments: true, limitLength: false });
}

function normalizeBaseFolder(value) {
  let path = String(value || "").trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  if (!path) {
    return DEFAULT_OPTIONS.baseFolder;
  }
  if (/^Users\//.test(path)) {
    path = `/${path}`;
  }
  if (path === "/" || /^[a-z]:\/$/i.test(path)) {
    return path;
  }
  return path.replace(/\/+$/, "");
}

function sanitizeDownloadFilename(value) {
  const raw = String(value || "").trim();
  const drive = raw.match(/^([a-z]:)[\\/]/i);
  const absolute = raw.startsWith("/") || /^Users[\\/]/.test(raw);
  const body = drive ? raw.slice(drive[0].length) : raw;
  const sanitized = sanitizePathSegments(body, { trimSegments: true, forDownload: true }) || "download";
  if (drive) {
    return `${drive[1]}/${sanitized}`;
  }
  return absolute ? `/${sanitized}` : sanitized;
}

function sanitizePathSegments(value, options = {}) {
  const normalizedValue = String(value || "")
    .normalize("NFC")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/{2,}/g, "/");

  if (!normalizedValue) {
    return "";
  }

  const segments = normalizedValue.split("/");

  return normalizedValue
    .split("/")
    .map((segment, index) => sanitizePathSegment(segment, { ...options, isLeaf: index === segments.length - 1 }))
    .filter(Boolean)
    .join("/");
}

function sanitizePathSegment(segment, options = {}) {
  let clean = String(segment || "")
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "_")
    .replace(/[<>:"|?*]/g, "_")
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "");

  if (options.trimSegments) {
    clean = clean.trim();
  }

  if (options.forDownload) {
    clean = clean.replace(/[. ]+$/g, "").replace(/^[. ]+/g, "");
    if (!options.isLeaf && /\.app$/i.test(clean)) {
      clean = clean.replace(/\.app$/i, "_app");
    }
  }

  if (!clean || clean === "." || clean === "..") {
    clean = "_";
  }

  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(clean)) {
    clean = `_${clean}`;
  }

  if (options.limitLength !== false && clean.length > MAX_FILENAME_SEGMENT_LENGTH) {
    clean = truncateSegment(clean, MAX_FILENAME_SEGMENT_LENGTH);
  }

  return clean;
}

function limitDownloadFilenameLength(filename) {
  if (filename.length <= MAX_DOWNLOAD_FILENAME_LENGTH) {
    return filename;
  }

  const parts = filename.split("/");
  const leaf = parts.pop() || "download";
  const prefix = parts.length ? `${parts.join("/")}/` : "";
  const remaining = Math.max(24, MAX_DOWNLOAD_FILENAME_LENGTH - prefix.length);
  if (prefix.length < MAX_DOWNLOAD_FILENAME_LENGTH - 24) {
    return `${prefix}${truncateSegment(leaf, remaining)}`;
  }

  const base = parts[0] || DEFAULT_OPTIONS.baseFolder;
  return [truncateSegment(base, 40), truncateSegment(leaf, MAX_DOWNLOAD_FILENAME_LENGTH - 41)].filter(Boolean).join("/");
}

function truncateSegment(segment, maxLength) {
  if (segment.length <= maxLength) {
    return segment;
  }

  const hash = shortHash(segment);
  const suffix = `-${hash}`;
  const dotIndex = segment.lastIndexOf(".");
  if (dotIndex > 0 && segment.length - dotIndex <= 16) {
    const extension = segment.slice(dotIndex);
    const headLength = Math.max(1, maxLength - extension.length - suffix.length);
    return `${segment.slice(0, headLength)}${suffix}${extension}`;
  }
  const headLength = Math.max(1, maxLength - suffix.length);
  return `${segment.slice(0, headLength)}${suffix}`;
}

function repairItemFilename(item) {
  const sourcePath = queueItemPath(item);
  const fallback = [state.options.baseFolder || DEFAULT_OPTIONS.baseFolder, sourcePath || "download"].filter(Boolean).join("/");
  item.path = sourcePath || "download";
  item.normalizedPath = item.path;
  item.pathParts = null;
  item.ancestorPaths = null;
  item.compactRetry = false;
  item.filename = sanitizeDownloadFilename(fallback);
}

function queueItemPath(item) {
  if (!item) {
    return "";
  }

  if (item.normalizedPath) {
    return item.normalizedPath;
  }

  const rawPath = String(item.path || "").trim();
  if (/^https?:\/\//i.test(rawPath)) {
    const urlPath = normalizeStoragePath(pathFromUrl(rawPath));
    if (urlPath) {
      item.normalizedPath = urlPath;
      return urlPath;
    }
  } else {
    const directPath = normalizeStoragePath(rawPath);
    if (directPath) {
      item.normalizedPath = directPath;
      return directPath;
    }
  }

  const rawLabel = String(item.label || "").trim();
  const labelPath = normalizeStoragePath(rawLabel);
  if (labelPath && !/^https?:\/\//i.test(rawLabel)) {
    item.normalizedPath = labelPath;
    return labelPath;
  }

  const urlPath = normalizeStoragePath(pathFromUrl(item.url || ""));
  if (urlPath) {
    item.normalizedPath = urlPath;
    return urlPath;
  }

  const sourceKeyPath = pathFromSourceKey(item.sourceKey || "");
  if (sourceKeyPath) {
    item.normalizedPath = sourceKeyPath;
    return sourceKeyPath;
  }

  item.normalizedPath = pathFromFilename(item.filename || "");
  return item.normalizedPath;
}

function queueItemParts(item) {
  if (!item) {
    return [];
  }
  if (!Array.isArray(item.pathParts)) {
    item.pathParts = queueItemPath(item).split("/").filter(Boolean);
  }
  return item.pathParts;
}

function queueItemAncestorPaths(item) {
  if (!item) {
    return [];
  }
  if (Array.isArray(item.ancestorPaths)) {
    return item.ancestorPaths;
  }

  const parts = queueItemParts(item);
  const ancestors = [];
  let current = "";
  for (let index = 0; index < parts.length - 1; index += 1) {
    current = current ? `${current}/${parts[index]}` : parts[index];
    ancestors.push(current);
  }
  item.ancestorPaths = ancestors;
  return ancestors;
}

function pathFromSourceKey(sourceKey) {
  const value = String(sourceKey || "");
  if (!value.startsWith("path-list:")) {
    return "";
  }

  const rawLine = value.slice("path-list:".length).trim().replace(/^["']|["']$/g, "");
  if (!rawLine) {
    return "";
  }

  if (/^https?:\/\//i.test(rawLine)) {
    return normalizeStoragePath(pathFromUrl(rawLine));
  }

  return normalizeStoragePath(decodePath(rawLine));
}

function normalizeStoragePath(value) {
  const path = sanitizePath(value);
  const match = path.match(/(?:^|\/)api\/companies\/[^/]+\/storages\/files\/(.+)$/i);
  return match ? sanitizePath(match[1]) : path;
}

function decodePath(value) {
  try {
    return decodeURIComponent(String(value || ""));
  } catch (_) {
    return String(value || "");
  }
}

function pathFromFilename(filename) {
  let path = sanitizePath(filename);
  if (!path) {
    return "";
  }

  const prefixes = [
    state.options.baseFolder,
    DEFAULT_OPTIONS.baseFolder,
    "tor-downloader-idb-test"
  ]
    .filter(Boolean)
    .map((prefix) => `${sanitizePath(prefix)}/`);

  for (const prefix of prefixes) {
    if (path.startsWith(prefix)) {
      path = path.slice(prefix.length);
      break;
    }
  }

  if (path.startsWith("__retry__/")) {
    path = path.slice("__retry__/".length).replace(/^[a-z0-9]+-/i, "");
  }

  return normalizeStoragePath(path);
}

function hasParentPathSegment(value) {
  return value.split("/").includes("..");
}

function createDirectoryNode(name, path, parentPath = "") {
  return {
    kind: "directory",
    id: path || ROOT_DIRECTORY_LABEL,
    name,
    path,
    parentPath: sanitizePath(parentPath || ""),
    count: 0,
    completedCount: 0,
    queuedCount: 0,
    downloadingCount: 0,
    errorCount: 0,
    bytesReceived: 0,
    sizeBytes: metadataDirectorySize(path),
    manualCheckState: null,
    calculatedCheckState: "all",
    parent: null,
    children: new Map()
  };
}

function createFileNode(item, name, resolvedPath = "", parentPath = "") {
  const path = resolvedPath || queueItemPath(item);
  return {
    kind: "file",
    id: item.id,
    item,
    name,
    path,
    parentPath: sanitizePath(parentPath || ""),
    count: 1,
    completedCount: item.status === "done" ? 1 : 0,
    queuedCount: item.status === "queued" ? 1 : 0,
    downloadingCount: item.status === "downloading" ? 1 : 0,
    errorCount: item.status === "error" ? 1 : 0,
    manualCheckState: item.manualSelected === true ? "all" : item.manualSelected === false ? "none" : null,
    calculatedCheckState: "all",
    extension: fileExtension(name),
    status: item.status,
    url: item.url,
    bytesReceived: item.bytesReceived || 0,
    totalBytes: item.totalBytes || -1,
    sizeBytes: itemDisplaySize(item),
    children: new Map()
  };
}

function itemDisplaySize(item) {
  const metadataSize = Number(item && item.metadataSize);
  if (item && item.metadataSize !== null && item.metadataSize !== undefined && Number.isFinite(metadataSize) && metadataSize >= 0) {
    return metadataSize;
  }
  const completedLocalSize = Number(item && item.completedLocalSize);
  if (item && item.status === "done" && item.completedLocalSize !== null && item.completedLocalSize !== undefined && Number.isFinite(completedLocalSize) && completedLocalSize >= 0) {
    return completedLocalSize;
  }
  return null;
}

function metadataDirectorySize(path) {
  const normalizedPath = sanitizePath(path || "");
  if (!metadataDirectorySizes.has(normalizedPath)) {
    return null;
  }
  const size = Number(metadataDirectorySizes.get(normalizedPath));
  return Number.isFinite(size) && size >= 0 ? size : null;
}

function compareTreeNodes(a, b) {
  if (a.kind !== b.kind) {
    return a.kind === "directory" ? -1 : 1;
  }
  if (a.kind === "directory" && a.count !== b.count) {
    return b.count - a.count;
  }
  return a.name.localeCompare(b.name);
}

function directoryContainsPath(directoryPath, itemPath) {
  const cleanedItemPath = sanitizePath(itemPath);
  if (directoryPath === ROOT_DIRECTORY_LABEL) {
    return cleanedItemPath && !cleanedItemPath.includes("/");
  }

  const cleanedDirectoryPath = sanitizePath(directoryPath);
  return cleanedItemPath === cleanedDirectoryPath || cleanedItemPath.startsWith(`${cleanedDirectoryPath}/`);
}

function fileExtension(name) {
  const match = String(name || "").toLowerCase().match(/\.([a-z0-9]{1,10})$/);
  return match ? match[1] : "";
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(number)));
}

function nonnegativeByteCount(primary, fallback = 0) {
  const primaryValue = Number(primary);
  if (Number.isFinite(primaryValue) && primaryValue >= 0) {
    return primaryValue;
  }
  const fallbackValue = Number(fallback);
  return Number.isFinite(fallbackValue) && fallbackValue >= 0 ? fallbackValue : 0;
}

function saveOptions() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    desktop.persistence.saveSettings(state.options).catch(() => {});
  }, 100);
}

function broadcastState() {
  desktop.runtime.sendMessage({ type: "queue:state-changed", state: getPublicState() }).catch(() => {});
}

function broadcastStateThrottled() {
  if (broadcastTimer) {
    return;
  }

  broadcastTimer = setTimeout(() => {
    broadcastTimer = null;
    broadcastState();
  }, PROGRESS_REFRESH_INTERVAL_MS);
}

function flushNodeUpdatesThrottled() {
  if (nodeUpdateTimer || !pendingNodeUpdates.size) {
    return;
  }

  nodeUpdateTimer = setTimeout(() => {
    nodeUpdateTimer = null;
    flushNodeUpdates();
  }, 250);
}

function flushNodeUpdates() {
  if (!pendingNodeUpdates.size) {
    return;
  }

  const updates = Array.from(pendingNodeUpdates.values());
  pendingNodeUpdates.clear();
  desktop.runtime.sendMessage({ type: "queue:nodes-updated", updates }).catch(() => {});
}
