type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Logs typed diagnostic context in a consistent format.
 */
export function logWithContext<TContext extends Record<string, unknown>>(
  level: LogLevel,
  message: string,
  context?: TContext
): void {
  const payload = {
    scope: 'ai-memory-extension',
    timestamp: Date.now(),
    message,
    ...(context ?? {})
  };

  if (level === 'debug') {
    console.debug(payload);
    return;
  }

  if (level === 'info') {
    console.info(payload);
    return;
  }

  if (level === 'warn') {
    console.warn(payload);
    return;
  }

  console.error(payload);
}
