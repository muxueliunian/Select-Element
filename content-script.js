(() => {
  if (globalThis.__elementSnapshotInspectorLoaded) {
    return;
  }
  globalThis.__elementSnapshotInspectorLoaded = true;

  // utils.js 在 manifest content_scripts / executeScript 中始终先于本文件加载，
  // 因此 ElementSnapshotUtils 一定可用，常量与工具函数直接复用，避免重复实现漂移。
  const sharedUtils = globalThis.ElementSnapshotUtils;
  const MESSAGE_TYPES = sharedUtils.MESSAGE_TYPES;
  const { collapseWhitespace, truncateText, roundNumber, generateId } = sharedUtils;

  const DOM_IDS = {
    root: "__esi-root",
    overlay: "__esi-overlay",
    overlayLabel: "__esi-overlay-label",
    hint: "__esi-hint",
    fab: "__esi-fab-host",
  };

  const FAB_STYLES = `
    :host {
      all: initial;
      position: fixed;
      z-index: 2147483647;
      display: block;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    .fab-wrap {
      position: relative;
      width: 44px;
      height: 44px;
    }
    :host(.snap-left) .fab-menu {
      transform-origin: bottom left;
      left: calc(100% + 8px);
      right: auto;
    }
    .fab-menu {
      position: absolute;
      right: calc(100% + 8px);
      bottom: 0;
      display: flex;
      flex-direction: column;
      gap: 6px;
      background: #ffffff;
      border: 1px solid #e2e8f0;
      border-radius: 10px;
      padding: 8px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.12);
      min-width: 148px;
      transform-origin: bottom right;
      transition: opacity 0.15s ease, transform 0.15s ease;
      z-index: 1;
    }
    .fab-menu[hidden] {
      display: none;
    }
    .fab-menu-item {
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      padding: 8px 10px;
      border: none;
      border-radius: 6px;
      background: transparent;
      color: #0f172a;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      white-space: nowrap;
      text-align: left;
      transition: background 0.15s ease;
    }
    .fab-menu-item:hover {
      background: #f1f5f9;
    }
    .fab-menu-item.danger {
      color: #ef4444;
    }
    .fab-menu-item.danger:hover {
      background: #fef2f2;
    }
    .fab-menu-item .icon {
      width: 16px;
      height: 16px;
      flex: none;
      opacity: 0.7;
    }
    .fab-divider {
      height: 1px;
      background: #e2e8f0;
      margin: 2px 0;
    }
    .fab-btn {
      position: absolute;
      right: 0;
      bottom: 0;
      width: 44px;
      height: 44px;
      border-radius: 50%;
      border: 2px solid #e2e8f0;
      background: #ffffff;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 4px 12px rgba(0,0,0,0.12);
      transition: border-color 0.2s ease, transform 0.2s ease, box-shadow 0.2s ease;
      flex: none;
      padding: 0;
      overflow: hidden;
    }
    .fab-btn:hover {
      border-color: #cbd5e1;
      box-shadow: 0 6px 16px rgba(0,0,0,0.18);
    }
    .fab-btn.is-active {
      border-color: #16a34a;
      box-shadow: 0 4px 12px rgba(22,163,74,0.3);
    }
    .fab-btn.is-active:hover {
      border-color: #15803d;
    }
    .fab-btn img {
      width: 28px;
      height: 28px;
      pointer-events: none;
      border-radius: 50%;
      object-fit: cover;
    }
    .fab-btn svg {
      width: 20px;
      height: 20px;
      pointer-events: none;
    }
    .fab-status {
      position: absolute;
      top: -4px;
      right: -4px;
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: #16a34a;
      border: 2px solid #ffffff;
      display: none;
    }
    .fab-btn.is-active .fab-status {
      display: block;
    }
  `;

  const FAB_MODE = sharedUtils.FAB_MODES;

  const fabState = {
    host: null,
    shadow: null,
    documentClickHandler: null,
    open: false,
    dragging: false,
    dragStartX: 0,
    dragStartY: 0,
    dragStartLeft: 0,
    dragStartTop: 0,
    currentLeft: -1,   // -1 = 未初始化，首次由 initFabPosition() 设置
    currentTop: -1,
    snapSide: "right",  // "left" | "right"
    enabledForThisTab: false,
    resizeHandler: null,
    resizeRafId: 0,
  };

  const LIMITS = {
    html: 12000,
    text: 1200,
    attrValue: 500,
  };

  const SAFE_DATA_ATTRIBUTE_NAMES = [
    "data-testid",
    "data-test",
    "data-qa",
    "data-cy",
    "data-component",
    "data-component-id",
    "data-role",
    "data-slot",
    "data-variant",
    "data-state",
    "data-id",
  ];

  const state = {
    active: false,
    root: null,
    overlay: null,
    overlayLabel: null,
    hint: null,
    currentElement: null,
    rafId: 0,
    pointerX: 0,
    pointerY: 0,
  };

  const previewState = {
    active: false,
    element: null,
    originalStyle: null,
    overlayEl: null,
    handleHost: null,
    dragState: null,
    trackHandler: null,
    trackRafId: 0,
  };

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || !message.type) {
      return false;
    }

    if (message.type === MESSAGE_TYPES.ping) {
      sendResponse({
        ready: true,
        active: state.active,
      });
      return true;
    }

    if (message.type === MESSAGE_TYPES.startSelection) {
      startSelection()
        .then((result) => sendResponse({ ok: true, ...result }))
        .catch((error) =>
          sendResponse({
            ok: false,
            error: error && error.message ? error.message : "开启选择模式失败。",
          })
        );
      return true;
    }

    if (message.type === MESSAGE_TYPES.stopSelection) {
      stopSelection({
        notifyBackground: false,
      });
      sendResponse({
        ok: true,
        active: false,
      });
      return true;
    }

    if (message.type === MESSAGE_TYPES.fabModeChanged) {
      handleFabModeChange(message.payload);
      sendResponse({ ok: true });
      return true;
    }

    if (message.type === MESSAGE_TYPES.previewElement) {
      const result = applyPreviewToElement(message.payload.record, {
        width: message.payload.width,
        height: message.payload.height,
      });
      sendResponse(result);
      return true;
    }

    if (message.type === MESSAGE_TYPES.clearElementPreview) {
      const result = clearPreview();
      sendResponse(result);
      return true;
    }

    return false;
  });

  function resolveElementFromRecord(record) {
    if (!record) return null;

    if (record.cssSelector) {
      try {
        const el = document.querySelector(record.cssSelector);
        if (el && (!record.tagName || el.tagName.toLowerCase() === record.tagName.toLowerCase())) {
          return el;
        }
      } catch (e) {
        // invalid selector, fall through
      }
    }

    if (record.xpath) {
      try {
        const result = document.evaluate(
          record.xpath,
          document,
          null,
          XPathResult.FIRST_ORDERED_NODE_TYPE,
          null
        );
        if (result.singleNodeValue instanceof HTMLElement) {
          return result.singleNodeValue;
        }
      } catch (e) {
        // invalid xpath, fall through
      }
    }

    return null;
  }

  function createPreviewOverlay(element) {
    let overlay = previewState.overlayEl;
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.className = "__esi-preview-highlight";
      document.body.appendChild(overlay);
      previewState.overlayEl = overlay;
    }

    updatePreviewOverlayPosition(element);
    createDragHandles(element);
    startPreviewTracking();
    return overlay;
  }

  // 预览高亮框/手柄使用 position:fixed + getBoundingClientRect，页面滚动或窗口缩放后
  // 会与目标元素错位。激活期间监听 scroll/resize（rAF 节流）实时重定位。
  function startPreviewTracking() {
    if (previewState.trackHandler) {
      return;
    }
    previewState.trackHandler = () => {
      if (previewState.trackRafId) {
        return;
      }
      previewState.trackRafId = requestAnimationFrame(() => {
        previewState.trackRafId = 0;
        if (previewState.active && previewState.element) {
          updatePreviewOverlayPosition(previewState.element);
        }
      });
    };
    window.addEventListener("scroll", previewState.trackHandler, true);
    window.addEventListener("resize", previewState.trackHandler, true);
  }

  function stopPreviewTracking() {
    if (previewState.trackHandler) {
      window.removeEventListener("scroll", previewState.trackHandler, true);
      window.removeEventListener("resize", previewState.trackHandler, true);
      previewState.trackHandler = null;
    }
    if (previewState.trackRafId) {
      cancelAnimationFrame(previewState.trackRafId);
      previewState.trackRafId = 0;
    }
  }

  function updatePreviewOverlayPosition(element) {
    const overlay = previewState.overlayEl;
    if (!overlay) return;

    const rect = element.getBoundingClientRect();
    overlay.style.cssText = [
      "position:fixed",
      "pointer-events:none",
      "z-index:2147483645",
      "border:2px dashed rgba(255,152,0,0.9)",
      "background:rgba(255,152,0,0.08)",
      "border-radius:4px",
      "box-shadow:0 0 0 1px rgba(255,255,255,0.6),0 4px 12px rgba(255,152,0,0.2)",
      "transition:none",
      "left:" + rect.left + "px",
      "top:" + rect.top + "px",
      "width:" + rect.width + "px",
      "height:" + rect.height + "px",
    ].join(";");

    // Update handle positions too
    if (previewState.handleHost) {
      positionDragHandles(rect);
    }
  }

  const DRAG_HANDLE_STYLES = `
    :host {
      all: initial;
      position: fixed;
      z-index: 2147483646;
      pointer-events: none;
      display: block;
    }
    .handle {
      position: fixed;
      width: 10px;
      height: 10px;
      background: #fff;
      border: 2px solid rgba(255,152,0,0.9);
      border-radius: 2px;
      pointer-events: auto;
      z-index: 2147483646;
      box-shadow: 0 1px 4px rgba(0,0,0,0.18);
    }
    .handle-e, .handle-w { cursor: ew-resize; }
    .handle-s, .handle-n { cursor: ns-resize; }
    .handle-se { cursor: nwse-resize; }
    .handle-sw { cursor: nesw-resize; }
    .handle-ne { cursor: nesw-resize; }
    .handle-nw { cursor: nwse-resize; }
  `;

  function createDragHandles(element) {
    removeDragHandles();

    const host = document.createElement("div");
    host.id = "__esi-drag-handles";
    const shadow = host.attachShadow({ mode: "closed" });

    const style = document.createElement("style");
    style.textContent = DRAG_HANDLE_STYLES;
    shadow.appendChild(style);

    const dirs = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];
    dirs.forEach((dir) => {
      const h = document.createElement("div");
      h.className = "handle handle-" + dir;
      h.dataset.dir = dir;
      h.addEventListener("mousedown", onHandleMouseDown);
      shadow.appendChild(h);
    });

    document.body.appendChild(host);
    previewState.handleHost = host;
    previewState.handleShadow = shadow;

    const rect = element.getBoundingClientRect();
    positionDragHandles(rect);
  }

  function positionDragHandles(rect) {
    const shadow = previewState.handleShadow;
    if (!shadow) return;

    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const map = {
      n:  { left: cx - 5, top: rect.top - 5 },
      s:  { left: cx - 5, top: rect.top + rect.height - 5 },
      e:  { left: rect.left + rect.width - 5, top: cy - 5 },
      w:  { left: rect.left - 5, top: cy - 5 },
      ne: { left: rect.left + rect.width - 5, top: rect.top - 5 },
      nw: { left: rect.left - 5, top: rect.top - 5 },
      se: { left: rect.left + rect.width - 5, top: rect.top + rect.height - 5 },
      sw: { left: rect.left - 5, top: rect.top + rect.height - 5 },
    };

    shadow.querySelectorAll(".handle").forEach((h) => {
      const pos = map[h.dataset.dir];
      if (pos) {
        h.style.left = pos.left + "px";
        h.style.top = pos.top + "px";
      }
    });
  }

  function removeDragHandles() {
    if (previewState.handleHost) {
      previewState.handleHost.remove();
      previewState.handleHost = null;
      previewState.handleShadow = null;
    }
  }

  function onHandleMouseDown(e) {
    if (!previewState.active || !previewState.element) return;
    e.preventDefault();
    e.stopPropagation();

    const el = previewState.element;
    const rect = el.getBoundingClientRect();
    previewState.dragState = {
      dir: e.currentTarget.dataset.dir,
      startX: e.clientX,
      startY: e.clientY,
      startWidth: rect.width,
      startHeight: rect.height,
      startLeft: rect.left,
      startTop: rect.top,
    };

    document.addEventListener("mousemove", onHandleMouseMove, true);
    document.addEventListener("mouseup", onHandleMouseUp, true);
  }

  function onHandleMouseMove(e) {
    const ds = previewState.dragState;
    if (!ds || !previewState.element) return;
    e.preventDefault();

    const el = previewState.element;
    const dx = e.clientX - ds.startX;
    const dy = e.clientY - ds.startY;
    const dir = ds.dir;

    let newWidth = ds.startWidth;
    let newHeight = ds.startHeight;

    if (dir.includes("e")) newWidth = Math.max(20, ds.startWidth + dx);
    if (dir.includes("w")) newWidth = Math.max(20, ds.startWidth - dx);
    if (dir.includes("s")) newHeight = Math.max(20, ds.startHeight + dy);
    if (dir.includes("n")) newHeight = Math.max(20, ds.startHeight - dy);

    el.style.width = Math.round(newWidth) + "px";
    el.style.height = Math.round(newHeight) + "px";

    updatePreviewOverlayPosition(el);
  }

  function onHandleMouseUp(e) {
    document.removeEventListener("mousemove", onHandleMouseMove, true);
    document.removeEventListener("mouseup", onHandleMouseUp, true);

    if (!previewState.element) {
      previewState.dragState = null;
      return;
    }

    const computed = getComputedStyle(previewState.element);
    const width = computed.width;
    const height = computed.height;

    previewState.dragState = null;

    // Notify sidepanel of new size
    try {
      chrome.runtime.sendMessage({
        type: MESSAGE_TYPES.previewSizeChanged,
        payload: { width, height },
      });
    } catch (err) {
      // sidepanel might be closed
    }
  }

  function removePreviewOverlay() {
    stopPreviewTracking();
    if (previewState.overlayEl) {
      previewState.overlayEl.remove();
      previewState.overlayEl = null;
    }
    removeDragHandles();
  }

  function applyPreviewToElement(record, size) {
    // Clear any existing preview first
    if (previewState.active) {
      clearPreview();
    }

    const element = resolveElementFromRecord(record);
    if (!element) {
      return {
        ok: false,
        error: "无法定位目标元素，可能页面已刷新或 DOM 已变化。",
      };
    }

    // Detect inline elements where width/height won't take effect
    const display = getComputedStyle(element).display;
    const isInline = display === "inline";

    previewState.originalStyle = element.style.cssText;
    previewState.element = element;
    previewState.active = true;

    if (size.width) {
      element.style.width = size.width;
    }
    if (size.height) {
      element.style.height = size.height;
    }

    createPreviewOverlay(element);

    if (isInline && (size.width || size.height)) {
      return {
        ok: true,
        warning: "目标元素是 inline 元素，宽高设置可能不会生效。建议先改为 inline-block 或 block。",
      };
    }

    return { ok: true };
  }

  function clearPreview() {
    if (!previewState.active) {
      return { ok: true };
    }

    document.removeEventListener("mousemove", onHandleMouseMove, true);
    document.removeEventListener("mouseup", onHandleMouseUp, true);
    previewState.dragState = null;

    if (previewState.element) {
      previewState.element.style.cssText = previewState.originalStyle || "";
    }

    removePreviewOverlay();

    previewState.active = false;
    previewState.element = null;
    previewState.originalStyle = null;

    return { ok: true };
  }

  // Clean up preview on visibility change (tab switch)
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && previewState.active) {
      clearPreview();
    }
  });

  // ESC exits preview mode
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && previewState.active && !state.active) {
      clearPreview();
    }
  }, true);

  function startSelection() {
    if (state.active) {
      showHint("点击任意元素进行采集，按 ESC 退出");
      return Promise.resolve({ alreadyActive: true });
    }

    // Close the FAB menu before entering selection mode.
    if (fabState.shadow) {
      closeFabMenu(fabState.shadow);
    }

    ensureUi();
    state.active = true;
    document.documentElement.classList.add("__esi-selection-active");
    addEventListeners();
    showHint("点击任意元素进行采集，按 ESC 退出");
    updateFabActiveState(true);

    const initialX = Math.min(Math.max(window.innerWidth / 2, 0), window.innerWidth);
    const initialY = Math.min(
      Math.max(window.innerHeight / 2, 0),
      window.innerHeight
    );
    updateOverlayFromPoint(initialX, initialY);

    return Promise.resolve({ alreadyActive: false });
  }

  function stopSelection(options) {
    const notifyBackground = Boolean(options && options.notifyBackground);

    if (state.rafId) {
      cancelAnimationFrame(state.rafId);
      state.rafId = 0;
    }

    removeEventListeners();
    state.active = false;
    state.currentElement = null;
    document.documentElement.classList.remove("__esi-selection-active");
    destroyUi();
    updateFabActiveState(false);

    if (notifyBackground) {
      safeSendRuntimeMessage({
        type: MESSAGE_TYPES.selectionStopped,
        payload: {
          reason: options && options.reason ? options.reason : "stopped",
        },
      });
    }
  }

  function ensureUi() {
    if (state.root && document.contains(state.root)) {
      return;
    }

    const mountTarget = document.documentElement || document.body;
    if (!mountTarget) {
      throw new Error("当前页面尚未准备好。");
    }

    const root = document.createElement("div");
    root.id = DOM_IDS.root;

    const overlay = document.createElement("div");
    overlay.id = DOM_IDS.overlay;

    const overlayLabel = document.createElement("div");
    overlayLabel.id = DOM_IDS.overlayLabel;
    overlay.appendChild(overlayLabel);

    const hint = document.createElement("div");
    hint.id = DOM_IDS.hint;

    root.appendChild(overlay);
    root.appendChild(hint);
    mountTarget.appendChild(root);

    state.root = root;
    state.overlay = overlay;
    state.overlayLabel = overlayLabel;
    state.hint = hint;
  }

  function destroyUi() {
    if (state.root && state.root.remove) {
      state.root.remove();
    }
    state.root = null;
    state.overlay = null;
    state.overlayLabel = null;
    state.hint = null;
  }

  function addEventListeners() {
    document.addEventListener("mousemove", handleMouseMove, true);
    document.addEventListener("click", handleClick, true);
    document.addEventListener("mousedown", suppressMouseEvent, true);
    document.addEventListener("mouseup", suppressMouseEvent, true);
    document.addEventListener("pointerdown", suppressMouseEvent, true);
    document.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("scroll", handleViewportChange, true);
    window.addEventListener("resize", handleViewportChange, true);
    document.addEventListener("visibilitychange", handleVisibilityChange, true);
  }

  function removeEventListeners() {
    document.removeEventListener("mousemove", handleMouseMove, true);
    document.removeEventListener("click", handleClick, true);
    document.removeEventListener("mousedown", suppressMouseEvent, true);
    document.removeEventListener("mouseup", suppressMouseEvent, true);
    document.removeEventListener("pointerdown", suppressMouseEvent, true);
    document.removeEventListener("keydown", handleKeyDown, true);
    window.removeEventListener("scroll", handleViewportChange, true);
    window.removeEventListener("resize", handleViewportChange, true);
    document.removeEventListener("visibilitychange", handleVisibilityChange, true);
  }

  function handleMouseMove(event) {
    if (!state.active) {
      return;
    }

    state.pointerX = event.clientX;
    state.pointerY = event.clientY;
    scheduleOverlayUpdate();
  }

  function handleViewportChange() {
    if (!state.active) {
      return;
    }

    scheduleOverlayUpdate();
  }

  function handleVisibilityChange() {
    if (!state.active || !document.hidden) {
      return;
    }

    stopSelection({
      notifyBackground: true,
      reason: "hidden",
    });
  }

  function scheduleOverlayUpdate() {
    if (state.rafId) {
      cancelAnimationFrame(state.rafId);
    }

    state.rafId = requestAnimationFrame(() => {
      state.rafId = 0;
      updateOverlayFromPoint(state.pointerX, state.pointerY);
    });
  }

  function updateOverlayFromPoint(clientX, clientY) {
    if (!state.overlay) {
      return;
    }

    const element =
      typeof clientX === "number" && typeof clientY === "number"
        ? document.elementFromPoint(clientX, clientY)
        : state.currentElement;

    if (!element || shouldIgnoreElement(element)) {
      hideOverlay();
      return;
    }

    state.currentElement = element;
    updateOverlayForElement(element);
  }

  function updateOverlayForElement(element) {
    const rect = element.getBoundingClientRect();
    if (!state.overlay || !state.overlayLabel) {
      return;
    }

    if (rect.width <= 0 || rect.height <= 0) {
      hideOverlay();
      return;
    }

    const tagName = element.tagName.toLowerCase();
    const classSummary = Array.from(element.classList || [])
      .slice(0, 2)
      .map((item) => `.${item}`)
      .join("");
    const idSummary = element.id ? `#${element.id}` : "";
    const labelText = `${tagName}${idSummary}${classSummary} · ${Math.round(
      rect.width
    )}×${Math.round(rect.height)}`;

    state.overlay.style.display = "block";
    state.overlay.style.left = `${rect.left}px`;
    state.overlay.style.top = `${rect.top}px`;
    state.overlay.style.width = `${rect.width}px`;
    state.overlay.style.height = `${rect.height}px`;
    state.overlayLabel.textContent = labelText;
  }

  function hideOverlay() {
    if (state.overlay) {
      state.overlay.style.display = "none";
    }
    state.currentElement = null;
  }

  function showHint(text) {
    ensureUi();
    if (state.hint) {
      state.hint.textContent = text;
    }
  }

  function suppressMouseEvent(event) {
    if (!state.active) {
      return;
    }

    const target = resolveTarget(event);
    if (!target) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === "function") {
      event.stopImmediatePropagation();
    }
  }

  function handleClick(event) {
    if (!state.active) {
      return;
    }

    const target = resolveTarget(event);
    if (!target) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === "function") {
      event.stopImmediatePropagation();
    }

    try {
      const snapshot = getElementSnapshot(target);

      // 停止选择模式（立即恢复页面交互）
      stopSelection({ notifyBackground: false });

      // 发送采集数据到后台（可靠版本）+ 自动复制提示文本
      sendMessageToBackground({
        type: MESSAGE_TYPES.elementCaptured,
        payload: snapshot,
      })
        .then(() => {
          const promptText = buildPromptText(snapshot);
          return copyToClipboard(promptText).then(() => {
            showToast("已采集，预制提示词已复制到剪贴板");
          });
        })
        .catch((error) => {
          console.error("元素采集后处理失败：", error);
          showToast("已采集，但复制失败");
        });
    } catch (error) {
      stopSelection({
        notifyBackground: true,
        reason: "capture-error",
      });
      console.error("元素采集失败：", error);
    }
  }

  function handleKeyDown(event) {
    if (!state.active) {
      return;
    }

    if (event.key !== "Escape") {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === "function") {
      event.stopImmediatePropagation();
    }

    stopSelection({
      notifyBackground: true,
      reason: "esc",
    });
  }

  function resolveTarget(event) {
    const target = event && event.target instanceof Element ? event.target : null;
    if (!target || shouldIgnoreElement(target)) {
      return null;
    }
    return target;
  }

  function shouldIgnoreElement(element) {
    if (!(element instanceof Element)) {
      return true;
    }

    if (state.root && state.root.contains(element)) {
      return true;
    }

    // Ignore the FAB host element so it is never accidentally captured.
    if (fabState.host && (element === fabState.host || fabState.host.contains(element))) {
      return true;
    }

    const tagName = element.tagName.toLowerCase();
    return ["html", "script", "style", "meta", "link"].includes(tagName);
  }

  // 消息发送：fire-and-forget，用于非关键通知
  function safeSendRuntimeMessage(message) {
    try {
      chrome.runtime.sendMessage(message, () => {
        void chrome.runtime.lastError;
      });
    } catch (error) {
      // Ignore messaging failures when the extension context is updating.
    }
  }

  // 消息发送：可靠的 Promise 版本，用于关键操作（如元素采集）
  function sendMessageToBackground(message) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }

          if (!response || response.ok === false) {
            reject(
              new Error(
                (response && response.error) || "后台未能完成当前操作。"
              )
            );
            return;
          }

          if (response.ok === true) {
            resolve(response);
            return;
          }

          resolve(response);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  // ── 提示文本生成 & 剪贴板 ───────────────────────────────────────────────────

  function buildPromptText(snapshot) {
    return sharedUtils.buildAgentTaskPrompt(snapshot);
  }

  async function copyToClipboard(text) {
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
        await navigator.clipboard.writeText(text);
        return;
      }
    } catch (_) {
      // Clipboard API may be blocked by page permissions policy.
    }

    // Fallback: execCommand
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "true");
    textarea.style.cssText = "position:fixed;left:-9999px;top:-9999px;opacity:0";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  }

  // 轻量 toast：不依赖选择模式 UI，可在任何时候显示
  function showToast(text, durationMs) {
    const TOAST_ID = "__esi-toast";
    let existing = document.getElementById(TOAST_ID);
    if (existing) existing.remove();

    const el = document.createElement("div");
    el.id = TOAST_ID;
    el.textContent = text;
    el.style.cssText = [
      "position:fixed",
      "left:50%",
      "bottom:48px",
      "transform:translateX(-50%)",
      "z-index:2147483647",
      "padding:8px 18px",
      "border-radius:8px",
      "background:#0f172a",
      "color:#fff",
      "font:500 13px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
      "box-shadow:0 4px 12px rgba(0,0,0,0.18)",
      "pointer-events:none",
      "opacity:0",
      "transition:opacity 0.2s ease",
    ].join(";");
    document.documentElement.appendChild(el);

    // fade in
    requestAnimationFrame(() => { el.style.opacity = "1"; });

    setTimeout(() => {
      el.style.opacity = "0";
      setTimeout(() => el.remove(), 250);
    }, durationMs || 2000);
  }

  // collapseWhitespace / truncateText / roundNumber / generateId 复用 utils.js（见顶部解构）。
  // truncateRaw 与 truncateText 不同：它对超长 HTML 追加注释标记，故保留为本地实现。
  function truncateRaw(value, maxLength) {
    const text = String(value || "");
    if (text.length <= maxLength) {
      return text;
    }
    return `${text.slice(0, maxLength)}\n<!-- 已截断 -->`;
  }

  function getElementSnapshot(element) {
    const rect = element.getBoundingClientRect();
    const pageTop = roundNumber(rect.top + window.scrollY);
    const pageLeft = roundNumber(rect.left + window.scrollX);
    const tagName = element.tagName.toLowerCase();
    const text = getElementText(element);
    const attributes = getElementAttributes(element);
    const frameworkHints = getFrameworkHints(element);
    const sourceHints = getSourceHints(element, text, attributes, frameworkHints);

    return {
      id: generateId(),
      timestamp: Date.now(),
      url: window.location.href,
      title: document.title || "",
      domPath: getDomPath(element),
      cssSelector: getCssSelector(element),
      xpath: getXPath(element),
      tagName,
      idAttribute: element.id || "",
      classList: Array.from(element.classList || []),
      text,
      html: truncateRaw(getSanitizedOuterHtml(element), LIMITS.html),
      position: {
        top: pageTop,
        left: pageLeft,
        width: roundNumber(rect.width),
        height: roundNumber(rect.height),
      },
      attributes,
      parentSummary: getParentSummary(element),
      ancestorSummary: getAncestorSummary(element),
      childrenCount: element.children ? element.children.length : 0,
      isVisible: isElementVisible(element),
      viewport: {
        windowWidth: window.innerWidth,
        windowHeight: window.innerHeight,
        scrollX: roundNumber(window.scrollX),
        scrollY: roundNumber(window.scrollY),
      },
      elementSummary: getElementSummary(element, rect, text, attributes),
      frameworkHints,
      sourceHints,
      note: "",
    };
  }

  function getElementText(element) {
    if (!element) {
      return "";
    }

    if (element.tagName && element.tagName.toLowerCase() === "input") {
      const input = element;
      const type = String(input.type || "").toLowerCase();
      if (["button", "submit", "reset"].includes(type)) {
        return truncateText(collapseWhitespace(input.value || ""), LIMITS.text);
      }
    }

    const rawText =
      typeof element.innerText === "string"
        ? element.innerText
        : element.textContent || "";
    return truncateText(collapseWhitespace(rawText), LIMITS.text);
  }

  function getElementAttributes(element) {
    const attributes = {};
    const baseAttributes = [
      "role",
      "name",
      "type",
      "href",
      "src",
      "alt",
      "title",
      "placeholder",
    ];

    baseAttributes.forEach((name) => {
      const value = element.getAttribute(name);
      if (value) {
        attributes[name] = truncateText(value, LIMITS.attrValue);
      }
    });

    if (shouldExposeValue(element)) {
      const value = getInputValue(element);
      if (value) {
        attributes.value = truncateText(maskCapturedValue(value), LIMITS.attrValue);
      }
    }

    Array.from(element.attributes || []).forEach((attr) => {
      if (!attr || !attr.name) {
        return;
      }

      if (attr.name.startsWith("aria-")) {
        attributes[attr.name] = truncateText(attr.value, LIMITS.attrValue);
      }

      if (attr.name.startsWith("data-") && shouldCaptureDataAttribute(attr.name, attr.value)) {
        attributes[attr.name] = truncateText(sanitizeDataAttributeValue(attr.value), LIMITS.attrValue);
      }
    });

    return attributes;
  }

  function shouldExposeValue(element) {
    if (!(element instanceof Element)) {
      return false;
    }

    const tagName = element.tagName.toLowerCase();
    if (tagName === "textarea" || tagName === "select") {
      return true;
    }

    if (tagName !== "input") {
      return false;
    }

    const type = String(element.getAttribute("type") || "text").toLowerCase();
    return !["password", "hidden", "file"].includes(type);
  }

  function getInputValue(element) {
    if (!("value" in element)) {
      return "";
    }
    return collapseWhitespace(element.value || "");
  }

  function maskCapturedValue(value) {
    const text = collapseWhitespace(value);
    if (!text) {
      return "";
    }
    return `[masked:${text.length}]`;
  }

  function shouldCaptureDataAttribute(name, value) {
    const normalizedName = String(name || "").toLowerCase();
    const normalizedValue = collapseWhitespace(value);

    if (!normalizedName || !normalizedValue) {
      return false;
    }

    if (SAFE_DATA_ATTRIBUTE_NAMES.includes(normalizedName)) {
      return true;
    }

    if (isSensitiveAttributeName(normalizedName) || looksSensitiveValue(normalizedValue)) {
      return false;
    }

    return normalizedValue.length <= 80;
  }

  function sanitizeDataAttributeValue(value) {
    const normalizedValue = collapseWhitespace(value);
    if (!normalizedValue) {
      return "";
    }

    if (looksSensitiveValue(normalizedValue)) {
      return maskCapturedValue(normalizedValue);
    }

    return normalizedValue;
  }

  function isSensitiveAttributeName(name) {
    return /(token|secret|auth|session|cookie|password|passwd|pwd|bearer|csrf|xsrf|email|phone|mobile|tel)/i.test(
      String(name || "")
    );
  }

  function looksSensitiveValue(value) {
    const text = collapseWhitespace(value);
    if (!text) {
      return false;
    }

    return (
      /@/.test(text) ||
      /(?:^|\b)(?:\+?\d[\d\s-]{7,}\d)(?:\b|$)/.test(text) ||
      /(?:token|secret|bearer|authorization|session)=/i.test(text) ||
      /^[A-Za-z0-9+/_=-]{24,}$/.test(text)
    );
  }

  function getSanitizedOuterHtml(element) {
    if (!(element instanceof Element)) {
      return "";
    }

    const clone = element.cloneNode(true);
    sanitizeElementTree(clone);
    return clone.outerHTML || "";
  }

  function sanitizeElementTree(root) {
    if (!(root instanceof Element)) {
      return;
    }

    sanitizeElementNode(root);
    root.querySelectorAll("*").forEach((node) => sanitizeElementNode(node));
  }

  function sanitizeElementNode(node) {
    if (!(node instanceof Element)) {
      return;
    }

    Array.from(node.attributes || []).forEach((attr) => {
      if (!attr || !attr.name) {
        return;
      }

      const attrName = attr.name.toLowerCase();
      if (attrName === "value") {
        node.setAttribute(attr.name, maskCapturedValue(attr.value));
        return;
      }

      if (attrName.startsWith("data-")) {
        if (!shouldCaptureDataAttribute(attrName, attr.value)) {
          node.removeAttribute(attr.name);
          return;
        }

        node.setAttribute(attr.name, sanitizeDataAttributeValue(attr.value));
      }
    });

    const tagName = node.tagName.toLowerCase();
    if (tagName === "textarea") {
      if (node.value) {
        node.textContent = maskCapturedValue(node.value);
      }
      return;
    }

    if (tagName !== "input") {
      return;
    }

    const type = String(node.getAttribute("type") || "text").toLowerCase();
    if (["button", "submit", "reset", "checkbox", "radio", "range"].includes(type)) {
      return;
    }

    const value = typeof node.value === "string" ? node.value : node.getAttribute("value") || "";
    if (value) {
      node.setAttribute("value", maskCapturedValue(value));
    }
  }

  function getParentSummary(element) {
    const parent = element.parentElement;
    if (!parent) {
      return null;
    }

    return {
      tagName: parent.tagName.toLowerCase(),
      idAttribute: parent.id || "",
      classList: Array.from(parent.classList || []).slice(0, 6),
      selector: getNodeDescriptor(parent),
    };
  }

  function getAncestorSummary(element) {
    const ancestors = [];
    let current = element.parentElement;
    let depth = 0;

    while (current && depth < 4) {
      ancestors.push({
        tagName: current.tagName.toLowerCase(),
        idAttribute: current.id || "",
        classList: Array.from(current.classList || []).slice(0, 8),
        selector: getNodeDescriptor(current),
      });
      current = current.parentElement;
      depth += 1;
    }

    return ancestors;
  }

  function getFrameworkHints(element) {
    return {
      react: getReactFrameworkHints(element),
      vue: getVueFrameworkHints(element),
    };
  }

  function getReactFrameworkHints(element) {
    const fiberKey = Object.keys(element).find(
      (key) =>
        key.startsWith("__reactFiber$") || key.startsWith("__reactInternalInstance$")
    );

    if (!fiberKey) {
      return null;
    }

    const chain = [];
    const seen = new Set();
    let debugSource = "";
    let current = element[fiberKey];
    let depth = 0;

    while (current && depth < 12) {
      const name = getReactFiberName(current);
      if (name && !seen.has(name)) {
        seen.add(name);
        chain.push(name);
      }

      if (!debugSource && current._debugSource && current._debugSource.fileName) {
        const source = current._debugSource;
        debugSource = `${source.fileName}:${source.lineNumber || "?"}`;
      }

      current = current.return;
      depth += 1;
    }

    if (!chain.length && !debugSource) {
      return null;
    }

    return {
      componentChain: chain,
      debugSource,
    };
  }

  function getReactFiberName(fiber) {
    if (!fiber) {
      return "";
    }

    const candidates = [fiber.elementType, fiber.type, fiber.pendingProps && fiber.pendingProps.as];
    for (const candidate of candidates) {
      const name = getReactCandidateName(candidate);
      if (name) {
        return name;
      }
    }

    return "";
  }

  function getReactCandidateName(candidate) {
    if (!candidate) {
      return "";
    }

    if (typeof candidate === "string") {
      return "";
    }

    if (typeof candidate === "function") {
      return candidate.displayName || candidate.name || "";
    }

    if (typeof candidate === "object") {
      return (
        candidate.displayName ||
        candidate.name ||
        (candidate.render && (candidate.render.displayName || candidate.render.name)) ||
        ""
      );
    }

    return "";
  }

  function getVueFrameworkHints(element) {
    const instance = element.__vueParentComponent || null;
    if (!instance) {
      return null;
    }

    const chain = [];
    const seen = new Set();
    let singleFileComponent = "";
    let current = instance;
    let depth = 0;

    while (current && depth < 12) {
      const type = current.type || {};
      const name =
        type.name ||
        type.__name ||
        (type.__file ? getFileBaseName(type.__file).replace(/\.\w+$/, "") : "");

      if (name && !seen.has(name)) {
        seen.add(name);
        chain.push(name);
      }

      if (!singleFileComponent && type.__file) {
        singleFileComponent = type.__file;
      }

      current = current.parent;
      depth += 1;
    }

    if (!chain.length && !singleFileComponent) {
      return null;
    }

    return {
      componentChain: chain,
      singleFileComponent,
    };
  }

  function getFileBaseName(path) {
    return String(path || "").split(/[\\/]/).pop() || "";
  }

  function getSourceHints(element, text, attributes, frameworkHints) {
    const searchableClasses = getSearchableClasses(element.classList);
    const parentClasses = getSearchableClasses(
      element.parentElement ? element.parentElement.classList : []
    );
    const keyAttributes = getKeyAttributeEntries(attributes);
    const htmlSignature = buildHtmlSignature(element, searchableClasses);
    const componentQuery = getFrameworkComponentQuery(frameworkHints);
    const visibleText = truncateText(collapseWhitespace(text), 80);
    const attributeSummary = keyAttributes.map(([name, value]) => `${name}="${value}"`).join(" ");
    const classSummary = searchableClasses.slice(0, 8).join(" ");
    const parentClassSummary = parentClasses.slice(0, 8).join(" ");

    const primaryQueries = [
      componentQuery,
      buildAttributeQuery(element.tagName.toLowerCase(), keyAttributes),
      buildClassQuery(element.tagName.toLowerCase(), searchableClasses),
      buildParentContainerQuery(parentClasses),
      htmlSignature,
    ].filter(Boolean);

    const fallbackQueries = [
      visibleText,
      element.getAttribute("aria-label") || "",
      getNodeDescriptor(element.parentElement || element),
      getDomPath(element),
    ]
      .map((item) => truncateText(collapseWhitespace(item), 180))
      .filter(Boolean)
      .filter((item, index, items) => items.indexOf(item) === index);

    return {
      visibleText,
      i18nRisk: hasPotentialI18nRisk(text, attributes, keyAttributes),
      attributeSummary,
      classSummary,
      parentClassSummary,
      primaryQueries,
      fallbackQueries,
      htmlSignature,
    };
  }

  function getFrameworkComponentQuery(frameworkHints) {
    if (
      frameworkHints &&
      frameworkHints.react &&
      Array.isArray(frameworkHints.react.componentChain) &&
      frameworkHints.react.componentChain.length
    ) {
      return frameworkHints.react.componentChain.slice(0, 4).join(" ");
    }

    if (
      frameworkHints &&
      frameworkHints.vue &&
      Array.isArray(frameworkHints.vue.componentChain) &&
      frameworkHints.vue.componentChain.length
    ) {
      return frameworkHints.vue.componentChain.slice(0, 4).join(" ");
    }

    return "";
  }

  function getSearchableClasses(classListLike) {
    return Array.from(classListLike || [])
      .filter(isUsefulClassName)
      .filter((className) => !/^(hover:|focus:|active:|visited:|sm:|md:|lg:|xl:|2xl:|dark:)/.test(className))
      .slice(0, 10);
  }

  function getKeyAttributeEntries(attributes) {
    const preferredOrder = [
      "data-testid",
      "data-test",
      "data-cy",
      "data-qa",
      "aria-label",
      "name",
      "role",
      "type",
      "title",
      "placeholder",
      "href",
      "src",
      "alt",
    ];

    const entries = [];
    preferredOrder.forEach((name) => {
      if (attributes[name]) {
        entries.push([name, attributes[name]]);
      }
    });

    Object.keys(attributes).forEach((name) => {
      if ((name.startsWith("data-") || name.startsWith("aria-")) && !preferredOrder.includes(name)) {
        entries.push([name, attributes[name]]);
      }
    });

    return entries.slice(0, 6);
  }

  function buildAttributeQuery(tagName, keyAttributes) {
    if (!keyAttributes.length) {
      return "";
    }

    const parts = keyAttributes.slice(0, 3).map(([name, value]) => `${name}="${value}"`);
    return `${tagName} ${parts.join(" ")}`;
  }

  function buildClassQuery(tagName, classes) {
    if (!classes.length) {
      return "";
    }
    return `${tagName} ${classes.slice(0, 6).join(" ")}`;
  }

  function buildParentContainerQuery(classes) {
    if (!classes.length) {
      return "";
    }
    return classes.slice(0, 6).join(" ");
  }

  function buildHtmlSignature(element, searchableClasses) {
    const tagName = element.tagName.toLowerCase();
    const attrParts = [];
    const typeValue = element.getAttribute("type");
    const ariaLabel = element.getAttribute("aria-label");

    if (typeValue) {
      attrParts.push(`type="${typeValue}"`);
    }
    if (ariaLabel) {
      attrParts.push(`aria-label="${ariaLabel}"`);
    }

    if (searchableClasses.length) {
      attrParts.push(`class="${searchableClasses.slice(0, 6).join(" ")}"`);
    }

    return `<${tagName}${attrParts.length ? ` ${attrParts.join(" ")}` : ""}>`;
  }

  function hasPotentialI18nRisk(text, attributes, keyAttributes) {
    const hasHumanText = Boolean(collapseWhitespace(text));
    const hasTranslatableAttr = ["aria-label", "title", "placeholder", "alt"].some(
      (name) => Boolean(attributes[name])
    );
    const hasExplicitTestHook = keyAttributes.some(([name]) =>
      ["data-testid", "data-test", "data-cy", "data-qa"].includes(name)
    );

    return (hasHumanText || hasTranslatableAttr) && !hasExplicitTestHook;
  }

  function getElementSummary(element, rect, text, attributes) {
    const tagName = element.tagName.toLowerCase();
    const kind = getReadableElementKind(tagName, attributes.type);
    const label =
      text ||
      attributes.title ||
      attributes.alt ||
      attributes.placeholder ||
      attributes["aria-label"] ||
      attributes.name ||
      "";
    const summaryParts = [
      `${kind}`,
      label ? `内容“${truncateText(label, 60)}”` : null,
      `尺寸 ${Math.round(rect.width)}×${Math.round(rect.height)}`,
      `位置 (${Math.round(rect.left + window.scrollX)}, ${Math.round(
        rect.top + window.scrollY
      )})`,
    ].filter(Boolean);
    return summaryParts.join("，");
  }

  function getReadableElementKind(tagName, type) {
    if (tagName === "input") {
      const inputType = String(type || "").toLowerCase();
      if (inputType === "checkbox") {
        return "复选框";
      }
      if (inputType === "radio") {
        return "单选框";
      }
      if (["button", "submit", "reset"].includes(inputType)) {
        return "按钮";
      }
      return "输入框";
    }

    const map = {
      a: "链接",
      button: "按钮",
      textarea: "文本框",
      select: "下拉框",
      img: "图片",
      svg: "图标",
      form: "表单",
      label: "标签",
      nav: "导航区域",
      header: "页眉区域",
      footer: "页脚区域",
      main: "主体区域",
      section: "区块",
      article: "文章块",
      video: "视频",
      audio: "音频",
    };
    return map[tagName] || `${tagName} 元素`;
  }

  function getDomPath(element) {
    const parts = [];
    let current = element;
    let depth = 0;

    while (current && current.nodeType === Node.ELEMENT_NODE && depth < 8) {
      parts.unshift(getNodeDescriptor(current));
      if (current.id) {
        break;
      }
      current = current.parentElement;
      depth += 1;
    }

    return parts.join(" > ");
  }

  function getNodeDescriptor(element) {
    const tagName = element.tagName.toLowerCase();
    const idPart = element.id ? `#${element.id}` : "";
    const classPart = Array.from(element.classList || [])
      .filter(isUsefulClassName)
      .slice(0, 2)
      .map((item) => `.${item}`)
      .join("");
    let suffix = `${idPart}${classPart}`;

    if (!suffix && element.parentElement && hasSiblingWithSameTag(element)) {
      suffix += `:nth-of-type(${getNthOfTypeIndex(element)})`;
    }

    return `${tagName}${suffix}`;
  }

  function getCssSelector(element) {
    if (!(element instanceof Element)) {
      return "";
    }

    if (element.id && isValidIdentifier(element.id)) {
      const idSelector = `#${escapeCssIdentifier(element.id)}`;
      if (isUniqueSelector(idSelector, element.ownerDocument, element)) {
        return idSelector;
      }
    }

    const parts = [];
    let current = element;
    let depth = 0;

    while (current && current.nodeType === Node.ELEMENT_NODE && depth < 8) {
      const part = buildCssSelectorPart(current);
      parts.unshift(part);
      const selector = parts.join(" > ");
      if (isUniqueSelector(selector, current.ownerDocument, element)) {
        return selector;
      }

      if (current.id) {
        break;
      }

      current = current.parentElement;
      depth += 1;
    }

    return parts.join(" > ");
  }

  function buildCssSelectorPart(element) {
    const tagName = element.tagName.toLowerCase();

    if (element.id && isValidIdentifier(element.id)) {
      return `${tagName}#${escapeCssIdentifier(element.id)}`;
    }

    let part = tagName;
    const usefulClasses = Array.from(element.classList || [])
      .filter(isUsefulClassName)
      .slice(0, 2);

    if (usefulClasses.length) {
      part += usefulClasses.map((name) => `.${escapeCssIdentifier(name)}`).join("");
    }

    if (!usefulClasses.length) {
      const nameAttr = element.getAttribute("name");
      if (nameAttr && nameAttr.length <= 40) {
        part += `[name="${escapeAttributeValue(nameAttr)}"]`;
      }
    }

    if (["input", "button"].includes(tagName)) {
      const typeAttr = element.getAttribute("type");
      if (typeAttr && typeAttr.length <= 40) {
        part += `[type="${escapeAttributeValue(typeAttr)}"]`;
      }
    }

    if (element.parentElement && shouldUseNthOfType(element, part)) {
      part += `:nth-of-type(${getNthOfTypeIndex(element)})`;
    }

    return part;
  }

  function shouldUseNthOfType(element, selectorPart) {
    const parent = element.parentElement;
    if (!parent) {
      return false;
    }

    const sameTagSiblings = Array.from(parent.children).filter(
      (child) => child.tagName === element.tagName
    );

    if (sameTagSiblings.length <= 1) {
      return false;
    }

    try {
      const matches = sameTagSiblings.filter((child) => child.matches(selectorPart));
      return matches.length > 1;
    } catch (error) {
      return true;
    }
  }

  function isUniqueSelector(selector, rootDocument, targetElement) {
    try {
      const matches = rootDocument.querySelectorAll(selector);
      return matches.length === 1 && matches[0] === targetElement;
    } catch (error) {
      return false;
    }
  }

  function getXPath(element) {
    if (!(element instanceof Element)) {
      return "";
    }

    if (element.id) {
      return `//*[@id=${toXPathLiteral(element.id)}]`;
    }

    const MAX_DEPTH = 12;
    const parts = [];
    let current = element;
    let depth = 0;

    while (current && current.nodeType === Node.ELEMENT_NODE && depth < MAX_DEPTH) {
      // 命中带 id 的祖先时以其作为锚点截断，缩短路径并提升稳健性
      if (current !== element && current.id) {
        return `//*[@id=${toXPathLiteral(current.id)}]/${parts.join("/")}`;
      }
      const tagName = current.tagName.toLowerCase();
      const index = getXPathIndex(current);
      parts.unshift(`${tagName}[${index}]`);
      current = current.parentElement;
      depth += 1;
    }

    // 自然到达根节点用绝对路径；因深度上限截断则用 // 锚点，保证 XPath 仍合法
    const reachedRoot = !current || current.nodeType !== Node.ELEMENT_NODE;
    return `${reachedRoot ? "/" : "//"}${parts.join("/")}`;
  }

  function getXPathIndex(element) {
    if (!element.parentElement) {
      return 1;
    }

    const siblings = Array.from(element.parentElement.children).filter(
      (child) => child.tagName === element.tagName
    );
    return siblings.indexOf(element) + 1;
  }

  function toXPathLiteral(value) {
    const text = String(value || "");
    if (!text.includes("'")) {
      return `'${text}'`;
    }
    if (!text.includes('"')) {
      return `"${text}"`;
    }
    return `concat('${text.split("'").join("',\"'\",'")}')`;
  }

  function hasSiblingWithSameTag(element) {
    if (!element.parentElement) {
      return false;
    }

    return Array.from(element.parentElement.children).some(
      (child) => child !== element && child.tagName === element.tagName
    );
  }

  function getNthOfTypeIndex(element) {
    if (!element.parentElement) {
      return 1;
    }

    return (
      Array.from(element.parentElement.children).filter(
        (child) => child.tagName === element.tagName
      ).indexOf(element) + 1
    );
  }

  function isUsefulClassName(className) {
    if (!className) {
      return false;
    }
    return !/^(-|_|ng-|css-|jsx-|sc-)/i.test(className);
  }

  function escapeCssIdentifier(value) {
    if (window.CSS && typeof window.CSS.escape === "function") {
      return window.CSS.escape(value);
    }
    return String(value).replace(/([^\w-])/g, "\\$1");
  }

  function escapeAttributeValue(value) {
    return String(value || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  function isValidIdentifier(value) {
    return /^[A-Za-z_][\w-:.]*$/.test(String(value || ""));
  }

  function isElementVisible(element) {
    if (!(element instanceof Element)) {
      return false;
    }

    const style = window.getComputedStyle(element);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.visibility === "collapse" ||
      Number(style.opacity) === 0
    ) {
      return false;
    }

    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return false;
    }

    return (
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.top < window.innerHeight &&
      rect.left < window.innerWidth
    );
  }

  // ── FAB 悬浮球 ──────────────────────────────────────────────────────────────

  function ensureFab() {
    if (fabState.host && document.contains(fabState.host)) {
      return;
    }

    const host = document.createElement("div");
    host.id = DOM_IDS.fab;
    const shadow = host.attachShadow({ mode: "closed" });

    const style = document.createElement("style");
    style.textContent = FAB_STYLES;

    const wrap = document.createElement("div");
    wrap.className = "fab-wrap";

    // 菜单
    const menu = document.createElement("div");
    menu.className = "fab-menu";
    menu.setAttribute("hidden", "");
    menu.setAttribute("role", "menu");

    const items = [
      { id: "fab-start", label: "开始选择", icon: svgCursor(), cls: "" },
      { id: "fab-stop",  label: "停止选择", icon: svgStop(),   cls: "" },
      { divider: true },
      { id: "fab-close", label: "关闭悬浮球", icon: svgClose(), cls: "danger" },
    ];

    items.forEach((item) => {
      if (item.divider) {
        const hr = document.createElement("div");
        hr.className = "fab-divider";
        menu.appendChild(hr);
        return;
      }
      const btn = document.createElement("button");
      btn.id = item.id;
      btn.className = `fab-menu-item${item.cls ? " " + item.cls : ""}`;
      btn.setAttribute("role", "menuitem");
      btn.type = "button";
      btn.innerHTML = `<span class="icon">${item.icon}</span>${item.label}`;
      menu.appendChild(btn);
    });

    // 主按钮
    const fabBtn = document.createElement("button");
    fabBtn.className = "fab-btn";
    fabBtn.type = "button";
    fabBtn.setAttribute("aria-label", "Select Element 菜单");
    fabBtn.setAttribute("title", "Select Element");

    const fabIcon = document.createElement("img");
    fabIcon.src = chrome.runtime.getURL("icon/icon48.png");
    fabIcon.alt = "Select Element";
    fabIcon.draggable = false;
    fabBtn.appendChild(fabIcon);

    const fabStatusDot = document.createElement("span");
    fabStatusDot.className = "fab-status";
    fabBtn.appendChild(fabStatusDot);

    wrap.appendChild(menu);
    wrap.appendChild(fabBtn);
    shadow.appendChild(style);
    shadow.appendChild(wrap);

    // 主按钮点击：切换菜单
    fabBtn.addEventListener("click", (e) => {
      if (fabState.dragging) return;
      e.stopPropagation();
      toggleFabMenu(shadow);
    });

    // 菜单项点击
    shadow.querySelector("#fab-start").addEventListener("click", () => {
      closeFabMenu(shadow);
      safeSendRuntimeMessage({ type: MESSAGE_TYPES.startSelection });
      startSelection().catch(() => {});
    });

    shadow.querySelector("#fab-stop").addEventListener("click", () => {
      closeFabMenu(shadow);
      stopSelection({ notifyBackground: true, reason: "fab-stop" });
    });

    shadow.querySelector("#fab-close").addEventListener("click", () => {
      destroyFab();
    });

    // 拖拽：自由拖动 FAB，松手后自动吸附到最近的左/右边缘
    const EDGE_MARGIN = 12;
    const FAB_SIZE = 44;
    const SNAP_DURATION = 280; // ms

    function initFabPosition() {
      if (fabState.currentLeft < 0) {
        // 默认：右下角
        fabState.currentLeft = window.innerWidth - FAB_SIZE - EDGE_MARGIN;
        fabState.currentTop = window.innerHeight - FAB_SIZE - 80;
        fabState.snapSide = "right";
      }
    }

    function clampPosition(left, top) {
      const maxLeft = window.innerWidth - FAB_SIZE - EDGE_MARGIN;
      const maxTop = window.innerHeight - FAB_SIZE - EDGE_MARGIN;
      return {
        left: Math.max(EDGE_MARGIN, Math.min(maxLeft, left)),
        top: Math.max(EDGE_MARGIN, Math.min(maxTop, top)),
      };
    }

    function applyPosition(animate) {
      if (!host) return;
      if (animate) {
        host.style.transition = `left ${SNAP_DURATION}ms cubic-bezier(0.25, 1, 0.5, 1), top ${SNAP_DURATION}ms cubic-bezier(0.25, 1, 0.5, 1)`;
      } else {
        host.style.transition = "none";
      }
      host.style.left = `${fabState.currentLeft}px`;
      host.style.top = `${fabState.currentTop}px`;
    }

    function snapToEdge() {
      const centerX = fabState.currentLeft + FAB_SIZE / 2;
      const halfScreen = window.innerWidth / 2;

      if (centerX < halfScreen) {
        fabState.currentLeft = EDGE_MARGIN;
        fabState.snapSide = "left";
      } else {
        fabState.currentLeft = window.innerWidth - FAB_SIZE - EDGE_MARGIN;
        fabState.snapSide = "right";
      }

      // 垂直方向也做边界修正
      const clamped = clampPosition(fabState.currentLeft, fabState.currentTop);
      fabState.currentTop = clamped.top;

      updateSnapClass();
      applyPosition(true);

      // 动画结束后清除 transition
      setTimeout(() => {
        if (host) host.style.transition = "none";
      }, SNAP_DURATION + 20);
    }

    function updateSnapClass() {
      if (!host) return;
      if (fabState.snapSide === "left") {
        host.classList.add("snap-left");
        host.classList.remove("snap-right");
      } else {
        host.classList.add("snap-right");
        host.classList.remove("snap-left");
      }
    }

    fabBtn.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      fabState.dragging = false;
      fabState.dragStartX = e.clientX;
      fabState.dragStartY = e.clientY;
      fabState.dragStartLeft = fabState.currentLeft;
      fabState.dragStartTop = fabState.currentTop;

      const onMove = (me) => {
        const deltaX = me.clientX - fabState.dragStartX;
        const deltaY = me.clientY - fabState.dragStartY;
        if (!fabState.dragging && (Math.abs(deltaX) > 4 || Math.abs(deltaY) > 4)) {
          fabState.dragging = true;
          closeFabMenu(shadow); // 拖动时关闭菜单
        }
        if (!fabState.dragging) return;

        const clamped = clampPosition(
          fabState.dragStartLeft + deltaX,
          fabState.dragStartTop + deltaY
        );
        fabState.currentLeft = clamped.left;
        fabState.currentTop = clamped.top;
        applyPosition(false);
      };

      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);

        if (fabState.dragging) {
          snapToEdge();
          // dragging 标志延迟清除，让 click 事件能检测到
          setTimeout(() => { fabState.dragging = false; }, SNAP_DURATION + 60);
        }
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    });

    // 点击页面其他区域关闭菜单（跳过 FAB 自身的点击，避免与切换逻辑冲突）
    fabState.documentClickHandler = (e) => {
      if (fabState.host && fabState.host.contains(e.target)) return;
      closeFabMenu(shadow);
    };
    document.addEventListener("click", fabState.documentClickHandler, true);

    // 窗口缩放（含侧边栏开合导致的视口变化）后，FAB 的绝对像素坐标可能落到视口外被遮挡。
    // 监听 resize（rAF 节流），按当前所在边缘重新贴边并夹取，确保始终可见可点。
    function repositionForViewport() {
      if (fabState.snapSide === "left") {
        fabState.currentLeft = EDGE_MARGIN;
      } else {
        fabState.currentLeft = window.innerWidth - FAB_SIZE - EDGE_MARGIN;
      }
      const clamped = clampPosition(fabState.currentLeft, fabState.currentTop);
      fabState.currentLeft = clamped.left;
      fabState.currentTop = clamped.top;
      applyPosition(false);
    }

    if (fabState.resizeHandler) {
      window.removeEventListener("resize", fabState.resizeHandler);
    }
    fabState.resizeHandler = () => {
      if (fabState.dragging || fabState.resizeRafId) {
        return;
      }
      fabState.resizeRafId = requestAnimationFrame(() => {
        fabState.resizeRafId = 0;
        if (fabState.host) {
          repositionForViewport();
        }
      });
    };
    window.addEventListener("resize", fabState.resizeHandler);

    initFabPosition();
    updateSnapClass();

    host.style.cssText = `
      position: fixed;
      left: ${fabState.currentLeft}px;
      top: ${fabState.currentTop}px;
      z-index: 2147483647;
      transition: none;
    `;

    document.documentElement.appendChild(host);
    fabState.host = host;
    fabState.shadow = shadow;
  }

  function destroyFab() {
    if (fabState.documentClickHandler) {
      document.removeEventListener("click", fabState.documentClickHandler, true);
      fabState.documentClickHandler = null;
    }

    if (fabState.resizeHandler) {
      window.removeEventListener("resize", fabState.resizeHandler);
      fabState.resizeHandler = null;
    }
    if (fabState.resizeRafId) {
      cancelAnimationFrame(fabState.resizeRafId);
      fabState.resizeRafId = 0;
    }

    if (fabState.host) {
      fabState.host.remove();
      fabState.host = null;
      fabState.shadow = null;
    }
    fabState.open = false;
  }

  function toggleFabMenu(shadow) {
    fabState.open ? closeFabMenu(shadow) : openFabMenu(shadow);
  }

  function openFabMenu(shadow) {
    const menu = shadow.querySelector(".fab-menu");
    if (menu) menu.removeAttribute("hidden");
    fabState.open = true;
  }

  function closeFabMenu(shadow) {
    if (!shadow) return;
    const menu = shadow.querySelector(".fab-menu");
    if (menu) menu.setAttribute("hidden", "");
    fabState.open = false;
  }

  function updateFabActiveState(isActive) {
    if (!fabState.shadow) return;
    const btn = fabState.shadow.querySelector(".fab-btn");
    if (!btn) return;
    if (isActive) {
      btn.classList.add("is-active");
    } else {
      btn.classList.remove("is-active");
    }
  }

  // SVG 图标（菜单项专用）
  function svgCursor() {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4l7 18 3-7 7-3z"/></svg>`;
  }
  function svgStop() {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>`;
  }
  function svgClose() {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18M6 6l12 12"/></svg>`;
  }

  // ── FAB 模式切换 ─────────────────────────────────────────────────────────

  function handleFabModeChange(payload) {
    if (!payload) return;
    const mode = payload.mode || FAB_MODE.off;
    const targetTab = payload.tabId; // only meaningful for current-tab

    if (mode === FAB_MODE.allTabs) {
      fabState.enabledForThisTab = false;
      ensureFab();
    } else if (mode === FAB_MODE.currentTab) {
      // service-worker sends tabId; if it matches, show; otherwise destroy
      if (payload.show) {
        fabState.enabledForThisTab = true;
        ensureFab();
      } else {
        fabState.enabledForThisTab = false;
        destroyFab();
      }
    } else {
      // off
      fabState.enabledForThisTab = false;
      destroyFab();
    }
  }

  // 初始化：根据存储的 fabMode 决定是否显示悬浮球
  (async function initFab() {
    try {
      const result = await chrome.storage.local.get({ elementSnapshotFabMode: "off" });
      const mode = result.elementSnapshotFabMode || "off";
      if (mode === FAB_MODE.allTabs) {
        ensureFab();
      }
      // current-tab 模式不在此初始化，由 service-worker 主动推送
    } catch (e) {
      // storage access may fail on restricted pages
    }
  })();
})();
