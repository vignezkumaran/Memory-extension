// src/shared/errors.ts
var ExtensionError = class extends Error {
  code;
  constructor(code, message, options) {
    super(message, options);
    this.name = "ExtensionError";
    this.code = code;
  }
};
var DomElementNotFoundError = class extends ExtensionError {
  constructor(selector) {
    super("DOM_ELEMENT_NOT_FOUND", `Unable to find element for selector: ${selector}`);
    this.name = "DomElementNotFoundError";
  }
};
var MessageValidationError = class extends ExtensionError {
  constructor(message) {
    super("MESSAGE_VALIDATION_FAILED", message);
    this.name = "MessageValidationError";
  }
};

// src/shared/logger.ts
function logWithContext(level, message, context) {
  const payload = {
    scope: "ai-memory-extension",
    timestamp: Date.now(),
    message,
    ...context ?? {}
  };
  if (level === "debug") {
    console.debug(payload);
    return;
  }
  if (level === "info") {
    console.info(payload);
    return;
  }
  if (level === "warn") {
    console.warn(payload);
    return;
  }
  console.error(payload);
}

// src/content/claude/editor-handler.ts
var EDITOR_SELECTORS = [
  '.ProseMirror[contenteditable="true"]',
  '[data-testid="chat-input"] .ProseMirror[contenteditable="true"]',
  'div[contenteditable="true"][role="textbox"]'
];
function findClaudeEditor() {
  for (const selector of EDITOR_SELECTORS) {
    const node = document.querySelector(selector);
    if (node instanceof HTMLElement) {
      return node;
    }
  }
  return null;
}
function setEditorContent(editor, value) {
  editor.focus();
  const selection = window.getSelection();
  if (selection) {
    const range = document.createRange();
    range.selectNodeContents(editor);
    selection.removeAllRanges();
    selection.addRange(range);
  }
  if (typeof document.execCommand === "function") {
    document.execCommand("selectAll", false);
    document.execCommand("delete", false);
    document.execCommand("insertText", false, value);
  } else {
    editor.textContent = value;
  }
  editor.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText" }));
  editor.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true, inputType: "insertText", data: value }));
  editor.dispatchEvent(new Event("change", { bubbles: true }));
}
async function getEditorWithRetry(maxAttempts = 6) {
  let delay = 150;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const editor = findClaudeEditor();
    if (editor) {
      return editor;
    }
    await new Promise((resolve) => {
      window.setTimeout(() => resolve(), delay);
    });
    delay = Math.min(delay * 2, 2e3);
  }
  throw new DomElementNotFoundError(EDITOR_SELECTORS.join(", "));
}

// src/content/claude/injector.ts
var STATUS_ID = "ai-memory-claude-status";
function summarizeConversation(conversation) {
  const userMessages = conversation.messages.filter((message) => message.role === "user").length;
  const assistantMessages = conversation.messages.filter((message) => message.role === "assistant").length;
  const preview = conversation.messages[0]?.content.slice(0, 160) ?? "No preview available.";
  return `Summary: ${userMessages} user messages, ${assistantMessages} assistant messages.
Preview: ${preview}`;
}
function formatConversation(message) {
  if (message.payload.preparedPrompt && message.payload.preparedPrompt.trim().length > 0) {
    return message.payload.preparedPrompt;
  }
  const conversation = message.payload.conversation;
  const format = message.payload.format;
  const header = `--- Previous conversation from ${conversation.source.toUpperCase()} ---
Title: ${conversation.title ?? "Untitled"}
`;
  if (format === "summary") {
    return `${header}${summarizeConversation(conversation)}`;
  }
  const bodyMessages = format === "last-only" ? conversation.messages.slice(-1) : conversation.messages;
  const body = bodyMessages.map((message2) => `${message2.role.toUpperCase()}: ${message2.content}`).join("\n\n");
  return `${header}${body}`;
}
function ensureStatusElement() {
  const existing = document.getElementById(STATUS_ID);
  if (existing instanceof HTMLDivElement) {
    return existing;
  }
  const node = document.createElement("div");
  node.id = STATUS_ID;
  node.style.position = "fixed";
  node.style.bottom = "20px";
  node.style.right = "20px";
  node.style.zIndex = "2147483647";
  node.style.padding = "8px 12px";
  node.style.borderRadius = "10px";
  node.style.border = "1px solid currentColor";
  node.style.background = "Canvas";
  node.style.color = "CanvasText";
  node.style.fontSize = "12px";
  document.body.appendChild(node);
  return node;
}
function renderStatus(message, success) {
  const statusElement = ensureStatusElement();
  statusElement.textContent = message;
  statusElement.style.opacity = success ? "1" : "0.9";
  window.setTimeout(() => {
    statusElement.remove();
  }, 3e3);
}
async function injectConversationToClaude(message) {
  try {
    const editor = await getEditorWithRetry();
    const formatted = formatConversation(message);
    setEditorContent(editor, formatted);
    const status = {
      type: "INJECTION_STATUS",
      payload: {
        success: true,
        messageCount: message.payload.conversation.messages.length
      }
    };
    renderStatus("Memory injected successfully.", true);
    return status;
  } catch (error) {
    const reason = error instanceof DomElementNotFoundError ? error.message : error instanceof Error ? error.message : String(error);
    logWithContext("error", "Failed Claude injection", { reason });
    renderStatus("Failed to inject memory.", false);
    return {
      type: "INJECTION_STATUS",
      payload: {
        success: false,
        error: reason
      }
    };
  }
}

// src/content/claude/index.ts
var teardownCallbacks = [];
function isPopupCaptureRequestMessage(value) {
  if (!value || typeof value !== "object") {
    return false;
  }
  return value.type === "POPUP_CAPTURE_CONTEXT";
}
function inferClaudeRole(text) {
  const lower = text.toLowerCase();
  if (lower.startsWith("you") || lower.startsWith("human") || lower.startsWith("user")) {
    return "user";
  }
  if (lower.startsWith("system")) {
    return "system";
  }
  return "assistant";
}
function extractClaudeConversation() {
  const containers = Array.from(document.querySelectorAll("main [data-testid], main article, main .prose"));
  const messages = [];
  for (const container of containers) {
    const text = container.textContent?.trim();
    if (!text || text.length < 6) {
      continue;
    }
    const role = inferClaudeRole(text);
    messages.push({ role, content: text });
  }
  if (messages.length === 0) {
    return null;
  }
  return {
    id: crypto.randomUUID(),
    title: messages[0]?.content.slice(0, 80) ?? "Claude Conversation",
    messages,
    createdAt: Date.now(),
    source: "claude"
  };
}
function saveClaudeConversationToBackground(conversation) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: "SAVE_CONVERSATION", payload: { conversation } }, (response) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message));
        return;
      }
      const type = response?.type;
      if (type !== "SAVE_RESULT") {
        reject(new Error("Unable to save Claude conversation."));
        return;
      }
      resolve();
    });
  });
}
function isInjectMessage(value) {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value;
  return candidate.type === "INJECT_CONVERSATION" && !!candidate.payload?.conversation;
}
var listener = (message, _sender, sendResponse) => {
  void (async () => {
    try {
      if (isPopupCaptureRequestMessage(message)) {
        const conversation = extractClaudeConversation();
        if (!conversation) {
          throw new MessageValidationError("No Claude conversation found to capture.");
        }
        await saveClaudeConversationToBackground(conversation);
        sendResponse({ success: true });
        return;
      }
      if (!isInjectMessage(message)) {
        throw new MessageValidationError("Received unsupported message in Claude content script.");
      }
      const status = await injectConversationToClaude(message);
      sendResponse(status);
    } catch (error) {
      logWithContext("error", "Claude message handling failed", {
        error: error instanceof Error ? error.message : String(error)
      });
      sendResponse({
        type: "INJECTION_STATUS",
        payload: {
          success: false,
          error: error instanceof Error ? error.message : String(error)
        }
      });
    }
  })();
  return true;
};
chrome.runtime.onMessage.addListener(listener);
teardownCallbacks.push(() => chrome.runtime.onMessage.removeListener(listener));
if (!findClaudeEditor()) {
  logWithContext("warn", "Claude editor not found during initialization; retrying via runtime calls.");
}
window.addEventListener("beforeunload", () => {
  teardownCallbacks.forEach((cleanup) => cleanup());
  teardownCallbacks.length = 0;
});
//# sourceMappingURL=index.js.map
