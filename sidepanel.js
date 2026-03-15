const utils = globalThis.ElementSnapshotUtils;
const MESSAGE_TYPES = utils.MESSAGE_TYPES;

const state = {
  records: [],
  filteredRecords: [],
  selectedId: "",
  searchKeyword: "",
  selectionState: utils.DEFAULT_SELECTION_STATE,
  fabMode: "off",
};

const refs = {};
let toastTimer = 0;

document.addEventListener("DOMContentLoaded", () => {
  cacheElements();
  bindEvents();
  refreshAll();
});

function cacheElements() {
  refs.statusBadge = document.getElementById("statusBadge");
  refs.startButton = document.getElementById("startButton");
  refs.stopButton = document.getElementById("stopButton");
  refs.copyCurrentButton = document.getElementById("copyCurrentButton");
  refs.exportButton = document.getElementById("exportButton");
  refs.clearButton = document.getElementById("clearButton");
  refs.searchInput = document.getElementById("searchInput");
  refs.recordCount = document.getElementById("recordCount");
  refs.listContainer = document.getElementById("listContainer");
  refs.detailEmpty = document.getElementById("detailEmpty");
  refs.detailContent = document.getElementById("detailContent");
  refs.detailTitle = document.getElementById("detailTitle");
  refs.detailMeta = document.getElementById("detailMeta");
  refs.noteInput = document.getElementById("noteInput");
  refs.saveNoteButton = document.getElementById("saveNoteButton");
  refs.copyLocatorButton = document.getElementById("copyLocatorButton");
  refs.copyMarkdownButton = document.getElementById("copyMarkdownButton");
  refs.deleteCurrentButton = document.getElementById("deleteCurrentButton");
  refs.jsonViewer = document.getElementById("jsonViewer");
  refs.toast = document.getElementById("toast");
  refs.fabModeControl = document.getElementById("fabModeControl");
}

function bindEvents() {
  refs.startButton.addEventListener("click", handleStartSelection);
  refs.stopButton.addEventListener("click", handleStopSelection);
  refs.copyCurrentButton.addEventListener("click", handleCopyCurrentJson);
  refs.exportButton.addEventListener("click", handleExport);
  refs.clearButton.addEventListener("click", handleClearRecords);
  refs.searchInput.addEventListener("input", handleSearchInput);
  refs.saveNoteButton.addEventListener("click", handleSaveNote);
  refs.copyLocatorButton.addEventListener("click", handleCopyLocator);
  refs.copyMarkdownButton.addEventListener("click", handleCopyMarkdown);
  refs.deleteCurrentButton.addEventListener("click", handleDeleteCurrent);
  refs.listContainer.addEventListener("click", handleListClick);
  refs.listContainer.addEventListener("keydown", handleListKeyDown);
  refs.fabModeControl.addEventListener("click", handleFabModeClick);

  chrome.runtime.onMessage.addListener((message) => {
    if (!message || !message.type) {
      return;
    }

    if (
      message.type === MESSAGE_TYPES.recordsUpdated ||
      message.type === MESSAGE_TYPES.selectionStateChanged
    ) {
      refreshAll(true);
    }
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") {
      return;
    }

    if (changes[utils.STORAGE_KEYS.records] || changes[utils.STORAGE_KEYS.selectionState]) {
      refreshAll(true);
    }
  });
}

async function refreshAll(preserveSelection) {
  try {
    const panelData = await loadPanelData();
    state.records = Array.isArray(panelData.records) ? panelData.records : [];
    state.selectionState = panelData.selectionState || utils.DEFAULT_SELECTION_STATE;
    state.fabMode = panelData.fabMode || "off";
    applyFilter();
    ensureValidSelection(Boolean(preserveSelection));
    render();
  } catch (error) {
    console.error("刷新侧边栏失败：", error);
    showToast(error && error.message ? error.message : "加载记录失败");
  }
}

async function loadPanelData() {
  try {
    const response = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.getPanelData,
    });
    if (response && response.ok) {
      return response;
    }
  } catch (error) {
    console.warn("通过消息读取面板数据失败，改用本地存储：", error);
  }

  const [records, selectionState, fabMode] = await Promise.all([
    utils.readRecords(),
    utils.readSelectionState(),
    utils.readFabMode(),
  ]);
  return { records, selectionState, fabMode };
}

function applyFilter() {
  const keyword = state.searchKeyword.trim().toLowerCase();
  if (!keyword) {
    state.filteredRecords = state.records.slice();
    return;
  }

  state.filteredRecords = state.records.filter((record) =>
    utils.buildRecordSearchIndex(record).includes(keyword)
  );
}

function ensureValidSelection(preserveSelection) {
  const filteredIds = new Set(state.filteredRecords.map((record) => record.id));
  const hasCurrent =
    preserveSelection && state.selectedId && filteredIds.has(state.selectedId);

  if (hasCurrent) {
    return;
  }

  state.selectedId = state.filteredRecords[0] ? state.filteredRecords[0].id : "";
}

function getSelectedRecord() {
  return state.records.find((record) => record.id === state.selectedId) || null;
}

function render() {
  renderStatus();
  renderRecordCount();
  renderList();
  renderDetail();
  updateActionStates();
  renderFabMode();
}

function renderStatus() {
  refs.statusBadge.textContent =
    (state.selectionState && state.selectionState.statusText) || "未开始选择";
}

function renderRecordCount() {
  const total = state.records.length;
  const visible = state.filteredRecords.length;
  refs.recordCount.textContent =
    state.searchKeyword.trim() === ""
      ? `共 ${total} 条记录`
      : `筛选后 ${visible} / ${total} 条记录`;
}

function renderList() {
  const container = refs.listContainer;
  container.innerHTML = "";

  if (!state.records.length) {
    container.innerHTML =
      '<div class="empty-state">尚未采集任何元素。<br />点击上方“开始选择”，再到网页中点选目标元素。</div>';
    return;
  }

  if (!state.filteredRecords.length) {
    container.innerHTML =
      '<div class="empty-state">没有匹配的记录。<br />请尝试更换搜索关键词。</div>';
    return;
  }

  const fragment = document.createDocumentFragment();

  state.filteredRecords.forEach((record) => {
    const card = document.createElement("article");
    card.className = `record-card${record.id === state.selectedId ? " is-selected" : ""}`;
    card.tabIndex = 0;
    card.dataset.recordId = record.id;

    const timeText = utils.formatDateTime(record.timestamp);
    const selector = escapeHtml(utils.getSelectorSummary(record) || "无可用选择器");
    const excerpt = escapeHtml(utils.getTextExcerpt(record) || "无文本内容");
    const meta = escapeHtml(utils.formatPosition(record.position));
    const page = escapeHtml(utils.getPageSummary(record));
    const tagName = escapeHtml(record.tagName || "unknown");

    card.innerHTML = `
      <div class="record-card__header">
        <span class="tag-chip">${tagName}</span>
        <button class="record-delete" type="button" data-delete-id="${record.id}">删除</button>
      </div>
      <div class="record-selector">${selector}</div>
      <div class="record-text">${excerpt}</div>
      <div class="record-meta">${meta}</div>
      <div class="record-page">${page}</div>
      <div class="record-card__footer">
        <span class="record-time">${escapeHtml(timeText)}</span>
        <span class="record-time">${record.isVisible ? "可见" : "不可见"}</span>
      </div>
    `;
    fragment.appendChild(card);
  });

  container.appendChild(fragment);
}

function renderDetail() {
  const record = getSelectedRecord();

  if (!record) {
    refs.detailEmpty.hidden = false;
    refs.detailContent.hidden = true;
    refs.noteInput.value = "";
    refs.jsonViewer.textContent = "";
    refs.detailTitle.textContent = "未选择记录";
    refs.detailMeta.textContent = "";
    return;
  }

  refs.detailEmpty.hidden = true;
  refs.detailContent.hidden = false;

  refs.detailTitle.textContent = record.elementSummary || `${record.tagName || ""} 元素`;
  const frameworkMeta = getFrameworkMetaLine(record);
  refs.detailMeta.innerHTML = [
    `页面：${escapeHtml(utils.getPageSummary(record))}`,
    `选择器：${escapeHtml(utils.getSelectorSummary(record) || "无")}`,
    `时间：${escapeHtml(utils.formatDateTime(record.timestamp))}`,
    frameworkMeta ? escapeHtml(frameworkMeta) : "",
  ]
    .filter(Boolean)
    .join("<br />");

  refs.noteInput.value = record.note || "";
  refs.jsonViewer.textContent = JSON.stringify(record, null, 2);
}

function updateActionStates() {
  const selectedRecord = getSelectedRecord();
  const hasRecords = state.records.length > 0;
  refs.copyCurrentButton.disabled = !selectedRecord;
  refs.exportButton.disabled = !hasRecords;
  refs.clearButton.disabled = !hasRecords;
  refs.copyLocatorButton.disabled = !selectedRecord;
  refs.copyMarkdownButton.disabled = !selectedRecord;
  refs.deleteCurrentButton.disabled = !selectedRecord;
  refs.saveNoteButton.disabled = !selectedRecord;
}

async function handleStartSelection() {
  try {
    const tabId = await getCurrentTabId();
    const response = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.startSelection,
      tabId,
    });

    if (!response || !response.ok) {
      throw new Error((response && response.error) || "开启选择模式失败");
    }

    await refreshAll(true);
    showToast("选择模式已开启");
  } catch (error) {
    showToast(error && error.message ? error.message : "开启选择模式失败");
  }
}

async function handleStopSelection() {
  try {
    const tabId = await getCurrentTabId();
    const response = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.stopSelection,
      tabId,
    });

    if (!response || !response.ok) {
      throw new Error((response && response.error) || "停止选择失败");
    }

    await refreshAll(true);
    showToast("已停止选择");
  } catch (error) {
    showToast(error && error.message ? error.message : "停止选择失败");
  }
}

async function handleCopyCurrentJson() {
  const record = getSelectedRecord();
  if (!record) {
    showToast("请先选择一条记录");
    return;
  }

  try {
    await copyText(JSON.stringify(record, null, 2));
    showToast("当前记录 JSON 已复制");
  } catch (error) {
    showToast(error && error.message ? error.message : "复制失败");
  }
}

async function handleCopyMarkdown() {
  const record = getSelectedRecord();
  if (!record) {
    showToast("请先选择一条记录");
    return;
  }

  try {
    await copyText(utils.buildRecordMarkdown(record));
    showToast("当前记录 Markdown 已复制");
  } catch (error) {
    showToast(error && error.message ? error.message : "复制失败");
  }
}

async function handleCopyLocator() {
  const record = getSelectedRecord();
  if (!record) {
    showToast("请先选择一条记录");
    return;
  }

  try {
    await copyText(utils.buildCursorPromptText(record));
    showToast("提示文本已复制");
  } catch (error) {
    showToast(error && error.message ? error.message : "复制失败");
  }
}

async function handleExport() {
  if (!state.records.length) {
    showToast("暂无可导出的记录");
    return;
  }

  try {
    utils.downloadJsonFile("元素快照记录.json", state.records);
    showToast("JSON 文件已开始下载");
  } catch (error) {
    showToast(error && error.message ? error.message : "导出失败");
  }
}

async function handleClearRecords() {
  if (!state.records.length) {
    showToast("当前没有可清空的记录");
    return;
  }

  try {
    await utils.clearRecords();
    state.selectedId = "";
    await refreshAll(false);
    showToast("记录已清空");
  } catch (error) {
    showToast(error && error.message ? error.message : "清空失败");
  }
}

function handleSearchInput(event) {
  state.searchKeyword = event.target.value || "";
  applyFilter();
  ensureValidSelection(true);
  render();
}

async function handleSaveNote() {
  const record = getSelectedRecord();
  if (!record) {
    showToast("请先选择一条记录");
    return;
  }

  try {
    await utils.updateRecordNote(record.id, refs.noteInput.value || "");
    await refreshAll(true);
    showToast("备注已保存");
  } catch (error) {
    showToast(error && error.message ? error.message : "保存备注失败");
  }
}

async function handleDeleteCurrent() {
  const record = getSelectedRecord();
  if (!record) {
    showToast("请先选择一条记录");
    return;
  }

  try {
    await utils.deleteRecord(record.id);
    state.selectedId = "";
    await refreshAll(false);
    showToast("记录已删除");
  } catch (error) {
    showToast(error && error.message ? error.message : "删除失败");
  }
}

async function handleListClick(event) {
  const deleteButton = event.target.closest("[data-delete-id]");
  if (deleteButton) {
    event.stopPropagation();
    const recordId = deleteButton.dataset.deleteId;
    try {
      await utils.deleteRecord(recordId);
      if (state.selectedId === recordId) {
        state.selectedId = "";
      }
      await refreshAll(false);
      showToast("记录已删除");
    } catch (error) {
      showToast(error && error.message ? error.message : "删除失败");
    }
    return;
  }

  const card = event.target.closest("[data-record-id]");
  if (!card) {
    return;
  }

  state.selectedId = card.dataset.recordId;
  render();
}

function handleListKeyDown(event) {
  if (!["Enter", " "].includes(event.key)) {
    return;
  }

  const card = event.target.closest("[data-record-id]");
  if (!card) {
    return;
  }

  event.preventDefault();
  state.selectedId = card.dataset.recordId;
  render();
}

function renderFabMode() {
  const buttons = refs.fabModeControl.querySelectorAll("[data-fab-mode]");
  buttons.forEach((btn) => {
    if (btn.dataset.fabMode === state.fabMode) {
      btn.classList.add("is-active");
    } else {
      btn.classList.remove("is-active");
    }
  });
}

async function handleFabModeClick(event) {
  const btn = event.target.closest("[data-fab-mode]");
  if (!btn) return;

  const mode = btn.dataset.fabMode;
  if (mode === state.fabMode) return;

  try {
    const tabId = await getCurrentTabId();
    const response = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.setFabMode,
      mode,
      tabId,
    });

    if (!response || !response.ok) {
      throw new Error("切换悬浮球模式失败");
    }

    state.fabMode = response.fabMode || mode;
    renderFabMode();

    const labels = { off: "已关闭悬浮球", "current-tab": "悬浮球：仅当前页", "all-tabs": "悬浮球：所有网页" };
    showToast(labels[state.fabMode] || "已切换");
  } catch (error) {
    showToast(error && error.message ? error.message : "切换失败");
  }
}

async function getCurrentTabId() {
  const tabs = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
  return tabs[0] && typeof tabs[0].id === "number" ? tabs[0].id : null;
}

async function copyText(text) {
  if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}

function showToast(message) {
  clearTimeout(toastTimer);
  refs.toast.textContent = message;
  refs.toast.hidden = false;
  toastTimer = window.setTimeout(() => {
    refs.toast.hidden = true;
  }, 2200);
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getFrameworkMetaLine(record) {
  if (
    record &&
    record.frameworkHints &&
    record.frameworkHints.react &&
    Array.isArray(record.frameworkHints.react.componentChain) &&
    record.frameworkHints.react.componentChain.length
  ) {
    return `React 组件链：${record.frameworkHints.react.componentChain.join(" > ")}`;
  }

  if (
    record &&
    record.frameworkHints &&
    record.frameworkHints.vue &&
    Array.isArray(record.frameworkHints.vue.componentChain) &&
    record.frameworkHints.vue.componentChain.length
  ) {
    return `Vue 组件链：${record.frameworkHints.vue.componentChain.join(" > ")}`;
  }

  return "";
}
