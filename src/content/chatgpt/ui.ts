import { logWithContext } from '../../shared/logger';

const BUTTON_ID = 'ai-memory-save-button';

/**
 * Injects a save button into ChatGPT's main composer area.
 */
export function injectSaveButton(onClick: () => Promise<void>): () => void {
  const observer = new MutationObserver(() => {
    const targetContainer = document.querySelector('form') ?? document.querySelector('main');
    if (!targetContainer) {
      return;
    }

    const existing = document.getElementById(BUTTON_ID);
    if (existing) {
      return;
    }

    const button = document.createElement('button');
    button.id = BUTTON_ID;
    button.type = 'button';
    button.textContent = '💾 Save to Memory';
    button.style.margin = '8px';
    button.style.padding = '6px 10px';
    button.style.borderRadius = '8px';
    button.style.border = '1px solid currentColor';
    button.style.cursor = 'pointer';
    button.addEventListener('click', () => {
      void onClick();
    });

    targetContainer.appendChild(button);
    logWithContext('info', 'ChatGPT save button injected', { buttonId: BUTTON_ID });
  });

  observer.observe(document.documentElement, { childList: true, subtree: true });

  return () => {
    observer.disconnect();
    document.getElementById(BUTTON_ID)?.remove();
  };
}
