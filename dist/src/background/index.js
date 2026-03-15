// src/background/types.ts
var DEFAULT_SETTINGS = {
  autoSave: false,
  maxConversations: 200,
  defaultSource: "chatgpt"
};

// src/shared/errors.ts
var ExtensionError = class extends Error {
  code;
  constructor(code, message, options) {
    super(message, options);
    this.name = "ExtensionError";
    this.code = code;
  }
};
var MessageValidationError = class extends ExtensionError {
  constructor(message) {
    super("MESSAGE_VALIDATION_FAILED", message);
    this.name = "MessageValidationError";
  }
};
var StorageValidationError = class extends ExtensionError {
  constructor(message) {
    super("STORAGE_VALIDATION_FAILED", message);
    this.name = "StorageValidationError";
  }
};

// src/background/storage.ts
var TypedStorage = class {
  constructor(area) {
    this.area = area;
  }
  async get(key) {
    const result = await this.area.get(String(key));
    return result[String(key)] ?? null;
  }
  async set(key, value) {
    await this.area.set({ [String(key)]: value });
  }
  async getAll() {
    const all = await this.area.get(null);
    return all;
  }
  async remove(key) {
    await this.area.remove(String(key));
  }
  async clear() {
    await this.area.clear();
  }
  subscribe(key, callback) {
    const listener = (changes, areaName) => {
      if (areaName !== "local") {
        return;
      }
      const changed = changes[String(key)];
      if (!changed) {
        return;
      }
      callback(changed.newValue ?? null);
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }
};
function ensureStorageArea() {
  if (!chrome?.storage?.local) {
    throw new ExtensionError("STORAGE_UNAVAILABLE", "chrome.storage.local is unavailable.");
  }
  return chrome.storage.local;
}

// src/shared/guards.ts
function isMessage(value) {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value;
  return (candidate.role === "user" || candidate.role === "assistant" || candidate.role === "system") && typeof candidate.content === "string" && (candidate.timestamp === void 0 || typeof candidate.timestamp === "number");
}
function isConversation(value) {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value;
  return typeof candidate.id === "string" && Array.isArray(candidate.messages) && candidate.messages.every(isMessage) && typeof candidate.createdAt === "number" && (candidate.source === "chatgpt" || candidate.source === "claude" || candidate.source === "perplexity");
}

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

// src/background/index.ts
var storage = new TypedStorage(ensureStorageArea());
async function getSettings() {
  const settings = await storage.get("settings");
  if (!settings) {
    await storage.set("settings", DEFAULT_SETTINGS);
    return DEFAULT_SETTINGS;
  }
  return { ...DEFAULT_SETTINGS, ...settings };
}
async function getConversations() {
  return await storage.get("conversations") ?? {};
}
function toListItems(conversations) {
  return Object.values(conversations).sort((a, b) => b.createdAt - a.createdAt).map((item) => ({
    id: item.id,
    title: item.title ?? "Untitled Conversation",
    preview: item.messages[0]?.content.slice(0, 120) ?? "",
    messageCount: item.messages.length,
    source: item.source,
    createdAt: item.createdAt
  }));
}
async function enforceLimit(conversations) {
  const settings = await getSettings();
  const entries = Object.entries(conversations);
  if (entries.length <= settings.maxConversations) {
    return conversations;
  }
  entries.sort(([, left], [, right]) => right.createdAt - left.createdAt);
  const kept = entries.slice(0, settings.maxConversations);
  return Object.fromEntries(kept);
}
function makeErrorResponse(code, message) {
  return {
    type: "ERROR",
    payload: { code, message }
  };
}
function assertBackgroundRequest(value) {
  if (!value || typeof value !== "object" || !("type" in value)) {
    throw new MessageValidationError("Invalid message shape from runtime sender.");
  }
}
function parseImportJson(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new StorageValidationError(`Invalid JSON payload: ${String(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.conversations)) {
    throw new StorageValidationError("Import payload must contain a conversations array.");
  }
  const conversations = parsed.conversations;
  if (!conversations.every(isConversation)) {
    throw new StorageValidationError("Import payload contains invalid conversation entries.");
  }
  return conversations;
}
async function saveConversation(conversation) {
  const existing = await getConversations();
  const next = { ...existing, [conversation.id]: conversation };
  const trimmed = await enforceLimit(next);
  await storage.set("conversations", trimmed);
  const lastAccessed = await storage.get("lastAccessed") ?? {};
  lastAccessed[conversation.id] = Date.now();
  await storage.set("lastAccessed", lastAccessed);
  return {
    type: "SAVE_RESULT",
    payload: { success: true, id: conversation.id }
  };
}
async function handleMessage(request) {
  switch (request.type) {
    case "SAVE_CONVERSATION": {
      if (!isConversation(request.payload.conversation)) {
        throw new MessageValidationError("SAVE_CONVERSATION payload has invalid shape.");
      }
      return saveConversation(request.payload.conversation);
    }
    case "GET_CONVERSATION": {
      const all = await getConversations();
      const conversation = all[request.payload.id];
      if (!conversation) {
        return makeErrorResponse("NOT_FOUND", `Conversation with id ${request.payload.id} not found.`);
      }
      return {
        type: "GET_RESULT",
        payload: { conversation }
      };
    }
    case "LIST_CONVERSATIONS": {
      const list = toListItems(await getConversations());
      return { type: "LIST_RESULT", payload: { conversations: list } };
    }
    case "DELETE_CONVERSATION": {
      const all = await getConversations();
      delete all[request.payload.id];
      await storage.set("conversations", all);
      return { type: "DELETE_RESULT", payload: { success: true, id: request.payload.id } };
    }
    case "EXPORT_CONVERSATIONS": {
      const conversations = Object.values(await getConversations());
      return {
        type: "EXPORT_RESULT",
        payload: {
          json: JSON.stringify({ conversations }, null, 2)
        }
      };
    }
    case "IMPORT_CONVERSATIONS": {
      const parsed = parseImportJson(request.payload.raw);
      const current = await getConversations();
      const merged = { ...current };
      for (const conversation of parsed) {
        merged[conversation.id] = conversation;
      }
      const trimmed = await enforceLimit(merged);
      await storage.set("conversations", trimmed);
      return {
        type: "IMPORT_RESULT",
        payload: { imported: parsed.length }
      };
    }
    default:
      return makeErrorResponse("UNSUPPORTED_MESSAGE", `Unhandled message type: ${request.type}`);
  }
}
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  void (async () => {
    try {
      assertBackgroundRequest(message);
      const response = await handleMessage(message);
      sendResponse(response);
      logWithContext("info", "Background message handled", { type: message.type });
    } catch (error) {
      if (error instanceof MessageValidationError || error instanceof StorageValidationError) {
        sendResponse(makeErrorResponse(error.code, error.message));
        return;
      }
      logWithContext("error", "Unhandled background error", {
        error: error instanceof Error ? error.message : String(error)
      });
      sendResponse(makeErrorResponse("UNEXPECTED_ERROR", "Unexpected background failure."));
    }
  })();
  return true;
});
//# sourceMappingURL=index.js.map
