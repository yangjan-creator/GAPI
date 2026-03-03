import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ActivePage, NebulaFile, TabInfo, TabInspectResult } from '../types';
import type { GapiClient } from '../client';
import { useWebSocket } from '../hooks/useWebSocket';
import './TabManagerPage.css';

const PAGES_POLL_INTERVAL = 10_000;
const RESPONSE_POLL_INTERVAL = 3_000;
const RESPONSE_POLL_MAX_ATTEMPTS = 20;

type DetailTab = 'inspect' | 'send' | 'navigate' | 'files' | 'custom-query';

interface InspectAction {
  label: string;
  action: string;
  description: string;
}

const INSPECT_ACTIONS: InspectAction[] = [
  { label: 'Get Last Response', action: 'GET_LAST_RESPONSE', description: 'Retrieve the last AI response' },
  { label: 'Inspect DOM', action: 'inspectDOM', description: 'Inspect the page DOM structure' },
  { label: 'Inspect Messages', action: 'inspectMessages', description: 'Extract conversation messages' },
  { label: 'Extract Images', action: 'EXTRACT_IMAGES', description: 'Extract images from the page' },
  { label: 'Inspect Tool Calls', action: 'inspectToolCalls', description: 'List tool/function calls' },
  { label: 'Expand Tool Calls', action: 'expandToolCalls', description: 'Expand tool call details' },
];

const RELOAD_MODES = [
  { value: 'soft', label: 'Soft Reload', description: 'Reload content scripts only' },
  { value: 'full', label: 'Full Reload', description: 'Reload entire extension' },
  { value: 'hard', label: 'Hard Reload', description: 'Uninstall and reinstall extension' },
];

const SITE_TYPE_COLORS: Record<string, string> = {
  gemini: 'tm-badge--gemini',
  claude: 'tm-badge--claude',
  chatgpt: 'tm-badge--chatgpt',
  nebula: 'tm-badge--nebula',
};

interface TabManagerPageProps {
  client: GapiClient;
  serverUrl: string;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatJson(data: unknown): string {
  try {
    return JSON.stringify(data, null, 2);
  } catch {
    return String(data);
  }
}

function formatRelativeTime(isoString: string): string {
  try {
    const date = new Date(isoString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffSec = Math.floor(diffMs / 1000);
    if (diffSec < 60) return `${diffSec}s ago`;
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    return date.toLocaleString('zh-TW', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return isoString;
  }
}

export function TabManagerPage({ client, serverUrl }: TabManagerPageProps) {
  // Pages list state
  const [pages, setPages] = useState<ActivePage[]>([]);
  const [connectedExtensions, setConnectedExtensions] = useState(0);
  const [loadingPages, setLoadingPages] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // WebSocket connection for real-time page updates
  const { connected: wsConnected } = useWebSocket({
    serverUrl,
    onPagesUpdate: useCallback((updatedPages: ActivePage[], meta?: { total: number; connected_extensions: number }) => {
      setPages(updatedPages);
      if (meta) {
        setConnectedExtensions(meta.connected_extensions);
      }
      setLoadingPages(false);
    }, []),
  });

  // Selection state
  const [selectedTabId, setSelectedTabId] = useState<number | null>(null);
  const [activeDetailTab, setActiveDetailTab] = useState<DetailTab>('inspect');

  // Inspect state
  const [inspectResult, setInspectResult] = useState<TabInspectResult | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [activeAction, setActiveAction] = useState<string | null>(null);

  // Send state
  const [sendMessage, setSendMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState<unknown>(null);
  const [waitingResponse, setWaitingResponse] = useState(false);
  const pollAttemptsRef = useRef(0);

  // Navigate state
  const [navUrl, setNavUrl] = useState('');
  const [navigating, setNavigating] = useState(false);

  // Files state (Nebula)
  const [nebulaFiles, setNebulaFiles] = useState<NebulaFile[]>([]);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [selectedFile, setSelectedFile] = useState<NebulaFile | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [loadingFileContent, setLoadingFileContent] = useState(false);

  // Custom query state
  const [customSelector, setCustomSelector] = useState('');
  const [customResult, setCustomResult] = useState<TabInspectResult | null>(null);
  const [querying, setQuerying] = useState(false);

  // Reload state
  const [reloading, setReloading] = useState(false);
  const [reloadMenuOpen, setReloadMenuOpen] = useState(false);

  // New Tab form state
  const [newTabFormOpen, setNewTabFormOpen] = useState(false);
  const [newTabUrl, setNewTabUrl] = useState('');
  const [creatingTab, setCreatingTab] = useState(false);

  // Tab Info state
  const [tabInfo, setTabInfo] = useState<TabInfo | null>(null);
  const [loadingTabInfo, setLoadingTabInfo] = useState(false);

  const reloadMenuRef = useRef<HTMLDivElement>(null);

  const selectedPage = useMemo(
    () => pages.find((p) => p.tab_id === selectedTabId) ?? null,
    [pages, selectedTabId],
  );

  const isNebulaTab = selectedPage?.site_type === 'nebula';

  // ---- Data Loading ----

  const loadPages = useCallback(async () => {
    try {
      const data = await client.getPages();
      setPages(data.pages);
      setConnectedExtensions(data.meta.connected_extensions);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingPages(false);
    }
  }, [client]);

  // Initial load
  useEffect(() => {
    loadPages();
  }, [loadPages]);

  // Poll pages list (only when WebSocket is disconnected)
  useEffect(() => {
    if (wsConnected) return;
    const timer = window.setInterval(() => {
      if (!document.hidden) loadPages();
    }, PAGES_POLL_INTERVAL);
    return () => window.clearInterval(timer);
  }, [loadPages, wsConnected]);

  // Clear selection when selected tab disappears
  useEffect(() => {
    if (selectedTabId !== null && !pages.find((p) => p.tab_id === selectedTabId)) {
      // Keep selection for a brief grace period (tab might reappear)
    }
  }, [pages, selectedTabId]);

  // Load nebula files when files tab is active and it's a nebula tab
  useEffect(() => {
    if (activeDetailTab !== 'files' || !isNebulaTab || selectedTabId === null) return;
    let cancelled = false;
    const load = async () => {
      setLoadingFiles(true);
      try {
        const data = await client.getNebulaFiles(selectedTabId);
        if (!cancelled) setNebulaFiles(data.files);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoadingFiles(false);
      }
    };
    load();
    return () => { cancelled = true; };
  }, [activeDetailTab, isNebulaTab, selectedTabId, client]);

  // Close reload menu on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (reloadMenuRef.current && !reloadMenuRef.current.contains(e.target as Node)) {
        setReloadMenuOpen(false);
      }
    };
    if (reloadMenuOpen) {
      document.addEventListener('mousedown', handler);
    }
    return () => document.removeEventListener('mousedown', handler);
  }, [reloadMenuOpen]);

  // Fetch tab info when a tab is selected
  useEffect(() => {
    if (selectedTabId === null) {
      setTabInfo(null);
      return;
    }
    let cancelled = false;
    const fetchInfo = async () => {
      setLoadingTabInfo(true);
      try {
        const info = await client.getTabInfo(selectedTabId);
        if (!cancelled) setTabInfo(info);
      } catch {
        if (!cancelled) setTabInfo(null);
      } finally {
        if (!cancelled) setLoadingTabInfo(false);
      }
    };
    fetchInfo();
    return () => { cancelled = true; };
  }, [selectedTabId, client]);

  // ---- Handlers ----

  const handleRefresh = () => {
    setLoadingPages(true);
    loadPages();
  };

  const handleCreateTab = async () => {
    if (!newTabUrl.trim()) return;
    setCreatingTab(true);
    try {
      await client.createTab(newTabUrl.trim());
      setNewTabUrl('');
      setNewTabFormOpen(false);
      // Refresh pages list to show the new tab
      loadPages();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreatingTab(false);
    }
  };

  const handleSelectTab = (tabId: number) => {
    setSelectedTabId(tabId);
    setInspectResult(null);
    setSendResult(null);
    setCustomResult(null);
    setNebulaFiles([]);
    setSelectedFile(null);
    setFileContent(null);
    setTabInfo(null);
    setActiveDetailTab('inspect');
  };

  const handleInspect = async (action: string) => {
    if (selectedTabId === null) return;
    setInspecting(true);
    setActiveAction(action);
    setInspectResult(null);
    try {
      const result = await client.inspectTab(selectedTabId, action);
      setInspectResult(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setInspecting(false);
      setActiveAction(null);
    }
  };

  const handleSend = async () => {
    if (selectedTabId === null || !sendMessage.trim()) return;
    setSending(true);
    setSendResult(null);
    setWaitingResponse(false);
    try {
      const result = await client.sendToTab(selectedTabId, sendMessage.trim());
      setSendResult(result);
      setSendMessage('');
      // Start polling for response
      setWaitingResponse(true);
      pollAttemptsRef.current = 0;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  // Poll for response after sending
  useEffect(() => {
    if (!waitingResponse || selectedTabId === null) return;
    let cancelled = false;
    const poll = async () => {
      if (cancelled) return;
      pollAttemptsRef.current += 1;
      try {
        const result = await client.getTabResponse(selectedTabId);
        if (!cancelled) {
          setSendResult(result);
          if (result.status === 'completed' || result.status === 'error' || pollAttemptsRef.current >= RESPONSE_POLL_MAX_ATTEMPTS) {
            setWaitingResponse(false);
          }
        }
      } catch {
        if (!cancelled) {
          setWaitingResponse(false);
        }
      }
    };
    const timer = window.setInterval(poll, RESPONSE_POLL_INTERVAL);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [waitingResponse, selectedTabId, client]);

  const handleNavigate = async () => {
    if (selectedTabId === null || !navUrl.trim()) return;
    setNavigating(true);
    try {
      await client.navigateTab(selectedTabId, navUrl.trim());
      setNavUrl('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setNavigating(false);
    }
  };

  const handleViewFile = async (file: NebulaFile) => {
    if (selectedTabId === null) return;
    setSelectedFile(file);
    setFileContent(null);
    setLoadingFileContent(true);
    try {
      const data = await client.getNebulaFileContent(selectedTabId, file.id);
      setFileContent(data.content);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setFileContent(null);
    } finally {
      setLoadingFileContent(false);
    }
  };

  const handleCustomQuery = async () => {
    if (selectedTabId === null || !customSelector.trim()) return;
    setQuerying(true);
    setCustomResult(null);
    try {
      const result = await client.inspectTab(selectedTabId, 'customQuery', {
        selector: customSelector.trim(),
      });
      setCustomResult(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setQuerying(false);
    }
  };

  const handleReload = async (mode: string) => {
    setReloading(true);
    setReloadMenuOpen(false);
    try {
      const result = await client.reloadExtension(mode);
      setError(null);
      // Show success briefly via the result
      setSendResult(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setReloading(false);
    }
  };

  const handleReloadKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      setReloadMenuOpen(false);
    }
  };

  // ---- Render Helpers ----

  const renderJsonViewer = (data: unknown, label?: string) => (
    <div className="tm-json-viewer">
      {label && <div className="tm-json-label">{label}</div>}
      <pre className="tm-json-content mono">{formatJson(data)}</pre>
    </div>
  );

  const renderDetailTabs = () => {
    const tabs: { id: DetailTab; label: string; hidden?: boolean }[] = [
      { id: 'inspect', label: 'Inspect' },
      { id: 'send', label: 'Send' },
      { id: 'navigate', label: 'Navigate' },
      { id: 'files', label: 'Files', hidden: !isNebulaTab },
      { id: 'custom-query', label: 'Custom Query' },
    ];

    return (
      <nav className="tm-detail-tabs" role="tablist" aria-label="Tab detail sections">
        {tabs
          .filter((t) => !t.hidden)
          .map((tab) => (
            <button
              key={tab.id}
              role="tab"
              aria-selected={activeDetailTab === tab.id}
              className={`tm-detail-tab${activeDetailTab === tab.id ? ' tm-detail-tab--active' : ''}`}
              onClick={() => setActiveDetailTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
      </nav>
    );
  };

  const renderInspectPanel = () => (
    <div className="tm-inspect-panel">
      <div className="tm-action-grid">
        {INSPECT_ACTIONS.map((ia) => (
          <button
            key={ia.action}
            className={`tm-action-btn${activeAction === ia.action ? ' tm-action-btn--active' : ''}`}
            onClick={() => handleInspect(ia.action)}
            disabled={inspecting}
            title={ia.description}
          >
            <span className="tm-action-btn__label">{ia.label}</span>
            <span className="tm-action-btn__desc">{ia.description}</span>
          </button>
        ))}
      </div>
      {inspecting && (
        <div className="tm-loading" role="status" aria-live="polite">Inspecting...</div>
      )}
      {inspectResult && !inspecting && renderJsonViewer(inspectResult, 'Inspect Result')}
    </div>
  );

  const renderSendPanel = () => (
    <div className="tm-send-panel">
      <div className="tm-send-form">
        <label htmlFor="tm-send-input" className="tm-form-label">Message</label>
        <textarea
          id="tm-send-input"
          className="textarea"
          placeholder="Type a message to send to this tab..."
          value={sendMessage}
          onChange={(e) => setSendMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              if (!sending && sendMessage.trim()) handleSend();
            }
          }}
          disabled={sending}
          rows={4}
        />
        <div className="tm-send-actions">
          <button
            className="btn-primary"
            onClick={handleSend}
            disabled={sending || !sendMessage.trim()}
          >
            {sending ? 'Sending...' : 'Send'}
          </button>
          {waitingResponse && (
            <span className="tm-waiting" role="status" aria-live="polite">
              Waiting for response... ({pollAttemptsRef.current}/{RESPONSE_POLL_MAX_ATTEMPTS})
            </span>
          )}
        </div>
      </div>
      {sendResult != null && renderJsonViewer(sendResult, 'Response')}
    </div>
  );

  const renderNavigatePanel = () => (
    <div className="tm-navigate-panel">
      <div className="tm-navigate-form">
        <label htmlFor="tm-nav-url" className="tm-form-label">URL</label>
        <div className="tm-nav-row">
          <input
            id="tm-nav-url"
            className="input"
            type="url"
            placeholder="https://gemini.google.com/app/..."
            value={navUrl}
            onChange={(e) => setNavUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                if (!navigating && navUrl.trim()) handleNavigate();
              }
            }}
            disabled={navigating}
          />
          <button
            className="btn-primary"
            onClick={handleNavigate}
            disabled={navigating || !navUrl.trim()}
          >
            {navigating ? 'Navigating...' : 'Go'}
          </button>
        </div>
      </div>
      {selectedPage && (
        <div className="tm-current-url">
          <span className="tm-form-label">Current URL:</span>
          <span className="mono">{selectedPage.url}</span>
        </div>
      )}
    </div>
  );

  const renderFilesPanel = () => (
    <div className="tm-files-panel">
      {loadingFiles ? (
        <div className="tm-loading" role="status" aria-live="polite">Loading files...</div>
      ) : nebulaFiles.length === 0 ? (
        <div className="empty">No files found for this tab.</div>
      ) : (
        <div className="tm-files-layout">
          <div className="tm-files-list" role="listbox" aria-label="Nebula files">
            {nebulaFiles.map((file) => (
              <button
                key={file.id}
                role="option"
                aria-selected={selectedFile?.id === file.id}
                className={`tm-file-item${selectedFile?.id === file.id ? ' tm-file-item--active' : ''}`}
                onClick={() => handleViewFile(file)}
              >
                <div className="tm-file-name">{file.filename}</div>
                <div className="tm-file-meta">
                  <span className="tm-file-ext">{file.file_extension}</span>
                  <span className="dot">&middot;</span>
                  <span>{formatBytes(file.size_bytes)}</span>
                  <span className="dot">&middot;</span>
                  <span>{formatRelativeTime(file.created_at)}</span>
                </div>
                {file.folder_path && (
                  <div className="tm-file-path mono">{file.folder_path}</div>
                )}
              </button>
            ))}
          </div>
          <div className="tm-file-content-area">
            {selectedFile ? (
              <>
                <div className="tm-file-content-header">
                  <strong>{selectedFile.filename}</strong>
                  <span className="tm-file-meta-inline">
                    {selectedFile.file_extension} &middot; {formatBytes(selectedFile.size_bytes)} &middot; {selectedFile.source}
                  </span>
                </div>
                {loadingFileContent ? (
                  <div className="tm-loading" role="status" aria-live="polite">Loading content...</div>
                ) : fileContent !== null ? (
                  <pre className="tm-file-content mono">{fileContent}</pre>
                ) : (
                  <div className="empty">Failed to load file content.</div>
                )}
              </>
            ) : (
              <div className="empty">Select a file to view its content.</div>
            )}
          </div>
        </div>
      )}
    </div>
  );

  const renderCustomQueryPanel = () => (
    <div className="tm-custom-query-panel">
      <div className="tm-custom-form">
        <label htmlFor="tm-selector" className="tm-form-label">CSS Selector</label>
        <div className="tm-nav-row">
          <input
            id="tm-selector"
            className="input mono"
            type="text"
            placeholder=".conversation-container, #main-content, [data-testid='response']"
            value={customSelector}
            onChange={(e) => setCustomSelector(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                if (!querying && customSelector.trim()) handleCustomQuery();
              }
            }}
            disabled={querying}
          />
          <button
            className="btn-primary"
            onClick={handleCustomQuery}
            disabled={querying || !customSelector.trim()}
          >
            {querying ? 'Querying...' : 'Query'}
          </button>
        </div>
      </div>
      {querying && (
        <div className="tm-loading" role="status" aria-live="polite">Running query...</div>
      )}
      {customResult && !querying && renderJsonViewer(customResult, 'Query Result')}
    </div>
  );

  return (
    <div className="tm-page">
      {error && (
        <div className="toast-error" role="alert" aria-live="assertive">
          <div className="toast-title">Error</div>
          <div className="toast-msg">{error}</div>
          <button className="btn-close" onClick={() => setError(null)} aria-label="Close error message">
            &times;
          </button>
        </div>
      )}

      {/* Top Bar */}
      <div className="tm-topbar">
        <div className="tm-topbar__left">
          <button
            className="btn"
            onClick={handleRefresh}
            disabled={loadingPages}
            aria-label="Refresh active pages"
          >
            {loadingPages ? 'Refreshing...' : 'Refresh'}
          </button>
          <button
            className="btn"
            onClick={() => setNewTabFormOpen(!newTabFormOpen)}
            aria-expanded={newTabFormOpen}
            aria-label="Open new tab form"
          >
            New Tab
          </button>
          <span className="tm-connection-status" role="status" aria-live="polite">
            <span
              className={`tm-status-dot${connectedExtensions > 0 ? ' tm-status-dot--connected' : ''}`}
              aria-hidden="true"
            />
            {connectedExtensions > 0
              ? `${connectedExtensions} extension${connectedExtensions > 1 ? 's' : ''} connected`
              : 'No extensions connected'}
          </span>
          <span className="tm-ws-indicator" role="status" aria-live="polite">
            <span
              className={`tm-ws-dot${wsConnected ? ' tm-ws-dot--connected' : ''}`}
              aria-hidden="true"
            />
            {wsConnected ? 'Real-time' : 'Polling'}
          </span>
        </div>
        <div className="tm-topbar__right" ref={reloadMenuRef} onKeyDown={handleReloadKeyDown}>
          <div className="tm-reload-dropdown">
            <button
              className="btn"
              onClick={() => setReloadMenuOpen(!reloadMenuOpen)}
              disabled={reloading}
              aria-expanded={reloadMenuOpen}
              aria-haspopup="true"
            >
              {reloading ? 'Reloading...' : 'Reload Extension'}
            </button>
            {reloadMenuOpen && (
              <ul className="tm-reload-menu" role="menu" aria-label="Reload modes">
                {RELOAD_MODES.map((mode) => (
                  <li key={mode.value} role="none">
                    <button
                      role="menuitem"
                      className="tm-reload-menu__item"
                      onClick={() => handleReload(mode.value)}
                    >
                      <span className="tm-reload-menu__label">{mode.label}</span>
                      <span className="tm-reload-menu__desc">{mode.description}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>

      {/* New Tab Form */}
      {newTabFormOpen && (
        <div className="tm-new-tab-form">
          <label htmlFor="tm-new-tab-url" className="tm-form-label">Open URL in new browser tab</label>
          <div className="tm-nav-row">
            <input
              id="tm-new-tab-url"
              className="input"
              type="url"
              placeholder="https://gemini.google.com/app"
              value={newTabUrl}
              onChange={(e) => setNewTabUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  if (!creatingTab && newTabUrl.trim()) handleCreateTab();
                }
                if (e.key === 'Escape') {
                  setNewTabFormOpen(false);
                }
              }}
              disabled={creatingTab}
              autoFocus
            />
            <button
              className="btn-primary"
              onClick={handleCreateTab}
              disabled={creatingTab || !newTabUrl.trim()}
            >
              {creatingTab ? 'Opening...' : 'Open'}
            </button>
            <button
              className="btn"
              onClick={() => setNewTabFormOpen(false)}
              aria-label="Cancel new tab"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Main Layout */}
      <div className="tm-layout">
        {/* Left Panel: Active Pages */}
        <div className="tm-sidebar">
          <div className="tm-sidebar__header">
            <h2 className="tm-sidebar__title">Active Pages</h2>
            <span className="tm-sidebar__count">{pages.length}</span>
          </div>
          <div className="tm-pages-list" role="listbox" aria-label="Active browser pages">
            {loadingPages && pages.length === 0 ? (
              <div className="empty">Loading pages...</div>
            ) : pages.length === 0 ? (
              <div className="empty">No active pages detected. Ensure the extension is connected.</div>
            ) : (
              pages.map((page) => (
                <button
                  key={page.tab_id}
                  role="option"
                  aria-selected={page.tab_id === selectedTabId}
                  className={`tm-page-item${page.tab_id === selectedTabId ? ' tm-page-item--active' : ''}`}
                  onClick={() => handleSelectTab(page.tab_id)}
                >
                  <div className="tm-page-item__header">
                    <span className="tm-page-item__title">{page.title || 'Untitled'}</span>
                    <span
                      className={`tm-badge ${SITE_TYPE_COLORS[page.site_type] || 'tm-badge--default'}`}
                    >
                      {page.site_type}
                    </span>
                  </div>
                  <div className="tm-page-item__url mono">{page.url}</div>
                  <div className="tm-page-item__meta">
                    <span className="mono">Tab {page.tab_id}</span>
                    <span className="dot">&middot;</span>
                    <span>{formatRelativeTime(page.last_seen)}</span>
                  </div>
                </button>
              ))
            )}
          </div>
        </div>

        {/* Right Panel: Detail */}
        <div className="tm-detail">
          {selectedTabId === null ? (
            <div className="tm-detail__empty">
              <div className="empty-chat">Select a tab from the left panel to inspect and interact with it.</div>
            </div>
          ) : (
            <>
              <div className="tm-detail__header">
                <div className="tm-detail__title">
                  {selectedPage?.title || 'Tab ' + selectedTabId}
                </div>
                <div className="tm-detail__sub">
                  <span className="mono">Tab {selectedTabId}</span>
                  {selectedPage && (
                    <>
                      <span className="dot">&middot;</span>
                      <span
                        className={`tm-badge ${SITE_TYPE_COLORS[selectedPage.site_type] || 'tm-badge--default'}`}
                      >
                        {selectedPage.site_type}
                      </span>
                    </>
                  )}
                </div>
              </div>
              {/* Tab Info Bar */}
              {loadingTabInfo && (
                <div className="tm-tab-info" role="status" aria-live="polite">
                  <span className="tm-tab-info__loading">Loading tab info...</span>
                </div>
              )}
              {!loadingTabInfo && tabInfo && (
                <div className="tm-tab-info" aria-label="Tab conversation info">
                  {tabInfo.chat_id && (
                    <div className="tm-tab-info__item">
                      <span className="tm-tab-info__label">Chat ID</span>
                      <span className="tm-tab-info__value mono">{tabInfo.chat_id}</span>
                    </div>
                  )}
                  <div className="tm-tab-info__item">
                    <span className="tm-tab-info__label">Title</span>
                    <span className="tm-tab-info__value">{tabInfo.title || 'Untitled'}</span>
                  </div>
                  <div className="tm-tab-info__item">
                    <span className="tm-tab-info__label">Site</span>
                    <span className={`tm-badge ${SITE_TYPE_COLORS[tabInfo.site_type] || 'tm-badge--default'}`}>
                      {tabInfo.site_type}
                    </span>
                  </div>
                </div>
              )}
              {renderDetailTabs()}
              <div className="tm-detail__body">
                {activeDetailTab === 'inspect' && renderInspectPanel()}
                {activeDetailTab === 'send' && renderSendPanel()}
                {activeDetailTab === 'navigate' && renderNavigatePanel()}
                {activeDetailTab === 'files' && renderFilesPanel()}
                {activeDetailTab === 'custom-query' && renderCustomQueryPanel()}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
