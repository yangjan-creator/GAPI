import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { ChatMessage, ConversationMeta, UserProfile } from './api';
import { ExtensionApi } from './api';

const LS_KEY_EXTENSION_ID = 'gemini_admin_extension_id';

function formatTime(ts?: number) {
  if (!ts) return '';
  try {
    return new Date(ts).toLocaleString('zh-TW', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  } catch {
    return '';
  }
}

function classNames(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(' ');
}

function escapeHtml(s: string) {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function MessageBubble({ msg }: { msg: ChatMessage }) {
  const role = msg.role || 'unknown';
  const isUser = role === 'user';
  const isAssistant = role === 'assistant' || role === 'model';

  return (
    <div className={classNames('msgRow', isUser && 'msgRowUser', isAssistant && 'msgRowAssistant')}>
      <div className={classNames('msgBubble', isUser ? 'msgUser' : isAssistant ? 'msgAssistant' : 'msgUnknown')}>
        <div className="msgMeta">
          <span className="msgRole">{isUser ? '你' : isAssistant ? 'Gemini' : role}</span>
          <span className="msgTime">{formatTime(msg.timestamp)}</span>
        </div>
        <div className="msgText" dangerouslySetInnerHTML={{ __html: escapeHtml(msg.text || '') }} />

        {Array.isArray(msg.codeBlocks) && msg.codeBlocks.length > 0 && (
          <div className="codeBlocks">
            {msg.codeBlocks.map((cb, idx) => (
              <div key={idx} className="codeBlock">
                <div className="codeBlockHeader">
                  <span className="codeLang">{cb.language || 'code'}</span>
                  <button
                    className="btnCopy"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(cb.text || '');
                      } catch {
                        // ignore
                      }
                    }}
                    title="複製"
                  >
                    複製
                  </button>
                </div>
                <pre className="codePre">
                  <code>{cb.text || ''}</code>
                </pre>
              </div>
            ))}
          </div>
        )}

        {Array.isArray(msg.images) && msg.images.length > 0 && (
          <div className="imagesGrid">
            {msg.images.map((img, idx) => (
              <a
                key={img.id || img.url || String(idx)}
                className="imageTile"
                href={img.originalUrl || img.downloadUrl || img.url || '#'}
                target="_blank"
                rel="noreferrer"
                onClick={(e) => {
                  if (!img.originalUrl && !img.downloadUrl && !img.url) e.preventDefault();
                }}
                title={img.alt || 'image'}
              >
                {/* Use img.url as preview if available */}
                {img.url ? <img src={img.url} alt={img.alt || 'image'} /> : <div className="imagePlaceholder">No URL</div>}
              </a>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function App() {
  const [extensionId, setExtensionId] = useState<string>(() => localStorage.getItem(LS_KEY_EXTENSION_ID) || '');
  const api = useMemo(() => (extensionId ? new ExtensionApi(extensionId) : null), [extensionId]);

  const [status, setStatus] = useState<string>('未連線');
  const [error, setError] = useState<string | null>(null);
  const [pushActive, setPushActive] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [downloadBaseFolder, setDownloadBaseFolder] = useState<string>('Gemini_Assistant');
  const [savingSettings, setSavingSettings] = useState(false);

  const [profiles, setProfiles] = useState<UserProfile[]>([]);
  const [selectedProfile, setSelectedProfile] = useState<UserProfile>('default');

  const [conversations, setConversations] = useState<ConversationMeta[]>([]);
  const [search, setSearch] = useState('');
  const [selectedChatId, setSelectedChatId] = useState<string | null>(null);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [unread, setUnread] = useState<Record<string, number>>({});
  const [openTabs, setOpenTabs] = useState<any[]>([]);
  const [openTabsExpanded, setOpenTabsExpanded] = useState(true);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreviewUrl, setImagePreviewUrl] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const listRef = useRef<HTMLDivElement | null>(null);
  const portRef = useRef<{ disconnect: () => void } | null>(null);
  const refreshTimerRef = useRef<number | null>(null);
  const lastRefreshRef = useRef<number>(0);

  async function connectAndLoad() {
    if (!api) {
      setError('請先輸入 extensionId');
      return;
    }
    setError(null);
    setStatus('連線中...');
    try {
      const resp = await api.listProfiles();
      if (!resp?.success) throw new Error(resp?.error || 'listProfiles failed');
      const ps = resp.profiles?.length ? resp.profiles : ['default'];
      setProfiles(ps);
      if (!ps.includes(selectedProfile)) setSelectedProfile(ps[0] || 'default');
      setStatus('已連線');

      try {
        const s = await api.getDownloadBaseFolder();
        if (s?.success && s.downloadBaseFolder) setDownloadBaseFolder(s.downloadBaseFolder);
      } catch {
        // ignore
      }

      // Try open tabs snapshot
      try {
        const t = await api.listOpenTabs();
        if (t?.success) setOpenTabs(t.tabs || []);
      } catch {
        // ignore
      }
    } catch (e: any) {
      setStatus('未連線');
      setError(e?.message || String(e));
    }
  }

  function scheduleRefresh(kind: 'conversations' | 'messages' | 'tabs' | 'all') {
    // debounce to avoid storm
    const now = Date.now();
    if (now - lastRefreshRef.current < 250) return;
    lastRefreshRef.current = now;

    if (refreshTimerRef.current) window.clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = window.setTimeout(async () => {
      if (!api) return;
      if (kind === 'conversations' || kind === 'all') await loadConversations(selectedProfile);
      if ((kind === 'messages' || kind === 'all') && selectedChatId) await loadMessages(selectedProfile, selectedChatId);
      if (kind === 'tabs' || kind === 'all') {
        try {
          const t = await api.listOpenTabs();
          if (t?.success) setOpenTabs(t.tabs || []);
        } catch {
          // ignore
        }
      }
    }, 180);
  }

  async function loadConversations(profile: string) {
    if (!api) return;
    setError(null);
    try {
      const resp = await api.listConversations(profile);
      if (!resp?.success) throw new Error(resp?.error || 'listConversations failed');
      setConversations(resp.conversations || []);
    } catch (e: any) {
      setError(e?.message || String(e));
    }
  }

  async function loadMessages(profile: string, chatId: string) {
    if (!api) return;
    setLoadingMessages(true);
    setError(null);
    try {
      const resp = await api.getConversationMessages(profile, chatId);
      if (!resp?.success) throw new Error(resp?.error || 'getConversationMessages failed');
      setMessages(resp.messages || []);
      // scroll to bottom
      requestAnimationFrame(() => {
        const el = listRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      });
    } catch (e: any) {
      setError(e?.message || String(e));
      setMessages([]);
    } finally {
      setLoadingMessages(false);
    }
  }

  async function sendMessage() {
    if (!api) return;
    if (!selectedChatId) {
      setError('請先選擇一個對話');
      return;
    }
    const text = draft.trim();
    if (!text && !imageFile) return;
    setSending(true);
    setError(null);
    try {
      if (imageFile) {
        // Read as data URL (prefix + base64). Send in chunks to extension.
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onerror = () => reject(new Error('讀取圖片失敗'));
          reader.onload = () => resolve(String(reader.result || ''));
          reader.readAsDataURL(imageFile);
        });

        const commaIdx = dataUrl.indexOf(',');
        if (commaIdx < 0) throw new Error('不合法的 dataURL');
        const prefix = dataUrl.slice(0, commaIdx + 1); // include comma
        const b64 = dataUrl.slice(commaIdx + 1);

        const begin = await api.uploadBegin(
          selectedProfile,
          selectedChatId,
          prefix,
          imageFile.name || 'image.png',
          imageFile.type || ''
        );
        if (!begin?.success || !begin.uploadId) throw new Error(begin?.error || 'uploadBegin failed');

        const uploadId = begin.uploadId;
        const chunkSize = 180_000; // keep well under message limits
        for (let i = 0; i < b64.length; i += chunkSize) {
          const chunk = b64.slice(i, i + chunkSize);
          const r = await api.uploadChunk(uploadId, chunk);
          if (!r?.success) {
            try {
              await api.uploadAbort(uploadId);
            } catch {
              // ignore
            }
            throw new Error(r?.error || 'uploadChunk failed');
          }
        }

        const commit = await api.uploadCommit(uploadId, text);
        if (!commit?.success) throw new Error(commit?.error || 'uploadCommit failed');
      } else {
        const resp = await api.sendMessageToChat(selectedProfile, selectedChatId, text);
        if (!resp?.success) throw new Error(resp?.error || 'sendMessage failed');
      }

      setDraft('');
      setImageFile(null);
      if (imagePreviewUrl) URL.revokeObjectURL(imagePreviewUrl);
      setImagePreviewUrl(null);

      // If push is active, rely on events; else poll DB (no DOM scraping)
      if (!pushActive) {
        const start = Date.now();
        const timeoutMs = 60_000;
        const intervalMs = 1_500;
        const prevCount = messages.length;

        while (Date.now() - start < timeoutMs) {
          await new Promise((r) => setTimeout(r, intervalMs));
          const m = await api.getConversationMessages(selectedProfile, selectedChatId);
          if (m?.success && (m.messages?.length || 0) >= prevCount + 1) {
            setMessages(m.messages || []);
            requestAnimationFrame(() => {
              const el = listRef.current;
              if (el) el.scrollTop = el.scrollHeight;
            });
            break;
          }
        }
      }
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setSending(false);
    }
  }

  useEffect(() => {
    if (extensionId) localStorage.setItem(LS_KEY_EXTENSION_ID, extensionId);
  }, [extensionId]);

  useEffect(() => {
    return () => {
      if (imagePreviewUrl) URL.revokeObjectURL(imagePreviewUrl);
    };
  }, [imagePreviewUrl]);

  useEffect(() => {
    // try auto connect
    if (api) connectAndLoad();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  // realtime push connection
  useEffect(() => {
    if (!api) return;

    // cleanup previous
    try {
      portRef.current?.disconnect();
    } catch {
      // ignore
    }
    portRef.current = null;
    setPushActive(false);

    let stopped = false;
    try {
      const port = api.connectAdminEvents((ev) => {
        if (stopped) return;
        if (!ev || typeof ev !== 'object') return;
        if (ev.type === 'hello' || ev.type === 'pong') {
          setPushActive(true);
          return;
        }
        if (ev.type === 'disconnected') {
          setPushActive(false);
          return;
        }

        if (ev.type === 'conversationStateChanged') {
          const d = ev.data || {};
          const up = d.userProfile || 'default';
          if (up === selectedProfile) scheduleRefresh('conversations');
          scheduleRefresh('tabs');
        }

        if (ev.type === 'messagesSaved') {
          const d = ev.data || {};
          const up = d.userProfile || 'default';
          const cid = d.chatId ? String(d.chatId) : null;
          if (up === selectedProfile) scheduleRefresh('conversations');
          if (cid) {
            const key = `${up}:${cid}`;
            if (cid === selectedChatId && up === selectedProfile) {
              setUnread((m) => {
                if (!m[key]) return m;
                const { [key]: _, ...rest } = m;
                return rest;
              });
              scheduleRefresh('messages');
            } else {
              setUnread((m) => ({ ...m, [key]: (m[key] || 0) + (Number(d.messageCount) || 1) }));
            }
          }
        }
      });
      portRef.current = port;
    } catch {
      // no push; polling fallback is enabled below
      setPushActive(false);
    }

    return () => {
      stopped = true;
      try {
        portRef.current?.disconnect();
      } catch {
        // ignore
      }
      portRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, selectedProfile, selectedChatId]);

  // polling fallback when push is not active
  useEffect(() => {
    if (!api) return;
    if (pushActive) return;

    const timer = window.setInterval(() => {
      loadConversations(selectedProfile);
      if (selectedChatId) loadMessages(selectedProfile, selectedChatId);
    }, 3500);

    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, pushActive, selectedProfile, selectedChatId]);

  useEffect(() => {
    if (!api) return;
    loadConversations(selectedProfile);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, selectedProfile]);

  useEffect(() => {
    if (!api) return;
    if (selectedChatId) loadMessages(selectedProfile, selectedChatId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, selectedProfile, selectedChatId]);

  const filteredConversations = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return conversations;
    return conversations.filter((c) => (c.title || '').toLowerCase().includes(q) || (c.chatId || '').toLowerCase().includes(q));
  }, [conversations, search]);

  const selectedConversation = useMemo(
    () => conversations.find((c) => c.chatId === selectedChatId) || null,
    [conversations, selectedChatId]
  );

  const pushLabel = pushActive ? '即時' : '輪詢';

  return (
    <div className="appShell">
      <header className="topBar">
        <div className="brand">
          <div className="brandTitle">Gemini</div>
          <div className="brandSub">Conversations</div>
        </div>
        <div className="connect">
          {(settingsOpen || status !== '已連線') && (
            <>
              <input
                className="input"
                value={extensionId}
                onChange={(e) => setExtensionId(e.target.value.trim())}
                placeholder="Extension ID"
              />
              <button className="btn" onClick={connectAndLoad} disabled={!extensionId}>
                連線
              </button>
              <input
                className="input"
                value={downloadBaseFolder}
                onChange={(e) => setDownloadBaseFolder(e.target.value)}
                placeholder="下載子資料夾 (Downloads 下)"
                title="只能指定 Downloads 底下的相對路徑，例如 Gemini_Assistant 或 Gemini_Assistant/MyProject"
              />
              <button
                className="btn"
                onClick={async () => {
                  if (!api) return;
                  setSavingSettings(true);
                  setError(null);
                  try {
                    const r = await api.setDownloadBaseFolder(downloadBaseFolder);
                    if (!r?.success) throw new Error(r?.error || 'setDownloadBaseFolder failed');
                    setDownloadBaseFolder(r.downloadBaseFolder);
                  } catch (e: any) {
                    setError(e?.message || String(e));
                  } finally {
                    setSavingSettings(false);
                  }
                }}
                disabled={!api || savingSettings}
                title="儲存下載位置設定"
              >
                {savingSettings ? '儲存中…' : '儲存下載位置'}
              </button>
            </>
          )}
          <div className={classNames('statusPill', status === '已連線' && 'ok', status !== '已連線' && 'warn')}>{status}</div>
          <div className={classNames('statusPill', pushActive ? 'ok' : 'warn')}>{pushLabel}</div>
          <button
            className="btnIcon"
            onClick={() => setSettingsOpen((v) => !v)}
            title={settingsOpen ? '關閉設定' : '設定'}
          >
            設定
          </button>
        </div>
      </header>

      <div className="mainGrid">
        <aside className="sidebar">
          <div className="panelHeader">
            <div className="panelTitle">對話</div>
          </div>

          <div className="panelBody">
            <div className="row">
              <label className="label">用戶</label>
              <select
                className="select"
                value={selectedProfile}
                onChange={(e) => setSelectedProfile(e.target.value)}
                disabled={!profiles.length}
              >
                {(profiles.length ? profiles : ['default']).map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </div>

            <div className="openTabs">
              <div className="openTabsHeader">
                <button className="openTabsTitleBtn" onClick={() => setOpenTabsExpanded((v) => !v)} title="展開/收起">
                  已開啟 Gemini 分頁
                  <span className={classNames('chev', openTabsExpanded && 'chevOpen')}>▶</span>
                </button>
                <div className="openTabsRight">
                  <button
                    className="btnSmall"
                    onClick={async () => {
                      if (!api) return;
                      const t = await api.listOpenTabs();
                      if (t?.success) setOpenTabs(t.tabs || []);
                    }}
                    disabled={!api}
                    title="刷新"
                  >
                    刷新
                  </button>
                </div>
              </div>
              <div className={classNames('openTabsList', !openTabsExpanded && 'openTabsListHidden')}>
                {openTabs.length === 0 ? (
                  <div className="openTabsEmpty">目前沒有偵測到 Gemini 分頁</div>
                ) : (
                  openTabs.slice(0, 6).map((t, idx) => {
                    const p = t?.ping?.userProfile || t?.derivedUserProfile || 'default';
                    const cid = t?.ping?.chatId || t?.derivedChatId || '';
                    const title = t?.ping?.title || '';
                    return (
                      <div key={String(t.tabId || idx)} className="openTabItem">
                        <div className="openTabTop">
                          <span className="mono">{p}</span>
                          <span className="dot">•</span>
                          <span className="mono">{cid || '-'}</span>
                        </div>
                        <div className="openTabTitle">{title || '（未取得標題）'}</div>
                        <div className="openTabActions">
                          <button
                            className="btnTiny"
                            onClick={async () => {
                              if (!api) return;
                              if (p && cid) {
                                setSelectedProfile(p);
                                setSelectedChatId(String(cid));
                              }
                            }}
                            title="在後台切換到此對話"
                          >
                            切換
                          </button>
                          <button
                            className="btnTiny"
                            onClick={async () => {
                              if (!api) return;
                              if (typeof t.tabId === 'number') await api.focusTab(t.tabId);
                            }}
                            title="切到該分頁"
                          >
                            前往
                          </button>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>

            <div className="row">
              <input className="input" placeholder="搜尋標題 / chatId" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>

            <div className="convList">
              {filteredConversations.length === 0 ? (
                <div className="empty">尚無對話（先打開 Gemini 讓擴充功能開始記錄）</div>
              ) : (
                filteredConversations.map((c) => (
                  <button
                    key={c.chatId}
                    className={classNames('convItem', c.chatId === selectedChatId && 'active')}
                    onClick={() => {
                      setSelectedChatId(c.chatId);
                      const key = `${selectedProfile}:${c.chatId}`;
                      setUnread((m) => {
                        if (!m[key]) return m;
                        const { [key]: _, ...rest } = m;
                        return rest;
                      });
                    }}
                  >
                    <div className="convTitle">{c.title || '未命名對話'}</div>
                    <div className="convMeta">
                      <span className="mono">{c.chatId}</span>
                      {unread[`${selectedProfile}:${c.chatId}`] ? (
                        <>
                          <span className="dot">•</span>
                          <span className="badge">{unread[`${selectedProfile}:${c.chatId}`]}</span>
                        </>
                      ) : null}
                      <span className="dot">•</span>
                      <span>{c.lastUpdated ? formatTime(c.lastUpdated) : ''}</span>
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>
        </aside>

        <section className="chatPanel">
          <div className="chatHeader">
            <div className="chatTitle">{selectedConversation ? selectedConversation.title : '選擇一個對話'}</div>
            <div className="chatSub">
              <span className="mono">{selectedChatId || ''}</span>
              {selectedConversation?.url ? (
                <>
                  <span className="dot">•</span>
                  <a className="link" href={selectedConversation.url} target="_blank" rel="noreferrer">
                    Gemini
                  </a>
                </>
              ) : null}
              {loadingMessages ? (
                <>
                  <span className="dot">•</span>
                  <span>載入中…</span>
                </>
              ) : null}
            </div>
          </div>

          <div className="chatBody" ref={listRef}>
            {!selectedChatId ? (
              <div className="emptyChat">在左側選擇一個對話</div>
            ) : messages.length === 0 ? (
              <div className="emptyChat">此對話尚無已保存消息（請在 Gemini 中產生/刷新一下）</div>
            ) : (
              messages.map((m, idx) => <MessageBubble key={m.hash || m.id || String(idx)} msg={m} />)
            )}

            {selectedChatId && sending ? (
              <div className="msgRow msgRowAssistant">
                <div className="typingBubble" aria-label="typing">
                  <span className="dot1" />
                  <span className="dot2" />
                  <span className="dot3" />
                </div>
              </div>
            ) : null}
          </div>

          <div className="chatComposer">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              style={{ display: 'none' }}
              onChange={(e) => {
                const f = e.target.files?.[0] || null;
                setImageFile(f);
                if (imagePreviewUrl) URL.revokeObjectURL(imagePreviewUrl);
                setImagePreviewUrl(f ? URL.createObjectURL(f) : null);
              }}
            />
            <textarea
              className="textarea"
              placeholder={selectedChatId ? '輸入訊息…（會真正送到 Gemini）' : '先選擇一個對話'}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  if (!sending && (draft.trim() || imageFile)) sendMessage();
                }
              }}
              disabled={!selectedChatId || sending}
              rows={3}
            />
            <div className="composerRight">
              {imagePreviewUrl ? (
                <div className="attachPreview" title={imageFile?.name || 'image'}>
                  <img src={imagePreviewUrl} alt="attach" />
                  <button
                    className="btnRemove"
                    onClick={() => {
                      setImageFile(null);
                      if (imagePreviewUrl) URL.revokeObjectURL(imagePreviewUrl);
                      setImagePreviewUrl(null);
                      if (fileInputRef.current) fileInputRef.current.value = '';
                    }}
                    title="移除"
                  >
                    ×
                  </button>
                </div>
              ) : (
                <button
                  className="btnAttach"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={!selectedChatId || sending}
                  title="上傳圖片"
                >
                  上傳
                </button>
              )}

              <button className="btnPrimary" onClick={sendMessage} disabled={!selectedChatId || sending || (!draft.trim() && !imageFile)}>
                {sending ? '送出中…' : '送出'}
              </button>
            </div>
          </div>
        </section>
      </div>

      {error ? (
        <div className="toastError">
          <div className="toastTitle">錯誤</div>
          <div className="toastMsg">{error}</div>
        </div>
      ) : null}
    </div>
  );
}

