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

// src/content/chatgpt/extractor.ts
var AUTHOR_SELECTOR = "[data-message-author-role]";
var USER_SELECTOR = '[data-message-author-role="user"]';
var ASSISTANT_SELECTOR = '[data-message-author-role="assistant"]';
async function waitForDocumentReady() {
  if (document.readyState === "complete") {
    return;
  }
  await new Promise((resolve) => {
    window.addEventListener("load", () => resolve(), { once: true });
  });
}
async function waitForMessages(timeoutMs = 12e3) {
  await waitForDocumentReady();
  const hasMessages = () => {
    const user = document.querySelector(USER_SELECTOR);
    const assistant = document.querySelector(ASSISTANT_SELECTOR);
    return Boolean(user || assistant);
  };
  if (hasMessages()) {
    return;
  }
  await new Promise((resolve, reject) => {
    let settled = false;
    const observer = new MutationObserver(() => {
      if (hasMessages()) {
        settled = true;
        observer.disconnect();
        window.clearTimeout(timeoutId);
        resolve();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    const timeoutId = window.setTimeout(() => {
      if (settled) {
        return;
      }
      observer.disconnect();
      reject(new DomElementNotFoundError(AUTHOR_SELECTOR));
    }, timeoutMs);
  });
}
function extractTextContent(element) {
  const text = element.textContent?.trim() ?? "";
  return text.replace(/\n{3,}/g, "\n\n");
}
function inferTitle(messages) {
  const firstUser = messages.find((message) => message.role === "user");
  if (!firstUser) {
    return "ChatGPT Conversation";
  }
  return firstUser.content.slice(0, 80) || "ChatGPT Conversation";
}
async function extractChatGPTConversation() {
  try {
    await waitForMessages();
    const nodes = Array.from(document.querySelectorAll(AUTHOR_SELECTOR));
    if (nodes.length === 0) {
      throw new DomElementNotFoundError(AUTHOR_SELECTOR);
    }
    const messages = [];
    for (const node of nodes) {
      const roleValue = node.getAttribute("data-message-author-role");
      if (roleValue !== "user" && roleValue !== "assistant" && roleValue !== "system") {
        continue;
      }
      const content = extractTextContent(node);
      if (!content) {
        continue;
      }
      messages.push({
        role: roleValue,
        content
      });
    }
    if (messages.length === 0) {
      logWithContext("warn", "No message content found during extraction", { source: "chatgpt" });
      return null;
    }
    const createdAt = Date.now();
    return {
      id: crypto.randomUUID(),
      title: inferTitle(messages),
      messages,
      createdAt,
      source: "chatgpt"
    };
  } catch (error) {
    if (error instanceof DomElementNotFoundError) {
      logWithContext("warn", "ChatGPT extraction failed due to missing message elements", {
        error: error.message
      });
      return null;
    }
    if (error instanceof ExtensionError) {
      logWithContext("error", "Known extension error while extracting ChatGPT conversation", {
        code: error.code,
        error: error.message
      });
      return null;
    }
    logWithContext("error", "Unexpected extraction error", {
      error: error instanceof Error ? error.message : String(error)
    });
    return null;
  }
}

// src/content/chatgpt/ui.ts
var BUTTON_ID = "ai-memory-save-button";
function injectSaveButton(onClick) {
  const observer = new MutationObserver(() => {
    const targetContainer = document.querySelector("form") ?? document.querySelector("main");
    if (!targetContainer) {
      return;
    }
    const existing = document.getElementById(BUTTON_ID);
    if (existing) {
      return;
    }
    const button = document.createElement("button");
    button.id = BUTTON_ID;
    button.type = "button";
    button.textContent = "\u{1F4BE} Save to Memory";
    button.style.margin = "8px";
    button.style.padding = "6px 10px";
    button.style.borderRadius = "8px";
    button.style.border = "1px solid currentColor";
    button.style.cursor = "pointer";
    button.addEventListener("click", () => {
      void onClick();
    });
    targetContainer.appendChild(button);
    logWithContext("info", "ChatGPT save button injected", { buttonId: BUTTON_ID });
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  return () => {
    observer.disconnect();
    document.getElementById(BUTTON_ID)?.remove();
  };
}

// src/content/chatgpt/index.ts
function isBackgroundResponseMessage(value) {
  if (!value || typeof value !== "object" || !("type" in value)) {
    return false;
  }
  const type = value.type;
  return type === "SAVE_RESULT" || type === "LIST_RESULT" || type === "DELETE_RESULT" || type === "EXPORT_RESULT" || type === "IMPORT_RESULT" || type === "ERROR";
}
async function sendSaveRequest(conversationId, payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(payload, (response) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message));
        return;
      }
      if (!isBackgroundResponseMessage(response)) {
        reject(new MessageValidationError("Missing response from background service worker."));
        return;
      }
      resolve(response);
    });
  }).finally(() => {
    logWithContext("debug", "Save request completed", { conversationId });
  });
}
async function onSaveConversation() {
  try {
    const conversation = await extractChatGPTConversation();
    if (!conversation) {
      logWithContext("warn", "Skipping save because extraction returned null", { source: "chatgpt" });
      return;
    }
    const response = await sendSaveRequest(conversation.id, {
      type: "SAVE_CONVERSATION",
      payload: { conversation }
    });
    if (response.type === "SAVE_RESULT") {
      logWithContext("info", "Conversation saved successfully", { id: response.payload.id });
      return;
    }
    if (response.type === "ERROR") {
      throw new MessageValidationError(`${response.payload.code}: ${response.payload.message}`);
    }
    throw new MessageValidationError(`Unexpected response type: ${response.type}`);
  } catch (error) {
    logWithContext("error", "Failed to save ChatGPT conversation", {
      error: error instanceof Error ? error.message : String(error)
    });
  }
}
function isPopupSaveRequestMessage(value) {
  if (!value || typeof value !== "object") {
    return false;
  }
  return value.type === "POPUP_SAVE_CHATGPT";
}
var popupListener = (message, _sender, sendResponse) => {
  if (!isPopupSaveRequestMessage(message)) {
    return false;
  }
  void (async () => {
    try {
      await onSaveConversation();
      sendResponse({ success: true });
    } catch (error) {
      sendResponse({
        success: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  })();
  return true;
};
chrome.runtime.onMessage.addListener(popupListener);
var cleanup = injectSaveButton(onSaveConversation);
window.addEventListener("beforeunload", () => {
  cleanup();
  chrome.runtime.onMessage.removeListener(popupListener);
});
export {
  extractChatGPTConversation
};
//# sourceMappingURL=index.js.map
