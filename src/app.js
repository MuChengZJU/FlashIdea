(function () {
  const messageList = document.getElementById("message-list");
  const composer = document.getElementById("composer");
  const input = document.getElementById("message-input");
  const sendButton = document.getElementById("send-button");

  const messages = new Map();
  const tauri = window.__TAURI__;
  const invoke = tauri && tauri.core && tauri.core.invoke;
  const listen = tauri && tauri.event && tauri.event.listen;

  var statusSvg = {
    queued:
      '<svg class="status-icon status-icon--syncing" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="20 12" /></svg>',
    synced:
      '<svg class="status-icon" viewBox="0 0 16 16"><path d="M4 8.5l3 3 5-6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    failed:
      '<svg class="status-icon" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 5v4M8 10.5v.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  };

  var statusLabel = {
    queued: "同步中",
    synced: "已同步",
    failed: "同步失败，点击重试",
  };

  function isTauriReady() {
    return typeof invoke === "function";
  }

  function normalizeMessage(raw) {
    return {
      id: String(raw.id),
      text: String(raw.text || ""),
      created_at: raw.created_at || new Date().toISOString(),
      sync_status: raw.sync_status || raw.status || "queued",
    };
  }

  function formatTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return "--:--";
    }

    return date.toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  }

  function createElement(tagName, className, textContent) {
    const element = document.createElement(tagName);
    if (className) {
      element.className = className;
    }
    if (textContent !== undefined) {
      element.textContent = textContent;
    }
    return element;
  }

  function renderMessage(message) {
    const normalized = normalizeMessage(message);
    const existing = messages.get(normalized.id);
    if (existing) {
      updateMessageStatus(normalized.id, normalized.sync_status);
      return;
    }

    const item = createElement("li", "message-item");
    item.dataset.id = normalized.id;

    const bubble = createElement("article", "message-bubble");
    const text = createElement("div", "message-text", normalized.text);
    const meta = createElement("div", "message-meta");
    const time = createElement("time", "message-time", formatTime(normalized.created_at));
    time.dateTime = normalized.created_at;

    const statusButton = createElement("button", "status-button");
    statusButton.type = "button";
    statusButton.addEventListener("click", function () {
      if (statusButton.dataset.status === "failed") {
        retryMessage(normalized.id);
      }
    });

    meta.append(time, statusButton);
    bubble.append(text, meta);
    item.append(bubble);
    messageList.append(item);

    messages.set(normalized.id, {
      data: normalized,
      item,
      statusButton,
    });

    setStatus(statusButton, normalized.sync_status);
    scrollToBottom();
  }

  function setStatus(button, status) {
    var key = statusSvg[status] ? status : "queued";
    button.innerHTML = statusSvg[key];
    button.title = statusLabel[key];
    button.setAttribute("aria-label", statusLabel[key]);
    button.dataset.status = status;
    button.disabled = status !== "failed";
  }

  function updateMessageStatus(id, status) {
    const record = messages.get(String(id));
    if (!record) {
      return;
    }

    record.data.sync_status = status;
    setStatus(record.statusButton, status);
  }

  function scrollToBottom() {
    requestAnimationFrame(function () {
      messageList.scrollTop = messageList.scrollHeight;
    });
  }

  function resizeInput() {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 128) + "px";
  }

  async function loadHistory() {
    if (!isTauriReady()) {
      return;
    }

    try {
      const history = await invoke("get_messages", { limit: 50 });
      if (Array.isArray(history)) {
        history.forEach(renderMessage);
      }
    } catch (error) {
      console.warn("get_messages failed", error);
    }
  }

  async function sendMessage(text) {
    if (!isTauriReady()) {
      renderMessage({
        id: "browser-" + Date.now(),
        text,
        created_at: new Date().toISOString(),
        sync_status: "failed",
      });
      return;
    }

    sendButton.disabled = true;
    try {
      const response = await invoke("send_message", { text });
      if (response && response.status !== "rejected") {
        renderMessage({
          id: response.id,
          text,
          created_at: new Date().toISOString(),
          sync_status: response.status || "queued",
        });
      }
    } catch (error) {
      console.warn("send_message failed", error);
      renderMessage({
        id: "failed-" + Date.now(),
        text,
        created_at: new Date().toISOString(),
        sync_status: "failed",
      });
    } finally {
      sendButton.disabled = false;
      input.focus();
    }
  }

  async function retryMessage(id) {
    const record = messages.get(String(id));
    if (!record || !isTauriReady()) {
      return;
    }

    updateMessageStatus(id, "queued");
    try {
      await invoke("retry_message", { id });
    } catch (error) {
      console.warn("retry_message failed", error);
      updateMessageStatus(id, "failed");
    }
  }

  async function bindSyncEvents() {
    if (typeof listen !== "function") {
      return;
    }

    try {
      await listen("sync_status_changed", function (event) {
        const payload = event && event.payload ? event.payload : {};
        if (payload.id && payload.status) {
          updateMessageStatus(payload.id, payload.status);
        }
      });
    } catch (error) {
      console.warn("sync_status_changed listener failed", error);
    }
  }

  composer.addEventListener("submit", function (event) {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) {
      return;
    }

    input.value = "";
    resizeInput();
    sendMessage(text);
  });

  input.addEventListener("input", resizeInput);
  input.addEventListener("keydown", function (event) {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      composer.requestSubmit();
    }
  });

  resizeInput();
  bindSyncEvents();
  loadHistory();
  input.focus();
})();
