(async () => {
  const baseFolderInput = document.querySelector("#base-folder");
  const selectBaseFolderButton = document.querySelector("#select-base-folder");
  const defaultBaseUrl = normalizeBaseUrl("https://worldleaksartrjm3c6vasllvgacbi5u3mgzkluehrzhk2jz4taufuid.onion");
  const companySelect = document.querySelector("#company-select");
  const refreshCompaniesButton = document.querySelector("#refresh-companies");
  const importProgress = document.querySelector("#import-progress");
  const importProgressBar = document.querySelector("#import-progress-bar");
  const delayInput = document.querySelector("#delay");
  const maxConcurrentInput = document.querySelector("#max-concurrent");
  const startButton = document.querySelector("#start");
  const pauseButton = document.querySelector("#pause");
  const cancelButton = document.querySelector("#cancel");
  const retryButton = document.querySelector("#retry");
  const status = document.querySelector("#status");
  const directoryList = document.querySelector("#directories");
  const IMPORT_CHUNK_SIZE = 5000;
  let directoryTree = null;
  let directoryTreeSignature = "";
  let fallbackTreeSignature = "";
  const fallbackExpandedPaths = new Set();
  let directoryRenderSequence = 0;
  let suppressTreeSelectionEvents = false;
  let materialIconMap = await loadMaterialIconMap();
  let useFallbackTree = true;
  let saveOptionsTimer = null;
  let treeContextMenu = null;
  let queueLocksSaveDirectory = false;
  let uiBusy = false;

  const counters = {
    downloading: document.querySelector("#downloading"),
    error: document.querySelector("#error"),
    speed: document.querySelector("#speed")
  };

  const [saved, defaultDownloadDirectory] = await Promise.all([
    desktop.persistence.load().catch(() => ({ queueOptions: null })),
    desktop.files.defaultDownloadDirectory().catch(() => "Downloads")
  ]);
  const savedOptions = saved.queueOptions || {
    baseFolder: defaultDownloadDirectory,
    overwrite: true,
    skipExisting: true,
    delayMs: 750,
    maxConcurrent: 3,
    baseUrl: defaultBaseUrl
  };

  const savedCompanyId = companyIdFromBaseUrl(savedOptions.baseUrl);
  let currentDownloadBaseUrl = savedCompanyId
    ? companyFilesBaseUrl(defaultBaseUrl, savedCompanyId)
    : defaultBaseUrl;
  baseFolderInput.value = normalizeSaveDirectory(savedOptions.baseFolder) || defaultDownloadDirectory;
  baseFolderInput.title = baseFolderInput.value;
  delayInput.value = savedOptions.delayMs;
  maxConcurrentInput.value = savedOptions.maxConcurrent || 3;

  startButton.addEventListener("click", () => sendQueueCommand("queue:start"));
  pauseButton.addEventListener("click", () => sendQueueCommand("queue:pause"));
  cancelButton.addEventListener("click", () => sendQueueCommand("queue:cancel-downloads"));
  retryButton.addEventListener("click", () => sendQueueCommand("queue:retry-failed"));
  document.addEventListener("click", () => {
    closeTreeContextMenu();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeTreeContextMenu();
    }
  });

  companySelect.addEventListener("change", () => {
    if (companySelect.value) {
      importCompany(companySelect.value, false).catch((error) => setCatalogError(error));
    }
  });
  refreshCompaniesButton.addEventListener("click", () => {
    loadCompanyList(true, true).catch((error) => setCatalogError(error));
  });
  selectBaseFolderButton.addEventListener("click", selectBaseFolder);
  baseFolderInput.addEventListener("change", () => scheduleSaveOptions({ forceTreeReload: true }));
  baseFolderInput.addEventListener("input", () => scheduleSaveOptions({ forceTreeReload: true }));
  for (const input of [delayInput, maxConcurrentInput]) {
    input.addEventListener("change", scheduleSaveOptions);
    input.addEventListener("input", scheduleSaveOptions);
  }

  desktop.runtime.onMessage.addListener((message) => {
    if (message && message.type === "queue:state-changed") {
      Promise.resolve(message.state).then(renderState);
    } else if (message && message.type === "queue:nodes-updated") {
      applyNodeUpdates(message.updates || []);
    }
  });

  await desktop.persistence.saveSettings(readOptions());
  renderState(await desktop.runtime.sendMessage({ type: "queue:update-options", options: readOptions() }));
  await loadCompanyList(false, true).catch((error) => setCatalogError(error));

  async function loadCompanyList(forceRefresh, autoImport) {
    const baseUrl = defaultBaseUrl;
    const selectedId = companySelect.value || companyIdFromBaseUrl(currentDownloadBaseUrl);
    companySelect.disabled = true;
    refreshCompaniesButton.disabled = true;
    setStatus(forceRefresh ? "正在刷新公司列表..." : "正在加载公司列表...");
    try {
      const companies = await desktop.catalog.loadCompanies(baseUrl, { forceRefresh });
      companySelect.replaceChildren();
      const placeholder = document.createElement("option");
      placeholder.value = "";
      placeholder.textContent = companies.length ? "请选择公司" : "没有可用公司";
      companySelect.append(placeholder);
      for (const company of companies.sort((left, right) => String(left.title).localeCompare(String(right.title)))) {
        const option = document.createElement("option");
        option.value = String(company.id || "");
        option.textContent = company.country
          ? `${company.title || company.id} (${String(company.country).toUpperCase()})`
          : (company.title || company.id);
        companySelect.append(option);
      }
      if (selectedId && companies.some((company) => String(company.id) === selectedId)) {
        companySelect.value = selectedId;
      }
      if (autoImport && companySelect.value) {
        await importCompany(companySelect.value, forceRefresh);
      } else {
        setStatus(`已加载 ${companies.length} 家公司。`, false, true);
      }
    } finally {
      companySelect.disabled = false;
      refreshCompaniesButton.disabled = false;
    }
  }

  async function importCompany(companyId, forceRefresh) {
    setBusy(true);
    setImportProgress(null);
    setStatus("正在获取公司目录和 Path，请稍候...");
    try {
      const sourceBaseUrl = defaultBaseUrl;
      const data = await desktop.catalog.loadCompanyData(sourceBaseUrl, companyId, {
        forceRefresh,
        onProgress(progress) {
          if (String(progress.companyId || "") !== String(companyId)) {
            return;
          }
          const received = Math.max(0, Number(progress.receivedBytes) || 0);
          const total = Math.max(0, Number(progress.totalBytes) || 0);
          setImportProgress(total > 0 ? (received / total) * 100 : null);
          setStatus(total > 0
            ? `正在下载 Path：${formatBytes(received)} / ${formatBytes(total)}`
            : `正在下载 Path：${formatBytes(received)}`);
        }
      });
      currentDownloadBaseUrl = companyFilesBaseUrl(sourceBaseUrl, companyId);
      const importOptions = readOptions();
      await desktop.persistence.saveSettings(importOptions);
      await desktop.runtime.sendMessage({ type: "queue:replace-path-list", options: importOptions });
      await desktop.runtime.sendMessage({
        type: "queue:set-catalog-directory-sizes",
        directories: Array.from(data.dirs && data.dirs.dirs || [], (directory) => ({
          path: directory.name,
          size: directory.size
        }))
      });
      resetDirectoryTreeState();

      let added = 0;
      let totalPaths = 0;
      let lastState = null;
      let pendingItems = [];
      for await (const entry of readPathTextEntries(data.listing || "")) {
        totalPaths += 1;
        const queueItem = pathToQueueItem(entry, currentDownloadBaseUrl);
        if (queueItem) {
          pendingItems.push(queueItem);
        }
        if (pendingItems.length >= IMPORT_CHUNK_SIZE) {
          const response = await addImportChunk(pendingItems, importOptions, true);
          pendingItems = [];
          added += response.added || 0;
          await yieldToUi();
        }
      }
      if (pendingItems.length) {
        const response = await addImportChunk(pendingItems, importOptions, false);
        added += response.added || 0;
        lastState = response.state || null;
      }
      if (!totalPaths) {
        throw new Error("该公司的 listing 中没有可导入的 Path。");
      }
      renderState(lastState || await desktop.runtime.sendMessage({ type: "queue:get-state" }));
      setImportProgress(100);
      const totalSize = Number(data.dirs && data.dirs.total_size) || 0;
      setStatus(`已加载 ${totalPaths} 条 Path${totalSize ? `，总大小 ${formatBytes(totalSize)}` : ""}。`, false, true);
    } finally {
      hideImportProgress();
      setBusy(false);
    }
  }

  async function sendQueueCommand(type) {
    setBusy(true);
    try {
      await saveOptions();
      const nextState = await desktop.runtime.sendMessage({ type, options: readOptions() });
      renderState(nextState);
      setStatus(statusTextForCommand(type), false, !["queue:pause", "queue:cancel-downloads"].includes(type));
    } catch (error) {
      setStatus(error.message || String(error), true);
    } finally {
      setBusy(false);
    }
  }

  async function saveOptions(options = {}) {
    clearTimeout(saveOptionsTimer);
    const forceTreeReload = Boolean(options.forceTreeReload);
    const queueOptions = readOptions();
    if (forceTreeReload) {
      resetDirectoryTreeState();
    }
    await desktop.persistence.saveSettings(queueOptions);
    const nextState = await desktop.runtime.sendMessage({ type: "queue:update-options", options: queueOptions });
    await renderState(nextState);
    if (forceTreeReload) {
      const latestState = await desktop.runtime.sendMessage({ type: "queue:get-state" });
      resetDirectoryTreeState();
      await renderDirectoryTree(latestState);
    }
  }

  async function selectBaseFolder() {
    if (queueLocksSaveDirectory || uiBusy) {
      return;
    }
    selectBaseFolderButton.disabled = true;
    try {
      const selected = await desktop.files.selectDirectory(baseFolderInput.value);
      if (!selected) {
        return;
      }
      baseFolderInput.value = selected;
      baseFolderInput.title = selected;
      resetDirectoryTreeState();
      if (companySelect.value) {
        await importCompany(companySelect.value, false);
      } else {
        await saveOptions({ forceTreeReload: true });
      }
    } catch (error) {
      setStatus(error.message || String(error), true);
    } finally {
      updateSaveDirectoryAvailability();
    }
  }

  function scheduleSaveOptions(options = {}) {
    clearTimeout(saveOptionsTimer);
    saveOptionsTimer = window.setTimeout(() => {
      saveOptions(options).catch((error) => {
        setStatus(error.message || String(error), true);
      });
    }, 180);
  }

  function readOptions() {
    return {
      baseFolder: normalizeSaveDirectory(baseFolderInput.value) || "queued-downloads",
      overwrite: true,
      skipExisting: true,
      delayMs: clampNumber(delayInput.value, 0, 60000, 750),
      maxConcurrent: clampNumber(maxConcurrentInput.value, 1, 100, 3),
      baseUrl: currentDownloadBaseUrl
    };
  }

  function renderState(nextState) {
    if (!nextState) {
      return Promise.resolve();
    }

    queueLocksSaveDirectory = Boolean(nextState.running) || Number(nextState.counts && nextState.counts.downloading) > 0;
    updateSaveDirectoryAvailability();
    renderCounters(nextState);
    if (nextState.notice) {
      setStatus(nextState.notice, true);
    }

    if (nextState.selectionOnly) {
      applyNodeUpdates(nextState.nodeUpdates || []);
      return Promise.resolve();
    }

    if (nextState.exclusionOnly) {
      applyNodeUpdates(nextState.exclusionUpdates || nextState.nodeUpdates || []);
      return Promise.resolve();
    }

    return renderDirectoryTree(nextState).catch((error) => {
      setStatus(`Directory tree failed: ${error.message || error}`, true);
    });
  }

  function renderCounters(nextState) {
    const counts = nextState.counts || {};
    counters.downloading.textContent = `下载中 ${counts.downloading || 0}`;
    counters.error.textContent = `失败 ${counts.error || 0}`;
    counters.speed.textContent = formatRate(nextState.downloadSpeedBps || 0);

    startButton.disabled = Boolean(nextState.running) || !pendingCount(counts);
    pauseButton.disabled = !nextState.running;
    cancelButton.disabled = !(counts.downloading || nextState.running);
    retryButton.disabled = !(counts.error || 0);
  }

  function applyNodeUpdates(updates) {
    if (!Array.isArray(updates) || !updates.length) {
      return;
    }

    for (const update of updates) {
      if (!update || !update.path) {
        continue;
      }
      const node = toWunderbaumNode(update);
      if (useFallbackTree) {
        updateFallbackNode(node);
      } else {
        updateWunderbaumNode(node);
      }
    }
  }

  function updateFallbackNode(node) {
    const wrapper = findFallbackWrapper(node.path || "");
    if (!wrapper) {
      return;
    }

    wrapper.__treeNode = { ...(wrapper.__treeNode || {}), ...node };
    wrapper.classList.toggle("excluded", node.excluded === true);
    wrapper.classList.toggle("direct-excluded", node.directExcluded === true);
    const row = wrapper.querySelector(":scope > .fallback-row");
    if (!row) {
      return;
    }
    row.classList.toggle("excluded", node.excluded === true);

    setFallbackWrapperSelection(wrapper, node.selection || "all");

    const icon = row.querySelector(":scope > .fallback-icon");
    if (icon) {
      icon.style.backgroundImage = `url("${node.icon}")`;
    }

    const title = row.querySelector(":scope > .fallback-title");
    if (title) {
      title.textContent = node.title || node.name || "";
      appendTitleCopyLink(title, node);
    }
    renderCountCell(row.querySelector(":scope > .fallback-count"), node);
    renderSizeCell(row.querySelector(":scope > .fallback-size"), node);

    row
      .querySelectorAll(":scope > .tree-copy-link, :scope > .tree-progress-ring")
      .forEach((element) => element.remove());
    appendFallbackNodeAccessories(row, node);
  }

  function updateWunderbaumNode(node) {
    if (!directoryTree || !directoryTree.findKey) {
      return;
    }

    const treeNode = directoryTree.findKey(treeKeyForNode(node));
    if (!treeNode) {
      return;
    }

    Object.assign(treeNode.data, node);
    if (treeNode.setTitle) {
      treeNode.setTitle(node.title);
    }
    if (treeNode.setSelected) {
      treeNode.setSelected(node.selection === "all");
    }
    if (treeNode.render) {
      treeNode.render();
    }
  }

  async function renderDirectoryTree(nextState) {
    let directories = nextState.directories || [];
    const totalCount = Number(nextState.counts && nextState.counts.total) || 0;
    const visibleCount = totalCount;
    if (visibleCount > 0) {
      try {
        const response = await desktop.runtime.sendMessage({
          type: "queue:get-tree-children",
          path: ""
        });
        directories = response.children || [];
      } catch (error) {
        setStatus(`Directory root request failed: ${error.message || error}`, true);
      }
    }

    if (!directories.length && visibleCount > 0) {
      setStatus(`Directory tree is empty: ${visibleCount} visible items, 0 root nodes.`, true);
      return;
    }
    const data = directories.map(toWunderbaumNode);
    if (useFallbackTree) {
      await renderFallbackTree(data);
      return;
    }
    const signature = treeRenderSignature(data);
    if (directoryTree && signature === directoryTreeSignature) {
      return;
    }

    const scrollTop = getDirectoryTreeScrollTop();
    const renderSequence = ++directoryRenderSequence;
    suppressTreeSelectionEvents = true;
    if (directoryTree) {
      const previousTreeState = directoryTree.getState({ expandedKeys: true });
      try {
        await directoryTree.reload({ source: data });
        directoryTreeSignature = signature;
        if (directoryTree.count() === 0 && data.length) {
          await directoryTree.load(data);
        }
        if (previousTreeState.expandedKeys && previousTreeState.expandedKeys.length) {
          await directoryTree.setState(
            { expandedKeys: previousTreeState.expandedKeys },
            { expandLazy: true }
          );
        } else {
          await directoryTree.expandAll(false, { ignoreMinExpandLevel: true });
        }
      } finally {
        if (renderSequence === directoryRenderSequence) {
          restoreDirectoryTreeScrollTop(scrollTop);
          suppressTreeSelectionEvents = false;
        }
      }
    } else {
      directoryTree = new window.mar10.Wunderbaum({
        id: "download-directory-tree",
        element: directoryList,
        source: data,
        header: false,
        columns: [
          { id: "*", title: "名称", width: "*" },
          { id: "count", title: "下载数量/总数量", width: "130px", classes: "tree-count-column" },
          { id: "size", title: "大小", width: "180px", classes: "tree-size-column" }
        ],
        checkbox: true,
        selectMode: "hier",
        minExpandLevel: 0,
        iconMap: {
          ...window.mar10.Wunderbaum.iconMaps.bootstrap,
          checkChecked: "download-checkbox download-checkbox-checked",
          checkUnchecked: "download-checkbox download-checkbox-unchecked",
          checkUnknown: "download-checkbox download-checkbox-partial"
        },
        quicksearch: true,
        showSpinner: true,
        sortFoldersFirst: true,
        strings: {
          noData: visibleCount > 0 ? "Directory data is rebuilding..." : "No matching paths."
        },
        types: {
          notice: { icon: false, checkbox: false, unselectable: true }
        },
        init: async () => {
          try {
            directoryTreeSignature = signature;
            if (directoryTree && directoryTree.count() === 0 && data.length) {
              await directoryTree.load(data);
            }
            if (directoryTree) {
              await directoryTree.expandAll(false, { ignoreMinExpandLevel: true });
            }
          } finally {
            if (renderSequence === directoryRenderSequence) {
              restoreDirectoryTreeScrollTop(scrollTop);
              suppressTreeSelectionEvents = false;
            }
          }
        },
        lazyLoad: async (event) => {
          const sourceNode = event.node && event.node.data;
          if (!sourceNode || sourceNode.kind !== "directory") {
            return [];
          }
          const response = await desktop.runtime.sendMessage({
            type: "queue:get-tree-children",
            path: sourceNode.path || ""
          });
          return (response.children || []).map(toWunderbaumNode);
        },
        render: decorateTreeNode,
        select: async (event) => {
          if (suppressTreeSelectionEvents) {
            return;
          }
          const sourceNode = event.node && event.node.data;
          if (!sourceNode || sourceNode.readonly) {
            return;
          }
          await updateSelection(sourceNode, event.node.isSelected());
        }
      });
      if (directoryTree.ready) {
        await directoryTree.ready;
      }
    }

    if (data.length && directoryTree && directoryTree.count() === 0) {
      throw new Error("Wunderbaum accepted data but rendered 0 nodes.");
    }
  }

  async function renderFallbackTree(nodes) {
    const signature = treeRenderSignature(nodes);
    if (signature === fallbackTreeSignature && directoryList.querySelector(".fallback-tree")) {
      return;
    }

    const expandedPaths = collectFallbackExpandedPaths();
    for (const path of expandedPaths) {
      fallbackExpandedPaths.add(path);
    }
    const scrollTop = getDirectoryTreeScrollTop();
    const renderSequence = ++directoryRenderSequence;

    directoryList.classList.remove("wunderbaum");
    directoryList.textContent = "";
    const root = document.createElement("div");
    root.className = "fallback-tree";
    for (const node of nodes) {
      root.append(createFallbackRow(node, 0));
    }
    directoryList.append(root);
    fallbackTreeSignature = signature;
    await restoreFallbackExpandedPaths(renderSequence);
    if (renderSequence === directoryRenderSequence) {
      restoreDirectoryTreeScrollTop(scrollTop);
    }
  }

  function treeRenderSignature(nodes) {
    return JSON.stringify((nodes || []).map(treeRenderSignatureNode));
  }

  function treeRenderSignatureNode(node) {
    return {
      key: node.key || treeKeyForNode(node),
      kind: node.kind || "",
      path: node.path || "",
      count: Number(node.count) || 0,
      completedCount: Number(node.completedCount) || 0,
      queuedCount: Number(node.queuedCount) || 0,
      downloadingCount: Number(node.downloadingCount) || 0,
      status: node.status || "",
      bytesReceived: Number(node.bytesReceived) || 0,
      totalBytes: Number(node.totalBytes) || -1,
      sizeBytes: node.sizeBytes === null || node.sizeBytes === undefined ? null : Number(node.sizeBytes),
      sizeLoading: node.sizeLoading === true,
      localPath: node.localPath || "",
      selection: node.selection || "",
      excluded: node.excluded === true,
      directExcluded: node.directExcluded === true,
      hasChildren: node.hasChildren !== false,
      lazy: node.lazy === true,
      children: (node.children || []).map(treeRenderSignatureNode)
    };
  }

  function resetDirectoryTreeState() {
    fallbackTreeSignature = "";
    directoryTreeSignature = "";
    fallbackExpandedPaths.clear();
  }

  function createFallbackRow(node, level) {
    const wrapper = document.createElement("div");
    wrapper.className = "fallback-node";
    wrapper.classList.toggle("excluded", node.excluded === true);
    wrapper.classList.toggle("direct-excluded", node.directExcluded === true);
    wrapper.dataset.path = node.path || "";
    wrapper.dataset.kind = node.kind || "";
    wrapper.__treeNode = node;
    wrapper.__treeLevel = level;

    const row = document.createElement("div");
    row.className = "fallback-row";
    row.classList.toggle("excluded", node.excluded === true);
    row.style.setProperty("--level", String(level));

    const expander = document.createElement("button");
    expander.type = "button";
    expander.className = "fallback-expander";
    expander.setAttribute("aria-label", "Toggle folder");
    expander.disabled = node.kind !== "directory";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = node.selected === true;
    checkbox.indeterminate = node.selection === "partial";
    checkbox.addEventListener("click", (event) => event.stopPropagation());
    checkbox.addEventListener("change", async () => {
      await updateSelection(node, checkbox.checked, wrapper);
    });

    const icon = document.createElement("span");
    icon.className = "fallback-icon";
    icon.style.backgroundImage = `url("${node.icon}")`;

    const title = document.createElement("span");
    title.className = "fallback-title";
    title.textContent = node.title || node.name || "";
    appendTitleCopyLink(title, node);

    const size = document.createElement("span");
    size.className = "fallback-size tree-size-column";
    renderSizeCell(size, node);

    const count = document.createElement("span");
    count.className = "fallback-count tree-count-column";
    renderCountCell(count, node);

    row.append(expander, checkbox, icon, title, count, size);
    appendFallbackNodeAccessories(row, node);
    row.addEventListener("contextmenu", (event) => showTreeContextMenu(event, node));
    if (node.kind === "directory") {
      row.addEventListener("click", () => toggleFallbackDirectory(wrapper, node, level, expander));
    }

    wrapper.append(row);
    return wrapper;
  }

  function appendFallbackNodeAccessories(row, node) {
    if (node.kind === "directory") {
      row.append(createProgressRing(
        directoryProgress(node),
        node.completedCount >= node.count && node.count > 0,
        {
          loading: node.downloadingCount > 0,
          label: node.downloadingCount > 0 ? `${node.downloadingCount} downloading in this folder` : ""
        }
      ));
      return;
    }

    row.append(createProgressRing(
      fileProgress(node),
      node.status === "done",
      {
        loading: node.status === "downloading",
        label: fileStatusLabel(node)
      }
    ));
  }

  async function toggleFallbackDirectory(wrapper, node, level, expander) {
    if (wrapper.classList.contains("expanded")) {
      wrapper.classList.remove("expanded");
      wrapper.querySelector(".fallback-children")?.remove();
      fallbackExpandedPaths.delete(node.path || "");
      return;
    }

    wrapper.classList.add("expanded");
    fallbackExpandedPaths.add(node.path || "");
    expander.classList.add("loading");
    try {
      wrapper.querySelector(".fallback-children")?.remove();
      const response = await desktop.runtime.sendMessage({
        type: "queue:get-tree-children",
        path: node.path || ""
      });
      const children = (response.children || []).map(toWunderbaumNode);
      const childWrap = document.createElement("div");
      childWrap.className = "fallback-children";
      for (const child of children) {
        childWrap.append(createFallbackRow(child, level + 1));
      }
      wrapper.append(childWrap);
    } finally {
      expander.classList.remove("loading");
    }
  }

  function collectFallbackExpandedPaths() {
    return Array.from(directoryList.querySelectorAll(".fallback-node.expanded"))
      .map((node) => node.dataset.path || "")
      .filter(Boolean);
  }

  async function restoreFallbackExpandedPaths(renderSequence) {
    const paths = Array.from(fallbackExpandedPaths)
      .filter(Boolean)
      .sort((a, b) => a.split("/").length - b.split("/").length);
    for (const path of paths) {
      if (renderSequence !== directoryRenderSequence) {
        return;
      }
      const wrapper = findFallbackWrapper(path);
      if (!wrapper || wrapper.classList.contains("expanded")) {
        continue;
      }
      const row = wrapper.querySelector(":scope > .fallback-row");
      const expander = row && row.querySelector(".fallback-expander");
      if (wrapper.__treeNode && expander) {
        await toggleFallbackDirectory(wrapper, wrapper.__treeNode, wrapper.__treeLevel || 0, expander);
      }
    }
  }

  function findFallbackWrapper(path) {
    return Array.from(directoryList.querySelectorAll(".fallback-node"))
      .find((node) => (node.dataset.path || "") === path) || null;
  }

  function getDirectoryTreeScrollTop() {
    const element = getDirectoryTreeScrollElement();
    return element ? element.scrollTop : 0;
  }

  function restoreDirectoryTreeScrollTop(scrollTop) {
    if (!Number.isFinite(scrollTop) || scrollTop <= 0) {
      return;
    }
    setDirectoryTreeScrollTop(scrollTop);
    requestAnimationFrame(() => {
      setDirectoryTreeScrollTop(scrollTop);
      requestAnimationFrame(() => {
        setDirectoryTreeScrollTop(scrollTop);
      });
    });
  }

  function setDirectoryTreeScrollTop(scrollTop) {
    const element = getDirectoryTreeScrollElement();
    if (element) {
      element.scrollTop = scrollTop;
    }
  }

  function getDirectoryTreeScrollElement() {
    const candidates = [
      directoryList.querySelector(".wb-list-container"),
      directoryTree && directoryTree.element,
      directoryList
    ].filter(Boolean);
    return (
      candidates.find((element) => element.scrollTop > 0) ||
      candidates.find((element) => element.scrollHeight > element.clientHeight + 1) ||
      candidates[0] ||
      null
    );
  }

  async function updateSelection(node, selected, wrapper = null) {
    try {
      const response = await desktop.runtime.sendMessage({
        type: "queue:set-selection",
        target: {
          kind: node.kind,
          id: node.id,
          path: node.path
        },
        selected
      });
      updateVisibleSelection(node, selected, wrapper, response && response.selectionUpdates);
      setStatus(selected ? "已选中。" : "已取消选择。", false, true);
    } catch (error) {
      setStatus(error.message || String(error), true);
    }
  }

  function updateVisibleSelection(node, selected, wrapper, selectionUpdates = []) {
    if (!useFallbackTree) {
      updateVisibleWunderbaumSelection(node, selected, selectionUpdates);
      return;
    }

    const targetWrapper = wrapper || findFallbackWrapper(node.path || "");
    if (!targetWrapper) {
      return;
    }

    setFallbackWrapperSelection(targetWrapper, selected ? "all" : "none");

    if (node.kind === "directory") {
      for (const descendant of visibleFallbackDescendants(node.path || "")) {
        setFallbackWrapperSelection(descendant, selected ? "all" : "none");
      }
    }

    for (const update of selectionUpdates || []) {
      if (!update || update.path === (node.path || "")) {
        continue;
      }
      const updateWrapper = findFallbackWrapper(update.path || "");
      if (updateWrapper) {
        setFallbackWrapperSelection(updateWrapper, update.selection || "all");
      }
    }

    if (!selectionUpdates || !selectionUpdates.length) {
      for (const ancestor of visibleFallbackAncestors(node.path || "")) {
        setFallbackWrapperSelection(ancestor, visibleChildrenSelectionState(ancestor));
      }
    }
  }

  async function updateExclusion(node, excluded, wrapper = null) {
    try {
      const response = await desktop.runtime.sendMessage({
        type: "queue:set-exclusion",
        target: {
          kind: node.kind,
          id: node.id,
          path: node.path
        },
        excluded
      });
      updateVisibleExclusion(node, excluded, wrapper, response && response.exclusionUpdates);
      setStatus(excluded ? "已排除。" : "已取消排除。", false, true);
    } catch (error) {
      setStatus(error.message || String(error), true);
    }
  }

  function updateVisibleExclusion(node, excluded, wrapper, exclusionUpdates = []) {
    if (!useFallbackTree) {
      updateVisibleWunderbaumExclusion(node, excluded, exclusionUpdates);
      return;
    }

    const targetWrapper = wrapper || findFallbackWrapper(node.path || "");
    if (targetWrapper) {
      setFallbackWrapperExclusion(targetWrapper, excluded, excluded);
    }

    for (const update of exclusionUpdates || []) {
      const updateWrapper = findFallbackWrapper(update.path || "");
      if (updateWrapper) {
        setFallbackWrapperExclusion(updateWrapper, update.excluded === true, update.directExcluded === true);
      }
    }
  }

  function updateVisibleWunderbaumExclusion(node, excluded, exclusionUpdates = []) {
    if (!directoryTree || !node) {
      return;
    }
    const treeNode = directoryTree.findKey && directoryTree.findKey(treeKeyForNode(node));
    if (treeNode) {
      setWunderbaumNodeExclusion(treeNode, excluded, excluded);
    }

    for (const update of exclusionUpdates || []) {
      const updateNode = directoryTree.findKey && directoryTree.findKey(treeKeyForNode(update));
      if (updateNode) {
        setWunderbaumNodeExclusion(updateNode, update.excluded === true, update.directExcluded === true);
      }
    }
  }

  function setWunderbaumNodeExclusion(treeNode, excluded, directExcluded) {
    if (treeNode.data) {
      treeNode.data.excluded = excluded === true;
      treeNode.data.directExcluded = directExcluded === true;
    }
    if (treeNode.render) {
      treeNode.render();
    }
  }

  function updateVisibleWunderbaumSelection(node, selected, selectionUpdates = []) {
    if (!directoryTree || !node) {
      return;
    }
    const treeNode = directoryTree.findKey && directoryTree.findKey(treeKeyForNode(node));
    if (treeNode && treeNode.setSelected) {
      treeNode.setSelected(selected);
    }

    for (const update of selectionUpdates || []) {
      const updateNode = directoryTree.findKey && directoryTree.findKey(treeKeyForNode(update));
      if (updateNode && updateNode.setSelected) {
        updateNode.setSelected(update.selection === "all");
      }
    }
  }

  function setFallbackWrapperSelection(wrapper, selection) {
    const node = wrapper.__treeNode;
    if (node) {
      node.selection = selection;
      node.selected = selection === "all";
    }

    const checkbox = wrapper.querySelector(":scope > .fallback-row input[type='checkbox']");
    if (!checkbox) {
      return;
    }
    checkbox.indeterminate = selection === "partial";
    checkbox.checked = selection === "all";
  }

  function visibleFallbackDescendants(path) {
    const prefix = path ? `${path}/` : "";
    return Array.from(directoryList.querySelectorAll(".fallback-node"))
      .filter((candidate) => {
        const candidatePath = candidate.dataset.path || "";
        return candidatePath && candidatePath.startsWith(prefix) && candidatePath !== path;
      });
  }

  function visibleFallbackAncestors(path) {
    const parts = String(path || "").split("/").filter(Boolean);
    const ancestors = [];
    for (let index = parts.length - 1; index >= 1; index -= 1) {
      const ancestor = findFallbackWrapper(parts.slice(0, index).join("/"));
      if (ancestor) {
        ancestors.push(ancestor);
      }
    }
    return ancestors;
  }

  function visibleChildrenSelectionState(wrapper) {
    const childRows = Array.from(wrapper.querySelectorAll(":scope > .fallback-children > .fallback-node"));
    if (!childRows.length) {
      return wrapper.__treeNode && wrapper.__treeNode.selection ? wrapper.__treeNode.selection : "all";
    }

    const states = childRows.map((child) => child.__treeNode && child.__treeNode.selection ? child.__treeNode.selection : "all");
    if (states.every((state) => state === "all")) {
      return "all";
    }
    if (states.every((state) => state === "none")) {
      return "none";
    }
    return "partial";
  }

  function toWunderbaumNode(node) {
    const iconName = iconNameForTreeNode(node);
    const result = {
      key: treeKeyForNode(node),
      title: treeTextForNode(node),
      type: treeTypeForNode(node),
      expanded: false,
      icon: materialIconUrl(iconName),
      checkbox: true,
      selected: node.selection === "all",
      kind: node.kind,
      id: node.id,
      path: node.path,
      url: node.url || "",
      status: node.status || "",
      count: node.count || 0,
      completedCount: node.completedCount || 0,
      queuedCount: node.queuedCount || 0,
      downloadingCount: node.downloadingCount || 0,
      bytesReceived: node.bytesReceived || 0,
      totalBytes: node.totalBytes || -1,
      sizeBytes: node.sizeBytes,
      sizeLoading: node.sizeLoading === true,
      localPath: node.localPath || "",
      selection: node.selection,
      excluded: node.excluded === true,
      directExcluded: node.directExcluded === true
    };
    const children = (node.children || []).map(toWunderbaumNode);
    if (children.length) {
      result.children = children;
    } else if (node.kind === "directory" && node.hasChildren !== false) {
      result.lazy = true;
    }
    return result;
  }

  function decorateTreeNode(event) {
    const node = event.node;
    const data = node && node.data;
    const title = event.nodeElem && event.nodeElem.querySelector(".wb-title");
    if (!data || !title) {
      return;
    }

    title.classList.add("tree-title-content");
    if (event.nodeElem) {
      event.nodeElem.classList.toggle("tree-node-excluded", data.excluded === true);
      event.nodeElem.oncontextmenu = (contextEvent) => showTreeContextMenu(contextEvent, data);
    }
    title.classList.toggle("tree-node-title-excluded", data.excluded === true);
    title
      .querySelectorAll(".tree-copy-link, .tree-progress-ring")
      .forEach((element) => element.remove());
    renderCountCell(event.renderColInfosById && event.renderColInfosById.count
      ? event.renderColInfosById.count.elem
      : null, data);
    renderSizeCell(event.renderColInfosById && event.renderColInfosById.size
      ? event.renderColInfosById.size.elem
      : null, data);

    if (data.kind === "directory") {
      title.append(createProgressRing(
        directoryProgress(data),
        data.completedCount >= data.count && data.count > 0,
        {
          loading: data.downloadingCount > 0,
          label: data.downloadingCount > 0 ? `${data.downloadingCount} downloading in this folder` : ""
        }
      ));
      return;
    }

    if (data.url) {
      title.append(createCopyButton(data.url));
    }

  }

  function appendTitleCopyLink(title, node) {
    if (!title || !node || !node.url) {
      return;
    }
    title.append(createCopyButton(node.url));
  }

  function createCopyButton(url) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "tree-copy-link";
    button.title = "Copy link";
    button.setAttribute("aria-label", "Copy link");
    button.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      try {
        await copyText(url);
        setStatus("Link copied.", false, true);
      } catch (error) {
        setStatus(error.message || "Copy failed.", true);
      }
    });
    return button;
  }

  function createProgressRing(progress, complete, options = {}) {
    const ring = document.createElement("span");
    const percent = Math.max(0, Math.min(100, Math.round(progress)));
    ring.className = `tree-progress-ring${complete ? " complete" : ""}${options.loading ? " loading" : ""}`;
    ring.style.setProperty("--progress", `${percent}%`);
    ring.title = options.label ? `${options.label}, ${percent}%` : `${percent}%`;
    ring.setAttribute("aria-label", ring.title);
    return ring;
  }

  function createSizeLoadingIcon() {
    const icon = document.createElement("span");
    icon.className = "tree-size-loading";
    icon.title = "正在获取远程大小";
    icon.setAttribute("aria-label", icon.title);
    return icon;
  }

  function renderSizeCell(cell, node) {
    if (!cell) {
      return;
    }
    cell.replaceChildren();
    if (node && node.sizeLoading) {
      cell.append(createSizeLoadingIcon());
      return;
    }
    const label = sizeLabelForNode(node);
    cell.textContent = label;
    cell.title = label;
  }

  function renderCountCell(cell, node) {
    if (!cell) {
      return;
    }
    const completed = Math.max(0, Number(node && node.completedCount) || 0);
    const total = Math.max(0, Number(node && node.count) || 0);
    cell.textContent = `${completed}/${total}`;
    cell.title = `已下载 ${completed} / 总数 ${total}`;
  }

  function directoryProgress(node) {
    const total = Number(node.sizeBytes) || 0;
    if (!total) {
      return 0;
    }
    return (Math.max(0, Number(node.bytesReceived) || 0) / total) * 100;
  }

  function fileProgress(node) {
    if (node.status === "done") {
      return 100;
    }
    const metadataTotal = Number(node.sizeBytes);
    const total = node.sizeBytes !== null && node.sizeBytes !== undefined && Number.isFinite(metadataTotal)
      ? metadataTotal
      : Number(node.totalBytes) || 0;
    if (total <= 0) {
      return 0;
    }
    return ((Number(node.bytesReceived) || 0) / total) * 100;
  }

  function fileStatusLabel(node) {
    if (!node || !node.status) {
      return "";
    }
    if (node.status === "done") {
      return "已下载";
    }
    if (node.status === "downloading") {
      return "下载中";
    }
    if (node.status === "error") {
      return "下载失败";
    }
    return "等待下载";
  }

  function formatBytes(value) {
    const bytes = Math.max(0, Number(value) || 0);
    if (bytes >= 1000 * 1000 * 1000 * 1000) {
      return `${(bytes / (1000 * 1000 * 1000 * 1000)).toFixed(1)} TB`;
    }
    if (bytes >= 1000 * 1000 * 1000) {
      return `${(bytes / (1000 * 1000 * 1000)).toFixed(1)} GB`;
    }
    if (bytes >= 1000 * 1000) {
      return `${(bytes / (1000 * 1000)).toFixed(1)} MB`;
    }
    if (bytes >= 1000) {
      return `${(bytes / 1000).toFixed(1)} KB`;
    }
    return `${bytes} B`;
  }

  async function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }

    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.append(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    textarea.remove();
    if (!copied) {
      throw new Error("Copy failed.");
    }
  }

  function treeKeyForNode(node) {
    if (node.kind === "file") {
      return `file:${node.id}`;
    }
    return `dir:${node.path || "/"}`;
  }

  function treeTextForNode(node) {
    return node.name || node.path || "(根目录)";
  }

  function sizeLabelForNode(node) {
    const size = Number(node && node.sizeBytes);
    if (node && node.sizeBytes !== null && node.sizeBytes !== undefined && Number.isFinite(size) && size >= 0) {
      const complete = node.kind === "file"
        ? node.status === "done"
        : Number(node.count) > 0 && Number(node.completedCount) >= Number(node.count);
      if (complete) {
        return formatBytes(size);
      }
      const received = Math.min(size, Math.max(0, Number(node.bytesReceived) || 0));
      return `${formatBytes(received)} / ${formatBytes(size)}`;
    }
    return "";
  }

  function showTreeContextMenu(event, node) {
    if (!node) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    closeTreeContextMenu();

    const menu = document.createElement("div");
    menu.className = "tree-context-menu";
    menu.setAttribute("role", "menu");

    const buttons = [];
    const createButton = (label, handler, options = {}) => {
      const button = document.createElement("button");
      button.type = "button";
      button.setAttribute("role", "menuitem");
      button.textContent = label;
      if (options.className) {
        button.className = options.className;
      }
      if (options.disabled) {
        button.disabled = true;
      }
      button.addEventListener("click", async (clickEvent) => {
        clickEvent.stopPropagation();
        if (button.disabled) {
          return;
        }
        closeTreeContextMenu();
        try {
          await handler();
        } catch (error) {
          setStatus(error.message || String(error), true);
        }
      });
      menu.append(button);
      buttons.push(button);
      return button;
    };

    if (node.localPath && desktop.files && typeof desktop.files.reveal === "function") {
      createButton("在文件浏览器中显示", async () => {
        await desktop.files.reveal(node.localPath, { isDirectory: node.kind === "directory" });
      });
    }

    if (node.excluded === true && node.directExcluded !== true) {
      createButton("由父节点排除", async () => {}, { disabled: true });
    } else {
      createButton(node.directExcluded === true ? "取消排除" : "排除", async () => {
        await updateExclusion(node, node.directExcluded !== true);
      }, { className: node.directExcluded === true ? "" : "danger" });
    }

    document.body.append(menu);
    treeContextMenu = menu;

    const bounds = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(event.clientX, window.innerWidth - bounds.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(event.clientY, window.innerHeight - bounds.height - 8))}px`;
    const focusTarget = buttons.find((button) => !button.disabled) || buttons[0];
    if (focusTarget) {
      focusTarget.focus();
    }
  }

  function setFallbackWrapperExclusion(wrapper, excluded, directExcluded) {
    const node = wrapper.__treeNode;
    if (node) {
      node.excluded = excluded === true;
      node.directExcluded = directExcluded === true;
    }
    wrapper.classList.toggle("excluded", excluded === true);
    wrapper.classList.toggle("direct-excluded", directExcluded === true);
    const row = wrapper.querySelector(":scope > .fallback-row");
    if (row) {
      row.classList.toggle("excluded", excluded === true);
    }
  }

  function closeTreeContextMenu() {
    if (treeContextMenu) {
      treeContextMenu.remove();
      treeContextMenu = null;
    }
  }

  function pendingCount(value) {
    const total = Number(value && value.count !== undefined ? value.count : value && value.total) || 0;
    const done = Number(value && value.completedCount !== undefined ? value.completedCount : value && value.done) || 0;
    return Math.max(0, total - done);
  }

  function treeTypeForNode(node) {
    if (node.kind === "directory") {
      return "directory";
    }
    return "file";
  }

  async function loadMaterialIconMap() {
    try {
      const response = await fetch(desktop.runtime.getURL("vendor/material-icon-theme/icon-map.json"));
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return await response.json();
    } catch (error) {
      console.warn("Material Icon Theme map unavailable:", error);
      return {
        file: "file",
        folder: "folder",
        folderExpanded: "folder-open",
        fileExtensions: {},
        fileNames: {},
        folderNames: {},
        folderNamesExpanded: {}
      };
    }
  }

  function iconNameForTreeNode(node) {
    if (node.kind === "directory") {
      return lookupDirectoryIcon(node, false);
    }
    return lookupFileIcon(node);
  }

  function lookupDirectoryIcon(node, expanded) {
    const name = normalizeIconLookupName(node.name || node.path || "");
    const map = expanded ? materialIconMap.folderNamesExpanded : materialIconMap.folderNames;
    const fallback = expanded
      ? materialIconMap.folderExpanded || "folder-open"
      : materialIconMap.folder || "folder";
    return (name && map && map[name]) || fallback;
  }

  function lookupFileIcon(node) {
    const name = normalizeIconLookupName(node.name || "");
    if (name && materialIconMap.fileNames && materialIconMap.fileNames[name]) {
      return materialIconMap.fileNames[name];
    }

    for (const extension of fileExtensionCandidates(name, node.extension)) {
      const iconName = materialIconMap.fileExtensions && materialIconMap.fileExtensions[extension];
      if (iconName) {
        return iconName;
      }
    }

    return materialIconMap.file || "file";
  }

  function fileExtensionCandidates(name, extension) {
    const candidates = [];
    const normalizedExtension = normalizeIconLookupName(extension || "");
    const dotIndexes = [];

    for (let index = 0; index < name.length; index += 1) {
      if (name[index] === "." && index < name.length - 1) {
        dotIndexes.push(index);
      }
    }

    for (const dotIndex of dotIndexes) {
      candidates.push(name.slice(dotIndex + 1));
    }

    if (normalizedExtension) {
      candidates.push(normalizedExtension);
    }

    return [...new Set(candidates)];
  }

  function normalizeIconLookupName(value) {
    return String(value || "").trim().toLowerCase();
  }

  function materialIconUrl(iconName) {
    const safeName = String(iconName || "file").replace(/[^a-z0-9_.-]/gi, "");
    return desktop.runtime.getURL(`vendor/material-icon-theme/icons/${safeName}.svg`);
  }

  function statusTextForCommand(type) {
    return {
      "queue:start": "队列已开始。",
      "queue:pause": "队列已暂停。",
      "queue:cancel-downloads": "已取消当前下载任务。",
      "queue:retry-failed": "失败项已放回队列。"
    }[type] || "已更新。";
  }

  function normalizePath(value) {
    return String(value || "")
      .trim()
      .replace(/\\/g, "/")
      .replace(/^\/+/, "")
      .replace(/\/{2,}/g, "/");
  }

  function normalizeSaveDirectory(value) {
    const path = String(value || "").trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/");
    const normalized = /^Users\//.test(path) ? `/${path}` : path;
    if (normalized === "/" || /^[a-z]:\/$/i.test(normalized)) {
      return normalized;
    }
    return normalized.replace(/\/+$/, "");
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

  function apiRootFromBaseUrl(value) {
    const url = new URL(normalizeBaseUrl(value) || defaultBaseUrl);
    const markerIndex = url.pathname.indexOf("/api/companies");
    url.pathname = markerIndex >= 0
      ? url.pathname.slice(0, markerIndex)
      : url.pathname.replace(/\/+$/, "");
    url.search = "";
    url.hash = "";
    return url.href.replace(/\/+$/, "");
  }

  function companyIdFromBaseUrl(value) {
    try {
      const match = new URL(value).pathname.match(/\/api\/companies\/(?:api\/companies\/)?([^/]+)/);
      return match ? decodeURIComponent(match[1]) : "";
    } catch (_) {
      return "";
    }
  }

  function companyFilesBaseUrl(value, companyId) {
    return normalizeBaseUrl(`${apiRootFromBaseUrl(value)}/api/companies/${encodeURIComponent(companyId)}/storages/files/`);
  }

  async function* readPathTextEntries(text) {
    const value = String(text || "");
    let offset = 0;
    let emitted = 0;
    while (offset < value.length) {
      const newline = value.indexOf("\n", offset);
      const nextOffset = newline === -1 ? value.length : newline + 1;
      const entry = parsePathLine(value.slice(offset, newline === -1 ? value.length : newline));
      offset = nextOffset;
      if (entry) {
        yield entry;
        emitted += 1;
      }
      if (emitted > 0 && emitted % IMPORT_CHUNK_SIZE === 0) {
        setImportProgress((offset / Math.max(1, value.length)) * 100);
        await yieldToUi();
      }
    }
  }

  function parsePathLine(line) {
    const rawLine = String(line || "").trim();
    const path = rawLine.replace(/^["']|["']$/g, "");
    if (!rawLine || rawLine.startsWith("#") || rawLine.startsWith("//") || !path) {
      return null;
    }
    return { rawLine, path };
  }

  function addImportChunk(items, options, deferRender) {
    return desktop.runtime.sendMessage({
      type: "queue:add",
      items,
      options,
      deferRender
    });
  }

  function yieldToUi() {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  function formatRate(bytesPerSecond) {
    const value = Math.max(0, Number(bytesPerSecond) || 0);
    if (value >= 1000 * 1000 * 1000) {
      return `${(value / 1000 / 1000 / 1000).toFixed(1)} GB/s`;
    }
    if (value >= 1000 * 1000) {
      return `${(value / 1000 / 1000).toFixed(1)} MB/s`;
    }
    return `${Math.round(value / 1000)} KB/s`;
  }

  function pathToQueueItem(entry, baseUrl) {
    const rawPath = entry.path;
    const sourceKey = `path-list:${entry.rawLine.normalize("NFC")}`;
    if (/^https?:\/\//i.test(rawPath)) {
      return {
        url: rawPath,
        label: rawPath,
        path: pathFromUrl(rawPath),
        sourceType: "absolute-url",
        sourceKey
      };
    }

    const cleanPath = normalizePath(decodePath(rawPath));
    if (!cleanPath || cleanPath.split("/").includes("..")) {
      return null;
    }

    return {
      url: joinUrl(baseUrl, cleanPath),
      label: cleanPath,
      path: cleanPath,
      sourceType: "path-list",
      sourceKey
    };
  }

  function decodePath(path) {
    try {
      return decodeURIComponent(path);
    } catch (_) {
      return path;
    }
  }

  function joinUrl(baseUrl, path) {
    return `${baseUrl}${path.split("/").map(encodeUrlPathSegment).join("/")}`;
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

  function pathFromUrl(url) {
    try {
      const parsed = new URL(url);
      return normalizePath(decodeURIComponent(parsed.pathname || "")) || "download";
    } catch (_) {
      return "download";
    }
  }

  function clampNumber(value, min, max, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
      return fallback;
    }
    return Math.min(max, Math.max(min, Math.round(number)));
  }

  function setStatus(message, isError = false, isSuccess = false) {
    status.textContent = message;
    status.className = isError ? "error" : isSuccess ? "success" : "";
  }

  function setCatalogError(error) {
    const message = error && (error.message || String(error));
    setStatus(String(message).includes("TOR_PROXY_UNAVAILABLE")
      ? "无法连接 Tor 代理，请打开 Tor 浏览器并连接到 Tor 网络。"
      : message, true);
  }

  function setImportProgress(value) {
    const indeterminate = value === null || value === undefined;
    importProgress.classList.toggle("indeterminate", indeterminate);
    if (indeterminate) {
      importProgress.hidden = false;
      importProgressBar.style.width = "35%";
      return;
    }
    const percent = Math.max(0, Math.min(100, Math.floor(Number(value) || 0)));
    importProgress.hidden = false;
    importProgressBar.style.width = `${percent}%`;
  }

  function hideImportProgress() {
    importProgress.hidden = true;
    importProgress.classList.remove("indeterminate");
    importProgressBar.style.width = "0%";
  }

  function setBusy(isBusy) {
    uiBusy = isBusy;
    companySelect.disabled = isBusy;
    refreshCompaniesButton.disabled = isBusy;
    updateSaveDirectoryAvailability();
  }

  function updateSaveDirectoryAvailability() {
    const disabled = uiBusy || queueLocksSaveDirectory;
    baseFolderInput.disabled = disabled;
    selectBaseFolderButton.disabled = disabled;
  }

})();
