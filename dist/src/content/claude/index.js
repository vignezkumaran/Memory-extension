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
  editor.textContent = value;
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
function formatConversation(conversation, format) {
  const header = `--- Previous conversation from ChatGPT ---
Title: ${conversation.title ?? "Untitled"}
`;
  if (format === "summary") {
    return `${header}${summarizeConversation(conversation)}`;
  }
  const bodyMessages = format === "last-only" ? conversation.messages.slice(-1) : conversation.messages;
  const body = bodyMessages.map((message) => `${message.role.toUpperCase()}: ${message.content}`).join("\n\n");
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
    const formatted = formatConversation(message.payload.conversation, message.payload.format);
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
window.addEventListener("beforeunload", () => {
  teardownCallbacks.forEach((cleanup) => cleanup());
  teardownCallbacks.length = 0;
});
//# sourceMappingURL=index.js.map
