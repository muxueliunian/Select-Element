(function (global) {
  const STORAGE_KEYS = Object.freeze({
    records: "elementSnapshotRecords",
    selectionState: "elementSnapshotSelectionState",
    fabMode: "elementSnapshotFabMode",
  });

  const FAB_MODES = Object.freeze({
    off: "off",
    currentTab: "current-tab",
    allTabs: "all-tabs",
  });

  const MAX_RECORDS = 200;

  const MESSAGE_TYPES = Object.freeze({
    ping: "ESI_PING",
    startSelection: "ESI_START_SELECTION",
    stopSelection: "ESI_STOP_SELECTION",
    selectionStopped: "ESI_SELECTION_STOPPED",
    elementCaptured: "ESI_ELEMENT_CAPTURED",
    getPanelData: "ESI_GET_PANEL_DATA",
    recordsUpdated: "ESI_RECORDS_UPDATED",
    selectionStateChanged: "ESI_SELECTION_STATE_CHANGED",
    setFabMode: "ESI_SET_FAB_MODE",
    fabModeChanged: "ESI_FAB_MODE_CHANGED",
  });

  const DEFAULT_SELECTION_STATE = Object.freeze({
    isSelecting: false,
    tabId: null,
    pageUrl: "",
    statusText: "未开始选择",
    lastCapturedId: null,
    updatedAt: 0,
  });

  function collapseWhitespace(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function truncateText(value, maxLength) {
    const text = String(value || "");
    if (!maxLength || text.length <= maxLength) {
      return text;
    }
    return text.slice(0, maxLength) + "…";
  }

  function roundNumber(value, digits) {
    const factor = 10 ** (typeof digits === "number" ? digits : 2);
    return Math.round((Number(value) || 0) * factor) / factor;
  }

  function generateId() {
    if (global.crypto && typeof global.crypto.randomUUID === "function") {
      return global.crypto.randomUUID();
    }
    return `snapshot-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  }

  function normalizeSelectionState(input) {
    return {
      ...DEFAULT_SELECTION_STATE,
      ...(input && typeof input === "object" ? input : {}),
    };
  }

  async function readRecords() {
    const result = await chrome.storage.local.get({
      [STORAGE_KEYS.records]: [],
    });
    return Array.isArray(result[STORAGE_KEYS.records])
      ? result[STORAGE_KEYS.records]
      : [];
  }

  async function writeRecords(records) {
    const safeRecords = Array.isArray(records) ? records.slice(0, MAX_RECORDS) : [];
    await chrome.storage.local.set({
      [STORAGE_KEYS.records]: safeRecords,
    });
    return safeRecords;
  }

  async function insertRecord(record) {
    const current = await readRecords();
    const next = [record, ...current].slice(0, MAX_RECORDS);
    await writeRecords(next);
    return next;
  }

  async function deleteRecord(recordId) {
    const current = await readRecords();
    const next = current.filter((item) => item.id !== recordId);
    await writeRecords(next);
    return next;
  }

  async function clearRecords() {
    await writeRecords([]);
    return [];
  }

  async function updateRecordNote(recordId, note) {
    const current = await readRecords();
    const next = current.map((item) =>
      item.id === recordId
        ? {
            ...item,
            note: String(note || "").trim(),
          }
        : item
    );
    await writeRecords(next);
    return next;
  }

  async function readSelectionState() {
    const result = await chrome.storage.local.get({
      [STORAGE_KEYS.selectionState]: DEFAULT_SELECTION_STATE,
    });
    return normalizeSelectionState(result[STORAGE_KEYS.selectionState]);
  }

  async function writeSelectionState(partialState) {
    const current = await readSelectionState();
    const next = normalizeSelectionState({
      ...current,
      ...(partialState && typeof partialState === "object" ? partialState : {}),
      updatedAt: Date.now(),
    });
    await chrome.storage.local.set({
      [STORAGE_KEYS.selectionState]: next,
    });
    return next;
  }

  async function readFabMode() {
    const result = await chrome.storage.local.get({
      [STORAGE_KEYS.fabMode]: FAB_MODES.off,
    });
    const mode = result[STORAGE_KEYS.fabMode];
    return Object.values(FAB_MODES).includes(mode) ? mode : FAB_MODES.off;
  }

  async function writeFabMode(mode) {
    const safe = Object.values(FAB_MODES).includes(mode) ? mode : FAB_MODES.off;
    await chrome.storage.local.set({
      [STORAGE_KEYS.fabMode]: safe,
    });
    return safe;
  }

  function formatDateTime(timestamp) {
    if (!timestamp) {
      return "未知时间";
    }
    try {
      return new Intl.DateTimeFormat("zh-CN", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }).format(new Date(timestamp));
    } catch (error) {
      return String(timestamp);
    }
  }

  function getSelectorSummary(record) {
    return truncateText(
      record && (record.cssSelector || record.domPath || record.xpath || ""),
      96
    );
  }

  function getTextExcerpt(record) {
    return truncateText(
      collapseWhitespace(
        record &&
          (record.text ||
            (record.elementSummary ? record.elementSummary : ""))
      ),
      140
    );
  }

  function getPageSummary(record) {
    const title = collapseWhitespace(record && record.title);
    const url = collapseWhitespace(record && record.url);
    return truncateText(title || url || "未知页面", 120);
  }

  function formatPosition(position) {
    if (!position) {
      return "位置未知";
    }
    const left = roundNumber(position.left, 0);
    const top = roundNumber(position.top, 0);
    const width = roundNumber(position.width, 0);
    const height = roundNumber(position.height, 0);
    return `x:${left} y:${top} · ${width}×${height}`;
  }

  function buildRecordSearchIndex(record) {
    return [
      record && record.tagName,
      record && record.title,
      record && record.url,
      record && record.domPath,
      record && record.cssSelector,
      record && record.xpath,
      record && record.text,
      record && record.elementSummary,
      record && record.note,
      record && record.idAttribute,
      record &&
      record.sourceHints &&
      Array.isArray(record.sourceHints.primaryQueries)
        ? record.sourceHints.primaryQueries.join(" ")
        : "",
      record &&
      record.sourceHints &&
      Array.isArray(record.sourceHints.fallbackQueries)
        ? record.sourceHints.fallbackQueries.join(" ")
        : "",
      record &&
      record.frameworkHints &&
      record.frameworkHints.react &&
      Array.isArray(record.frameworkHints.react.componentChain)
        ? record.frameworkHints.react.componentChain.join(" ")
        : "",
      record &&
      record.frameworkHints &&
      record.frameworkHints.vue &&
      Array.isArray(record.frameworkHints.vue.componentChain)
        ? record.frameworkHints.vue.componentChain.join(" ")
        : "",
      record && Array.isArray(record.classList) ? record.classList.join(" ") : "",
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
  }

  function buildSourceLocatorText(record) {
    if (!record) {
      return "";
    }

    const lines = [
      "源码定位提示",
      `页面：${record.title || "未知页面"} (${record.url || ""})`,
      `元素：${record.tagName || "unknown"} · ${record.elementSummary || "无摘要"}`,
      `选择器：${record.cssSelector || record.domPath || record.xpath || "无"}`,
      `位置：${formatPosition(record.position)}`,
    ];

    const sourceHints = record.sourceHints || {};
    const frameworkHints = record.frameworkHints || {};

    if (Array.isArray(sourceHints.primaryQueries) && sourceHints.primaryQueries.length) {
      lines.push("", "优先搜索：");
      sourceHints.primaryQueries.forEach((item, index) => {
        lines.push(`${index + 1}. ${item}`);
      });
    }

    if (Array.isArray(sourceHints.fallbackQueries) && sourceHints.fallbackQueries.length) {
      lines.push("", "备用搜索：");
      sourceHints.fallbackQueries.forEach((item, index) => {
        lines.push(`${index + 1}. ${item}`);
      });
    }

    if (
      frameworkHints.react &&
      Array.isArray(frameworkHints.react.componentChain) &&
      frameworkHints.react.componentChain.length
    ) {
      lines.push("", `React 组件链：${frameworkHints.react.componentChain.join(" > ")}`);
      if (frameworkHints.react.debugSource) {
        lines.push(`React 调试源码：${frameworkHints.react.debugSource}`);
      }
    }

    if (
      frameworkHints.vue &&
      Array.isArray(frameworkHints.vue.componentChain) &&
      frameworkHints.vue.componentChain.length
    ) {
      lines.push("", `Vue 组件链：${frameworkHints.vue.componentChain.join(" > ")}`);
      if (frameworkHints.vue.singleFileComponent) {
        lines.push(`Vue 单文件组件：${frameworkHints.vue.singleFileComponent}`);
      }
    }

    if (sourceHints.attributeSummary) {
      lines.push("", `关键属性：${sourceHints.attributeSummary}`);
    }

    if (sourceHints.classSummary) {
      lines.push(`关键类名：${sourceHints.classSummary}`);
    }

    if (sourceHints.parentClassSummary) {
      lines.push(`父容器类名：${sourceHints.parentClassSummary}`);
    }

    if (sourceHints.i18nRisk) {
      lines.push(
        "提示：元素文案可能来自 i18n 文本，优先用类名组合、组件链、父容器结构回源码。"
      );
    }

    lines.push("", `HTML 片段：${truncateText(record.html || "", 360)}`);
    return lines.join("\n");
  }

  function buildCursorPromptText(record) {
    if (!record) {
      return "";
    }

    const domPath = record.domPath || record.cssSelector || record.xpath || "未知路径";
    const position = record.position || {};
    const htmlElement = collapseWhitespace(record.html || "");
    const htmlSnippet = truncateText(htmlElement, 520);

    const lines = [
      `DOM Path: ${domPath}`,
      `Position: top=${roundNumber(position.top, 0)}px, left=${roundNumber(position.left, 0)}px, width=${roundNumber(position.width, 0)}px, height=${roundNumber(position.height, 0)}px`,
      `HTML Element: ${htmlSnippet}`,
    ];

    if (record.cssSelector) {
      lines.push(`CSS Selector: ${record.cssSelector}`);
    }

    if (
      record.frameworkHints &&
      record.frameworkHints.react &&
      Array.isArray(record.frameworkHints.react.componentChain) &&
      record.frameworkHints.react.componentChain.length
    ) {
      lines.push(`React Component Chain: ${record.frameworkHints.react.componentChain.join(" > ")}`);
      if (record.frameworkHints.react.debugSource) {
        lines.push(`React Debug Source: ${record.frameworkHints.react.debugSource}`);
      }
    }

    if (
      record.frameworkHints &&
      record.frameworkHints.vue &&
      Array.isArray(record.frameworkHints.vue.componentChain) &&
      record.frameworkHints.vue.componentChain.length
    ) {
      lines.push(`Vue Component Chain: ${record.frameworkHints.vue.componentChain.join(" > ")}`);
      if (record.frameworkHints.vue.singleFileComponent) {
        lines.push(`Vue SFC File: ${record.frameworkHints.vue.singleFileComponent}`);
      }
    }

    if (
      record.sourceHints &&
      Array.isArray(record.sourceHints.primaryQueries) &&
      record.sourceHints.primaryQueries.length
    ) {
      lines.push(`Search Hints: ${record.sourceHints.primaryQueries.slice(0, 3).join(" | ")}`);
    }

    return lines.join("\n");
  }

  function buildRecordMarkdown(record) {
    if (!record) {
      return "";
    }

    return [
      `# 元素快照 ${record.id || ""}`.trim(),
      "",
      `- 采集时间：${formatDateTime(record.timestamp)}`,
      `- 页面标题：${record.title || "未知页面"}`,
      `- 页面地址：${record.url || ""}`,
      `- 标签：${record.tagName || ""}`,
      `- 选择器：${record.cssSelector || record.domPath || ""}`,
      `- XPath：${record.xpath || ""}`,
      `- 元素摘要：${record.elementSummary || ""}`,
      `- 位置：${formatPosition(record.position)}`,
      `- 可见性：${record.isVisible ? "可见" : "不可见"}`,
      record.note ? `- 备注：${record.note}` : null,
      "",
      "## 文本",
      "",
      record.text || "无",
      "",
      "## JSON",
      "",
      "```json",
      JSON.stringify(record, null, 2),
      "```",
    ]
      .filter((line) => line !== null)
      .join("\n");
  }

  function downloadJsonFile(filename, data) {
    if (!global.document || typeof URL === "undefined") {
      throw new Error("当前环境不支持直接下载文件。");
    }

    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: "application/json;charset=utf-8",
    });
    const objectUrl = URL.createObjectURL(blob);
    const link = global.document.createElement("a");
    link.href = objectUrl;
    link.download = filename;
    link.style.display = "none";
    global.document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  }

  global.ElementSnapshotUtils = {
    STORAGE_KEYS,
    FAB_MODES,
    MAX_RECORDS,
    MESSAGE_TYPES,
    DEFAULT_SELECTION_STATE,
    collapseWhitespace,
    truncateText,
    roundNumber,
    generateId,
    normalizeSelectionState,
    readRecords,
    writeRecords,
    insertRecord,
    deleteRecord,
    clearRecords,
    updateRecordNote,
    readSelectionState,
    writeSelectionState,
    readFabMode,
    writeFabMode,
    formatDateTime,
    getSelectorSummary,
    getTextExcerpt,
    getPageSummary,
    formatPosition,
    buildRecordSearchIndex,
    buildRecordMarkdown,
    buildSourceLocatorText,
    buildCursorPromptText,
    downloadJsonFile,
  };
})(typeof globalThis !== "undefined" ? globalThis : self);
