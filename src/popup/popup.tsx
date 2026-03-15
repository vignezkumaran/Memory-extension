import { Component, type ErrorInfo, type ReactElement, type ReactNode, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useMessages } from './hooks/useMessages';
import type { ConversationListItem } from './types';
import type { InjectMessage } from '../shared/types';
import './popup.css';

class PopupErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
  public constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  public static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true };
  }

  public componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error({ error, info });
  }

  public render(): ReactNode {
    if (this.state.hasError) {
      return <div style={{ padding: '12px' }}>Something went wrong in popup UI.</div>;
    }

    return this.props.children;
  }
}

type TabContext = 'chatgpt' | 'claude' | 'perplexity' | 'other';
type Screen = 'loading' | 'save' | 'list' | 'empty' | 'settings';
type ToastKind = 'success' | 'error';

interface ToastState {
  id: number;
  kind: ToastKind;
  message: string;
}

function toRelativeTime(epochMs: number): string {
  const deltaMs = Date.now() - epochMs;
  const minutes = Math.floor(deltaMs / 60000);
  if (minutes < 1) {
    return 'just now';
  }

  if (minutes < 60) {
    return `${minutes}m ago`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }

  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function detectTabContext(url: string | undefined): TabContext {
  if (!url) {
    return 'other';
  }

  if (url.startsWith('https://chat.openai.com/') || url.startsWith('https://chatgpt.com/')) {
    return 'chatgpt';
  }

  if (url.startsWith('https://claude.ai/')) {
    return 'claude';
  }

  if (url.startsWith('https://www.perplexity.ai/')) {
    return 'perplexity';
  }

  return 'other';
}

function App(): ReactElement {
  const [screen, setScreen] = useState<Screen>('loading');
  const [tabContext, setTabContext] = useState<TabContext>('other');
  const [activeTabId, setActiveTabId] = useState<number | null>(null);
  const [memories, setMemories] = useState<ConversationListItem[]>([]);
  const [search, setSearch] = useState('');
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [clearAllConfirm, setClearAllConfirm] = useState(false);
  const [showInjectStatus, setShowInjectStatus] = useState(true);
  const [groupBySource, setGroupBySource] = useState(true);
  const [autoExpandPreview, setAutoExpandPreview] = useState(true);
  const { listConversations, deleteConversation, getConversation, exportConversations } = useMessages();

  const canInject = tabContext === 'claude';
  const injectDisabledReason = canInject ? undefined : 'Switch to Claude.ai to inject memories.';

  useEffect(() => {
    if (!toast) {
      return;
    }

    const timeout = window.setTimeout(() => {
      setToast(null);
    }, 4000);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [toast]);

  useEffect(() => {
    const init = async (): Promise<void> => {
      try {
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        setActiveTabId(activeTab?.id ?? null);
        setTabContext(detectTabContext(activeTab?.url));
      } catch {
        setTabContext('other');
      }

      try {
        const response = await listConversations();
        if (response.type === 'LIST_RESULT') {
          setMemories(response.payload.conversations);
          setScreen(response.payload.conversations.length > 0 ? 'list' : 'empty');
        } else {
          setScreen('empty');
        }
      } catch {
        setScreen('empty');
      }
    };

    void init();
  }, [listConversations]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) {
      return memories;
    }

    return memories.filter((memory) => {
      return memory.title.toLowerCase().includes(query) || memory.preview.toLowerCase().includes(query);
    });
  }, [memories, search]);

  const grouped = useMemo(() => {
    if (!groupBySource) {
      return { all: filtered } as Record<string, ConversationListItem[]>;
    }

    return filtered.reduce<Record<string, ConversationListItem[]>>((acc, item) => {
      const bucket = acc[item.source] ?? [];
      bucket.push(item);
      acc[item.source] = bucket;
      return acc;
    }, {});
  }, [filtered, groupBySource]);

  const deleteTarget = useMemo(() => {
    if (!deleteTargetId) {
      return null;
    }

    return memories.find((memory) => memory.id === deleteTargetId) ?? null;
  }, [deleteTargetId, memories]);

  const showToast = (kind: ToastKind, message: string): void => {
    setToast({ id: Date.now(), kind, message });
  };

  const refreshMemories = async (): Promise<void> => {
    const response = await listConversations();
    if (response.type === 'LIST_RESULT') {
      setMemories(response.payload.conversations);
      setScreen(response.payload.conversations.length > 0 ? 'list' : 'empty');
      return;
    }

    if (response.type === 'ERROR') {
      throw new Error(response.payload.message);
    }

    throw new Error('Unexpected response while listing conversations.');
  };

  const handleSaveConversation = async (): Promise<void> => {
    if (tabContext !== 'chatgpt') {
      showToast('error', 'Save is only available on ChatGPT tabs.');
      return;
    }

    if (!activeTabId) {
      showToast('error', 'Active tab unavailable.');
      return;
    }

    try {
      const response = (await chrome.tabs.sendMessage(activeTabId, {
        type: 'POPUP_SAVE_CHATGPT'
      })) as { success?: boolean; error?: string } | undefined;

      if (!response?.success) {
        showToast('error', response?.error ?? 'Unable to save from this page.');
        return;
      }

      await refreshMemories();
      showToast('success', 'Conversation saved successfully.');
    } catch (error) {
      showToast('error', error instanceof Error ? error.message : 'Unable to save from this page.');
    }
  };

  const handleInject = async (memoryId: string): Promise<void> => {
    if (!canInject) {
      showToast('error', 'Inject is disabled on this tab.');
      return;
    }

    if (!activeTabId) {
      showToast('error', 'Active tab unavailable for injection.');
      return;
    }

    try {
      const convoResponse = await getConversation(memoryId);
      if (convoResponse.type !== 'GET_RESULT') {
        showToast('error', convoResponse.type === 'ERROR' ? convoResponse.payload.message : 'Unable to fetch conversation.');
        return;
      }

      const message: InjectMessage = {
        type: 'INJECT_CONVERSATION',
        payload: { conversation: convoResponse.payload.conversation, format: 'full' }
      };

      await chrome.tabs.sendMessage(activeTabId, message);
    } catch (error) {
      showToast('error', error instanceof Error ? error.message : 'Injection failed.');
      return;
    }

    if (showInjectStatus) {
      showToast('success', 'Memory injected into Claude.');
    }
  };

  const handleDeleteConfirmed = async (): Promise<void> => {
    if (!deleteTargetId) {
      return;
    }

    try {
      const response = await deleteConversation(deleteTargetId);
      if (response.type !== 'DELETE_RESULT') {
        showToast('error', response.type === 'ERROR' ? response.payload.message : 'Delete failed.');
        return;
      }

      await refreshMemories();
      setDeleteTargetId(null);
      showToast('success', 'Memory deleted.');
    } catch (error) {
      showToast('error', error instanceof Error ? error.message : 'Delete failed.');
    }
  };

  const handleExportAll = async (): Promise<void> => {
    const response = await exportConversations();
    if (response.type !== 'EXPORT_RESULT') {
      showToast('error', response.type === 'ERROR' ? response.payload.message : 'Export failed.');
      return;
    }

    const blob = new Blob([response.payload.json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'ai-memory-export.json';
    anchor.click();
    URL.revokeObjectURL(url);
    showToast('success', 'Exported all memories as JSON.');
  };

  if (screen === 'loading') {
    return (
      <div className="ai-popup">
        <nav className="ai-top-nav">
          <div className="ai-skeleton ai-skeleton-title" />
          <div className="ai-skeleton ai-skeleton-icon" />
        </nav>
        <div className="ai-left-accent" />
        <main className="ai-main">
          <div className="ai-skeleton ai-skeleton-search" />
          <div className="ai-skeleton-card" />
          <div className="ai-skeleton-card" />
          <div className="ai-skeleton-card" />
        </main>
        <div className="ai-radial-glow" />
      </div>
    );
  }

  return (
    <div className="ai-popup">
      <nav className="ai-top-nav ai-frosted">
        <div className="ai-header-left">
          {screen === 'settings' ? (
            <button className="ai-icon-btn" type="button" onClick={() => setScreen('list')} aria-label="Back">
              <span className="material-symbols-outlined">arrow_back</span>
            </button>
          ) : null}
          <h1 className="ai-title">{screen === 'settings' ? 'Settings' : 'AI Memory'}</h1>
        </div>

        <div className="ai-header-actions">
          {screen !== 'settings' ? (
            <span className={`ai-status-pill ${canInject ? 'is-active' : ''}`}>{canInject ? 'Claude Active' : 'Other Tab'}</span>
          ) : null}
          {screen !== 'settings' ? (
            <button className="ai-icon-btn" type="button" onClick={() => setScreen('settings')} aria-label="Settings">
              <span className="material-symbols-outlined">settings</span>
            </button>
          ) : null}
        </div>
      </nav>

      <div className="ai-left-accent" />
      <div className="ai-radial-glow" />

      <main className="ai-main">
        {screen === 'save' ? (
          <section className="ai-empty">
            <div className="ai-illustration-box">
              <span className="material-symbols-outlined">ink_highlighter</span>
            </div>
            <h2>Save to Memory</h2>
            <p>
              {tabContext === 'chatgpt'
                ? 'You are on ChatGPT. Save this conversation into AI Memory.'
                : 'Open ChatGPT to save the current conversation.'}
            </p>
            <button className="ai-btn" type="button" disabled={tabContext !== 'chatgpt'} onClick={() => { void handleSaveConversation(); }}>
              Save This Conversation
            </button>
            <button className="ai-btn-ghost" type="button" onClick={() => setScreen(memories.length > 0 ? 'list' : 'empty')}>
              Go to Memory List
            </button>
          </section>
        ) : null}

        {screen === 'list' ? (
          <>
            {!canInject ? (
              <div className="ai-banner">
                <span className="material-symbols-outlined">warning</span>
                <div>
                  <strong>Inject is disabled</strong>
                  <div>{injectDisabledReason}</div>
                </div>
              </div>
            ) : null}

            {toast ? (
              <div className={`ai-toast ${toast.kind === 'error' ? 'is-error' : ''}`} key={toast.id}>
                <span className="material-symbols-outlined">{toast.kind === 'error' ? 'warning' : 'check_circle'}</span>
                <span>{toast.message}</span>
                <button type="button" className="ai-icon-btn" onClick={() => setToast(null)} aria-label="Dismiss toast">
                  <span className="material-symbols-outlined">close</span>
                </button>
              </div>
            ) : null}

            <div className="ai-search-wrap">
              <div className="ai-search-row">
                <input
                  className="ai-input"
                  placeholder="Search memories..."
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
                {search ? (
                  <button className="ai-icon-btn" type="button" onClick={() => setSearch('')} aria-label="Clear search">
                    <span className="material-symbols-outlined">close</span>
                  </button>
                ) : null}
              </div>
            </div>

            {search ? <p className="ai-item-meta">{filtered.length} results for “{search}”</p> : null}

            {filtered.length === 0 ? (
              <div className="ai-no-results">
                <p>No memories match “{search}”</p>
                <button type="button" className="ai-link" onClick={() => setSearch('')}>
                  Clear search
                </button>
              </div>
            ) : (
              Object.keys(grouped)
                .sort((left, right) => left.localeCompare(right))
                .map((groupKey) => {
                  const items = grouped[groupKey] ?? [];
                  const label = groupKey === 'all' ? 'ALL' : groupKey.toUpperCase();

                  return (
                    <section className="ai-group" key={groupKey}>
                      <h3>
                        {label} ({items.length})
                      </h3>

                      {items.map((item) => (
                        <article key={item.id} className="ai-item">
                          <div className="ai-item-row-top">
                            <span className={`ai-source-badge ${item.source === 'chatgpt' ? 'is-chatgpt' : 'is-perplexity'}`}>
                              {item.source === 'chatgpt' ? 'ChatGPT' : item.source === 'perplexity' ? 'Perplexity' : item.source}
                            </span>
                            <span className="ai-item-meta">{toRelativeTime(item.createdAt)}</span>
                            <span className="ai-item-meta">{item.messageCount} msgs</span>
                          </div>

                          <div className="ai-item-title">{item.title}</div>
                          <p className={`ai-item-preview ${autoExpandPreview ? 'expanded' : ''}`}>{item.preview}</p>

                          <div className="ai-item-actions">
                            <button
                              className="ai-btn"
                              type="button"
                              disabled={!canInject}
                              onClick={() => {
                                void handleInject(item.id);
                              }}
                            >
                              ⚡ Inject
                            </button>
                            <button className="ai-btn-delete" type="button" onClick={() => setDeleteTargetId(item.id)}>
                              🗑 Delete
                            </button>
                          </div>
                        </article>
                      ))}
                    </section>
                  );
                })
            )}
          </>
        ) : null}

        {screen === 'empty' ? (
          <section className="ai-empty">
            <div className="ai-illustration-box">
              <span className="material-symbols-outlined">draw</span>
            </div>
            <h2>No memories yet.</h2>
            <p>Save a conversation from ChatGPT first, then use list + search here.</p>
            <button className="ai-btn" type="button" onClick={() => setScreen('save')}>
              Go to Save Page
            </button>
          </section>
        ) : null}

        {screen === 'settings' ? (
          <section className="ai-settings">
            <article className="ai-settings-card">
              <p>
                {memories.length} saved memories · Stored locally · No cloud sync
              </p>
            </article>

            <div className="ai-toggle-row">
              <span>Auto-expand preview on hover</span>
              <button
                type="button"
                className={`ai-toggle ${autoExpandPreview ? 'is-on' : ''}`}
                onClick={() => setAutoExpandPreview((value) => !value)}
                aria-label="Toggle auto-expand preview"
              />
            </div>

            <div className="ai-toggle-row">
              <span>Show inject status in popup</span>
              <button
                type="button"
                className={`ai-toggle ${showInjectStatus ? 'is-on' : ''}`}
                onClick={() => setShowInjectStatus((value) => !value)}
                aria-label="Toggle inject status"
              />
            </div>

            <div className="ai-toggle-row">
              <span>Group by source</span>
              <button
                type="button"
                className={`ai-toggle ${groupBySource ? 'is-on' : ''}`}
                onClick={() => setGroupBySource((value) => !value)}
                aria-label="Toggle source grouping"
              />
            </div>

            <button className="ai-btn-outline" type="button" onClick={handleExportAll}>
              Export All as JSON
            </button>

            <button className="ai-btn-outline is-danger" type="button" onClick={() => setClearAllConfirm(true)}>
              Clear All Memories
            </button>

            {clearAllConfirm ? (
              <div className="ai-inline-confirm">
                <button
                  type="button"
                  className="ai-btn-danger"
                  onClick={() => {
                    setMemories([]);
                    setClearAllConfirm(false);
                    showToast('success', 'All memories cleared.');
                  }}
                >
                  Confirm Clear
                </button>
                <button type="button" className="ai-btn-ghost" onClick={() => setClearAllConfirm(false)}>
                  Cancel
                </button>
              </div>
            ) : null}

            <div className="ai-about">
              <strong>AI Memory v1.0.0</strong>
              <p>Shared local memory layer for ChatGPT and Claude workflows.</p>
            </div>
          </section>
        ) : null}
      </main>

      {screen === 'list' || screen === 'empty' || screen === 'save' ? (
        <footer className="ai-sticky-footer">
          <div className="ai-footer-row">
            <button className="ai-btn-ghost" type="button" onClick={() => setScreen('save')}>
              Save Page
            </button>
            <button className="ai-btn-ghost" type="button" onClick={() => setScreen(memories.length > 0 ? 'list' : 'empty')}>
              Memory List
            </button>
          </div>
        </footer>
      ) : null}

      {deleteTarget ? (
        <div className="ai-modal-backdrop" role="dialog" aria-modal="true" aria-label="Delete memory confirmation">
          <div className="ai-modal">
            <h3>Delete this memory?</h3>
            <p>
              “{deleteTarget.title.slice(0, 28)}{deleteTarget.title.length > 28 ? '…' : ''}” will be permanently removed from local storage.
            </p>
            <div className="ai-modal-actions">
              <button className="ai-btn-danger" type="button" onClick={() => { void handleDeleteConfirmed(); }}>
                Delete Permanently
              </button>
              <button className="ai-btn-ghost" type="button" onClick={() => setDeleteTargetId(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

const container = document.getElementById('root');
if (!container) {
  throw new Error('Popup root element not found.');
}

const root = createRoot(container);
root.render(
  <PopupErrorBoundary>
    <App />
  </PopupErrorBoundary>
);
