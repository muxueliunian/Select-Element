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
    highlightElement: "ESI_HIGHLIGHT_ELEMENT",
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
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
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

  // 元素上能被人读懂的文字：优先可见文本，其次是输入框占位符等属性
  function getTextExcerpt(record) {
    if (!record) {
      return "";
    }
    const attributes = record.attributes || {};
    const label =
      record.text ||
      attributes.placeholder ||
      attributes["aria-label"] ||
      attributes.title ||
      attributes.alt ||
      "";
    return truncateText(collapseWhitespace(label), 80);
  }

  function getPageSummary(record) {
    const title = collapseWhitespace(record && record.title);
    const url = collapseWhitespace(record && record.url);
    return truncateText(title || url || "未知页面", 120);
  }

  // elementSummary 形如「输入框，内容“…”，尺寸 …」，第一段即元素类型
  function getElementKind(record) {
    const summary = collapseWhitespace(record && record.elementSummary);
    const kind = summary ? summary.split("，")[0] : "";
    return kind || (record && record.tagName) || "元素";
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

  // 去掉查询参数（可能含 token），只保留 hash 路由
  function formatPageUrl(url) {
    try {
      const parsed = new URL(url);
      const base =
        parsed.origin && parsed.origin !== "null"
          ? parsed.origin
          : `${parsed.protocol}//${parsed.host}`;
      const hashRoute = parsed.hash.startsWith("#/") ? parsed.hash : "";
      return `${base}${parsed.pathname}${hashRoute}`;
    } catch (error) {
      return String(url || "");
    }
  }

  function getComponentHints(record) {
    const hints = (record && record.frameworkHints) || {};
    const react = hints.react;
    const vue = hints.vue;

    if (react && ((react.componentChain || []).length || react.debugSource)) {
      return { chain: react.componentChain || [], source: react.debugSource || "" };
    }
    if (vue && ((vue.componentChain || []).length || vue.singleFileComponent)) {
      return { chain: vue.componentChain || [], source: vue.singleFileComponent || "" };
    }
    return null;
  }

  // 元素签名里已有 type / aria-label / class，这里只补充其余可搜索的属性
  const PROMPT_ATTRIBUTE_NAMES = [
    "data-testid",
    "data-test",
    "data-cy",
    "data-qa",
    "id",
    "name",
    "role",
    "placeholder",
    "title",
    "alt",
    "href",
  ];

  function getPromptAttributes(record) {
    const attributes = {
      ...((record && record.attributes) || {}),
      id: (record && record.idAttribute) || "",
    };
    return PROMPT_ATTRIBUTE_NAMES.filter((name) => attributes[name])
      .slice(0, 4)
      .map((name) => `${name}="${truncateText(collapseWhitespace(attributes[name]), 60)}"`)
      .join(" ");
  }

  // 发给 Agent 的提示词：只保留能在源码里搜到的线索 + 用户需求，
  // 不输出页面坐标、DOM Path、XPath 等运行时信息。
  function buildAgentPrompt(record) {
    if (!record) {
      return "";
    }

    const sourceHints = record.sourceHints || {};
    const position = record.position || {};
    const requirement = String(record.note || "").trim();
    const signature = sourceHints.htmlSignature || `<${record.tagName || "unknown"}>`;
    const size =
      position.width || position.height
        ? `（${roundNumber(position.width, 0)}×${roundNumber(position.height, 0)}）`
        : "";
    const text = sourceHints.visibleText || truncateText(collapseWhitespace(record.text), 80);
    const attributes = getPromptAttributes(record);
    const component = getComponentHints(record);

    const lines = [
      requirement
        ? "请在项目源码中找到下面这个网页元素对应的代码，并按需求修改。"
        : "请在项目源码中找到下面这个网页元素对应的代码。",
      "",
      `页面：${record.title || "未知页面"}（${formatPageUrl(record.url)}）`,
      `元素：${signature}${size}`,
    ];

    if (text) {
      lines.push(`文本：“${text}”`);
    }
    if (attributes) {
      lines.push(`属性：${attributes}`);
    }
    if (component && component.chain.length) {
      lines.push(`组件：${component.chain.slice(0, 6).reverse().join(" > ")}`);
    }
    if (component && component.source) {
      lines.push(`源码：${component.source}`);
    }
    if (sourceHints.parentClassSummary) {
      lines.push(`父容器：class="${sourceHints.parentClassSummary}"`);
    }
    if (text && sourceHints.i18nRisk && !component) {
      lines.push("提示：文案可能来自 i18n 配置，直接搜文本找不到时，改用 class 或属性搜索。");
    }

    if (requirement) {
      lines.push("", requirement.includes("\n") ? `需求：\n${requirement}` : `需求：${requirement}`);
    }

    return lines.join("\n");
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
    getElementKind,
    formatPageUrl,
    buildRecordSearchIndex,
    buildAgentPrompt,
    downloadJsonFile,
  };
})(typeof globalThis !== "undefined" ? globalThis : self);
