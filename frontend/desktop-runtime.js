(function () {
  const invoke = window.__TAURI__.core.invoke;
  const listen = window.__TAURI__.event.listen;
  const runtimeListeners = [];
  const downloadChangedListeners = [];
  const catalogProgressListeners = new Set();
  let catalogProgressReady = Promise.resolve();
  const defaultProxyUrl = "socks5h://127.0.0.1:9150";
  let persistenceLoadPromise = null;
  const downloads = new Map();
  let nextDownloadId = 0;

  function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function loadPersistence() {
    if (!persistenceLoadPromise) {
      persistenceLoadPromise = loadPersistenceOnce();
    }
    return persistenceLoadPromise.then(clone);
  }

  async function loadPersistenceOnce() {
    return invoke("native_persistence_load");
  }

  async function saveSettings(queueOptions) {
    return invoke("native_settings_save", { request: { queueOptions: clone(queueOptions) } });
  }

  async function loadCompanies(baseUrl, options = {}) {
    return invoke("native_companies_load", {
      request: {
        baseUrl: String(baseUrl || ""),
        proxyUrl: String(options.proxyUrl || defaultProxyUrl),
        forceRefresh: Boolean(options.forceRefresh)
      }
    });
  }

  async function loadCompanyData(baseUrl, companyId, options = {}) {
    const onProgress = typeof options.onProgress === "function" ? options.onProgress : null;
    if (onProgress) {
      catalogProgressListeners.add(onProgress);
    }
    try {
      await catalogProgressReady;
      return await invoke("native_company_data_load", {
        request: {
          baseUrl: String(baseUrl || ""),
          companyId: String(companyId || ""),
          proxyUrl: String(options.proxyUrl || defaultProxyUrl),
          forceRefresh: Boolean(options.forceRefresh)
        }
      });
    } finally {
      if (onProgress) {
        catalogProgressListeners.delete(onProgress);
      }
    }
  }

  async function sendMessage(message) {
    let response;
    for (const listener of [...runtimeListeners]) {
      const value = listener(message);
      if (value !== undefined && response === undefined) {
        response = await value;
      } else if (value && typeof value.then === "function") {
        value.catch(() => {});
      }
    }
    return response;
  }

  async function startDownload(options) {
    const filename = normalizeDesktopFilename(options.filename);
    const id = ++nextDownloadId;
    console.info("[native-download] start requested", {
      id,
      url: options.url,
      filename
    });
    downloads.set(id, {
      id,
      url: options.url,
      filename,
      bytesReceived: 0,
      sessionBytesReceived: 0,
      totalBytes: -1,
      fileSize: 0,
      state: "in_progress",
      error: ""
    });
    try {
      const started = await invoke("native_download_start", {
        request: {
          id,
          url: options.url,
          filename,
          proxyUrl: defaultProxyUrl
        }
      });
      console.info("[native-download] rust accepted", { id, rustId: started.id });
      return Number(started.id);
    } catch (error) {
      console.error("[native-download] start failed", { id, error });
      downloads.delete(id);
      throw error;
    }
  }

  function normalizeDesktopFilename(filename) {
    const value = String(filename || "download").replace(/\\/g, "/");
    if (value.startsWith("/")) {
      return value;
    }
    if (/^Users\//.test(value)) {
      return `/${value}`;
    }
    return value;
  }

  async function cancelDownload(id) {
    console.info("[native-download] cancel requested", { id: Number(id) });
    await invoke("native_download_cancel", { id: Number(id) });
  }

  async function existsLocalFile(filename) {
    const normalized = normalizeDesktopFilename(filename);
    return invoke("native_download_exists", {
      request: {
        filename: normalized
      }
    });
  }

  async function existsLocalFiles(filenames) {
    return invoke("native_download_exists_many", {
      request: {
        filenames: Array.from(filenames || [], normalizeDesktopFilename)
      }
    });
  }

  async function revealLocalPath(path, options = {}) {
    return invoke("native_reveal_path", {
      request: {
        path: normalizeDesktopFilename(path),
        isDirectory: Boolean(options && options.isDirectory)
      }
    });
  }

  async function selectDirectory(initialPath) {
    return invoke("native_select_directory", {
      request: {
        initialPath: String(initialPath || "")
      }
    });
  }

  async function defaultDownloadDirectory() {
    return invoke("native_default_download_directory");
  }

  async function loadPathSelections() {
    return invoke("native_path_selections_load");
  }

  async function updatePathSelection(update) {
    return invoke("native_path_selection_update", {
      request: {
        kind: String(update && update.kind || "file"),
        path: String(update && update.path || ""),
        selected: Boolean(update && update.selected)
      }
    });
  }

  async function cachedFileSizes(paths) {
    return invoke("native_metadata_sizes", {
      request: {
        paths: Array.from(paths || [], (path) => String(path || ""))
      }
    });
  }

  async function cachedMetadataSizes(entries, options = {}) {
    return invoke("native_metadata_sizes", {
      request: {
        paths: [],
        baseUrl: String(options.baseUrl || ""),
        proxyUrl: String(options.proxyUrl || defaultProxyUrl),
        entries: Array.from(entries || [], (entry) => ({
          kind: String(entry && entry.kind || "file"),
          path: String(entry && entry.path || "")
        }))
      }
    });
  }

  async function searchDownloads(query) {
    if (query && query.id != null) {
      const id = Number(query.id);
      await refreshNativeDownload(id);
      const item = downloads.get(id);
      return item ? [clone(item)] : [];
    }
    return [];
  }

  async function refreshNativeDownload(id) {
    try {
      const event = await invoke("native_download_search", { request: { id } });
      if (event) {
        applyDownloadEvent(event, false);
      }
    } catch (error) {
      console.warn("[native-download] search refresh failed", { id, error });
    }
  }

  function emitDownloadChanged(event) {
    console.debug("[native-download] event", event);
    applyDownloadEvent(event, true);
  }

  function applyDownloadEvent(event, notify) {
    const item = downloads.get(Number(event.id));
    if (!item) {
      console.warn("[native-download] event without mapped item", event);
      return;
    }
    const delta = { id: item.id };
    const bytesReceived = event.bytesReceived ?? event.bytes_received;
    const totalBytes = event.totalBytes ?? event.total_bytes;
    const sessionBytesReceived = event.sessionBytesReceived ?? event.session_bytes_received;
    if (bytesReceived != null && bytesReceived !== item.bytesReceived) {
      item.bytesReceived = Number(bytesReceived) || 0;
      delta.bytesReceived = { current: item.bytesReceived };
    }
    if (totalBytes != null && totalBytes !== item.totalBytes) {
      const nextTotalBytes = Number(totalBytes);
      item.totalBytes = Number.isFinite(nextTotalBytes) ? nextTotalBytes : -1;
      item.fileSize = item.totalBytes;
      delta.totalBytes = { current: item.totalBytes };
      delta.fileSize = { current: item.fileSize };
    }
    if (sessionBytesReceived != null && sessionBytesReceived !== item.sessionBytesReceived) {
      item.sessionBytesReceived = Math.max(0, Number(sessionBytesReceived) || 0);
      delta.sessionBytesReceived = { current: item.sessionBytesReceived };
    }
    if (event.state && event.state !== item.state) {
      item.state = event.state;
      delta.state = { current: item.state };
    }
    if (event.error && event.error !== item.error) {
      item.error = event.error;
      delta.error = { current: item.error };
    }
    if (notify && Object.keys(delta).length > 1) {
      for (const listener of downloadChangedListeners) {
        listener(delta);
      }
    }
  }

  listen("native-download-changed", (event) => emitDownloadChanged(event.payload || {}));
  catalogProgressReady = listen("native-catalog-progress", (event) => {
    const progress = event.payload || {};
    for (const listener of catalogProgressListeners) {
      try {
        listener(clone(progress));
      } catch (error) {
        console.error("[native-catalog] progress listener failed", error);
      }
    }
  });

  window.desktop = {
    runtime: {
      onInstalled: { addListener(listener) { window.setTimeout(listener, 0); } },
      onStartup: { addListener() {} },
      onMessage: { addListener(listener) { runtimeListeners.push(listener); } },
      sendMessage,
      getURL(path) {
        return path;
      }
    },
    persistence: {
      load: loadPersistence,
      saveSettings
    },
    catalog: {
      loadCompanies,
      loadCompanyData
    },
    downloads: {
      onChanged: { addListener(listener) { downloadChangedListeners.push(listener); } },
      download: startDownload,
      cancel: cancelDownload,
      existsLocalFile,
      existsLocalFiles,
      search: searchDownloads
    },
    files: {
      reveal: revealLocalPath,
      selectDirectory,
      defaultDownloadDirectory,
      loadPathSelections,
      updatePathSelection,
      cachedSizes: cachedFileSizes,
      cachedMetadataSizes
    }
  };
})();
