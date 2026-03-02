import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ConversationMeta, Message } from '../types';
import type { GapiClient } from '../client';
import { MessageBubble } from '../components/MessageBubble';
import { SimpleSearch } from '../components/SimpleSearch';

const LIST_POLL_INTERVAL = 10_000;
const DETAIL_POLL_INTERVAL = 5_000;

interface ConversationsPageProps {
  client: GapiClient;
}

export function ConversationsPage({ client }: ConversationsPageProps) {
  const [conversations, setConversations] = useState<ConversationMeta[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreviewUrl, setImagePreviewUrl] = useState<string | null>(null);

  const chatBodyRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      const el = chatBodyRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }, []);

  // Load conversations
  const loadConversations = useCallback(async () => {
    try {
      const data = await client.listConversations(100);
      setConversations(data.conversations);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [client]);

  // Load messages for selected conversation
  const loadMessages = useCallback(async (convId: string) => {
    try {
      const detail = await client.getConversation(convId);
      setMessages(detail.messages);
      scrollToBottom();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setMessages([]);
    }
  }, [client, scrollToBottom]);

  // Initial load
  useEffect(() => {
    loadConversations();
  }, [loadConversations]);

  // Load messages when selection changes
  useEffect(() => {
    if (selectedId) {
      setLoading(true);
      loadMessages(selectedId).finally(() => setLoading(false));
    } else {
      setMessages([]);
    }
  }, [selectedId, loadMessages]);

  // Poll conversations list
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!document.hidden) loadConversations();
    }, LIST_POLL_INTERVAL);
    return () => window.clearInterval(timer);
  }, [loadConversations]);

  // Poll selected conversation messages
  useEffect(() => {
    if (!selectedId) return;
    const timer = window.setInterval(() => {
      if (!document.hidden) loadMessages(selectedId);
    }, DETAIL_POLL_INTERVAL);
    return () => window.clearInterval(timer);
  }, [selectedId, loadMessages]);

  // Cleanup image preview
  useEffect(() => {
    return () => {
      if (imagePreviewUrl) URL.revokeObjectURL(imagePreviewUrl);
    };
  }, [imagePreviewUrl]);

  const filteredConversations = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return conversations;
    return conversations.filter((c) => c.title.toLowerCase().includes(q) || c.id.toLowerCase().includes(q));
  }, [conversations, search]);

  const selectedConversation = useMemo(
    () => conversations.find((c) => c.id === selectedId) || null,
    [conversations, selectedId],
  );

  const handleSend = async () => {
    if (!selectedId) return;
    const text = draft.trim();
    if (!text && !imageFile) return;

    setSending(true);
    setError(null);
    try {
      let attachments: string[] | undefined;

      if (imageFile) {
        const uploaded = await client.uploadImage(imageFile, selectedId);
        attachments = [uploaded.image_id];
      }

      if (text || attachments) {
        await client.sendMessage(selectedId, text || '', attachments);
      }

      setDraft('');
      setImageFile(null);
      if (imagePreviewUrl) URL.revokeObjectURL(imagePreviewUrl);
      setImagePreviewUrl(null);

      // Reload messages after sending
      await loadMessages(selectedId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] || null;
    setImageFile(f);
    if (imagePreviewUrl) URL.revokeObjectURL(imagePreviewUrl);
    setImagePreviewUrl(f ? URL.createObjectURL(f) : null);
  };

  const formatTime = (ts: number) => {
    try {
      return new Date(ts).toLocaleString('zh-TW', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return '';
    }
  };

  return (
    <div className="conversations-page">
      {error && (
        <div className="toast-error" role="alert" aria-live="assertive">
          <div className="toast-title">Error</div>
          <div className="toast-msg">{error}</div>
          <button className="btn-close" onClick={() => setError(null)} aria-label="關閉錯誤訊息">
            &times;
          </button>
        </div>
      )}

      <div className="conv-layout">
        {/* Sidebar */}
        <div className="conv-sidebar">
          <div className="conv-sidebar-header">
            <SimpleSearch value={search} onChange={setSearch} placeholder="搜尋對話..." />
          </div>
          <div className="conv-list" role="listbox" aria-label="對話列表">
            {filteredConversations.length === 0 ? (
              <div className="empty">尚無對話</div>
            ) : (
              filteredConversations.map((c) => (
                <button
                  key={c.id}
                  role="option"
                  aria-selected={c.id === selectedId}
                  className={`conv-item${c.id === selectedId ? ' active' : ''}`}
                  onClick={() => setSelectedId(c.id)}
                >
                  <div className="conv-title">{c.title || '未命名對話'}</div>
                  <div className="conv-meta">
                    <span className="mono">{c.id}</span>
                    <span className="dot">&middot;</span>
                    <span>{formatTime(c.updated_at)}</span>
                  </div>
                </button>
              ))
            )}
          </div>
        </div>

        {/* Chat panel */}
        <div className="chat-panel">
          <div className="chat-header">
            <div className="chat-title">
              {selectedConversation ? selectedConversation.title : '選擇一個對話'}
            </div>
            {selectedId && (
              <div className="chat-sub">
                <span className="mono">{selectedId}</span>
                {loading && (
                  <>
                    <span className="dot">&middot;</span>
                    <span>載入中...</span>
                  </>
                )}
              </div>
            )}
          </div>

          <div className="chat-body" ref={chatBodyRef}>
            {!selectedId ? (
              <div className="empty-chat">在左側選擇一個對話</div>
            ) : messages.length === 0 ? (
              <div className="empty-chat">此對話尚無訊息</div>
            ) : (
              messages.map((m) => <MessageBubble key={m.id} msg={m} client={client} />)
            )}
          </div>

          <div className="chat-composer">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              style={{ display: 'none' }}
              onChange={handleFileChange}
            />
            <div className="composer-row">
              <button
                className="btn-attach"
                onClick={() => fileInputRef.current?.click()}
                disabled={!selectedId || sending}
                title="上傳圖片"
              >
                圖片
              </button>

              <div className="composer-input-area">
                {imagePreviewUrl && (
                  <div className="attach-preview-small">
                    <img src={imagePreviewUrl} alt="Preview" />
                    <button
                      className="btn-remove-preview"
                      onClick={() => {
                        setImageFile(null);
                        if (imagePreviewUrl) URL.revokeObjectURL(imagePreviewUrl);
                        setImagePreviewUrl(null);
                      }}
                      aria-label="移除圖片"
                    >
                      &times;
                    </button>
                  </div>
                )}
                <textarea
                  className="textarea"
                  placeholder={selectedId ? '輸入訊息...' : '先選擇一個對話'}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      if (!sending && (draft.trim() || imageFile)) handleSend();
                    }
                  }}
                  disabled={!selectedId || sending}
                  rows={3}
                />
              </div>

              <button
                className="btn-primary"
                onClick={handleSend}
                disabled={!selectedId || sending || (!draft.trim() && !imageFile)}
              >
                {sending ? '送出中...' : '送出'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
