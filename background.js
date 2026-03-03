// Background Service Worker
// 處理 Side Panel 的開啟邏輯和擴充功能的核心功能

// 本地資料庫（IndexedDB）
// - 用於保存大量對話訊息，避免 chrome.storage.local 配額與大物件讀寫成本
importScripts('db.js');

// R2 儲存客戶端
// - 用於將對話紀錄上傳到 Cloudflare R2 並從 R2 查詢
importScripts('r2.js');

// 分頁路由模組
// - 抽象化多站點分頁查詢，取代寫死的 URL
importScripts('tab-router.js');

// ========== Admin Web Realtime Push (externally_connectable) ==========
// Keep service worker alive while admin page is open via Port.
const adminPorts = new Set();

// ========== GAPI Server WebSocket Connection (P0.2) ==========
// WebSocket client for authenticated communication with GAPI Server

const DEFAULT_GAPI_HOST = 'localhost:18799';
let GAPI_WS_URL = `ws://${DEFAULT_GAPI_HOST}/ws`;
let GAPI_HTTP_URL = `http://${DEFAULT_GAPI_HOST}`;
const RECONNECT_INTERVAL = 5000; // 5 seconds (fast-path setTimeout)
const PING_INTERVAL = 60000; // 1 minute (chrome.alarms minimum interval)

// chrome.alarms names for MV3 service worker persistence
const ALARM_TOKEN_REFRESH = 'gapi_token_refresh';
const ALARM_HEARTBEAT = 'gapi_heartbeat';
const ALARM_RECONNECT = 'gapi_reconnect';

// 從 storage 讀取 Server 配置，更新全域 URL
async function loadServerConfig() {
  try {
    const result = await chrome.storage.local.get(['gapiServerHost']);
    const host = result.gapiServerHost || DEFAULT_GAPI_HOST;
    GAPI_WS_URL = `ws://${host}/ws`;
    GAPI_HTTP_URL = `http://${host}`;
    console.log(`[GAPI] Server config loaded: ${host}`);
  } catch (e) {
    console.warn('[GAPI] Failed to load server config, using default:', e);
  }
}

// 監聽 storage 變更，URL 改變時自動重連
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.gapiServerHost) {
    const newHost = changes.gapiServerHost.newValue || DEFAULT_GAPI_HOST;
    console.log(`[GAPI] Server host changed to: ${newHost}`);
    GAPI_WS_URL = `ws://${newHost}/ws`;
    GAPI_HTTP_URL = `http://${newHost}`;
    // 更新 TokenManager 的 server URL
    tokenManager.serverUrl = GAPI_HTTP_URL;
    tokenManager.invalidate();
    // 更新 HTTP client 的 base URL
    gapiHttpClient.baseUrl = GAPI_HTTP_URL;
    // 重連 WebSocket
    if (gapiClient.ws) {
      gapiClient.disconnect();
    }
    initGAPIConnection();
    initGAPIHttpConnection();
  }
});

// ========== Token Manager ==========
// Manages authentication tokens obtained from the GAPI server.
// Caches tokens in chrome.storage.local and auto-refreshes before expiry.

class TokenManager {
  constructor(serverUrl) {
    this.serverUrl = serverUrl;
    this.token = null;
    this.expiresAt = 0;
    this.extensionId = null;
  }

  async getToken(extensionId, forceRefresh = false) {
    this.extensionId = extensionId;

    if (!forceRefresh) {
      // Return cached token if still valid (with 5-min buffer)
      if (this.token && Date.now() < this.expiresAt - 300000) {
        return this.token;
      }

      // Try to load from storage
      try {
        const stored = await chrome.storage.local.get(['gapi_token', 'gapi_token_expires']);
        if (stored.gapi_token && Date.now() < (stored.gapi_token_expires || 0) - 300000) {
          this.token = stored.gapi_token;
          this.expiresAt = stored.gapi_token_expires;
          this.scheduleRefresh();
          return this.token;
        }
      } catch (e) {
        console.warn('[TokenManager] Storage read failed:', e);
      }
    }

    // Fetch new token from server
    return this.refreshToken(extensionId);
  }

  async refreshToken(extensionId) {
    const eid = extensionId || this.extensionId;
    if (!eid) throw new Error('No extensionId for token refresh');

    try {
      const resp = await fetch(`${this.serverUrl}/v1/auth/token?extension_id=${encodeURIComponent(eid)}`, {
        method: 'POST'
      });
      if (!resp.ok) throw new Error(`Token request failed: ${resp.status}`);
      const data = await resp.json();

      this.token = data.token;
      this.expiresAt = data.expires_at;

      // Cache in storage
      try {
        await chrome.storage.local.set({
          gapi_token: this.token,
          gapi_token_expires: this.expiresAt
        });
      } catch (e) {
        console.warn('[TokenManager] Storage write failed:', e);
      }

      this.scheduleRefresh();
      console.log('[TokenManager] Token refreshed, expires at', new Date(this.expiresAt).toISOString());
      return this.token;
    } catch (e) {
      console.error('[TokenManager] Failed to get token:', e);
      throw e; // Propagate error — do not return stale token
    }
  }

  scheduleRefresh() {
    // Use chrome.alarms for MV3 persistence (survives service worker suspension)
    const delayMs = Math.max(0, this.expiresAt - Date.now() - 300000);
    if (delayMs > 0) {
      const delayMinutes = Math.max(1, delayMs / 60000); // chrome.alarms minimum = 1 min
      chrome.alarms.create(ALARM_TOKEN_REFRESH, { delayInMinutes: delayMinutes });
      console.log(`[TokenManager] Scheduled refresh in ${Math.round(delayMinutes)} min`);
    }
  }

  invalidate() {
    this.token = null;
    this.expiresAt = 0;
    chrome.alarms.clear(ALARM_TOKEN_REFRESH);
    try {
      chrome.storage.local.remove(['gapi_token', 'gapi_token_expires']);
    } catch (e) {}
  }
}

// 全域 TokenManager 實例
const tokenManager = new TokenManager(GAPI_HTTP_URL);

class GAPIWebSocketClient {
  constructor() {
    this.ws = null;
    this.sessionId = null;
    this.extensionId = null;
    this.authenticated = false;
    this.reconnectTimer = null;
    this.messageHandlers = new Map();
    this.pendingRequests = new Map();
  }

  // 生成認證 Token (透過 TokenManager 從 server 取得)
  async generateToken(extensionId, forceRefresh = false) {
    return tokenManager.getToken(extensionId, forceRefresh);
  }

  // 連接到 GAPI Server
  async connect(extensionId, options = {}) {
    this.extensionId = extensionId;
    const forceNewToken = options.forceNewToken || false;

    // Clear any pending reconnect alarm since we're connecting now
    chrome.alarms.clear(ALARM_RECONNECT);

    return new Promise((resolve, reject) => {
      try {
        console.log(`[GAPI-WS] Connecting to ${GAPI_WS_URL}/${extensionId}... (forceNewToken=${forceNewToken})`);
        this.ws = new WebSocket(`${GAPI_WS_URL}/${extensionId}`);

        this.ws.onopen = () => {
          console.log('[GAPI-WS] Connection opened, sending auth...');
          // 發送認證訊息 (force refresh token on reconnect)
          this.generateToken(extensionId, forceNewToken).then(token => {
            this.send({
              type: 'auth',
              payload: { token }
            });
          }).catch(err => {
            console.error('[GAPI-WS] Token generation failed:', err);
            reject(err);
          });
        };

        this.ws.onmessage = (event) => {
          this.handleMessage(event.data);
        };

        this.ws.onerror = (error) => {
          console.error('[GAPI-WS] Error:', error);
        };

        this.ws.onclose = () => {
          console.log('[GAPI-WS] Connection closed');
          this.authenticated = false;
          chrome.action.setBadgeText({ text: '' });
          this.scheduleReconnect();
        };

        // 等待認證結果
        this.pendingRequests.set('auth', { resolve, reject });
        
        // 設置超時
        setTimeout(() => {
          if (this.pendingRequests.has('auth')) {
            this.pendingRequests.delete('auth');
            reject(new Error('Auth timeout'));
          }
        }, 10000);

      } catch (error) {
        console.error('[GAPI-WS] Connection error:', error);
        reject(error);
      }
    });
  }

  // 處理收到的訊息
  handleMessage(data) {
    try {
      const msg = JSON.parse(data);
      console.log('[GAPI-WS] Received:', msg.type);

      // 處理認證回應
      if (msg.type === 'auth_ok') {
        this.authenticated = true;
        this.sessionId = msg.payload.session_id;

        const pending = this.pendingRequests.get('auth');
        if (pending) {
          pending.resolve(this.sessionId);
          this.pendingRequests.delete('auth');
        }

        // Show green "ON" badge
        chrome.action.setBadgeText({ text: 'ON' });
        chrome.action.setBadgeBackgroundColor({ color: '#22c55e' });

        this.startHeartbeat();
        this.notifyAdmin({ type: 'gapi_connected', sessionId: this.sessionId });
        this.syncPages();
        return;
      }

      if (msg.type === 'auth_error') {
        const reason = msg.payload.reason || 'unknown';
        console.warn(`[GAPI-WS] Auth failed: ${msg.payload.message} (reason=${reason})`);

        const pending = this.pendingRequests.get('auth');
        if (pending) {
          pending.reject(new Error(msg.payload.message || 'Auth failed'));
          this.pendingRequests.delete('auth');
        }

        // Invalidate stale token, close zombie WS, schedule reconnect with fresh token
        tokenManager.invalidate();
        if (this.ws) {
          this.ws.onclose = null; // prevent onclose from scheduling a duplicate reconnect
          this.ws.close();
          this.ws = null;
        }
        this.authenticated = false;
        this.scheduleReconnect();
        return;
      }

      // 處理心跳回應
      if (msg.type === 'pong') {
        console.log('[GAPI-WS] Pong received');
        return;
      }

      // 處理訊息流
      if (msg.type === 'message_stream') {
        const handler = this.messageHandlers.get('stream');
        if (handler) handler(msg.payload);
        return;
      }

      // 處理一般訊息
      if (msg.type === 'conversation_data') {
        const handler = this.messageHandlers.get('conversation_data');
        if (handler) handler(msg.payload);
        return;
      }

      if (msg.type === 'message_sent') {
        const handler = this.messageHandlers.get('message_sent');
        if (handler) handler(msg.payload);
        return;
      }

      // 處理事件推送
      if (msg.type === 'event_push') {
        const handler = this.messageHandlers.get('event_push');
        if (handler) handler(msg.payload);
        // 廣播給 Admin Web
        broadcastAdminEvent('gapi_event', msg.payload);
        return;
      }

      if (msg.type === 'pages_sync_ok') {
        console.log('[GAPI-WS] Pages synced:', msg.payload.count);
        return;
      }

      // 遠端更新 — soft: reinject content scripts / full: chrome.runtime.reload()
      if (msg.type === 'reload_extension') {
        const mode = msg.payload?.mode || 'soft';
        console.log(`[GAPI-WS] Remote reload requested (mode=${mode})`);
        if (mode === 'full') {
          // Full reload: restart entire extension (background.js + content scripts)
          this.send({ type: 'reload_ack', payload: { status: 'reloading' } });
          setTimeout(() => chrome.runtime.reload(), 500);
        } else {
          // Soft reload: only reinject content scripts
          (async () => {
            try {
              const count = await reinjectContentScripts();
              this.send({ type: 'reload_ack', payload: { status: 'updated', tabs_updated: count } });
            } catch (err) {
              this.send({ type: 'reload_ack', payload: { status: 'error', error: err.message } });
            }
          })();
        }
        return;
      }

      // 處理 server 下發的分頁指令
      if (msg.type === 'tab_command') {
        console.log('[GAPI-WS] Tab command received:', JSON.stringify(msg.payload));
        const self = this;
        (async () => {
          try {
            await self.handleTabCommand(msg.payload);
          } catch (err) {
            console.error('[GAPI-WS] handleTabCommand uncaught:', err);
            self.send({
              type: 'tab_command_result',
              payload: { command_id: msg.payload.command_id, success: false, error: String(err) }
            });
          }
        })();
        return;
      }

    } catch (error) {
      console.error('[GAPI-WS] Message parse error:', error);
    }
  }

  // 發送訊息
  send(message) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
      return true;
    }
    console.warn('[GAPI-WS] Cannot send, not connected');
    return false;
  }

  // 同步對話
  async syncConversation(conversationId, lastMessageTs = 0) {
    if (!this.authenticated) {
      throw new Error('Not authenticated');
    }

    return new Promise((resolve, reject) => {
      const requestId = `sync_${Date.now()}`;
      
      this.pendingRequests.set(requestId, { resolve, reject });
      
      this.send({
        type: 'conversation_sync',
        payload: {
          conversation_id: conversationId,
          last_message_ts: lastMessageTs
        }
      });

      // 註冊一次性 handler
      this.messageHandlers.set('conversation_data', (data) => {
        if (data.conversation_id === conversationId) {
          const pending = this.pendingRequests.get(requestId);
          if (pending) {
            pending.resolve(data);
            this.pendingRequests.delete(requestId);
            this.messageHandlers.delete('conversation_data');
          }
        }
      });

      setTimeout(() => {
        if (this.pendingRequests.has(requestId)) {
          this.pendingRequests.delete(requestId);
          this.messageHandlers.delete('conversation_data');
          reject(new Error('Sync timeout'));
        }
      }, 10000);
    });
  }

  // 發送訊息
  async sendMessage(conversationId, content, attachments = []) {
    if (!this.authenticated) {
      throw new Error('Not authenticated');
    }

    return new Promise((resolve, reject) => {
      const requestId = `msg_${Date.now()}`;
      
      this.pendingRequests.set(requestId, { resolve, reject });
      
      this.send({
        type: 'message_send',
        payload: {
          conversation_id: conversationId,
          content,
          attachments
        }
      });

      // 註冊 handler
      this.messageHandlers.set('message_sent', (data) => {
        const pending = this.pendingRequests.get(requestId);
        if (pending) {
          pending.resolve(data);
          this.pendingRequests.delete(requestId);
        }
      });

      setTimeout(() => {
        if (this.pendingRequests.has(requestId)) {
          this.pendingRequests.delete(requestId);
          this.messageHandlers.delete('message_sent');
          reject(new Error('Send message timeout'));
        }
      }, 30000);
    });
  }

  // 開始心跳 — use chrome.alarms for MV3 persistence
  startHeartbeat() {
    chrome.alarms.create(ALARM_HEARTBEAT, { periodInMinutes: 1 });
  }

  // 安排重連 — dual strategy: fast setTimeout + chrome.alarms fallback
  scheduleReconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    // Fast path: 5s setTimeout (works if service worker stays active)
    this.reconnectTimer = setTimeout(() => {
      if (this.extensionId) {
        console.log('[GAPI-WS] Fast reconnect attempt...');
        this.connect(this.extensionId, { forceNewToken: true }).catch(err => {
          console.error('[GAPI-WS] Fast reconnect failed:', err);
        });
      }
    }, RECONNECT_INTERVAL);

    // Fallback: chrome.alarms (1 min) — guaranteed to fire even after SW suspension
    chrome.alarms.create(ALARM_RECONNECT, { delayInMinutes: 1 });
  }

  // 同步活躍頁面到 GAPI Server
  // 處理 server 下發的分頁指令（sendMessage / GET_LAST_RESPONSE）
  async handleTabCommand(payload) {
    const { command_id, tab_id, action, message } = payload;
    console.log(`[GAPI-WS] Tab command: ${action} → tab ${tab_id} (${command_id})`);

    const sendResult = (result) => {
      this.send({
        type: 'tab_command_result',
        payload: { command_id, ...result }
      });
    };

    const buildMsg = () => {
      if (action === 'sendMessage' || action === 'SEND_MESSAGE') {
        return { action: 'sendMessage', messageText: message };
      }
      return { action };
    };

    const trySend = (tabId, msg) => new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(tabId, msg, (resp) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(resp);
      });
    });

    // getInfo: get tab's conversation info (chatId, title, url)
    if (action === 'getInfo') {
      try {
        const resp = await trySend(tab_id, { action: 'getCurrentConversation' });
        const tab = await chrome.tabs.get(tab_id);
        sendResult({
          success: true,
          data: {
            tab_id,
            url: tab.url,
            chat_id: resp?.chatId || null,
            title: resp?.title || null,
            page_title: tab.title || null
          }
        });
      } catch (err) {
        sendResult({ success: false, error: err.message });
      }
      return;
    }

    // createTab: open a new browser tab
    if (action === 'createTab') {
      try {
        const url = message || 'https://gemini.google.com/app';
        const tab = await chrome.tabs.create({ url });
        console.log(`[GAPI-WS] Created tab ${tab.id} → ${url}`);
        sendResult({ success: true, data: { tab_id: tab.id, url } });
        // Sync pages after creating tab (delayed to allow content script injection)
        setTimeout(() => this.syncPages(), 5000);
      } catch (err) {
        console.error('[GAPI-WS] createTab failed:', err);
        sendResult({ success: false, error: err.message });
      }
      return;
    }

    // GET_LAST_RESPONSE / inspect* / customQuery / expandToolCalls: always use direct execution (chrome.scripting)
    // SEND_MESSAGE: use content script handler (more reliable for framework state)
    const directActions = [
      'GET_LAST_RESPONSE', 'EXTRACT_IMAGES', 'inspectDOM', 'inspectMessages', 'inspectReply',
      'inspectToolCalls', 'expandToolCalls', 'customQuery',
      'NEBULA_LIST_FILES', 'NEBULA_GET_FILE'
    ];
    if (directActions.includes(action)) {
      try {
        const result = await this.executeDirectCommand(tab_id, action, message, payload);
        sendResult({ success: true, data: result });
      } catch (directErr) {
        console.error(`[GAPI-WS] Direct ${action} failed:`, directErr);
        sendResult({ success: false, error: directErr.message });
      }
      return;
    }

    // For send: use content script, auto-inject if stale
    try {
      const response = await trySend(tab_id, buildMsg());
      sendResult({ success: true, data: response });
    } catch (err) {
      const needsInject = err.message.includes('Receiving end does not exist')
        || err.message.includes('message port closed');
      if (needsInject) {
        console.log('[GAPI-WS] Content script stale, injecting...');
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab_id },
            files: ['content-site-registry.js', 'content-site-gemini.js', 'content-site-claude.js', 'content-site-nebula.js', 'content.js']
          });
          await new Promise(r => setTimeout(r, 1500));
          const response = await trySend(tab_id, buildMsg());
          sendResult({ success: true, data: response });
        } catch (retryErr) {
          console.error('[GAPI-WS] Send failed after inject:', retryErr);
          sendResult({ success: false, error: retryErr.message });
        }
      } else {
        console.error('[GAPI-WS] Send failed:', err);
        sendResult({ success: false, error: err.message });
      }
    }
  }

  // Direct execution fallback — bypasses content script listeners entirely
  async executeDirectCommand(tabId, action, message, payload = {}) {
    if (action === 'GET_LAST_RESPONSE') {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const host = location.hostname;

          // --- Nebula: site-specific extraction ---
          if (host.includes('nebula.gg')) {
            const blocks = document.querySelectorAll('.user-message-block');
            if (blocks.length === 0) return { status: 'failed', reason: 'No messages found on Nebula' };
            const lastBlock = blocks[blocks.length - 1];
            // The reply div is the 2nd child of .user-message-block.
            // Its classes are: ml-1.5 border-l-2 pl-2 transition-colors duration-300 border-border/20
            const reply = lastBlock.children[1];
            if (!reply) return { status: 'failed', reason: 'No AI reply in last message block' };

            // Use innerText split on newlines for positional stripping.
            // Line structure emitted by Nebula:
            //   [0] Agent name     — e.g. "Nebula", "GPT-4" (no digits/punct, short)
            //   [1] Timestamp      — e.g. "上午11:19", "下午3:45", "AM 9:00"
            //   [2..N] AI content  — one or more lines of actual response
            //   [N+1] (optional)   — response time e.g. "1.4s"
            //   [N+2] (optional)   — token count   e.g. "940 tokens"
            //   [N+3] (optional)   — reaction count e.g. "1" (bare integer)
            const RE_TIMESTAMP   = /^(上午|下午|AM|PM)\s*\d{1,2}:\d{2}$/;
            const RE_AGENT_NAME  = /^[^\d\W]{1,40}$/u;
            const RE_RESP_TIME   = /^\d+(\.\d+)?s$/;
            const RE_TOKEN_COUNT = /^\d+\s*tokens?$/i;
            const RE_REACTION    = /^\d+$/;

            const rawLines = reply.innerText.split('\n').map(l => l.trim()).filter(l => l.length > 0);

            let start = 0;
            // Strip leading agent name line
            if (rawLines.length > 0 && RE_AGENT_NAME.test(rawLines[0])) {
              start = 1;
            }
            // Strip timestamp line immediately after the agent name
            if (rawLines.length > start && RE_TIMESTAMP.test(rawLines[start])) {
              start += 1;
            }

            let end = rawLines.length;
            // Strip trailing reaction count (bare integer)
            if (end > start && RE_REACTION.test(rawLines[end - 1])) {
              end -= 1;
            }
            // Strip trailing token count
            if (end > start && RE_TOKEN_COUNT.test(rawLines[end - 1])) {
              end -= 1;
            }
            // Strip trailing response time
            if (end > start && RE_RESP_TIME.test(rawLines[end - 1])) {
              end -= 1;
            }

            const text = rawLines.slice(start, end).join('\n').trim();
            return text ? { status: 'success', data: text } : { status: 'failed', reason: 'Empty AI reply after metadata strip' };
          }

          // --- Claude: site-specific selectors ---
          if (host.includes('claude.ai')) {
            const selectors = [
              '[class*="response"]',
              '.font-claude-message',
              '[data-testid="ai-turn"]',
              '[data-role="assistant"]',
              '[data-message-author-role="assistant"]'
            ];
            let elements = [];
            for (const sel of selectors) {
              elements = document.querySelectorAll(sel);
              if (elements.length > 0) break;
            }
            if (elements.length === 0) return { status: 'failed', reason: 'No AI response found on Claude' };
            const last = elements[elements.length - 1];
            const clone = last.cloneNode(true);
            clone.querySelectorAll('button, [role="button"], [aria-label], .thinking-toggle').forEach(n => n.remove());
            const text = clone.innerText.replace(/\s+/g, ' ').trim();
            return text ? { status: 'success', data: text } : { status: 'failed', reason: 'Empty AI response' };
          }

          // --- Gemini (default): site-specific selectors ---
          const selectors = [
            'message-content', '.message-content',
            '[class*="model-response"]', '[data-role="model"]',
            '[data-message-role="model"]',
            // Generic fallbacks
            '[data-role="assistant"]',
            '[data-message-author-role="assistant"]',
            '[class*="assistant"]',
            '[class*="response"]'
          ];
          let elements = [];
          for (const sel of selectors) {
            elements = document.querySelectorAll(sel);
            if (elements.length > 0) break;
          }
          if (elements.length === 0) return { status: 'failed', reason: 'No AI response found' };
          const last = elements[elements.length - 1];
          const clone = last.cloneNode(true);
          clone.querySelectorAll('button, [role="button"], [aria-label], .thinking-toggle').forEach(n => n.remove());
          const text = clone.innerText.replace(/\s+/g, ' ').trim();

          // Extract images from the last response container
          const imageDomains = ['googleusercontent.com', 'gstatic.com', 'ggpht.com', 'google.com/images'];
          const images = [];
          last.querySelectorAll('img').forEach((img, idx) => {
            const src = img.src || '';
            if (!src) return;
            // Filter: must be from an image-hosting domain, skip tiny icons/avatars
            const isHosted = imageDomains.some(d => src.includes(d));
            const w = img.naturalWidth || img.width || 0;
            const h = img.naturalHeight || img.height || 0;
            if (isHosted && (w > 48 || h > 48 || (w === 0 && h === 0))) {
              images.push({
                src,
                alt: img.alt || '',
                width: img.width || 0,
                height: img.height || 0,
                naturalWidth: img.naturalWidth || 0,
                naturalHeight: img.naturalHeight || 0,
                index: idx
              });
            }
          });

          if (!text && images.length === 0) return { status: 'failed', reason: 'Empty AI response' };
          return { status: 'success', data: text, images };
        }
      });
      return results[0]?.result || { status: 'failed', reason: 'Script execution returned no result' };
    }

    if (action === 'EXTRACT_IMAGES') {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: (messageIndex) => {
          const host = location.hostname;

          // Image-hosting domains to match against
          const imageDomains = ['googleusercontent.com', 'gstatic.com', 'ggpht.com', 'google.com/images'];

          // Helper: extract image info from a container element
          const extractImages = (container) => {
            const imgs = [];
            container.querySelectorAll('img').forEach((img, idx) => {
              const src = img.src || '';
              if (!src) return;
              // Must be from an image-hosting domain
              const isHosted = imageDomains.some(d => src.includes(d));
              if (!isHosted) return;
              // Skip tiny icons and avatars (<=48px in both dimensions)
              const w = img.naturalWidth || img.width || 0;
              const h = img.naturalHeight || img.height || 0;
              if (w > 0 && w <= 48 && h > 0 && h <= 48) return;
              imgs.push({
                src,
                alt: img.alt || '',
                width: img.width || 0,
                height: img.height || 0,
                naturalWidth: img.naturalWidth || 0,
                naturalHeight: img.naturalHeight || 0,
                index: idx
              });
            });
            return imgs;
          };

          // --- Gemini ---
          if (host.includes('gemini.google.com')) {
            // Find model response containers
            const responseSelectors = [
              'message-content', '.message-content',
              '[class*="model-response"]', '[data-role="model"]',
              '[data-message-role="model"]'
            ];
            let responseBlocks = [];
            for (const sel of responseSelectors) {
              responseBlocks = Array.from(document.querySelectorAll(sel));
              if (responseBlocks.length > 0) break;
            }
            if (responseBlocks.length === 0) {
              return { status: 'failed', reason: 'No model response containers found' };
            }

            // If message_index specified, extract from that block only
            if (typeof messageIndex === 'number' && messageIndex >= 0) {
              if (messageIndex >= responseBlocks.length) {
                return { status: 'failed', reason: `message_index ${messageIndex} out of range (total: ${responseBlocks.length})` };
              }
              const imgs = extractImages(responseBlocks[messageIndex]);
              return { status: 'success', total_responses: responseBlocks.length, message_index: messageIndex, images: imgs };
            }

            // Extract from all response blocks
            const allImages = [];
            responseBlocks.forEach((block, blockIdx) => {
              const imgs = extractImages(block);
              imgs.forEach(img => {
                allImages.push({ ...img, message_index: blockIdx });
              });
            });
            return { status: 'success', total_responses: responseBlocks.length, images: allImages };
          }

          // --- Claude ---
          if (host.includes('claude.ai')) {
            const selectors = [
              '[class*="response"]',
              '.font-claude-message',
              '[data-testid="ai-turn"]',
              '[data-role="assistant"]',
              '[data-message-author-role="assistant"]'
            ];
            let responseBlocks = [];
            for (const sel of selectors) {
              responseBlocks = Array.from(document.querySelectorAll(sel));
              if (responseBlocks.length > 0) break;
            }
            if (responseBlocks.length === 0) {
              return { status: 'failed', reason: 'No AI response containers found on Claude' };
            }

            if (typeof messageIndex === 'number' && messageIndex >= 0) {
              if (messageIndex >= responseBlocks.length) {
                return { status: 'failed', reason: `message_index ${messageIndex} out of range (total: ${responseBlocks.length})` };
              }
              const imgs = extractImages(responseBlocks[messageIndex]);
              return { status: 'success', total_responses: responseBlocks.length, message_index: messageIndex, images: imgs };
            }

            const allImages = [];
            responseBlocks.forEach((block, blockIdx) => {
              const imgs = extractImages(block);
              imgs.forEach(img => {
                allImages.push({ ...img, message_index: blockIdx });
              });
            });
            return { status: 'success', total_responses: responseBlocks.length, images: allImages };
          }

          // --- Generic fallback ---
          const fallbackSelectors = [
            '[data-role="assistant"]',
            '[data-message-author-role="assistant"]',
            '[class*="assistant"]',
            '[class*="response"]'
          ];
          let responseBlocks = [];
          for (const sel of fallbackSelectors) {
            responseBlocks = Array.from(document.querySelectorAll(sel));
            if (responseBlocks.length > 0) break;
          }
          if (responseBlocks.length === 0) {
            return { status: 'failed', reason: 'No AI response containers found' };
          }

          if (typeof messageIndex === 'number' && messageIndex >= 0) {
            if (messageIndex >= responseBlocks.length) {
              return { status: 'failed', reason: `message_index ${messageIndex} out of range (total: ${responseBlocks.length})` };
            }
            const imgs = extractImages(responseBlocks[messageIndex]);
            return { status: 'success', total_responses: responseBlocks.length, message_index: messageIndex, images: imgs };
          }

          const allImages = [];
          responseBlocks.forEach((block, blockIdx) => {
            const imgs = extractImages(block);
            imgs.forEach(img => {
              allImages.push({ ...img, message_index: blockIdx });
            });
          });
          return { status: 'success', total_responses: responseBlocks.length, images: allImages };
        },
        args: [payload.message_index !== undefined ? payload.message_index : null]
      });
      return results[0]?.result || { status: 'failed', reason: 'Script execution returned no result' };
    }

    if (action === 'sendMessage' || action === 'SEND_MESSAGE' || action === 'ACTION_SEND_MESSAGE') {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: (text) => {
          return new Promise((resolve) => {
            const selectors = [
              'div[contenteditable="true"][role="textbox"]',
              '[contenteditable="true"][role="textbox"]',
              'div[contenteditable="true"]',
              'textarea'
            ];
            let input = null;
            for (const sel of selectors) {
              input = document.querySelector(sel);
              if (input) break;
            }
            if (!input) { resolve({ status: 'failed', reason: 'Input field not found' }); return; }

            // Clear and focus
            input.focus();
            if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
              input.value = text;
              input.dispatchEvent(new Event('input', { bubbles: true }));
            } else {
              // contenteditable — detect ProseMirror and use clipboard paste simulation.
              // ProseMirror maintains its own internal document model and ignores
              // direct DOM changes (textContent, execCommand). Paste events are the
              // reliable way to feed text through ProseMirror's input pipeline.
              const isPM = input.classList.contains('ProseMirror') ||
                input.closest('.ProseMirror') !== null;

              if (isPM) {
                // ProseMirror: clear via select-all + delete, then paste
                input.dispatchEvent(new KeyboardEvent('keydown', {
                  key: 'a', code: 'KeyA', keyCode: 65,
                  ctrlKey: true, bubbles: true, cancelable: true
                }));
                setTimeout(() => {
                  input.dispatchEvent(new KeyboardEvent('keydown', {
                    key: 'Backspace', code: 'Backspace', keyCode: 8,
                    bubbles: true, cancelable: true
                  }));
                  setTimeout(() => {
                    const dt = new DataTransfer();
                    dt.setData('text/plain', text);
                    input.dispatchEvent(new ClipboardEvent('paste', {
                      bubbles: true, cancelable: true, clipboardData: dt
                    }));
                  }, 50);
                }, 50);
              } else {
                // Non-ProseMirror contenteditable: use textContent + InputEvent
                input.textContent = text;
                input.dispatchEvent(new InputEvent('input', {
                  bubbles: true, inputType: 'insertText', data: text
                }));
              }
            }

            // Wait for send button to become enabled, then click
            let attempts = 0;
            const tryClick = () => {
              const btnSels = [
                'button[aria-label*="Send message"]',
                'button[aria-label*="Send"]',
                'button[aria-label*="傳送訊息"]',
                'button[aria-label*="傳送"]',
                'button[aria-label*="send"]',
                'button[type="submit"]'
              ];
              for (const sel of btnSels) {
                const btn = document.querySelector(sel);
                if (btn && !btn.disabled) { btn.click(); resolve({ status: 'success' }); return; }
              }
              attempts++;
              if (attempts < 10) { setTimeout(tryClick, 200); }
              else { resolve({ status: 'failed', reason: 'Send button not found or disabled' }); }
            };
            setTimeout(tryClick, 300);
          });
        },
        args: [message]
      });
      return results[0]?.result || { status: 'failed', reason: 'Script execution returned no result' };
    }

    if (action === 'inspectMessages') {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          // Find all message-like elements and show their structure
          const blocks = document.querySelectorAll('[class*="message-block"], [class*="message"]');
          const msgs = [];
          blocks.forEach((b, i) => {
            if (i > 10) return;
            msgs.push({
              index: i,
              tag: b.tagName,
              classes: b.className?.substring(0, 200) || '',
              childCount: b.children.length,
              text: b.innerText?.substring(0, 300) || '',
              attrs: Array.from(b.attributes).map(a => `${a.name}=${a.value.substring(0, 50)}`).slice(0, 10),
              children: Array.from(b.children).slice(0, 5).map(c => ({
                tag: c.tagName,
                classes: c.className?.substring(0, 100) || '',
                text: c.innerText?.substring(0, 100) || ''
              }))
            });
          });
          return { messageBlocks: msgs, total: blocks.length, url: location.href };
        }
      });
      return results[0]?.result || { status: 'failed', reason: 'No result' };
    }

    if (action === 'inspectDOM') {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          // Response selectors
          const respSels = [
            'message-content', '.message-content',
            '[class*="model-response"]', '[data-role="model"]',
            '.font-claude-message', '[data-testid="ai-turn"]',
            '[data-testid="user-message"]',
            '[data-role="assistant"]', '[class*="assistant"]',
            '[class*="response"]', '[class*="message"]'
          ];
          const found = {};
          for (const sel of respSels) {
            try {
              const els = document.querySelectorAll(sel);
              if (els.length > 0) {
                const last = els[els.length - 1];
                found[sel] = {
                  count: els.length,
                  tag: last.tagName,
                  classes: last.className?.substring?.(0, 150) || '',
                  sample: last.innerText?.substring(0, 200) || ''
                };
              }
            } catch(e) {}
          }
          // Input fields
          const inputSels = [
            'div.ProseMirror[contenteditable="true"]',
            'div[contenteditable="true"][data-placeholder]',
            'div[contenteditable="true"][role="textbox"]',
            'div[contenteditable="true"]',
            '[data-testid="chat-input"]',
            'textarea'
          ];
          const inputs = {};
          for (const sel of inputSels) {
            try {
              const el = document.querySelector(sel);
              if (el) {
                inputs[sel] = {
                  tag: el.tagName,
                  placeholder: el.getAttribute('placeholder') || el.getAttribute('aria-label') || el.getAttribute('data-placeholder') || '',
                  classes: el.className?.substring?.(0, 150) || ''
                };
              }
            } catch(e) {}
          }
          // Send buttons
          const btnSels = [
            'button[data-testid="send-button"]',
            'button[aria-label*="Send"]',
            'button[aria-label*="send"]',
            'button[type="submit"]'
          ];
          const buttons = {};
          for (const sel of btnSels) {
            try {
              const el = document.querySelector(sel);
              if (el) {
                buttons[sel] = {
                  text: el.innerText?.substring(0, 50) || '',
                  ariaLabel: el.getAttribute('aria-label') || '',
                  disabled: el.disabled
                };
              }
            } catch(e) {}
          }
          // data-testid values
          const testIds = new Set();
          document.querySelectorAll('[data-testid]').forEach(el => testIds.add(el.getAttribute('data-testid')));
          return { found, inputs, buttons, testIds: [...testIds].slice(0, 50), url: location.href, title: document.title };
        }
      });
      return results[0]?.result || { status: 'failed', reason: 'No result' };
    }

    if (action === 'inspectReply') {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const blocks = document.querySelectorAll('.user-message-block');
          if (blocks.length === 0) return { error: 'No message blocks' };
          const lastBlock = blocks[blocks.length - 1];
          const reply = lastBlock.children[1];
          if (!reply) return { error: 'No reply child' };
          // Map direct children
          const children = [];
          for (let i = 0; i < reply.children.length; i++) {
            const c = reply.children[i];
            children.push({
              index: i,
              tag: c.tagName,
              classes: (c.className || '').substring(0, 200),
              text: (c.innerText || '').substring(0, 300),
              childCount: c.children.length,
              attrs: Array.from(c.attributes || []).map(a => `${a.name}=${a.value}`).slice(0, 5)
            });
          }
          return { childCount: reply.children.length, children, outerHTML: reply.outerHTML.substring(0, 2000) };
        }
      });
      return results[0]?.result || { status: 'failed' };
    }

    // inspectToolCalls: deep inspect tool call summaries, file references, and collapsed sections
    if (action === 'inspectToolCalls') {
      const msgIdx = payload.message_index;
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: (targetIndex) => {
          const blocks = document.querySelectorAll('.user-message-block');
          if (blocks.length === 0) return { error: 'No message blocks found' };

          const inspectBlock = (block, idx) => {
            const reply = block.children[1];
            if (!reply) return { index: idx, error: 'No reply child' };

            // Find tool call summary lines — they match "Nebula exchanged N messages and executed N tools"
            // or "Nebula executed N tools"
            const toolCallPattern = /(?:exchanged\s+\d+\s+messages?\s+and\s+)?executed\s+\d+\s+tools?/i;
            const allText = reply.innerText || '';
            const hasToolCalls = toolCallPattern.test(allText);

            // Find clickable/expandable tool call summary elements
            const toolCallSummaries = [];
            // Nebula wraps tool summaries in clickable divs. Look for elements containing the pattern.
            reply.querySelectorAll('div, span, button, p').forEach(el => {
              const txt = (el.textContent || '').trim();
              if (toolCallPattern.test(txt) && txt.length < 200) {
                toolCallSummaries.push({
                  tag: el.tagName,
                  classes: (el.className || '').substring(0, 200),
                  text: txt.substring(0, 200),
                  clickable: el.tagName === 'BUTTON' || el.onclick !== null || el.getAttribute('role') === 'button' || el.style.cursor === 'pointer',
                  parentClasses: (el.parentElement?.className || '').substring(0, 200),
                  attrs: Array.from(el.attributes || []).map(a => `${a.name}=${a.value.substring(0, 100)}`).slice(0, 10),
                  childHTML: el.innerHTML.substring(0, 500)
                });
              }
            });

            // Find file reference elements — look for file paths like /filename.md
            const fileRefs = [];
            reply.querySelectorAll('a, div, span, p').forEach(el => {
              const txt = (el.textContent || '').trim();
              // Match file paths: /something.md, docs/something.md, etc.
              if (/[\w/]+\.\w{1,5}$/.test(txt) && txt.length < 300) {
                fileRefs.push({
                  tag: el.tagName,
                  classes: (el.className || '').substring(0, 200),
                  text: txt.substring(0, 300),
                  href: el.getAttribute('href') || null,
                  dataAttrs: Array.from(el.attributes || [])
                    .filter(a => a.name.startsWith('data-'))
                    .map(a => `${a.name}=${a.value.substring(0, 100)}`),
                  parentTag: el.parentElement?.tagName || null,
                  parentClasses: (el.parentElement?.className || '').substring(0, 200)
                });
              }
            });

            // Find any link elements that might point to files
            const fileLinks = [];
            reply.querySelectorAll('a[href]').forEach(a => {
              const href = a.getAttribute('href') || '';
              if (href.includes('/files') || href.includes('/file/') || href.includes('.md')) {
                fileLinks.push({
                  text: (a.textContent || '').trim().substring(0, 200),
                  href: href.substring(0, 500),
                  classes: (a.className || '').substring(0, 200)
                });
              }
            });

            // Detect expanded sections (non-collapsed content that might contain file previews)
            const expandedSections = [];
            reply.querySelectorAll('[class*="expanded"], [class*="open"], [class*="show"], [aria-expanded="true"], details[open]').forEach(el => {
              expandedSections.push({
                tag: el.tagName,
                classes: (el.className || '').substring(0, 200),
                text: (el.innerText || '').substring(0, 500),
                childCount: el.children.length
              });
            });

            // Look for code blocks or pre elements that might contain file content
            const codeBlocks = [];
            reply.querySelectorAll('pre, code, [class*="code-block"], [class*="markdown"]').forEach(el => {
              codeBlocks.push({
                tag: el.tagName,
                classes: (el.className || '').substring(0, 200),
                text: (el.textContent || '').substring(0, 500),
                length: (el.textContent || '').length
              });
            });

            return {
              index: idx,
              blockId: block.id || null,
              hasToolCalls,
              toolCallSummaries,
              fileRefs,
              fileLinks,
              expandedSections,
              codeBlocks,
              replyText: allText.substring(0, 1000),
              replyChildCount: reply.children.length,
              replyChildren: Array.from(reply.children).slice(0, 15).map((c, ci) => ({
                index: ci,
                tag: c.tagName,
                classes: (c.className || '').substring(0, 150),
                text: (c.innerText || '').substring(0, 200),
                childCount: c.children.length
              }))
            };
          };

          if (typeof targetIndex === 'number' && targetIndex >= 0 && targetIndex < blocks.length) {
            return { total: blocks.length, blocks: [inspectBlock(blocks[targetIndex], targetIndex)] };
          }

          // Inspect all blocks that have tool calls
          const results = [];
          blocks.forEach((block, i) => {
            const info = inspectBlock(block, i);
            if (info.hasToolCalls || info.fileRefs.length > 0 || info.fileLinks.length > 0) {
              results.push(info);
            }
          });

          return { total: blocks.length, url: location.href, blocks: results };
        },
        args: [msgIdx !== undefined ? msgIdx : null]
      });
      return results[0]?.result || { status: 'failed', reason: 'No result' };
    }

    // expandToolCalls: click on collapsed tool call summaries to expand them, then read
    if (action === 'expandToolCalls') {
      const msgIdx = payload.message_index;
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: (targetIndex) => {
          return new Promise((resolve) => {
            const blocks = document.querySelectorAll('.user-message-block');
            if (blocks.length === 0) { resolve({ error: 'No message blocks found' }); return; }

            const blockIdx = (typeof targetIndex === 'number' && targetIndex >= 0) ? targetIndex : blocks.length - 1;
            if (blockIdx >= blocks.length) { resolve({ error: `Block index ${blockIdx} out of range (total: ${blocks.length})` }); return; }

            const block = blocks[blockIdx];
            const reply = block.children[1];
            if (!reply) { resolve({ error: 'No reply child in block' }); return; }

            const toolCallPattern = /(?:exchanged\s+\d+\s+messages?\s+and\s+)?executed\s+\d+\s+tools?/i;

            // Find clickable elements containing tool call text
            const clickTargets = [];
            reply.querySelectorAll('div, span, button, p').forEach(el => {
              const txt = (el.textContent || '').trim();
              if (toolCallPattern.test(txt) && txt.length < 200) {
                clickTargets.push(el);
              }
            });

            if (clickTargets.length === 0) {
              // No tool call summaries — just return current content
              resolve({
                expanded: false,
                reason: 'No tool call summaries found to expand',
                content: reply.innerText.substring(0, 3000)
              });
              return;
            }

            // Click on each tool call summary element (use the smallest / most specific one)
            const clicked = [];
            clickTargets.forEach(el => {
              // Find the most specific (innermost) clickable parent/self
              let target = el;
              // If the text-bearing element is inside a clickable container, click the container
              let parent = el;
              while (parent && parent !== reply) {
                if (parent.getAttribute('role') === 'button' || parent.tagName === 'BUTTON' ||
                    parent.classList.contains('cursor-pointer') || parent.style.cursor === 'pointer') {
                  target = parent;
                  break;
                }
                // Check computed style for cursor pointer
                const computed = window.getComputedStyle(parent);
                if (computed.cursor === 'pointer') {
                  target = parent;
                  break;
                }
                parent = parent.parentElement;
              }
              try {
                target.click();
                clicked.push({
                  tag: target.tagName,
                  classes: (target.className || '').substring(0, 200),
                  text: (target.textContent || '').trim().substring(0, 200)
                });
              } catch (e) {
                clicked.push({ error: e.message });
              }
            });

            // Wait for DOM to update after click, then capture expanded content
            setTimeout(() => {
              // Re-read the reply content after expansion
              const expandedContent = reply.innerText || '';

              // Check for newly visible file content, code blocks, or details
              const newCodeBlocks = [];
              reply.querySelectorAll('pre, code, [class*="code-block"], [class*="markdown-body"]').forEach(el => {
                newCodeBlocks.push({
                  tag: el.tagName,
                  classes: (el.className || '').substring(0, 200),
                  text: (el.textContent || '').substring(0, 2000),
                  fullLength: (el.textContent || '').length
                });
              });

              // Check for file preview areas
              const filePreviews = [];
              reply.querySelectorAll('[class*="file"], [class*="preview"], [class*="editor"], [class*="document"]').forEach(el => {
                filePreviews.push({
                  tag: el.tagName,
                  classes: (el.className || '').substring(0, 200),
                  text: (el.textContent || '').substring(0, 2000),
                  fullLength: (el.textContent || '').length
                });
              });

              // Also look for newly appeared expanded areas
              const expandedAreas = [];
              reply.querySelectorAll('[aria-expanded="true"], details[open], [class*="expanded"]').forEach(el => {
                expandedAreas.push({
                  tag: el.tagName,
                  classes: (el.className || '').substring(0, 200),
                  text: (el.textContent || '').substring(0, 2000),
                  fullLength: (el.textContent || '').length
                });
              });

              // Capture full inner HTML structure for deep analysis
              const replyHTML = reply.innerHTML.substring(0, 5000);

              resolve({
                expanded: true,
                blockIndex: blockIdx,
                clicked,
                content: expandedContent.substring(0, 5000),
                contentLength: expandedContent.length,
                codeBlocks: newCodeBlocks,
                filePreviews,
                expandedAreas,
                replyHTML
              });
            }, 2000); // 2s wait for expansion animation
          });
        },
        args: [msgIdx !== undefined ? msgIdx : null]
      });
      return results[0]?.result || { status: 'failed', reason: 'No result' };
    }

    // customQuery: run an arbitrary CSS selector and return matching elements
    if (action === 'customQuery') {
      const selector = payload.selector;
      if (!selector) {
        return { error: 'No selector provided. Pass "selector" in the request body.' };
      }
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: (sel) => {
          try {
            const els = document.querySelectorAll(sel);
            if (els.length === 0) return { selector: sel, count: 0, elements: [] };
            const items = [];
            els.forEach((el, i) => {
              if (i >= 20) return; // cap at 20 results
              items.push({
                index: i,
                tag: el.tagName,
                id: el.id || null,
                classes: (el.className || '').substring(0, 300),
                text: (el.innerText || '').substring(0, 1000),
                textLength: (el.innerText || '').length,
                html: el.outerHTML.substring(0, 2000),
                htmlLength: el.outerHTML.length,
                attrs: Array.from(el.attributes || []).map(a => `${a.name}=${a.value.substring(0, 200)}`).slice(0, 15),
                childCount: el.children.length,
                rect: (() => { const r = el.getBoundingClientRect(); return { top: r.top, left: r.left, width: r.width, height: r.height }; })()
              });
            });
            return { selector: sel, count: els.length, elements: items, url: location.href };
          } catch (e) {
            return { selector: sel, error: e.message };
          }
        },
        args: [selector]
      });
      return results[0]?.result || { status: 'failed', reason: 'No result' };
    }

    // NEBULA_LIST_FILES: extract auth token + thread_id from page, then call Nebula API
    if (action === 'NEBULA_LIST_FILES') {
      // Step 1: Extract auth token and thread_id from the Nebula tab
      const extractResults = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          // Extract thread_id from URL: /chat/channel/{thread_id}
          const urlMatch = location.pathname.match(/\/chat\/channel\/([^/?#]+)/);
          const threadId = urlMatch ? urlMatch[1] : null;

          // Extract auth token from localStorage — scan for JWT (starts with eyJ)
          let authToken = null;
          for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            const value = localStorage.getItem(key);
            if (value && typeof value === 'string' && value.startsWith('eyJ')) {
              authToken = value;
              break;
            }
          }

          return { threadId, authToken };
        }
      });

      const extracted = extractResults[0]?.result;
      if (!extracted) {
        return { status: 'failed', reason: 'Script execution returned no result' };
      }
      if (!extracted.authToken) {
        return { status: 'failed', reason: 'No auth token found in localStorage' };
      }
      if (!extracted.threadId) {
        return { status: 'failed', reason: 'Could not extract thread_id from URL (expected /chat/channel/{thread_id})' };
      }

      // Step 2: Call Nebula API from the background service worker
      try {
        const apiUrl = `https://api.nebula.gg/files?thread_id=${encodeURIComponent(extracted.threadId)}&sort_by=created_at&sort_order=desc`;
        const resp = await fetch(apiUrl, {
          method: 'GET',
          headers: {
            'x-secret-key': extracted.authToken,
            'Accept': 'application/json'
          }
        });

        if (!resp.ok) {
          const errText = await resp.text().catch(() => '');
          return { status: 'failed', reason: `Nebula API returned ${resp.status}: ${errText.substring(0, 500)}` };
        }

        const data = await resp.json();
        // Return trimmed file list with essential fields
        const files = (Array.isArray(data) ? data : data.files || data.data || []).map(f => ({
          id: f.id,
          filename: f.filename,
          file_extension: f.file_extension,
          size_bytes: f.size_bytes,
          folder_path: f.folder_path,
          source: f.source,
          created_at: f.created_at
        }));

        return { status: 'success', thread_id: extracted.threadId, files, total: files.length };
      } catch (fetchErr) {
        return { status: 'failed', reason: `Nebula API fetch error: ${fetchErr.message}` };
      }
    }

    // NEBULA_GET_FILE: extract auth token from page, then fetch file content from Nebula API
    if (action === 'NEBULA_GET_FILE') {
      const fileId = payload.file_id;
      if (!fileId) {
        return { status: 'failed', reason: 'No file_id provided in payload' };
      }

      // Step 1: Extract auth token from the Nebula tab
      const extractResults = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          let authToken = null;
          for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            const value = localStorage.getItem(key);
            if (value && typeof value === 'string' && value.startsWith('eyJ')) {
              authToken = value;
              break;
            }
          }
          return { authToken };
        }
      });

      const extracted = extractResults[0]?.result;
      if (!extracted) {
        return { status: 'failed', reason: 'Script execution returned no result' };
      }
      if (!extracted.authToken) {
        return { status: 'failed', reason: 'No auth token found in localStorage' };
      }

      // Step 2: Call Nebula API from the background service worker
      try {
        const apiUrl = `https://api.nebula.gg/files/${encodeURIComponent(fileId)}/content`;
        const resp = await fetch(apiUrl, {
          method: 'GET',
          headers: {
            'x-secret-key': extracted.authToken,
            'Accept': 'application/json'
          }
        });

        if (!resp.ok) {
          const errText = await resp.text().catch(() => '');
          return { status: 'failed', reason: `Nebula API returned ${resp.status}: ${errText.substring(0, 500)}` };
        }

        // Try JSON first, fall back to text
        const contentType = resp.headers.get('content-type') || '';
        let content;
        if (contentType.includes('application/json')) {
          content = await resp.json();
        } else {
          content = await resp.text();
        }

        return { status: 'success', file_id: fileId, content };
      } catch (fetchErr) {
        return { status: 'failed', reason: `Nebula API fetch error: ${fetchErr.message}` };
      }
    }

    throw new Error(`Unsupported direct action: ${action}`);
  }

  async syncPages() {
    if (!this.authenticated) return;
    try {
      const pages = await collectActivePages();
      this.send({
        type: 'pages_sync',
        payload: { pages }
      });
    } catch (e) {
      console.error('[GAPI-WS] Pages sync error:', e);
    }
  }

  // 斷開連接
  disconnect() {
    // Clear badge
    chrome.action.setBadgeText({ text: '' });
    // Clear all timers and alarms
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    chrome.alarms.clear(ALARM_HEARTBEAT);
    chrome.alarms.clear(ALARM_RECONNECT);

    if (this.ws) {
      this.ws.onclose = null; // prevent auto-reconnect
      this.ws.close();
      this.ws = null;
    }
    this.authenticated = false;
    this.sessionId = null;
  }

  // 註冊訊息處理器
  on(event, handler) {
    this.messageHandlers.set(event, handler);
  }

  // 通知 Admin Web
  notifyAdmin(data) {
    broadcastAdminEvent('gapi_status', data);
  }

  // 取得連接狀態
  getStatus() {
    return {
      connected: this.authenticated,
      sessionId: this.sessionId,
      extensionId: this.extensionId
    };
  }
}

// 全域 GAPI WebSocket 客戶端實例
const gapiClient = new GAPIWebSocketClient();

// ========== chrome.alarms handler (MV3 persistent scheduling) ==========
chrome.alarms.onAlarm.addListener((alarm) => {
  console.log(`[GAPI-Alarm] Fired: ${alarm.name}`);

  if (alarm.name === ALARM_TOKEN_REFRESH) {
    tokenManager.refreshToken().catch(err => {
      console.error('[GAPI-Alarm] Token refresh failed:', err);
    });
    return;
  }

  if (alarm.name === ALARM_HEARTBEAT) {
    if (gapiClient.authenticated) {
      gapiClient.send({ type: 'ping' });
    }
    return;
  }

  if (alarm.name === ALARM_RECONNECT) {
    if (!gapiClient.authenticated) {
      console.log('[GAPI-Alarm] Reconnect alarm triggered');
      if (gapiClient.extensionId) {
        gapiClient.connect(gapiClient.extensionId, { forceNewToken: true }).catch(err => {
          console.error('[GAPI-Alarm] Reconnect failed:', err);
        });
      } else {
        // extensionId not loaded yet — run full bootstrap
        bootstrapGAPI().catch(err => {
          console.error('[GAPI-Alarm] Bootstrap failed:', err);
        });
      }
    }
    return;
  }
});

// ========== GAPI HTTP Client (P1.3) ==========
// HTTP client for REST API calls (POST /v1/messages, etc.)

class GAPIHttpClient {
  constructor() {
    this.baseUrl = GAPI_HTTP_URL;
    this.extensionId = null;
    this.authToken = null;
  }

  // 初始化 HTTP 客戶端 (透過 TokenManager 從 server 取得 token)
  async init(extensionId) {
    this.extensionId = extensionId;
    this.authToken = await tokenManager.getToken(extensionId);
  }

  // 發送 HTTP 請求（內部方法）
  async _request(method, endpoint, data = null, timeout = 30000) {
    const url = `${this.baseUrl}${endpoint}`;
    
    const options = {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.authToken}`
      }
    };

    if (data && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
      options.body = JSON.stringify(data);
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    options.signal = controller.signal;

    try {
      const response = await fetch(url, options);
      clearTimeout(timeoutId);
      
      // 解析回應
      const contentType = response.headers.get('content-type');
      let result;
      if (contentType && contentType.includes('application/json')) {
        result = await response.json();
      } else {
        result = await response.text();
      }

      // 檢查 HTTP 狀態
      if (!response.ok) {
        throw new Error(result.message || result.error || `HTTP ${response.status}`);
      }

      return result;
    } catch (error) {
      clearTimeout(timeoutId);
      
      // 區分錯誤類型
      if (error.name === 'AbortError') {
        throw new Error('請求超時 (timeout)');
      }
      if (error.message.includes('Failed to fetch') || error.message.includes('NetworkError')) {
        throw new Error('網路錯誤：無法連接到伺服器');
      }
      throw error;
    }
  }

  // POST /v1/messages - 發送訊息
  async sendMessage(conversationId, content, attachments = []) {
    const payload = {
      conversation_id: conversationId,
      content,
      attachments
    };

    try {
      const result = await this._request('POST', '/v1/messages', payload, 30000);
      
      return {
        success: true,
        message_id: result.message_id,
        status: result.status,
        data: result
      };
    } catch (error) {
      console.error('[GAPI-HTTP] Send message failed:', error.message);
      
      return {
        success: false,
        error: error.message,
        conversation_id: conversationId,
        content
      };
    }
  }

  // GET /v1/conversations - 取得對話列表
  async getConversations() {
    return await this._request('GET', '/v1/conversations');
  }

  // GET /v1/conversations/{id} - 取得特定對話
  async getConversation(conversationId) {
    return await this._request('GET', `/v1/conversations/${conversationId}`);
  }

  // POST /v1/conversations - 建立新對話
  async createConversation(title = null) {
    const payload = title ? { title } : {};
    return await this._request('POST', '/v1/conversations', payload);
  }

  // 儲存發送結果到本地存儲（用於追蹤）
  async saveMessageResult(result) {
    try {
      // 使用全局的 GeminiLocalDB (通過 importScripts 加載)
      if (self.GeminiLocalDB && self.GeminiLocalDB.saveMessageResult) {
        const record = {
          id: `msg_result_${Date.now()}`,
          message_id: result.message_id || null,
          conversation_id: result.conversation_id || null,
          content: result.content || null,
          status: result.success ? 'sent' : 'failed',
          error: result.error || null,
          timestamp: Date.now()
        };
        
        await self.GeminiLocalDB.saveMessageResult(record);
        return record;
      } else {
        // Fallback: 使用 chrome.storage.local
        const record = {
          id: `msg_result_${Date.now()}`,
          message_id: result.message_id || null,
          conversation_id: result.conversation_id || null,
          content: result.content || null,
          status: result.success ? 'sent' : 'failed',
          error: result.error || null,
          timestamp: Date.now()
        };
        
        const key = `msg_result_${record.id}`;
        const existing = await new Promise(resolve => {
          chrome.storage.local.get([key], r => resolve(r[key] || []));
        });
        
        const results = Array.isArray(existing) ? existing : [];
        results.push(record);
        
        await new Promise(resolve => {
          chrome.storage.local.set({ [key]: results }, resolve);
        });
        
        return record;
      }
    } catch (error) {
      console.error('[GAPI-HTTP] Save result failed:', error);
      return null;
    }
  }

	// ========== P3.1: 圖片上傳方法 ==========

	// POST /v1/images/upload - 上傳圖片（base64 格式）
	async uploadImage(imageDataUrl, conversationId = null, filename = null) {
		try {
			const formData = new FormData();
			formData.append('image_data', imageDataUrl);
			if (conversationId) {
				formData.append('conversation_id', conversationId);
			}
			if (filename) {
				formData.append('filename', filename);
			}
			
			const url = `${this.baseUrl}/v1/images/upload`;
			const response = await fetch(url, {
				method: 'POST',
				headers: {
					'Authorization': `Bearer ${this.authToken}`
				},
				body: formData
			});
			
			if (!response.ok) {
				const error = await response.text();
				throw new Error(error || `HTTP ${response.status}`);
			}
			
			const result = await response.json();
			return {
				success: true,
				image_id: result.image_id,
				url: result.url,
				filename: result.filename,
				mime_type: result.mime_type,
				size: result.size,
				created_at: result.created_at
			};
		} catch (error) {
			console.error('[GAPI-HTTP] Upload image failed:', error.message);
			return { success: false, error: error.message };
		}
	}
	
	// POST /v1/images/upload-file - 上傳圖片（File 物件）
	async uploadImageFile(file, conversationId = null) {
		try {
			const formData = new FormData();
			formData.append('file', file);
			if (conversationId) {
				formData.append('conversation_id', conversationId);
			}
			
			const url = `${this.baseUrl}/v1/images/upload-file`;
			const response = await fetch(url, {
				method: 'POST',
				headers: {
					'Authorization': `Bearer ${this.authToken}`
				},
				body: formData
			});
			
			if (!response.ok) {
				const error = await response.text();
				throw new Error(error || `HTTP ${response.status}`);
			}
			
			const result = await response.json();
			return {
				success: true,
				image_id: result.image_id,
				url: result.url,
				filename: result.filename,
				mime_type: result.mime_type,
				size: result.size,
				created_at: result.created_at
			};
		} catch (error) {
			console.error('[GAPI-HTTP] Upload image file failed:', error.message);
			return { success: false, error: error.message };
		}
	}
	
	// GET /v1/images - 列出圖片
	async listImages(conversationId = null) {
		try {
			let endpoint = '/v1/images';
			if (conversationId) {
				endpoint += `?conversation_id=${encodeURIComponent(conversationId)}`;
			}
			return await this._request('GET', endpoint);
		} catch (error) {
			console.error('[GAPI-HTTP] List images failed:', error.message);
			return { images: [], count: 0, error: error.message };
		}
	}
	
	// GET /v1/images/{image_id} - 取得圖片 URL
	getImageUrl(imageId) {
		return `${this.baseUrl}/v1/images/${imageId}`;
	}
	
	// DELETE /v1/images/{image_id} - 刪除圖片
	async deleteImage(imageId) {
		try {
			const result = await this._request('DELETE', `/v1/images/${imageId}`);
			return { success: true, ...result };
		} catch (error) {
			console.error('[GAPI-HTTP] Delete image failed:', error.message);
			return { success: false, error: error.message };
		}
	}
}

// 全域 GAPI HTTP 客戶端實例
const gapiHttpClient = new GAPIHttpClient();

// 初始化 GAPI HTTP 連接
async function initGAPIHttpConnection() {
  await loadServerConfig();
  gapiHttpClient.baseUrl = GAPI_HTTP_URL;
  try {
    const result = await chrome.storage.local.get(['gapiExtensionId']);
    let extensionId = result.gapiExtensionId;
    
    if (!extensionId) {
      extensionId = `ext_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      await chrome.storage.local.set({ gapiExtensionId: extensionId });
    }

    await gapiHttpClient.init(extensionId);
    console.log('[Background] GAPI HTTP client initialized');
    
  } catch (error) {
    console.error('[Background] GAPI HTTP client init failed:', error);
  }
}

// 初始化 GAPI 連接
async function initGAPIConnection() {
  await loadServerConfig();
  // 從 storage 取得 extension ID 或生成
  try {
    const result = await chrome.storage.local.get(['gapiExtensionId']);
    let extensionId = result.gapiExtensionId;
    
    if (!extensionId) {
      extensionId = `ext_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      await chrome.storage.local.set({ gapiExtensionId: extensionId });
    }

    await gapiClient.connect(extensionId);
    console.log('[Background] GAPI connection initialized');
    
  } catch (error) {
    console.error('[Background] GAPI connection failed:', error);
  }
}

// 調用 initGAPIConnection 進行連接
initGAPIConnection();

// ========== Auto download toggle ==========
// Default: disabled (per user request)
const DEFAULT_AUTO_DOWNLOAD_ENABLED = false;
let autoDownloadEnabledCache = DEFAULT_AUTO_DOWNLOAD_ENABLED;

async function loadAutoDownloadEnabled() {
  try {
    const result = await chrome.storage.local.get(['autoDownloadEnabled']);
    if (typeof result.autoDownloadEnabled === 'undefined') {
      await chrome.storage.local.set({ autoDownloadEnabled: DEFAULT_AUTO_DOWNLOAD_ENABLED });
      autoDownloadEnabledCache = DEFAULT_AUTO_DOWNLOAD_ENABLED;
    } else {
      autoDownloadEnabledCache = result.autoDownloadEnabled === true;
    }
  } catch {
    autoDownloadEnabledCache = DEFAULT_AUTO_DOWNLOAD_ENABLED;
  }
}

loadAutoDownloadEnabled();

function isAllowedAdminOrigin(senderUrl) {
  const u = senderUrl || '';
  return u.startsWith('http://localhost') || u.startsWith('http://127.0.0.1');
}

function broadcastAdminEvent(type, data) {
  const payload = { type, data: data || {}, ts: Date.now() };
  for (const port of Array.from(adminPorts)) {
    try {
      port.postMessage(payload);
    } catch (e) {
      // remove broken ports
      try {
        adminPorts.delete(port);
      } catch (deleteError) {
        // 忽略刪除失敗（端口可能已經無效）
        console.debug('[Background] 刪除無效端口時發生錯誤（可忽略）:', deleteError?.message || deleteError);
      }
    }
  }
}

chrome.runtime.onConnectExternal.addListener((port) => {
  try {
    const senderUrl = port?.sender?.url || '';
    if (!isAllowedAdminOrigin(senderUrl)) {
      try {
        port.disconnect();
      } catch (disconnectError) {
        // 忽略斷開連接失敗（端口可能已經無效）
        console.debug('[Background] 斷開未授權連接時發生錯誤（可忽略）:', disconnectError?.message || disconnectError);
      }
      return;
    }

    // Only accept our admin channel
    if (port.name !== 'gemini-admin') {
      try {
        port.disconnect();
      } catch (disconnectError) {
        // 忽略斷開連接失敗（端口可能已經無效）
        console.debug('[Background] 斷開非管理通道連接時發生錯誤（可忽略）:', disconnectError?.message || disconnectError);
      }
      return;
    }

    // Enforce max size of 20 ports to prevent resource exhaustion
    if (adminPorts.size >= 20) {
      const oldest = adminPorts.values().next().value;
      try {
        oldest.disconnect();
      } catch (e) {
        console.debug('[Background] Failed to disconnect oldest admin port:', e?.message || e);
      }
      adminPorts.delete(oldest);
    }

    adminPorts.add(port);

    port.onDisconnect.addListener(() => {
      adminPorts.delete(port);
    });

    port.onMessage.addListener((msg) => {
      // Currently no commands over port; reserved for future.
      if (msg && msg.type === 'ping') {
        try {
          port.postMessage({ type: 'pong', ts: Date.now() });
        } catch (postError) {
          // 忽略發送消息失敗（端口可能已經關閉）
          console.debug('[Background] 發送 pong 消息時發生錯誤（可忽略）:', postError?.message || postError);
        }
      }
    });

    // Initial hello so UI can confirm push is active
    try {
      port.postMessage({ type: 'hello', ts: Date.now() });
    } catch (helloError) {
      // 忽略發送 hello 消息失敗（端口可能已經關閉）
      console.debug('[Background] 發送 hello 消息時發生錯誤（可忽略）:', helloError?.message || helloError);
    }
  } catch (error) {
    // 忽略連接處理錯誤（可能是端口已關閉等）
    console.debug('[Background] 處理外部連接時發生錯誤（可忽略）:', error?.message || error);
  }
});

// Upload sessions for Admin Web image uploads (memory only)
// uploadId -> { userProfile, chatId, filename, mime, prefix, chunks: string[], createdAt }
const adminUploadSessions = new Map();

// 【優化修復】解決 Storage 報錯：檢測到 QuotaExceededError 時，優先清理大數據，避免清空所有存儲
(async () => {
  try {
    // 嘗試讀取存儲，檢測是否有 QuotaExceededError
    try {
      await chrome.storage.local.get(null);
    } catch (error) {
      // 如果檢測到 QuotaExceededError，優先清理大數據
      if (error && error.message && (error.message.includes('quota') || error.message.includes('QuotaExceeded'))) {
        console.error('[Background] ⚠️ 檢測到 QuotaExceededError，開始清理大數據...');
        
        // 優先清理策略：先清理非關鍵的大數據
        const largeDataKeys = [
          'operation_logs_default',
          'all_images_record_default',
          'operationLogs',
          'imageDatabase',
          'imagePaths',
          'generated_images_default'
        ];
        
        let cleaned = false;
        for (const key of largeDataKeys) {
          try {
            await chrome.storage.local.remove(key);
            cleaned = true;
            console.log(`[Background] ✓ 已清理: ${key}`);
          } catch (removeError) {
            // 忽略單個鍵的清理失敗
          }
        }
        
        // 如果清理後仍然有問題，嘗試清理所有用戶的操作日誌和圖片記錄
        if (!cleaned) {
          try {
            const allKeys = await chrome.storage.local.get(null);
            const keysToRemove = Object.keys(allKeys).filter(k => 
              k.startsWith('operation_logs_') || 
              k.startsWith('all_images_record_') ||
              k.startsWith('generated_images_')
            );
            if (keysToRemove.length > 0) {
              await chrome.storage.local.remove(keysToRemove);
              console.log(`[Background] ✓ 已清理 ${keysToRemove.length} 個大數據鍵`);
              cleaned = true;
            }
          } catch (bulkRemoveError) {
            console.error('[Background] 批量清理失敗:', bulkRemoveError);
          }
        }
        
        // 只有在所有清理嘗試都失敗時，才考慮清空所有存儲（最後手段）
        if (!cleaned) {
          try {
            // 再次嘗試讀取，確認是否仍然有問題
            await chrome.storage.local.get(null);
            console.log('[Background] ✓ 清理後存儲已恢復正常');
          } catch (retryError) {
            console.error('[Background] ⚠️ 清理後仍然有 Quota 錯誤，執行最後手段：清空所有存儲...');
            try {
              await chrome.storage.local.clear();
              console.log('[Background] ✓ 已清空所有存儲（最後手段）');
            } catch (clearError) {
              console.error('[Background] ❌ 清空存儲時發生錯誤:', clearError);
            }
          }
        }
        return;
      }
      throw error; // 其他錯誤繼續拋出
    }
    
    // 如果沒有 Quota 錯誤，執行常規清理
    const keysToClear = ['operationLogs', 'imageDatabase', 'imagePaths'];
    const result = await chrome.storage.local.get(keysToClear);
    const hasData = keysToClear.some(key => result[key] !== undefined);
    
    if (hasData) {
      console.log('[Background] 🧹 清空操作日誌和圖片數據快取（避免存儲空間不足）');
      await chrome.storage.local.remove(keysToClear);
      console.log('[Background] ✓ 快取已清空');
    }
  } catch (error) {
    console.error('[Background] 清空快取時發生錯誤:', error);
    // 如果是 Quota 錯誤，嘗試優先清理大數據
    if (error && error.message && (error.message.includes('quota') || error.message.includes('QuotaExceeded'))) {
      try {
        // 優先清理大數據
        const largeDataKeys = ['operation_logs_default', 'all_images_record_default'];
        for (const key of largeDataKeys) {
          try {
            await chrome.storage.local.remove(key);
            console.log(`[Background] ✓ 已清理: ${key}`);
          } catch (removeError) {
            // 忽略單個鍵的清理失敗
          }
        }
        // 再次嘗試讀取確認
        await chrome.storage.local.get(null);
        console.log('[Background] ✓ 清理後存儲已恢復正常');
      } catch (finalError) {
        // 最後手段：清空所有存儲
        try {
          await chrome.storage.local.clear();
          console.log('[Background] ✓ 已清空所有存儲（最後手段）');
        } catch (clearError) {
          console.error('[Background] ❌ 清空存儲時發生錯誤:', clearError);
        }
      }
    }
  }
})();

// 注意：已移除 downloadImageCache，改用持久化的 download_history

// 工具：清理檔名非法字元 (Windows/Mac 限制)
function sanitizeFilename(name) {
  if (!name) return '未命名對話';
  return name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') // 將所有非法字符（包括斜線 / 和冒號 :）替換為底線
    .replace(/\s+/g, '_') // 空格替換為下劃線
    .replace(/_+/g, '_') // 將多個連續底線合併為單個底線
    .replace(/^_|_$/g, '') // 移除開頭和結尾的底線
    .trim()
    .substring(0, 50); // 限制長度
}

// 下載路徑設定（注意：Chrome extension 只能指定「Downloads 底下的相對路徑」，不能指定任意磁碟絕對路徑）
const DEFAULT_DOWNLOAD_BASE_FOLDER = 'Gemini_Assistant';
let downloadBaseFolderCache = DEFAULT_DOWNLOAD_BASE_FOLDER;

function sanitizePathPart(part, maxLen = 120) {
  const s = String(part || '')
    .replace(/[<>:"\\|?*\x00-\x1f]/g, '_') // 注意：不替換 '/'，讓我們可用子資料夾
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .trim();
  return s.substring(0, maxLen) || 'unknown';
}

function sanitizeRelativePath(p) {
  const raw = String(p || '').trim();
  if (!raw) return DEFAULT_DOWNLOAD_BASE_FOLDER;
  // allow nested folders separated by / or \
  const parts = raw.split(/[\\/]+/).filter(Boolean);
  const cleaned = [];
  for (const part of parts) {
    if (part === '.' || part === '..') continue;
    const seg = sanitizePathPart(part, 60);
    if (seg) cleaned.push(seg);
  }
  return cleaned.length ? cleaned.join('/') : DEFAULT_DOWNLOAD_BASE_FOLDER;
}

async function loadDownloadBaseFolder() {
  try {
    const result = await chrome.storage.local.get(['downloadBaseFolder']);
    downloadBaseFolderCache = sanitizeRelativePath(result.downloadBaseFolder) || DEFAULT_DOWNLOAD_BASE_FOLDER;
  } catch {
    downloadBaseFolderCache = DEFAULT_DOWNLOAD_BASE_FOLDER;
  }
}

function getDownloadBaseFolder() {
  return downloadBaseFolderCache || DEFAULT_DOWNLOAD_BASE_FOLDER;
}

function buildDownloadPath(...parts) {
  const base = getDownloadBaseFolder();
  const cleaned = [sanitizeRelativePath(base)];
  for (const p of parts) {
    if (!p) continue;
    cleaned.push(sanitizePathPart(p, 140));
  }
  return cleaned.join('/');
}

// init cache early
loadDownloadBaseFolder();

chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'local' && changes.downloadBaseFolder) {
    downloadBaseFolderCache = sanitizeRelativePath(changes.downloadBaseFolder.newValue) || DEFAULT_DOWNLOAD_BASE_FOLDER;
  }
  if (namespace === 'local' && changes.autoDownloadEnabled) {
    autoDownloadEnabledCache = changes.autoDownloadEnabled.newValue === true;
  }
});

// 重新導向「頁面觸發」的 Gemini 圖片下載到子資料夾（避免 Downloads 根目錄雜亂）
chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  try {
    // 不干預 extension 自己指定 filename 的下載
    if (item.byExtensionId && item.byExtensionId === chrome.runtime.id) return;
    const url = item.url || '';
    const ref = item.referrer || '';
    if (!url.includes('googleusercontent.com')) return;
    if (!ref.includes('gemini.google.com')) return;

    const originalName = (item.filename || '').split(/[\\/]/).pop() || `gemini_${Date.now()}.png`;
    const safeName = sanitizePathPart(originalName, 160);
    const target = buildDownloadPath('page-downloads', safeName);
    suggest({ filename: target, conflictAction: 'uniquify' });
  } catch {
    // ignore
  }
});

// 遠端 API 會話管理
const remoteSessions = new Map(); // sessionId -> { messages: [], images: [], createdAt }

// ========== 啟動連線（統一入口） ==========
async function bootstrapGAPI() {
  try {
    await initGAPIHttpConnection();
    await initGAPIConnection();
    console.log('[GAPI] Bootstrap complete');
  } catch (err) {
    console.error('[GAPI] Bootstrap failed, scheduling retry:', err);
    // 確保 alarm 存在以喚醒 service worker 重試
    chrome.alarms.create(ALARM_RECONNECT, { delayInMinutes: 0.5 });
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  console.log('Gemini 對話分類助手已安裝');

  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
    .catch((error) => console.error(error));

  await chrome.sidePanel.setOptions({
    path: 'sidepanel.html',
    enabled: true
  });

  // 初始化專案存儲
  chrome.storage.local.get(['interceptedImages', 'projects'], (result) => {
    if (!result.interceptedImages) {
      chrome.storage.local.set({ interceptedImages: [] });
    }
    if (!result.projects) {
      chrome.storage.local.set({
        projects: {
          eell: { name: 'EELL', images: [] },
          generalProject: { name: '漫畫', images: [] }
        }
      });
    }
  });

  await bootstrapGAPI();
});

// Service worker 被喚醒時（Chrome 啟動、alarm 觸發等）也嘗試連線
chrome.runtime.onStartup.addListener(async () => {
  console.log('[GAPI] onStartup — bootstrapping');
  await bootstrapGAPI();
});

// ========== 遠端更新：重新注入 Content Scripts ==========
// 用 chrome.scripting.executeScript 把最新檔案注入到 AI 分頁（不刷新頁面、不重啟 Extension）
async function reinjectContentScripts() {
  const AI_URL_PATTERNS = [
    'https://gemini.google.com/*',
    'https://claude.ai/*'
  ];
  const SCRIPTS = [
    'content-site-registry.js',
    'content-site-gemini.js',
    'content-site-claude.js',
    'content.js'
  ];
  let injected = 0;
  for (const pattern of AI_URL_PATTERNS) {
    try {
      const tabs = await chrome.tabs.query({ url: pattern });
      for (const tab of tabs) {
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: SCRIPTS
          });
          injected++;
          console.log(`[GAPI] Scripts injected into tab ${tab.id} (${tab.url})`);
        } catch (err) {
          console.warn(`[GAPI] Inject failed for tab ${tab.id}:`, err.message);
        }
      }
    } catch (err) {
      console.warn(`[GAPI] Tab query failed for ${pattern}:`, err.message);
    }
  }
  console.log(`[GAPI] Injection complete: ${injected} tab(s)`);
  return injected;
}

// 檢查並管理 Side Panel（根據標籤頁是否為 Gemini 頁面）
async function manageSidePanelForTab(tabId, tab) {
  try {
    if (tab && tab.url && tab.url.includes('gemini.google.com')) {
      // 在 Gemini 網頁上啟用 Side Panel
      await chrome.sidePanel.setOptions({
        tabId: tabId,
        path: 'sidepanel.html',
        enabled: true
      });
      console.log('[Background] ✓ 在 Gemini 頁面上啟用 Side Panel (tabId:', tabId, ')');
      
      // 自動打開 Side Panel
      try {
        await chrome.sidePanel.open({ tabId: tabId });
        console.log('[Background] ✓ 已自動打開 Side Panel (tabId:', tabId, ')');
      } catch (error) {
        // 如果無法自動打開（需要用戶手勢），忽略錯誤
        console.log('[Background] 無法自動打開 Side Panel（需要用戶手勢）:', error.message);
      }
    } else {
      // 在非 Gemini 網頁上禁用 Side Panel
      try {
        await chrome.sidePanel.setOptions({
          tabId: tabId,
          enabled: false
        });
        console.log('[Background] ✗ 在非 Gemini 頁面上禁用 Side Panel (tabId:', tabId, ')');
      } catch (error) {
        // 如果設置失敗（可能 Side Panel 未打開），忽略錯誤
        console.log('[Background] 禁用 Side Panel 時發生錯誤（可忽略）:', error.message);
      }
    }
  } catch (error) {
    console.error('[Background] 管理 Side Panel 時發生錯誤:', error);
  }
}

// ========== Active Pages Sync (P4) ==========
let _syncPagesTimer = null;
function debouncedSyncPages() {
  if (_syncPagesTimer) clearTimeout(_syncPagesTimer);
  _syncPagesTimer = setTimeout(() => {
    if (gapiClient && gapiClient.authenticated) {
      gapiClient.syncPages();
    }
  }, 2000);
}

// 當標籤頁更新時，檢查是否為 Gemini 網頁
chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  // 只有在 URL 改變時才檢查（避免過度觸發）
  if (info.url || info.status === 'complete') {
    await manageSidePanelForTab(tabId, tab);
    debouncedSyncPages();
  }
});

// 當標籤頁關閉時，同步活躍頁面
chrome.tabs.onRemoved.addListener(() => {
  debouncedSyncPages();
});

// 當標籤頁切換時，檢查當前活動標籤頁是否為 Gemini 網頁
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    await manageSidePanelForTab(activeInfo.tabId, tab);
    
    // 同時檢查所有窗口的當前標籤頁
    const windows = await chrome.windows.getAll({ populate: true });
    for (const window of windows) {
      if (window.id === activeInfo.windowId) continue; // 已處理
      
      // 找到該窗口的當前活動標籤頁
      const activeTab = window.tabs?.find(t => t.active);
      if (activeTab) {
        await manageSidePanelForTab(activeTab.id, activeTab);
      }
    }
  } catch (error) {
    console.error('[Background] 處理標籤頁切換時發生錯誤:', error);
  }
});

// 內存緩存：用於 webRequest 攔截器的去重（防止重複下載）
const webRequestProcessingUrls = new Set();

// 內存鎖：用於 DOWNLOAD_IMAGE 消息處理的去重（防止競態條件）
const downloadImageProcessingLocks = new Map(); // urlKey -> { timestamp, timeoutId }

// 監控 Background 的下載事件：捕捉下載的實體網址
chrome.downloads.onCreated.addListener((downloadItem) => {
  // 將這個捕捉到的 URL 發回給 Content Script 或 Side Panel
  // 嘗試發送給所有支援站點的標籤頁
  findAllSupportedTabs().then(tabs => {
    tabs.forEach(tab => {
      chrome.tabs.sendMessage(tab.id, {
        action: 'CAPTURE_REAL_DOWNLOAD_URL',
        url: downloadItem.url,
        filename: downloadItem.filename,
        referrer: downloadItem.referrer,
        downloadId: downloadItem.id,
        startTime: downloadItem.startTime
      }).catch(() => {
        // 靜默處理錯誤，不輸出到控制台
      });
    });
  });
  
  // 同時嘗試發送給 Side Panel（如果打開的話）
  chrome.runtime.sendMessage({
    action: 'CAPTURE_REAL_DOWNLOAD_URL',
    url: downloadItem.url,
    filename: downloadItem.filename,
    referrer: downloadItem.referrer,
    downloadId: downloadItem.id,
    startTime: downloadItem.startTime
  }).catch(() => {
    // 靜默處理錯誤，不輸出到控制台
  });
});

// 【簡化自動化流程】網路層攔截：攔截所有圖片請求（包含小圖和大圖）
chrome.webRequest.onHeadersReceived.addListener(
  async (details) => {
    // 關鍵過濾：網址包含 googleusercontent
    if (!details.url.includes('googleusercontent.com')) {
      return;
    }

    // 取消自動下載：僅保留去重記錄/其他功能
    if (!autoDownloadEnabledCache) {
      return;
    }
    
    // 判斷圖片類型：=s0 表示原圖（highres），其他可能是小圖（thumbnail）
    const isHighRes = details.url.includes('=s0');
    const imageType = isHighRes ? 'highres' : 'thumbnail';
    
    // 使用完整的 URL 作為 key（但截取前 200 字元用於比對）
    const urlKey = details.url.substring(0, 200);
    
    // 【先檢查 storage】優先檢查持久化記錄（避免重複下載）
    const result = await chrome.storage.local.get(['download_history']);
    const history = result.download_history || {};
    
    // 檢查所有對話的記錄
    let found = false;
    for (const [chatKey, chatData] of Object.entries(history)) {
      // 跳過 thumb_captured 等非 URL 記錄
      if (typeof chatData !== 'object' || chatData === null) continue;
      
      for (const [key, value] of Object.entries(chatData)) {
        // 跳過特殊標記（如 thumb_captured）
        if (key === 'thumb_captured') continue;
        
        if (value && typeof value === 'object' && value.url) {
          // 比對 URL（使用前 200 字元）
          const storedUrlKey = value.url.substring(0, 200);
          if (storedUrlKey === urlKey) {
            found = true;
            break;
          }
        }
      }
      if (found) break;
    }
    
    if (found) {
      // 已下載過，直接返回
      return;
    }
    
    // 【檢查內存緩存】防止並發請求同時通過檢查
    if (webRequestProcessingUrls.has(urlKey)) {
      return;
    }
    
    // 立即標記為處理中（防止並發）
    webRequestProcessingUrls.add(urlKey);
    
    // 30 秒後自動清理緩存（延長緩存時間，防止重複下載）
    setTimeout(() => {
      webRequestProcessingUrls.delete(urlKey);
    }, 30000);
    
    // 【限制小圖】如果是小圖，檢查該對話是否已下載過小圖
    if (imageType === 'thumbnail') {
      // 檢查所有對話是否已有 thumb_captured 標記
      // 由於 webRequest 攔截無法獲取 chatId，我們檢查 default 對話
      const defaultChat = history['default'] || {};
      if (defaultChat.thumb_captured === true) {
        console.log('[Background] [自動下載] ⏭️ 跳過小圖下載（已保存預覽圖）');
        webRequestProcessingUrls.delete(urlKey);
        return;
      }
    }
    
    // 【檔案命名優化】由 background.js 負責給予唯一檔名
    const timestamp = Date.now();
    const randomStr = Math.random().toString(36).substring(2, 9);
    const uniqueFilename = `${timestamp}_${randomStr}.png`;
    const downloadPath = buildDownloadPath('auto', imageType, uniqueFilename);
    
    // 【先寫入 storage】在下載前先寫入記錄，防止重複下載
    if (!history['default']) {
      history['default'] = {};
    }
    history['default'][urlKey] = {
      url: urlKey,
      type: imageType,
      timestamp: Date.now(),
      filename: uniqueFilename,
      status: 'queued' // 標記為排隊中
    };
    
    // 【限制小圖】如果是小圖，標記該對話已保存預覽圖
    if (imageType === 'thumbnail') {
      history['default'].thumb_captured = true;
    }
    
    // 立即保存到 storage（在下載前）
    await chrome.storage.local.set({ download_history: history });
    
    // 直接呼叫下載 API
    chrome.downloads.download({
      url: details.url,
      filename: downloadPath,
      saveAs: false,
      conflictAction: 'uniquify'
    }, async (downloadId) => {
      if (chrome.runtime.lastError) {
        // 下載失敗時從緩存中移除，並更新 storage 狀態
        webRequestProcessingUrls.delete(urlKey);
        
        // 更新記錄狀態為失敗
        if (history['default'] && history['default'][urlKey]) {
          history['default'][urlKey].status = 'failed';
          history['default'][urlKey].error = chrome.runtime.lastError.message;
          await chrome.storage.local.set({ download_history: history });
        }
      } else {
        console.log('[Background] [自動下載] ✅ 圖片已排入下載佇列，ID:', downloadId, ', 檔名:', downloadPath, ', 類型:', imageType);
        
        // 更新記錄狀態為已下載
        if (history['default'] && history['default'][urlKey]) {
          history['default'][urlKey].status = 'downloaded';
          history['default'][urlKey].downloadId = downloadId;
        }
        
        // 清理舊資料
        const chatKeys = Object.keys(history);
        if (chatKeys.length > 1000) {
          const sortedKeys = chatKeys.sort((a, b) => {
            const aTime = Math.max(...Object.values(history[a] || {}).map(v => (v.timestamp || 0)));
            const bTime = Math.max(...Object.values(history[b] || {}).map(v => (v.timestamp || 0)));
            return aTime - bTime;
          });
          sortedKeys.slice(0, sortedKeys.length - 1000).forEach(key => delete history[key]);
        }
        
        await chrome.storage.local.set({ download_history: history });
      }
    });
  },
  { urls: ["https://*.googleusercontent.com/*"] },
  ["responseHeaders"]
);

// 處理擴充功能圖標點擊
chrome.action.onClicked.addListener(async (tab) => {
  try {
    // 如果當前標籤頁是 Gemini 網頁，打開 Side Panel
    if (tab.url && tab.url.includes('gemini.google.com')) {
      await chrome.sidePanel.open({ windowId: tab.windowId });
    } else {
      // 如果不是 Gemini 網頁，嘗試打開或跳轉到 Gemini
      const geminiUrl = 'https://gemini.google.com/';
      
      // 檢查是否已有支援站點的標籤頁開啟
      const tabs = await findAllSupportedTabs();
      
      if (tabs.length > 0) {
        // 切換到現有的 Gemini 標籤頁並打開 Side Panel
        await chrome.tabs.update(tabs[0].id, { active: true });
        await chrome.windows.update(tabs[0].windowId, { focused: true });
        await chrome.sidePanel.open({ tabId: tabs[0].id });
      } else {
        // 創建新的 Gemini 標籤頁
        const newTab = await chrome.tabs.create({ url: geminiUrl });
        // 注意：由於 sidePanel.open() 只能在響應用戶手勢時調用
        // 我們無法在標籤頁載入完成後自動打開 Side Panel
        // 用戶需要手動點擊擴展圖標來打開 Side Panel
        console.log('[Background] 已創建新的 Gemini 標籤頁，請點擊擴展圖標打開 Side Panel');
      }
    }
  } catch (error) {
    console.error('打開 Side Panel 時發生錯誤:', error);
  }
});

// 統一監聽來自 Content Script 和 Side Panel 的消息
// 監聽來自 content.js 的抓取結果
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // [Step 6] 處理數據持久化
    if (message.action === 'PERSIST_RESPONSE') {
        const { site, text, timestamp } = message;
        console.log(`[Lobster] 持久化數據: ${site}`);
        
        // 使用 db.js 提供的方法
        self.GeminiLocalDB.addOrMergeMessages({
            chatId: 'lobster_archive', // 暫時統一存放至一個 archive，後續再細分
            userProfile: site,
            messages: [{ role: 'model', text: text, timestamp: timestamp }]
        }).then(res => {
            console.log('[Lobster] 數據物理入庫成功:', res);
        }).catch(err => {
            console.error('[Lobster] 數據入庫失敗:', err);
        });
        return false; // 不需要異步回覆
    }

    if (message.action === 'ACTION_RESULT_READY') {
        console.log('[GEMINISIDE] 收到抓取結果:', message.payload);
        // 未來這裡將對接 Native Messaging
        // 目前先執行 console 輸出與狀態儲存
        chrome.storage.local.set({ last_result: message.payload });
        sendResponse({ status: 'received' });
        return true;
    }
  // 處理從 API 響應中提取的圖片 URL
  if (message.action === 'IMAGE_URL_EXTRACTED') {
    const { url, source } = message;
    if (url && typeof url === 'string') {
      console.log('[Background] [API 攔截] 收到從', source, '提取的圖片 URL:', url.substring(0, 100));
      
      // 保存圖片 URL 到存儲（用於後續下載或顯示）
      chrome.storage.local.get(['extractedImageUrls'], async (result) => {
        const urls = result.extractedImageUrls || [];
        if (!urls.includes(url)) {
          urls.push({
            url: url,
            extractedAt: Date.now(),
            source: source || 'unknown'
          });
          await chrome.storage.local.set({ extractedImageUrls: urls });
          console.log('[Background] [API 攔截] ✅ 圖片 URL 已保存');
        }
      });
      
      // 如果啟用了自動下載，嘗試下載圖片
      if (autoDownloadEnabledCache && url.includes('googleusercontent.com')) {
        // 檢查是否已下載過
        chrome.storage.local.get(['download_history'], async (result) => {
          const history = result.download_history || {};
          const urlKey = url.substring(0, 200);
          
          // 檢查所有對話的記錄
          let found = false;
          for (const [chatKey, chatData] of Object.entries(history)) {
            if (typeof chatData !== 'object' || chatData === null) continue;
            for (const [key, value] of Object.entries(chatData)) {
              if (key === 'thumb_captured') continue;
              if (value && typeof value === 'object' && value.url) {
                const storedUrlKey = value.url.substring(0, 200);
                if (storedUrlKey === urlKey) {
                  found = true;
                  break;
                }
              }
            }
            if (found) break;
          }
          
          if (!found && !webRequestProcessingUrls.has(urlKey)) {
            // 未下載過，觸發下載
            webRequestProcessingUrls.add(urlKey);
            setTimeout(() => {
              webRequestProcessingUrls.delete(urlKey);
            }, 30000);
            
            const timestamp = Date.now();
            const randomStr = Math.random().toString(36).substring(2, 9);
            const uniqueFilename = `${timestamp}_${randomStr}.png`;
            const downloadPath = buildDownloadPath('auto', 'highres', uniqueFilename);
            
            chrome.downloads.download({
              url: url,
              filename: downloadPath,
              saveAs: false,
              conflictAction: 'uniquify'
            }, (downloadId) => {
              if (chrome.runtime.lastError) {
                console.error('[Background] [API 攔截] 下載失敗:', chrome.runtime.lastError.message);
                webRequestProcessingUrls.delete(urlKey);
              } else {
                console.log('[Background] [API 攔截] ✅ 圖片已排入下載佇列，ID:', downloadId);
              }
            });
          }
        });
      }
    }
    sendResponse({ status: 'ok' });
    return true;
  } else if (message.action === 'openSidePanel') {
    // 注意：sidePanel.open() 只能在響應用戶手勢時調用
    // 從消息監聽器中調用會失敗，所以這裡只回應，不實際打開
    // 如果需要打開 Side Panel，應該通過 chrome.action.onClicked 處理
    console.log('[Background] 收到打開 Side Panel 請求（但無法在消息監聽器中打開）');
    sendResponse({ status: 'ok', message: 'Side Panel 只能在用戶點擊擴展圖標時打開' });
    return true;
  } else if (message.action === 'closeSidePanel') {
    // 嘗試關閉 Side Panel（通過禁用當前標籤頁的 Side Panel）
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      if (tabs[0]) {
        try {
          await chrome.sidePanel.setOptions({
            tabId: tabs[0].id,
            enabled: false
          });
          console.log('[Background] ✓ 已禁用 Side Panel (tabId:', tabs[0].id, ')');
        } catch (error) {
          console.log('[Background] 禁用 Side Panel 時發生錯誤:', error.message);
        }
      }
      // 確保響應被發送
      try {
        sendResponse({ status: 'ok' });
      } catch (responseError) {
        console.error('[Background] sendResponse 失敗（closeSidePanel）:', responseError);
      }
    });
    return true; // 異步響應
  } else if (message.action === 'conversationStateChanged') {
    // 監聽對話狀態變化消息並記錄（以 ID 作為索引）
    console.log('[Background] 對話狀態已變化:', message.data);
    // 保存對話狀態到存儲
    if (message.data && message.data.chatId) {
      saveConversationState(message.data);
      // Push to Admin Web
      broadcastAdminEvent('conversationStateChanged', {
        chatId: message.data.chatId,
        title: message.data.title || null,
        url: message.data.url || null,
        userProfile: message.data.userProfile || 'default',
        timestamp: message.data.timestamp || Date.now()
      });
    }
    sendResponse({ status: 'ok' });
    return true;
  } else if (message.action === 'conversationDetected') {
    console.log('[Background] 檢測到新對話:', message.conversation);
    // 可以在這裡添加額外的處理邏輯，例如發送通知等
    sendResponse({ status: 'ok' });
    return true;
  } else if (message.action === 'updateConversationTitle') {
    // 更新對話標題（以 ID 作為索引）
    const { chatId, title, userProfile } = message.data || {};
    if (chatId && title) {
      updateConversationTitle(chatId, title, userProfile).then(success => {
        try {
          sendResponse({ success });
        } catch (error) {
          console.error('[Background] sendResponse 失敗（updateConversationTitle）:', error);
        }
      }).catch(error => {
        console.error('[Background] 更新對話標題時發生錯誤:', error);
        try {
          sendResponse({ success: false, error: error.message || '更新失敗' });
        } catch (responseError) {
          console.error('[Background] sendResponse 失敗（updateConversationTitle error）:', responseError);
        }
      });
      return true; // 異步響應
    }
    sendResponse({ success: false, error: 'Missing chatId or title' });
    return false;
  } else if (message.action === 'saveConversationMessages') {
    // 保存對話消息
    const { chatId, messages, userProfile } = message.data || {};
    if (chatId && messages && messages.length > 0) {
      saveConversationMessages(chatId, messages, userProfile).then(success => {
        // 記錄助手回復到遠端會話（如果有活躍的遠端會話）
        recordMessagesToRemoteSession(messages);
        
        try {
          sendResponse({ status: success ? 'ok' : 'error' });
        } catch (error) {
          console.error('[Background] sendResponse 失敗（saveConversationMessages）:', error);
        }
        
        // 通知 Side Panel 有新消息（如果 Side Panel 已打開）
        if (success) {
          // Push to Admin Web
          broadcastAdminEvent('messagesSaved', {
            chatId,
            userProfile: userProfile || 'default',
            messageCount: messages.length,
            savedAt: Date.now()
          });

          try {
            chrome.runtime.sendMessage({
              action: 'newMessagesAvailable',
              data: {
                chatId: chatId,
                messageCount: messages.length,
                userProfile: userProfile || 'default'
              }
            }).catch(err => {
              // Side Panel 可能未打開，忽略錯誤
              console.log('[Background] 通知 Side Panel 新消息時發生錯誤（可忽略）:', err.message);
            });
          } catch (err) {
            // 忽略錯誤（Side Panel 可能未打開）
            console.log('[Background] 通知 Side Panel 新消息時發生錯誤（可忽略）:', err.message);
          }
        }
      }).catch(error => {
        console.error('[Background] 保存對話消息時發生錯誤:', error);
        try {
          sendResponse({ status: 'error', error: error.message || '保存失敗' });
        } catch (responseError) {
          console.error('[Background] sendResponse 失敗（saveConversationMessages error）:', responseError);
        }
      });
      return true; // 異步響應
    }
    sendResponse({ status: 'error', error: 'Missing chatId or messages' });
    return false;
  } else if (message.action === 'getConversationMessages') {
    // 獲取對話消息
    const { chatId, userProfile } = message.data || {};
    if (chatId) {
      getConversationMessages(chatId, userProfile).then(messages => {
        try {
          sendResponse({ success: true, messages: messages || [] });
        } catch (error) {
          console.error('[Background] sendResponse 失敗（getConversationMessages）:', error);
        }
      }).catch(error => {
        console.error('[Background] 獲取對話消息時發生錯誤:', error);
        try {
          sendResponse({ success: false, error: error.message || '獲取失敗' });
        } catch (responseError) {
          console.error('[Background] sendResponse 失敗（getConversationMessages error）:', responseError);
        }
      });
      return true; // 異步響應
    }
    sendResponse({ success: false, error: 'Missing chatId' });
    return false;
  } else if (message.action === 'RECORD_IMAGE') {
    // 記錄圖片路徑到全局數據庫
    const imageData = message.data;
    if (imageData) {
      recordImageToDatabase(imageData).then(success => {
        try {
          sendResponse({ status: success ? 'ok' : 'error' });
        } catch (error) {
          console.error('[Background] sendResponse 失敗（RECORD_IMAGE）:', error);
        }
      }).catch(error => {
        console.error('[Background] 記錄圖片時發生錯誤:', error);
        try {
          sendResponse({ status: 'error', error: error.message || '記錄失敗' });
        } catch (responseError) {
          console.error('[Background] sendResponse 失敗（RECORD_IMAGE error）:', responseError);
        }
      });
      return true; // 異步響應
    }
    sendResponse({ status: 'error', error: 'Missing image data' });
    return false;
  } else if (message.action === 'RECORD_CLICK_MONITOR') {
    // 記錄點擊監聽事件
    try {
      const record = message.record;
      if (!record) {
        sendResponse({ status: 'error', error: '缺少記錄數據' });
        return false;
      }
      
      const userProfile = record.userProfile || 'default';
      const storageKey = `click_monitor_records_${userProfile}`;
      
      chrome.storage.local.get([storageKey], (result) => {
        const records = result[storageKey] || [];
        records.push(record);
        
        // 限制記錄數量（最多保留 200 條）
        if (records.length > 200) {
          records.shift();
        }
        
        chrome.storage.local.set({ [storageKey]: records }, () => {
          console.log('[Background] [點擊監聽記錄] ✓ 已保存記錄:', record.eventType);
        });
      });
      
      sendResponse({ status: 'ok' });
    } catch (error) {
      console.error('[Background] [點擊監聽記錄] 保存失敗:', error);
      sendResponse({ status: 'error', error: error.message });
    }
    return false;
  } else if (message.action === 'GET_CLICK_MONITOR_RECORDS') {
    // 獲取點擊監聽記錄
    try {
      const userProfile = message.userProfile || 'default';
      const storageKey = `click_monitor_records_${userProfile}`;
      
      chrome.storage.local.get([storageKey], (result) => {
        const records = result[storageKey] || [];
        sendResponse({ status: 'ok', records: records });
      });
    } catch (error) {
      console.error('[Background] [點擊監聽記錄] 獲取失敗:', error);
      sendResponse({ status: 'error', error: error.message });
    }
    return true; // 異步響應
  } else if (message.action === 'UPDATE_CLICK_MONITOR_RECORD') {
    // 更新點擊監聽記錄（合併同一條 DOWNLOAD_STARTED）
    try {
      const recordId = message.recordId;
      const userProfile = message.userProfile || 'default';
      const patch = message.patch || {};

      if (!recordId) {
        sendResponse({ status: 'error', error: '缺少 recordId' });
        return false;
      }

      const storageKey = `click_monitor_records_${userProfile}`;
      chrome.storage.local.get([storageKey], (result) => {
        const records = result[storageKey] || [];
        const idx = records.findIndex(r => r.id === recordId);
        if (idx >= 0) {
          const existing = records[idx];
          const mergedData = {
            ...(existing.data || {}),
            ...(patch.data || patch || {})
          };
          records[idx] = {
            ...existing,
            data: mergedData,
            updatedAt: Date.now()
          };
        }

        chrome.storage.local.set({ [storageKey]: records }, () => {
          sendResponse({ status: 'ok' });
        });
      });
    } catch (error) {
      console.error('[Background] [點擊監聽記錄] 更新失敗:', error);
      sendResponse({ status: 'error', error: error.message });
    }
    return true; // 異步響應
  } else if (message.action === 'CLEAR_CLICK_MONITOR_RECORDS') {
    // 清除點擊監聽記錄
    try {
      const userProfile = message.userProfile || 'default';
      const storageKey = `click_monitor_records_${userProfile}`;
      
      chrome.storage.local.set({ [storageKey]: [] }, () => {
        console.log('[Background] [點擊監聽記錄] ✓ 已清除記錄');
        sendResponse({ status: 'ok' });
      });
    } catch (error) {
      console.error('[Background] [點擊監聽記錄] 清除失敗:', error);
      sendResponse({ status: 'error', error: error.message });
    }
    return true; // 異步響應
  } else if (message.action === 'EXPORT_CLICK_MONITOR_RECORDS') {
    // 導出點擊監聽記錄
    exportClickMonitorRecords(message.userProfile).then(result => {
      sendResponse(result);
    }).catch(error => {
      sendResponse({ status: 'error', error: error.message });
    });
    return true; // 異步響應
  } else if (message.action === 'FORCE_DOWNLOAD_URL') {
    // 強制下載指定 URL
    try {
      const url = message.url;
      if (!url) {
        sendResponse({ status: 'error', error: '缺少 URL' });
        return false;
      }

      chrome.downloads.download({
        url: url,
        saveAs: false,
        conflictAction: 'uniquify'
      }, (downloadId) => {
        if (chrome.runtime.lastError) {
          console.error('[Background] [強制下載] 下載失敗:', chrome.runtime.lastError.message);
          sendResponse({ status: 'error', error: chrome.runtime.lastError.message });
        } else {
          console.log('[Background] [強制下載] ✓ 已觸發下載:', downloadId);
          sendResponse({ status: 'ok', downloadId });
        }
      });
    } catch (error) {
      console.error('[Background] [強制下載] 下載失敗:', error);
      sendResponse({ status: 'error', error: error.message });
    }
    return true;
  } else if (message.action === 'GET_ACTIVE_TAB_ID') {
    try {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tabId = tabs && tabs.length ? tabs[0].id : null;
        sendResponse({ status: 'ok', tabId });
      });
    } catch (error) {
      sendResponse({ status: 'error', error: error.message });
    }
    return true;
  } else if (message.action === 'CLOSE_DOWNLOAD_TABS') {
    try {
      const targetUrl = message.url || '';
      const returnTabId = message.returnTabId || null;
      chrome.tabs.query({}, (tabs) => {
        const tabsToClose = [];
        tabs.forEach((tab) => {
          if (!tab || !tab.id) return;
          if (returnTabId && tab.id === returnTabId) return;
          const tabUrl = tab.url || '';
          if (!tabUrl) return;
          const isDownloadTab = targetUrl
            ? tabUrl.startsWith(targetUrl)
            : (tabUrl.includes('rd-gg-dl') || tabUrl.includes('gg-dl'));
          if (isDownloadTab) {
            tabsToClose.push(tab.id);
          }
        });

        if (tabsToClose.length) {
          chrome.tabs.remove(tabsToClose, () => {
            if (returnTabId) {
              chrome.tabs.update(returnTabId, { active: true }).catch(() => {});
            }
            sendResponse({ status: 'ok', closed: tabsToClose.length });
          });
        } else {
          if (returnTabId) {
            chrome.tabs.update(returnTabId, { active: true }).catch(() => {});
          }
          sendResponse({ status: 'ok', closed: 0 });
        }
      });
    } catch (error) {
      sendResponse({ status: 'error', error: error.message });
    }
    return true;
  } else if (message.action === 'IMAGES_DETECTED') {
    // 轉發圖片消息到 Side Panel
    const imageData = message.data || [];
    console.log('[Background] 收到圖片檢測消息，共', imageData.length, '張圖片');
    
    // 記錄圖片到遠端會話（如果有活躍的遠端會話）
    if (imageData.length > 0) {
      imageData.forEach(img => {
        recordImageToRemoteSession(img);
      });
    }
    
    // 保存圖片數據到存儲（按用戶檔案和對話 ID 分組）
    if (imageData.length > 0) {
      const firstImage = imageData[0];
      const userProfile = firstImage.userProfile || 'default';
      const chatId = firstImage.chatId;
      
      if (chatId) {
        const storageKey = `generated_images_${userProfile}_${chatId}`;
        chrome.storage.local.get([storageKey]).then(result => {
          const existingImages = result[storageKey] || [];
          const imageMap = new Map();
          
          // 將現有圖片添加到 Map（去重）
          existingImages.forEach(img => {
            imageMap.set(img.id, img);
          });
          
          // 添加新圖片（覆蓋舊的）
          imageData.forEach(img => {
            imageMap.set(img.id, img);
          });
          
          // 保存回存儲
          const allImages = Array.from(imageMap.values());
          chrome.storage.local.set({ [storageKey]: allImages }).then(() => {
            console.log('[Background] ✓ 圖片數據已保存，共', allImages.length, '張');
          });
        });
      }
    }
    
    // 轉發到 Side Panel
    try {
      chrome.runtime.sendMessage({
        action: 'IMAGES_DETECTED',
        data: imageData
      }).catch(err => {
        // Side Panel 可能未打開，忽略錯誤
        console.log('[Background] 轉發圖片消息到 Side Panel 時發生錯誤（可忽略）:', err.message);
      });
    } catch (err) {
      console.log('[Background] 轉發圖片消息時發生錯誤（可忽略）:', err.message);
    }
    
    sendResponse({ status: 'ok' });
    return true;
  } else if (message.action === 'DOWNLOAD_IMAGE') {
    // 自動下載圖片（從佔位符變更為真實路徑時觸發，支援新的 data 格式）
    const url = message.url || (message.data && message.data.url);
    const filename = message.filename || (message.data && message.data.filename);
    const requestId = message.requestId || (message.data && message.data.requestId);
    const chatId = message.chatId || (message.data && message.data.chatId);
    const userProfile = message.userProfile || (message.data && message.data.userProfile) || 'default';
    const imageType = message.imageType || (message.data && message.data.imageType) || 'highres';
    const conversationTitle = message.conversationTitle || message.data?.conversationTitle || (chatId ? `Chat_${chatId.substring(0, 20)}` : '未命名對話');
    
    if (!autoDownloadEnabledCache) {
      // 取消自動下載，但不影響「圖片記錄/右側顯示」
      sendResponse({ status: 'ok', message: 'Auto download disabled' });
      return true;
    }

    if (url) {
      // 【持久化 Registry】在任何下載行為發生前，必須先 await 讀取 storage。如果該圖片的 requestId 或 URL 已存在，則絕對禁止執行後續邏輯
      // 使用 Promise 包裝異步操作，確保 sendResponse 在正確的時機被調用
      (async () => {
        let responseSent = false;
        const safeSendResponse = (response) => {
          if (!responseSent) {
            responseSent = true;
            try {
              sendResponse(response);
            } catch (error) {
              console.error('[Background] [自動下載] sendResponse 失敗:', error);
            }
          }
        };

        try {
          // 【內存鎖機制】防止競態條件：在檢查前先檢查是否正在處理
          const urlKey = url.substring(0, 200);
          const lockKey = requestId ? `req_${requestId.substring(0, 50)}` : `url_${urlKey}`;
          
          // 檢查是否正在處理（防止並發請求）
          if (downloadImageProcessingLocks.has(lockKey)) {
            const lock = downloadImageProcessingLocks.get(lockKey);
            const lockAge = Date.now() - lock.timestamp;
            // 如果鎖超過 30 秒，認為是過期鎖，清除它
            if (lockAge > 30000) {
              if (lock.timeoutId) clearTimeout(lock.timeoutId);
              downloadImageProcessingLocks.delete(lockKey);
            } else {
              console.log('[Background] [自動下載] ⏭️  跳過重複下載（正在處理中）:', lockKey.substring(0, 50));
              safeSendResponse({ status: 'ok', message: '圖片正在下載中，跳過' });
              return;
            }
          }
          
          // 立即設置鎖（防止其他並發請求）
          const timeoutId = setTimeout(() => {
            downloadImageProcessingLocks.delete(lockKey);
          }, 30000); // 30 秒後自動清理鎖
          
          downloadImageProcessingLocks.set(lockKey, {
            timestamp: Date.now(),
            timeoutId: timeoutId
          });

          const result = await chrome.storage.local.get(['download_history']);
          const history = result.download_history || {};
          const chatKey = chatId || 'default';
          const chatData = history[chatKey] || {};
          
          // 檢查 requestId
          if (requestId && chatData[requestId]) {
            console.log('[Background] [自動下載] ⏭️  跳過重複下載（requestId 已存在）:', requestId.substring(0, 50));
            // 清理鎖
            if (timeoutId) clearTimeout(timeoutId);
            downloadImageProcessingLocks.delete(lockKey);
            safeSendResponse({ status: 'ok', message: '圖片已下載過，跳過' });
            return;
          }
          
          // 檢查 URL
          for (const [key, value] of Object.entries(chatData)) {
            if (value && typeof value === 'object' && value.url && value.url.substring(0, 200) === urlKey) {
              console.log('[Background] [自動下載] ⏭️  跳過重複下載（URL 已存在）:', urlKey.substring(0, 50));
              // 清理鎖
              if (timeoutId) clearTimeout(timeoutId);
              downloadImageProcessingLocks.delete(lockKey);
              safeSendResponse({ status: 'ok', message: '圖片已下載過，跳過' });
              return;
            }
          }
          
          // 【過濾 unnamed 格式】如果檔名包含 "unnamed"，跳過下載（優先選擇另一種命名格式）
          if (filename && (filename.toLowerCase().includes('unnamed') || filename.includes('未命名'))) {
            console.log('[Background] [自動下載] ⏭️ 跳過 unnamed 格式的檔案:', filename);
            // 清理鎖
            if (timeoutId) clearTimeout(timeoutId);
            downloadImageProcessingLocks.delete(lockKey);
            safeSendResponse({ status: 'ok', message: '跳過 unnamed 格式的檔案' });
            return;
          }
          
          // 【檔案命名優化】由 background.js 負責給予唯一檔名（包含時間戳記和隨機字串），避免瀏覽器因為同名檔案而忽略第二次下載請求
          const timestamp = Date.now();
          const randomStr = Math.random().toString(36).substring(2, 9);
          let downloadFilename;
          
          if (filename) {
            // 如果提供了檔名，在檔名中加入時間戳和隨機字串確保唯一性
            const ext = filename.includes('.png') ? '.png' : '.jpg';
            const baseName = filename.replace(/\.(png|jpg|jpeg)$/i, '');
            downloadFilename = `${baseName}_${timestamp}_${randomStr}${ext}`;
          } else {
            // 如果沒有提供檔名，生成新的檔名（使用唯一識別碼）
            const uniqueId = requestId ? requestId.substring(0, 20) : `${timestamp}_${randomStr}`;
            downloadFilename = `${uniqueId}.png`;
          }
          
          const cleanTitle = sanitizeFilename(conversationTitle);
          const cleanProfile = sanitizeFilename(userProfile || 'default');
          const downloadPath = buildDownloadPath('images', cleanProfile, cleanTitle, downloadFilename);
          
          // 【下載日誌】獲取下載日誌信息
          const downloadLog = message.downloadLog || {};
          
          // 使用 Promise 包裝下載操作
          const downloadPromise = new Promise((resolve, reject) => {
            chrome.downloads.download({
              url: url,
              filename: downloadPath,
              conflictAction: "uniquify",
              saveAs: false // 設為 false 即可達成「自動下載」不彈窗
            }, (downloadId) => {
              if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
              } else {
                resolve(downloadId);
              }
            });
          });

          try {
            const downloadId = await downloadPromise;
            console.log(`[Background] [自動下載] ✅ 圖片已排入下載佇列，ID: ${downloadId}, 檔名: ${downloadPath}`);
            
            // 【下載日誌】記錄成功的下載
            await logDownloadAttempt({
              ...downloadLog,
              downloadId: downloadId,
              status: 'queued',
              downloadPath: downloadPath,
              downloadFilename: downloadFilename,
              cleanTitle: cleanTitle
            });
            
            // 監聽下載完成事件，獲取實際文件大小（使用超時機制確保監聽器被清理）
            let listenerRemoved = false;
            const timeoutId = setTimeout(() => {
              if (!listenerRemoved) {
                chrome.downloads.onChanged.removeListener(onDownloadChanged);
                listenerRemoved = true;
                console.log('[Background] [自動下載] ⏰ 下載監聽器超時，已清理');
              }
            }, 300000); // 5 分鐘超時

            const onDownloadChanged = (delta) => {
              if (delta.id === downloadId) {
                if (delta.state && delta.state.current === 'complete') {
                  // 獲取下載項目的完整信息
                  chrome.downloads.search({ id: downloadId }, (results) => {
                    if (results && results[0]) {
                      const downloadItem = results[0];
                      // 【下載日誌】更新下載完成信息
                      logDownloadAttempt({
                        ...downloadLog,
                        downloadId: downloadId,
                        status: 'completed',
                        downloadPath: downloadPath,
                        downloadFilename: downloadFilename,
                        cleanTitle: cleanTitle,
                        fileSize: downloadItem.totalBytes || 0,
                        fileSizeFormatted: formatFileSize(downloadItem.totalBytes || 0),
                        mimeType: downloadItem.mime || 'image/png'
                      }).then(() => {
                        if (!listenerRemoved) {
                          clearTimeout(timeoutId);
                          chrome.downloads.onChanged.removeListener(onDownloadChanged);
                          listenerRemoved = true;
                        }
                      }).catch(err => {
                        console.error('[Background] [自動下載] 記錄下載完成信息失敗:', err);
                        if (!listenerRemoved) {
                          clearTimeout(timeoutId);
                          chrome.downloads.onChanged.removeListener(onDownloadChanged);
                          listenerRemoved = true;
                        }
                      });
                    }
                  });
                } else if (delta.state && delta.state.current === 'interrupted') {
                  // 【下載日誌】記錄中斷的下載
                  logDownloadAttempt({
                    ...downloadLog,
                    downloadId: downloadId,
                    status: 'interrupted',
                    error: delta.error?.current || 'Unknown error',
                    downloadPath: downloadPath,
                    downloadFilename: downloadFilename
                  }).then(() => {
                    if (!listenerRemoved) {
                      clearTimeout(timeoutId);
                      chrome.downloads.onChanged.removeListener(onDownloadChanged);
                      listenerRemoved = true;
                    }
                  }).catch(err => {
                    console.error('[Background] [自動下載] 記錄下載中斷信息失敗:', err);
                    if (!listenerRemoved) {
                      clearTimeout(timeoutId);
                      chrome.downloads.onChanged.removeListener(onDownloadChanged);
                      listenerRemoved = true;
                    }
                  });
                }
              }
            };
            
            chrome.downloads.onChanged.addListener(onDownloadChanged);
            
            // 【持久化 Registry】下載後立即寫入紀錄
            if (!history[chatKey]) {
              history[chatKey] = {};
            }
            const recordKey = requestId || urlKey;
            history[chatKey][recordKey] = {
              url: urlKey,
              type: imageType, // 'thumbnail' 或 'highres'
              timestamp: Date.now(),
              filename: downloadFilename,
              conversationTitle: cleanTitle
            };
            
            // 清理舊資料（只保留最近 1000 個對話的記錄）
            const chatKeys = Object.keys(history);
            if (chatKeys.length > 1000) {
              const sortedKeys = chatKeys.sort((a, b) => {
                const aTime = Math.max(...Object.values(history[a] || {}).map(v => (v && typeof v === 'object' && v.timestamp) ? v.timestamp : 0));
                const bTime = Math.max(...Object.values(history[b] || {}).map(v => (v && typeof v === 'object' && v.timestamp) ? v.timestamp : 0));
                return aTime - bTime;
              });
              sortedKeys.slice(0, sortedKeys.length - 1000).forEach(key => delete history[key]);
            }
            
            await chrome.storage.local.set({ download_history: history });
            console.log('[Background] [自動下載] ✓ 已記錄到 download_history');
            
            // 清理鎖（下載已成功啟動）
            if (timeoutId) clearTimeout(timeoutId);
            downloadImageProcessingLocks.delete(lockKey);
            
            safeSendResponse({ status: 'ok', downloadId: downloadId });
          } catch (downloadError) {
            console.error('[Background] [自動下載] ❌ 下載失敗:', downloadError.message);
            
            // 清理鎖（下載失敗）
            if (timeoutId) clearTimeout(timeoutId);
            downloadImageProcessingLocks.delete(lockKey);
            
            // 【下載日誌】記錄失敗的下載
            try {
              await logDownloadAttempt({
                ...downloadLog,
                downloadId: null,
                status: 'failed',
                error: downloadError.message,
                downloadPath: downloadPath,
                downloadFilename: downloadFilename
              });
            } catch (logError) {
              console.error('[Background] [自動下載] 記錄失敗日誌時發生錯誤:', logError);
            }
            
            safeSendResponse({ status: 'error', error: downloadError.message });
          }
        } catch (error) {
          console.error('[Background] [自動下載] 處理下載請求時發生錯誤:', error);
          
          // 清理鎖（處理錯誤）
          const lock = downloadImageProcessingLocks.get(lockKey);
          if (lock && lock.timeoutId) {
            clearTimeout(lock.timeoutId);
          }
          downloadImageProcessingLocks.delete(lockKey);
          
          safeSendResponse({ status: 'error', error: error.message || '未知錯誤' });
        }
      })();
      return true; // 異步響應
    }
    sendResponse({ status: 'error', error: 'Missing URL' });
    return false;
  } else if (message.action === 'LOG_OPERATION') {
    // 記錄操作日誌
    const logEntry = message.logEntry;
    if (logEntry) {
      saveOperationLog(logEntry).then(() => {
        sendResponse({ status: 'ok' });
      }).catch(error => {
        console.error('[Background] [操作日誌] 保存失敗:', error);
        sendResponse({ status: 'error', error: error.message });
      });
    } else {
      sendResponse({ status: 'error', error: 'Missing logEntry' });
    }
    return true;
  } else if (message.action === 'EXPORT_OPERATION_LOGS') {
    // 導出操作日誌到文件
    exportOperationLogs(message.userProfile).then(result => {
      sendResponse(result);
    }).catch(error => {
      sendResponse({ status: 'error', error: error.message });
    });
    return true;
  } else if (message.action === 'GET_OPERATION_LOGS') {
    // 獲取操作日誌
    getOperationLogs(message.userProfile).then(logs => {
      sendResponse({ status: 'ok', logs: logs });
    }).catch(error => {
      sendResponse({ status: 'error', error: error.message });
    });
    return true;
  } else if (message.action === 'IMAGE_INTERCEPTED') {
    // 新增：處理圖片攔截消息（來自專案控制面板功能）
    handleImageIntercepted(message.data, sender.tab?.id);
    sendResponse({ status: 'ok' });
    return true;
  } else if (message.action === 'GET_INTERCEPTED_IMAGES') {
    // 新增：返回攔截到的圖片列表
    chrome.storage.local.get(['interceptedImages'], (result) => {
      sendResponse({ images: result.interceptedImages || [] });
    });
    return true;
  } else if (message.action === 'ADD_TO_PROJECT') {
    // 新增：將圖片添加到專案
    addImageToProject(message.data);
    sendResponse({ status: 'ok' });
    return true;
  } else if (message.action === 'R2_SAVE_CONFIG') {
    // 保存 R2 配置
    const config = message.config;
    if (self.R2Client) {
      self.R2Client.saveConfig(config).then(success => {
        try {
          sendResponse({ success, message: success ? 'R2 配置已保存' : '保存失敗' });
        } catch (error) {
          console.error('[Background] sendResponse 失敗（R2_SAVE_CONFIG）:', error);
        }
      }).catch(error => {
        console.error('[Background] 保存 R2 配置時發生錯誤:', error);
        try {
          sendResponse({ success: false, error: error.message || '保存失敗' });
        } catch (responseError) {
          console.error('[Background] sendResponse 失敗（R2_SAVE_CONFIG error）:', responseError);
        }
      });
      return true;
    }
    sendResponse({ success: false, error: 'R2Client not available' });
    return false;
  } else if (message.action === 'R2_LOAD_CONFIG') {
    // 載入 R2 配置
    if (self.R2Client) {
      self.R2Client.loadConfig().then(config => {
        try {
          sendResponse({ success: true, config: config || null });
        } catch (error) {
          console.error('[Background] sendResponse 失敗（R2_LOAD_CONFIG）:', error);
        }
      }).catch(error => {
        console.error('[Background] 載入 R2 配置時發生錯誤:', error);
        try {
          sendResponse({ success: false, error: error.message || '載入失敗' });
        } catch (responseError) {
          console.error('[Background] sendResponse 失敗（R2_LOAD_CONFIG error）:', responseError);
        }
      });
      return true;
    }
    sendResponse({ success: false, error: 'R2Client not available' });
    return false;
  } else if (message.action === 'R2_TEST_CONNECTION') {
    // 測試 R2 連接
    if (self.R2Client) {
      self.R2Client.testConnection().then(result => {
        try {
          sendResponse(result);
        } catch (error) {
          console.error('[Background] sendResponse 失敗（R2_TEST_CONNECTION）:', error);
        }
      }).catch(error => {
        console.error('[Background] 測試 R2 連接時發生錯誤:', error);
        try {
          sendResponse({ success: false, error: error.message || '測試失敗' });
        } catch (responseError) {
          console.error('[Background] sendResponse 失敗（R2_TEST_CONNECTION error）:', responseError);
        }
      });
      return true;
    }
    sendResponse({ success: false, error: 'R2Client not available' });
    return false;
  } else if (message.action === 'R2_UPLOAD_CONVERSATION') {
    // 上傳單個對話到 R2
    const { chatId, userProfile } = message.data || {};
    if (!chatId) {
      sendResponse({ success: false, error: 'Missing chatId' });
      return false;
    }
    if (self.R2Client && self.GeminiLocalDB) {
      (async () => {
        try {
          const profile = userProfile || 'default';
          const messages = await self.GeminiLocalDB.getConversationMessages({ chatId, userProfile: profile });
          const meta = await self.GeminiLocalDB.getConversationMeta({ chatId, userProfile: profile });
          
          await self.R2Client.uploadConversation(chatId, profile, {
            title: meta?.title || '未命名對話',
            url: meta?.url || `https://gemini.google.com/app/${chatId}`,
            lastUpdated: meta?.lastUpdated || Date.now(),
            createdAt: meta?.createdAt || Date.now(),
            messages: messages || []
          });
          
          try {
            sendResponse({ success: true, message: '對話已上傳到 R2' });
          } catch (error) {
            console.error('[Background] sendResponse 失敗（R2_UPLOAD_CONVERSATION）:', error);
          }
        } catch (error) {
          console.error('[Background] 上傳對話到 R2 時發生錯誤:', error);
          try {
            sendResponse({ success: false, error: error.message || '上傳失敗' });
          } catch (responseError) {
            console.error('[Background] sendResponse 失敗（R2_UPLOAD_CONVERSATION error）:', responseError);
          }
        }
      })();
      return true;
    }
    sendResponse({ success: false, error: 'R2Client or GeminiLocalDB not available' });
    return false;
  } else if (message.action === 'R2_UPLOAD_ALL') {
    // 批量上傳所有對話到 R2
    const { userProfile } = message.data || {};
    if (self.R2Client) {
      self.R2Client.uploadAllConversations(userProfile).then(results => {
        try {
          sendResponse({ success: true, results });
        } catch (error) {
          console.error('[Background] sendResponse 失敗（R2_UPLOAD_ALL）:', error);
        }
      }).catch(error => {
        console.error('[Background] 批量上傳到 R2 時發生錯誤:', error);
        try {
          sendResponse({ success: false, error: error.message || '批量上傳失敗' });
        } catch (responseError) {
          console.error('[Background] sendResponse 失敗（R2_UPLOAD_ALL error）:', responseError);
        }
      });
      return true;
    }
    sendResponse({ success: false, error: 'R2Client not available' });
    return false;
  } else if (message.action === 'R2_DOWNLOAD_CONVERSATION') {
    // 從 R2 下載單個對話
    const { chatId, userProfile } = message.data || {};
    if (!chatId) {
      sendResponse({ success: false, error: 'Missing chatId' });
      return false;
    }
    if (self.R2Client) {
      self.R2Client.downloadConversation(chatId, userProfile).then(data => {
        try {
          sendResponse({ success: true, data });
        } catch (error) {
          console.error('[Background] sendResponse 失敗（R2_DOWNLOAD_CONVERSATION）:', error);
        }
      }).catch(error => {
        console.error('[Background] 從 R2 下載對話時發生錯誤:', error);
        try {
          sendResponse({ success: false, error: error.message || '下載失敗' });
        } catch (responseError) {
          console.error('[Background] sendResponse 失敗（R2_DOWNLOAD_CONVERSATION error）:', responseError);
        }
      });
      return true;
    }
    sendResponse({ success: false, error: 'R2Client not available' });
    return false;
  } else if (message.action === 'R2_LIST_CONVERSATIONS') {
    // 從 R2 列出所有對話
    const { userProfile } = message.data || {};
    if (self.R2Client) {
      self.R2Client.listConversations(userProfile).then(conversations => {
        try {
          sendResponse({ success: true, conversations });
        } catch (error) {
          console.error('[Background] sendResponse 失敗（R2_LIST_CONVERSATIONS）:', error);
        }
      }).catch(error => {
        console.error('[Background] 從 R2 列出對話時發生錯誤:', error);
        try {
          sendResponse({ success: false, error: error.message || '列出失敗' });
        } catch (responseError) {
          console.error('[Background] sendResponse 失敗（R2_LIST_CONVERSATIONS error）:', responseError);
        }
      });
      return true;
    }
    sendResponse({ success: false, error: 'R2Client not available' });
    return false;
  } else if (message.action === 'R2_SYNC_FROM_R2') {
    // 從 R2 同步對話到本地
    const { userProfile, chatIds } = message.data || {};
    if (self.R2Client) {
      self.R2Client.syncConversationsFromR2(userProfile, chatIds).then(results => {
        try {
          sendResponse({ success: true, results });
        } catch (error) {
          console.error('[Background] sendResponse 失敗（R2_SYNC_FROM_R2）:', error);
        }
      }).catch(error => {
        console.error('[Background] 從 R2 同步對話時發生錯誤:', error);
        try {
          sendResponse({ success: false, error: error.message || '同步失敗' });
        } catch (responseError) {
          console.error('[Background] sendResponse 失敗（R2_SYNC_FROM_R2 error）:', responseError);
        }
      });
      return true;
    }
    sendResponse({ success: false, error: 'R2Client not available' });
    return false;
  }
  
  return false;
});

// 【全域】攔截下載類型請求，回報 responseURL 給 content.js 記錄
chrome.webRequest.onCompleted.addListener(
  (details) => {
    const url = details?.url || '';
    if (!url) return;

    const isTargetUrl =
      url.includes('rd-gg') ||
      url.includes('rd-gg-dl') ||
      url.includes('gg-dl') ||
      url.includes('googleusercontent.com') ||
      url.includes('work.fife.usercontent.google.com');

    if (!isTargetUrl) return;

    findAllSupportedTabs().then(tabs => {
      tabs.forEach(tab => {
        chrome.tabs.sendMessage(tab.id, {
          action: 'RECORD_RESPONSE_URL',
          url: url,
          tabId: details.tabId,
          initiator: details.initiator || details.documentUrl || ''
        }, () => {});
      });
    });
  },
  {
    urls: [
      '*://work.fife.usercontent.google.com/rd-gg*',
      '*://lh3.googleusercontent.com/rd-gg*',
      '*://lh3.googleusercontent.com/rd-gg-dl*',
      '*://lh3.googleusercontent.com/gg-dl*',
      '*://*.googleusercontent.com/*'
    ]
  }
);

// 格式化日期為 YYYYMMDD 格式
function formatDate(timestamp) {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

// 保存對話狀態（按用戶檔案隔離，以 ID 作為索引）
async function saveConversationState(data) {
  try {
    const userProfile = data.userProfile || 'default';
    const storageKey = `conversationStates_${userProfile}`;
    
    const result = await chrome.storage.local.get([storageKey]);
    const states = result[storageKey] || {};
    
    // 使用 chatId 作為索引（鍵）保存狀態
    if (data.chatId) {
      // 結構：states[chatId] = { chatId, title, url, ... }
      const existingState = states[data.chatId];
      
      states[data.chatId] = {
        chatId: data.chatId,
        title: data.title || existingState?.title || '未命名對話',
        url: data.url || existingState?.url || `https://gemini.google.com/app/${data.chatId}`,
        lastUpdated: data.timestamp || Date.now(),
        timestamp: data.timestamp || existingState?.timestamp || Date.now(),
        userProfile: userProfile
      };
      
      await chrome.storage.local.set({ [storageKey]: states });
      console.log(`[Background] 對話狀態已保存 (用戶檔案: ${userProfile}, ID: ${data.chatId}):`, states[data.chatId].title);

      // 同步寫入本地 DB（不影響側欄原本讀 storage 的行為）
      try {
        if (self.GeminiLocalDB) {
          await self.GeminiLocalDB.upsertConversationMeta({
            chatId: data.chatId,
            userProfile: userProfile,
            title: states[data.chatId].title,
            url: states[data.chatId].url,
            lastUpdated: states[data.chatId].lastUpdated || Date.now()
          });
        }
      } catch (e) {
        console.warn('[Background] 寫入本地 DB（對話狀態）失敗（可忽略）:', e?.message || e);
      }
    }
  } catch (error) {
    console.error('[Background] 保存對話狀態時發生錯誤:', error);
  }
}

// 更新對話標題（按 ID 索引）
async function updateConversationTitle(chatId, title, userProfile) {
  try {
    const profile = userProfile || 'default';
    const storageKey = `conversationStates_${profile}`;
    
    const result = await chrome.storage.local.get([storageKey]);
    const states = result[storageKey] || {};
    
    if (states[chatId]) {
      const oldTitle = states[chatId].title;
      states[chatId].title = title;
      states[chatId].lastUpdated = Date.now();
      
      await chrome.storage.local.set({ [storageKey]: states });
      console.log(`[Background] 對話標題已更新 (ID: ${chatId}): "${oldTitle}" -> "${title}"`);

      // 同步寫入本地 DB
      try {
        if (self.GeminiLocalDB) {
          await self.GeminiLocalDB.upsertConversationMeta({
            chatId,
            userProfile: profile,
            title,
            url: states[chatId]?.url,
            lastUpdated: Date.now()
          });
        }
      } catch (e) {
        console.warn('[Background] 寫入本地 DB（更新標題）失敗（可忽略）:', e?.message || e);
      }
      return true;
    } else {
      // 如果不存在，創建新記錄
      states[chatId] = {
        chatId: chatId,
        title: title,
        url: `https://gemini.google.com/app/${chatId}`,
        lastUpdated: Date.now(),
        timestamp: Date.now(),
        userProfile: profile
      };
      await chrome.storage.local.set({ [storageKey]: states });
      console.log(`[Background] 對話記錄已創建 (ID: ${chatId}): "${title}"`);

      // 同步寫入本地 DB
      try {
        if (self.GeminiLocalDB) {
          await self.GeminiLocalDB.upsertConversationMeta({
            chatId,
            userProfile: profile,
            title,
            url: states[chatId]?.url,
            lastUpdated: Date.now()
          });
        }
      } catch (e) {
        console.warn('[Background] 寫入本地 DB（創建標題）失敗（可忽略）:', e?.message || e);
      }
      return true;
    }
  } catch (error) {
    console.error('[Background] 更新對話標題時發生錯誤:', error);
    return false;
  }
}


// 保存對話消息
async function saveConversationMessages(chatId, messages, userProfile) {
  try {
    const profile = userProfile || 'default';
    if (!self.GeminiLocalDB) {
      throw new Error('GeminiLocalDB not available');
    }

    await self.GeminiLocalDB.addOrMergeMessages({
      chatId,
      userProfile: profile,
      messages
    });

    console.log(`[Background] 對話消息已保存到本地 DB (用戶檔案: ${profile}, ID: ${chatId}, 本次提交: ${messages.length}條)`);
    return true;
  } catch (error) {
    console.error('[Background] 保存對話消息時發生錯誤:', error);
    return false;
  }
}

// 獲取對話消息（包括圖片數據）
async function getConversationMessages(chatId, userProfile) {
  try {
    const profile = userProfile || 'default';
    if (!self.GeminiLocalDB) {
      throw new Error('GeminiLocalDB not available');
    }

    let messages = await self.GeminiLocalDB.getConversationMessages({ chatId, userProfile: profile });

    // 向後兼容：如果 DB 尚未有資料，嘗試從舊 storage 讀一次（首次升級時）
    if (!messages || messages.length === 0) {
      const storageKey = `conversationMessages_${profile}`;
      try {
        const result = await chrome.storage.local.get([storageKey]);
        const allMessages = result[storageKey] || {};
        const legacy = allMessages[chatId] || [];
        if (legacy.length > 0) {
          await self.GeminiLocalDB.addOrMergeMessages({ chatId, userProfile: profile, messages: legacy });
          messages = await self.GeminiLocalDB.getConversationMessages({ chatId, userProfile: profile });
        }
      } catch (e) {
        // 忽略舊資料讀取失敗
      }
    }

    // 仍然合併已保存的圖片數據（從 generated_images 存儲）
    const imagesStorageKey = `generated_images_${profile}_${chatId}`;
    const imagesResult = await chrome.storage.local.get([imagesStorageKey]);
    const savedImages = imagesResult[imagesStorageKey] || [];

    if (savedImages.length > 0 && messages && messages.length > 0) {
      const messageMap = new Map();
      messages.forEach((msg, index) => {
        if (msg.id) messageMap.set(msg.id, index);
      });
      savedImages.forEach(imageData => {
        if (imageData.requestId) {
          const messageIndex = messageMap.get(imageData.requestId);
          if (messageIndex !== undefined && messages[messageIndex]) {
            if (!messages[messageIndex].images) messages[messageIndex].images = [];
            const exists = messages[messageIndex].images.some(img => img.id === imageData.id);
            if (!exists) {
              messages[messageIndex].images.push({
                id: imageData.id,
                url: imageData.url,
                base64: imageData.base64,
                alt: imageData.alt || '生成的圖片',
                timestamp: imageData.timestamp,
                requestId: imageData.requestId
              });
            }
          }
        }
      });
    }

    return messages || [];
  } catch (error) {
    console.error('[Background] 獲取對話消息時發生錯誤:', error);
    return [];
  }
}

// 記錄所有圖片路徑到全局數據庫（獨立存儲）
async function recordImageToDatabase(imageData) {
  try {
    const userProfile = imageData.userProfile || 'default';
    const storageKey = `all_images_record_${userProfile}`; // 全局圖片記錄
    
    const result = await chrome.storage.local.get([storageKey]);
    const allImages = result[storageKey] || [];
    
    // 【修正】移除 Base64 數據，只保存 URL，避免 Quota 報錯
    const imageDataWithoutBase64 = {
      ...imageData,
      base64: null // 暫時停用 Base64 儲存
    };
    
    // 檢查是否已存在（根據 id 去重）
    const existingIndex = allImages.findIndex(img => img.id === imageData.id);
    
    if (existingIndex >= 0) {
      // 更新現有記錄
      allImages[existingIndex] = {
        ...allImages[existingIndex],
        ...imageDataWithoutBase64,
        lastUpdated: Date.now()
      };
      console.log('[Background] [圖片記錄] ✓ 更新圖片記錄:', imageData.id.substring(0, 30));
    } else {
      // 添加新記錄
      allImages.push({
        ...imageDataWithoutBase64,
        recordedAt: Date.now(),
        lastUpdated: Date.now()
      });
      console.log('[Background] [圖片記錄] ✓ 新增圖片記錄:', imageData.id.substring(0, 30));
    }
    
    // 按時間戳排序（最新的在前）
    allImages.sort((a, b) => (b.timestamp || b.recordedAt) - (a.timestamp || a.recordedAt));
    
    // 【清理機制】只保留最近 1000 張圖片記錄，避免存儲空間不足
    if (allImages.length > 1000) {
      const removed = allImages.splice(1000);
      console.log(`[Background] [圖片記錄] 🧹 清理舊記錄，移除 ${removed.length} 張圖片記錄`);
    }
    
    // 保存到存儲
    try {
      await chrome.storage.local.set({ [storageKey]: allImages });
      console.log(`[Background] [圖片記錄] ✓ 圖片記錄已保存 (用戶檔案: ${userProfile}, 總計: ${allImages.length}張)`);
    } catch (error) {
      // 【優化修復】檢測到 QuotaExceededError 時，優先清理舊記錄，避免清空所有存儲
      if (error && error.message && (error.message.includes('quota') || error.message.includes('QuotaExceeded'))) {
        console.error('[Background] [圖片記錄] ⚠️ 檢測到 QuotaExceededError，嘗試清理舊記錄...');
        try {
          // 優先清理當前用戶的舊圖片記錄
          await cleanupOldImageRecords(userProfile);
          
          // 嘗試減少記錄數量後重新保存
          const reducedImages = allImages.slice(0, 500); // 只保留最近 500 張
          await chrome.storage.local.set({ [storageKey]: reducedImages });
          console.log(`[Background] [圖片記錄] ✓ 清理後已保存 (用戶檔案: ${userProfile}, 總計: ${reducedImages.length}張)`);
        } catch (cleanupError) {
          console.error('[Background] [圖片記錄] 清理後保存仍然失敗:', cleanupError);
          // 如果清理後仍然失敗，跳過本次保存，避免再次觸發錯誤
          console.log('[Background] [圖片記錄] ⚠️ 跳過本次保存，避免再次觸發 Quota 錯誤');
          return false;
        }
      } else {
        throw error; // 其他錯誤繼續拋出
      }
    }
    
    // 取消自動下載圖片：僅保留記錄（右側顯示圖片仍可用）
    if (autoDownloadEnabledCache && (imageData.url || imageData.base64)) {
      await autoDownloadImage(imageData);
    }
    
    return true;
  } catch (error) {
    console.error('[Background] [圖片記錄] 保存圖片記錄時發生錯誤:', error);
    // 如果是 Quota 錯誤，嘗試清理舊記錄
    if (error.message && (error.message.includes('quota') || error.message.includes('QuotaExceeded'))) {
      console.log('[Background] [圖片記錄] ⚠️ 存儲空間不足，嘗試清理舊記錄...');
      await cleanupOldImageRecords(userProfile);
    }
    return false;
  }
}

// 自動下載圖片（使用 chrome.downloads API）
async function autoDownloadImage(imageData) {
  try {
    if (imageData.downloaded) {
      console.log('[Background] [自動下載] 圖片已下載過，跳過:', imageData.id?.substring(0, 30));
      return;
    }

    // 優先使用 URL（更可靠）
    let downloadUrl = null;
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
    let filename = `gemini-image-${imageData.id ? imageData.id.substring(0, 20) : timestamp}-${Date.now()}`;

    if (imageData.url && !imageData.url.startsWith('data:')) {
      // 使用 URL 下載
      downloadUrl = imageData.url;
      // 根據 URL 推斷文件擴展名
      if (imageData.url.includes('.jpg') || imageData.url.includes('jpeg')) {
        filename += '.jpg';
      } else if (imageData.url.includes('.webp')) {
        filename += '.webp';
      } else if (imageData.url.includes('.png')) {
        filename += '.png';
      } else {
        filename += '.png'; // 默認 PNG
      }
      console.log('[Background] [自動下載] 使用 URL 下載:', imageData.url.substring(0, 100));
    } else if (imageData.base64) {
      // 使用 Base64 (data URL) 下載
      // chrome.downloads API 可以直接使用 data URL
      downloadUrl = imageData.base64; // Base64 已經是 data URL 格式
      filename += '.png';
      console.log('[Background] [自動下載] 使用 Base64 (data URL) 下載');
    } else if (imageData.url && imageData.url.startsWith('data:')) {
      // 如果 URL 是 data URL
      downloadUrl = imageData.url;
      filename += '.png';
      console.log('[Background] [自動下載] 使用 data URL 下載');
    }

    if (!downloadUrl) {
      console.error('[Background] [自動下載] 沒有可下載的圖片 URL');
      return;
    }

    // 使用 chrome.downloads API 下載
    try {
      // 檢查是否有下載權限
      if (!chrome.downloads) {
        console.warn('[Background] [自動下載] chrome.downloads API 不可用，請檢查 manifest.json 權限');
        return;
      }

      const downloadId = await chrome.downloads.download({
        url: downloadUrl,
        filename: buildDownloadPath('images-record', sanitizeFilename(imageData.userProfile || 'default'), filename),
        saveAs: false, // 自動保存到默認下載目錄
        conflictAction: 'uniquify' // 如果文件名衝突，自動重命名
      });
      
      console.log('[Background] [自動下載] ✓ 圖片已開始下載 (ID:', downloadId, '):', filename);
      
      // 監聽下載完成事件
      const downloadListener = (delta) => {
        if (delta.id === downloadId) {
          if (delta.state && delta.state.current === 'complete') {
            console.log('[Background] [自動下載] ✓ 圖片下載完成:', filename);
            
            // 更新記錄標記為已下載
            updateImageDownloadStatus(imageData.id, imageData.userProfile, true, filename).then(() => {
              chrome.downloads.onChanged.removeListener(downloadListener);
            });
          } else if (delta.state && delta.state.current === 'interrupted') {
            console.error('[Background] [自動下載] ✗ 圖片下載中斷:', delta.error?.current || '未知錯誤');
            updateImageDownloadStatus(imageData.id, imageData.userProfile, false, null, delta.error?.current || '下載中斷').then(() => {
              chrome.downloads.onChanged.removeListener(downloadListener);
            });
          }
        }
      };
      
      chrome.downloads.onChanged.addListener(downloadListener);
      
    } catch (error) {
      console.error('[Background] [自動下載] 下載失敗:', error);
      // 記錄下載失敗
      await updateImageDownloadStatus(imageData.id, imageData.userProfile, false, null, error.message);
    }
  } catch (error) {
    console.error('[Background] [自動下載] 自動下載過程發生錯誤:', error);
  }
}

// 監聽存儲變化（當對話被保存時）
chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'local' && changes.conversations) {
    console.log('對話列表已更新');
  }
});

// ========== 新增功能：圖片攔截和專案管理 ==========

// 處理攔截到的圖片
async function handleImageIntercepted(imageData, tabId) {
  try {
    const result = await chrome.storage.local.get(['interceptedImages']);
    const images = result.interceptedImages || [];
    
    // 檢查是否已存在（去重）
    const exists = images.some(img => img.url === imageData.url);
    if (exists) {
      console.log('[Background] [圖片攔截] ⏭️  圖片已存在，跳過:', imageData.url.substring(0, 50));
      return;
    }
    
    // 添加時間戳和標籤頁 ID
    imageData.interceptedAt = imageData.interceptedAt || Date.now();
    imageData.tabId = tabId;
    images.push(imageData);
    
    // 保存到存儲
    await chrome.storage.local.set({ interceptedImages: images });
    console.log('[Background] [圖片攔截] ✅ 圖片已保存:', imageData.url.substring(0, 50));
    
    // 通知所有標籤頁更新（如果有 popup 打開）
    chrome.runtime.sendMessage({
      action: 'NEW_IMAGE_ADDED',
      data: imageData
    }).catch(() => {
      // 如果沒有監聽器，忽略錯誤
    });

    // 記錄圖片到遠端 API 會話（如果有活躍的遠端會話）
    recordImageToRemoteSession(imageData);
  } catch (error) {
    console.error('[Background] [圖片攔截] 處理圖片時發生錯誤:', error);
  }
}

// ========== 下載日誌記錄功能 ==========

// 格式化文件大小
function formatFileSize(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

// 記錄下載嘗試（詳細日誌）
async function logDownloadAttempt(logData) {
  try {
    const logEntry = {
      operation: 'DOWNLOAD_IMAGE',
      timestamp: logData.timestamp || Date.now(),
      userProfile: 'default', // 可以從 logData 中獲取
      
      // 檔案屬性
      fileInfo: {
        url: logData.url || '',
        urlKey: logData.urlKey || '',
        urlLength: logData.urlLength || 0,
        fileSize: logData.fileSize || 0,
        fileSizeFormatted: logData.fileSizeFormatted || 'unknown',
        mimeType: logData.mimeType || 'image/png',
        imageType: logData.imageType || 'highres' // 'thumbnail' 或 'highres'
      },
      
      // 來源信息
      source: {
        function: logData.source || 'unknown',
        chatId: logData.chatId || null,
        conversationTitle: logData.conversationTitle || null,
        isManual: logData.isManual || false
      },
      
      // 命名原則
      naming: {
        rule: logData.namingRule || 'unknown',
        originalFilename: logData.originalFilename || null,
        finalFilename: logData.downloadFilename || null,
        downloadPath: logData.downloadPath || null,
        details: logData.namingDetails || {}
      },
      
      // 下載狀態
      download: {
        downloadId: logData.downloadId || null,
        status: logData.status || 'unknown', // 'queued', 'completed', 'failed', 'interrupted'
        error: logData.error || null
      },
      
      // 識別信息
      identifiers: {
        requestId: logData.requestId || null,
        originalRequestId: logData.originalRequestId || null,
        stableRequestId: logData.requestId || null
      }
    };
    
    // 保存到操作日誌
    await saveOperationLog(logEntry);
    
    // 同時輸出詳細的控制台日誌
    console.log('[Background] [下載日誌] ========== 下載記錄 ==========');
    console.log('[Background] [下載日誌] 來源函數:', logData.source || 'unknown');
    console.log('[Background] [下載日誌] URL 長度:', logData.urlLength || 0);
    console.log('[Background] [下載日誌] 檔案大小:', logData.fileSizeFormatted || 'unknown');
    console.log('[Background] [下載日誌] 命名規則:', logData.namingRule || 'unknown');
    console.log('[Background] [下載日誌] 原始檔名:', logData.originalFilename || 'N/A');
    console.log('[Background] [下載日誌] 最終檔名:', logData.downloadFilename || 'N/A');
    console.log('[Background] [下載日誌] 下載路徑:', logData.downloadPath || 'N/A');
    console.log('[Background] [下載日誌] 下載狀態:', logData.status || 'unknown');
    console.log('[Background] [下載日誌] RequestId:', logData.requestId || 'N/A');
    console.log('[Background] [下載日誌] ==============================');
    
  } catch (error) {
    console.error('[Background] [下載日誌] 記錄失敗:', error);
  }
}

// ========== 操作日誌記錄功能 ==========

// 保存操作日誌
async function saveOperationLog(logEntry) {
  try {
    const userProfile = logEntry.userProfile || 'default';
    const storageKey = `operation_logs_${userProfile}`;
    
    const result = await chrome.storage.local.get([storageKey]);
    const logs = result[storageKey] || [];
    
    // 【清理機制】減少保留數量，只保留最近 1000 條日誌，避免存儲空間不足
    logs.push(logEntry);
    if (logs.length > 1000) {
      const removed = logs.splice(0, logs.length - 1000); // 移除最舊的日誌
      console.log(`[Background] [操作日誌] 🧹 清理舊日誌，移除 ${removed.length} 條`);
    }
    
    // 保存到存儲
    try {
      await chrome.storage.local.set({ [storageKey]: logs });
      console.log('[Background] [操作日誌] ✓ 已記錄:', logEntry.operation, '(總計:', logs.length, '條)');
      
      // 驗證保存是否成功
      const verifyResult = await chrome.storage.local.get([storageKey]);
      if (verifyResult[storageKey] && verifyResult[storageKey].length === logs.length) {
        console.log('[Background] [操作日誌] ✓ 驗證成功，日誌已正確保存');
      } else {
        console.warn('[Background] [操作日誌] ⚠️ 驗證失敗，日誌可能未正確保存');
      }
    } catch (error) {
      // 【緊急修復 4】檢測到 QuotaExceededError 時，自動執行 clear()
      if (error.message && (error.message.includes('quota') || error.message.includes('QuotaExceeded'))) {
        console.error('[Background] [操作日誌] ⚠️ 檢測到 QuotaExceededError，清空所有存儲...');
        try {
          await chrome.storage.local.clear();
          console.log('[Background] [操作日誌] ✓ 已清空所有存儲，解決 QuotaExceededError');
          // 清空後不再保存，避免再次觸發錯誤
          console.log('[Background] [操作日誌] ⚠️ 跳過本次保存，避免再次觸發 Quota 錯誤');
          return;
        } catch (clearError) {
          console.error('[Background] [操作日誌] 清空存儲時發生錯誤:', clearError);
        }
      } else {
        throw error; // 其他錯誤繼續拋出
      }
    }
  } catch (error) {
    console.error('[Background] [操作日誌] 保存失敗:', error);
    // 如果是 Quota 錯誤，嘗試清理舊日誌
    if (error && error.message && (error.message.includes('quota') || error.message.includes('QuotaExceeded'))) {
      console.log('[Background] [操作日誌] ⚠️ 存儲空間不足，嘗試清理舊日誌...');
      await cleanupOldOperationLogs(logEntry.userProfile || 'default');
      // 清理後重試一次
      try {
        const userProfile = logEntry.userProfile || 'default';
        const storageKey = `operation_logs_${userProfile}`;
        const result = await chrome.storage.local.get([storageKey]);
        const logs = result[storageKey] || [];
        logs.push(logEntry);
        // 只保留最近 500 條
        if (logs.length > 500) {
          logs.splice(0, logs.length - 500);
        }
        await chrome.storage.local.set({ [storageKey]: logs });
        console.log('[Background] [操作日誌] ✓ 清理後重新保存成功');
      } catch (retryError) {
        console.error('[Background] [操作日誌] 清理後重新保存失敗:', retryError);
      }
    }
    // 不再拋出錯誤，避免影響其他功能
  }
}

// 獲取操作日誌
async function getOperationLogs(userProfile = 'default') {
  try {
    const storageKey = `operation_logs_${userProfile}`;
    const result = await chrome.storage.local.get([storageKey]);
    return result[storageKey] || [];
  } catch (error) {
    console.error('[Background] [操作日誌] 獲取失敗:', error);
    return [];
  }
}

// 導出點擊監聽記錄到文件（JSON 格式）
async function exportClickMonitorRecords(userProfile = 'default') {
  try {
    const storageKey = `click_monitor_records_${userProfile}`;
    const result = await chrome.storage.local.get([storageKey]);
    const records = result[storageKey] || [];
    
    if (records.length === 0) {
      return { status: 'error', error: '沒有記錄可導出' };
    }
    
    // 生成 JSON 格式的記錄文件
    const exportData = {
      version: '1.0',
      exportDate: new Date().toISOString(),
      exportTimestamp: Date.now(),
      userProfile: userProfile,
      totalRecords: records.length,
      records: records.map(record => ({
        id: record.id,
        timestamp: record.timestamp,
        timestampDisplay: record.timestampDisplay,
        eventType: record.eventType,
        data: record.data,
        chatId: record.chatId,
        url: record.url,
        pageTitle: record.pageTitle || null,
        userAgent: record.userAgent || null,
        viewport: record.viewport || null
      }))
    };
    
    // 轉換為 JSON 字符串
    const jsonContent = JSON.stringify(exportData, null, 2);
    
    // 轉換為 base64 編碼的 data URL
    const base64Content = btoa(unescape(encodeURIComponent(jsonContent)));
    const dataUrl = `data:application/json;charset=utf-8;base64,${base64Content}`;
    
    // 生成文件名
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
    const filename = `gemini_click_monitor_${userProfile}_${timestamp}.json`;
    
    // 使用 chrome.downloads API 下載文件
    const downloadId = await new Promise((resolve, reject) => {
      chrome.downloads.download({
        url: dataUrl,
        filename: filename,
        saveAs: false,
        conflictAction: 'uniquify'
      }, (id) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(id);
        }
      });
    });
    
    console.log('[Background] [點擊監聽記錄] ✓ 已導出記錄文件:', filename, '共', records.length, '條記錄');
    
    return { 
      status: 'ok', 
      filename: filename,
      recordCount: records.length,
      downloadId: downloadId
    };
  } catch (error) {
    console.error('[Background] [點擊監聽記錄] 導出失敗:', error);
    return { status: 'error', error: error.message };
  }
}

// 導出操作日誌到文件（TXT 格式）
async function exportOperationLogs(userProfile = 'default') {
  try {
    const logs = await getOperationLogs(userProfile);
    
    if (logs.length === 0) {
      return { status: 'ok', message: '沒有日誌可導出' };
    }
    
    // 生成 TXT 格式的日誌內容
    let txtContent = '';
    txtContent += '='.repeat(80) + '\n';
    txtContent += `Gemini 對話分類助手 - 操作日誌\n`;
    txtContent += '='.repeat(80) + '\n';
    txtContent += `導出時間: ${new Date().toLocaleString('zh-TW')}\n`;
    txtContent += `用戶檔案: ${userProfile}\n`;
    txtContent += `總日誌數: ${logs.length} 條\n`;
    txtContent += '='.repeat(80) + '\n\n';
    
    // 按時間戳排序（最新的在前）
    const sortedLogs = [...logs].sort((a, b) => b.timestamp - a.timestamp);
    
    sortedLogs.forEach((log, index) => {
      txtContent += `\n[日誌 ${index + 1}/${logs.length}]\n`;
      txtContent += '-'.repeat(80) + '\n';
      txtContent += `時間: ${log.timestampDisplay || new Date(log.timestamp).toLocaleString('zh-TW')}\n`;
      txtContent += `操作類型: ${log.operation}\n`;
      txtContent += `對話ID: ${log.chatId || '無'}\n`;
      txtContent += `URL: ${log.url || '無'}\n`;
      
      // 格式化數據
      if (log.data && Object.keys(log.data).length > 0) {
        txtContent += `\n操作數據:\n`;
        for (const [key, value] of Object.entries(log.data)) {
          if (value !== null && value !== undefined) {
            if (typeof value === 'object') {
              txtContent += `  ${key}: ${JSON.stringify(value, null, 2).split('\n').join('\n  ')}\n`;
            } else {
              // 截斷過長的字符串
              let displayValue = String(value);
              if (displayValue.length > 200) {
                displayValue = displayValue.substring(0, 200) + '... (已截斷)';
              }
              txtContent += `  ${key}: ${displayValue}\n`;
            }
          }
        }
      }
      
      txtContent += '\n';
    });
    
    txtContent += '='.repeat(80) + '\n';
    txtContent += `日誌結束 (共 ${logs.length} 條)\n`;
    txtContent += '='.repeat(80) + '\n';
    
    // 【Service Worker 兼容】在 Service Worker 中，URL.createObjectURL 不可用
    // 改用 data URL 方式下載
    // 將文本內容轉換為 base64 編碼的 data URL
    const base64Content = btoa(unescape(encodeURIComponent(txtContent)));
    const dataUrl = `data:text/plain;charset=utf-8;base64,${base64Content}`;
    
    // 生成文件名（TXT 格式）
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
    const filename = buildDownloadPath('logs', `gemini_operation_logs_${userProfile}_${timestamp}.txt`);
    
    // 使用 chrome.downloads API 下載文件
    const downloadId = await chrome.downloads.download({
      url: dataUrl,
      filename: filename,
      saveAs: false,
      conflictAction: 'uniquify'
    });
    
    console.log('[Background] [操作日誌] ✓ 已導出日誌文件 (TXT):', filename, '共', logs.length, '條日誌');
    
    return { 
      status: 'ok', 
      filename: filename,
      logCount: logs.length,
      downloadId: downloadId
    };
  } catch (error) {
    console.error('[Background] [操作日誌] 導出失敗:', error);
    return { status: 'error', error: error.message };
  }
}

// ========== 清理機制 ==========

// 清理舊的操作日誌
async function cleanupOldOperationLogs(userProfile = 'default') {
  try {
    const storageKey = `operation_logs_${userProfile}`;
    const result = await chrome.storage.local.get([storageKey]);
    const logs = result[storageKey] || [];
    
    if (logs.length > 500) {
      const removed = logs.splice(0, logs.length - 500);
      await chrome.storage.local.set({ [storageKey]: logs });
      console.log(`[Background] [清理機制] 🧹 清理操作日誌，移除 ${removed.length} 條舊日誌，保留 ${logs.length} 條`);
    }
  } catch (error) {
    console.error('[Background] [清理機制] 清理操作日誌失敗:', error);
  }
}

// 清理舊的圖片記錄
async function cleanupOldImageRecords(userProfile = 'default') {
  try {
    const storageKey = `all_images_record_${userProfile}`;
    const result = await chrome.storage.local.get([storageKey]);
    const allImages = result[storageKey] || [];
    
    if (allImages.length > 500) {
      // 移除所有 Base64 數據（如果還有）
      allImages.forEach(img => {
        if (img.base64) {
          img.base64 = null;
        }
      });
      
      // 只保留最近 500 張
      const removed = allImages.splice(500);
      await chrome.storage.local.set({ [storageKey]: allImages });
      console.log(`[Background] [清理機制] 🧹 清理圖片記錄，移除 ${removed.length} 張舊記錄，保留 ${allImages.length} 張`);
    }
  } catch (error) {
    console.error('[Background] [清理機制] 清理圖片記錄失敗:', error);
  }
}

// 定期清理機制（每小時執行一次）
function startPeriodicCleanup() {
  // 立即執行一次清理
  cleanupOldOperationLogs('default');
  cleanupOldImageRecords('default');
  
  // 每小時執行一次清理
  setInterval(() => {
    console.log('[Background] [清理機制] 🔄 執行定期清理...');
    cleanupOldOperationLogs('default');
    cleanupOldImageRecords('default');
  }, 60 * 60 * 1000); // 1 小時
}

// 在啟動時開始定期清理
startPeriodicCleanup();

// ========== 遠端 API 功能 ==========

// 記錄圖片到遠端會話
function recordImageToRemoteSession(imageData) {
  // 為所有活躍的遠端會話添加圖片
  for (const [sessionId, session] of remoteSessions.entries()) {
    // 檢查是否已存在（去重）
    const exists = session.images.some(img => img.url === imageData.url);
    if (!exists) {
      session.images.push({
        url: imageData.url,
        base64: imageData.base64 || null,
        interceptedAt: imageData.interceptedAt || Date.now(),
        metadata: {
          messageId: imageData.messageId,
          chatId: imageData.chatId,
          alt: imageData.alt || '生成的圖片'
        }
      });
      console.log('[Background] [遠端API] ✅ 圖片已記錄到會話:', sessionId);
    }
  }
}

// 記錄消息到遠端會話
function recordMessagesToRemoteSession(messages) {
  // 為所有活躍的遠端會話添加助手回復
  for (const [sessionId, session] of remoteSessions.entries()) {
    // 只添加助手回復（role === 'model' 或 'assistant'）
    const assistantMessages = messages.filter(msg => 
      msg.role === 'model' || msg.role === 'assistant'
    );
    
    assistantMessages.forEach(msg => {
      // 檢查是否已存在（根據文本內容去重）
      const exists = session.messages.some(m => 
        m.role === 'assistant' && m.text === msg.text
      );
      
      if (!exists) {
        session.messages.push({
          role: 'assistant',
          text: msg.text || '',
          timestamp: msg.timestamp || Date.now()
        });
        console.log('[Background] [遠端API] ✅ 助手回復已記錄到會話:', sessionId);
      }
    });
  }
}

// 監聽來自外部應用的消息（遠端 API）
chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  console.log('[Background] [遠端API] 收到外部消息:', message);
  
  try {
    // Admin Web (localhost) actions
    if (typeof message?.action === 'string' && message.action.startsWith('ADMIN_')) {
      const senderUrl = sender?.url || '';
      const isAllowed =
        senderUrl.startsWith('http://localhost') ||
        senderUrl.startsWith('http://127.0.0.1');
      if (!isAllowed) {
        sendResponse({ success: false, error: 'Forbidden origin' });
        return false;
      }
      handleAdminExternalMessage(message, sendResponse);
      return true;
    }

    if (message.action === 'sendMessage') {
      // 接收對話輸入，發送到 Gemini
      handleRemoteSendMessage(message, sendResponse);
      return true; // 異步響應
    } else if (message.action === 'getResult') {
      // 獲取對話結果（包括圖片）
      handleRemoteGetResult(message, sendResponse);
      return true;
    } else if (message.action === 'createSession') {
      // 創建新的遠端會話
      handleRemoteCreateSession(message, sendResponse);
      return true;
    } else if (message.action === 'closeSession') {
      // 關閉遠端會話
      handleRemoteCloseSession(message, sendResponse);
      return true;
    } else if (message.action === 'listTabs') {
      // 列出所有支援站點的分頁
      handleRemoteListTabs(message, sendResponse);
      return true;
    } else {
      sendResponse({ success: false, error: '未知的操作類型' });
      return false;
    }
  } catch (error) {
    console.error('[Background] [遠端API] 處理外部消息時發生錯誤:', error);
    sendResponse({ success: false, error: error.message });
    return false;
  }
});

function parseUserProfileFromUrl(url) {
  try {
    if (!url) return null;
    const uMatch = url.match(/\/u\/(\d+)\//);
    if (uMatch && uMatch[1] !== undefined) return `u${uMatch[1]}`;
    const aMatch = url.match(/[?&]authuser=(\d+)/);
    if (aMatch && aMatch[1] !== undefined) return `u${aMatch[1]}`;
    return null;
  } catch {
    return null;
  }
}

function parseChatIdFromUrl(url) {
  try {
    if (!url) return null;
    // Gemini: /app/{chatId}
    const gemini = url.match(/\/app\/([^/?#]+)/);
    if (gemini && gemini[1]) return gemini[1];
    // Nebula: /chat/channel/{threadId} (must check before Claude)
    const nebula = url.match(/\/chat\/channel\/([^/?#]+)/);
    if (nebula && nebula[1]) return nebula[1];
    // Claude: /chat/{uuid}
    const claude = url.match(/\/chat\/([^/?#]+)/);
    if (claude && claude[1]) return claude[1];
    return null;
  } catch {
    return null;
  }
}

function getAuthIndexFromProfile(userProfile) {
  const m = String(userProfile || '').match(/^u(\d+)$/);
  if (m && m[1] !== undefined) return Number(m[1]);
  return null;
}

async function pingGeminiTab(tabId) {
  return await new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, { action: 'ping' }, (resp) => {
        if (chrome.runtime.lastError) {
          resolve(null);
          return;
        }
        resolve(resp || null);
      });
    } catch {
      resolve(null);
    }
  });
}

async function collectActivePages() {
  let tabs = await findAllSupportedTabs();
  // Fallback: also scan all tabs by hostname in case URL pattern matching missed some
  try {
    const allTabs = await chrome.tabs.query({});
    const knownIds = new Set(tabs.map(t => t.id));
    for (const t of allTabs) {
      if (knownIds.has(t.id)) continue;
      const site = getSiteFromUrl(t.url);
      if (site) {
        tabs.push({ ...t, site });
      }
    }
  } catch { /* ignore */ }
  const pages = [];
  for (const t of tabs || []) {
    const url = t.url || '';
    const site = t.site || getSiteFromUrl(url) || 'unknown';
    let ping = null;
    try {
      ping = await pingGeminiTab(t.id);
    } catch { /* tab not ready */ }
    let title = ping?.title || null;
    // If content script didn't return a title, try extracting from sidebar via direct execution
    if (!title && (ping?.chatId || parseChatIdFromUrl(url))) {
      try {
        const chatId = ping?.chatId || parseChatIdFromUrl(url);
        const titleResults = await chrome.scripting.executeScript({
          target: { tabId: t.id },
          func: (cid) => {
            const link = document.querySelector(`a[href*="/app/${cid}"]`);
            if (!link) return null;
            const clone = link.cloneNode(true);
            for (let i = clone.children.length - 1; i >= 0; i--) clone.children[i].remove();
            const text = (clone.textContent || '').trim();
            return text.length >= 2 ? text : null;
          },
          args: [chatId]
        });
        title = titleResults?.[0]?.result || null;
      } catch { /* ignore */ }
    }
    pages.push({
      tab_id: t.id,
      url,
      site,
      chat_id: ping?.chatId || parseChatIdFromUrl(url) || null,
      title: title || t.title || null,
      user_profile: ping?.userProfile || parseUserProfileFromUrl(url) || 'default',
      monitoring: ping?.monitoring || false
    });
  }
  return pages;
}

async function findGeminiTabForProfile(userProfile, siteName) {
  return findTabForSite(siteName || 'gemini', userProfile);
}

async function findGeminiTabForProfileAndChat(userProfile, chatId, siteName) {
  return findTabForSiteAndChat(siteName || 'gemini', userProfile, chatId);
}

async function waitForTabComplete(tabId, timeoutMs = 30000) {
  const start = Date.now();
  return await new Promise((resolve, reject) => {
    const onUpdated = (updatedTabId, info) => {
      if (updatedTabId !== tabId) return;
      if (info.status === 'complete') {
        cleanup();
        resolve(true);
      }
    };
    const timer = setInterval(() => {
      if (Date.now() - start > timeoutMs) {
        cleanup();
        reject(new Error('Tab load timeout'));
      }
    }, 500);
    function cleanup() {
      clearInterval(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

async function buildChatUrl(userProfile, chatId) {
  // Prefer DB stored URL if exists
  try {
    if (self.GeminiLocalDB?.getConversationMeta) {
      const meta = await self.GeminiLocalDB.getConversationMeta({ userProfile, chatId });
      if (meta?.url && String(meta.url).includes(String(chatId))) return meta.url;
    }
  } catch {
    // ignore
  }

  const idx = getAuthIndexFromProfile(userProfile);
  if (idx !== null) {
    return `https://gemini.google.com/app/${chatId}?authuser=${idx}`;
  }
  return `https://gemini.google.com/app/${chatId}`;
}

async function sendMessageToGeminiChat({ userProfile, chatId, messageText }) {
  const url = await buildChatUrl(userProfile, chatId);

  let tab = await findGeminiTabForProfileAndChat(userProfile, chatId);
  if (!tab) {
    tab = await chrome.tabs.create({ url, active: false });
  } else {
    // navigate if needed
    if (!tab.url || !tab.url.includes(String(chatId))) {
      await chrome.tabs.update(tab.id, { url, active: false });
    }
  }

  // Wait for load
  try {
    await waitForTabComplete(tab.id, 45000);
  } catch {
    // continue anyway; sometimes status isn't reliable
  }

  // Try send without activating; if fails, activate and retry once
  const trySend = () =>
    new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(
        tab.id,
        { action: 'sendMessage', messageText },
        (resp) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          resolve(resp);
        }
      );
    });

  try {
    await trySend();
    return { tabId: tab.id, url };
  } catch {
    await chrome.tabs.update(tab.id, { active: true });
    await new Promise((r) => setTimeout(r, 500));
    await trySend();
    return { tabId: tab.id, url };
  }
}

async function ensureContentScriptReady(tabId, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const resp = await pingGeminiTab(tabId);
    if (resp && resp.status === 'ok') return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function sendMessageWithImageToGeminiChat({ userProfile, chatId, messageText, imageDataUrl, filename, mime }) {
  const url = await buildChatUrl(userProfile, chatId);

  let tab = await findGeminiTabForProfileAndChat(userProfile, chatId);
  if (!tab) {
    tab = await chrome.tabs.create({ url, active: false });
  } else {
    if (!tab.url || !tab.url.includes(String(chatId))) {
      await chrome.tabs.update(tab.id, { url, active: false });
    }
  }

  try {
    await waitForTabComplete(tab.id, 45000);
  } catch {
    // ignore
  }

  await ensureContentScriptReady(tab.id, 15000);

  const trySend = () =>
    new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(
        tab.id,
        { action: 'sendMessageWithImage', messageText, imageDataUrl, filename, mime },
        (resp) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          resolve(resp);
        }
      );
    });

  try {
    await trySend();
    return { tabId: tab.id, url };
  } catch {
    await chrome.tabs.update(tab.id, { active: true });
    await new Promise((r) => setTimeout(r, 600));
    await ensureContentScriptReady(tab.id, 15000);
    await trySend();
    return { tabId: tab.id, url };
  }
}

async function handleAdminExternalMessage(message, sendResponse) {
  try {
    const action = message.action;
    const data = message.data || {};

    if (action === 'ADMIN_GET_DOWNLOAD_BASE_FOLDER') {
      sendResponse({ success: true, downloadBaseFolder: getDownloadBaseFolder() });
      return;
    }

    if (action === 'ADMIN_SET_DOWNLOAD_BASE_FOLDER') {
      const next = sanitizeRelativePath(data.downloadBaseFolder);
      downloadBaseFolderCache = next || DEFAULT_DOWNLOAD_BASE_FOLDER;
      await chrome.storage.local.set({ downloadBaseFolder: downloadBaseFolderCache });
      sendResponse({ success: true, downloadBaseFolder: downloadBaseFolderCache });
      return;
    }

    if (action === 'ADMIN_LIST_PROFILES') {
      const result = await chrome.storage.local.get(['availableProfiles']);
      const fromStorage = Array.isArray(result.availableProfiles) ? result.availableProfiles : [];
      let fromDb = [];
      try {
        if (self.GeminiLocalDB?.listProfiles) fromDb = await self.GeminiLocalDB.listProfiles();
      } catch {
        fromDb = [];
      }
      const profiles = Array.from(new Set(['default', ...fromStorage, ...fromDb])).filter(Boolean);
      sendResponse({ success: true, profiles });
      return;
    }

    if (action === 'ADMIN_LIST_CONVERSATIONS') {
      const userProfile = data.userProfile || 'default';
      if (!self.GeminiLocalDB?.listConversations) {
        sendResponse({ success: false, error: 'DB not ready' });
        return;
      }
      const conversations = await self.GeminiLocalDB.listConversations(userProfile);
      sendResponse({ success: true, conversations: conversations || [] });
      return;
    }

    if (action === 'ADMIN_GET_CONVERSATION_MESSAGES') {
      const userProfile = data.userProfile || 'default';
      const chatId = data.chatId;
      if (!chatId) {
        sendResponse({ success: false, error: 'Missing chatId' });
        return;
      }
      if (!self.GeminiLocalDB?.getConversationMessages) {
        sendResponse({ success: false, error: 'DB not ready' });
        return;
      }
      const messages = await self.GeminiLocalDB.getConversationMessages({ userProfile, chatId });
      sendResponse({ success: true, messages: messages || [] });
      return;
    }

    if (action === 'ADMIN_SEND_MESSAGE_TO_CHAT') {
      const userProfile = data.userProfile || 'default';
      const chatId = data.chatId;
      const messageText = data.messageText || '';
      if (!chatId) {
        sendResponse({ success: false, error: 'Missing chatId' });
        return;
      }
      if (!messageText || !String(messageText).trim()) {
        sendResponse({ success: false, error: 'Empty message' });
        return;
      }
      await sendMessageToGeminiChat({ userProfile, chatId, messageText: String(messageText) });
      sendResponse({ success: true });
      return;
    }

    if (action === 'ADMIN_UPLOAD_BEGIN') {
      const userProfile = data.userProfile || 'default';
      const chatId = data.chatId;
      const filename = data.filename || 'image.png';
      const mime = data.mime || '';
      const prefix = data.prefix || '';
      if (!chatId) {
        sendResponse({ success: false, error: 'Missing chatId' });
        return;
      }
      if (!prefix || typeof prefix !== 'string' || !prefix.startsWith('data:')) {
        sendResponse({ success: false, error: 'Missing/invalid prefix' });
        return;
      }
      const uploadId = `u_${Date.now()}_${Math.random().toString(16).slice(2)}`;
      adminUploadSessions.set(uploadId, {
        userProfile,
        chatId: String(chatId),
        filename,
        mime,
        prefix,
        chunks: [],
        createdAt: Date.now()
      });
      sendResponse({ success: true, uploadId });
      return;
    }

    if (action === 'ADMIN_UPLOAD_CHUNK') {
      const uploadId = data.uploadId;
      const chunk = data.chunk;
      if (!uploadId || !adminUploadSessions.has(uploadId)) {
        sendResponse({ success: false, error: 'Invalid uploadId' });
        return;
      }
      if (typeof chunk !== 'string' || chunk.length === 0) {
        sendResponse({ success: false, error: 'Invalid chunk' });
        return;
      }
      const s = adminUploadSessions.get(uploadId);
      s.chunks.push(chunk);
      sendResponse({ success: true });
      return;
    }

    if (action === 'ADMIN_UPLOAD_ABORT') {
      const uploadId = data.uploadId;
      if (uploadId) adminUploadSessions.delete(uploadId);
      sendResponse({ success: true });
      return;
    }

    if (action === 'ADMIN_UPLOAD_COMMIT') {
      const uploadId = data.uploadId;
      const messageText = data.messageText || '';
      if (!uploadId || !adminUploadSessions.has(uploadId)) {
        sendResponse({ success: false, error: 'Invalid uploadId' });
        return;
      }
      const s = adminUploadSessions.get(uploadId);
      const imageDataUrl = `${s.prefix}${s.chunks.join('')}`;
      adminUploadSessions.delete(uploadId);

      await sendMessageWithImageToGeminiChat({
        userProfile: s.userProfile,
        chatId: s.chatId,
        messageText: String(messageText || ''),
        imageDataUrl,
        filename: s.filename,
        mime: s.mime
      });
      sendResponse({ success: true });
      return;
    }

    if (action === 'ADMIN_LIST_OPEN_TABS') {
      const tabs = await findAllSupportedTabs();
      const out = [];
      for (const t of tabs || []) {
        const url = t.url || '';
        const site = t.site || getSiteFromUrl(url) || 'unknown';
        const derivedUserProfile = parseUserProfileFromUrl(url) || 'default';
        const derivedChatId = parseChatIdFromUrl(url);
        let ping = null;
        try {
          ping = await pingGeminiTab(t.id);
        } catch {
          ping = null;
        }
        out.push({
          tabId: t.id,
          windowId: t.windowId,
          url,
          site,
          derivedUserProfile,
          derivedChatId,
          ping: ping
            ? {
                status: ping.status,
                chatId: ping.chatId || null,
                title: ping.title || null,
                userProfile: ping.userProfile || null
              }
            : null
        });
      }
      sendResponse({ success: true, tabs: out });
      return;
    }

    if (action === 'ADMIN_FOCUS_TAB') {
      const tabId = data.tabId;
      if (!tabId && tabId !== 0) {
        sendResponse({ success: false, error: 'Missing tabId' });
        return;
      }
      const tab = await chrome.tabs.get(tabId);
      await chrome.windows.update(tab.windowId, { focused: true });
      await chrome.tabs.update(tabId, { active: true });
      sendResponse({ success: true });
      return;
    }

    sendResponse({ success: false, error: 'Unknown ADMIN action' });
  } catch (e) {
    sendResponse({ success: false, error: e?.message || String(e) });
  }
}

// 處理遠端發送消息
async function handleRemoteSendMessage(message, sendResponse) {
  try {
    const { messageText, sessionId } = message;
    
    if (!messageText || !messageText.trim()) {
      sendResponse({ success: false, error: '消息內容不能為空' });
      return;
    }

    // 確保會話存在
    if (!sessionId || !remoteSessions.has(sessionId)) {
      sendResponse({ success: false, error: '會話不存在，請先創建會話' });
      return;
    }

    const session = remoteSessions.get(sessionId);
    
    // 記錄用戶消息
    session.messages.push({
      role: 'user',
      text: messageText,
      timestamp: Date.now()
    });

    // 清空該會話的圖片（準備接收新的圖片）
    session.images = [];

    // 從 session 取得站點和分頁
    const siteName = session.site || 'gemini';
    let geminiTab = null;

    // 優先使用 session 綁定的 tabId
    if (session.tabId) {
      geminiTab = await findTabById(session.tabId);
      if (!geminiTab) {
        console.warn('[Background] [遠端API] 綁定的 tabId', session.tabId, '已失效，改用自動查找');
      }
    }

    if (!geminiTab) {
      const tabs = await findAllTabsForSite(siteName);
      if (tabs.length === 0) {
        sendResponse({ success: false, error: `找不到 ${siteName} 標籤頁，請先打開對應頁面` });
        return;
      }
      geminiTab = tabs[0];
    }
    
    // 記錄發送時間，用於後續監聽回復
    const sendTimestamp = Date.now();
    session.lastSendTime = sendTimestamp;
    
    // 發送消息到 content script
    chrome.tabs.sendMessage(geminiTab.id, {
      action: 'sendMessage',
      messageText: messageText
    }, async (response) => {
      if (chrome.runtime.lastError) {
        sendResponse({ success: false, error: '發送消息失敗: ' + chrome.runtime.lastError.message });
        return;
      }

      if (response && response.success) {
        // 啟動監聽回復的定時器（等待 Gemini 回復）
        startMonitoringResponse(sessionId, geminiTab.id, sendTimestamp);
        
        // [P1.3] 回傳結果到 GAPI Server (HTTP POST /v1/messages)
        const conversationId = session.conversationId || `conv_${sessionId}`;
        let serverResult = { success: false, error: 'HTTP client not initialized' };
        
        try {
          if (gapiHttpClient.extensionId) {
            serverResult = await gapiHttpClient.sendMessage(conversationId, messageText);
            // 儲存結果到本地數據庫
            await gapiHttpClient.saveMessageResult(serverResult);
            console.log('[Background] [P1.3] Message sent to GAPI Server:', serverResult);
          } else {
            console.log('[Background] [P1.3] GAPI HTTP client not initialized, skipping server push');
          }
        } catch (serverError) {
          console.error('[Background] [P1.3] Failed to send to GAPI Server:', serverError);
          serverResult = { success: false, error: serverError.message };
        }
        
        sendResponse({ 
          success: true, 
          sessionId: sessionId,
          gapiServerResult: serverResult,
          message: '消息已發送，請稍後調用 getResult 獲取結果（包括回復和圖片）'
        });
      } else {
        sendResponse({ success: false, error: response?.error || '發送消息失敗' });
      }
    });
  } catch (error) {
    console.error('[Background] [遠端API] 處理發送消息時發生錯誤:', error);
    sendResponse({ success: false, error: error.message });
  }
}

// 處理遠端獲取結果
async function handleRemoteGetResult(message, sendResponse) {
  try {
    const { sessionId } = message;
    
    if (!sessionId || !remoteSessions.has(sessionId)) {
      sendResponse({ success: false, error: '會話不存在' });
      return;
    }

    const session = remoteSessions.get(sessionId);
    
    sendResponse({
      success: true,
      sessionId: sessionId,
      messages: session.messages,
      images: session.images,
      messageCount: session.messages.length,
      imageCount: session.images.length
    });
  } catch (error) {
    console.error('[Background] [遠端API] 處理獲取結果時發生錯誤:', error);
    sendResponse({ success: false, error: error.message });
  }
}

// 處理遠端創建會話
function handleRemoteCreateSession(message, sendResponse) {
  try {
    const sessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const site = message.site || 'gemini';
    const tabId = message.tabId || null;

    remoteSessions.set(sessionId, {
      messages: [],
      images: [],
      site: site,
      tabId: tabId,
      createdAt: Date.now()
    });

    console.log('[Background] [遠端API] 建立會話:', sessionId, '站點:', site, 'tabId:', tabId);

    // 定期清理過期會話（24小時）
    setTimeout(() => {
      const expiredSession = remoteSessions.get(sessionId);
      if (expiredSession) {
        // 清理監聽器（如果存在）
        if (expiredSession.monitorInterval) {
          clearInterval(expiredSession.monitorInterval);
        }
        remoteSessions.delete(sessionId);
        console.log('[Background] [遠端API] 會話已過期，已清理:', sessionId);
      }
    }, 24 * 60 * 60 * 1000);

    sendResponse({
      success: true,
      sessionId: sessionId,
      site: site,
      tabId: tabId
    });
  } catch (error) {
    console.error('[Background] [遠端API] 處理創建會話時發生錯誤:', error);
    sendResponse({ success: false, error: error.message });
  }
}

// 處理遠端關閉會話
function handleRemoteCloseSession(message, sendResponse) {
  try {
    const { sessionId } = message;
    
    if (sessionId && remoteSessions.has(sessionId)) {
      const session = remoteSessions.get(sessionId);
      // 停止監聽回復
      if (session.monitorInterval) {
        clearInterval(session.monitorInterval);
      }
      remoteSessions.delete(sessionId);
      sendResponse({ success: true, message: '會話已關閉' });
    } else {
      sendResponse({ success: false, error: '會話不存在' });
    }
  } catch (error) {
    console.error('[Background] [遠端API] 處理關閉會話時發生錯誤:', error);
    sendResponse({ success: false, error: error.message });
  }
}

// 處理遠端列出分頁
async function handleRemoteListTabs(message, sendResponse) {
  try {
    const tabs = await findAllSupportedTabs();
    const out = [];
    for (const t of tabs) {
      out.push({
        tabId: t.id,
        url: t.url || '',
        title: t.title || '',
        site: t.site || getSiteFromUrl(t.url) || 'unknown'
      });
    }
    sendResponse({ success: true, tabs: out });
  } catch (error) {
    console.error('[Background] [遠端API] 處理列出分頁時發生錯誤:', error);
    sendResponse({ success: false, error: error.message });
  }
}

// 監聽 Gemini 回復（定期檢查新消息）
function startMonitoringResponse(sessionId, tabId, sendTimestamp) {
  if (!remoteSessions.has(sessionId)) {
    return;
  }
  
  const session = remoteSessions.get(sessionId);
  let checkCount = 0;
  const maxChecks = 60; // 最多檢查 60 次（約 30 秒）
  
  // 清除舊的監聽器
  if (session.monitorInterval) {
    clearInterval(session.monitorInterval);
  }
  
  session.monitorInterval = setInterval(async () => {
    // 檢查會話是否仍然存在
    if (!remoteSessions.has(sessionId)) {
      // 會話已被刪除，清理監聽器
      if (session.monitorInterval) {
        clearInterval(session.monitorInterval);
        session.monitorInterval = null;
      }
      return;
    }
    
    checkCount++;
    
    if (checkCount > maxChecks) {
      // 達到最大檢查次數，停止監聽
      if (session.monitorInterval) {
        clearInterval(session.monitorInterval);
        session.monitorInterval = null;
      }
      console.log('[Background] [遠端API] 監聽回復已達到最大檢查次數，停止監聽:', sessionId);
      return;
    }
    
    try {
      // 從 content script 獲取最新消息
      chrome.tabs.sendMessage(tabId, {
        action: 'scrapeMessages'
      }, (response) => {
        // 再次檢查會話是否仍然存在（可能在異步操作期間被刪除）
        if (!remoteSessions.has(sessionId)) {
          return;
        }
        
        if (chrome.runtime.lastError) {
          // 如果標籤頁已關閉或無效，停止監聽
          const errorMsg = chrome.runtime.lastError.message || '';
          if (errorMsg.includes('tab') || errorMsg.includes('closed') || errorMsg.includes('invalid')) {
            const currentSession = remoteSessions.get(sessionId);
            if (currentSession && currentSession.monitorInterval) {
              clearInterval(currentSession.monitorInterval);
              currentSession.monitorInterval = null;
              console.log('[Background] [遠端API] 標籤頁無效，停止監聽:', sessionId);
            }
          }
          return; // 忽略其他錯誤，繼續監聽
        }
        
        if (response && response.success && response.messages) {
          // UI 噪音黑名單 — exact match + prefix match 過濾頁面 UI 元素
          const UI_NOISE_EXACT = new Set([
            'fast', 'quality', 'balanced',
            'write', 'plan', 'research', 'learn',
            'send message', 'upload', 'microphone',
            'new chat', 'gemini'
          ]);
          const UI_NOISE_PREFIX = [
            'meet gemini',
            'welcome to gemini',
            'i can help you with',
          ];

          // 只獲取發送時間之後的新消息（助手回復），並過濾噪音
          const newMessages = response.messages.filter(msg => {
            if (msg.role !== 'model' && msg.role !== 'assistant') return false;
            if (msg.timestamp <= sendTimestamp) return false;
            const text = (msg.text || '').trim();
            if (text.length < 2) return false;
            const lower = text.toLowerCase();
            if (UI_NOISE_EXACT.has(lower)) return false;
            if (UI_NOISE_PREFIX.some(p => lower.startsWith(p))) return false;
            return true;
          });

          if (newMessages.length > 0) {
            // 記錄新消息到會話
            newMessages.forEach(msg => {
              const text = (msg.text || '').trim();
              const exists = session.messages.some(m =>
                m.role === 'assistant' && m.text === text
              );

              if (!exists) {
                session.messages.push({
                  role: 'assistant',
                  text: text,
                  timestamp: msg.timestamp || Date.now()
                });
                console.log('[Background] [遠端API] ✅ 檢測到新回復，已記錄到會話:', sessionId);
              }
            });
            
            // 如果已經有回復，可以停止監聽（可選）
            // clearInterval(session.monitorInterval);
            // session.monitorInterval = null;
          }
        }
      });
    } catch (error) {
      console.error('[Background] [遠端API] 監聽回復時發生錯誤:', error);
      // 如果發生嚴重錯誤，停止監聽
      if (remoteSessions.has(sessionId)) {
        const currentSession = remoteSessions.get(sessionId);
        if (currentSession && currentSession.monitorInterval) {
          clearInterval(currentSession.monitorInterval);
          currentSession.monitorInterval = null;
          console.log('[Background] [遠端API] 發生錯誤，停止監聽:', sessionId);
        }
      }
    }
  }, 500); // 每 500ms 檢查一次
}

// 將圖片添加到專案
async function addImageToProject(data) {
  try {
    const { imageUrl, projectType } = data;
    const result = await chrome.storage.local.get(['projects']);
    const projects = result.projects || {
      eell: { name: 'EELL', images: [] },
      generalProject: { name: '漫畫', images: [] }
    };
    
    if (projects[projectType]) {
      // 檢查是否已存在
      const exists = projects[projectType].images.some(img => img.url === imageUrl);
      if (!exists) {
        projects[projectType].images.push({
          url: imageUrl,
          addedAt: Date.now()
        });
        await chrome.storage.local.set({ projects });
        console.log('[Background] [專案管理] ✅ 圖片已添加到專案:', projectType);
      } else {
        console.log('[Background] [專案管理] ⏭️  圖片已存在於專案:', projectType);
      }
    }
  } catch (error) {
    console.error('[Background] [專案管理] 添加到專案時發生錯誤:', error);
  }
}
