import { DomElementNotFoundError } from '../../shared/errors';

const EDITOR_SELECTORS = [
  '.ProseMirror[contenteditable="true"]',
  '[data-testid="chat-input"] .ProseMirror[contenteditable="true"]',
  'div[contenteditable="true"][role="textbox"]'
] as const;

/**
 * Locates the Claude editable input element for either new or existing chats.
 */
export function findClaudeEditor(): HTMLElement | null {
  for (const selector of EDITOR_SELECTORS) {
    const node = document.querySelector(selector);
    if (node instanceof HTMLElement) {
      return node;
    }
  }

  return null;
}

/**
 * Sets editor content and dispatches expected input lifecycle events.
 */
export function setEditorContent(editor: HTMLElement, value: string): void {
  editor.focus();

  const selection = window.getSelection();
  if (selection) {
    const range = document.createRange();
    range.selectNodeContents(editor);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  if (typeof document.execCommand === 'function') {
    document.execCommand('selectAll', false);
    document.execCommand('delete', false);
    document.execCommand('insertText', false, value);
  } else {
    editor.textContent = value;
  }

  editor.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText' }));
  editor.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: value }));
  editor.dispatchEvent(new Event('change', { bubbles: true }));
}

export async function getEditorWithRetry(maxAttempts = 6): Promise<HTMLElement> {
  let delay = 150;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const editor = findClaudeEditor();
    if (editor) {
      return editor;
    }

    await new Promise<void>((resolve) => {
      window.setTimeout(() => resolve(), delay);
    });

    delay = Math.min(delay * 2, 2000);
  }

  throw new DomElementNotFoundError(EDITOR_SELECTORS.join(', '));
}
