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

// src/content/perplexity/index.ts
logWithContext("info", "Perplexity content script initialized", { source: "perplexity" });
//# sourceMappingURL=index.js.map
