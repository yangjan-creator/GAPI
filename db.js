// IndexedDB local database for Gemini Assistant
// - Stores conversation metadata and messages per userProfile/chatId
// - Designed for MV3 service worker (background.js) usage

(function initGeminiLocalDB() {
  const DB_NAME = 'gemini_assistant_local_db';
  const DB_VERSION = 1;

  const STORE_CONVERSATIONS = 'conversations';
  const STORE_MESSAGES = 'messages';

  /** @type {Promise<IDBDatabase> | null} */
  let dbPromise = null;

  function reqToPromise(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IndexedDB request failed'));
    });
  }

  function txDone(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
      tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
    });
  }

  function getConvKey(userProfile, chatId) {
    const profile = userProfile || 'default';
    const id = String(chatId || '');
    return `${profile}:${id}`;
  }

  function normalizeMessage(msg, fallbackTimestamp) {
    const role = msg?.role || 'unknown';
    const text = msg?.text || '';
    const timestamp = typeof msg?.timestamp === 'number' ? msg.timestamp : fallbackTimestamp;

    // Prefer provided hash; else compute a stable-ish fallback hash
    const rawHash = msg?.hash;
    const hash = rawHash || `${role}_${text.substring(0, 200)}_${text.length}`;

    const normalized = {
      role,
      text,
      timestamp,
      hash,
      id: msg?.id || null,
    };

    if (Array.isArray(msg?.images) && msg.images.length > 0) {
      normalized.images = msg.images;
    }
    if (Array.isArray(msg?.codeBlocks) && msg.codeBlocks.length > 0) {
      normalized.codeBlocks = msg.codeBlocks;
    }

    return normalized;
  }

  function mergeByIdOrUrl(existingArr, incomingArr) {
    const a = Array.isArray(existingArr) ? existingArr : [];
    const b = Array.isArray(incomingArr) ? incomingArr : [];
    if (a.length === 0) return b;
    if (b.length === 0) return a;
    const map = new Map();
    for (const item of a) {
      const key = item?.id || item?.url || JSON.stringify(item);
      map.set(key, item);
    }
    for (const item of b) {
      const key = item?.id || item?.url || JSON.stringify(item);
      const prev = map.get(key);
      map.set(key, prev ? { ...prev, ...item } : item);
    }
    return Array.from(map.values());
  }

  async function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_CONVERSATIONS)) {
          const store = db.createObjectStore(STORE_CONVERSATIONS, { keyPath: 'convKey' });
          store.createIndex('byUserProfile', 'userProfile', { unique: false });
          store.createIndex('byLastUpdated', 'lastUpdated', { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_MESSAGES)) {
          const store = db.createObjectStore(STORE_MESSAGES, { keyPath: 'msgKey' });
          store.createIndex('byConvKey', 'convKey', { unique: false });
          store.createIndex('byUserProfile', 'userProfile', { unique: false });
          store.createIndex('byChatId', 'chatId', { unique: false });
          store.createIndex('byTimestamp', 'timestamp', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('Failed to open IndexedDB'));
    });
    return dbPromise;
  }

  async function upsertConversationMeta({ chatId, userProfile, title, url, lastUpdated }) {
    const db = await openDB();
    const profile = userProfile || 'default';
    const convKey = getConvKey(profile, chatId);
    const ts = typeof lastUpdated === 'number' ? lastUpdated : Date.now();

    const tx = db.transaction([STORE_CONVERSATIONS], 'readwrite');
    const store = tx.objectStore(STORE_CONVERSATIONS);

    const existing = await reqToPromise(store.get(convKey)).catch(() => null);
    const next = {
      convKey,
      chatId: String(chatId),
      userProfile: profile,
      title: title || existing?.title || '未命名對話',
      url: url || existing?.url || `https://gemini.google.com/app/${chatId}`,
      lastUpdated: ts,
      createdAt: existing?.createdAt || ts,
    };

    store.put(next);
    await txDone(tx);
    return next;
  }

  async function addOrMergeMessages({ chatId, userProfile, messages }) {
    const db = await openDB();
    const profile = userProfile || 'default';
    const convKey = getConvKey(profile, chatId);
    const now = Date.now();

    // Ensure meta exists
    await upsertConversationMeta({ chatId, userProfile: profile, lastUpdated: now });

    const tx = db.transaction([STORE_MESSAGES, STORE_CONVERSATIONS], 'readwrite');
    const msgStore = tx.objectStore(STORE_MESSAGES);
    const convStore = tx.objectStore(STORE_CONVERSATIONS);

    const normalizedList = Array.isArray(messages) ? messages.map(m => normalizeMessage(m, now)) : [];

    for (const msg of normalizedList) {
      const msgKey = `${convKey}:${msg.hash}`;
      const existing = await reqToPromise(msgStore.get(msgKey)).catch(() => null);
      const merged = existing
        ? {
            ...existing,
            ...msg,
            // Preserve and merge rich fields if either side has them
            images: mergeByIdOrUrl(existing.images, msg.images),
            codeBlocks: mergeByIdOrUrl(existing.codeBlocks, msg.codeBlocks),
            // Keep the earliest timestamp if both exist
            timestamp: Math.min(existing.timestamp || msg.timestamp || now, msg.timestamp || existing.timestamp || now),
          }
        : {
            msgKey,
            convKey,
            chatId: String(chatId),
            userProfile: profile,
            ...msg,
          };
      msgStore.put(merged);
    }

    // Update conversation meta timestamp
    const conv = await reqToPromise(convStore.get(convKey)).catch(() => null);
    if (conv) {
      conv.lastUpdated = now;
      convStore.put(conv);
    }

    await txDone(tx);
    return { convKey, saved: normalizedList.length };
  }

  async function getConversationMessages({ chatId, userProfile }) {
    const db = await openDB();
    const profile = userProfile || 'default';
    const convKey = getConvKey(profile, chatId);

    const tx = db.transaction([STORE_MESSAGES], 'readonly');
    const store = tx.objectStore(STORE_MESSAGES);
    const index = store.index('byConvKey');
    const range = IDBKeyRange.only(convKey);
    const rows = await reqToPromise(index.getAll(range)).catch(() => []);
    await txDone(tx).catch(() => {});

    const messages = (rows || [])
      .map(r => {
        const { msgKey, convKey: _ck, chatId: _cid, userProfile: _up, ...rest } = r || {};
        return rest;
      })
      .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

    return messages;
  }

  async function listConversations(userProfile) {
    const db = await openDB();
    const profile = userProfile || 'default';
    const tx = db.transaction([STORE_CONVERSATIONS], 'readonly');
    const store = tx.objectStore(STORE_CONVERSATIONS);
    const index = store.index('byUserProfile');
    const range = IDBKeyRange.only(profile);
    const rows = await reqToPromise(index.getAll(range)).catch(() => []);
    await txDone(tx).catch(() => {});
    return (rows || []).sort((a, b) => (b.lastUpdated || 0) - (a.lastUpdated || 0));
  }

  async function getConversationMeta({ chatId, userProfile }) {
    const db = await openDB();
    const profile = userProfile || 'default';
    const convKey = getConvKey(profile, chatId);
    const tx = db.transaction([STORE_CONVERSATIONS], 'readonly');
    const store = tx.objectStore(STORE_CONVERSATIONS);
    const row = await reqToPromise(store.get(convKey)).catch(() => null);
    await txDone(tx).catch(() => {});
    return row;
  }

  async function listProfiles() {
    const db = await openDB();
    const tx = db.transaction([STORE_CONVERSATIONS], 'readonly');
    const store = tx.objectStore(STORE_CONVERSATIONS);
    const profiles = new Set();
    await new Promise((resolve, reject) => {
      const req = store.openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) {
          const v = cursor.value;
          if (v?.userProfile) profiles.add(v.userProfile);
          cursor.continue();
        } else {
          resolve();
        }
      };
      req.onerror = () => reject(req.error || new Error('cursor failed'));
    }).catch(() => {});
    await txDone(tx).catch(() => {});
    return Array.from(profiles.values()).sort();
  }

  // Expose API on globalThis for background.js
  // (MV3 service worker global is `self`)
  self.GeminiLocalDB = {
    openDB,
    upsertConversationMeta,
    addOrMergeMessages,
    getConversationMessages,
    listConversations,
    getConversationMeta,
    listProfiles,
  };
})();

