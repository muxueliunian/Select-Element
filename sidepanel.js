const utils = globalThis.ElementSnapshotUtils;
const MESSAGE_TYPES = utils.MESSAGE_TYPES;

const NOTE_SAVE_DELAY_MS = 500;
const UNDO_TOAST_MS = 5000;

const state = {
  records: [],
  filteredRecords: [],
  selectedId: "",
  searchKeyword: "",
  selectionState: utils.DEFAULT_SELECTION_STATE,
  fabMode: "off",
  // 新采集的记录在下一次刷新时自动选中
  pendingSelectId: "",
  // 底部编辑框当前对应的记录；只有切换记录时才回填输入框，避免打断正在输入的内容
  composerRecordId: "",
};

const refs = {};
let toastTimer = 0;
let searchDebounceTimer = 0;
let pendingNoteSave = null;

// 搜索索引按记录对象缓存：记录数据不可变，输入框每次按键无需对全部记录重算索引。
// 记录在 refreshAll 时会被替换为新对象，WeakMap 自动随旧对象回收。
const searchIndexCache = new WeakMap();

function getRecordSearchIndex(record) {
  let index = searchIndexCache.get(record);
  if (index === undefined) {
    index = utils.buildRecordSearchIndex(record);
    searchIndexCache.set(record, index);
  }
  return index;
}

document.addEventListener("DOMContentLoaded", () => {
  cacheElements();
  bindEvents();
  renderShortcuts();
  refreshAll();
});

function cacheElements() {
  [
    "toggleButton",
    "searchInput",
    "settingsButton",
    "settingsPopover",
    "menuButton",
    "moreMenu",
    "exportButton",
    "clearButton",
    "recordCount",
    "listContainer",
    "composer",
    "composerKind",
    "composerSelector",
    "noteInput",
    "copyButton",
    "promptViewer",
    "fabModeControl",
    "shortcutList",
    "editShortcutsButton",
    "toast",
    "toastText",
    "toastAction",
  ].forEach((id) => {
    refs[id] = document.getElementById(id);
  });
}

function bindEvents() {
  refs.toggleButton.addEventListener("click", handleToggleSelection);
  refs.searchInput.addEventListener("input", handleSearchInput);
  refs.exportButton.addEventListener("click", handleExport);
  refs.clearButton.addEventListener("click", handleClearRecords);
  refs.listContainer.addEventListener("click", handleListClick);
  refs.listContainer.addEventListener("keydown", handleListKeyDown);
  refs.noteInput.addEventListener("input", handleNoteInput);
  refs.noteInput.addEventListener("compositionend", handleNoteInput);
  refs.noteInput.addEventListener("blur", flushNoteSave);
  refs.copyButton.addEventListener("click", handleCopyPrompt);
  refs.fabModeControl.addEventListener("click", handleFabModeClick);
  refs.editShortcutsButton.addEventListener("click", () => {
    chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
  });
  refs.toastAction.addEventListener("click", handleToastAction);
  window.addEventListener("pagehide", flushNoteSave);

  anchorPopover(refs.settingsPopover, refs.settingsButton);
  anchorPopover(refs.moreMenu, refs.menuButton);

  chrome.runtime.onMessage.addListener((message) => {
    if (!message || !message.type) {
      return;
    }

    if (message.type === MESSAGE_TYPES.recordsUpdated) {
      const capturedId = message.payload && message.payload.lastCapturedId;
      if (capturedId) {
        state.pendingSelectId = capturedId;
      }
      refreshAll();
    }

    if (message.type === MESSAGE_TYPES.selectionStateChanged) {
      refreshAll();
    }
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") {
      return;
    }

    if (changes[utils.STORAGE_KEYS.records] || changes[utils.STORAGE_KEYS.selectionState]) {
      refreshAll();
    }
  });
}

// 弹出层打开前，贴着触发按钮的右下方定位
function anchorPopover(popover, trigger) {
  popover.addEventListener("beforetoggle", (event) => {
    if (event.newState !== "open") {
      return;
    }
    const rect = trigger.getBoundingClientRect();
    popover.style.top = `${rect.bottom + 6}px`;
    popover.style.right = `${Math.max(8, window.innerWidth - rect.right)}px`;
  });
}

async function refreshAll() {
  try {
    const panelData = await loadPanelData();
    state.records = Array.isArray(panelData.records) ? panelData.records : [];
    state.selectionState = panelData.selectionState || utils.DEFAULT_SELECTION_STATE;
    state.fabMode = panelData.fabMode || "off";

    if (state.pendingSelectId && state.records.some((r) => r.id === state.pendingSelectId)) {
      flushNoteSave();
      state.selectedId = state.pendingSelectId;
      state.pendingSelectId = "";
      clearSearch();
    }

    applyFilter();
    ensureValidSelection();
    render();
  } catch (error) {
    console.error("刷新侧边栏失败：", error);
    showToast(getErrorMessage(error, "加载记录失败"));
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

function clearSearch() {
  clearTimeout(searchDebounceTimer);
  state.searchKeyword = "";
  refs.searchInput.value = "";
}

function applyFilter() {
  const keyword = state.searchKeyword.trim().toLowerCase();
  state.filteredRecords = keyword
    ? state.records.filter((record) => getRecordSearchIndex(record).includes(keyword))
    : state.records.slice();
}

function ensureValidSelection() {
  if (state.filteredRecords.some((record) => record.id === state.selectedId)) {
    return;
  }
  state.selectedId = state.filteredRecords[0] ? state.filteredRecords[0].id : "";
}

function getSelectedRecord() {
  return state.records.find((record) => record.id === state.selectedId) || null;
}

function render() {
  renderToggle();
  renderRecordCount();
  renderList();
  renderComposer();
  renderMenu();
  renderFabMode();
}

function renderToggle() {
  const isSelecting = Boolean(state.selectionState && state.selectionState.isSelecting);
  refs.toggleButton.textContent = isSelecting ? "选择中… 点击停止" : "开始选择";
  refs.toggleButton.classList.toggle("button--active", isSelecting);
}

function renderRecordCount() {
  const total = state.records.length;
  const visible = state.filteredRecords.length;
  refs.recordCount.textContent =
    state.searchKeyword.trim() === "" ? `${total} 条记录` : `匹配 ${visible} / ${total} 条`;
}

function renderList() {
  const container = refs.listContainer;
  const scrollTop = container.scrollTop;
  container.innerHTML = "";

  if (!state.records.length) {
    container.innerHTML =
      '<div class="empty-state">还没有记录。<br />点击“开始选择”，然后在网页中点一下目标元素。</div>';
    return;
  }

  if (!state.filteredRecords.length) {
    container.innerHTML = '<div class="empty-state">没有匹配的记录</div>';
    return;
  }

  const fragment = document.createDocumentFragment();
  state.filteredRecords.forEach((record) => {
    fragment.appendChild(createRecordCard(record));
  });
  container.appendChild(fragment);
  container.scrollTop = scrollTop;
}

function createRecordCard(record) {
  const card = document.createElement("article");
  card.className = `record-card${record.id === state.selectedId ? " is-selected" : ""}`;
  card.tabIndex = 0;
  card.dataset.recordId = record.id;

  const excerpt = utils.getTextExcerpt(record);
  const flags = [
    record.note ? '<span class="flag">已写需求</span>' : "",
    record.isVisible === false ? '<span class="flag flag--muted">不可见</span>' : "",
  ].join("");

  card.innerHTML = `
    <div class="record-card__top">
      <span class="chip">${escapeHtml(utils.getElementKind(record))}</span>
      <code class="record-selector mono">${escapeHtml(utils.getSelectorSummary(record) || record.tagName || "")}</code>
      <button class="record-delete" type="button" data-delete-id="${escapeHtml(record.id)}" title="删除" aria-label="删除">×</button>
    </div>
    ${excerpt ? `<div class="record-text">${escapeHtml(excerpt)}</div>` : ""}
    <div class="record-meta">
      <span class="record-meta__page">${escapeHtml(utils.getPageSummary(record))}</span>
      <span class="record-meta__time">· ${escapeHtml(utils.formatDateTime(record.timestamp))}</span>
      ${flags}
    </div>
  `;
  return card;
}

function renderComposer() {
  const record = getSelectedRecord();
  refs.composer.hidden = !record;

  if (!record) {
    state.composerRecordId = "";
    return;
  }

  refs.composerKind.textContent = utils.getElementKind(record);
  refs.composerSelector.textContent = utils.getSelectorSummary(record) || record.tagName || "";

  // 切换记录时回填；同一条记录在输入期间不覆盖，避免吞字或打断输入法
  if (state.composerRecordId !== record.id || document.activeElement !== refs.noteInput) {
    if (!pendingNoteSave || pendingNoteSave.recordId !== record.id) {
      refs.noteInput.value = record.note || "";
    }
    state.composerRecordId = record.id;
  }

  renderPromptPreview();
}

function renderPromptPreview() {
  refs.promptViewer.textContent = buildCurrentPrompt();
}

function buildCurrentPrompt() {
  const record = getSelectedRecord();
  return record ? utils.buildAgentPrompt({ ...record, note: refs.noteInput.value }) : "";
}

function renderMenu() {
  const hasRecords = state.records.length > 0;
  refs.exportButton.disabled = !hasRecords;
  refs.clearButton.disabled = !hasRecords;
}

function renderFabMode() {
  refs.fabModeControl.querySelectorAll("[data-fab-mode]").forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.fabMode === state.fabMode);
  });
}

// 快捷键以 Chrome 中的实际绑定为准（用户可能已在 chrome://extensions/shortcuts 修改）
async function renderShortcuts() {
  const labels = {
    "start-selection": "开始选择",
    "stop-selection": "停止选择",
  };
  let commands = [];
  try {
    commands = await chrome.commands.getAll();
  } catch (error) {
    console.warn("读取快捷键失败：", error);
  }

  const items = commands
    .filter((command) => labels[command.name])
    .map((command) => [labels[command.name], command.shortcut]);
  items.push(["退出选择", "Esc"]);

  refs.shortcutList.innerHTML = items
    .map(
      ([label, shortcut]) =>
        `<li><span>${escapeHtml(label)}</span><span>${
          shortcut
            ? shortcut
                .split("+")
                .map((key) => `<kbd>${escapeHtml(key)}</kbd>`)
                .join(" + ")
            : "未设置"
        }</span></li>`
    )
    .join("");
}

async function handleToggleSelection() {
  const isSelecting = Boolean(state.selectionState && state.selectionState.isSelecting);
  const type = isSelecting ? MESSAGE_TYPES.stopSelection : MESSAGE_TYPES.startSelection;
  const fallbackError = isSelecting ? "停止选择失败" : "开启选择模式失败";

  try {
    const tabId = await getCurrentTabId();
    const response = await chrome.runtime.sendMessage({ type, tabId });
    if (!response || !response.ok) {
      throw new Error((response && response.error) || fallbackError);
    }
    await refreshAll();
  } catch (error) {
    showToast(getErrorMessage(error, fallbackError));
  }
}

function handleSearchInput(event) {
  const value = event.target.value || "";
  // 防抖：连续输入时只在停顿后过滤+重渲染一次，避免每次按键全量重建列表
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = window.setTimeout(() => {
    flushNoteSave();
    state.searchKeyword = value;
    applyFilter();
    ensureValidSelection();
    render();
  }, 150);
}

function handleNoteInput(event) {
  renderPromptPreview();
  // 输入法组字过程中不保存，等 compositionend 再触发
  if (event.isComposing) {
    clearTimeout(pendingNoteSave && pendingNoteSave.timer);
    return;
  }

  const recordId = state.selectedId;
  if (!recordId) {
    return;
  }

  clearTimeout(pendingNoteSave && pendingNoteSave.timer);
  pendingNoteSave = {
    recordId,
    timer: window.setTimeout(flushNoteSave, NOTE_SAVE_DELAY_MS),
  };
}

function flushNoteSave() {
  if (!pendingNoteSave) {
    return;
  }
  const { recordId, timer } = pendingNoteSave;
  clearTimeout(timer);
  pendingNoteSave = null;

  utils.updateRecordNote(recordId, refs.noteInput.value || "").catch((error) => {
    showToast(getErrorMessage(error, "保存需求失败"));
  });
}

async function handleCopyPrompt() {
  const prompt = buildCurrentPrompt();
  if (!prompt) {
    return;
  }

  flushNoteSave();
  try {
    await copyText(prompt);
    showToast("已复制，粘贴给 AI 即可");
  } catch (error) {
    showToast(getErrorMessage(error, "复制失败"));
  }
}

function handleExport() {
  refs.moreMenu.hidePopover();
  if (!state.records.length) {
    return;
  }

  try {
    utils.downloadJsonFile("元素快照记录.json", state.records);
    showToast("JSON 文件已开始下载");
  } catch (error) {
    showToast(getErrorMessage(error, "导出失败"));
  }
}

async function handleClearRecords() {
  refs.moreMenu.hidePopover();
  if (!state.records.length) {
    return;
  }

  flushNoteSave();
  const snapshot = state.records.slice();
  try {
    await utils.clearRecords();
    showUndoToast(`已清空 ${snapshot.length} 条记录`, snapshot);
  } catch (error) {
    showToast(getErrorMessage(error, "清空失败"));
  }
}

async function deleteRecordWithUndo(recordId) {
  const record = state.records.find((item) => item.id === recordId);
  if (!record) {
    return;
  }

  flushNoteSave();
  try {
    await utils.deleteRecord(recordId);
    showUndoToast("已删除 1 条记录", [record]);
  } catch (error) {
    showToast(getErrorMessage(error, "删除失败"));
  }
}

// 撤销：把删掉的记录合并回当前列表（期间新采集的记录不会丢），按采集时间倒序
async function restoreRecords(deletedRecords) {
  const current = await utils.readRecords();
  const existingIds = new Set(current.map((record) => record.id));
  const merged = current
    .concat(deletedRecords.filter((record) => !existingIds.has(record.id)))
    .sort((a, b) => (Number(b.timestamp) || 0) - (Number(a.timestamp) || 0));
  await utils.writeRecords(merged);
}

function handleListClick(event) {
  const deleteButton = event.target.closest("[data-delete-id]");
  if (deleteButton) {
    event.stopPropagation();
    deleteRecordWithUndo(deleteButton.dataset.deleteId);
    return;
  }

  const card = event.target.closest("[data-record-id]");
  if (card) {
    applySelection(card.dataset.recordId);
    highlightInPage();
  }
}

// ↑↓ 切换记录，Enter / 空格 在页面中定位
function handleListKeyDown(event) {
  const card = event.target.closest("[data-record-id]");
  if (!card || event.target.closest("[data-delete-id]")) {
    return;
  }

  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    applySelection(card.dataset.recordId);
    highlightInPage();
    return;
  }

  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
    return;
  }

  const next = event.key === "ArrowDown" ? card.nextElementSibling : card.previousElementSibling;
  if (next && next.dataset.recordId) {
    event.preventDefault();
    next.focus();
    applySelection(next.dataset.recordId);
  }
}

// 切换选中：仅更新卡片高亮与底部编辑区，避免重建整个列表 DOM
function applySelection(newId) {
  if (newId === state.selectedId) {
    return;
  }
  flushNoteSave();
  state.selectedId = newId;
  refs.listContainer.querySelectorAll("[data-record-id]").forEach((card) => {
    card.classList.toggle("is-selected", card.dataset.recordId === newId);
  });
  renderComposer();
}

async function highlightInPage() {
  const record = getSelectedRecord();
  if (!record) {
    return;
  }
  try {
    const tabId = await getCurrentTabId();
    await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.highlightElement,
      record,
      tabId,
    });
  } catch (error) {
    // 定位只是辅助功能，失败时静默
  }
}

async function handleFabModeClick(event) {
  const btn = event.target.closest("[data-fab-mode]");
  if (!btn || btn.dataset.fabMode === state.fabMode) {
    return;
  }

  try {
    const tabId = await getCurrentTabId();
    const response = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.setFabMode,
      mode: btn.dataset.fabMode,
      tabId,
    });

    if (!response || !response.ok) {
      throw new Error("切换悬浮球模式失败");
    }

    state.fabMode = response.fabMode || btn.dataset.fabMode;
    renderFabMode();
  } catch (error) {
    showToast(getErrorMessage(error, "切换失败"));
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

let toastActionHandler = null;

function showToast(message, action) {
  clearTimeout(toastTimer);
  toastActionHandler = action ? action.onClick : null;
  refs.toastText.textContent = message;
  refs.toastAction.hidden = !action;
  refs.toast.hidden = false;
  toastTimer = window.setTimeout(hideToast, action ? UNDO_TOAST_MS : 2200);
}

function hideToast() {
  clearTimeout(toastTimer);
  toastActionHandler = null;
  refs.toast.hidden = true;
}

function showUndoToast(message, deletedRecords) {
  showToast(message, {
    onClick: () => restoreRecords(deletedRecords),
  });
}

async function handleToastAction() {
  const handler = toastActionHandler;
  hideToast();
  if (!handler) {
    return;
  }
  try {
    await handler();
    showToast("已撤销");
  } catch (error) {
    showToast(getErrorMessage(error, "撤销失败"));
  }
}

function getErrorMessage(error, fallback) {
  return error && error.message ? error.message : fallback;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
