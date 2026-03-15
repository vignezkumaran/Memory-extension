/**
 * Base error type for extension runtime issues.
 */
export class ExtensionError extends Error {
  public readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ExtensionError';
    this.code = code;
  }
}

/**
 * Error thrown when required DOM nodes are unavailable.
 */
export class DomElementNotFoundError extends ExtensionError {
  constructor(selector: string) {
    super('DOM_ELEMENT_NOT_FOUND', `Unable to find element for selector: ${selector}`);
    this.name = 'DomElementNotFoundError';
  }
}

/**
 * Error thrown for malformed runtime messages.
 */
export class MessageValidationError extends ExtensionError {
  constructor(message: string) {
    super('MESSAGE_VALIDATION_FAILED', message);
    this.name = 'MessageValidationError';
  }
}

/**
 * Error thrown when import/export JSON payloads are invalid.
 */
export class StorageValidationError extends ExtensionError {
  constructor(message: string) {
    super('STORAGE_VALIDATION_FAILED', message);
    this.name = 'StorageValidationError';
  }
}
