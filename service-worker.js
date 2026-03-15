importScripts("utils.js");

const {
  MESSAGE_TYPES,
  FAB_MODES,
  generateId,
  truncateText,
  insertRecord,
  readRecords,
  readSelectionState,
  writeSelectionState,
  readFabMode,
  writeFabMode,
} = ElementSnapshotUtils;

const PANEL_PATH = "sidepanel.html";

async function configureSidePanel() {
  if (!chrome.sidePanel || !chrome.sidePanel.setPanelBehavior) {
    return;
  }

  try {
    await chrome.sidePanel.setPanelBehavior({
      openPanelOnActionClick: true,
    });
  } catch (error) {
    console.warn("设置侧边栏行为失败：", error);
  }
}

configureSidePanel();
chrome.runtime.onInstalled.addListener(() => {
  configureSidePanel();
});
chrome.runtime.onStartup.addListener(() => {
  configureSidePanel();
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isSupportedUrl(url) {
  return /^(https?|file):/i.test(String(url || ""));
}

async function getTabById(tabId) {
  if (typeof tabId !== "number") {
    return null;
  }

  try {
    return await chrome.tabs.get(tabId);
  } catch (error) {
    return null;
  }
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
  return tabs[0] || null;
}

async function resolveTargetTab(preferredTabId) {
  if (typeof preferredTabId === "number") {
    return getTabById(preferredTabId);
  }
  return getActiveTab();
}

async function safeSendTabMessage(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    return null;
  }
}

async function safeBroadcast(message) {
  try {
    await chrome.runtime.sendMessage(message);
  } catch (error) {
    // Side panel may be closed. Storage listeners are the primary update path.
  }
}

async function sendFabModeToTab(tab, payload) {
  if (!tab || typeof tab.id !== "number" || !isSupportedUrl(tab.url)) {
    return;
  }

  if (payload && payload.show) {
    try {
      await ensureContentScript(tab.id);
    } catch (error) {
      return;
    }
  }

  await safeSendTabMessage(tab.id, {
    type: MESSAGE_TYPES.fabModeChanged,
    payload,
  });
}

async function ensureSidePanelEnabled(tabId) {
  if (!chrome.sidePanel || typeof tabId !== "number") {
    return;
  }

  try {
    await chrome.sidePanel.setOptions({
      tabId,
      enabled: true,
      path: PANEL_PATH,
    });
  } catch (error) {
    console.warn("启用侧边栏失败：", error);
  }
}

async function ensureContentScript(tabId) {
  const existing = await safeSendTabMessage(tabId, {
    type: MESSAGE_TYPES.ping,
  });

  if (existing && existing.ready) {
    return;
  }

  try {
    await chrome.scripting.insertCSS({
      target: { tabId },
      files: ["content-style.css"],
    });
  } catch (error) {
    console.warn("插入内容样式失败：", error);
  }

  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["utils.js", "content-script.js"],
  });

  await sleep(80);

  const ready = await safeSendTabMessage(tabId, {
    type: MESSAGE_TYPES.ping,
  });

  if (!ready || !ready.ready) {
    throw new Error("页面注入失败，请刷新页面后重试。");
  }
}

async function notifySelectionStateChanged(state) {
  await safeBroadcast({
    type: MESSAGE_TYPES.selectionStateChanged,
    payload: state,
  });
}

async function notifyRecordsUpdated(recordId) {
  await safeBroadcast({
    type: MESSAGE_TYPES.recordsUpdated,
    payload: {
      lastCapturedId: recordId || null,
    },
  });
}

async function handleStartSelection(requestedTabId) {
  const tab = await resolveTargetTab(requestedTabId);
  if (!tab || typeof tab.id !== "number") {
    throw new Error("未找到当前标签页。");
  }

  if (!isSupportedUrl(tab.url)) {
    throw new Error("当前页面不支持采集，请切换到普通网页。");
  }

  await ensureSidePanelEnabled(tab.id);
  await ensureContentScript(tab.id);

  const response = await safeSendTabMessage(tab.id, {
    type: MESSAGE_TYPES.startSelection,
  });

  if (!response || response.ok === false) {
    throw new Error(
      truncateText(response && response.error, 120) || "无法开启选择模式。"
    );
  }

  const state = await writeSelectionState({
    isSelecting: true,
    tabId: tab.id,
    pageUrl: tab.url || "",
    statusText: "选择模式已开启",
    lastCapturedId: null,
  });

  await notifySelectionStateChanged(state);
  return {
    ok: true,
    state,
    alreadyActive: Boolean(response.alreadyActive),
  };
}

async function handleStopSelection(requestedTabId) {
  const currentState = await readSelectionState();
  const targetTabId =
    typeof requestedTabId === "number"
      ? requestedTabId
      : currentState.isSelecting && typeof currentState.tabId === "number"
        ? currentState.tabId
        : null;

  if (typeof targetTabId === "number") {
    await safeSendTabMessage(targetTabId, {
      type: MESSAGE_TYPES.stopSelection,
    });
  }

  const state = await writeSelectionState({
    isSelecting: false,
    tabId: null,
    statusText: "已停止选择",
  });

  await notifySelectionStateChanged(state);
  return {
    ok: true,
    state,
  };
}

function normalizeCapturedRecord(payload, sender) {
  const tab = sender && sender.tab ? sender.tab : null;
  const record = payload && typeof payload === "object" ? payload : {};

  return {
    ...record,
    id: record.id || generateId(),
    note: typeof record.note === "string" ? record.note : "",
    timestamp: Number(record.timestamp) || Date.now(),
    url: record.url || (tab && tab.url) || "",
    title: record.title || (tab && tab.title) || "",
  };
}

async function handleElementCaptured(payload, sender) {
  const record = normalizeCapturedRecord(payload, sender);
  const records = await insertRecord(record);

  const state = await writeSelectionState({
    isSelecting: false,
    tabId: null,
    statusText: `已采集 ${records.length} 条记录`,
    lastCapturedId: record.id,
    pageUrl: record.url || "",
  });

  await notifyRecordsUpdated(record.id);
  await notifySelectionStateChanged(state);

  return {
    ok: true,
    record,
    total: records.length,
  };
}

async function handleSelectionStopped() {
  const state = await readSelectionState();
  if (!state.isSelecting) {
    return {
      ok: true,
      state,
    };
  }

  const nextState = await writeSelectionState({
    isSelecting: false,
    tabId: null,
    statusText: "已停止选择",
  });

  await notifySelectionStateChanged(nextState);
  return {
    ok: true,
    state: nextState,
  };
}

async function handleGetPanelData() {
  const [records, selectionState, fabMode] = await Promise.all([
    readRecords(),
    readSelectionState(),
    readFabMode(),
  ]);

  return {
    ok: true,
    records,
    selectionState,
    fabMode,
  };
}

async function handleSetFabMode(mode, requestedTabId) {
  const saved = await writeFabMode(mode);

  if (saved === FAB_MODES.allTabs) {
    // Broadcast to ALL supported tabs: show FAB
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      await sendFabModeToTab(tab, { mode: saved, show: true });
    }
  } else if (saved === FAB_MODES.currentTab) {
    // Show FAB only on the requested tab; hide on all others
    const tabs = await chrome.tabs.query({});
    const activeTab = await resolveTargetTab(requestedTabId);
    const activeTabId = activeTab ? activeTab.id : null;

    for (const tab of tabs) {
      await sendFabModeToTab(tab, {
        mode: saved,
        tabId: tab.id,
        show: tab.id === activeTabId,
      });
    }
  } else {
    // off — hide FAB on all tabs
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      await sendFabModeToTab(tab, { mode: saved, show: false });
    }
  }

  return { ok: true, fabMode: saved };
}

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status !== "loading") {
    return;
  }

  const currentState = await readSelectionState();
  if (!currentState.isSelecting || currentState.tabId !== tabId) {
    return;
  }

  const nextState = await writeSelectionState({
    isSelecting: false,
    tabId: null,
    statusText: "已停止选择",
  });
  await notifySelectionStateChanged(nextState);
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const currentState = await readSelectionState();
  if (!currentState.isSelecting || currentState.tabId !== tabId) {
    return;
  }

  const nextState = await writeSelectionState({
    isSelecting: false,
    tabId: null,
    statusText: "已停止选择",
  });
  await notifySelectionStateChanged(nextState);
});

// current-tab 模式下，切换 tab 时把 FAB 从旧 tab 移到新 tab
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const mode = await readFabMode();
    if (mode !== FAB_MODES.currentTab) {
      return;
    }

    const newTabId = activeInfo.tabId;
    const tabs = await chrome.tabs.query({ windowId: activeInfo.windowId });

    for (const tab of tabs) {
      await sendFabModeToTab(tab, {
        mode,
        tabId: tab.id,
        show: tab.id === newTabId,
      });
    }
  } catch (error) {
    console.warn("tabs.onActivated FAB 处理失败：", error);
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "start-selection" && command !== "stop-selection") {
    return;
  }

  const tab = await getActiveTab();
  if (!tab || typeof tab.id !== "number") {
    return;
  }

  try {
    if (command === "start-selection") {
      await handleStartSelection(tab.id);
    } else {
      await handleStopSelection(tab.id);
    }
  } catch (error) {
    console.warn("快捷键处理失败：", error);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (!message || !message.type) {
      return {
        ok: false,
        error: "无效消息。",
      };
    }

    switch (message.type) {
      case MESSAGE_TYPES.startSelection:
        return handleStartSelection(message.tabId);
      case MESSAGE_TYPES.stopSelection:
        return handleStopSelection(message.tabId);
      case MESSAGE_TYPES.elementCaptured:
        return handleElementCaptured(message.payload, sender);
      case MESSAGE_TYPES.selectionStopped:
        return handleSelectionStopped();
      case MESSAGE_TYPES.getPanelData:
        return handleGetPanelData();
      case MESSAGE_TYPES.setFabMode:
        return handleSetFabMode(message.mode, message.tabId);
      default:
        return {
          ok: false,
          error: "未知消息类型。",
        };
    }
  })()
    .then((result) => sendResponse(result))
    .catch((error) => {
      console.error("服务工作线程处理失败：", error);
      sendResponse({
        ok: false,
        error: truncateText(error && error.message, 160) || "扩展内部错误。",
      });
    });

  return true;
});
