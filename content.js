// Content Script
// 用於監測 Gemini 網頁的對話狀態和內容

(function() {
  'use strict';

  console.log('[Gemini 分類助手] Content Script 開始載入...');

  // 【解決 Context 失效】加入攔截機制，當偵測到 Extension context invalidated 錯誤時，自動在畫面上方顯示提示
  function showContextInvalidatedWarning() {
    // 檢查是否已經顯示過警告
    if (document.getElementById('gemini-extension-warning')) {
      return;
    }

    const warningDiv = document.createElement('div');
    warningDiv.id = 'gemini-extension-warning';
    warningDiv.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      z-index: 999999;
      background: linear-gradient(135deg, #ff6b6b 0%, #ee5a6f 100%);
      color: white;
      padding: 16px 20px;
      text-align: center;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 16px;
      font-weight: 600;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
      animation: slideDown 0.3s ease-out;
    `;
    warningDiv.innerHTML = `
      <div style="max-width: 1200px; margin: 0 auto;">
        <strong>⚠️ 插件已更新，請重新整理頁面 (F5)</strong>
        <span style="margin-left: 12px; opacity: 0.9; font-size: 14px;">Extension context invalidated - 擴充功能需要重新載入</span>
      </div>
    `;

    // 添加動畫樣式
    if (!document.getElementById('gemini-warning-styles')) {
      const style = document.createElement('style');
      style.id = 'gemini-warning-styles';
      style.textContent = `
        @keyframes slideDown {
          from {
            transform: translateY(-100%);
            opacity: 0;
          }
          to {
            transform: translateY(0);
            opacity: 1;
          }
        }
      `;
      document.head.appendChild(style);
    }

    document.body.insertBefore(warningDiv, document.body.firstChild);

    // 點擊警告可以關閉
    warningDiv.addEventListener('click', () => {
      warningDiv.style.animation = 'slideDown 0.3s ease-out reverse';
      setTimeout(() => warningDiv.remove(), 300);
    });
  }

  // 【解決 Context 失效】包裝所有 chrome.runtime 調用，自動檢測 Context 失效
  function safeRuntimeCall(callback) {
    try {
      // 先檢查 runtime 是否有效
      if (!chrome.runtime || !chrome.runtime.id) {
        showContextInvalidatedWarning();
        return null;
      }
      
      const result = callback();
      
      // 對於同步調用，立即檢查錯誤
      if (chrome.runtime.lastError) {
        const errorMessage = chrome.runtime.lastError.message || '';
        if (errorMessage.includes('Extension context invalidated') || 
            errorMessage.includes('context invalidated') ||
            errorMessage.includes('message port closed')) {
          console.error('[Gemini 分類助手] ⚠️ Extension context invalidated 錯誤偵測到');
          showContextInvalidatedWarning();
          return null;
        }
      }
      return result;
    } catch (error) {
      const errorMessage = error.message || '';
      if (errorMessage.includes('Extension context invalidated') || 
          errorMessage.includes('context invalidated')) {
        console.error('[Gemini 分類助手] ⚠️ Extension context invalidated 錯誤偵測到');
        showContextInvalidatedWarning();
        return null;
      }
      throw error;
    }
  }
  
  // 檢查 runtime 是否有效的輔助函數（用於 sendMessage 回調）
  function checkRuntimeError(error) {
    if (error) {
      const errorMessage = error.message || '';
      if (errorMessage.includes('Extension context invalidated') || 
          errorMessage.includes('context invalidated') ||
          errorMessage.includes('message port closed')) {
        showContextInvalidatedWarning();
        return true;
      }
    }
    return false;
  }

  // ========== 工具函數模組：優化 DOM 查詢和操作 ==========
  
  // DOM 查詢緩存（減少重複查詢）
  const domCache = {
    cache: new Map(),
    ttl: 5000, // 緩存有效期 5 秒
    timestamps: new Map()
  };

  // 帶緩存的 DOM 查詢函數
  function $q(selector, useCache = true) {
    const cacheKey = `query:${selector}`;
    const now = Date.now();
    
    if (useCache && domCache.cache.has(cacheKey)) {
      const cached = domCache.cache.get(cacheKey);
      const timestamp = domCache.timestamps.get(cacheKey) || 0;
      if (now - timestamp < domCache.ttl && document.contains(cached)) {
        return cached;
      }
      // 緩存過期或元素已移除
      domCache.cache.delete(cacheKey);
      domCache.timestamps.delete(cacheKey);
    }
    
    const element = document.querySelector(selector);
    if (element && useCache) {
      domCache.cache.set(cacheKey, element);
      domCache.timestamps.set(cacheKey, now);
    }
    return element;
  }

  // 帶緩存的 DOM 查詢所有函數
  function $qa(selector, useCache = false) {
    // querySelectorAll 通常不需要緩存，因為結果會變化
    return document.querySelectorAll(selector);
  }

  // 清理 DOM 緩存
  function clearDomCache() {
    domCache.cache.clear();
    domCache.timestamps.clear();
  }

  // 定期清理過期緩存
  setInterval(() => {
    const now = Date.now();
    for (const [key, timestamp] of domCache.timestamps.entries()) {
      if (now - timestamp >= domCache.ttl) {
        domCache.cache.delete(key);
        domCache.timestamps.delete(key);
      }
    }
  }, 10000); // 每 10 秒清理一次

  // ========== Storage 操作工具函數（帶緩存優化）==========
  
  // Storage 緩存管理器
  const storageCache = {
    cache: new Map(),
    timestamps: new Map(),
    ttl: 30000, // 緩存有效期 30 秒
    pendingWrites: new Map(), // 待寫入的數據
    writeTimer: null,
    writeDelay: 1000 // 批量寫入延遲 1 秒
  };

  // 統一的 Storage 讀取函數（帶緩存）
  async function getStorage(key, defaultValue = null, useCache = true) {
    try {
      if (!isRuntimeValid()) {
        // 靜默處理，不輸出警告（避免重複日誌）
        return defaultValue;
      }

      // 檢查緩存
      if (useCache && storageCache.cache.has(key)) {
        const cached = storageCache.cache.get(key);
        const timestamp = storageCache.timestamps.get(key) || 0;
        if (Date.now() - timestamp < storageCache.ttl) {
          return cached;
        }
        // 緩存過期
        storageCache.cache.delete(key);
        storageCache.timestamps.delete(key);
      }

      // 從 storage 讀取
      const result = await chrome.storage.local.get([key]);
      const value = result[key] !== undefined ? result[key] : defaultValue;
      
      // 更新緩存
      if (useCache) {
        storageCache.cache.set(key, value);
        storageCache.timestamps.set(key, Date.now());
      }
      
      return value;
    } catch (error) {
      console.error('[Storage] 讀取失敗:', error);
      return defaultValue;
    }
  }

  // 統一的 Storage 寫入函數（批量優化）
  async function setStorage(key, value, immediate = false) {
    try {
      if (!isRuntimeValid()) {
        // 靜默處理，不輸出警告（避免重複日誌）
        return false;
      }

      // 更新緩存
      storageCache.cache.set(key, value);
      storageCache.timestamps.set(key, Date.now());

      // 添加到待寫入隊列
      storageCache.pendingWrites.set(key, value);

      if (immediate) {
        // 立即寫入
        await flushStorageWrites();
      } else {
        // 延遲批量寫入
        if (storageCache.writeTimer) {
          clearTimeout(storageCache.writeTimer);
        }
        storageCache.writeTimer = setTimeout(() => {
          flushStorageWrites();
        }, storageCache.writeDelay);
      }

      return true;
    } catch (error) {
      console.error('[Storage] 寫入失敗:', error);
      return false;
    }
  }

  // 批量寫入 Storage
  async function flushStorageWrites() {
    if (storageCache.pendingWrites.size === 0) return;

    try {
      const writes = Object.fromEntries(storageCache.pendingWrites);
      await chrome.storage.local.set(writes);
      storageCache.pendingWrites.clear();
      
      if (storageCache.writeTimer) {
        clearTimeout(storageCache.writeTimer);
        storageCache.writeTimer = null;
      }
    } catch (error) {
      console.error('[Storage] 批量寫入失敗:', error);
    }
  }

  // 清理過期緩存
  setInterval(() => {
    const now = Date.now();
    for (const [key, timestamp] of storageCache.timestamps.entries()) {
      if (now - timestamp >= storageCache.ttl) {
        storageCache.cache.delete(key);
        storageCache.timestamps.delete(key);
      }
    }
  }, 10000); // 每 10 秒清理一次

  // 統一的 Storage 批量讀取函數
  async function getStorageMulti(keys, defaultValue = {}, useCache = true) {
    try {
      if (!isRuntimeValid()) {
        // 靜默處理，不輸出警告（避免重複日誌）
        return defaultValue;
      }

      const result = {};
      const uncachedKeys = [];

      // 先從緩存讀取
      for (const key of keys) {
        if (useCache && storageCache.cache.has(key)) {
          const timestamp = storageCache.timestamps.get(key) || 0;
          if (Date.now() - timestamp < storageCache.ttl) {
            result[key] = storageCache.cache.get(key);
            continue;
          }
          storageCache.cache.delete(key);
          storageCache.timestamps.delete(key);
        }
        uncachedKeys.push(key);
      }

      // 讀取未緩存的鍵
      if (uncachedKeys.length > 0) {
        const storageResult = await chrome.storage.local.get(uncachedKeys);
        for (const key of uncachedKeys) {
          const value = storageResult[key] !== undefined ? storageResult[key] : (defaultValue[key] !== undefined ? defaultValue[key] : null);
          result[key] = value;
          if (useCache) {
            storageCache.cache.set(key, value);
            storageCache.timestamps.set(key, Date.now());
          }
        }
      }

      return { ...defaultValue, ...result };
    } catch (error) {
      console.error('[Storage] 批量讀取失敗:', error);
      return defaultValue;
    }
  }

  // 清理 Storage 緩存（切換對話時調用）
  function clearStorageCache() {
    storageCache.cache.clear();
    storageCache.timestamps.clear();
  }

  // 切換對話時的清理函數
  function cleanupOnConversationSwitch() {
    console.log('[Gemini 分類助手] [清理] 切換對話，清理資源...');
    
    // 1. 清理 Storage 緩存
    clearStorageCache();
    
    // 2. 清理內存中的圖片 URL 集合
    processedImageUrls.clear();

    // 2-1. 清理生圖自動觸發狀態
    autoImageHandledMessages.clear();
    lastAutoImageClickAt = 0;
    
    // 3. 強制刷新待寫入的 Storage（確保數據不丟失）
    flushStorageWrites();
    
    // 4. 清理 DOM 緩存
    clearDomCache();
    
    console.log('[Gemini 分類助手] [清理] ✓ 資源清理完成');
  }

  // ========== 事件監聽器管理器 ==========
  
  const eventManager = {
    listeners: new Map(), // element -> Set<{type, handler, options}>
    
    // 添加事件監聽器（自動管理）
    add(element, type, handler, options = false) {
      if (!element) return;
      
      const key = this._getElementKey(element);
      if (!this.listeners.has(key)) {
        this.listeners.set(key, new Set());
      }
      
      const listener = { type, handler, options };
      this.listeners.get(key).add(listener);
      element.addEventListener(type, handler, options);
      
      return () => this.remove(element, type, handler);
    },
    
    // 移除事件監聽器
    remove(element, type, handler) {
      if (!element) return;
      
      const key = this._getElementKey(element);
      const listeners = this.listeners.get(key);
      if (!listeners) return;
      
      for (const listener of listeners) {
        if (listener.type === type && listener.handler === handler) {
          element.removeEventListener(type, handler, listener.options);
          listeners.delete(listener);
          break;
        }
      }
      
      if (listeners.size === 0) {
        this.listeners.delete(key);
      }
    },
    
    // 移除元素的所有事件監聽器
    removeAll(element) {
      if (!element) return;
      
      const key = this._getElementKey(element);
      const listeners = this.listeners.get(key);
      if (!listeners) return;
      
      for (const listener of listeners) {
        element.removeEventListener(listener.type, listener.handler, listener.options);
      }
      
      this.listeners.delete(key);
    },
    
    // 清理所有事件監聽器
    cleanup() {
      for (const [key, listeners] of this.listeners.entries()) {
        const element = this._getElementByKey(key);
        if (element) {
          for (const listener of listeners) {
            element.removeEventListener(listener.type, listener.handler, listener.options);
          }
        }
      }
      this.listeners.clear();
    },
    
    // 獲取元素的唯一鍵
    _getElementKey(element) {
      if (element._eventManagerKey) {
        return element._eventManagerKey;
      }
      const key = `elem_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      element._eventManagerKey = key;
      return key;
    },
    
    // 根據鍵獲取元素（需要遍歷，效率較低，僅用於清理）
    _getElementByKey(key) {
      // 由於無法直接從鍵獲取元素，我們需要遍歷所有元素
      // 這是一個備用方案，實際使用時應該直接傳遞元素
      return null; // 返回 null，清理時需要手動傳遞元素
    }
  };

  // ========== 定時器管理器 ==========
  
  const timerManager = {
    timers: new Map(), // name -> {type: 'timeout'|'interval', id, callback}
    
    // 創建定時器
    setTimeout(name, callback, delay) {
      this.clear(name);
      const id = setTimeout(() => {
        callback();
        this.timers.delete(name);
      }, delay);
      this.timers.set(name, { type: 'timeout', id, callback });
      return id;
    },
    
    // 創建間隔定時器
    setInterval(name, callback, delay) {
      this.clear(name);
      const id = setInterval(callback, delay);
      this.timers.set(name, { type: 'interval', id, callback });
      return id;
    },
    
    // 清除定時器
    clear(name) {
      const timer = this.timers.get(name);
      if (timer) {
        if (timer.type === 'timeout') {
          clearTimeout(timer.id);
        } else {
          clearInterval(timer.id);
        }
        this.timers.delete(name);
      }
    },
    
    // 清除所有定時器
    clearAll() {
      for (const [name, timer] of this.timers.entries()) {
        if (timer.type === 'timeout') {
          clearTimeout(timer.id);
        } else {
          clearInterval(timer.id);
        }
      }
      this.timers.clear();
    },
    
    // 檢查定時器是否存在
    has(name) {
      return this.timers.has(name);
    }
  };

  // ========== MutationObserver 管理器 ==========
  
  const observerManager = {
    observers: new Map(),
    
    // 創建並管理觀察者
    create(name, target, callback, options = {}) {
      // 如果已存在同名觀察者，先停止
      if (this.observers.has(name)) {
        this.disconnect(name);
      }
      
      const observer = new MutationObserver(callback);
      const defaultOptions = {
        childList: true,
        subtree: true,
        ...options
      };
      
      observer.observe(target, defaultOptions);
      this.observers.set(name, { observer, target, options: defaultOptions });
      
      return observer;
    },
    
    // 斷開指定觀察者
    disconnect(name) {
      const item = this.observers.get(name);
      if (item) {
        item.observer.disconnect();
        this.observers.delete(name);
        return true;
      }
      return false;
    },
    
    // 斷開所有觀察者
    disconnectAll() {
      for (const [name, item] of this.observers.entries()) {
        item.observer.disconnect();
      }
      this.observers.clear();
    },
    
    // 檢查觀察者是否存在
    has(name) {
      return this.observers.has(name);
    }
  };

  // ========== Runtime 檢查統一函數 ==========
  
  // 檢查 runtime 是否有效（統一入口）
  // 檢查 runtime 是否有效（統一版本，支持錯誤處理）
  function isRuntimeValid() {
    try {
      // 嘗試獲取 runtime ID，如果擴展上下文無效，這會拋出錯誤
      return chrome.runtime && chrome.runtime.id !== undefined;
    } catch (e) {
      return false;
    }
  }

  // 安全的 sendMessage 包裝（統一使用）
  function safeSendMessage(message, callback) {
    if (!isRuntimeValid()) {
      showContextInvalidatedWarning();
      if (callback) callback({ error: 'Runtime invalid' });
      return;
    }
    
    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          if (checkRuntimeError(chrome.runtime.lastError)) {
            if (callback) callback({ error: chrome.runtime.lastError.message });
            return;
          }
        }
        if (callback) callback(response);
      });
    } catch (error) {
      if (checkRuntimeError(error)) {
        if (callback) callback({ error: error.message });
        return;
      }
      throw error;
    }
  }

  // ========== URL 和元素處理工具函數 ==========
  
  // 檢查 URL 是否為有效的圖片 URL
  function isValidImageUrl(url) {
    if (!url || url.length < 100) return false;
    if (url.includes('/profile/picture/') || url.includes('profile/picture')) return false;
    // 【過濾無效 URL】跳過 blob:null/ 開頭的無效 URL
    if (url.startsWith('blob:null/')) return false;
    return url.includes('googleusercontent.com') || url.startsWith('blob:') || url.startsWith('data:');
  }

  // 提取 URL 的關鍵部分（用於去重）
  function getUrlKey(url, maxLength = 200) {
    if (!url) return '';
    return url.substring(0, maxLength);
  }

  // 檢查元素是否在 DOM 中
  function isElementInDOM(element) {
    return element && document.contains(element);
  }

  // 安全地獲取元素屬性
  function getElementAttr(element, attr, defaultValue = '') {
    if (!element) return defaultValue;
    return element.getAttribute(attr) || element[attr] || defaultValue;
  }

  // 批量查找元素（優化查詢）
  function findElements(selectors, container = document) {
    const results = {};
    for (const [key, selector] of Object.entries(selectors)) {
      try {
        results[key] = container.querySelector(selector);
      } catch (e) {
        results[key] = null;
      }
    }
    return results;
  }

  // 監測狀態
  let isMonitoring = false;
  let currentChatId = null;
  let currentTitle = null;
  let urlCheckInterval = null;
  let lastNotifiedData = null;
  let extractionAttempts = 0;
  const MAX_EXTRACTION_ATTEMPTS = 50; // 最多嘗試 50 次
  let currentUserProfile = null; // 當前用戶檔案標識
  
  // 對話內容監測
  let messageObserver = null; // 監控對話消息的 MutationObserver
  let titleObserver = null; // 監控標題變化的 MutationObserver
  let imageObserver = null; // 監控圖片變化的 MutationObserver（新增）
  let lastMessageCount = 0; // 記錄上次檢測到的消息數量
  let recordedMessages = new Set(); // 已記錄的消息 ID 集合（用於去重）
  let autoImageHandledMessages = new Set(); // 已處理的生圖消息（避免重複觸發）
  let lastAutoImageClickAt = 0;
  const AUTO_IMAGE_CLICK_COOLDOWN = 4000;
  let lastModelResponseCount = 0; // 記錄上次檢測到的模型回復數量
  let lastImageCount = 0; // 記錄上次檢測到的圖片數量（新增）
  let scrapeTimeout = null; // 延遲提取的定時器
  let imageCheckInterval = null; // 定期檢查圖片的定時器（新增）
  let forceExtractInterval = null; // 強制提取圖片的定時器（每 2 秒掃描一次）
  // 【持久化 Registry】廢除記憶體 Set，改用 chrome.storage.local 的 download_history 物件
  let processedImageUrls = new Set(); // 已處理的圖片 URL 集合（用於去重，僅在記憶體中，用於快速檢查）
  
  // 檢查圖片是否已下載（從 download_history 讀取）- 優化版本
  async function checkDownloadHistory(imageUrl, requestId, chatId) {
    try {
      if (!isRuntimeValid()) {
        // 靜默處理，不輸出警告（避免重複日誌）
        return { exists: false, type: null };
      }
      
      const history = await getStorage('download_history', {});
      const chatKey = chatId || currentChatId || 'default';
      const chatData = history[chatKey] || {};
      
      // 【優化】優先使用 URL 進行檢查（因為 URL 是穩定的，而 requestId 可能每次都不同）
      if (imageUrl) {
        const urlKey = getUrlKey(imageUrl, 200);
        
        // 方法 1: 直接使用 urlKey 作為鍵查找
        if (chatData[urlKey]) {
          return { exists: true, type: chatData[urlKey].type || 'unknown' };
        }
        
        // 方法 2: 遍歷所有記錄，比較 URL（兼容舊數據）
        for (const [key, value] of Object.entries(chatData)) {
          if (value.url) {
            const valueUrlKey = getUrlKey(value.url, 200);
            if (valueUrlKey === urlKey) {
              return { exists: true, type: value.type || 'unknown' };
            }
          }
        }
      }
      
      // 方法 3: 如果提供了 requestId，也檢查 requestId（兼容舊邏輯）
      if (requestId && chatData[requestId]) {
        return { exists: true, type: chatData[requestId].type || 'unknown' };
      }
      
      return { exists: false, type: null };
    } catch (error) {
      console.error('[Gemini 分類助手] [資料庫檢查] 讀取失敗:', error);
      return { exists: false, type: null };
    }
  }
  
  // 記錄圖片到 download_history - 優化版本
  async function markImageInHistory(imageUrl, requestId, chatId, type, metadata = {}) {
    try {
      if (!isRuntimeValid()) {
        // 靜默處理，不輸出警告（避免重複日誌）
        return;
      }
      
      const history = await getStorage('download_history', {});
      const chatKey = chatId || currentChatId || 'default';
      
      if (!history[chatKey]) {
        history[chatKey] = {};
      }
      
      // 【優化】優先使用 URL 的 hash 作為鍵（穩定），如果沒有則使用 requestId
      const urlKey = getUrlKey(imageUrl, 200);
      const key = urlKey || requestId || 'unknown';
      
      history[chatKey][key] = {
        url: urlKey, // 保存 URL 的關鍵部分
        fullUrl: imageUrl, // 保存完整 URL（用於調試）
        requestId: requestId, // 保存原始 requestId（用於兼容）
        type: type, // 'thumbnail' 或 'highres'
        timestamp: Date.now(),
        ...metadata
      };
      
      // 清理舊資料（只保留最近 1000 個對話的記錄）
      const chatKeys = Object.keys(history);
      if (chatKeys.length > 1000) {
        const sortedKeys = chatKeys.sort((a, b) => {
          const aTime = Math.max(...Object.values(history[a] || {}).map(v => v.timestamp || 0));
          const bTime = Math.max(...Object.values(history[b] || {}).map(v => v.timestamp || 0));
          return aTime - bTime;
        });
        sortedKeys.slice(0, sortedKeys.length - 1000).forEach(key => delete history[key]);
      }
      
      // 使用批量寫入（延遲寫入，提高性能）
      await setStorage('download_history', history, false);
      console.log('[Gemini 分類助手] [資料庫記錄] ✓ 已記錄到 download_history:', type);
    } catch (error) {
      console.error('[Gemini 分類助手] [資料庫記錄] 記錄失敗:', error);
    }
  }
  
  // 檢查對話是否已保存預覽圖（限制小圖：每個對話 ID 僅允許下載一張）- 優化版本
  async function hasThumbnailSaved(chatId) {
    try {
      if (!isRuntimeValid()) return false;
      
      const history = await getStorage('download_history', {});
      const chatKey = chatId || currentChatId || 'default';
      const chatData = history[chatKey] || {};
      
      return chatData.thumb_captured === true;
    } catch (error) {
      console.error('[Gemini 分類助手] [資料庫檢查] 檢查預覽圖失敗:', error);
      return false;
    }
  }
  
  // 標記對話已保存預覽圖（限制小圖：每個對話 ID 僅允許下載一張）- 優化版本
  async function markThumbnailSaved(chatId) {
    try {
      if (!isRuntimeValid()) return;
      
      const history = await getStorage('download_history', {});
      const chatKey = chatId || currentChatId || 'default';
      
      if (!history[chatKey]) {
        history[chatKey] = {};
      }
      history[chatKey].thumb_captured = true;
      
      await setStorage('download_history', history);
      console.log('[Gemini 分類助手] [資料庫記錄] ✓ 已標記預覽圖已保存（thumb_captured）');
    } catch (error) {
      console.error('[Gemini 分類助手] [資料庫記錄] 標記預覽圖失敗:', error);
    }
  }
  
  // ========== 操作日誌記錄系統 ==========
  // 記錄所有與高畫質圖片下載相關的操作，用於分析最佳下載方式
  
  // 記錄操作日誌
  function logOperation(operation, data) {
    try {
      const logEntry = {
        timestamp: Date.now(),
        timestampDisplay: new Date().toLocaleTimeString('zh-TW', {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          fractionalSecondDigits: 3
        }),
        operation: operation, // 操作類型
        data: data, // 操作數據
        url: window.location.href,
        chatId: currentChatId,
        userProfile: currentUserProfile || 'default'
      };
      
      // 同時在控制台輸出（方便調試）- 僅在開發模式下輸出
      // 【優化】減少控制台輸出，避免產生大量日誌
      // 只在重要操作時輸出，或使用 debug 模式
      // console.log(`[操作日誌] ${operation}:`, data); // 已禁用，避免大量日誌
      
      // 【修正通訊崩潰】所有 sendMessage 前必須加上檢查，防止 context invalidated 錯誤
      // 靜默處理，不輸出警告（避免重複日誌）
      if (!chrome.runtime?.id) {
        return;
      }
      
      // 發送到 background.js 保存（使用 checkRuntimeError 確保 Context 失效時顯示警告）
      if (isRuntimeValid()) {
        chrome.runtime.sendMessage({
          action: 'LOG_OPERATION',
          logEntry: logEntry
        }, (response) => {
          if (chrome.runtime.lastError) {
            // 【解決 Context 失效】檢查是否為 Extension context invalidated 錯誤
            if (checkRuntimeError(chrome.runtime.lastError)) {
              return;
            }
            console.error('[操作日誌] 發送失敗:', chrome.runtime.lastError.message);
            // 如果發送失敗，嘗試直接保存到本地存儲（備用方案）
            try {
              const storageKey = `operation_logs_${logEntry.userProfile}`;
              chrome.storage.local.get([storageKey], (result) => {
                const logs = result[storageKey] || [];
                logs.push(logEntry);
                if (logs.length > 5000) {
                  logs.shift();
                }
                chrome.storage.local.set({ [storageKey]: logs }, () => {
                  console.log('[操作日誌] ✓ 已保存到本地存儲（備用方案）');
                });
              });
            } catch (e) {
              console.error('[操作日誌] 備用保存也失敗:', e);
            }
          } else {
            console.log('[操作日誌] ✓ 已發送到 Background');
          }
        });
      } else {
        // 靜默處理，不輸出警告（避免重複日誌）
      }
    } catch (error) {
      console.error('[操作日誌] 記錄失敗:', error);
    }
  }
  
  // 初始化
  init();

  // 檢測用戶檔案
  function detectUserProfile() {
    try {
      // console.log('[Gemini 分類助手] [用戶檢測] 開始檢測用戶檔案...'); // 已關閉日誌

      // 策略 0（最穩定且成本最低）: 從 URL 判斷 Google 帳號索引（多帳號常見 /u/0/ 或 authuser=0）
      // - 例: https://gemini.google.com/u/1/app
      // - 例: https://gemini.google.com/app?authuser=1
      try {
        const pathname = window.location.pathname || '';
        const href = window.location.href || '';
        const uMatch = pathname.match(/\/u\/(\d+)\//);
        if (uMatch && uMatch[1] !== undefined) {
          currentUserProfile = `u${uMatch[1]}`;
          return;
        }
        const authMatch = href.match(/[?&]authuser=(\d+)/);
        if (authMatch && authMatch[1] !== undefined) {
          currentUserProfile = `u${authMatch[1]}`;
          return;
        }
      } catch (e) {
        // 忽略 URL 解析失敗
      }
      
      // 策略 1: 嘗試從頁面元素中獲取用戶信息（頭像、名稱等）
      const userSelectors = [
        '[aria-label*="Google Account"]',
        '[aria-label*="Google 帳戶"]',
        '[aria-label*="Google 帳號"]',
        'a[href*="myaccount.google.com"]',
        'img[alt*="@"]', // 包含 @ 的圖片 alt（可能是用戶頭像）
        '[data-testid*="avatar"]',
        '[aria-label*="@"]',
        '[class*="avatar"]',
        '[class*="user"]',
        '[class*="account"]'
      ];
      
      for (const selector of userSelectors) {
        const elements = document.querySelectorAll(selector);
        for (const el of elements) {
          const alt = el.getAttribute('alt') || '';
          const ariaLabel = el.getAttribute('aria-label') || '';
          const src = el.getAttribute('src') || '';
          const href = el.getAttribute('href') || '';
          
          // 嘗試從 alt 或 aria-label 中提取郵箱
          const emailMatch = (alt + ' ' + ariaLabel).match(/([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9_-]+)/);
          if (emailMatch && emailMatch[1]) {
            const email = emailMatch[1];
            // 使用郵箱前綴作為檔案標識（移除特殊字符）
            const profileId = email.split('@')[0].replace(/[^a-zA-Z0-9]/g, '_');
            currentUserProfile = profileId;
            // console.log('[Gemini 分類助手] [用戶檢測] ✓ 從頁面元素找到用戶檔案:', currentUserProfile); // 已關閉日誌
            return;
          }

          // 嘗試從 myaccount 連結中的 authuser 提取（通常也能區分多帳號）
          if (href) {
            const authMatch = href.match(/[?&]authuser=(\d+)/);
            if (authMatch && authMatch[1] !== undefined) {
              currentUserProfile = `u${authMatch[1]}`;
              return;
            }
          }
          
          // 嘗試從圖片 src 中提取（某些情況下包含用戶 ID）
          if (src.includes('googleusercontent.com')) {
            const userIdMatch = src.match(/\/a\/([^\/]+)/);
            if (userIdMatch && userIdMatch[1]) {
              currentUserProfile = userIdMatch[1].substring(0, 20); // 限制長度
              // console.log('[Gemini 分類助手] [用戶檢測] ✓ 從圖片 URL 找到用戶檔案:', currentUserProfile); // 已關閉日誌
              return;
            }
          }
        }
      }
      
      // 策略 2: 嘗試從 localStorage 獲取（某些 Google 服務會在 localStorage 存儲用戶信息）
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key && (key.includes('user') || key.includes('account') || key.includes('email'))) {
            const value = localStorage.getItem(key);
            if (value) {
              try {
                const parsed = JSON.parse(value);
                if (parsed.email) {
                  const profileId = parsed.email.split('@')[0].replace(/[^a-zA-Z0-9]/g, '_');
                  currentUserProfile = profileId;
                  // console.log('[Gemini 分類助手] [用戶檢測] ✓ 從 localStorage 找到用戶檔案:', currentUserProfile); // 已關閉日誌
                  return;
                }
              } catch (e) {
                // 不是 JSON，嘗試直接匹配郵箱
                const emailMatch = value.match(/([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9_-]+)/);
                if (emailMatch && emailMatch[1]) {
                  const profileId = emailMatch[1].split('@')[0].replace(/[^a-zA-Z0-9]/g, '_');
                  currentUserProfile = profileId;
                  // console.log('[Gemini 分類助手] [用戶檢測] ✓ 從 localStorage 找到用戶檔案:', currentUserProfile); // 已關閉日誌
                  return;
                }
              }
            }
          }
        }
      } catch (e) {
        // console.log('[Gemini 分類助手] [用戶檢測] 無法訪問 localStorage:', e.message); // 已關閉日誌
      }
      
      // 策略 3: 使用默認檔案（無法檢測時）
      if (!currentUserProfile) {
        currentUserProfile = 'default';
        // console.log('[Gemini 分類助手] [用戶檢測] ⚠️ 無法檢測用戶，使用默認檔案: default'); // 已關閉日誌
      }
    } catch (error) {
      console.error('[Gemini 分類助手] [用戶檢測] ❌ 檢測用戶檔案時發生錯誤:', error);
      currentUserProfile = 'default';
    }
  }

  function init() {
    console.log('[Gemini 分類助手] Content Script 已載入，準備開始監測');
    
    // 初始化時檢測用戶檔案
    detectUserProfile();

    // 從第一次滑鼠點擊開始記錄
    setupFirstClickRecorder();
    
    // 等待頁面載入完成
    if (document.readyState === 'loading') {
      console.log('[Gemini 分類助手] 頁面載入中，等待 DOMContentLoaded...');
      document.addEventListener('DOMContentLoaded', () => {
        console.log('[Gemini 分類助手] DOMContentLoaded 事件觸發');
        startMonitoring();
      });
    } else {
      console.log('[Gemini 分類助手] 頁面已載入，立即開始監測');
      startMonitoring();
    }

    // 監聽來自 Side Panel 的消息
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      // 只在非頻繁的消息時才記錄日誌（減少控制台噪音）
      if (message.action !== 'getUserProfile' && message.action !== 'GET_DOWNLOAD_BUTTONS' && message.action !== 'ping') {
        console.log('[Gemini 分類助手] 收到消息:', message);
      }
      
      if (message.action === 'ping') {
        detectUserProfile(); // 更新用戶檔案
        // 即使監控暫停/未啟動，也嘗試從 URL 推導 chatId（避免側欄抓不到對話）
        const inferred = getChatIdFromUrl(window.location.href);
        if (inferred && inferred !== currentChatId) {
          // 檢測到新的對話 ID，觸發完整的初始化流程
          console.log('[Gemini 分類助手] [ping] 檢測到新的對話 ID:', inferred, '(舊 ID:', currentChatId, ')');
          currentChatId = inferred;
          currentTitle = null; // 重置標題，等待重新獲取
          extractionAttempts = 0; // 重置嘗試次數
          
          // 觸發完整的 URL 檢查以初始化對話（即使監控未啟動也執行）
          checkURLAndExtractConversation(true);
        } else if (!currentChatId && inferred) {
          // 首次檢測到對話 ID
          currentChatId = inferred;
          // 觸發完整的 URL 檢查以初始化對話（即使監控未啟動也執行）
          checkURLAndExtractConversation(true);
        }
        
        const response = {
          status: 'ok',
          monitoring: isMonitoring,
          chatId: currentChatId,
          title: currentTitle,
          url: window.location.href,
          userProfile: currentUserProfile || 'default'
        };
        console.log('[Gemini 分類助手] 回應 ping:', response);
        sendResponse(response);
      } else if (message.action === 'getUserProfile') {
        detectUserProfile();
        sendResponse({ userProfile: currentUserProfile || 'default' });
      } else if (message.action === 'getCurrentConversation') {
        sendResponse({ chatId: currentChatId, title: currentTitle });
      } else if (message.action === 'getConversationTitle') {
        // 根據指定 chatId 獲取對話標題（從側邊欄查找）
        const targetChatId = message.chatId;
        if (targetChatId) {
          const title = extractTitleByChatId(targetChatId);
          sendResponse({ chatId: targetChatId, title: title || null });
        } else {
          sendResponse({ chatId: null, title: null });
        }
      } else if (message.action === 'verifyConversationTitles') {
        // 批量驗證多個對話的標題
        const chatIds = message.chatIds || [];
        const results = {};
        chatIds.forEach(chatId => {
          const title = extractTitleByChatId(chatId);
          if (title) {
            results[chatId] = title;
          }
        });
        sendResponse({ results });
      } else if (message.action === 'startMonitoring') {
        startMonitoring();
        sendResponse({ status: 'ok' });
      } else if (message.action === 'stopMonitoring') {
        stopMonitoring();
        sendResponse({ status: 'ok' });
      } else if (message.action === 'pauseMonitoring') {
        // 暫停監控
        stopMonitoring();
        sendResponse({ status: 'ok' });
      } else if (message.action === 'resumeMonitoring') {
        // 恢復監控
        startMonitoring();
        sendResponse({ status: 'ok' });
      } else if (message.action === 'forceExtract') {
        // 強制重新提取（用於調試）
        if (currentChatId) {
          extractionAttempts = 0;
          extractTitle();
        }
        sendResponse({ status: 'ok', chatId: currentChatId, title: currentTitle });
      } else if (message.action === 'debugTitleCandidates') {
        // 調試：列出所有可能的標題候選
        const candidates = [];
        
        // 查找所有 h1
        document.querySelectorAll('h1').forEach((h1, idx) => {
          const text = (h1.innerText || h1.textContent || '').trim();
          if (text) {
            candidates.push({ type: 'h1', index: idx, text: text, selector: 'h1' });
          }
        });
        
        // 查找側邊欄項目
        const sidebarItems = document.querySelectorAll('[class*="conversation"], [class*="chat"], [class*="thread"], [role="listitem"]');
        sidebarItems.forEach((item, idx) => {
          const links = item.querySelectorAll('a[href*="/app/"]');
          links.forEach(link => {
            const href = link.getAttribute('href') || '';
            if (href.includes(currentChatId)) {
              const text = (item.innerText || item.textContent || '').trim();
              if (text) {
                candidates.push({ type: 'sidebar-item', index: idx, text: text, href: href });
              }
            }
          });
        });
        
        console.log('[Gemini 分類助手] [調試] 找到的標題候選:', candidates);
        sendResponse({ status: 'ok', candidates: candidates, currentChatId: currentChatId });
      } else if (message.action === 'GET_DOWNLOAD_BUTTONS') {
        // 獲取下載按鈕列表（用於測試）
        try {
          const buttons = getDownloadButtonsList();
          sendResponse({ status: 'ok', buttons: buttons });
        } catch (error) {
          console.error('[Gemini 分類助手] [下載按鈕測試] 獲取按鈕列表失敗:', error);
          sendResponse({ status: 'error', error: error.message });
        }
        return true;
      } else if (message.action === 'CLICK_DOWNLOAD_BUTTON') {
        // 點擊指定索引的下載按鈕（用於測試）
        try {
          const buttonIndex = message.buttonIndex;
          if (buttonIndex === undefined || buttonIndex === null) {
            sendResponse({ status: 'error', error: '缺少按鈕索引' });
            return true;
          }
          const result = clickDownloadButtonByIndex(buttonIndex);
          sendResponse(result);
        } catch (error) {
          console.error('[Gemini 分類助手] [下載按鈕測試] 點擊按鈕失敗:', error);
          sendResponse({ status: 'error', error: error.message });
        }
        return true;
      } else if (message.action === 'CLICK_BEST_DOWNLOAD_BUTTON') {
        // 自動尋找最佳下載按鈕並點擊（用於測試）
        try {
          const result = clickBestDownloadButton();
          sendResponse(result);
        } catch (error) {
          console.error('[Gemini 分類助手] [下載按鈕測試] 自動點擊失敗:', error);
          sendResponse({ status: 'error', error: error.message });
        }
        return true;
      } else if (message.action === 'sendMessage' || message.action === 'SEND_MESSAGE') {
        // 從側邊欄發送消息（異步處理）
        const messageText = message.messageText || message.text || message.content || '';
        console.log('[Gemini 分類助手] [消息監聽] ========== 收到發送消息請求 ==========');
        console.log('[Gemini 分類助手] [消息監聽] Action:', message.action);
        console.log('[Gemini 分類助手] [消息監聽] 消息長度:', messageText.length, '字符');
        console.log('[Gemini 分類助手] [消息監聽] 消息預覽:', messageText.substring(0, 100));
        console.log('[Gemini 分類助手] [消息監聽] 當前 ChatId:', currentChatId);
        console.log('[Gemini 分類助手] [消息監聽] 當前 URL:', window.location.href);
        
        if (!messageText || !messageText.trim()) {
          console.error('[Gemini 分類助手] [消息監聽] ❌ 消息內容為空');
          sendResponse({ success: false, error: '消息內容為空' });
          return true;
        }
        
        sendMessageToGemini(messageText).then(result => {
          console.log('[Gemini 分類助手] [消息監聽] 發送消息結果:', result);
          sendResponse(result);
        }).catch(error => {
          console.error('[Gemini 分類助手] [消息監聽] 發送消息時發生錯誤:', error);
          console.error('[Gemini 分類助手] [消息監聽] 錯誤堆疊:', error.stack);
          sendResponse({ success: false, error: error.message || String(error) });
        });
        return true; // 保持通道開啟用於異步響應
      } else if (message.action === 'sendMessageWithImage') {
        // 從後台/側邊欄發送「圖片 + 文字」到 Gemini（異步）
        const messageText = message.messageText || message.text || message.content || '';
        const imageDataUrl = message.imageDataUrl || message.dataUrl || message.image || '';
        const filename = message.filename || 'image.png';
        const mime = message.mime || '';

        if (!imageDataUrl || typeof imageDataUrl !== 'string' || !imageDataUrl.startsWith('data:')) {
          sendResponse({ success: false, error: '缺少或不合法的 imageDataUrl' });
          return true;
        }

        sendMessageWithImageToGemini({ messageText, imageDataUrl, filename, mime })
          .then((result) => sendResponse(result))
          .catch((error) => sendResponse({ success: false, error: error?.message || String(error) }));
        return true;
      } else if (message.action === 'getConversationMessages') {
        // 獲取當前對話的消息歷史
        console.log('[Gemini 分類助手] [消息監聽] ========== 收到獲取對話記錄請求 ==========');
        console.log('[Gemini 分類助手] [消息監聽] 當前 ChatId:', currentChatId);
        console.log('[Gemini 分類助手] [消息監聽] 當前 URL:', window.location.href);
        console.log('[Gemini 分類助手] [消息監聽] Runtime 有效:', isRuntimeValid());
        
        try {
          if (!isRuntimeValid()) {
            // 靜默處理，不輸出錯誤（避免重複日誌）
            sendResponse({ success: false, error: 'Extension context invalidated' });
            return true;
          }

          if (!currentChatId) {
            console.warn('[Gemini 分類助手] [消息監聽] ⚠️ 沒有當前對話 ID');
            sendResponse({ success: true, messages: [], source: 'empty', error: 'No current chat ID' });
            return true;
          }

          console.log('[Gemini 分類助手] [消息監聽] ========== 開始獲取對話記錄 ==========');
          
          // 優化：先從存儲獲取歷史記錄，再補充新消息
          const fetchStoredMessages = new Promise((resolve, reject) => {
            console.log('[Gemini 分類助手] [消息監聽] 步驟 1: 從存儲獲取歷史記錄...');
            
            // 【修正通訊崩潰】所有 sendMessage 前必須加上檢查，防止 context invalidated 錯誤
            if (!chrome.runtime?.id) {
              // 靜默處理，不輸出警告（避免重複日誌）
              reject(new Error('Runtime invalid'));
              return;
            }
            
            chrome.runtime.sendMessage({
              action: 'getConversationMessages',
              data: {
                chatId: currentChatId,
                userProfile: currentUserProfile || 'default'
              }
            }, (response) => {
              if (chrome.runtime.lastError) {
                console.error('[Gemini 分類助手] [消息監聽] 從存儲獲取消息失敗:', chrome.runtime.lastError.message);
                resolve(null); // 返回 null 表示獲取失敗，但繼續處理
              } else {
                resolve(response);
              }
            });
          });
          
          // 等待存儲消息獲取完成後，再提取新消息
          fetchStoredMessages.then((storageResponse) => {
            // 步驟 1: 先使用存儲的歷史記錄
            const storedMessages = (storageResponse && storageResponse.messages) || [];
            console.log('[Gemini 分類助手] [消息監聽] ✓ 從存儲獲取到', storedMessages.length, '條歷史記錄');
            
            // 使用 Map 進行去重（基於文本內容和角色）
            const messageMap = new Map();
            
            // 先添加存儲的消息（保留原有的時間戳、圖片、代碼塊等信息）
            storedMessages.forEach(msg => {
              // 使用文本內容的前 200 字符和角色作為唯一鍵
              const textKey = (msg.text || '').substring(0, 200).replace(/\s/g, '');
              const roleKey = msg.role || 'unknown';
              const key = `${roleKey}_${textKey}`;
              if (!messageMap.has(key)) {
                messageMap.set(key, msg);
              } else {
                // 如果已存在，保留時間戳較早的那個（保留原始時間戳）
                const existing = messageMap.get(key);
                if ((msg.timestamp || 0) < (existing.timestamp || 0)) {
                  messageMap.set(key, msg);
                }
              }
            });
            
            console.log('[Gemini 分類助手] [消息監聽] 步驟 2: 從頁面提取新消息（補充）...');
            
            // 步驟 2: 從頁面提取新消息（只提取可能的新消息）
            let currentMessages = [];
            try {
              currentMessages = scrapeMessages();
              console.log('[Gemini 分類助手] [消息監聽] ✓ 從頁面提取到', currentMessages.length, '條消息');
            } catch (scrapeError) {
              console.error('[Gemini 分類助手] [消息監聽] ❌ scrapeMessages() 執行失敗:', scrapeError);
              currentMessages = [];
            }
            
            // 步驟 3: 合併新消息（只添加不存在的消息，或更新圖片/代碼塊）
            let newMessageCount = 0;
            let updatedMessageCount = 0;
            
            currentMessages.forEach(currentMsg => {
              const textKey = (currentMsg.text || '').substring(0, 200).replace(/\s/g, '');
              const roleKey = currentMsg.role || 'unknown';
              const key = `${roleKey}_${textKey}`;
              
              if (!messageMap.has(key)) {
                // 新消息，直接添加
                messageMap.set(key, currentMsg);
                newMessageCount++;
                console.log('[Gemini 分類助手] [消息監聽] + 發現新消息:', (currentMsg.text || '').substring(0, 50));
              } else {
                // 已存在的消息，只更新圖片和代碼塊（如果有的話）
                const existing = messageMap.get(key);
                let updated = false;
                
                // 更新圖片（如果新消息有圖片且舊消息沒有，或圖片數量不同）
                if (currentMsg.images && currentMsg.images.length > 0) {
                  if (!existing.images || existing.images.length < currentMsg.images.length) {
                    existing.images = currentMsg.images;
                    updated = true;
                    console.log('[Gemini 分類助手] [消息監聽] 📷 更新圖片:', currentMsg.images.length, '張');
                  }
                }
                
                // 更新代碼塊（如果新消息有代碼塊且舊消息沒有）
                if (currentMsg.codeBlocks && currentMsg.codeBlocks.length > 0) {
                  if (!existing.codeBlocks || existing.codeBlocks.length < currentMsg.codeBlocks.length) {
                    existing.codeBlocks = currentMsg.codeBlocks;
                    updated = true;
                  }
                }
                
                if (updated) {
                  updatedMessageCount++;
                }
              }
            });
            
            console.log('[Gemini 分類助手] [消息監聽] 合併結果: 新增', newMessageCount, '條，更新', updatedMessageCount, '條');
            
            // 轉換為數組並按時間戳排序
            const allMessages = Array.from(messageMap.values()).sort((a, b) => {
              const timeA = a.timestamp || 0;
              const timeB = b.timestamp || 0;
              return timeA - timeB;
            });
            
            console.log('[Gemini 分類助手] [消息監聽] 合併後共', allMessages.length, '條消息（新增', newMessageCount, '條）');
            console.log('[Gemini 分類助手] [消息監聽] ========== 返回消息完成 ==========');
            
            // 構建響應對象
            const responseData = { 
              success: true, 
              messages: allMessages,
              source: storedMessages.length > 0 ? 'merged' : 'realtime',
              realtimeCount: currentMessages.length,
              storedCount: storedMessages.length,
              totalCount: allMessages.length
            };
            
            // 確保 sendResponse 被調用
            try {
              const responseSent = sendResponse(responseData);
              console.log('[Gemini 分類助手] [消息監聽] ✓ sendResponse 已調用，返回值:', responseSent);
              console.log('[Gemini 分類助手] [消息監聽] 響應數據:', {
                success: responseData.success,
                messageCount: responseData.totalCount,
                source: responseData.source
              });
            } catch (e) {
              console.error('[Gemini 分類助手] [消息監聽] ❌ sendResponse 調用失敗:', e);
              console.error('[Gemini 分類助手] [消息監聽] 錯誤堆疊:', e.stack);
            }
          }).catch((error) => {
            console.error('[Gemini 分類助手] [消息監聽] 處理存儲消息時發生錯誤:', error);
            // 即使出錯，也返回實時提取的消息
            try {
              sendResponse({ 
                success: true, 
                messages: currentMessages,
                source: 'realtime',
                error: error.message || String(error)
              });
              console.log('[Gemini 分類助手] [消息監聽] ✓ sendResponse 已調用（錯誤情況下返回實時消息）');
            } catch (e) {
              console.error('[Gemini 分類助手] [消息監聽] ❌ sendResponse 調用失敗（錯誤情況）:', e);
            }
          });
          
          return true; // 保持通道開啟用於異步響應
        } catch (error) {
          console.error('[Gemini 分類助手] [消息監聽] 獲取對話記錄時發生錯誤:', error);
          console.error('[Gemini 分類助手] [消息監聽] 錯誤堆疊:', error.stack);
          sendResponse({ success: false, error: error.message || String(error) });
          return true;
        }
      } else if (message.action === 'scrapeMessages' || message.action === 'getCurrentMessages') {
        // 直接從頁面提取當前對話消息（不從存儲）
        console.log('[Gemini 分類助手] [消息監聽] ========== 收到直接提取對話記錄請求 ==========');
        try {
          if (!currentChatId) {
            console.warn('[Gemini 分類助手] [消息監聽] ⚠️ 沒有當前對話 ID');
            sendResponse({ success: true, messages: [], error: 'No current chat ID' });
            return true;
          }
          
          console.log('[Gemini 分類助手] [消息監聽] 開始從頁面提取消息...');
          const messages = scrapeMessages();
          console.log('[Gemini 分類助手] [消息監聽] 提取完成，共', messages.length, '條消息');
          sendResponse({ success: true, messages: messages, count: messages.length });
          return true;
        } catch (error) {
          console.error('[Gemini 分類助手] [消息監聽] 提取對話記錄時發生錯誤:', error);
          console.error('[Gemini 分類助手] [消息監聽] 錯誤堆疊:', error.stack);
          sendResponse({ success: false, error: error.message || String(error) });
          return true;
        }
      } else if (message.action === 'analyzePageStructure') {
        // 分析頁面結構（用於調試）
        const analysis = analyzePageStructure();
        sendResponse({ success: true, analysis });
        return true;
      } else if (message.action === 'testSendMessage') {
        // 測試發送消息（用於調試）
        sendMessageToGemini(message.messageText || '測試消息').then(result => {
          sendResponse(result);
        }).catch(error => {
          sendResponse({ success: false, error: error.message });
        });
        return true;
      } else if (message.action === 'CAPTURE_REAL_DOWNLOAD_URL') {
        // 處理來自 background.js 的下載 URL 捕獲消息（異步處理）
        const url = message.url;
        const downloadId = message.downloadId;
        const filename = message.filename || '';
        const referrer = message.referrer || '';
        const isIgnorableUrl =
          !url ||
          url.startsWith('blob:null/') ||
          url.startsWith('data:application/json');

        // 若尚未開始記錄，從下載事件觸發開始
        if (!clickMonitorStarted) {
          clickMonitorStarted = true;
          firstUserClickAt = Date.now();
          recordClickMonitorEvent('FIRST_USER_CLICK', {
            clickTimestamp: firstUserClickAt,
            source: 'download_started',
            url: url ? url.substring(0, 300) : null
          });
        }

        if (!isIgnorableUrl) {
          // 【監聽記錄】記錄下載開始事件
          const downloadRecord = recordClickMonitorEvent('DOWNLOAD_STARTED', {
            url: url.substring(0, 300),
            downloadId: downloadId,
            filename: filename,
            referrer: referrer
          });

          if (stopAutoDownloadAfterSuccess && isDownloadUrl(url)) {
            if (url.includes('rd-gg-dl') || url.includes('gg-dl') || url.includes('work.fife.usercontent.google.com/rd-gg-dl')) {
              markAutoDownloadSuccess(url, 'download_started');
            }
          }

          const downloadKey = downloadId || url;
          if (downloadRecord?.id) {
            downloadRecordIdByKey.set(downloadKey, downloadRecord.id);
          }

          // 記錄圖片路徑（異步，不阻塞響應）
          recordImagePath({
            id: `download_${downloadId || Date.now()}`,
            requestId: `download_${downloadId || Date.now()}`,
            url: url,
            timestamp: Date.now(),
            chatId: currentChatId,
            userProfile: currentUserProfile || 'default'
          }).catch(err => {
            console.error('[Gemini 分類助手] [圖片記錄] 記錄失敗:', err);
          });

          // 【自動追蹤】下載 URL 命中 gg-dl/rd-gg 時，自動追蹤原始圖
          if (typeof trackImageUrlRedirectChain === 'function' && isDownloadUrl(url)) {
            if (url.includes('gg-dl') || url.includes('rd-gg-dl') || url.includes('rd-gg')) {
              recordClickMonitorEvent('TRACK_TRIGGERED_FROM_DOWNLOAD', {
                url: url.substring(0, 300),
                downloadId: downloadId
              });
              trackImageUrlRedirectChain(url, 4).then(result => {
                const chainSummary = (result?.chain || []).map(step => ({
                  step: step.step,
                  type: step.type,
                  url: step.url ? step.url.substring(0, 200) : ''
                }));
                const recordId = downloadRecordIdByKey.get(downloadKey);
                if (recordId) {
                  updateClickMonitorRecord(recordId, {
                    tracking: {
                      status: result?.success ? 'success' : 'failed',
                      reason: result?.reason || null,
                      finalUrl: result?.finalUrl || null,
                      steps: chainSummary.length,
                      chainSummary,
                      resolvedAt: Date.now()
                    }
                  });
                }
              }).catch(err => {
                const recordId = downloadRecordIdByKey.get(downloadKey);
                if (recordId) {
                  updateClickMonitorRecord(recordId, {
                    tracking: {
                      status: 'error',
                      reason: err?.message || String(err),
                      resolvedAt: Date.now()
                    }
                  });
                }
                recordClickMonitorEvent('TRACK_ERROR', {
                  url: url.substring(0, 300),
                  error: err?.message || String(err)
                });
              });
            }
          }
        }

        sendResponse({ status: 'ok' });
        return true;
      } else if (message.action === 'GET_CLICK_MONITOR_RECORDS') {
        // 獲取監聽記錄
        sendResponse({ status: 'ok', records: clickMonitorRecords });
        return true;
      } else if (message.action === 'CLEAR_CLICK_MONITOR_RECORDS') {
        // 清除監聽記錄
        clickMonitorRecords = [];
        sendResponse({ status: 'ok' });
        return true;
      } else if (message.action === 'RECORD_RESPONSE_URL') {
        // 由 background(webRequest) 傳入的 responseURL 記錄
        const url = message.url || '';
        if (url) {
          recordClickMonitorEvent('NETWORK_RESPONSE_URL', {
            requestUrl: url.substring(0, 500),
            responseUrl: url.substring(0, 500),
            source: 'webRequest',
            captureLocation: 'background',
            tabId: message.tabId ?? null,
            initiator: message.initiator || null
          });

          if (Date.now() <= globalDownloadMonitorUntil &&
              isDownloadUrl(url) &&
              !globalTrackedResponseUrls.has(url)) {
            globalTrackedResponseUrls.add(url);
            recordClickMonitorEvent('AUTO_TRACK_FROM_RESPONSE_URL', {
              responseUrl: url.substring(0, 500),
              source: 'webRequest'
            });
            trackImageUrlRedirectChain(url, 4).catch(err => {
              recordClickMonitorEvent('TRACK_ERROR', {
                url: url.substring(0, 300),
                error: err?.message || String(err)
              });
            });
          }

          if (Date.now() <= globalDownloadMonitorUntil &&
              url.includes('rd-gg-dl') &&
              !triggerAutoDownloadOnceUrls.has(url)) {
            triggerAutoDownloadOnceUrls.add(url);
            attemptAutoDownloadMulti(url, 'webRequest');
          }
        }
        sendResponse({ status: 'ok' });
        return true;
      }
      // 對於未處理的消息，返回 false 表示不需要異步響應
      return false;
    });
  }

  function getChatIdFromUrl(url) {
    try {
      if (!url) return null;
      const m = url.match(/\/app\/([^/?#]+)/);
      return (m && m[1]) ? m[1] : null;
    } catch {
      return null;
    }
  }

  // ========== Auto download toggle (default off) ==========
  let autoDownloadEnabled = false;
  try {
    chrome.storage.local.get(['autoDownloadEnabled']).then((r) => {
      autoDownloadEnabled = r.autoDownloadEnabled === true;
    }).catch(() => {});
    chrome.storage.onChanged.addListener((changes, namespace) => {
      if (namespace === 'local' && changes.autoDownloadEnabled) {
        autoDownloadEnabled = changes.autoDownloadEnabled.newValue === true;
      }
    });
  } catch {
    // ignore
  }

  async function findFileInputForImage(maxAttempts = 6, delayMs = 400) {
    const selectors = [
      'input[type="file"][accept*="image"]',
      'input[type="file"]'
    ];

    for (let i = 0; i < maxAttempts; i++) {
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el) return el;
      }

      // 嘗試點擊附件/上傳按鈕以顯示 input
      const uploadBtnSelectors = [
        'button[aria-label*="Upload"]',
        'button[aria-label*="upload"]',
        'button[aria-label*="上傳"]',
        'button[aria-label*="附件"]',
        'button[aria-label*="附加"]',
        'button[aria-label*="Add file"]',
        'button[aria-label*="Add"]',
        'button[title*="Upload"]',
        'button[title*="上傳"]'
      ];
      for (const s of uploadBtnSelectors) {
        const btn = document.querySelector(s);
        if (btn) {
          try {
            btn.click();
            break;
          } catch {
            // ignore
          }
        }
      }

      await new Promise((r) => setTimeout(r, delayMs));
    }
    return null;
  }

  async function attachImageDataUrl(imageDataUrl, filename, mime) {
    const input = await findFileInputForImage(6, 350);
    if (!input) throw new Error('找不到圖片上傳 input[type=file]');

    // Convert dataURL to Blob
    const res = await fetch(imageDataUrl);
    const blob = await res.blob();
    const type = mime || blob.type || 'image/png';
    const file = new File([blob], filename || 'image.png', { type });
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;

    // Trigger events to notify framework
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));

    // Give UI some time to render attachment preview
    await new Promise((r) => setTimeout(r, 600));
    return true;
  }

  async function sendMessageWithImageToGemini({ messageText, imageDataUrl, filename, mime }) {
    try {
      // Ensure image attached first
      await attachImageDataUrl(imageDataUrl, filename, mime);

      // If no text provided, still send a minimal prompt
      const text = (messageText && String(messageText).trim()) ? String(messageText) : '請解析這張圖片。';
      const result = await sendMessageToGemini(text);
      return result;
    } catch (e) {
      return { success: false, error: e?.message || String(e) };
    }
  }

  async function startMonitoring() {
    if (isMonitoring) {
      console.log('[Gemini 分類助手] 監測已在運行中');
      return;
    }
    
    // 檢查是否暫停監控
    const result = await chrome.storage.local.get(['monitoringPaused']);
    if (result.monitoringPaused === true) {
      console.log('[Gemini 分類助手] ⏸️ 監控已暫停，不啟動監測');
      return;
    }
    
    isMonitoring = true;
    console.log('[Gemini 分類助手] ✓ 開始監測 Gemini 對話狀態');
    console.log('[Gemini 分類助手] 當前 URL:', window.location.href);
    console.log('[Gemini 分類助手] 當前 isMonitoring:', isMonitoring);

    // 監聽 URL 變化
    setupURLMonitoring();

    // 立即檢查當前 URL（強制檢查，確保對話能被檢測到）
    console.log('[Gemini 分類助手] 立即檢查當前 URL:', window.location.href);
    checkURLAndExtractConversation(true); // 使用強制檢查
    
    // 開始監控對話內容（即使沒有 currentChatId 也設置）
    console.log('[Gemini 分類助手] 設置消息監控...');
    setupMessageMonitoring();
    
    // 啟動強制提取定時器（每 2 秒掃描一次，不論有沒有對話 ID 都運行）
    setTimeout(() => {
      startForceExtractInterval();
    }, 1000); // 延遲 1 秒啟動，確保頁面已完全加載
    
    // 啟動圖片攔截功能
    setTimeout(() => {
      // 取消自動下載：不再自動點擊下載按鈕
      if (autoDownloadEnabled) {
        setupDownloadButtonObserver();
      }
    }, 1500); // 延遲 1.5 秒，確保頁面已完全載入
  }

  function stopMonitoring() {
    isMonitoring = false;
    console.log('[Gemini 分類助手] ✗ 停止監測');
    
    // 停止標題觀察器
    if (titleObserver) {
      try {
        titleObserver.disconnect();
      } catch (e) {
        // 如果觀察器已經失效，忽略錯誤
        console.log('[Gemini 分類助手] [清理] 觀察器清理時發生錯誤（可忽略）:', e.message);
      }
      titleObserver = null;
      console.log('[Gemini 分類助手] 已停止 MutationObserver');
    }

    // 停止 URL 檢查定時器
    if (urlCheckInterval) {
      clearInterval(urlCheckInterval);
      urlCheckInterval = null;
      console.log('[Gemini 分類助手] 已停止 URL 檢查定時器');
    }
    
    // 重置狀態（但保留 currentChatId 和 currentTitle，以便重新啟動時使用）
    extractionAttempts = 0;
    lastNotifiedData = null;
    
    // 停止消息觀察器
    if (messageObserver) {
      try {
        messageObserver.disconnect();
      } catch (e) {
        console.log('[Gemini 分類助手] [清理] 消息觀察器清理時發生錯誤（可忽略）:', e.message);
      }
      messageObserver = null;
      console.log('[Gemini 分類助手] 已停止消息觀察器');
    }
    
    // 停止圖片觀察器（新增）
    if (imageObserver) {
      try {
        imageObserver.disconnect();
      } catch (e) {
        console.log('[Gemini 分類助手] [清理] 圖片觀察器清理時發生錯誤（可忽略）:', e.message);
      }
      imageObserver = null;
      console.log('[Gemini 分類助手] 已停止圖片觀察器');
    }
    
    // 停止圖片檢查定時器（新增）
    if (imageCheckInterval) {
      clearInterval(imageCheckInterval);
      imageCheckInterval = null;
      console.log('[Gemini 分類助手] 已停止圖片檢查定時器');
    }
    
    // 停止強制提取定時器（新增）
    stopForceExtractInterval();
    
    // 重置消息記錄狀態
    lastMessageCount = 0;
    lastImageCount = 0; // 重置圖片計數（新增）
    recordedMessages.clear();
  }

  // 設置 URL 監聽
  function setupURLMonitoring() {
    console.log('[Gemini 分類助手] 設置 URL 監聽...');

    // 監聽 popstate 事件（瀏覽器前進/後退）
    window.addEventListener('popstate', () => {
      console.log('[Gemini 分類助手] popstate 事件觸發');
      setTimeout(() => {
        checkURLAndExtractConversation();
      }, 300);
    });

    // 攔截 pushState 和 replaceState（SPA 路由變化）
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;

    history.pushState = function(...args) {
      originalPushState.apply(history, args);
      console.log('[Gemini 分類助手] pushState 觸發，新 URL:', window.location.href);
      setTimeout(() => {
        checkURLAndExtractConversation();
      }, 300);
    };

    history.replaceState = function(...args) {
      originalReplaceState.apply(history, args);
      console.log('[Gemini 分類助手] replaceState 觸發，新 URL:', window.location.href);
      setTimeout(() => {
        checkURLAndExtractConversation();
      }, 300);
    };

    // 定期檢查 URL（作為主要機制，每 1 秒檢查一次）
    urlCheckInterval = setInterval(() => {
      checkURLAndExtractConversation();
    }, 1000);

    console.log('[Gemini 分類助手] ✓ URL 監聽已設置完成');
  }

  // 用於追蹤 URL 檢查次數（定期檢測用戶檔案）
  let urlCheckCount = 0;

  // 檢查 URL 並提取對話 ID
  function checkURLAndExtractConversation(forceCheck = false) {
    // 如果監控未啟動且不是強制檢查，則跳過（但允許強制檢查以支持 ping 請求）
    // 【修復】即使監控未啟動，也允許檢查（用於檢測對話）
    // if (!isMonitoring && !forceCheck) return; // 暫時註釋掉，確保對話能被檢測到

    try {
      urlCheckCount++;
      const url = window.location.href;
      // console.log('[Gemini 分類助手] [URL檢查] 當前 URL:', url, '(檢查次數:', urlCheckCount, ')'); // 已關閉日誌

      // 檢查是否在 Gemini 網頁上
      if (!url.includes('gemini.google.com')) {
        // console.log('[Gemini 分類助手] [URL檢查] ⚠️ 不在 Gemini 網頁上'); // 已關閉日誌
        if (currentChatId !== null) {
          // console.log('[Gemini 分類助手] [URL檢查] 清除當前對話信息'); // 已關閉日誌
          currentChatId = null;
          currentTitle = null;
          // 停止強制提取定時器
          stopForceExtractInterval();
          notifyConversationChange(null, null);
        }
        return;
      }

      // 檢查 URL 是否包含 /app/ 且後面有對話 ID
      // Gemini URL 格式可能是:
      // - https://gemini.google.com/app/{chatId}
      // - https://gemini.google.com/app/{chatId}?...
      // - https://gemini.google.com/app (新對話，可能還沒有 chatId)
      let chatId = null;
      const appMatch = url.match(/\/app\/([^/?#]+)/);
      
      if (appMatch && appMatch[1]) {
        chatId = appMatch[1];
        console.log('[Gemini 分類助手] [URL檢查] ✓ 從 URL 找到對話 ID:', chatId);
      } else if (url.includes('/app')) {
        // 如果在 /app 頁面但沒有 chatId，嘗試從 DOM 或其他方式檢測
        console.log('[Gemini 分類助手] [URL檢查] ⚠️ 在 /app 頁面但 URL 中沒有 chatId，嘗試從 DOM 檢測...');
        
        // 嘗試從頁面中提取 chatId（例如從數據屬性、localStorage 等）
        try {
          // 方法 1: 從 window.location 的 pathname 中提取
          const pathMatch = window.location.pathname.match(/\/app\/([^/?#]+)/);
          if (pathMatch && pathMatch[1]) {
            chatId = pathMatch[1];
            console.log('[Gemini 分類助手] [URL檢查] ✓ 從 pathname 找到對話 ID:', chatId);
          }
          
          // 方法 2: 嘗試從頁面數據中提取（如果 Gemini 在頁面中存儲了對話 ID）
          if (!chatId) {
            // 檢查是否有對話相關的數據屬性
            const conversationElement = document.querySelector('[data-conversation-id], [data-chat-id], [data-chatid]');
            if (conversationElement) {
              chatId = conversationElement.getAttribute('data-conversation-id') || 
                       conversationElement.getAttribute('data-chat-id') || 
                       conversationElement.getAttribute('data-chatid');
              if (chatId) {
                console.log('[Gemini 分類助手] [URL檢查] ✓ 從 DOM 元素找到對話 ID:', chatId);
              }
            }
          }
          
          // 方法 3: 如果仍然沒有找到，但頁面上有對話內容，使用臨時 ID
          if (!chatId) {
            // 檢查頁面上是否有對話消息
            const hasMessages = document.querySelectorAll('[class*="message"], [class*="user-query"], [class*="model-response"]').length > 0;
            if (hasMessages) {
              // 使用基於時間戳的臨時 ID（當 URL 更新時會被替換）
              const tempId = 'temp_' + Date.now();
              console.log('[Gemini 分類助手] [URL檢查] ⚠️ 使用臨時對話 ID:', tempId, '(頁面上有對話內容但 URL 中沒有 ID)');
              chatId = tempId;
            }
          }
        } catch (error) {
          console.error('[Gemini 分類助手] [URL檢查] 從 DOM 檢測對話 ID 時發生錯誤:', error);
        }
      }
      
      if (chatId) {
        
        // 如果 chatId 改變了，先檢測用戶檔案，然後更新並嘗試獲取標題
        if (chatId !== currentChatId) {
          // console.log('[Gemini 分類助手] [URL檢查] ✨ 檢測到新的對話 ID:', chatId, '(舊 ID:', currentChatId, ')'); // 已關閉日誌
          
          // 【優化】切換對話時清理資源
          cleanupOnConversationSwitch();
          
          // 重要：先檢測用戶檔案（頁面切換時優先確認用戶是誰）
          // console.log('[Gemini 分類助手] [URL檢查] 🔍 開始檢測用戶檔案（頁面切換）...'); // 已關閉日誌
          try {
            detectUserProfile();
          } catch (error) {
            console.error('[Gemini 分類助手] [URL檢查] 檢測用戶檔案時發生錯誤:', error);
            currentUserProfile = currentUserProfile || 'default';
          }
          // console.log('[Gemini 分類助手] [URL檢查] ✓ 當前用戶檔案:', currentUserProfile || 'default'); // 已關閉日誌
          
          currentChatId = chatId;
          currentTitle = null; // 重置標題，等待重新獲取
          extractionAttempts = 0; // 重置嘗試次數
          lastNotifiedData = null; // 重置最後通知的數據，確保新對話能通知
          
          // 重置消息記錄狀態（新對話開始）
          recordedMessages.clear();
          lastMessageCount = 0;
          
          // 設置標題監測（確保標題加載後能被抓取）
          setupTitleMonitoring();
          
          // 設置消息監測（開始監控對話內容）
          setupMessageMonitoring(); // 這會自動調用 setupImageMonitoring()
          
          // 立即執行一次圖片提取（查找頁面上已存在的圖片）
          console.log('[Gemini 分類助手] [圖片追蹤] 🔍 開始追蹤圖片（新對話）...');
          setTimeout(() => {
            extractGeneratedImages();
          }, 1000);
            
            // 等待一小段時間後再提取（給頁面時間渲染）
            setTimeout(() => {
              console.log('[Gemini 分類助手] [標題提取] 開始提取新對話的標題（500ms 後）...');
              extractionAttempts = 0; // 重置計數
              extractTitle();
              // 同時提取圖片
              extractGeneratedImages();
            }, 500);
            
            // 再等待一段時間後再次嘗試（確保動態內容已加載）
            setTimeout(() => {
              const genericTitles = ['對話', 'Conversation', '和 Gemini 的對話', 'Google Gemini'];
              if (!currentTitle || genericTitles.includes(currentTitle)) {
                console.log('[Gemini 分類助手] [標題提取] 再次嘗試提取標題（2s 後，動態內容可能已加載）...');
                extractionAttempts = 0; // 重置計數
                // 再次檢測用戶檔案（以防頁面完全加載後才顯示）
                try {
                  detectUserProfile();
                } catch (error) {
                  console.error('[Gemini 分類助手] [標題提取] 檢測用戶檔案時發生錯誤:', error);
                }
                extractTitle();
              }
            }, 2000);
            
            // 第三次嘗試（等待更長時間，確保側邊欄已完全加載）
            setTimeout(() => {
              const genericTitles = ['對話', 'Conversation', '和 Gemini 的對話', 'Google Gemini'];
              if (!currentTitle || genericTitles.includes(currentTitle)) {
                console.log('[Gemini 分類助手] [標題提取] 第三次嘗試提取標題（5s 後，側邊欄應已完全加載）...');
                extractionAttempts = 0; // 重置計數
                // 再次檢測用戶檔案（確保是最新的）
                try {
                  detectUserProfile();
                } catch (error) {
                  console.error('[Gemini 分類助手] [標題提取] 檢測用戶檔案時發生錯誤:', error);
                }
                extractTitle();
              }
            }, 5000);
        } else {
          // 同一個對話，但可能需要更新標題和用戶檔案
          // 定期重新檢測用戶檔案（以防頁面切換但 URL 沒變）
          if (!currentTitle) {
            console.log('[Gemini 分類助手] [標題提取] 同一個對話但標題為空，嘗試重新提取...');
            // 先檢測用戶檔案
            try {
              detectUserProfile();
            } catch (error) {
              console.error('[Gemini 分類助手] [URL檢查] 檢測用戶檔案時發生錯誤:', error);
            }
            extractTitle();
          } else {
            // 即使有標題，也定期檢測用戶檔案（每 10 次 URL 檢查檢測一次）
            if (urlCheckCount % 10 === 0) {
              // console.log('[Gemini 分類助手] [URL檢查] 定期檢測用戶檔案...'); // 已關閉日誌
              try {
                detectUserProfile();
              } catch (error) {
                console.error('[Gemini 分類助手] [URL檢查] 檢測用戶檔案時發生錯誤:', error);
                // 不影響其他功能，繼續執行
              }
            }
          }
          
          // 確保消息監控正在運行（同一個對話時也應該持續監聽新消息）
          if (!messageObserver) {
            console.log('[Gemini 分類助手] [消息監測] 同一個對話但消息監控未運行，重新設置...');
            setupMessageMonitoring();
          }
          
          // 定期觸發一次消息提取（每 5 次 URL 檢查提取一次，確保新消息能被捕獲）
          if (urlCheckCount % 5 === 0) {
            console.log('[Gemini 分類助手] [對話提取] 定期提取消息（同一個對話）...');
            setTimeout(() => {
              if (isRuntimeValid() && currentChatId === chatId) {
                scrapeMessages();
              }
            }, 500);
          }
        }
      } else {
        // URL 中沒有對話 ID，可能是在主頁面
        // console.log('[Gemini 分類助手] [URL檢查] ⚠️ URL 中沒有找到 /app/{chatId} 模式'); // 已關閉日誌
        if (currentChatId !== null) {
          // console.log('[Gemini 分類助手] [URL檢查] 離開對話頁面，清除當前對話'); // 已關閉日誌
          currentChatId = null;
          currentTitle = null;
          // 停止強制提取定時器
          stopForceExtractInterval();
          notifyConversationChange(null, null);
          
          // 停止消息監控
          if (messageObserver) {
            messageObserver.disconnect();
            messageObserver = null;
          }
          recordedMessages.clear();
          lastMessageCount = 0;
        }
      }
    } catch (error) {
      console.error('[Gemini 分類助手] [URL檢查] ❌ 檢查 URL 時發生錯誤:', error);
    }
  }

  // 設置標題監測（使用 MutationObserver）
  function setupTitleMonitoring() {
    if (!currentChatId) {
      console.log('[Gemini 分類助手] [MutationObserver] 跳過設置，因為沒有當前對話 ID');
      return;
    }

    // 如果已有觀察器，先停止它
    if (titleObserver) {
      console.log('[Gemini 分類助手] [MutationObserver] 停止舊的觀察器');
      titleObserver.disconnect();
    }

    // 創建新的觀察器（使用 observerManager，如果可用）
    if (typeof observerManager !== 'undefined' && observerManager && typeof observerManager.create === 'function') {
      titleObserver = observerManager.create('titleObserver', document.body, (mutations) => {
        // 檢查 runtime 是否有效，如果無效則停止觀察
        if (!isRuntimeValid()) {
          console.warn('[Gemini 分類助手] [MutationObserver] ⚠️ 擴展上下文已失效，停止觀察');
          console.warn('[Gemini 分類助手] [MutationObserver] 💡 提示: 這通常發生在擴展被重新加載時，請刷新頁面以恢復功能');
          if (typeof observerManager !== 'undefined' && observerManager) {
            observerManager.disconnect('titleObserver');
          }
          if (titleObserver) {
            titleObserver.disconnect();
            titleObserver = null;
          }
          return;
        }
      
      // 只有在還沒有標題時才頻繁嘗試
      if (!currentTitle && extractionAttempts < MAX_EXTRACTION_ATTEMPTS) {
        console.log('[Gemini 分類助手] [MutationObserver] DOM 變化檢測到，嘗試提取標題 (嘗試次數:', extractionAttempts + 1, ')');
        try {
          extractTitle();
        } catch (error) {
          // 如果提取標題時發生錯誤（可能是 runtime 失效），停止觀察
          const errorMessage = error.message || error.toString();
          if (errorMessage.includes('Extension context invalidated') || 
              errorMessage.includes('message port closed')) {
            console.warn('[Gemini 分類助手] [MutationObserver] ⚠️ 擴展上下文已失效，停止觀察');
            console.warn('[Gemini 分類助手] [MutationObserver] 💡 提示: 這通常發生在擴展被重新加載時，請刷新頁面以恢復功能');
            if (titleObserver) {
              titleObserver.disconnect();
              titleObserver = null;
            }
          }
        }
      }
      });
      
      // 觀察整個文檔的變化
      if (document.body) {
        titleObserver.observe(document.body, {
          childList: true,
          subtree: true,
          characterData: true,
          attributes: true,
          attributeFilter: ['class', 'data-testid', 'aria-label']
        });
        console.log('[Gemini 分類助手] [MutationObserver] ✓ MutationObserver 已設置，觀察 document.body');
      } else {
        console.error('[Gemini 分類助手] [MutationObserver] ❌ document.body 不存在，無法設置觀察器');
      }
    } else {
      // 如果 observerManager 不可用，直接創建 MutationObserver
      console.warn('[Gemini 分類助手] [MutationObserver] ⚠️ observerManager 不可用，使用直接方式創建觀察器');
      titleObserver = new MutationObserver((mutations) => {
        // 檢查 runtime 是否有效，如果無效則停止觀察
        if (!isRuntimeValid()) {
          console.warn('[Gemini 分類助手] [MutationObserver] ⚠️ 擴展上下文已失效，停止觀察');
          console.warn('[Gemini 分類助手] [MutationObserver] 💡 提示: 這通常發生在擴展被重新加載時，請刷新頁面以恢復功能');
          if (titleObserver) {
            titleObserver.disconnect();
            titleObserver = null;
          }
          return;
        }
        
        // 只有在還沒有標題時才頻繁嘗試
        if (!currentTitle && extractionAttempts < MAX_EXTRACTION_ATTEMPTS) {
          console.log('[Gemini 分類助手] [MutationObserver] DOM 變化檢測到，嘗試提取標題 (嘗試次數:', extractionAttempts + 1, ')');
          try {
            extractTitle();
          } catch (error) {
            // 如果提取標題時發生錯誤（可能是 runtime 失效），停止觀察
            const errorMessage = error.message || error.toString();
            if (errorMessage.includes('Extension context invalidated') || 
                errorMessage.includes('message port closed')) {
              console.warn('[Gemini 分類助手] [MutationObserver] ⚠️ 擴展上下文已失效，停止觀察');
              console.warn('[Gemini 分類助手] [MutationObserver] 💡 提示: 這通常發生在擴展被重新加載時，請刷新頁面以恢復功能');
              if (titleObserver) {
                titleObserver.disconnect();
                titleObserver = null;
              }
            }
          }
        }
      });
      
      // 觀察整個文檔的變化
      if (document.body) {
        titleObserver.observe(document.body, {
          childList: true,
          subtree: true,
          characterData: true,
          attributes: true,
          attributeFilter: ['class', 'data-testid', 'aria-label']
        });
        console.log('[Gemini 分類助手] [MutationObserver] ✓ MutationObserver 已設置（直接方式），觀察 document.body');
      } else {
        console.error('[Gemini 分類助手] [MutationObserver] ❌ document.body 不存在，無法設置觀察器');
      }
    }
  }

  // 提取對話標題
  function extractTitle() {
    if (!currentChatId) {
      console.log('[Gemini 分類助手] [標題提取] 跳過提取，因為沒有當前對話 ID');
      return;
    }

    extractionAttempts++;
    
    // 如果嘗試太多次仍未找到標題，減少嘗試頻率
    if (extractionAttempts > MAX_EXTRACTION_ATTEMPTS) {
      if (extractionAttempts % 10 !== 0) return; // 每 10 次才嘗試一次
    }

    try {
      let title = null;
      let foundBy = null;

      console.log('[Gemini 分類助手] [標題提取] ========== 開始提取標題 (嘗試 #' + extractionAttempts + ') ==========');
      console.log('[Gemini 分類助手] [標題提取] 當前 URL:', window.location.href);
      console.log('[Gemini 分類助手] [標題提取] 當前 ChatId:', currentChatId);
      
      // 調試：輸出頁面結構信息
      if (extractionAttempts === 1) {
        console.log('[Gemini 分類助手] [標題提取] [調試] 頁面結構分析:');
        console.log('[Gemini 分類助手] [標題提取] [調試] - document.title:', document.title);
        console.log('[Gemini 分類助手] [標題提取] [調試] - h1 數量:', document.querySelectorAll('h1').length);
        console.log('[Gemini 分類助手] [標題提取] [調試] - 所有 h1 文本:', Array.from(document.querySelectorAll('h1')).map(h => h.innerText || h.textContent).filter(t => t.trim()));
        console.log('[Gemini 分類助手] [標題提取] [調試] - 包含 /app/ 的鏈接數量:', document.querySelectorAll('a[href*="/app/"]').length);
        console.log('[Gemini 分類助手] [標題提取] [調試] - 前 5 個包含 /app/ 的鏈接:', Array.from(document.querySelectorAll('a[href*="/app/"]')).slice(0, 5).map(a => ({
          href: a.href,
          text: (a.innerText || a.textContent || '').trim().substring(0, 50),
          ariaLabel: a.getAttribute('aria-label') || ''
        })));
      }

      // 策略 0: 優先從側邊欄對話列表區域查找（最可靠，因為側邊欄通常有真實的對話標題）
      console.log('[Gemini 分類助手] [標題提取] 策略 0: 優先從側邊欄對話列表區域查找當前對話標題...');
      try {
        // 策略 0.0: 首先查找側邊欄中當前選中/激活的對話項（最準確）
        console.log('[Gemini 分類助手] [標題提取] 策略 0.0: 查找側邊欄中當前選中的對話項...');
        const selectedSelectors = [
          'a[href*="/app/' + currentChatId + '"][aria-current="page"]',
          'a[href*="/app/' + currentChatId + '"]:has(+ *[aria-selected="true"])',
          '[aria-selected="true"] a[href*="/app/' + currentChatId + '"]',
          '[aria-current="page"] a[href*="/app/' + currentChatId + '"]',
          '[class*="selected"] a[href*="/app/' + currentChatId + '"]',
          '[class*="active"] a[href*="/app/' + currentChatId + '"]'
        ];
        
        for (const selector of selectedSelectors) {
          try {
            const selectedLink = document.querySelector(selector);
            if (selectedLink) {
              console.log('[Gemini 分類助手] [標題提取] 策略 0.0: 找到選中的對話鏈接');
              const clonedLink = selectedLink.cloneNode(true);
              const children = clonedLink.children;
              for (let i = children.length - 1; i >= 0; i--) {
                children[i].remove();
              }
              let text = clonedLink.textContent || clonedLink.innerText || '';
              
              if (!text || text.trim().length < 2) {
                const listItem = selectedLink.closest('li, [role="listitem"], [class*="conversation"], [class*="chat"], [class*="thread"]');
                if (listItem) {
                  const itemText = listItem.innerText || listItem.textContent || '';
                  text = itemText.split('\n')[0].trim();
                }
              }
              
              const textTrimmed = text.trim();
              if (textTrimmed && textTrimmed.length >= 2 && textTrimmed.length <= 300) {
                title = textTrimmed;
                foundBy = 'sidebar-selected-item (strategy 0.0)';
                console.log('[Gemini 分類助手] [標題提取] ✓ 策略 0.0 成功: 從選中項找到標題:', title);
                break;
              }
            }
          } catch (e) {
            // 某些選擇器可能不支持（如 :has()），繼續下一個
            continue;
          }
        }
        
        // 策略 0.1: 精確查找包含當前 chatId 的鏈接
        if (!title) {
          console.log('[Gemini 分類助手] [標題提取] 策略 0.1: 精確查找包含 chatId 的鏈接 (chatId: ' + currentChatId + ')...');
          const exactLinkSelector = 'a[href*="/app/' + currentChatId + '"]';
          const exactLinks = document.querySelectorAll(exactLinkSelector);
          console.log('[Gemini 分類助手] [標題提取] 找到', exactLinks.length, '個精確匹配的鏈接');
          
          for (const link of exactLinks) {
          // 獲取鏈接的直接文本（不包含子元素）
          let text = '';
          
          // 方法1: 獲取鏈接的直接文本內容（不包含子元素）
          const clonedLink = link.cloneNode(true);
          // 移除所有子元素，只保留文本
          const children = clonedLink.children;
          for (let i = children.length - 1; i >= 0; i--) {
            children[i].remove();
          }
          text = clonedLink.textContent || clonedLink.innerText || '';
          
          // 如果直接文本為空，從父元素獲取（但要確保在對話列表區域）
          if (!text || text.trim().length < 3) {
            // 查找最近的列表項或對話項容器
            const listItem = link.closest('li, [role="listitem"], [class*="conversation"], [class*="chat"], [class*="thread"]');
            if (listItem) {
              // 只取第一行文本（標題通常在列表項的第一行）
              const itemText = listItem.innerText || listItem.textContent || '';
              const firstLine = itemText.split('\n')[0].trim();
              if (firstLine && firstLine.length > 2) {
                text = firstLine;
              }
            }
          }
          
          console.log('[Gemini 分類助手] [標題提取] 鏈接文本候選:', text.trim().substring(0, 100));
          
          // 排除導航菜單項和通用文本
          const excludedPatterns = [
            /^(Gemini|Chat|對話|Conversation|New Chat|Google|新的對話|和 Gemini 的對話|新的|New|Menu|Settings|收合選單|我的內容|我的|內容|Gem|程式夥伴|對話列表|Conversation List|新的對話|New Conversation|開始對話|Start Chat)$/i,
            /^(我的|內容|選單|Menu|設定|Settings|導航|Navigation)$/i
          ];
          
          const textTrimmed = text.trim();
          
          // 檢查是否是導航菜單文本（通常是短且常見的導航詞）
          const isNavigationText = excludedPatterns.some(p => p.test(textTrimmed)) || 
                                   textTrimmed.length < 5 || 
                                   textTrimmed.length > 200;
          
          // 額外檢查：如果文本是"我的內容"等，明確排除
          const excludedTexts = ['我的內容', '我的', '內容', 'Gem', '程式夥伴', '幽默一點', '幽默', '一點'];
          if (excludedTexts.includes(textTrimmed)) {
            console.log('[Gemini 分類助手] [標題提取] 鏈接文本是導航菜單項或通用文本，明確排除:', textTrimmed);
            continue;
          }
          
          // 優先選擇在對話列表區域且長度符合要求的鏈接
          const isInConversationList = link.closest('[class*="conversation"], [class*="chat"], [class*="thread"], [role="list"]') !== null;
          
          if (isInConversationList && textTrimmed.length >= 2 && textTrimmed.length <= 300) {
            // 如果在對話列表區域，即使看起來像通用文本也接受（因為這就是實際顯示的標題）
            title = textTrimmed;
            foundBy = 'sidebar-exact-link (strategy 0.1)';
            console.log('[Gemini 分類助手] [標題提取] ✓ 策略 0.1 成功: 從精確鏈接找到標題:', title);
            break;
          } else if (!isNavigationText && textTrimmed.length >= 5) {
            title = textTrimmed;
            foundBy = 'sidebar-exact-link (strategy 0.1)';
            console.log('[Gemini 分類助手] [標題提取] ✓ 策略 0.1 成功: 從精確鏈接找到標題:', title);
            break;
          } else {
            console.log('[Gemini 分類助手] [標題提取] 鏈接文本被排除:', textTrimmed, '(isNavigation:', isNavigationText, ', length:', textTrimmed.length, ')');
            }
          }
        }
        
        // 如果精確查找沒找到，嘗試從對話列表區域查找
        if (!title) {
          console.log('[Gemini 分類助手] [標題提取] 策略 0.2: 從對話列表區域查找...');
          
          // 查找所有包含 /app/ 的鏈接，但只在對話列表區域
          const conversationListSelectors = [
            '[class*="conversation-list"] a[href*="/app/"]',
            '[class*="chat-list"] a[href*="/app/"]',
            '[class*="thread-list"] a[href*="/app/"]',
            '[role="list"] a[href*="/app/"]',
            'ul[class*="conversation"] a[href*="/app/"]',
            'div[class*="conversation"] a[href*="/app/"]'
          ];
          
          let foundInListArea = false;
          for (const selector of conversationListSelectors) {
            try {
              const links = document.querySelectorAll(selector);
              console.log('[Gemini 分類助手] [標題提取] 策略 0.1 選擇器', selector, '找到', links.length, '個鏈接');
              
              for (const link of links) {
                const href = link.getAttribute('href') || '';
                if (href.includes(currentChatId)) {
                  console.log('[Gemini 分類助手] [標題提取] 在對話列表區域找到匹配鏈接:', href);
                  
                  // 獲取鏈接的直接文本
                  const clonedLink = link.cloneNode(true);
                  const children = clonedLink.children;
                  for (let i = children.length - 1; i >= 0; i--) {
                    children[i].remove();
                  }
                  let text = clonedLink.textContent || clonedLink.innerText || '';
                  
                  if (!text || text.trim().length < 3) {
                    const listItem = link.closest('li, [role="listitem"]');
                    if (listItem) {
                      const itemText = listItem.innerText || listItem.textContent || '';
                      text = itemText.split('\n')[0].trim();
                    }
                  }
                  
                  const excludedPatterns = [
                    /^(Gemini|Chat|對話|Conversation|New Chat|Google|新的對話|和 Gemini 的對話|新的|New|Menu|Settings|我的內容|我的|內容|Gem|程式夥伴|幽默一點|幽默|一點)$/i
                  ];
                  
                  const textTrimmed = text.trim();
                  const isNavigationText = excludedPatterns.some(p => p.test(textTrimmed)) || 
                                           textTrimmed.length < 5 || 
                                           textTrimmed.length > 200;
                  
                  if (!isNavigationText && textTrimmed.length >= 2 && textTrimmed.length <= 300) {
                    title = textTrimmed;
                    foundBy = 'sidebar-list-area (strategy 0.2)';
                    console.log('[Gemini 分類助手] [標題提取] ✓ 策略 0.2 成功: 從對話列表區域找到標題:', title);
                    foundInListArea = true;
                    break;
                  }
                }
              }
              if (foundInListArea) break;
            } catch (e) {
              console.log('[Gemini 分類助手] [標題提取] 策略 0.1 選擇器', selector, '查詢出錯:', e.message);
            }
          }
        }
        
        // 最後備選：查找所有包含 /app/ 的鏈接，但更嚴格地過濾
        if (!title) {
          console.log('[Gemini 分類助手] [標題提取] 策略 0.3: 查找所有包含 /app/ 的鏈接（嚴格過濾）...');
          const allAppLinks = document.querySelectorAll('a[href*="/app/"]');
          console.log('[Gemini 分類助手] [標題提取] 找到', allAppLinks.length, '個包含 /app/ 的鏈接');
          
          for (const link of allAppLinks) {
            const href = link.getAttribute('href') || '';
            if (href.includes(currentChatId)) {
              console.log('[Gemini 分類助手] [標題提取] 找到匹配的鏈接:', href);
              
              // 獲取鏈接的直接文本（不包含子元素）
              const clonedLink = link.cloneNode(true);
              const children = clonedLink.children;
              for (let i = children.length - 1; i >= 0; i--) {
                children[i].remove();
              }
              let text = clonedLink.textContent || clonedLink.innerText || '';
              
              // 如果直接文本為空，從父元素獲取（但要排除導航區域）
              if (!text || text.trim().length < 3) {
                const listItem = link.closest('li, [role="listitem"], [class*="conversation"], [class*="chat"]');
                if (listItem) {
                  // 檢查是否在導航菜單區域（通常包含"我的內容"等文本）
                  const parentText = listItem.closest('nav, [role="navigation"], [class*="sidebar"], [class*="nav"]')?.innerText || '';
                  if (parentText.includes('我的內容') || parentText.includes('Gem') || parentText.includes('程式夥伴')) {
                    // 跳過導航菜單區域
                    console.log('[Gemini 分類助手] [標題提取] 跳過導航菜單區域的鏈接');
                    continue;
                  }
                  
                  const itemText = listItem.innerText || listItem.textContent || '';
                  text = itemText.split('\n')[0].trim();
                }
              }
              
              const textTrimmed = text.trim();
              
              // 嚴格過濾：排除導航文本和短文本
              const excludedPatterns = [
                /^(我的內容|我的|內容|Gem|程式夥伴|收合選單|Menu|Settings|新的對話|New Conversation|對話|Conversation|Gemini|Chat|Google)$/i
              ];
              
              const isNavigationText = excludedPatterns.some(p => p.test(textTrimmed)) || 
                                       textTrimmed.length < 5 || 
                                       textTrimmed.length > 200;
              
              if (!isNavigationText && textTrimmed.length >= 5 && textTrimmed.length <= 300) {
                title = textTrimmed;
                foundBy = 'sidebar-strict-filter (strategy 0.3)';
                console.log('[Gemini 分類助手] [標題提取] ✓ 策略 0.3 成功: 從嚴格過濾鏈接找到標題:', title);
                break;
              } else {
                console.log('[Gemini 分類助手] [標題提取] 鏈接文本被排除:', textTrimmed);
              }
            }
          }
        }
      } catch (e) {
        console.log('[Gemini 分類助手] [標題提取] 策略 0 執行出錯:', e.message);
        console.error(e);
      }

      // 策略 1: 查找頁面頂部區域的對話標題（作為備選）
      if (!title) {
        console.log('[Gemini 分類助手] [標題提取] 策略 1: 查找頁面頂部區域的對話標題...');
        
        // 先查找主聊天區域的標題容器
        const mainContentSelectors = [
          '[role="main"] > div > div > h1',
          '[role="main"] h1:first-of-type',
          'div[class*="chat"] h1',
          'div[class*="conversation"] h1',
          'div[class*="thread"] h1',
          'header h1',
          'div[class*="header"] h1',
          'div[class*="title"] h1',
          'h1[class*="title"]'
        ];

        for (const selector of mainContentSelectors) {
          try {
            const element = document.querySelector(selector);
            if (element) {
              const text = element.innerText || element.textContent || '';
              console.log('[Gemini 分類助手] [標題提取] 策略 1 候選:', selector, '=', text.trim().substring(0, 50));
              
              if (text.trim() && text.trim().length > 2) {
                const excludedPatterns = [
                  /^(Gemini|Chat|New Chat|對話|Conversation|和 Gemini 的對話)$/i, 
                  /^Google$/i,
                  /^(新的對話|New Conversation|開始對話|Start Chat)$/i
                ];
                const shouldExclude = excludedPatterns.some(pattern => pattern.test(text.trim()));
                
                if (!shouldExclude && text.trim().length > 2 && text.trim().length < 200) {
                  title = text.trim();
                  foundBy = 'main-content-h1 (' + selector + ')';
                  console.log('[Gemini 分類助手] [標題提取] ✓ 策略 1 成功: 從', selector, '找到標題:', title);
                  break;
                }
              }
            }
          } catch (e) {
            // 某些選擇器可能出錯，繼續下一個
          }
        }

        // 如果策略 1 沒找到，嘗試查找所有 h1（作為備選）
        if (!title) {
          console.log('[Gemini 分類助手] [標題提取] 策略 1.1: 查找所有 h1 標籤...');
          const h1Elements = document.querySelectorAll('h1');
          console.log('[Gemini 分類助手] [標題提取] 找到', h1Elements.length, '個 h1 標籤');
          
          for (const h1 of h1Elements) {
            const text = h1.innerText || h1.textContent || '';
            console.log('[Gemini 分類助手] [標題提取] h1 內容:', text.trim().substring(0, 50));
            
            if (text.trim() && text.trim().length > 2) {
              // 排除通用文本
              const excludedPatterns = [
                /^(Gemini|Chat|New Chat|對話|Conversation|和 Gemini 的對話)$/i, 
                /^Google$/i,
                /^(新的對話|New Conversation|開始對話|Start Chat)$/i
              ];
              const shouldExclude = excludedPatterns.some(pattern => pattern.test(text.trim()));
              
              if (!shouldExclude && text.trim().length < 200) {
                title = text.trim();
                foundBy = 'h1-fallback';
                console.log('[Gemini 分類助手] [標題提取] ✓ 策略 1.1 成功: 從 h1 找到標題:', title);
                break;
              } else {
                console.log('[Gemini 分類助手] [標題提取] h1 內容被排除:', text.trim());
              }
            }
          }
        }
      }

      // 策略 2: 查找 role="main" 區域內的標題
      if (!title) {
        console.log('[Gemini 分類助手] [標題提取] 策略 2: 查找 role="main" 區域...');
        const mainElement = document.querySelector('[role="main"]');
        if (mainElement) {
          console.log('[Gemini 分類助手] [標題提取] ✓ 找到 role="main" 元素');
          
          // 在 main 區域內查找 h1 或具有特定類名的元素
          const mainH1 = mainElement.querySelector('h1');
          if (mainH1) {
            const text = mainH1.innerText || mainH1.textContent || '';
            const excludedPatterns = [/^(Gemini|Chat|對話|Conversation|New Chat)$/i];
            if (text.trim() && text.trim().length > 2 && !excludedPatterns.some(p => p.test(text.trim()))) {
              title = text.trim();
              foundBy = 'role=main > h1';
              console.log('[Gemini 分類助手] [標題提取] ✓ 策略 2 成功: 從 role="main" > h1 找到標題:', title);
            }
          }

          // 如果還是沒找到，查找 main 區域內的其他標題元素
          if (!title) {
            const titleSelectors = [
              '[data-title]',
              '[aria-label*="title"]',
              '[class*="title"]',
              '[class*="Title"]',
              '[data-testid*="title"]',
              '[data-testid*="Title"]',
              '[role="heading"]'
            ];

            for (const selector of titleSelectors) {
              const element = mainElement.querySelector(selector);
              if (element) {
                const text = element.innerText || element.textContent || element.getAttribute('aria-label') || '';
                if (text.trim() && text.trim().length > 2 && !text.trim().match(/^(Gemini|Chat)$/i)) {
                  title = text.trim();
                  foundBy = 'role=main > ' + selector;
                  console.log('[Gemini 分類助手] [標題提取] ✓ 策略 2 成功: 從', foundBy, '找到標題:', title);
                  break;
                }
              }
            }
          }
        } else {
          console.log('[Gemini 分類助手] [標題提取] ⚠️ 未找到 role="main" 元素');
        }
      }

      // 策略 3: 查找特定的標題選擇器（擴展搜索，但只匹配當前對話的標題）
      if (!title) {
        console.log('[Gemini 分類助手] [標題提取] 策略 3: 使用擴展選擇器搜索（只匹配當前對話）...');
        const titleSelectors = [
          '[data-title]',
          '[aria-label*="title"]',
          '[aria-label*="conversation"]',
          '[aria-label*="chat"]',
          '[class*="conversation-title"]',
          '[class*="chat-title"]',
          '[class*="thread-title"]',
          '[data-testid*="title"]',
          '[data-testid*="Title"]',
          '[data-testid*="conversation-title"]',
          '[role="heading"][aria-level="1"]',
          '[role="heading"][aria-level="2"]',
          'h1[class*="title"]',
          // 注意：只在對話區域查找
          '[role="main"] [class*="title"]',
          '[role="main"] div[class*="title"]',
          'div[class*="conversation"] [class*="title"]',
          'div[class*="chat"] [class*="title"]'
        ];

        for (const selector of titleSelectors) {
          try {
            // 查找所有匹配的元素，而不是只找第一個
            const elements = document.querySelectorAll(selector);
            console.log('[Gemini 分類助手] [標題提取] 選擇器', selector, '找到', elements.length, '個元素');
            
            for (const element of elements) {
              // 關鍵：驗證元素是否屬於當前對話
              // 檢查元素或其父容器是否包含當前 URL 或 chatId
              const elementContainer = element.closest('[href*="/app/' + currentChatId + '"], a[href*="/app/' + currentChatId + '"]') ||
                                      element.closest('[data-chat-id="' + currentChatId + '"]') ||
                                      element.closest('[class*="' + currentChatId + '"]');
              
              // 檢查是否在側邊欄中（側邊欄元素不應該匹配，除非是當前選中的對話）
              const isInSidebar = element.closest('nav, [role="navigation"], [class*="sidebar"]') !== null;
              if (isInSidebar && !elementContainer) {
                // 在側邊欄中但不是當前對話的鏈接，跳過
                continue;
              }
              
              // 檢查元素是否在導航菜單區域（但不是對話列表）
              const navParent = element.closest('nav, [role="navigation"]');
              if (navParent) {
                const navText = navParent.innerText || navParent.textContent || '';
                // 如果包含導航菜單關鍵詞且不在對話列表中，跳過
                if ((navText.includes('我的內容') || navText.includes('Gem') || navText.includes('程式夥伴') || 
                    navText.includes('收合選單') || navText.includes('Menu') || navText.includes('Settings')) &&
                    !element.closest('[class*="conversation"], [class*="chat"], [class*="thread"], [role="list"]')) {
                  console.log('[Gemini 分類助手] [標題提取] 選擇器', selector, '在導航菜單區域，跳過');
                  continue;
                }
              }
              
              // 優先選擇屬於當前對話的元素，如果沒有則考慮主內容區域的元素
              const isInMainContent = element.closest('[role="main"], main, [class*="main-content"], [class*="chat-container"]') !== null;
              
              const text = element.innerText || element.textContent || element.getAttribute('aria-label') || '';
              const textTrimmed = text.trim();
              
              if (!textTrimmed || textTrimmed.length < 2 || textTrimmed.length > 300) {
                continue;
              }
              
              console.log('[Gemini 分類助手] [標題提取] 選擇器', selector, '找到內容:', textTrimmed.substring(0, 50), '(屬於當前對話:', !!elementContainer, ', 在主內容區:', isInMainContent, ')');
              
              const excludedPatterns = [
                /^(Gemini|Chat|對話|Conversation|New Chat|Google|新的對話|和 Gemini 的對話|我的內容|我的|內容|Gem|程式夥伴|收合選單|Menu|Settings|新的|New)$/i,
                /^(我的|內容|選單|設定|導航|Navigation)$/i
              ];
              
              const isNavigationText = excludedPatterns.some(p => p.test(textTrimmed));
              
              // 如果元素屬於當前對話或主內容區域，更寬鬆地接受（允許短標題）
              if (elementContainer || isInMainContent) {
                if (!isNavigationText && textTrimmed.length >= 2) {
                  // 在主內容區域，即使短標題也接受（如"繪圖1"）
                  title = textTrimmed;
                  if (elementContainer) {
                    foundBy = selector + ' (current conversation)';
                  } else {
                    foundBy = selector + ' (main content area, strategy 3)';
                  }
                  console.log('[Gemini 分類助手] [標題提取] ✓ 策略 3 成功: 從', selector, '找到標題 (主內容區):', title);
                  break;
                } else if (isNavigationText) {
                  console.log('[Gemini 分類助手] [標題提取] 跳過導航文本:', textTrimmed);
                }
              } else if (!isNavigationText && textTrimmed.length >= 5) {
                // 如果不在主內容區，要求更長（5個字符以上）作為備選
                title = textTrimmed;
                foundBy = selector + ' (fallback)';
                console.log('[Gemini 分類助手] [標題提取] ✓ 策略 3 備選: 從', selector, '找到標題:', title);
                break;
              } else {
                console.log('[Gemini 分類助手] [標題提取] 選擇器', selector, '找到的文本被排除:', textTrimmed, '(isNavigation:', isNavigationText, ', length:', textTrimmed.length, ')');
              }
            }
            
            if (title) break;
          } catch (e) {
            // 某些選擇器可能會出錯，繼續下一個
            console.log('[Gemini 分類助手] [標題提取] 選擇器', selector, '查詢出錯:', e.message);
          }
        }
      }

      // 策略 4: 從頁面標題提取
      if (!title && document.title) {
        console.log('[Gemini 分類助手] [標題提取] 策略 4: 從 document.title 提取...');
        console.log('[Gemini 分類助手] [標題提取] document.title:', document.title);
        
        // 嘗試多種格式
        let pageTitle = document.title;
        
        // 移除 "- Gemini" 或類似的後綴
        pageTitle = pageTitle.replace(/\s*[-–—]\s*Gemini.*$/i, '');
        pageTitle = pageTitle.replace(/\s*[-–—]\s*Google.*$/i, '');
        pageTitle = pageTitle.replace(/\s*\|\s*Gemini.*$/i, '');
        pageTitle = pageTitle.trim();
        
        const excludedTitlePatterns = [/^(Gemini|Chat|對話|Conversation|Google)$/i];
        if (pageTitle && pageTitle.length > 2 && !excludedTitlePatterns.some(p => p.test(pageTitle))) {
          title = pageTitle;
          foundBy = 'document.title';
          console.log('[Gemini 分類助手] [標題提取] ✓ 策略 4 成功: 從 document.title 找到標題:', title);
        } else {
          console.log('[Gemini 分類助手] [標題提取] ⚠️ document.title 不符合要求:', pageTitle);
        }
      }

      // 策略 5: 查找頁面上方區域的第一個有意義文本（作為最後手段）
      if (!title) {
        console.log('[Gemini 分類助手] [標題提取] 策略 5: 查找頁面上方區域...');
        try {
          // 查找頁面頂部的容器
          const topContainers = document.querySelectorAll('header, [role="banner"], [class*="header"], [class*="top"]');
          
          for (const container of topContainers) {
            const text = container.innerText || container.textContent || '';
            const lines = text.split('\n').map(line => line.trim()).filter(line => line.length > 2);
            
            for (const line of lines) {
              const excludedPatterns = [/^(Gemini|Chat|對話|Conversation|New Chat|Google|Menu|Settings|新的對話)$/i];
              if (!excludedPatterns.some(p => p.test(line)) && line.length > 2 && line.length < 100) {
                title = line;
                foundBy = 'top-container';
                console.log('[Gemini 分類助手] [標題提取] ✓ 策略 5 成功: 從頂部容器找到標題:', title);
                break;
              }
            }
            if (title) break;
          }
        } catch (e) {
          console.log('[Gemini 分類助手] [標題提取] 策略 5 執行出錯:', e.message);
        }
      }

      // 策略 6: 查找聊天區域的第一個用戶輸入或對話標題元素
      if (!title) {
        console.log('[Gemini 分類助手] [標題提取] 策略 6: 查找聊天區域...');
        try {
          // 查找可能包含對話標題的元素
          const chatAreaSelectors = [
            '[class*="chat-title"]',
            '[class*="conversation-title"]',
            '[class*="thread-title"]',
            '[data-chat-title]',
            '[data-conversation-title]',
            'div[role="main"] h1',
            'div[role="main"] h2',
            'div[role="main"] [class*="title"]'
          ];

          for (const selector of chatAreaSelectors) {
            const elements = document.querySelectorAll(selector);
            for (const element of elements) {
              const text = element.innerText || element.textContent || element.getAttribute('aria-label') || '';
              const excludedPatterns = [/^(Gemini|Chat|對話|Conversation|New Chat|Google)$/i];
              
              if (text.trim() && text.trim().length > 2 && 
                  !excludedPatterns.some(p => p.test(text.trim())) && 
                  text.trim().length < 200) {
                title = text.trim();
                foundBy = selector;
                console.log('[Gemini 分類助手] [標題提取] ✓ 策略 6 成功: 從', selector, '找到標題:', title);
                break;
              }
            }
            if (title) break;
          }
        } catch (e) {
          console.log('[Gemini 分類助手] [標題提取] 策略 6 執行出錯:', e.message);
        }
      }

      // 策略 7: 從側邊欄查找當前選中的對話標題（作為最後手段，如果策略0沒找到）
      if (!title) {
        console.log('[Gemini 分類助手] [標題提取] 策略 7: 從側邊欄查找當前選中的對話（備用策略）...');
        try {
          // 查找側邊欄中選中或活動的對話項目
          console.log('[Gemini 分類助手] [標題提取] 策略 7.1: 查找側邊欄選中項...');
          const sidebarSelectors = [
            '[class*="conversation-item"][aria-selected="true"]',
            '[class*="conversation-item"][class*="selected"]',
            '[class*="conversation-item"][class*="active"]',
            '[class*="chat-item"][aria-selected="true"]',
            '[class*="chat-item"][class*="selected"]',
            '[class*="thread-item"][aria-selected="true"]',
            'div[role="listitem"][aria-selected="true"]',
            'li[aria-selected="true"]',
            '[aria-current="page"]'
          ];

          for (const selector of sidebarSelectors) {
            const element = document.querySelector(selector);
            if (element) {
              const text = element.innerText || element.textContent || '';
              console.log('[Gemini 分類助手] [標題提取] 側邊欄選中項內容:', text.substring(0, 100));
              
              // 只取第一行（標題通常在列表項的第一行）
              const lines = text.split('\n').map(line => line.trim()).filter(line => line.length > 2);
              const excludedPatterns = [/^(Gemini|Chat|對話|Conversation|New Chat|Google|新的對話|和 Gemini 的對話|新的|New)$/i];
              
              for (const line of lines) {
                if (line.length > 2 && !excludedPatterns.some(p => p.test(line)) && line.length < 200) {
                  title = line;
                  foundBy = 'sidebar-selected';
                  console.log('[Gemini 分類助手] [標題提取] ✓ 策略 7.1 成功: 從側邊欄選中項找到標題:', title);
                  break;
                }
              }
              if (title) break;
            }
          }
        } catch (e) {
          console.log('[Gemini 分類助手] [標題提取] 策略 7 執行出錯:', e.message);
        }
      }

      // 處理提取結果
      // 如果找到標題，但標題是通用文本或導航菜單項，視為未找到
      const genericTitles = [
        '對話', 'Conversation', '和 Gemini 的對話', 'Google Gemini', 
        'Chat', 'New Chat', 'Gemini', 'Google', '新的對話', 'New Conversation',
        '我的內容', '我的', '內容', 'Gem', '程式夥伴', '收合選單',
        'Menu', 'Settings', '設定', '導航', 'Navigation',
        '幽默一點', '幽默', '一點' // 添加更多可能的通用文本
      ];
      
      if (title) {
        const titleTrimmed = title.trim();
        const titleLower = titleTrimmed.toLowerCase();
        const isGeneric = genericTitles.some(generic => 
          titleLower === generic.toLowerCase() || 
          titleLower.startsWith(generic.toLowerCase() + ' ') ||
          titleLower === '我的內容' || 
          titleLower === '我的' ||
          titleLower === '內容'
        );
        
        // 根據提取方式決定最小長度要求
        // 如果來自側邊欄或主內容區域（策略0、1、2、3），更寬鬆（允許2個字符以上）
        // 如果來自其他策略，較嚴格（要求5個字符以上）
        const isFromReliableSource = foundBy && (
          foundBy.includes('sidebar') || 
          foundBy.includes('strategy 0') || 
          foundBy.includes('strategy 1') ||
          foundBy.includes('strategy 2') ||
          foundBy.includes('strategy 3') ||
          foundBy.includes('current conversation') || // 策略3中來自當前對話的標題
          foundBy.includes('main content area') || // 策略3中來自主內容區域的標題
          foundBy.includes('main-content') ||
          foundBy.includes('main content') ||
          foundBy.includes('role=main') ||
          foundBy.includes('h1') ||
          foundBy.includes('conversation-title') || // 策略3使用的選擇器
          foundBy.includes('[class*="conversation-title"]') || // 完整選擇器
          foundBy.includes('[class*="chat-title"]') ||
          foundBy.includes('[class*="thread-title"]')
        );
        
        const minLength = isFromReliableSource ? 2 : 5; // 可靠來源允許2個字符，其他要求5個字符
        const isValidLength = titleTrimmed.length >= minLength && titleTrimmed.length <= 200;
        
        if (isGeneric || !isValidLength) {
          console.log('[Gemini 分類助手] [標題提取] ⚠️ 提取到的標題是通用文本或無效，視為未找到:', titleTrimmed, 
                     '(isGeneric:', isGeneric, ', isValidLength:', isValidLength, 
                     ', length:', titleTrimmed.length, ', minRequired:', minLength,
                     ', fromReliableSource:', isFromReliableSource, ')');
          title = null;
        }
      }

      // 在更新標題前，先從存儲中獲取已保存的標題（如果存在且更可靠）
      // 使用同步方式獲取存儲（避免異步問題）
      let finalTitle = title;
      let finalFoundBy = foundBy;
      
      if (title && currentChatId) {
        console.log('[Gemini 分類助手] [標題提取] 檢查存儲中是否有已保存的標題...');
        try {
          // 使用同步方式獲取（通過發送消息到 background）
          // 但這裡我們先檢查提取的標題是否是通用文本
          const genericTitles = [
            '對話', 'Conversation', '和 Gemini 的對話', 'Google Gemini', 
            'Chat', 'New Chat', 'Gemini', 'Google', '新的對話', 'New Conversation',
            '我的內容', '我的', '內容', 'Gem', '程式夥伴', '收合選單',
            'Menu', 'Settings', '設定', '導航', 'Navigation', '幽默一點', '幽默', '一點'
          ];
          
          const isExtractedTitleGeneric = genericTitles.some(g => title.toLowerCase() === g.toLowerCase());
          
          // 如果提取的標題是通用文本，標記為需要從存儲獲取
          if (isExtractedTitleGeneric) {
            console.log('[Gemini 分類助手] [標題提取] ⚠️ 提取的標題是通用文本:', title, '，將嘗試從存儲獲取');
            finalTitle = null; // 標記為需要從存儲獲取
          }
        } catch (e) {
          console.error('[Gemini 分類助手] [標題提取] 檢查標題時發生錯誤:', e);
        }
      }
      
      // 更新標題
      if (finalTitle && finalTitle !== currentTitle) {
        currentTitle = finalTitle;
        console.log('[Gemini 分類助手] [標題提取] ✨ 成功提取標題！');
        console.log('[Gemini 分類助手] [標題提取] 標題:', finalTitle);
        console.log('[Gemini 分類助手] [標題提取] 提取方式:', finalFoundBy);
        console.log('[Gemini 分類助手] [標題提取] 對話 ID:', currentChatId);
        
        // 重置嘗試次數，因為已經找到了
        extractionAttempts = 0;
        
        notifyConversationChange(currentChatId, currentTitle);
      } else if (finalTitle) {
        console.log('[Gemini 分類助手] [標題提取] 標題未改變，跳過通知 (當前標題:', currentTitle, ')');
      } else {
        console.log('[Gemini 分類助手] [標題提取] ❌ 未能提取有效標題 (嘗試 #' + extractionAttempts + ')');
        
        // 如果嘗試太多次仍未找到，嘗試從存儲中獲取
        if (extractionAttempts >= MAX_EXTRACTION_ATTEMPTS && currentChatId) {
          console.log('[Gemini 分類助手] [標題提取] ⚠️ 已達到最大嘗試次數，嘗試從存儲獲取標題...');
          // 異步從存儲獲取標題
          const storageKey = `conversationStates_${currentUserProfile || 'default'}`;
          chrome.storage.local.get([storageKey], (result) => {
            const conversationStates = result[storageKey] || {};
            const savedConversation = conversationStates[currentChatId];
            
            if (savedConversation && savedConversation.title) {
              const savedTitle = savedConversation.title.trim();
              const genericTitles = [
                '對話', 'Conversation', '和 Gemini 的對話', 'Google Gemini', 
                'Chat', 'New Chat', 'Gemini', 'Google', '新的對話', 'New Conversation',
                '我的內容', '我的', '內容', 'Gem', '程式夥伴', '收合選單',
                'Menu', 'Settings', '設定', '導航', 'Navigation', '幽默一點', '幽默', '一點'
              ];
              
              const isGeneric = genericTitles.some(g => savedTitle.toLowerCase() === g.toLowerCase());
              if (!isGeneric && savedTitle.length >= 2) {
                console.log('[Gemini 分類助手] [標題提取] ✓ 從存儲獲取標題:', savedTitle);
                currentTitle = savedTitle;
                notifyConversationChange(currentChatId, currentTitle);
                return;
              }
            }
            
            // 如果存儲中也沒有有效標題，發送 null
            if (currentTitle === null) {
              console.log('[Gemini 分類助手] [標題提取] 發送對話 ID（標題為 null）');
              notifyConversationChange(currentChatId, null);
            }
          });
        } else if (currentTitle === null) {
          notifyConversationChange(currentChatId, null);
        }
      }
    } catch (error) {
      console.error('[Gemini 分類助手] [標題提取] ❌ 提取標題時發生錯誤:', error);
      console.error('[Gemini 分類助手] [標題提取] 錯誤堆疊:', error.stack);
    }
  }

  // 根據指定的 chatId 提取對話標題（從側邊欄查找）
  // 驗證場景：只要找到匹配的鏈接就返回其文本，不嚴格排除通用文本
  function extractTitleByChatId(targetChatId) {
    if (!targetChatId) {
      console.log('[Gemini 分類助手] [標題驗證] 缺少 chatId，跳過提取');
      return null;
    }

    try {
      console.log('[Gemini 分類助手] [標題驗證] 開始為 chatId 提取標題:', targetChatId);
      
      // 策略：從側邊欄查找包含該 chatId 的鏈接
      const linkSelector = 'a[href*="/app/' + targetChatId + '"]';
      const links = document.querySelectorAll(linkSelector);
      console.log('[Gemini 分類助手] [標題驗證] 找到', links.length, '個包含該 chatId 的鏈接');
      
      for (const link of links) {
        // 檢查是否在對話列表區域（優先選擇對話列表中的鏈接）
        const isInConversationList = link.closest('[class*="conversation"], [class*="chat"], [class*="thread"], [role="list"], [class*="sidebar"]') !== null;
        
        // 排除明顯的導航菜單鏈接（不在對話列表中）
        const isInNavigationMenu = !isInConversationList && 
                                   link.closest('[role="navigation"], nav, [class*="navigation"], [class*="menu"]') !== null;
        
        if (isInNavigationMenu) {
          console.log('[Gemini 分類助手] [標題驗證] 跳過導航菜單中的鏈接');
          continue;
        }
        
        // 獲取鏈接的直接文本（不包含子元素）
        let text = '';
        
        // 方法1: 獲取鏈接的直接文本內容（不包含子元素）
        const clonedLink = link.cloneNode(true);
        // 移除所有子元素，只保留文本
        const children = clonedLink.children;
        for (let i = children.length - 1; i >= 0; i--) {
          children[i].remove();
        }
        text = clonedLink.textContent || clonedLink.innerText || '';
        
        // 如果直接文本為空或太短，從父元素獲取
        if (!text || text.trim().length < 2) {
          // 查找最近的列表項或對話項容器
          const listItem = link.closest('li, [role="listitem"], [class*="conversation"], [class*="chat"], [class*="thread"], div[class*="item"]');
          if (listItem) {
            // 只取第一行文本（標題通常在列表項的第一行）
            const itemText = listItem.innerText || listItem.textContent || '';
            const firstLine = itemText.split('\n')[0].trim();
            if (firstLine && firstLine.length >= 2) {
              text = firstLine;
            }
          }
        }
        
        const textTrimmed = text.trim();
        
        // 驗證場景：只要找到匹配 chatId 的鏈接且在對話列表區域，就接受其文本
        // 即使看起來像通用文本（如"對話"、"和 Gemini 的對話"），因為這就是在側邊欄顯示的標題
        if (textTrimmed && textTrimmed.length >= 2 && textTrimmed.length <= 300) {
          // 如果確實在對話列表區域，直接接受
          if (isInConversationList) {
            console.log('[Gemini 分類助手] [標題驗證] ✓ 從對話列表區域提取標題:', textTrimmed);
            return textTrimmed;
          }
          
          // 如果不在對話列表區域，但也不是明顯的導航文本，也接受
          const obviousNavigationTexts = ['我的內容', '我的', '內容', 'Gem', '程式夥伴', 
                                          'Menu', 'Settings', '設定', '選單', '導航', 'Navigation',
                                          '對話列表', 'Conversation List', '收合選單'];
          if (obviousNavigationTexts.indexOf(textTrimmed) === -1) {
            console.log('[Gemini 分類助手] [標題驗證] ✓ 提取標題（不在對話列表中但匹配 chatId）:', textTrimmed);
            return textTrimmed;
          }
        }
      }
      
      console.log('[Gemini 分類助手] [標題驗證] ❌ 未能提取有效標題 (chatId: ' + targetChatId + ')');
      return null;
    } catch (error) {
      console.error('[Gemini 分類助手] [標題驗證] 提取標題時發生錯誤:', error);
      return null;
    }
  }

  // 檢查 runtime 是否有效
  // 通知對話狀態變化
  function notifyConversationChange(chatId, title) {
    try {
      // 檢查 runtime 是否有效
      if (!isRuntimeValid()) {
        console.warn('[Gemini 分類助手] [通知] ⚠️ 擴展上下文已失效，跳過發送消息 (chatId:', chatId, ', title:', title || '(null)', ')');
        console.warn('[Gemini 分類助手] [通知] 💡 提示: 這通常發生在擴展被重新加載時，刷新頁面即可恢復');
        return;
      }

      // 確保用戶檔案已檢測（在頁面切換時應該已經檢測過，這裡作為備用）
      if (!currentUserProfile || currentUserProfile === 'default') {
        console.log('[Gemini 分類助手] [通知] ⚠️ 用戶檔案未檢測或為默認值，重新檢測...');
        try {
          detectUserProfile();
        } catch (error) {
          console.error('[Gemini 分類助手] [通知] 檢測用戶檔案時發生錯誤:', error);
          currentUserProfile = 'default';
        }
      }
      
      // 記錄當前用戶檔案（用於調試）
      console.log('[Gemini 分類助手] [通知] 當前用戶檔案:', currentUserProfile || 'default');
      
      const data = {
        chatId: chatId,
        title: title,
        url: window.location.href,
        timestamp: Date.now(),
        userProfile: currentUserProfile || 'default'
      };

      // 避免重複發送相同的數據
      if (lastNotifiedData && 
          lastNotifiedData.chatId === chatId && 
          lastNotifiedData.title === title &&
          lastNotifiedData.userProfile === data.userProfile) {
        console.log('[Gemini 分類助手] [通知] 跳過重複通知 (chatId:', chatId, ', title:', title, ', profile:', data.userProfile, ')');
        return;
      }

      lastNotifiedData = { ...data };

      console.log('[Gemini 分類助手] [通知] 📤 準備發送對話狀態變化:');
      console.log('[Gemini 分類助手] [通知]   - Chat ID:', chatId);
      console.log('[Gemini 分類助手] [通知]   - Title:', title || '(null)');
      console.log('[Gemini 分類助手] [通知]   - URL:', data.url);
      console.log('[Gemini 分類助手] [通知]   - User Profile:', data.userProfile);

      // 【修正通訊崩潰】所有 sendMessage 前必須加上檢查，防止 context invalidated 錯誤
      if (!chrome.runtime?.id) {
        // 靜默處理，不輸出警告（避免重複日誌）
        return;
      }
      
      // 發送消息到後台和 Side Panel
      if (!isRuntimeValid()) return;
      
      chrome.runtime.sendMessage({
        action: 'conversationStateChanged',
        data: data
      }).then(() => {
        console.log('[Gemini 分類助手] [通知] ✓ 消息發送成功');
      }).catch((error) => {
        // 檢查是否是擴展上下文失效的錯誤
        const errorMessage = error.message || error.toString();
        if (errorMessage.includes('Extension context invalidated') || 
            errorMessage.includes('message port closed') ||
            !isRuntimeValid()) {
          console.warn('[Gemini 分類助手] [通知] ⚠️ 擴展上下文已失效，無法發送消息');
          console.warn('[Gemini 分類助手] [通知] 💡 提示: 這通常發生在擴展被重新加載時，請刷新頁面以恢復功能');
          // 不要重試，因為上下文已失效
          return;
        }
        // 其他錯誤（如 Side Panel 或後台未開啟），這不是嚴重錯誤
        console.log('[Gemini 分類助手] [通知] ⚠️ 消息發送失敗 (可能接收方未開啟):', errorMessage);
      });

    } catch (error) {
      const errorMessage = error.message || error.toString();
      
      // 檢查是否是擴展上下文失效的錯誤
      if (errorMessage.includes('Extension context invalidated') || 
          errorMessage.includes('message port closed') ||
          !isRuntimeValid()) {
        console.warn('[Gemini 分類助手] [通知] ⚠️ 擴展上下文已失效');
        console.warn('[Gemini 分類助手] [通知] 💡 提示: 這通常發生在擴展被重新加載時，請刷新頁面以恢復功能');
        return;
      }
      
      // 其他錯誤
      console.error('[Gemini 分類助手] [通知] ❌ 通知對話狀態變化時發生錯誤:', error);
      console.error('[Gemini 分類助手] [通知] 錯誤堆疊:', error.stack);
    }
  }

  // 設置對話內容監測（監控消息變化）
  function setupMessageMonitoring() {
    // 即使沒有 currentChatId，也嘗試設置監控（用於檢測新對話）
    // 但優先檢查是否有 currentChatId
    if (!currentChatId) {
      console.log('[Gemini 分類助手] [消息監測] ⚠️ 沒有當前對話 ID，但仍設置監控以檢測新對話');
      // 不返回，繼續設置監控，這樣可以檢測到新對話
    }

    // 【修復】在創建觀察器前先檢查 runtime 是否有效
    if (!isRuntimeValid()) {
      console.warn('[Gemini 分類助手] [消息監測] ⚠️ 擴展上下文已失效，延遲設置監控...');
      console.warn('[Gemini 分類助手] [消息監測] 💡 提示: 這通常發生在擴展被重新加載時，請刷新頁面以恢復功能');
      // 設置定期檢查，當上下文恢復時自動重新設置
      const checkInterval = setInterval(() => {
        if (isRuntimeValid()) {
          console.log('[Gemini 分類助手] [消息監測] ✓ 擴展上下文已恢復，重新設置監控');
          clearInterval(checkInterval);
          setupMessageMonitoring();
        }
      }, 1000);
      
      // 30 秒後停止檢查（避免無限循環）
      setTimeout(() => {
        clearInterval(checkInterval);
      }, 30000);
      return;
    }

    // 如果已有觀察器，先停止它
    if (messageObserver) {
      console.log('[Gemini 分類助手] [消息監測] 停止舊的觀察器');
      messageObserver.disconnect();
    }

    // 創建新的觀察器
    messageObserver = new MutationObserver((mutations) => {
      // 檢查 runtime 是否有效
      if (!isRuntimeValid()) {
        console.warn('[Gemini 分類助手] [消息監測] ⚠️ 擴展上下文已失效，停止觀察');
        console.warn('[Gemini 分類助手] [消息監測] 💡 提示: 這通常發生在擴展被重新加載時，請刷新頁面以恢復功能');
        if (messageObserver) {
          messageObserver.disconnect();
          messageObserver = null;
        }
        // 嘗試自動恢復（當上下文恢復時）
        const recoveryInterval = setInterval(() => {
          if (isRuntimeValid()) {
            console.log('[Gemini 分類助手] [消息監測] ✓ 擴展上下文已恢復，重新設置監控');
            clearInterval(recoveryInterval);
            setupMessageMonitoring();
          }
        }, 2000);
        
        // 30 秒後停止恢復嘗試
        setTimeout(() => {
          clearInterval(recoveryInterval);
        }, 30000);
        return;
      }
      
      // 檢測是否有新的模型回復生成
      try {
        const currentModelResponses = document.querySelectorAll('[class*="model-response"], [class*="modelResponse"], [class*="assistant-message"], [data-role="model"], [data-role="assistant"]');
        const currentCount = currentModelResponses.length;
        
        // 檢查是否有新回復或回復內容變化
        let hasNewResponse = false;
        if (currentCount > lastModelResponseCount) {
          hasNewResponse = true;
          // console.log('[Gemini 分類助手] [消息監測] 檢測到新的模型回復 (數量:', currentCount, ')'); // 已禁用，避免大量日誌
        } else {
          // 檢查現有回復是否還在更新（例如打字效果）
          currentModelResponses.forEach(el => {
            const isUpdating = el.querySelector('[class*="typing"], [class*="streaming"], [aria-busy="true"]') !== null;
            if (isUpdating) {
              hasNewResponse = true;
            }
          });
        }
        
        lastModelResponseCount = currentCount;
        
        // 如果有新回復，延遲一下再提取（等待內容完全生成）
        if (hasNewResponse) {
          // 清除之前的定時器
          if (scrapeTimeout) {
            clearTimeout(scrapeTimeout);
          }
          
          // 等待 1 秒後提取（確保內容已完全生成）
          scrapeTimeout = setTimeout(() => {
            // console.log('[Gemini 分類助手] [消息監測] 觸發對話提取（檢測到新回復）'); // 已禁用，避免大量日誌
            scrapeMessages();
            scrapeTimeout = null;
          }, 1000);
        }
        
        // 確保 MutationObserver 能偵測到圖片加載完成（圖片加載完畢後 DOM 會發生變化）
        // 動態監測：當圖片還在生成中（Loading）時，src 可能是暫時的。
        // 請讓 MutationObserver 在圖片類名變更為 loaded 時再執行抓取
        // 確保 mutations 參數存在且為數組
        if (mutations && Array.isArray(mutations) && mutations.length > 0) {
          mutations.forEach(mutation => {
          // 檢查是否有新的圖片元素添加
          if (mutation.addedNodes && mutation.addedNodes.length > 0) {
            mutation.addedNodes.forEach(node => {
              if (node.nodeType === 1) { // Element node
                // 檢查是否是圖片元素或圖片按鈕
                // 安全地獲取 className（可能是字符串或 DOMTokenList）
                const msgNodeClassName = typeof node.className === 'string' 
                  ? node.className 
                  : (node.className?.baseVal || node.className?.toString() || '');
                
                if (node.tagName === 'IMG' || 
                    node.tagName === 'BUTTON' && (msgNodeClassName.includes('image') || msgNodeClassName.includes('image-button')) ||
                    node.querySelector('img') || 
                    node.querySelector('button.image-button')) {
                  
                  const imgElements = [];
                  if (node.tagName === 'IMG') {
                    imgElements.push(node);
                  } else {
                    const foundImgs = node.querySelectorAll('img');
                    foundImgs.forEach(img => imgElements.push(img));
                  }
                  
                  imgElements.forEach(img => {
                    // 監聽圖片類名變化（從 loading 變為 loaded）
                    const checkImageLoaded = () => {
                      const imgClasses = img.className || '';
                      const isLoaded = imgClasses.includes('loaded') || 
                                     img.complete || 
                                     img.naturalWidth > 0;
                      
                      if (isLoaded) {
                        // console.log('[Gemini 分類助手] [消息監測] 檢測到圖片已加載 (class="loaded"):', img.src?.substring(0, 100)); // 已禁用，避免大量日誌
                        // 延遲一點再提取，確保 DOM 完全更新
                        setTimeout(() => {
                          if (isRuntimeValid()) {
                            scrapeMessages();
                            // 同時提取生成圖片用於 Side Panel 顯示
                            extractGeneratedImages();
                          }
                        }, 500);
                      }
                    };
                    
                    // 立即檢查一次
                    checkImageLoaded();
                    
                    // 監聽類名變化
                    const classObserver = new MutationObserver((mutations) => {
                      mutations.forEach(mut => {
                        if (mut.attributeName === 'class') {
                          checkImageLoaded();
                        }
                      });
                    });
                    
                    classObserver.observe(img, {
                      attributes: true,
                      attributeFilter: ['class']
                    });
                    
                    // 監聽圖片加載完成事件（作為備用）
                    if (!img.complete || img.naturalWidth === 0) {
                      img.addEventListener('load', function() {
                        // console.log('[Gemini 分類助手] [消息監測] 圖片加載完成:', img.src?.substring(0, 100)); // 已禁用，避免大量日誌
                        setTimeout(() => {
                          if (isRuntimeValid()) {
                            scrapeMessages();
                          }
                        }, 500);
                      }, { once: true });
                    }
                  });
                }
              }
            });
          }
          
          // 檢查圖片屬性變化（例如 src 變化，表示圖片開始加載）
          // 動態監測：當圖片類名變更為 loaded 時再執行抓取
          if (mutation.type === 'attributes' && mutation.target.tagName === 'IMG') {
            if (mutation.attributeName === 'src' || mutation.attributeName === 'data-src' || mutation.attributeName === 'class') {
              const img = mutation.target;
              const imgClasses = img.className || '';
              
              // 如果類名變更為 loaded，觸發提取（使用異步方式避免阻塞）
              if (mutation.attributeName === 'class' && imgClasses.includes('loaded')) {
                // console.log('[Gemini 分類助手] [消息監測] 檢測到圖片類名變更為 loaded:', img.src?.substring(0, 100)); // 已禁用，避免大量日誌
                setTimeout(() => {
                  if (isRuntimeValid()) {
                    if (window.requestIdleCallback) {
                      requestIdleCallback(() => {
                        if (isRuntimeValid()) {
                          scrapeMessages();
                          extractGeneratedImages();
                        }
                      }, { timeout: 500 });
                    } else {
                      setTimeout(() => {
                        if (isRuntimeValid()) {
                          scrapeMessages();
                          extractGeneratedImages();
                        }
                      }, 0);
                    }
                  }
                }, 500);
              } else if (mutation.attributeName === 'src' || mutation.attributeName === 'data-src') {
                // console.log('[Gemini 分類助手] [消息監測] 檢測到圖片屬性變化:', img.src?.substring(0, 100)); // 已禁用，避免大量日誌
                setTimeout(() => {
                  if (isRuntimeValid()) {
                    if (window.requestIdleCallback) {
                      requestIdleCallback(() => {
                        if (isRuntimeValid()) {
                          scrapeMessages();
                          extractGeneratedImages();
                        }
                      }, { timeout: 1000 });
                    } else {
                      setTimeout(() => {
                        if (isRuntimeValid()) {
                          scrapeMessages();
                          extractGeneratedImages();
                        }
                      }, 0);
                    }
                  }
                }, 1000);
              }
            }
          }
          });
        }
      } catch (error) {
        const errorMessage = error.message || error.toString();
        if (errorMessage.includes('Extension context invalidated') || 
            errorMessage.includes('message port closed')) {
          console.warn('[Gemini 分類助手] [消息監測] ⚠️ 擴展上下文已失效，停止觀察');
          if (messageObserver) {
            messageObserver.disconnect();
            messageObserver = null;
          }
        } else {
          console.error('[Gemini 分類助手] [消息監測] 檢測消息變化時發生錯誤:', error);
        }
      }
    });
        
    // 觀察整個文檔的變化（包括圖片加載）
    if (document.body) {
          messageObserver.observe(document.body, {
            childList: true,
            subtree: true,
            characterData: true,
            attributes: true,
            attributeFilter: ['src', 'data-src', 'data-original', 'class', 'complete']
          });
          console.log('[Gemini 分類助手] [消息監測] ✓ 消息觀察器已設置（支持圖片監測）');
      
      // 立即執行一次提取（使用 requestIdleCallback 避免阻塞主線程）
      if (window.requestIdleCallback) {
        requestIdleCallback(() => {
          if (currentChatId && isRuntimeValid()) {
            scrapeMessages();
          }
        }, { timeout: 2000 });
      } else {
        setTimeout(() => {
          if (currentChatId && isRuntimeValid()) {
            scrapeMessages();
          }
        }, 2000);
      }
      
      // 定期提取（每 5 秒一次，作為備用，使用 requestIdleCallback 避免阻塞）
      setInterval(() => {
        if (currentChatId && isRuntimeValid()) {
          if (window.requestIdleCallback) {
            requestIdleCallback(() => {
              if (currentChatId && isRuntimeValid()) {
                scrapeMessages();
              }
            }, { timeout: 1000 });
          } else {
            scrapeMessages();
          }
        }
      }, 5000);
    } else {
      console.error('[Gemini 分類助手] [消息監測] ❌ document.body 不存在，無法設置觀察器');
    }
    
    // 設置專門的圖片監控
    setupImageMonitoring();
  }
  
  // 【暴力修正版】監控單個圖片容器：鎖定 button.image-button，只要 img 類名包含 loaded，強行提取
  function setupImageObserver(container) {
    try {
      console.log('[Gemini 分類助手] [圖片追蹤] 🔥 暴力模式：設置圖片容器監控...');
      
      // 1. 【無視 ID 限制】直接生成 requestId，不等待 BardVeMetadataKey
      const requestId = 'img_' + Date.now();
      
      // 2. 【鎖定 button.image-button】查找 button.image-button 內的 img
      let img = container.querySelector('button.image-button img');
      
      // 如果沒找到，查找任何 img
      if (!img) {
        img = container.querySelector('img');
      }
      
      if (!img) {
        console.log('[Gemini 分類助手] [圖片追蹤]   ⚠️ 未找到圖片元素，跳過監控');
        return;
      }
      
      console.log('[Gemini 分類助手] [圖片追蹤]   ✓ 找到圖片元素');
      console.log('[Gemini 分類助手] [圖片追蹤]   img.className:', img.className);
      console.log('[Gemini 分類助手] [圖片追蹤]   當前 src:', img.src?.substring(0, 100) || '無');
      
      // 3. 【即時檢查】如果已經是有效圖片，立即觸發
      const currentSrc = img.src || '';
      if (currentSrc && currentSrc.length >= 100 && 
          !currentSrc.includes('/profile/picture/') && 
          !currentSrc.includes('profile/picture') &&
          (currentSrc.includes('lh3.googleusercontent.com') || 
           currentSrc.includes('googleusercontent.com') || 
           (currentSrc.startsWith('blob:') && !currentSrc.startsWith('blob:null/')))) {
        console.log('[Gemini 分類助手] [圖片追蹤]   ✅ 圖片已經是有效 URL，立即下載');
        triggerAutoDownload(currentSrc, requestId);
        sendImageToSidePanel(currentSrc, requestId, img);
        return;
      }
      
      // 4. 【監控類名變化】創建 MutationObserver 監聽 class 和 src 變化
      const observer = new MutationObserver(async (mutations) => {
        mutations.forEach(async (mutation) => {
          const target = mutation.target;
          
          // 【效能優化】只要偵測到圖片已在資料庫中，立即停止對該 DOM 節點的所有監聽器
          if (mutation.attributeName === 'src' && target === img) {
            const currentSrc = img.src || '';
            if (currentSrc && currentSrc.length >= 100) {
              const checkResult = await checkDownloadHistory(currentSrc, requestId, currentChatId);
              if (checkResult.exists) {
                console.log('[Gemini 分類助手] [圖片追蹤] ⏭️ 圖片已在資料庫中，停止監聽');
                observer.disconnect();
                return;
              }
            }
          }
          
          // 【監控類名變化】只要 img 類名變更為包含 loaded，強行提取
          if (mutation.attributeName === 'class' && target === img) {
            const className = img.className || '';
            if (className.includes('loaded')) {
              console.log('[Gemini 分類助手] [圖片追蹤]   🔥 檢測到類名包含 loaded，強行提取！');
              const newSrc = img.src || '';
              
              // 【效能優化】檢查圖片是否已在資料庫中
              const checkResult = await checkDownloadHistory(newSrc, requestId, currentChatId);
              if (checkResult.exists) {
                console.log('[Gemini 分類助手] [圖片追蹤] ⏭️ 圖片已在資料庫中，停止監聽');
                observer.disconnect();
                return;
              }
              
              // 【跳過佔位符】寫死規則
              if (newSrc && newSrc.length >= 100 && 
                  !newSrc.includes('/profile/picture/') && 
                  !newSrc.includes('profile/picture') &&
                  (newSrc.includes('lh3.googleusercontent.com') || 
                   newSrc.includes('googleusercontent.com') || 
                   (newSrc.startsWith('blob:') && !newSrc.startsWith('blob:null/')))) {
                console.log('[Gemini 分類助手] [圖片追蹤]   ✅ 暴力模式：偵測到有效圖片，立即提取！');
                console.log('[Gemini 分類助手] [圖片追蹤]   完整 URL:', newSrc.substring(0, 150));
                
                // 【即時回傳】立即執行 sendImageToSidePanel
                sendImageToSidePanel(newSrc, requestId, img);
                triggerAutoDownload(newSrc, requestId);
                
                // 下載完成後停止監控
                observer.disconnect();
                console.log('[Gemini 分類助手] [圖片追蹤]   ✓ 監控已停止（圖片已提取）');
              }
            }
          }
          
          // 【監控 src 變化】同時監聽 src 屬性變化
          if (mutation.attributeName === 'src') {
            const newSrc = img.src || '';
            console.log('[Gemini 分類助手] [圖片追蹤]   📍 src 屬性已變更:', newSrc.substring(0, 100) || '無');
            
            // 【效能優化】檢查圖片是否已在資料庫中
            if (newSrc && newSrc.length >= 100) {
              const checkResult = await checkDownloadHistory(newSrc, requestId, currentChatId);
              if (checkResult.exists) {
                console.log('[Gemini 分類助手] [圖片追蹤] ⏭️ 圖片已在資料庫中，停止監聽');
                observer.disconnect();
                return;
              }
            }
            
            // 【跳過佔位符】寫死規則
            if (newSrc && newSrc.length >= 100 && 
                !newSrc.includes('/profile/picture/') && 
                !newSrc.includes('profile/picture') &&
                (newSrc.includes('lh3.googleusercontent.com') || 
                 newSrc.includes('googleusercontent.com') || 
                 newSrc.startsWith('blob:'))) {
              console.log('[Gemini 分類助手] [圖片追蹤]   ✅ 暴力模式：偵測到有效圖片 URL，立即提取！');
              
              // 【即時回傳】立即執行 sendImageToSidePanel
              sendImageToSidePanel(newSrc, requestId, img);
              triggerAutoDownload(newSrc, requestId);
              
              // 下載完成後停止監控
              observer.disconnect();
              console.log('[Gemini 分類助手] [圖片追蹤]   ✓ 監控已停止（圖片已提取）');
            }
          }
        });
      });
      
      // 開始監聽 img 元素的 class 和 src 變化
      observer.observe(img, { 
        attributes: true, 
        attributeFilter: ['src', 'class', 'data-src'] 
      });
      
      console.log('[Gemini 分類助手] [圖片追蹤]   ✓ MutationObserver 已啟動（監控 class 和 src）...');
      
      // 設置超時（30秒後自動停止監控）
      setTimeout(() => {
        observer.disconnect();
        console.log('[Gemini 分類助手] [圖片追蹤]   ⏱️ 30 秒超時，停止監控');
      }, 30000);
      
    } catch (error) {
      console.error('[Gemini 分類助手] [圖片追蹤] ❌ 設置圖片監控時發生錯誤:', error);
    }
  }

  // 新增：專門監控圖片變化的函數（圖片追蹤核心功能）
  function setupImageMonitoring() {
    if (!currentChatId) {
      console.log('[Gemini 分類助手] [圖片追蹤] 跳過設置，因為沒有當前對話 ID');
      return;
    }
    
    console.log('[Gemini 分類助手] [圖片追蹤] 🖼️ 開始設置圖片追蹤功能...');
    
    // 立即執行一次圖片提取（查找頁面上已存在的圖片）
    setTimeout(() => {
      console.log('[Gemini 分類助手] [圖片追蹤] 🔍 立即掃描頁面上的圖片...');
      extractGeneratedImages();
      
      // 同時對頁面上已存在的所有 .attachment-container.generated-images 設置監控
      const existingContainers = document.querySelectorAll('.attachment-container.generated-images');
      console.log('[Gemini 分類助手] [圖片追蹤]   找到', existingContainers.length, '個已存在的圖片容器，開始監控...');
      existingContainers.forEach((container, index) => {
        console.log('[Gemini 分類助手] [圖片追蹤]   設置容器 #' + (index + 1) + ' 的監控');
        setupImageObserver(container);
      });
      
      // 啟動強制提取定時器（每 2 秒掃描一次，確保不漏掉任何圖片）
      startForceExtractInterval();
    }, 500);

    // 如果已有圖片觀察器，先停止它
    if (typeof observerManager !== 'undefined' && observerManager && observerManager.has('imageObserver')) {
      console.log('[Gemini 分類助手] [圖片監控] 停止舊的圖片觀察器');
      observerManager.disconnect('imageObserver');
    } else if (imageObserver) {
      // 如果 observerManager 不可用，直接斷開 imageObserver
      console.log('[Gemini 分類助手] [圖片監控] 停止舊的圖片觀察器（直接方式）');
      imageObserver.disconnect();
      imageObserver = null;
    }

    // 創建新的圖片觀察器（使用 observerManager，如果可用）
    if (typeof observerManager !== 'undefined' && observerManager && typeof observerManager.create === 'function') {
      imageObserver = observerManager.create('imageObserver', document.body, (mutations) => {
      // 檢查 runtime 是否有效
      if (!isRuntimeValid()) {
        console.warn('[Gemini 分類助手] [圖片監控] ⚠️ 擴展上下文已失效，停止觀察');
        observerManager.disconnect('imageObserver');
        imageObserver = null;
        return;
      }
      
      let hasImageChanges = false;
      
      mutations.forEach(mutation => {
        // 檢查是否有新的圖片元素添加
        if (mutation.addedNodes && mutation.addedNodes.length > 0) {
          mutation.addedNodes.forEach(node => {
            if (node.nodeType === 1) { // Element node
              // 優先檢查是否是 .attachment-container.generated-images 容器
              let imageContainer = null;
              
              if (node.classList?.contains('attachment-container') && node.classList?.contains('generated-images')) {
                imageContainer = node;
              } else if (node.querySelector) {
                imageContainer = node.querySelector('.attachment-container.generated-images');
              }
              
              // 如果找到圖片容器，立即設置監控（延遲一點確保 DOM 完全構建）
              if (imageContainer) {
                // console.log('[Gemini 分類助手] [圖片追蹤] 🎯 檢測到新的 .attachment-container.generated-images，立即設置監控'); // 已禁用，避免大量日誌
                hasImageChanges = true;
                // 延遲一點點，確保 DOM 完全構建
                setTimeout(() => {
                  setupImageObserver(imageContainer);
                }, 100);
              }
              
              // 【暴力監控】檢查是否是 button.image-button（最優先）
              // 安全地獲取 className（可能是字符串或 DOMTokenList）
              let nodeClassName = typeof node.className === 'string' 
                ? node.className 
                : (node.className?.baseVal || node.className?.toString() || '');
              
              if (node.tagName === 'BUTTON' && (nodeClassName.includes('image-button') || nodeClassName.includes('image'))) {
                hasImageChanges = true;
                // console.log('[Gemini 分類助手] [圖片追蹤] 🔥 檢測到新的 button.image-button，立即設置監控'); // 已禁用，避免大量日誌
                setTimeout(() => {
                  setupImageObserver(node);
                }, 100);
              }
              
              // 檢查是否是圖片相關元素（其他類型）
              // 重新獲取 className（可能在上面的 if 中已使用）
              nodeClassName = typeof node.className === 'string' 
                ? node.className 
                : (node.className?.baseVal || node.className?.toString() || '');
              
              if (node.tagName === 'IMG' || 
                  node.tagName === 'A' && (node.getAttribute('download') || node.href?.includes('googleusercontent.com')) ||
                  node.querySelector('img') || 
                  node.querySelector('button.image-button') ||
                  nodeClassName.includes('image-expansion-dialog') ||
                  nodeClassName.includes('expansion-dialog') ||
                  node.getAttribute('aria-label')?.includes('顯示大圖') ||
                  node.getAttribute('aria-label')?.includes('燈箱')) {
                hasImageChanges = true;
                // console.log('[Gemini 分類助手] [圖片追蹤] 檢測到新的圖片相關元素:', node.tagName, nodeClassName.substring(0, 50)); // 已禁用，避免大量日誌
              }
            }
          });
        }
        
        // 【暴力監控】檢查圖片屬性變化（src、class、data-src 等）
        if (mutation.type === 'attributes' && mutation.target.tagName === 'IMG') {
          const img = mutation.target;
          const imgClasses = img.className || '';
          const imgSrc = img.src || '';
          
          // 【監控類名變化】只要 img 類名變更為包含 loaded，強行提取
          if (mutation.attributeName === 'class' && imgClasses.includes('loaded')) {
            hasImageChanges = true;
            // console.log('[Gemini 分類助手] [圖片追蹤] 🔥 檢測到圖片類名變更為 loaded，強行提取！'); // 已禁用，避免大量日誌
            
            // 【跳過佔位符】寫死規則
            if (imgSrc && imgSrc.length >= 100 && 
                !imgSrc.includes('/profile/picture/') && 
                !imgSrc.includes('profile/picture') &&
                (imgSrc.includes('lh3.googleusercontent.com') || 
                 imgSrc.includes('googleusercontent.com') || 
                 (imgSrc.startsWith('blob:') && !imgSrc.startsWith('blob:null/')))) {
              const requestId = 'img_loaded_' + Date.now();
              // console.log('[Gemini 分類助手] [圖片追蹤]   ✅ 類名變為 loaded，立即提取！'); // 已禁用，避免大量日誌
              sendImageToSidePanel(imgSrc, requestId, img);
              triggerAutoDownload(imgSrc, requestId);
            }
          }
          
          // 【監控 src 變化】只要 src 變成有效 URL，立即提取
          if (mutation.attributeName === 'src' || mutation.attributeName === 'data-src' || mutation.attributeName === 'data-original') {
            const newSrc = img.src || img.getAttribute('src') || img.getAttribute('data-src') || '';
            
            // 【跳過佔位符】寫死規則
            if (newSrc && newSrc.length >= 100 && 
                !newSrc.includes('/profile/picture/') && 
                !newSrc.includes('profile/picture') &&
                (newSrc.includes('lh3.googleusercontent.com') || 
                 newSrc.includes('googleusercontent.com') || 
                 newSrc.startsWith('blob:'))) {
              hasImageChanges = true;
              // console.log('[Gemini 分類助手] [圖片追蹤] 🔥 檢測到有效圖片 URL 變化，立即提取！:', newSrc.substring(0, 100)); // 已禁用，避免大量日誌
              
              const requestId = 'img_src_' + Date.now();
              sendImageToSidePanel(newSrc, requestId, img);
              triggerAutoDownload(newSrc, requestId);
            }
          }
        }
        
        // 檢查是否有圖片展開對話框（燈箱）打開
        if (mutation.type === 'attributes' || mutation.addedNodes) {
          const expansionDialogs = document.querySelectorAll(
            '.image-expansion-dialog-panel, ' +
            'mat-dialog-container[aria-label*="顯示大圖"], ' +
            'mat-dialog-container[aria-label*="燈箱"], ' +
            '.cdk-overlay-container .cdk-overlay-pane[class*="image-expansion"]'
          );
          
          if (expansionDialogs.length > 0) {
            hasImageChanges = true;
            console.log('[Gemini 分類助手] [圖片監控] 檢測到圖片展開對話框（燈箱）打開');
          }
        }
      });
      
      // 如果有圖片變化，延遲觸發提取（等待圖片完全加載）
      if (hasImageChanges) {
        // 清除之前的定時器
        if (scrapeTimeout) {
          clearTimeout(scrapeTimeout);
        }
        
        // 延遲 1.5 秒後提取（給圖片足夠的時間加載），使用異步方式避免阻塞
        scrapeTimeout = setTimeout(() => {
          console.log('[Gemini 分類助手] [圖片監控] 觸發圖片提取（檢測到圖片變化）');
          if (isRuntimeValid() && currentChatId) {
            // 使用異步方式執行，避免阻塞主線程
            if (window.requestIdleCallback) {
              requestIdleCallback(() => {
                if (isRuntimeValid() && currentChatId) {
                  scrapeMessages();
                  extractGeneratedImages();
                }
              }, { timeout: 500 });
            } else {
              // 降級到 setTimeout，使用較短的延遲分批執行
              setTimeout(() => {
                if (isRuntimeValid() && currentChatId) {
                  scrapeMessages();
                  extractGeneratedImages();
                }
              }, 0);
            }
            
            // 額外等待後再次檢查（給圖片更多時間加載）
            setTimeout(() => {
              if (isRuntimeValid() && currentChatId) {
                if (window.requestIdleCallback) {
                  requestIdleCallback(() => {
                    if (isRuntimeValid() && currentChatId) {
                      scrapeMessages();
                      extractGeneratedImages();
                    }
                  }, { timeout: 500 });
                } else {
                  setTimeout(() => {
                    if (isRuntimeValid() && currentChatId) {
                      scrapeMessages();
                      extractGeneratedImages();
                    }
                  }, 0);
                }
              }
            }, 2000);
          }
          scrapeTimeout = null;
        }, 1500);
      }
      });
      
      // 觀察整個文檔的圖片相關變化
      if (document.body) {
        imageObserver.observe(document.body, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['src', 'data-src', 'data-original', 'class', 'href', 'aria-label']
        });
        console.log('[Gemini 分類助手] [圖片追蹤] ✓ 圖片觀察器已設置');
      }
    } else {
      // 如果 observerManager 不可用，直接創建 MutationObserver
      console.warn('[Gemini 分類助手] [圖片監控] ⚠️ observerManager 不可用，使用直接方式創建觀察器');
      imageObserver = new MutationObserver((mutations) => {
        // 檢查 runtime 是否有效
        if (!isRuntimeValid()) {
          console.warn('[Gemini 分類助手] [圖片監控] ⚠️ 擴展上下文已失效，停止觀察');
          if (imageObserver) {
            imageObserver.disconnect();
            imageObserver = null;
          }
          return;
        }
        
        let hasImageChanges = false;
        
        mutations.forEach(mutation => {
          // 檢查是否有新的圖片元素添加
          if (mutation.addedNodes && mutation.addedNodes.length > 0) {
            mutation.addedNodes.forEach(node => {
              if (node.nodeType === 1) {
                // 優先檢查是否是 .attachment-container.generated-images 容器
                let imageContainer = null;
                
                if (node.classList?.contains('attachment-container') && node.classList?.contains('generated-images')) {
                  imageContainer = node;
                } else if (node.querySelector) {
                  imageContainer = node.querySelector('.attachment-container.generated-images');
                }
                
                if (imageContainer) {
                  // console.log('[Gemini 分類助手] [圖片追蹤] 🎯 檢測到新的 .attachment-container.generated-images，立即設置監控'); // 已禁用，避免大量日誌
                  hasImageChanges = true;
                  setTimeout(() => {
                    setupImageObserver(imageContainer);
                  }, 100);
                }
                
                // 檢查是否是 button.image-button
                let imgNodeClassName = typeof node.className === 'string' 
                  ? node.className 
                  : (node.className?.baseVal || node.className?.toString() || '');
                
                if (node.tagName === 'BUTTON' && (imgNodeClassName.includes('image-button') || imgNodeClassName.includes('image'))) {
                  hasImageChanges = true;
                  // console.log('[Gemini 分類助手] [圖片追蹤] 🔥 檢測到新的 button.image-button，立即設置監控'); // 已禁用，避免大量日誌
                  setTimeout(() => {
                    setupImageObserver(node);
                  }, 100);
                }
                
                // 檢查其他圖片相關元素
                imgNodeClassName = typeof node.className === 'string' 
                  ? node.className 
                  : (node.className?.baseVal || node.className?.toString() || '');
                
                if (node.tagName === 'IMG' || 
                    node.tagName === 'A' && (node.getAttribute('download') || node.href?.includes('googleusercontent.com')) ||
                    node.querySelector('img') || 
                    node.querySelector('button.image-button') ||
                    imgNodeClassName.includes('image-expansion-dialog') ||
                    imgNodeClassName.includes('expansion-dialog') ||
                    node.getAttribute('aria-label')?.includes('顯示大圖') ||
                    node.getAttribute('aria-label')?.includes('燈箱')) {
                  hasImageChanges = true;
                  // console.log('[Gemini 分類助手] [圖片追蹤] 檢測到新的圖片相關元素:', node.tagName, imgNodeClassName.substring(0, 50)); // 已禁用，避免大量日誌
                }
              }
            });
          }
          
          // 檢查圖片屬性變化
          if (mutation.type === 'attributes' && mutation.target.tagName === 'IMG') {
            const img = mutation.target;
            const imgClasses = img.className || '';
            const imgSrc = img.src || '';
            
            if (mutation.attributeName === 'class' && imgClasses.includes('loaded')) {
              hasImageChanges = true;
              // console.log('[Gemini 分類助手] [圖片追蹤] 🔥 檢測到圖片類名變更為 loaded，強行提取！'); // 已禁用，避免大量日誌
              
              if (imgSrc && imgSrc.length >= 100 && 
                  !imgSrc.includes('/profile/picture/') && 
                  !imgSrc.includes('profile/picture') &&
                  (imgSrc.includes('lh3.googleusercontent.com') || 
                   imgSrc.includes('googleusercontent.com') || 
                   imgSrc.startsWith('blob:'))) {
                const requestId = 'img_loaded_' + Date.now();
                // console.log('[Gemini 分類助手] [圖片追蹤]   ✅ 類名變為 loaded，立即提取！'); // 已禁用，避免大量日誌
                sendImageToSidePanel(imgSrc, requestId, img);
                triggerAutoDownload(imgSrc, requestId);
              }
            }
            
            if (mutation.attributeName === 'src' || mutation.attributeName === 'data-src' || mutation.attributeName === 'data-original') {
              const newSrc = img.src || img.getAttribute('src') || img.getAttribute('data-src') || '';
              
              if (newSrc && newSrc.length >= 100 && 
                  !newSrc.includes('/profile/picture/') && 
                  !newSrc.includes('profile/picture') &&
                  (newSrc.includes('lh3.googleusercontent.com') || 
                   newSrc.includes('googleusercontent.com') || 
                   (newSrc.startsWith('blob:') && !newSrc.startsWith('blob:null/')))) {
                hasImageChanges = true;
                // console.log('[Gemini 分類助手] [圖片追蹤] 🔥 檢測到有效圖片 URL 變化，立即提取！:', newSrc.substring(0, 100)); // 已禁用，避免大量日誌
                
                const requestId = 'img_src_' + Date.now();
                sendImageToSidePanel(newSrc, requestId, img);
                triggerAutoDownload(newSrc, requestId);
              }
            }
          }
        });
        
        // 如果有圖片變化，延遲觸發提取
        if (hasImageChanges) {
          if (scrapeTimeout) {
            clearTimeout(scrapeTimeout);
          }
          
          scrapeTimeout = setTimeout(() => {
            console.log('[Gemini 分類助手] [圖片監控] 觸發圖片提取（檢測到圖片變化）');
            if (isRuntimeValid() && currentChatId) {
              if (window.requestIdleCallback) {
                requestIdleCallback(() => {
                  if (isRuntimeValid() && currentChatId) {
                    scrapeMessages();
                    extractGeneratedImages();
                  }
                }, { timeout: 500 });
              } else {
                setTimeout(() => {
                  if (isRuntimeValid() && currentChatId) {
                    scrapeMessages();
                    extractGeneratedImages();
                  }
                }, 0);
              }
              
              setTimeout(() => {
                if (isRuntimeValid() && currentChatId) {
                  if (window.requestIdleCallback) {
                    requestIdleCallback(() => {
                      if (isRuntimeValid() && currentChatId) {
                        scrapeMessages();
                        extractGeneratedImages();
                      }
                    }, { timeout: 500 });
                  } else {
                    setTimeout(() => {
                      if (isRuntimeValid() && currentChatId) {
                        scrapeMessages();
                        extractGeneratedImages();
                      }
                    }, 0);
                  }
                }
              }, 2000);
            }
            scrapeTimeout = null;
          }, 1500);
        }
      });
      
      // 觀察整個文檔的圖片相關變化
      if (document.body) {
        imageObserver.observe(document.body, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['src', 'data-src', 'data-original', 'class', 'href', 'aria-label']
        });
        console.log('[Gemini 分類助手] [圖片追蹤] ✓ 圖片觀察器已設置（直接方式）');
      }
    }
    
    // 定期檢查圖片數量變化（作為備用機制，確保不漏掉任何圖片）
    if (imageCheckInterval) {
      clearInterval(imageCheckInterval);
    }
    
    imageCheckInterval = setInterval(() => {
      if (!isRuntimeValid() || !currentChatId) {
        if (imageCheckInterval) {
          clearInterval(imageCheckInterval);
          imageCheckInterval = null;
        }
        return;
      }
      
      // console.log('[Gemini 分類助手] [圖片追蹤] 🔄 定期掃描圖片（每 3 秒）...'); // 已禁用，避免大量日誌
      
      // 統計當前頁面上的圖片數量（使用更全面的選擇器）
      const currentImages = document.querySelectorAll(
        'button.image-button img, ' +
        'generated-image img, ' +
        'single-image img, ' +
        'img[src*="googleusercontent.com"], ' +
        'img[src*="gg-dl"], ' +
        'img[src*="rd-gg-dl"], ' +
        'img[src*="gg/"], ' +
        'img[src^="blob:"]'
      );
      
      const currentCount = currentImages.length;
      
      if (currentCount !== lastImageCount) {
        console.log('[Gemini 分類助手] [圖片追蹤] 📊 圖片數量變化:', lastImageCount, '->', currentCount);
        
        // 無論數量增加還是減少，都觸發提取（可能圖片已更新）
        extractGeneratedImages();
        
        lastImageCount = currentCount;
        
        // 同時觸發消息提取
        setTimeout(() => {
          if (isRuntimeValid() && currentChatId) {
            scrapeMessages();
          }
        }, 500);
      }
    }, 3000); // 每 3 秒檢查一次
    
    console.log('[Gemini 分類助手] [圖片追蹤] ✓ 定期掃描已設置（每 3 秒）');
  }

  // 提取純文字（過濾 HTML 標籤）
  function extractPlainText(element) {
    if (!element) return '';
    
    // 克隆元素以避免修改原始 DOM
    const clone = element.cloneNode(true);
    
    // 移除腳本和樣式標籤（但保留文本內容）
    const scripts = clone.querySelectorAll('script, style, noscript');
    scripts.forEach(el => el.remove());
    
    // 移除圖片和媒體元素（避免圖片 alt 文本混入對話文本）
    // 但保留文本內容
    const images = clone.querySelectorAll('img, video, audio, iframe, canvas, svg');
    images.forEach(el => {
      // 保留圖片的 alt 文本（如果有的話），但移除圖片元素本身
      // 這樣可以避免圖片 URL 或 base64 數據混入文本
      if (el.tagName === 'IMG' && el.alt) {
        const altText = el.alt;
        const textNode = document.createTextNode(`[圖片: ${altText}]`);
        el.parentNode?.replaceChild(textNode, el);
      } else {
        el.remove();
      }
    });
    
    // 獲取純文字（保留結構，包括空行）
    // 優先使用 innerText（保留換行格式），如果沒有則使用 textContent
    let text = '';
    
    // 嘗試使用 innerText（保留換行和空行）
    if (clone.innerText) {
      text = clone.innerText;
    } else if (clone.textContent) {
      text = clone.textContent;
    }
    
    // 如果還是沒有文本，嘗試直接從原始元素獲取
    if (!text || text.length === 0) {
      text = element.innerText || element.textContent || '';
    }
    
    // 保留所有換行和空行，只清理多餘的連續空格（但保留換行）
    // 將多個連續空格壓縮為單個空格，但保留換行符
    // 注意：不要使用 replace(/\s+/g, ' ')，這會將換行也替換為空格
    text = text.replace(/[ \t]+/g, ' '); // 只壓縮空格和製表符，不影響換行
    // 保留所有換行，包括空行（只清理超過3個連續換行）
    text = text.replace(/\n{4,}/g, '\n\n\n');
    // 只移除開頭和結尾的空白，不影響中間的空行
    text = text.trim();
    
    // 如果文本太短或只是變數名稱（例如只有單個單詞且符合變數命名規則），嘗試獲取更完整的內容
    if (!text || text.length < 3 || /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(text)) {
      // 嘗試使用 innerText 而不是 textContent（innerText 會考慮樣式，只顯示可見文本，且保留換行）
      const innerText = element.innerText || '';
      if (innerText && innerText.length > text.length) {
        // 使用 innerText，但也要保留換行結構
        let innerTextCleaned = innerText.replace(/[ \t]+/g, ' '); // 只壓縮空格，保留換行
        innerTextCleaned = innerTextCleaned.replace(/\n{4,}/g, '\n\n\n'); // 只清理過多換行
        text = innerTextCleaned.trim();
      }
      
      // 如果還是只有變數名稱，嘗試查找文本節點（保留換行）
      if (!text || text.length < 3 || /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(text)) {
        const textNodes = [];
        const walker = document.createTreeWalker(
          element,
          NodeFilter.SHOW_TEXT,
          null
        );
        
        let node;
        while (node = walker.nextNode()) {
          const nodeText = node.textContent;
          if (nodeText && nodeText.length > 0) {
            // 保留原始文本，包括換行
            textNodes.push(nodeText);
          }
        }
        
        if (textNodes.length > 0) {
          // 合併文本節點，保留換行結構（使用空字符串連接，保留原始格式）
          text = textNodes.join('').replace(/[ \t]+/g, ' ').replace(/\n{4,}/g, '\n\n\n').trim();
        }
      }
    }
    
    // 最終確保保留所有換行（包括空行）
    // 不要過度清理，只移除開頭和結尾的空白
    // 確保空行被保留（空行是兩個連續的換行符）
    return text;
  }

  // 檢查是否包含代碼塊
  function hasCodeBlock(element) {
    if (!element) return false;
    const codeElements = element.querySelectorAll('pre, code');
    return codeElements.length > 0;
  }

  // 提取代碼塊內容
  function extractCodeBlocks(element) {
    if (!element) return [];
    
    const codeBlocks = [];
    const codeElements = element.querySelectorAll('pre, code');
    
    codeElements.forEach(codeEl => {
      const codeText = (codeEl.textContent || codeEl.innerText || '').trim();
      if (codeText) {
        codeBlocks.push({
          type: 'code',
          text: codeText,
          language: codeEl.getAttribute('class')?.match(/language-(\w+)/)?.[1] || null
        });
      }
    });
    
    return codeBlocks;
  }

  // 提取圖片內容（專門針對 Gemini 生成的圖片）
  function extractImages(element) {
    const images = [];
    try {
      console.log('[Gemini 分類助手] [對話提取] 開始提取圖片，元素:', element.tagName, element.className?.substring(0, 100));
      
      // 策略 1: 擴大搜索範圍 - 尋找所有帶有 role="img"、aria-label 包含 'Generated'、或包含圖片按鈕的容器
      // 也包括圖片展開對話框（燈箱）- image-expansion-dialog
      // 新增：attachment-container generated-images, generated-image, single-image 等自定義元素
      const generatedImageContainers = element.querySelectorAll(
        'div[role="img"], ' +
        'div[aria-label*="Generated"], ' +
        'div[aria-label*="generated"], ' +
        'div[aria-label*="顯示大圖"], ' +
        'div[aria-label*="顯示"], ' +
        '[role="img"][aria-label*="Generated"], ' +
        '[role="img"][aria-label*="generated"], ' +
        'button[class*="image"], ' +
        'button.image-button, ' +
        '[class*="image-button"], ' +
        '[class*="image-expansion-dialog"], ' +
        '[class*="expansion-dialog"], ' +
        '[class*="generated-image-expansion"], ' +
        '[class*="trusted-image-dialog"], ' +
        '[class*="generated-image"], ' +
        '[class*="generatedImage"], ' +
        '[class*="generated_image"], ' +
        '[class*="result-image"], ' +
        '[class*="resultImage"], ' +
        '[data-type="generated-image"], ' +
        '[data-generated="true"], ' +
        // 新增：解析用戶提供的 HTML 結構
        'div.attachment-container.generated-images, ' +
        'div[class*="attachment-container"][class*="generated-images"], ' +
        'generated-image, ' +
        'single-image, ' +
        'single-image.generated-image, ' +
        'single-image[class*="generated-image"], ' +
        '[jslog*="BardVeMetadataKey"]'
      );
      
      // 特別查找圖片展開對話框（燈箱）中的圖片
      const expansionDialogs = document.querySelectorAll(
        '.image-expansion-dialog-panel, ' +
        '.generated-image-expansion-dialog, ' +
        'mat-dialog-container[aria-label*="顯示大圖"], ' +
        'mat-dialog-container[aria-label*="燈箱"], ' +
        '.trusted-image-dialog-container'
      );
      
      expansionDialogs.forEach(dialog => {
        console.log('[Gemini 分類助手] [對話提取] 找到圖片展開對話框（燈箱）');
        const dialogImgs = dialog.querySelectorAll('img');
        const dialogButtons = dialog.querySelectorAll(
          'button[class*="download"], ' +
          'button[class*="下載"], ' +
          'button[aria-label*="download"], ' +
          'button[aria-label*="下載"], ' +
          'a[download], ' +
          '.generated-image-expansion-dialog-bottom-action-buttons button, ' +
          '.generated-image-expansion-dialog-bottom-action-buttons a'
        );
        
        dialogImgs.forEach(img => {
          const imgSrc = img.src || img.getAttribute('src') || '';
          // 只提取高品質圖片（通常是完整尺寸的）
          if (imgSrc && (imgSrc.includes('googleusercontent.com') || (imgSrc.startsWith('blob:') && !imgSrc.startsWith('blob:null/')))) {
            const imgData = getImageDataFromElement(img, dialog, true, dialogButtons.length > 0);
            if (imgData && !images.some(existingImg => existingImg.url === imgData.url)) {
              // 標記為來自燈箱的高品質圖片
              imgData.source = 'expansion-dialog';
              imgData.isFullSize = true;
              images.push(imgData);
              console.log('[Gemini 分類助手] [對話提取] 從圖片展開對話框（燈箱）提取高品質圖片:', imgSrc.substring(0, 100));
            }
          }
        });
        
        // 從對話框的按鈕中提取下載連結
        dialogButtons.forEach(btn => {
          const downloadUrl = btn.getAttribute('href') || 
                             btn.getAttribute('data-url') ||
                             btn.getAttribute('data-download-url') ||
                             btn.getAttribute('data-original-url') ||
                             '';
          
          if (downloadUrl && !images.some(img => img.url === downloadUrl || img.downloadUrl === downloadUrl)) {
            images.push({
              url: downloadUrl,
              downloadUrl: downloadUrl,
              originalUrl: downloadUrl,
              alt: '燈箱中的高品質圖片',
              type: downloadUrl.startsWith('data:') || downloadUrl.startsWith('blob:') ? 'base64' : 'url',
              source: 'expansion-dialog-button',
              hasDownloadButton: true,
              isFullSize: true
            });
            console.log('[Gemini 分類助手] [對話提取] 從燈箱按鈕提取下載連結:', downloadUrl.substring(0, 100));
          }
        });
      });
      
      console.log('[Gemini 分類助手] [對話提取] 找到', generatedImageContainers.length, '個生成圖片容器（role="img" 或 aria-label 包含 Generated）');
      
      // 首先處理生成圖片容器（優先級最高）
      generatedImageContainers.forEach(container => {
        // 檢查容器本身是否是按鈕（例如 button.image-button）
        // 安全地獲取 className（可能是字符串或 DOMTokenList）
        const containerClassName = typeof container.className === 'string' 
          ? container.className 
          : (container.className?.baseVal || container.className?.toString() || '');
        
        const isImageButton = container.tagName === 'BUTTON' && 
                             (containerClassName.includes('image') || 
                              containerClassName.includes('image-button'));
        
        // 檢查容器是否包含 BardVeMetadataKey（在 jslog 屬性中）
        const hasBardVeMetadataKey = container.getAttribute('jslog')?.includes('BardVeMetadataKey') || 
                                     container.tagName?.toLowerCase() === 'single-image' ||
                                     container.tagName?.toLowerCase() === 'generated-image' ||
                                     (containerClassName.includes('generated-images') && 
                                      containerClassName.includes('attachment-container'));
        
        if (hasBardVeMetadataKey) {
          console.log('[Gemini 分類助手] [對話提取] 找到包含 BardVeMetadataKey 的容器:', container.tagName, container.className?.substring(0, 100));
        }
        
        // 查找容器內的圖片（包括 button 內的圖片）
        // 只提取已加載的圖片（class 包含 "loaded"）
        // 如果容器包含 BardVeMetadataKey，優先處理（即使圖片未完全加載也要嘗試提取）
        const containerImgs = Array.from(container.querySelectorAll('img')).filter(img => {
          // 獲取圖片 src
          const imgSrc = img.src || img.getAttribute('src') || '';
          
          // 如果沒有 src，跳過
          if (!imgSrc) return false;
          
          // 動態監測：只提取已加載的圖片（類名包含 "loaded"）
          const imgClasses = img.className || '';
          const isLoaded = imgClasses.includes('loaded') || 
                          img.complete || 
                          img.naturalWidth > 0;
          
          // 如果容器包含 BardVeMetadataKey，即使未完全加載也要嘗試提取
          // 如果容器不包含 BardVeMetadataKey，只提取已加載的圖片
          if (!hasBardVeMetadataKey && !isLoaded) {
            return false;
          }
          
          // 過濾掉頭像（包含 profile/picture 的網址）
          const isProfilePicture = imgSrc.includes('/profile/') || 
                                  imgSrc.includes('/picture/') ||
                                  imgSrc.includes('profile-picture') ||
                                  imgSrc.includes('avatar');
          
          return !isProfilePicture;
        });
        
        if (hasBardVeMetadataKey && containerImgs.length > 0) {
          console.log('[Gemini 分類助手] [對話提取] 在包含 BardVeMetadataKey 的容器中找到', containerImgs.length, '個圖片');
        }
        
        // 深入搜索：在 image-button 內部，檢查是否有 a 標籤（連結）或具有 download 屬性的元素
        const downloadLinks = container.querySelectorAll(
          'a[download], ' +
          'a[href*="googleusercontent.com"], ' +
          'a[href*="gg-dl"], ' +
          'a[href*="rd-gg-dl"], ' +
          '[download], ' +
          'button[aria-label*="download"], ' +
          'button[aria-label*="下載"], ' +
          'button[title*="download"], ' +
          'button[title*="下載"], ' +
          '[class*="download"], ' +
          '[class*="下載"]'
        );
        
        // 從下載連結中提取高品質原圖 URL
        const downloadUrls = [];
        downloadLinks.forEach(link => {
          const url = link.getAttribute('href') || 
                     link.getAttribute('data-url') ||
                     link.getAttribute('data-download-url') ||
                     link.getAttribute('data-original-url') ||
                     '';
          
          // 過濾掉頭像 URL
          if (url && !url.includes('/profile/') && !url.includes('/picture/') && 
              !url.includes('profile-picture') && !url.includes('avatar')) {
            downloadUrls.push(url);
          }
        });
        
        // 處理容器內的圖片
        containerImgs.forEach(img => {
          const imgSrc = img.src || img.getAttribute('src') || '';
          
          // 自動過濾：明確排除所有包含 profile/picture 的網址
          if (imgSrc.includes('/profile/') || 
              imgSrc.includes('/picture/') ||
              imgSrc.includes('profile-picture') ||
              imgSrc.includes('avatar')) {
            console.log('[Gemini 分類助手] [對話提取] 跳過頭像圖片:', imgSrc.substring(0, 100));
            return;
          }
          
          // 優先使用下載連結中的高品質原圖 URL
          let originalUrl = downloadUrls.find(url => url && url !== imgSrc) || imgSrc;
          
          const imgData = getImageDataFromElement(img, container, true, downloadLinks.length > 0 || isImageButton);
          if (imgData) {
            // 如果有高品質原圖 URL，使用它
            if (originalUrl && originalUrl !== imgSrc) {
              imgData.originalUrl = originalUrl;
              imgData.downloadUrl = originalUrl;
            }
            images.push(imgData);
          }
        });
        
        // 如果容器內沒有已加載的圖片，但有下載連結，直接使用下載連結
        if (containerImgs.length === 0 && downloadUrls.length > 0) {
          downloadUrls.forEach(downloadUrl => {
            if (!images.some(img => img.url === downloadUrl || img.downloadUrl === downloadUrl)) {
              images.push({
                url: downloadUrl,
                downloadUrl: downloadUrl,
                originalUrl: downloadUrl,
                alt: container.getAttribute('aria-label') || '生成的圖片',
                type: downloadUrl.startsWith('data:') || downloadUrl.startsWith('blob:') ? 'base64' : 'url',
                source: 'download-link',
                hasDownloadButton: true
              });
              console.log('[Gemini 分類助手] [對話提取] 從下載連結提取圖片:', downloadUrl.substring(0, 100));
            }
          });
        }
        
        // 如果容器本身是圖片（例如 canvas）
        if (container.tagName === 'IMG' || container.tagName === 'CANVAS') {
          const imgData = getImageDataFromElement(container, container.parentElement, true, downloadLinks.length > 0);
          if (imgData) {
            images.push(imgData);
          }
        }
      });
      
      // 策略 2: 在 Model 回應區域內查找所有 img 標籤（精準過濾）
      const allImgs = element.querySelectorAll('img');
      console.log('[Gemini 分類助手] [對話提取] 在元素中找到', allImgs.length, '個 img 標籤');
      
      // 測試日誌：輸出目前畫面上找到的所有圖片 src
      const allImageSrcs = [];
      allImgs.forEach(img => {
        const src = img.src || img.getAttribute('src') || img.getAttribute('data-src') || '';
        if (src) {
          allImageSrcs.push(src.substring(0, 100));
        }
      });
      console.log('[Gemini 分類助手] [對話提取] 目前畫面上找到的所有圖片 src 數量:', allImageSrcs.length);
      console.log('[Gemini 分類助手] [對話提取] 圖片 src 列表:', allImageSrcs);
      
      allImgs.forEach(img => {
        const src = img.src || img.getAttribute('src') || img.getAttribute('data-src') || '';
        
        // 精準圖片過濾：檢查 img.src 是否包含 googleusercontent.com/image_generation 或 blob:
        // 也檢查 googleusercontent.com/gg-dl/、googleusercontent.com/rd-gg-dl/ 和 googleusercontent.com/gg/（Gemini 圖片鏈接）
        const isGeneratedImage = src.includes('googleusercontent.com/image_generation') || 
                                src.includes('googleusercontent.com/gg-dl/') ||
                                src.includes('googleusercontent.com/rd-gg-dl/') ||
                                src.includes('googleusercontent.com/gg/') ||
                                src.includes('googleusercontent.com') ||
                                src.startsWith('blob:');
        
        // 檢查是否已經在生成圖片容器中處理過（避免重複）
        // 包括檢查是否在圖片按鈕中、自定義元素中
        const isInGeneratedContainer = img.closest(
          'div[role="img"], ' +
          'div[aria-label*="Generated"], ' +
          'button[class*="image"], ' +
          'button.image-button, ' +
          '[class*="image-button"], ' +
          '[class*="generated-image"], ' +
          '[class*="generatedImage"], ' +
          '[data-generated="true"], ' +
          'single-image, ' +
          'generated-image, ' +
          'div.attachment-container.generated-images, ' +
          'div[class*="attachment-container"][class*="generated-images"], ' +
          '[jslog*="BardVeMetadataKey"]'
        );
        
        // 如果已經在容器中處理過，跳過（除非是明確的生成圖片 URL）
        if (isInGeneratedContainer && !isGeneratedImage) {
          // 已經處理過但不是生成的圖片，跳過
          return;
        }
        
        // 如果是生成的圖片（包括 googleusercontent.com/gg-dl/），使用統一的圖片提取函數
        if (isGeneratedImage || isInGeneratedContainer) {
          // 檢查是否在圖片按鈕中
          const isInImageButton = img.closest('button[class*="image"], button.image-button') !== null;
          const imgData = getImageDataFromElement(img, element, true, isInImageButton);
          if (imgData && !images.some(existingImg => existingImg.url === imgData.url)) {
            images.push(imgData);
          }
        } else {
          // 對於其他圖片，檢查是否是有效的大圖
          const imgData = getImageDataFromElement(img, element, false, false);
          if (imgData && !images.some(existingImg => existingImg.url === imgData.url)) {
            images.push(imgData);
          }
        }
      });
      
      // 策略 3: 查找 canvas 元素（可能包含生成的圖片）
      const canvasElements = element.querySelectorAll('canvas');
      canvasElements.forEach(canvas => {
        try {
          const dataURL = canvas.toDataURL('image/png');
          if (dataURL && dataURL !== 'data:,') {
            images.push({
              url: dataURL,
              alt: 'Canvas 生成的圖片',
              type: 'base64',
              width: canvas.width || null,
              height: canvas.height || null,
              source: 'canvas'
            });
          }
        } catch (e) {
          console.log('[Gemini 分類助手] [對話提取] Canvas 轉換失敗（可能受 CORS 限制）');
        }
      });
      
      // 去重（基於 URL）
      const uniqueImages = [];
      const seenUrls = new Set();
      images.forEach(img => {
        const url = img.url || img.downloadUrl || img.originalUrl || '';
        if (url && !seenUrls.has(url)) {
          seenUrls.add(url);
          uniqueImages.push(img);
        }
      });
      
      // 整合至 Side Panel：當成功抓到符合 BardVeMetadataKey 的圖片後，將圖片網址與對話標題一併存入 chrome.storage.local
      if (uniqueImages.length > 0 && currentChatId) {
        // 檢查是否有包含 BardVeMetadataKey 的圖片按鈕或容器（包括自定義元素）
        const imageContainers = element.querySelectorAll(
          'button[jslog*="BardVeMetadataKey"], ' +
          'button.image-button[jslog*="BardVeMetadataKey"], ' +
          '[jslog*="BardVeMetadataKey"], ' +
          'single-image, ' +
          'generated-image, ' +
          'div.attachment-container.generated-images, ' +
          'div[class*="attachment-container"][class*="generated-images"]'
        );
        
        // 檢查這些容器中是否有 BardVeMetadataKey
        let foundBardVeMetadataKey = false;
        imageContainers.forEach(container => {
          const jslog = container.getAttribute('jslog') || '';
          if (jslog.includes('BardVeMetadataKey')) {
            foundBardVeMetadataKey = true;
          }
          // 自定義元素（single-image, generated-image）也視為包含 BardVeMetadataKey
          if (container.tagName?.toLowerCase() === 'single-image' || 
              container.tagName?.toLowerCase() === 'generated-image') {
            foundBardVeMetadataKey = true;
          }
          // attachment-container generated-images 也視為包含
          // 安全地獲取 className（可能是字符串或 DOMTokenList）
          const containerClassName = typeof container.className === 'string' 
            ? container.className 
            : (container.className?.baseVal || container.className?.toString() || '');
          
          if (containerClassName.includes('generated-images') && 
              containerClassName.includes('attachment-container')) {
            foundBardVeMetadataKey = true;
          }
        });
        
        if (foundBardVeMetadataKey) {
          console.log('[Gemini 分類助手] [對話提取] 找到包含 BardVeMetadataKey 的圖片容器，保存圖片信息');
          
          // 獲取當前對話標題
          const conversationTitle = extractTitle() || '未命名對話';
          
          // 保存圖片信息到 chrome.storage.local
          const imageInfo = {
            chatId: currentChatId,
            title: conversationTitle,
            images: uniqueImages.map(img => ({
              url: img.url,
              originalUrl: img.originalUrl || img.url,
              downloadUrl: img.downloadUrl || img.url,
              alt: img.alt,
              timestamp: Date.now()
            })),
            extractedAt: Date.now()
          };
          
          // 保存到存儲
          const storageKey = `gemini_images_${currentUserProfile}_${currentChatId}`;
          chrome.storage.local.set({
            [storageKey]: imageInfo
          }).then(() => {
            console.log('[Gemini 分類助手] [對話提取] ✓ 圖片信息已保存到 chrome.storage.local');
          }).catch(err => {
            console.error('[Gemini 分類助手] [對話提取] 保存圖片信息失敗:', err);
          });
        }
      }
      
      console.log('[Gemini 分類助手] [對話提取] ✓ 圖片提取完成，共', uniqueImages.length, '張圖片（去重後）');
      return uniqueImages;
    } catch (e) {
      console.error('[Gemini 分類助手] [對話提取] 提取圖片時發生錯誤:', e.message);
      return images;
    }
  }
  
  // 從單個圖片元素提取數據（統一的提取邏輯）
  function getImageDataFromElement(img, container, isGenerated = false, hasDownloadButton = false) {
    try {
      // 獲取圖片 URL（多種方式）
      let src = img.src || 
                img.getAttribute('src') || 
                img.getAttribute('data-src') || 
                img.getAttribute('data-url') ||
                img.getAttribute('data-image-url') ||
                img.getAttribute('data-original') ||
                img.getAttribute('data-full') ||
                img.getAttribute('data-lazy-src') ||
                '';
      
      // 從 srcset 中提取第一個 URL
      if (!src) {
        const srcset = img.getAttribute('srcset');
        if (srcset) {
          const firstSrc = srcset.split(',')[0]?.trim().split(' ')[0];
          if (firstSrc) {
            src = firstSrc;
          }
        }
      }
      
      // 如果 src 為空，嘗試從 style 屬性中提取（background-image）
      if (!src && img.hasAttribute('style')) {
        const style = img.getAttribute('style');
        const bgMatch = style.match(/background-image:\s*url\(['"]?([^'"]+)['"]?\)/);
        if (bgMatch && bgMatch[1]) {
          src = bgMatch[1];
        }
      }
      
      // 檢查是否是有效的生成圖片（過濾掉頭像、圖示等小圖片）
      if (!isValidGeneratedImage(src, img)) {
        console.log('[Gemini 分類助手] [對話提取] 跳過非生成圖片:', src ? src.substring(0, 100) : '(空)');
        return null;
      }
      
      // 獲取圖片描述（通常是原本的 Prompt）
      const alt = img.getAttribute('alt') || 
                  img.getAttribute('aria-label') || 
                  img.getAttribute('title') ||
                  img.getAttribute('data-alt') ||
                  '生成的圖片';
      
      // 查找下載按鈕或原圖 URL
      let downloadUrl = null;
      let originalUrl = null;
      
      if (container && hasDownloadButton) {
        // 查找下載按鈕
        const downloadBtn = container.querySelector(
          'button[aria-label*="download"], ' +
          'button[aria-label*="下載"], ' +
          '[class*="download"], ' +
          '[class*="下載"], ' +
          'a[download]'
        );
        
        if (downloadBtn) {
          downloadUrl = downloadBtn.getAttribute('href') || 
                       downloadBtn.getAttribute('data-url') ||
                       downloadBtn.getAttribute('data-download-url') ||
                       downloadBtn.getAttribute('data-original-url') ||
                       '';
        }
      }
      
      // 查找原圖 URL（data-original 等屬性）
      originalUrl = img.getAttribute('data-original') || 
                   img.getAttribute('data-full') ||
                   img.getAttribute('data-fullsize') ||
                   img.getAttribute('data-original-url') ||
                   img.getAttribute('data-large') ||
                   '';
      
      // 如果沒有明確的原圖 URL，但有下載按鈕 URL，使用下載 URL 作為原圖
      if (!originalUrl && downloadUrl) {
        originalUrl = downloadUrl;
      }
      
      // 如果還沒有，嘗試從 srcset 中選擇最大的圖片
      if (!originalUrl) {
        const srcset = img.getAttribute('srcset');
        if (srcset) {
          const srcsetMatches = srcset.match(/(https?:\/\/[^\s]+)\s+(\d+)w/g);
          if (srcsetMatches && srcsetMatches.length > 0) {
            let maxWidth = 0;
            let maxUrl = '';
            srcsetMatches.forEach(match => {
              const urlMatch = match.match(/(https?:\/\/[^\s]+)/);
              const widthMatch = match.match(/(\d+)w/);
              if (urlMatch && widthMatch) {
                const width = parseInt(widthMatch[1]);
                if (width > maxWidth) {
                  maxWidth = width;
                  maxUrl = urlMatch[1];
                }
              }
            });
            if (maxUrl && maxUrl !== src) {
              originalUrl = maxUrl;
            }
          }
        }
      }
      
      const imageData = {
        url: src,
        alt: alt,
        type: src.startsWith('data:') || src.startsWith('blob:') ? 'base64' : 'url',
        width: img.naturalWidth || img.width || null,
        height: img.naturalHeight || img.height || null,
        source: isGenerated ? 'generated' : 'message',
        hasDownloadButton: hasDownloadButton || !!downloadUrl
      };
      
      // 添加原圖和下載 URL（如果有的話）
      if (originalUrl) {
        imageData.originalUrl = originalUrl;
      }
      if (downloadUrl) {
        imageData.downloadUrl = downloadUrl;
      }
      
      console.log('[Gemini 分類助手] [對話提取] ✓ 提取圖片:', {
        url: src.substring(0, 100),
        alt: alt.substring(0, 50),
        type: imageData.type,
        hasOriginal: !!originalUrl,
        hasDownload: !!downloadUrl
      });
      
      return imageData;
    } catch (e) {
      console.error('[Gemini 分類助手] [對話提取] 提取圖片數據時發生錯誤:', e.message);
      return null;
    }
  }
  
  // 檢查是否是有效的生成圖片（過濾掉頭像、圖示等小圖片）
  function isValidGeneratedImage(src, imgElement) {
    if (!src || src.trim() === '') {
      return false;
    }
    
    // 精準圖片過濾：檢查 img.src 是否包含 googleusercontent.com/image_generation
    if (src.includes('googleusercontent.com/image_generation')) {
      return true;
    }
    
    // 檢查是否包含 googleusercontent.com/gg-dl/（Gemini 圖片下載鏈接）
    if (src.includes('googleusercontent.com/gg-dl/')) {
      return true;
    }
    
    // 檢查是否包含 googleusercontent.com/rd-gg-dl/（Gemini 圖片重定向下載鏈接）
    if (src.includes('googleusercontent.com/rd-gg-dl/')) {
      return true;
    }
    
    // 檢查是否包含 blob:
    if (src.startsWith('blob:')) {
      return true;
    }
    
    // 過濾掉 data URI 太小（可能是圖示）
    if (src.startsWith('data:image/')) {
      const base64Length = src.split(',')[1]?.length || 0;
      // 如果 base64 數據太小（小於 1KB），可能是圖示
      if (base64Length < 1000) {
        return false;
      }
    }
    
    // 優先抓取 Gemini 生成的圖片（包含 googleusercontent.com）
    if (src.includes('googleusercontent.com')) {
      return true;
    }
    
    // 過濾掉明顯的小圖示（根據圖片尺寸）
    const width = imgElement.naturalWidth || imgElement.width || 0;
    const height = imgElement.naturalHeight || imgElement.height || 0;
    
    // 如果圖片尺寸太小（小於 100x100），可能是圖示
    if (width > 0 && height > 0 && width < 100 && height < 100) {
      // 但是，如果 URL 包含特定參數或路徑（表示是生成的大圖），仍然包含
      if (src.includes('generated') || src.includes('result') || src.includes('image') || src.includes('image_generation')) {
        return true;
      }
      return false;
    }
    
    // 如果圖片尺寸足夠大（大於 200x200），認為是生成的圖片
    if (width >= 200 || height >= 200) {
      return true;
    }
    
    // 如果 URL 較長或包含特定參數，認為是生成的圖片
    if (src.length > 100 || 
        src.includes('generated') || 
        src.includes('result') || 
        src.includes('image') ||
        src.includes('image_generation') ||
        src.includes('download') ||
        src.includes('fullsize') ||
        src.includes('original')) {
      return true;
    }
    
    // 默認不包含（可能是小圖示）
    return false;
  }

  // 提取並保存對話消息（重命名為 scrapeMessages）
  function scrapeMessages() {
    // 即使沒有 currentChatId，也嘗試提取消息（可能可以從消息中推斷對話 ID）
    let chatIdToUse = currentChatId;
    
    if (!chatIdToUse) {
      // 嘗試從 URL 或 DOM 中獲取對話 ID
      const url = window.location.href;
      const appMatch = url.match(/\/app\/([^/?#]+)/);
      if (appMatch && appMatch[1]) {
        chatIdToUse = appMatch[1];
        console.log('[Gemini 分類助手] [對話提取] 從 URL 提取到對話 ID:', chatIdToUse);
        // 更新 currentChatId
        if (currentChatId !== chatIdToUse) {
          currentChatId = chatIdToUse;
          // 觸發對話狀態更新
          notifyConversationChange(chatIdToUse, currentTitle);
        }
      } else {
        // 如果仍然沒有對話 ID，但頁面上有消息，使用臨時 ID
        const hasMessages = document.querySelectorAll('[class*="message"], [class*="user-query"], [class*="model-response"]').length > 0;
        if (hasMessages) {
          chatIdToUse = 'temp_' + Date.now();
          console.log('[Gemini 分類助手] [對話提取] ⚠️ 使用臨時對話 ID:', chatIdToUse, '(頁面上有消息但沒有對話 ID)');
          currentChatId = chatIdToUse;
        } else {
          console.log('[Gemini 分類助手] [對話提取] 跳過提取，因為沒有當前對話 ID 且頁面上沒有消息');
          return [];
        }
      }
    }

    try {
      console.log('[Gemini 分類助手] [對話提取] ========== 開始提取對話記錄 ==========');
      console.log('[Gemini 分類助手] [對話提取] [調試] 頁面結構分析:');
      
      // 調試：分析頁面中的消息元素
      const debugSelectors = [
        '[class*="user-query"]',
        '[class*="userQuery"]',
        '[class*="user_query"]',
        '[class*="user-message"]',
        '[class*="userMessage"]',
        '[class*="human"]',
        '[data-role="user"]',
        '[class*="model-response"]',
        '[class*="modelResponse"]',
        '[class*="model_response"]',
        '[class*="assistant-message"]',
        '[class*="assistantMessage"]',
        '[class*="model"]',
        '[data-role="model"]',
        '[data-role="assistant"]',
        '[class*="message"]'
      ];
      
      console.log('[Gemini 分類助手] [對話提取] [調試] 檢查各種選擇器:');
      debugSelectors.forEach(selector => {
        try {
          const elements = document.querySelectorAll(selector);
          if (elements.length > 0) {
            console.log(`[Gemini 分類助手] [對話提取] [調試] - "${selector}": 找到 ${elements.length} 個元素`);
            // 顯示前 3 個元素的文本預覽
            Array.from(elements).slice(0, 3).forEach((el, idx) => {
              const text = extractPlainText(el);
              if (text && text.length > 0) {
                console.log(`[Gemini 分類助手] [對話提取] [調試]   [${idx}] 文本預覽:`, text.substring(0, 100));
              }
            });
          }
        } catch (e) {
          // 忽略選擇器錯誤
        }
      });
      
      const messages = [];
      const seenMessageIds = new Set();
      
      // 記錄提取開始時間，用於估算相對時間
      const extractionStartTime = Date.now();

      // 策略 1: 查找用戶消息（user-query 相關）
      console.log('[Gemini 分類助手] [對話提取] 查找用戶消息...');
      const userMessageSelectors = [
        // 精確匹配
        '[class*="user-query"]',
        '[class*="userQuery"]',
        '[class*="user_query"]',
        '[class*="user-message"]',
        '[class*="userMessage"]',
        '[class*="human"]',
        '[data-role="user"]',
        '[data-message-role="user"]',
        '[class*="message"][class*="user"]',
        '[role="article"][class*="user"]',
        // 通用匹配（嘗試匹配所有可能的用戶消息容器）
        '[class*="turn"]:has([class*="user"]),',
        '[class*="turn"]:has([data-role="user"])',
        '[class*="message-container"]:has([class*="user"])',
        '[class*="chat-message"]:has([class*="user"])',
        // 通過文本內容推斷（最後手段）
        'div[class*="message"]:not([class*="model"]):not([class*="assistant"]):not([class*="system"])'
      ];

      const userMessages = [];
      for (const selector of userMessageSelectors) {
        try {
          const elements = document.querySelectorAll(selector);
          if (elements.length > 0) {
            console.log(`[Gemini 分類助手] [對話提取] 選擇器 "${selector}" 找到 ${elements.length} 個用戶消息元素`);
          }
          
          elements.forEach((element, index) => {
            const text = extractPlainText(element);
            if (!text || text.length < 1) return;
            
            // 嘗試從元素中提取時間戳
            let timestamp = null;
            
            // 策略 1: 從 time 元素或 datetime 屬性提取
            const timeElement = element.querySelector('time, [datetime], [class*="time"], [class*="timestamp"]');
            if (timeElement) {
              const datetime = timeElement.getAttribute('datetime') || timeElement.textContent;
              if (datetime) {
                const parsedTime = new Date(datetime).getTime();
                if (!isNaN(parsedTime) && parsedTime > 0) {
                  timestamp = parsedTime;
                }
              }
            }
            
            // 策略 2: 從 data 屬性提取時間戳
            if (!timestamp) {
              const dataTimestamp = element.getAttribute('data-timestamp') || element.getAttribute('data-time');
              if (dataTimestamp) {
                const parsedTime = parseInt(dataTimestamp);
                if (!isNaN(parsedTime) && parsedTime > 0) {
                  timestamp = parsedTime;
                }
              }
            }
            
            // 獲取元素索引（用於估算時間和生成 ID）
            const allElements = document.querySelectorAll(selector);
            const elementIndex = Array.from(allElements).indexOf(element);
            
            // 策略 3: 使用元素在 DOM 中的位置來估算相對時間（但不使用絕對時間）
            if (!timestamp) {
              // 使用提取開始時間作為基準，每個元素間隔 2 秒
              timestamp = extractionStartTime - (allElements.length - elementIndex - 1) * 2000;
            }
            
            // 生成唯一 ID（使用內容和元素索引）
            const messageHash = text.substring(0, 200).replace(/\s/g, '').substring(0, 100);
            const messageId = `user_${messageHash}_${elementIndex}`;
            
            if (seenMessageIds.has(messageId)) return;
            seenMessageIds.add(messageId);
            
            const message = {
              role: 'user',
              text: text,
              timestamp: timestamp,
              id: messageId,
              extractedAt: Date.now()
            };
            
            // 檢查是否包含代碼塊
            if (hasCodeBlock(element)) {
              message.codeBlocks = extractCodeBlocks(element);
              console.log(`[Gemini 分類助手] [對話提取] 用戶消息包含 ${message.codeBlocks.length} 個代碼塊`);
            }
            
            // 檢查是否包含圖片
            const images = extractImages(element);
            if (images.length > 0) {
              message.images = images;
              console.log(`[Gemini 分類助手] [對話提取] 用戶消息包含 ${images.length} 張圖片`);
            }
            
            userMessages.push(message);
          });
        } catch (e) {
          console.warn(`[Gemini 分類助手] [對話提取] 選擇器 "${selector}" 查詢出錯:`, e.message);
        }
      }

      // 策略 2: 查找 Gemini 回復（model-response 相關）
      console.log('[Gemini 分類助手] [對話提取] 查找 Gemini 回復...');
      const modelResponseSelectors = [
        // 精確匹配
        '[class*="model-response"]',
        '[class*="modelResponse"]',
        '[class*="model_response"]',
        '[class*="assistant-message"]',
        '[class*="assistantMessage"]',
        '[class*="model"]',
        '[data-role="model"]',
        '[data-role="assistant"]',
        '[data-message-role="model"]',
        '[data-message-role="assistant"]',
        '[class*="message"][class*="model"]',
        '[class*="message"][class*="assistant"]',
        '[role="article"][class*="model"]',
        '[role="article"][class*="assistant"]',
        // 通用匹配（嘗試匹配所有可能的模型回復容器）
        '[class*="turn"]:has([class*="model"]),',
        '[class*="turn"]:has([class*="assistant"])',
        '[class*="turn"]:has([data-role="model"])',
        '[class*="turn"]:has([data-role="assistant"])',
        '[class*="message-container"]:has([class*="model"])',
        '[class*="message-container"]:has([class*="assistant"])',
        '[class*="chat-message"]:has([class*="model"])',
        '[class*="chat-message"]:has([class*="assistant"])'
      ];

      const modelMessages = [];
      for (const selector of modelResponseSelectors) {
        try {
          const elements = document.querySelectorAll(selector);
          if (elements.length > 0) {
            console.log(`[Gemini 分類助手] [對話提取] 選擇器 "${selector}" 找到 ${elements.length} 個模型回復元素`);
          }
          
          elements.forEach((element, index) => {
            const text = extractPlainText(element);
            if (!text || text.length < 1) return;
            
            // 嘗試從元素中提取時間戳
            let timestamp = null;
            
            // 策略 1: 從 time 元素或 datetime 屬性提取
            const timeElement = element.querySelector('time, [datetime], [class*="time"], [class*="timestamp"]');
            if (timeElement) {
              const datetime = timeElement.getAttribute('datetime') || timeElement.textContent;
              if (datetime) {
                const parsedTime = new Date(datetime).getTime();
                if (!isNaN(parsedTime) && parsedTime > 0) {
                  timestamp = parsedTime;
                }
              }
            }
            
            // 策略 2: 從 data 屬性提取時間戳
            if (!timestamp) {
              const dataTimestamp = element.getAttribute('data-timestamp') || element.getAttribute('data-time');
              if (dataTimestamp) {
                const parsedTime = parseInt(dataTimestamp);
                if (!isNaN(parsedTime) && parsedTime > 0) {
                  timestamp = parsedTime;
                }
              }
            }
            
            // 獲取元素索引（用於估算時間和生成 ID）
            const allElements = document.querySelectorAll(selector);
            const elementIndex = Array.from(allElements).indexOf(element);
            
            // 策略 3: 使用元素在 DOM 中的位置來估算相對時間（但不使用絕對時間）
            if (!timestamp) {
              // 使用提取開始時間作為基準，每個元素間隔 2 秒（考慮到模型回復需要時間生成）
              timestamp = extractionStartTime - (allElements.length - elementIndex - 1) * 2000;
            }
            
            // 生成唯一 ID（使用內容和元素索引）
            const messageHash = text.substring(0, 200).replace(/\s/g, '').substring(0, 100);
            const messageId = `model_${messageHash}_${elementIndex}`;
            
            if (seenMessageIds.has(messageId)) return;
            seenMessageIds.add(messageId);
            
            const message = {
              role: 'model',
              text: text,
              timestamp: timestamp,
              id: messageId,
              extractedAt: Date.now()
            };
            
            // 檢查是否包含代碼塊
            if (hasCodeBlock(element)) {
              message.codeBlocks = extractCodeBlocks(element);
              console.log(`[Gemini 分類助手] [對話提取] 模型回復包含 ${message.codeBlocks.length} 個代碼塊`);
            }
            
            // 檢查是否包含圖片（重要：Gemini 生成的圖片）
            const images = extractImages(element);
            if (images.length > 0) {
              message.images = images;
              console.log(`[Gemini 分類助手] [對話提取] 模型回復包含 ${images.length} 張圖片`);
              console.log('[Gemini 分類助手] [對話提取] 圖片詳情:', images.map(img => ({
                url: img.url?.substring(0, 100),
                hasDownloadButton: img.hasDownloadButton,
                originalUrl: img.originalUrl?.substring(0, 100)
              })));
            } else {
              // 如果沒有找到圖片，記錄一下以便調試
              console.log('[Gemini 分類助手] [對話提取] 模型回復未找到圖片，元素標籤:', element.tagName, 'class:', element.className?.substring(0, 100));
              
              // 異步重試機制：偵測到文字回覆後的 1 秒、3 秒、5 秒分別進行一次『二次掃描』
              // 由於圖片是動態生成的，可能在文字回覆後才加載完成
              [1000, 3000, 5000].forEach((delay, index) => {
                setTimeout(() => {
                  if (isRuntimeValid() && currentChatId) {
                    console.log(`[Gemini 分類助手] [對話提取] 二次掃描 ${index + 1}/3 (${delay}ms 後) - 重新提取圖片`);
                    const retryImages = extractImages(element);
                    if (retryImages.length > 0) {
                      // 更新消息的圖片
                      if (!message.images) {
                        message.images = [];
                      }
                      // 合併新找到的圖片（去重）
                      retryImages.forEach(newImg => {
                        const existingImg = message.images.find(img => 
                          img.url === newImg.url || 
                          img.downloadUrl === newImg.url ||
                          img.originalUrl === newImg.url
                        );
                        if (!existingImg) {
                          message.images.push(newImg);
                          console.log(`[Gemini 分類助手] [對話提取] 二次掃描找到新圖片:`, newImg.url?.substring(0, 100));
                        }
                      });
                      
                      // 【修正通訊崩潰】所有 sendMessage 前必須加上檢查，防止 context invalidated 錯誤
                      if (!chrome.runtime?.id) {
                        console.warn('[Gemini 分類助手] 插件環境失效，請手動重新整理頁面');
                        return;
                      }
                      
                      if (isRuntimeValid()) {
                        chrome.runtime.sendMessage({
                          action: 'saveConversationMessages',
                          data: {
                            chatId: currentChatId,
                            userProfile: currentUserProfile,
                            messages: [message]
                          }
                        }).catch(() => {});
                      }
                    }
                  }
                }, delay);
              });
            }
            
            modelMessages.push(message);
          });
        } catch (e) {
          console.warn(`[Gemini 分類助手] [對話提取] 選擇器 "${selector}" 查詢出錯:`, e.message);
        }
      }

      // 策略 3: 如果上述方法沒找到，使用通用選擇器（按順序提取）
      if (userMessages.length === 0 && modelMessages.length === 0) {
        console.log('[Gemini 分類助手] [對話提取] ⚠️ 策略 1 和 2 未找到消息，嘗試策略 3: 使用通用選擇器...');
        console.log('[Gemini 分類助手] [對話提取] [調試] 分析頁面中所有可能的消息容器...');
        
        // 先分析頁面結構
        const allPossibleContainers = document.querySelectorAll('div, article, section, li');
        console.log(`[Gemini 分類助手] [對話提取] [調試] 頁面中共有 ${allPossibleContainers.length} 個可能的容器元素`);
        
        // 查找包含文本內容的容器
        const textContainers = Array.from(allPossibleContainers).filter(el => {
          const text = (el.innerText || el.textContent || '').trim();
          return text.length > 10 && text.length < 10000; // 合理的消息長度
        });
        
        console.log(`[Gemini 分類助手] [對話提取] [調試] 找到 ${textContainers.length} 個包含文本的容器`);
        
        // 顯示前 10 個容器的信息
        textContainers.slice(0, 10).forEach((el, idx) => {
          const text = (el.innerText || el.textContent || '').trim();
          console.log(`[Gemini 分類助手] [對話提取] [調試] 容器 #${idx + 1}:`, {
            className: el.className?.substring(0, 100) || '(無類名)',
            tagName: el.tagName,
            textPreview: text.substring(0, 100),
            dataRole: el.getAttribute('data-role') || '(無)',
            ariaLabel: el.getAttribute('aria-label') || '(無)',
            id: el.id || '(無)'
          });
        });
        
        const genericSelectors = [
          '[role="article"]',
          '[class*="conversation-turn"]',
          '[class*="turn"]',
          '[class*="message"]',
          '[class*="Message"]',
          '[class*="chat"]',
          '[class*="Chat"]',
          '[class*="conversation"]',
          '[class*="Conversation"]',
          'div[class*="response"]',
          'div[class*="Response"]',
          'div[class*="content"]',
          'div[class*="Content"]'
        ];

        for (const selector of genericSelectors) {
          try {
            const elements = document.querySelectorAll(selector);
            if (elements.length === 0) continue;
            
            console.log(`[Gemini 分類助手] [對話提取] 通用選擇器 "${selector}" 找到 ${elements.length} 個元素`);
            
            elements.forEach((element, index) => {
              const text = extractPlainText(element);
              if (!text || text.length < 3) return;
              
              // 改進角色判斷邏輯
              const classList = (element.className || '').toLowerCase();
              const parentClassList = (element.parentElement?.className || '').toLowerCase();
              const combinedClassList = classList + ' ' + parentClassList;
              
              const isUser = combinedClassList.includes('user') || 
                           combinedClassList.includes('human') ||
                           element.getAttribute('data-role') === 'user' ||
                           element.closest('[class*="user"], [class*="human"]') !== null ||
                           element.querySelector('[class*="user"], [class*="human"]') !== null;
              
              const isModel = combinedClassList.includes('model') || 
                             combinedClassList.includes('assistant') ||
                             element.getAttribute('data-role') === 'model' ||
                             element.getAttribute('data-role') === 'assistant' ||
                             element.closest('[class*="model"], [class*="assistant"]') !== null ||
                             element.querySelector('[class*="model"], [class*="assistant"]') !== null;
              
              // 如果無法判斷角色，嘗試根據位置推斷（用戶消息通常在模型消息之前）
              let role = isUser ? 'user' : (isModel ? 'model' : 'unknown');
              
              // 如果仍然無法判斷，但文本看起來像消息，根據索引推斷（奇數索引可能是用戶，偶數可能是模型）
              if (role === 'unknown' && text.length > 5) {
                // 嘗試根據文本特徵判斷
                const textLower = text.toLowerCase();
                if (textLower.includes('你好') || textLower.includes('請') || textLower.includes('幫我') || textLower.includes('我想')) {
                  role = 'user';
                } else if (textLower.length > 50) {
                  // 長文本通常是模型回復
                  role = 'model';
                } else {
                  // 根據索引推斷（簡單策略：交替）
                  role = (index % 2 === 0) ? 'user' : 'model';
                }
              }
              
              if (role === 'unknown') {
                console.log(`[Gemini 分類助手] [對話提取] [調試] 無法判斷角色，跳過元素 #${index}:`, {
                  className: element.className?.substring(0, 100),
                  textPreview: text.substring(0, 50)
                });
                return;
              }
              
              const messageId = `${role}_${index}_${text.substring(0, 50).replace(/\s/g, '_')}`;
              if (seenMessageIds.has(messageId)) return;
              seenMessageIds.add(messageId);
              
              const message = {
                role: role,
                text: text,
                timestamp: Date.now(),
                id: messageId
              };
              
              if (hasCodeBlock(element)) {
                message.codeBlocks = extractCodeBlocks(element);
              }
              
              if (role === 'user') {
                userMessages.push(message);
                console.log(`[Gemini 分類助手] [對話提取] [調試] ✓ 找到用戶消息 #${userMessages.length}:`, text.substring(0, 100));
              } else {
                modelMessages.push(message);
                console.log(`[Gemini 分類助手] [對話提取] [調試] ✓ 找到模型回復 #${modelMessages.length}:`, text.substring(0, 100));
              }
            });
            
            if (userMessages.length > 0 || modelMessages.length > 0) {
              console.log(`[Gemini 分類助手] [對話提取] ✓ 策略 3 成功: 使用 "${selector}" 找到 ${userMessages.length} 條用戶消息和 ${modelMessages.length} 條模型回復`);
              break;
            }
          } catch (e) {
            console.warn(`[Gemini 分類助手] [對話提取] 通用選擇器 "${selector}" 查詢出錯:`, e.message);
            continue;
          }
        }
      }

      // 合併消息（按時間順序排列）
      messages.push(...userMessages);
      messages.push(...modelMessages);
      
      // 按時間戳排序（確保正確的時間順序）
      messages.sort((a, b) => {
        const timeA = a.timestamp || 0;
        const timeB = b.timestamp || 0;
        // 如果時間戳相同，使用 extractedAt 作為次要排序
        if (timeA === timeB) {
          return (a.extractedAt || 0) - (b.extractedAt || 0);
        }
        return timeA - timeB; // 升序排列（最早的在前）
      });
      
      // 記錄排序後的消息數量
      console.log('[Gemini 分類助手] [對話提取] 消息已按時間順序排列');

      console.log('[Gemini 分類助手] [對話提取] ✓ 提取完成:', {
        用戶消息: userMessages.length,
        模型回復: modelMessages.length,
        總計: messages.length
      });
      console.log('[Gemini 分類助手] [對話提取] 消息已按時間順序排列');

      // 如果有新消息，保存它們
      if (messages.length > 0) {
        // 確保有有效的 chatId
        if (!chatIdToUse) {
          console.warn('[Gemini 分類助手] [對話提取] ⚠️ 沒有有效的對話 ID，無法保存消息');
          return messages; // 仍然返回消息，但不保存
        }
        
        // 過濾出真正的新消息（通過 hash 檢查）
        const newMessages = [];
        messages.forEach(msg => {
          const messageHash = `${msg.role}_${msg.text.substring(0, 100)}_${msg.text.length}`;
          if (!recordedMessages.has(messageHash)) {
            newMessages.push({
              ...msg,
              hash: messageHash
            });
            recordedMessages.add(messageHash);
          }
        });

        if (newMessages.length > 0) {
          console.log('[Gemini 分類助手] [對話提取] 發現', newMessages.length, '條新消息，準備保存 (chatId:', chatIdToUse, ')');
          
          // 通知 background.js 保存消息
          if (isRuntimeValid()) {
            const data = {
              chatId: chatIdToUse, // 使用提取到的 chatId（可能從 URL 或臨時 ID）
              messages: newMessages,
              userProfile: currentUserProfile || 'default'
            };
            
            console.log('[Gemini 分類助手] [對話提取] 準備保存消息:', {
              chatId: chatIdToUse,
              messageCount: newMessages.length,
              userProfile: currentUserProfile || 'default'
            });

            // 【修正通訊崩潰】所有 sendMessage 前必須加上檢查，防止 context invalidated 錯誤
            if (!chrome.runtime?.id) {
              console.warn('[Gemini 分類助手] 插件環境失效，請手動重新整理頁面');
              return;
            }
            
            chrome.runtime.sendMessage({
              action: 'saveConversationMessages',
              data: data
            }, (response) => {
              if (chrome.runtime.lastError) {
                console.error('[Gemini 分類助手] [對話提取] 發送消息失敗:', chrome.runtime.lastError.message);
                return;
              }
              
              if (response && response.status === 'ok') {
                console.log('[Gemini 分類助手] [對話提取] ✓ 新消息已保存');
              }
            });
          }
        }
      }

      console.log('[Gemini 分類助手] [對話提取] ========== 提取完成 ==========');
      return messages;
    } catch (error) {
      console.error('[Gemini 分類助手] [對話提取] ❌ 提取消息時發生錯誤:', error);
      console.error('[Gemini 分類助手] [對話提取] 錯誤堆疊:', error.stack);
      return [];
    }
  }

  // 保留舊函數名作為別名（向後兼容）
  function extractAndSaveMessages() {
    return scrapeMessages();
  }
  
  // 強制提取函數：不論有沒有對話 ID，看到圖就抓（針對 lh3 路徑的暴力補強，優化版：去重 + 優先抓大圖）
  async function forceExtractRealImage() {
    try {
      // 只檢查 runtime 是否有效，不檢查對話 ID（暴力模式：看到圖就抓）
      if (!isRuntimeValid()) {
        return;
      }
      
      // 【核心優化】鎖定截圖中的關鍵結構，優先查找已加載的大圖
      // 策略 1: 優先查找 button.image-button 內已加載的圖片（最可靠）
      const imageButtons = document.querySelectorAll('button.image-button');
      const allPossibleImgs = [];
      
      // 收集所有可能的圖片，按優先級排序（已加載的優先）
      imageButtons.forEach(button => {
        // 策略 1: 優先查找已加載的 img 元素
        const loadedImg = button.querySelector('img.image.loaded');
        if (loadedImg) {
          allPossibleImgs.push({ img: loadedImg, container: button, priority: 1 });
        } else {
          const img = button.querySelector('img.image, img');
          if (img) {
            allPossibleImgs.push({ img: img, container: button, priority: 2 });
          }
        }
        
        // 策略 2: 如果沒有找到 img 元素，嘗試從背景圖中提取
        if (!loadedImg && !button.querySelector('img')) {
          try {
            const computedStyle = window.getComputedStyle(button);
            const backgroundImage = computedStyle.backgroundImage;
            
            if (backgroundImage && backgroundImage !== 'none') {
              const urlMatch = backgroundImage.match(/url\(['"]?([^'"]+)['"]?\)/);
              if (urlMatch && urlMatch[1]) {
                const bgUrl = urlMatch[1];
                // 檢查是否是有效的圖片 URL
                if (bgUrl.includes('googleusercontent.com') && bgUrl.length > 200 && 
                    !bgUrl.includes('/profile/picture/') && 
                    !bgUrl.includes('profile/picture')) {
                  console.log('[Gemini 分類助手] [強制提取] ✓ 從 button.image-button 的背景圖中提取到 URL:', bgUrl.substring(0, 100));
                  // 創建臨時 img 元素
                  const tempImg = document.createElement('img');
                  tempImg.src = bgUrl;
                  tempImg.dataset.backgroundImage = 'true';
                  allPossibleImgs.push({ img: tempImg, container: button, priority: 1.5 }); // 背景圖優先級介於已加載和未加載之間
                }
              }
            }
          } catch (error) {
            console.error('[Gemini 分類助手] [強制提取] 提取背景圖時發生錯誤:', error);
          }
        }
      });
      
      // 策略 2: 如果沒找到，查找 single-image 內的圖片
      if (allPossibleImgs.length === 0) {
        document.querySelectorAll('single-image img').forEach(img => {
          allPossibleImgs.push({ img: img, container: img.closest('single-image'), priority: 3 });
        });
      }
      
      let foundValidImages = 0;
      const candidateImages = []; // 候選圖片列表（用於比較長度，選最長的）
      
      // 第一遍：收集所有候選圖片（按 URL 長度排序，優先選擇最長的）
      allPossibleImgs.forEach(({ img, container, priority }) => {
        try {
          const src = img.src || img.getAttribute('src') || '';
          
          // 【嚴格過濾】只接受真正的生成圖：
          // 1. 必須包含 googleusercontent.com
          // 2. URL 長度必須 > 200（真正的原圖路徑很長）
          // 3. 必須排除佔位符
          // 4. 優先選擇包含特定關鍵詞的 URL（gg-dl, rd-gg-dl, image_generation）
          if (src.includes('googleusercontent.com') && 
              src.length > 200 && 
              !src.includes('/profile/picture/') && 
              !src.includes('profile/picture') &&
              !src.includes('/picture/')) {
            
            // 【統一去重】使用 urlKey 而不是完整的 src，與 triggerAutoDownload 保持一致
            const urlKey = getUrlKey(src, 200);
            if (processedImageUrls.has(urlKey)) {
              return; // 已處理過，跳過
            }
            
            // 計算優先級分數（URL 越長、包含關鍵詞越多，分數越高）
            let score = src.length;
            if (src.includes('gg-dl') || src.includes('rd-gg-dl')) score += 1000;
            if (src.includes('image_generation')) score += 500;
            if (src.includes('lh3.googleusercontent.com')) score += 300;
            
            candidateImages.push({
              img: img,
              container: container,
              src: src,
              priority: priority,
              score: score
            });
          }
        } catch (e) {
          // 靜默跳過錯誤
        }
      });
      
      // 按分數排序，優先處理分數最高的（最可能是真正的大圖）
      candidateImages.sort((a, b) => b.score - a.score);
      
      // 第二遍：處理候選圖片（只處理前 5 個最優先的，避免太多）
      // 使用 for...of 循環以支持 async/await
      for (let index = 0; index < Math.min(5, candidateImages.length); index++) {
        try {
          const candidate = candidateImages[index];
          const { img, src } = candidate;
          
          // 【統一去重】使用 urlKey 而不是完整的 src，與 triggerAutoDownload 保持一致
          const urlKey = getUrlKey(src, 200);
          
          // 先檢查內存緩存
          if (processedImageUrls.has(urlKey)) {
            continue;
          }
          
          // 【檢查持久化 storage】避免重複處理已下載的圖片
          const checkResult = await checkDownloadHistory(src, urlKey, currentChatId);
          if (checkResult.exists) {
            // 已下載過，標記為已處理並跳過
            processedImageUrls.add(urlKey);
            continue;
          }
          
          // 標記為已處理（使用 urlKey）
          processedImageUrls.add(urlKey);
          
          foundValidImages++;
          console.log('[Gemini 分類助手] [強制提取]   ✅ 發現生成圖 #' + foundValidImages + '（分數: ' + candidate.score + '）');
          console.log('[Gemini 分類助手] [強制提取]      URL 長度:', src.length);
          console.log('[Gemini 分類助手] [強制提取]      URL 預覽:', src.substring(0, 200));
          
          // 【自動模式降溫】若 URL 不含 gg-dl 或 image_generation 關鍵字（代表只是 200K 的預覽圖），則不執行 triggerAutoDownload
          const isHighQualityImage = src.includes('gg-dl') || src.includes('rd-gg-dl') || src.includes('image_generation');
          if (!isHighQualityImage) {
            console.log('[Gemini 分類助手] [強制提取]   ⏭️ 跳過：URL 不含 gg-dl 或 image_generation（可能是預覽圖）');
            continue;
          }
          
          const requestId = 'manual_extract_' + Date.now() + '_' + index;
          
          // 【統一處理】直接調用 triggerAutoDownload，它會處理去重檢查
          sendImageToSidePanel(src, requestId, img);
          triggerAutoDownload(src, requestId, null, 'highres', 'forceExtractRealImage');
        } catch (e) {
          console.error('[Gemini 分類助手] [強制提取]   處理圖片時發生錯誤:', e);
        }
      }
      
      if (foundValidImages > 0) {
        console.log('[Gemini 分類助手] [強制提取] 🔥 本次掃描共發現', foundValidImages, '張有效生成圖（已去重）');
      } else if (candidateImages.length > 5) {
        console.log('[Gemini 分類助手] [強制提取]   發現', candidateImages.length, '個候選圖片，但只處理前 5 個最優先的');
      }
    } catch (error) {
      console.error('[Gemini 分類助手] [強制提取] ❌ 強制提取函數執行錯誤:', error);
    }
  }
  
  // 啟動強制提取定時器（每 2 秒掃描一次，暴力模式：不論有沒有對話 ID）
  function startForceExtractInterval() {
    // 避免重複啟動（如果已經在運行，直接返回）
    if (forceExtractInterval !== null) {
      return;
    }
    
    // 只檢查 runtime 是否有效，不檢查對話 ID（暴力模式：看到圖就抓）
    if (!isRuntimeValid()) {
      return;
    }
    
    console.log('[Gemini 分類助手] [強制提取] 🔥 啟動強制提取定時器（每 5 秒掃描一次，暴力模式：不論有沒有對話 ID）');
    
    // 立即執行一次
    forceExtractRealImage();
    
    // 【效能優化】降低掃描頻率至每 10 秒一次（避免重複處理）
    forceExtractInterval = setInterval(() => {
      if (!isRuntimeValid()) {
        // 如果上下文失效，停止定時器
        if (forceExtractInterval) {
          clearInterval(forceExtractInterval);
          forceExtractInterval = null;
          console.log('[Gemini 分類助手] [強制提取] ⏹️ 停止強制提取定時器（上下文失效）');
        }
        return;
      }
      forceExtractRealImage();
    }, 5000); // 從 2000ms 改為 5000ms
  }
  
  // 停止強制提取定時器
  function stopForceExtractInterval() {
    if (forceExtractInterval) {
      clearInterval(forceExtractInterval);
      forceExtractInterval = null;
      console.log('[Gemini 分類助手] [強制提取] ⏹️ 停止強制提取定時器');
    }
  }
  
  // 將圖片轉換為 Base64（破解 CSP 封鎖，不修改原始圖片）
  function convertImageToBase64(imgElement) {
    return new Promise((resolve, reject) => {
      try {
        // 重要：不修改原始圖片的屬性，只讀取和轉換
        // 如果圖片 URL 是 data: 或 blob:，直接返回
        if (imgElement.src && (imgElement.src.startsWith('data:') || imgElement.src.startsWith('blob:'))) {
          resolve(imgElement.src);
          return;
        }
        
        // 創建新的 Image 對象用於轉換（不影響原始圖片）
        const img = new Image();
        img.crossOrigin = 'anonymous';
        
        const handleLoad = () => {
          try {
            const canvas = document.createElement('canvas');
            canvas.width = img.naturalWidth || img.width || 1024;
            canvas.height = img.naturalHeight || img.height || 1024;
            
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            
            const base64String = canvas.toDataURL('image/png');
            console.log('[Gemini 分類助手] [Base64轉換] ✓ 圖片已轉換為 Base64 (大小:', (base64String.length / 1024).toFixed(2), 'KB)');
            resolve(base64String);
          } catch (error) {
            console.error('[Gemini 分類助手] [Base64轉換] Canvas 轉換失敗:', error);
            // 如果 Canvas 轉換失敗，回退到原始 URL
            resolve(imgElement.src || '');
          }
        };
        
        const handleError = () => {
          console.error('[Gemini 分類助手] [Base64轉換] 圖片加載失敗，使用原始 URL');
          // 如果加載失敗，使用原始 URL（不轉換為 Base64）
          resolve(imgElement.src || '');
        };
        
        img.addEventListener('load', handleLoad, { once: true });
        img.addEventListener('error', handleError, { once: true });
        
        // 如果原始圖片已加載，直接使用原始 URL 創建新圖片
        if (imgElement.complete && imgElement.naturalWidth > 0) {
          img.src = imgElement.src;
        } else {
          // 等待原始圖片加載完成
          const originalLoadHandler = () => {
            img.src = imgElement.src;
          };
          imgElement.addEventListener('load', originalLoadHandler, { once: true });
          imgElement.addEventListener('error', handleError, { once: true });
          
          // 如果圖片已經有 src，立即設置
          if (imgElement.src) {
            img.src = imgElement.src;
          } else {
            handleError();
          }
        }
      } catch (error) {
        console.error('[Gemini 分類助手] [Base64轉換] 轉換過程發生錯誤:', error);
        // 如果轉換失敗，回退到原始 URL
        resolve(imgElement.src || '');
      }
    });
  }

  // 從 download-generated-image-button 提取真實圖片 URL
  async function extractImageFromDownloadButton(downloadButton) {
    try {
      const jslog = downloadButton.getAttribute('jslog') || '';
      
      // 嘗試從 jslog 中提取真實圖片 URL
      // jslog 可能包含高解析度圖片網址
      const urlMatches = jslog.match(/https?:\/\/[^\s"']+/g);
      if (urlMatches && urlMatches.length > 0) {
        // 優先選擇 googleusercontent.com 相關的 URL
        const googleUrl = urlMatches.find(url => 
          url.includes('googleusercontent.com') && 
          (url.includes('gg-dl') || url.includes('rd-gg-dl') || url.includes('image_generation'))
        );
        if (googleUrl) {
          console.log('[Gemini 分類助手] [下載按鈕] ✓ 從 jslog 提取到真實圖片 URL:', googleUrl.substring(0, 100));
          return googleUrl;
        }
        // 如果沒有找到 Google URL，使用第一個匹配的 URL
        console.log('[Gemini 分類助手] [下載按鈕] ✓ 從 jslog 提取到 URL:', urlMatches[0].substring(0, 100));
        return urlMatches[0];
      }
      
      // 如果 jslog 中沒有 URL，嘗試模擬點擊按鈕（可能會觸發下載或顯示 URL）
      // 注意：模擬點擊可能不會立即返回 URL，所以這裡主要依賴 jslog 提取
      console.log('[Gemini 分類助手] [下載按鈕] ⚠️ jslog 中未找到圖片 URL');
      return null;
    } catch (error) {
      console.error('[Gemini 分類助手] [下載按鈕] 提取 URL 時發生錯誤:', error);
      return null;
    }
  }

  // 監聽圖片 src 變化（跳過佔位符）
  function watchImageSrcChange(imgElement, timeout = 5000) {
    return new Promise((resolve) => {
      const startTime = Date.now();
      const originalSrc = imgElement.src || imgElement.getAttribute('src') || '';
      
      // 如果已經是有效的圖片 URL（不是佔位符），立即返回
      if (originalSrc && 
          !originalSrc.includes('/profile/') && 
          !originalSrc.includes('/picture/') &&
          !originalSrc.includes('profile-picture') &&
          !originalSrc.includes('avatar') &&
          (originalSrc.includes('googleusercontent.com') || originalSrc.startsWith('blob:'))) {
        console.log('[Gemini 分類助手] [佔位符監聽] 圖片 URL 已有效，無需等待');
        resolve(originalSrc);
        return;
      }
      
      // 創建 MutationObserver 監聽 src 變化
      const observer = new MutationObserver((mutations) => {
        mutations.forEach(mutation => {
          if (mutation.type === 'attributes' && 
              (mutation.attributeName === 'src' || mutation.attributeName === 'data-src')) {
            const newSrc = imgElement.src || imgElement.getAttribute('src') || '';
            
            // 檢查新 src 是否是有效圖片（不是佔位符）
            if (newSrc && 
                newSrc !== originalSrc &&
                !newSrc.includes('/profile/') && 
                !newSrc.includes('/picture/') &&
                !newSrc.includes('profile-picture') &&
                !newSrc.includes('avatar') &&
                (newSrc.includes('googleusercontent.com') || (newSrc.startsWith('blob:') && !newSrc.startsWith('blob:null/')))) {
              console.log('[Gemini 分類助手] [佔位符監聽] ✓ 檢測到有效圖片 URL:', newSrc.substring(0, 100));
              observer.disconnect();
              resolve(newSrc);
            }
          }
        });
        
        // 超時檢查
        if (Date.now() - startTime > timeout) {
          console.log('[Gemini 分類助手] [佔位符監聽] ⏱️ 等待超時，使用當前 URL');
          observer.disconnect();
          resolve(imgElement.src || imgElement.getAttribute('src') || originalSrc);
        }
      });
      
      // 開始監聽
      observer.observe(imgElement, {
        attributes: true,
        attributeFilter: ['src', 'data-src', 'data-original', 'data-image-url']
      });
      
      // 設置超時
      setTimeout(() => {
        observer.disconnect();
        const currentSrc = imgElement.src || imgElement.getAttribute('src') || originalSrc;
        console.log('[Gemini 分類助手] [佔位符監聽] ⏱️ 超時結束，當前 URL:', currentSrc.substring(0, 100));
        resolve(currentSrc);
      }, timeout);
    });
  }

  // 監聽單個圖片的 src 變化（用於佔位符檢測）
  function watchImageSrcForPlaceholder(imgElement, currentMessageId, timeout = 10000) {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      const originalSrc = imgElement.src || imgElement.getAttribute('src') || '';
      
      console.log('[Gemini 分類助手] [圖片監聽] 開始監聽圖片 src 變化:', originalSrc.substring(0, 100));
      
      // 如果已經是有效的圖片 URL（不是佔位符），立即返回
      if (originalSrc && 
          !originalSrc.includes('/profile/') && 
          !originalSrc.includes('/picture/') &&
          !originalSrc.includes('profile-picture') &&
          !originalSrc.includes('avatar') &&
          (originalSrc.includes('googleusercontent.com') || originalSrc.startsWith('blob:'))) {
        console.log('[Gemini 分類助手] [圖片監聽] 圖片 URL 已有效，無需等待');
        resolve(originalSrc);
        return;
      }
      
      // 創建 MutationObserver 監聽 src 變化
      const observer = new MutationObserver((mutations) => {
        mutations.forEach(mutation => {
          if (mutation.type === 'attributes' && 
              (mutation.attributeName === 'src' || mutation.attributeName === 'data-src')) {
            const newSrc = imgElement.src || imgElement.getAttribute('src') || '';
            
            // 檢查新 src 是否是有效圖片（不再包含 profile）
            if (newSrc && 
                newSrc !== originalSrc &&
                !newSrc.includes('/profile/') && 
                !newSrc.includes('/picture/') &&
                !newSrc.includes('profile-picture') &&
                !newSrc.includes('avatar') &&
                (newSrc.includes('googleusercontent.com') || (newSrc.startsWith('blob:') && !newSrc.startsWith('blob:null/')))) {
              console.log('[Gemini 分類助手] [圖片監聽] ✓ 檢測到有效圖片 URL:', newSrc.substring(0, 100));
              observer.disconnect();
              
              // 立即觸發 chrome.runtime.sendMessage 將新網址與 currentMessageId 傳送到 Side Panel
              sendImageToSidePanel(newSrc, currentMessageId, imgElement);
              
              resolve(newSrc);
            }
          }
        });
      });
      
      // 開始監聽
      observer.observe(imgElement, {
        attributes: true,
        attributeFilter: ['src', 'data-src', 'data-original', 'data-image-url']
      });
      
      // 設置超時（10 秒）
      const timeoutId = setTimeout(() => {
        observer.disconnect();
        const currentSrc = imgElement.src || imgElement.getAttribute('src') || originalSrc;
        console.log('[Gemini 分類助手] [圖片監聽] ⏱️ 10 秒超時，當前 URL:', currentSrc.substring(0, 100));
        
        // 如果 10 秒後 src 仍未改變，嘗試抓取同層級的 <download-generated-image-button> 中的連結
        if (currentSrc === originalSrc || currentSrc.includes('/profile/') || currentSrc.includes('/picture/')) {
          // 靜默處理：src 仍為佔位符，嘗試從下載按鈕提取
          tryExtractFromDownloadButton(imgElement, currentMessageId).then(downloadUrl => {
            if (downloadUrl) {
              resolve(downloadUrl);
            } else {
              reject(new Error('10 秒後 src 仍未改變且無法從下載按鈕提取'));
            }
          });
        } else {
          resolve(currentSrc);
        }
      }, timeout);
      
      // 清理函數
      const cleanup = () => {
        clearTimeout(timeoutId);
        observer.disconnect();
      };
      
      // 如果圖片已載入（且不是佔位符），立即清理
      if (imgElement.complete && imgElement.naturalWidth > 0) {
        const currentSrc = imgElement.src || imgElement.getAttribute('src') || '';
        if (!currentSrc.includes('/profile/') && !currentSrc.includes('/picture/')) {
          cleanup();
          resolve(currentSrc);
        }
      }
    });
  }

  // 監控圖片載入：當圖片從佔位符變更為真實路徑時自動下載
  function observeImageLoading(container, messageId) {
    try {
      console.log('[Gemini 分類助手] [圖片監控] 開始監控圖片載入...');
      
      // 使用更寬鬆的選擇器查找圖片
      let img = container.querySelector('button.image-button img.image.loaded');
      if (!img) {
        // 嘗試查找 class 包含 loaded 或 image 的圖片
        const allImages = container.querySelectorAll('button.image-button img');
        for (const imgCandidate of allImages) {
          if (imgCandidate.classList.contains('loaded') || imgCandidate.classList.contains('image')) {
            img = imgCandidate;
            break;
          }
        }
      }
      // 如果還是沒找到，直接查找任何 button.image-button 內的 img
      if (!img) {
        img = container.querySelector('button.image-button img');
      }
      // 最後備用：查找 single-image 或 generated-image 內的 img
      if (!img) {
        img = container.querySelector('single-image img') || container.querySelector('generated-image img');
      }
      
      if (!img) {
        console.log('[Gemini 分類助手] [圖片監控] ⚠️ 未找到任何圖片元素');
        console.log('[Gemini 分類助手] [圖片監控]   嘗試搜索的容器:', container.tagName, container.className?.substring(0, 50));
        return;
      }
      
      console.log('[Gemini 分類助手] [圖片監控]   ✓ 找到圖片元素');
      console.log('[Gemini 分類助手] [圖片監控]   img.className:', img.className);
      
      const metadata = container.querySelector('single-image')?.getAttribute('jslog');
      const requestIdMatch = metadata?.match(/BardVeMetadataKey:\[\["(.*?)",/);
      const requestId = requestIdMatch ? requestIdMatch[1] : messageId?.replace('message-content-id-', '') || 'unknown';
      
      console.log('[Gemini 分類助手] [圖片監控]   ✓ 找到圖片元素');
      console.log('[Gemini 分類助手] [圖片監控]   requestId:', requestId);
      console.log('[Gemini 分類助手] [圖片監控]   當前 src:', img.src?.substring(0, 100) || '無');
      
      // 如果已經是有效圖片，立即下載
      if (img.src && !img.src.includes('profile/picture') && !img.src.includes('/profile/')) {
        console.log('[Gemini 分類助手] [圖片監控]   ✅ 圖片已經是有效 URL，立即下載');
        triggerAutoDownload(img.src, requestId, null, 'highres', 'observeImageLoading_immediate');
        return;
      }
      
      // 創建 MutationObserver 監聽 src 變化
      const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
          if (mutation.attributeName === 'src') {
            const currentSrc = img.src;
            console.log('[Gemini 分類助手] [圖片監控]   📍 src 屬性已變更:', currentSrc?.substring(0, 100) || '無');
            
            // 排除佔位符，只處理真實圖片 URL
            if (currentSrc && !currentSrc.includes('profile/picture') && !currentSrc.includes('/profile/')) {
              console.log('[Gemini 分類助手] [圖片監控]   ✅ 真實圖片已現身！啟動下載程序...');
              console.log('[Gemini 分類助手] [圖片監控]   完整 URL:', currentSrc.substring(0, 150));
              
              // 觸發自動下載
              triggerAutoDownload(currentSrc, requestId, null, 'highres', 'observeImageLoading_srcChange');
              
              // 同時發送到 Side Panel
              sendImageToSidePanel(currentSrc, messageId || requestId, img);
              
              // 下載完就停止監控
              observer.disconnect();
              console.log('[Gemini 分類助手] [圖片監控]   ✓ 監控已停止（圖片已下載）');
            }
          }
        });
      });
      
      // 開始監聽 img 元素的 attributes 變化
      observer.observe(img, { 
        attributes: true, 
        attributeFilter: ['src', 'data-src'] 
      });
      
      console.log('[Gemini 分類助手] [圖片監控]   ✓ MutationObserver 已啟動，等待圖片載入...');
      
      // 設置超時（30秒後自動停止監控）
      setTimeout(() => {
        observer.disconnect();
        console.log('[Gemini 分類助手] [圖片監控]   ⏱️ 30 秒超時，停止監控');
      }, 30000);
      
    } catch (error) {
      console.error('[Gemini 分類助手] [圖片監控] ❌ 監控圖片載入時發生錯誤:', error);
    }
  }
  
  // 觸發自動下載（發送消息到 background.js，添加去重機制）
  // 清理文件名（移除無效字符）
  // 【修正下載路徑】清理檔名和路徑，確保斜線、冒號等非法字元一律替換為底線
  function cleanFilename(name) {
    if (!name) return '';
    return name
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') // 將所有非法字符（包括斜線 / 和冒號 :）替換為底線
      .replace(/\s+/g, '_') // 空格替換為下劃線
      .replace(/_+/g, '_') // 將多個連續底線合併為單個底線
      .replace(/^_|_$/g, '') // 移除開頭和結尾的底線
      .substring(0, 50); // 限制長度
  }

  // 【圖片分級策略】檢查圖片大小並下載：小尺寸預覽圖（約 200K，不含 =s0）和高畫質原圖（含 =s0，原始尺寸，大小因內容而異）分別處理
  async function checkImageSizeAndDownload(imageData) {
    try {
      if (!imageData.url) {
        console.warn('[Gemini 分類助手] [圖片分級] 沒有圖片 URL，跳過');
        return;
      }

      // 【通訊檢查】檢查 runtime 是否有效
      if (!chrome.runtime?.id) {
        // 靜默處理，不輸出警告（避免重複日誌）
        return;
      }

      const imageUrl = imageData.url;
      // 判斷邏輯：URL 中包含 =s0 參數代表原始尺寸（original size），不一定是 7MB+，大小取決於圖片內容
      // =s0 在 Google 圖片 URL 中表示「原始尺寸」，簡單圖片可能只有幾百 KB，複雜圖片可能達到 7MB+
      const isHighRes = imageUrl.includes('=s0'); // 高畫質原圖標記（原始尺寸）
      const requestId = imageData.requestId || imageData.id || Date.now().toString();
      
      // 【圖片分級策略】判斷圖片類型
      if (isHighRes) {
        // 高畫質原圖（含 =s0，原始尺寸）：檢查資料庫，若未下載過則執行下載
        // 注意：=s0 代表原始尺寸，但實際文件大小可能從幾百 KB 到 7MB+ 不等，取決於圖片內容複雜度
        console.log('[Gemini 分類助手] [圖片分級] 🔍 檢測到高畫質原圖（含 =s0，原始尺寸）');
        const checkResult = await checkDownloadHistory(imageUrl, requestId, currentChatId);
        if (checkResult.exists) {
          console.log('[Gemini 分類助手] [圖片分級] ⏭️ 高畫質原圖已下載過，跳過');
          return;
        }
        
        // 下載高畫質原圖
        const cleanTitle = cleanFilename(currentTitle || (currentChatId ? `Chat_${currentChatId.substring(0, 20)}` : '未命名對話'));
        const requestIdShort = requestId ? requestId.substring(0, 20) : Date.now().toString();
        const filename = `${requestIdShort}_${Date.now()}.png`;
        
        console.log('[Gemini 分類助手] [圖片分級] ✅ 開始下載高畫質原圖');
        await triggerAutoDownload(imageUrl, requestId, filename, 'highres', 'checkImageSizeAndDownload_highres');
      } else {
        // 小尺寸預覽圖（不含 =s0，約 200K）：僅限一張
        console.log('[Gemini 分類助手] [圖片分級] 🔍 檢測到小尺寸預覽圖（不含 =s0）');
        
        // 檢查該對話是否已保存預覽圖
        const hasThumbnail = await hasThumbnailSaved(currentChatId);
        if (hasThumbnail) {
          console.log('[Gemini 分類助手] [圖片分級] ⏭️ 該對話已保存預覽圖，跳過');
          return;
        }
        
        // 檢查資料庫，若未下載過則執行下載
        const checkResult = await checkDownloadHistory(imageUrl, requestId, currentChatId);
        if (checkResult.exists) {
          console.log('[Gemini 分類助手] [圖片分級] ⏭️ 預覽圖已下載過，跳過');
          return;
        }
        
        // 下載預覽圖（僅限一張）
        const cleanTitle = cleanFilename(currentTitle || (currentChatId ? `Chat_${currentChatId.substring(0, 20)}` : '未命名對話'));
        const requestIdShort = requestId ? requestId.substring(0, 20) : Date.now().toString();
        const filename = `thumbnail_${requestIdShort}_${Date.now()}.png`;
        
        console.log('[Gemini 分類助手] [圖片分級] ✅ 開始下載預覽圖（僅限一張）');
        await triggerAutoDownload(imageUrl, requestId, filename, 'thumbnail', 'checkImageSizeAndDownload_thumbnail');
        
        // 標記該對話已保存預覽圖
        await markThumbnailSaved(currentChatId);
      }
    } catch (error) {
      console.error('[Gemini 分類助手] [圖片分級] 檢查大小時發生錯誤:', error);
    }
  }

  // 【統一圖片處理入口】所有圖片下載都通過這個函數，確保去重邏輯一致
  // source: 來源標識，用於追蹤是哪個函數觸發的下載
  async function processImageDownload(imageUrl, requestId, filename, imageType = 'highres', source = 'unknown') {
    if (!imageUrl) {
      console.error('[Gemini 分類助手] [圖片處理] ❌ 圖片 URL 為空');
      return { processed: false, reason: 'empty_url' };
    }
    
    const isManual = requestId && (requestId.includes('manual') || requestId.includes('test'));
    const urlKey = getUrlKey(imageUrl, 200);
    
    // 【立即檢查內存緩存】防止並發調用
    if (!isManual && processedImageUrls.has(urlKey)) {
      console.log('[Gemini 分類助手] [圖片處理] ⏭️ 跳過重複下載（內存緩存）:', urlKey.substring(0, 100), '來源:', source);
      return { processed: false, reason: 'memory_cache' };
    }
    
    // 【持久化資料庫檢查】在任何下載行為發生前，必須先 await 讀取 storage
    if (!isManual) {
      const checkResult = await checkDownloadHistory(imageUrl, urlKey, currentChatId);
      if (checkResult.exists) {
        console.log('[Gemini 分類助手] [圖片處理] ⏭️ 跳過重複下載（資料庫檢查）:', urlKey.substring(0, 100), '類型:', checkResult.type, '來源:', source);
        return { processed: false, reason: 'database', type: checkResult.type };
      }
    }
    
    // 標記為已處理（防止並發）
    if (!isManual) {
      processedImageUrls.add(urlKey);
    }
    
    // 執行下載
    await triggerAutoDownload(imageUrl, requestId, filename, imageType);
    return { processed: true, urlKey };
  }

  // 【下載日誌】記錄下載來源的堆疊追蹤
  let downloadSourceStack = [];
  
  // 獲取調用堆疊（用於追蹤下載來源）
  function getDownloadSource() {
    try {
      const stack = new Error().stack;
      if (!stack) return 'unknown';
      
      // 解析堆疊，找出調用 triggerAutoDownload 的函數
      const stackLines = stack.split('\n');
      for (let i = 1; i < stackLines.length && i < 10; i++) {
        const line = stackLines[i];
        // 跳過 triggerAutoDownload 本身
        if (line.includes('triggerAutoDownload')) continue;
        // 跳過 processImageDownload
        if (line.includes('processImageDownload')) continue;
        // 查找實際的調用者
        if (line.includes('forceExtractRealImage')) return 'forceExtractRealImage';
        if (line.includes('extractGeneratedImages')) return 'extractGeneratedImages';
        if (line.includes('observeImageLoading')) return 'observeImageLoading';
        if (line.includes('setupImageObserver')) return 'setupImageObserver';
        if (line.includes('checkImageSizeAndDownload')) return 'checkImageSizeAndDownload';
        if (line.includes('getRealImagePath')) return 'getRealImagePath';
        if (line.includes('clickDownloadButtonByIndex')) return 'clickDownloadButtonByIndex';
        if (line.includes('extractImages')) return 'extractImages';
        if (line.includes('scrapeMessages')) return 'scrapeMessages';
      }
      return 'unknown';
    } catch (e) {
      return 'unknown';
    }
  }

  async function triggerAutoDownload(imageUrl, requestId, filename, imageType = 'highres', sourceOverride = null) {
    // 取消自動下載：仍保留「圖片偵測/記錄/右側顯示」，只是不再觸發下載
    if (!autoDownloadEnabled) {
      return;
    }

    if (!imageUrl) {
      console.error('[Gemini 分類助手] [自動下載] ❌ 圖片 URL 為空');
      return;
    }

    const isManual = requestId && (requestId.includes('manual') || requestId.includes('test'));
    if (stopAutoDownloadAfterSuccess && autoDownloadSuccessOnce && !isManual) {
      return;
    }
    
    // 【過濾無效 URL】跳過 blob:null/ 開頭的無效 URL
    if (imageUrl && typeof imageUrl === 'string' && imageUrl.startsWith('blob:null/')) {
      // console.log('[Gemini 分類助手] [自動下載] ⏭️ 跳過無效的 blob:null URL:', imageUrl.substring(0, 50)); // 已禁用，避免大量日誌
      return;
    }
    
    // 【下載日誌】記錄來源
    const downloadSource = sourceOverride || getDownloadSource();
    downloadSourceStack.push({
      source: downloadSource,
      url: imageUrl.substring(0, 200),
      timestamp: Date.now()
    });
    // 只保留最近 100 條記錄
    if (downloadSourceStack.length > 100) {
      downloadSourceStack.shift();
    }
    
    // 【優化去重】使用 URL 的 hash 作為唯一標識，而不是 requestId（因為 requestId 可能每次都不同）
    const urlKey = getUrlKey(imageUrl, 200);
    
    // 【持久化去重資料庫】手動點擊時，清除記憶體快取，但持久化資料庫仍會檢查
    if (isManual) {
      processedImageUrls.clear();
    } else {
      // 【立即檢查內存緩存】防止並發調用（這裡應該已經在 processImageDownload 中檢查過了，但為了安全還是再檢查一次）
      if (processedImageUrls.has(urlKey)) {
        console.log('[Gemini 分類助手] [自動下載] ⏭️ 跳過重複下載（內存緩存）:', urlKey.substring(0, 100));
        return;
      }
      
      // 立即標記為已處理（防止並發）
      processedImageUrls.add(urlKey);
    }

    // 【持久化資料庫】在任何下載行為發生前，必須先 await 讀取 storage。如果該圖片的 URL 已存在，則絕對禁止執行後續邏輯
    // 注意：使用 urlKey 而不是 requestId 進行檢查，因為 requestId 可能每次都不同
    if (!isManual) {
      const checkResult = await checkDownloadHistory(imageUrl, urlKey, currentChatId);
      if (checkResult.exists) {
        console.log('[Gemini 分類助手] [自動下載] ⏭️ 跳過重複下載（資料庫檢查）:', urlKey.substring(0, 100), '類型:', checkResult.type);
        // 從內存緩存中移除，允許重試（如果資料庫記錄有問題）
        processedImageUrls.delete(urlKey);
        return;
      }
    }

    // 如果沒有提供文件名，使用 currentTitle 和 requestId 生成文件名
    if (!filename) {
      const cleanTitle = cleanFilename(currentTitle || '未命名對話');
      const requestIdShort = requestId ? requestId.substring(0, 20) : Date.now().toString();
      filename = `Gemini_${cleanTitle}_${requestIdShort}_${formatDate(Date.now())}.png`;
    }
    
    // 【過濾 unnamed 格式】如果檔名包含 "unnamed"，跳過下載（優先選擇另一種命名格式）
    if (filename && (filename.toLowerCase().includes('unnamed') || filename.includes('未命名'))) {
      console.log('[Gemini 分類助手] [自動下載] ⏭️ 跳過 unnamed 格式的檔案:', filename);
      // 從內存緩存中移除，允許其他格式的下載
      if (!isManual) {
        processedImageUrls.delete(urlKey);
      }
      return;
    }

    // 【檔名隨機化】手動下載的檔名除了 timestamp，請額外加上一個隨機字串（Math.random），避免瀏覽器下載管理器因為檔名衝突而取消任務
    const finalFilename = isManual 
      ? filename.replace('.png', `_${Date.now()}_${Math.random().toString(36).substring(7)}.png`)
      : filename;

    // 【修正通訊崩潰】所有 sendMessage 前必須加上檢查，防止 context invalidated 錯誤
    if (!chrome.runtime?.id) {
      console.warn('[Gemini 分類助手] 插件環境失效，請手動重新整理頁面');
      return;
    }
    
    // 【自動化二級資料夾命名】傳遞對話標題或 chatId 給 background.js
    const conversationTitle = currentTitle || (currentChatId ? `Chat_${currentChatId.substring(0, 20)}` : '未命名對話');
    
    // 【優化】使用 URL 的 hash 作為穩定的 requestId，而不是每次都加 Date.now()
    // 這樣可以確保同一張圖片的 requestId 始終相同，去重檢查才能生效
    const stableRequestId = requestId && !isManual 
      ? requestId 
      : (urlKey.substring(0, 50) + '_' + btoa(urlKey).substring(0, 10)).replace(/[^a-zA-Z0-9_]/g, '_');
    
    // 【下載日誌】準備詳細的日誌信息
    const downloadLog = {
      url: imageUrl,
      urlKey: urlKey,
      urlLength: imageUrl.length,
      requestId: stableRequestId,
      originalRequestId: requestId,
      filename: finalFilename,
      originalFilename: filename,
      imageType: imageType,
      source: downloadSource,
      chatId: currentChatId,
      conversationTitle: conversationTitle,
      isManual: isManual,
      timestamp: Date.now(),
      namingRule: filename ? 'provided' : 'generated',
      namingDetails: filename ? {
        provided: filename,
        final: finalFilename,
        rule: isManual ? 'manual_with_random' : 'auto_with_timestamp'
      } : {
        generated: finalFilename,
        rule: `Gemini_${cleanTitle}_${requestIdShort}_${formatDate(Date.now())}`
      }
    };
    
    // 再次檢查 runtime（確保在發送前有效）
    if (!isRuntimeValid()) return;
    
    chrome.runtime.sendMessage({
      action: "DOWNLOAD_IMAGE",
      url: imageUrl,
      filename: finalFilename,
      requestId: stableRequestId, // 使用穩定的 requestId，確保去重檢查生效
      conversationTitle: conversationTitle, // 傳遞對話標題
      chatId: currentChatId, // 傳遞 chatId
      imageType: imageType, // 'thumbnail' 或 'highres'
      downloadLog: downloadLog // 【下載日誌】傳遞詳細日誌信息
    }, async (response) => {
      if (chrome.runtime.lastError) {
        // 檢查是否為 Extension context invalidated 錯誤
        if (checkRuntimeError(chrome.runtime.lastError)) {
          // 下載失敗，從內存緩存中移除，允許重試
          if (!isManual) {
            processedImageUrls.delete(urlKey);
          }
          return;
        }
      } else {
        // 【持久化資料庫】下載後立即寫入紀錄
        if (!isManual) {
          await markImageInHistory(imageUrl, stableRequestId, currentChatId, imageType, {
            filename: finalFilename,
            conversationTitle: conversationTitle
          });
        }
      }
    });
  }
  
  // 格式化日期為 YYYYMMDD 格式
  function formatDate(timestamp) {
    const date = new Date(timestamp);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}${month}${day}`;
  }

  // 嘗試從下載按鈕提取圖片 URL（防錯處理）
  async function tryExtractFromDownloadButton(imgElement, currentMessageId) {
    try {
      console.log('[Gemini 分類助手] [下載按鈕] 嘗試從同層級的 download-generated-image-button 提取連結');
      
      // 查找同層級或父級中的 download-generated-image-button
      const parentContainer = imgElement.closest('[class*="image-button"], [class*="response"], [class*="model-response"], [data-role="model"], [data-role="assistant"]');
      if (!parentContainer) {
        console.log('[Gemini 分類助手] [下載按鈕] ⚠️ 未找到父容器');
        return null;
      }
      
      // 優先查找 download-generated-image-button 自定義元素
      let downloadButtonElement = parentContainer.querySelector('download-generated-image-button');
      let downloadButton = null;
      
      if (downloadButtonElement) {
        // 從自定義元素中查找內部的 button
        downloadButton = downloadButtonElement.querySelector('button[data-test-id="download-generated-image-button"], button[aria-label*="下載"], button[aria-label*="download"]');
      }
      
      // 如果沒找到，直接查找 button
      if (!downloadButton) {
        downloadButton = parentContainer.querySelector(
          'button[data-test-id="download-generated-image-button"], ' +
          'download-generated-image-button button, ' +
          'button[aria-label*="下載原尺寸"], ' +
          'button[aria-label*="download"][aria-label*="original"], ' +
          'button[aria-label*="download"], ' +
          'button[aria-label*="下載"]'
        );
      }
      
      if (!downloadButton) {
        console.log('[Gemini 分類助手] [下載按鈕] ⚠️ 未找到 download-generated-image-button');
        return null;
      }
      
      console.log('[Gemini 分類助手] [下載按鈕] ✓ 找到下載按鈕:', {
        tagName: downloadButton.tagName,
        dataTestId: downloadButton.getAttribute('data-test-id'),
        ariaLabel: downloadButton.getAttribute('aria-label'),
        hasJslog: !!downloadButton.getAttribute('jslog')
      });
      
      // 策略 1: 從 jslog 中提取圖片 URL
      const jslog = downloadButton.getAttribute('jslog') || '';
      if (jslog) {
        const urlMatches = jslog.match(/https?:\/\/[^\s"']+/g);
        
        if (urlMatches && urlMatches.length > 0) {
          // 優先選擇 googleusercontent.com 相關的 URL
          const googleUrl = urlMatches.find(url => 
            url.includes('googleusercontent.com') && 
            (url.includes('gg-dl') || url.includes('rd-gg-dl') || url.includes('image_generation'))
          );
          
          if (googleUrl) {
            console.log('[Gemini 分類助手] [下載按鈕] ✓ 從 jslog 提取到 URL:', googleUrl.substring(0, 100));
            sendImageToSidePanel(googleUrl, currentMessageId, imgElement);
            return googleUrl;
          }
        }
      }
      
      // 策略 2: 從按鈕的數據屬性中提取
      const dataUrl = downloadButton.getAttribute('data-url') || 
                      downloadButton.getAttribute('data-image-url') ||
                      downloadButton.getAttribute('data-download-url');
      if (dataUrl && dataUrl.includes('googleusercontent.com')) {
        console.log('[Gemini 分類助手] [下載按鈕] ✓ 從數據屬性提取到 URL:', dataUrl.substring(0, 100));
        sendImageToSidePanel(dataUrl, currentMessageId, imgElement);
        return dataUrl;
      }
      
      // 策略 3: 虛擬點擊按鈕，攔截下載請求
      console.log('[Gemini 分類助手] [下載按鈕] 🔄 嘗試通過虛擬點擊獲取下載 URL...');
      return await extractUrlByVirtualClick(downloadButton, imgElement, currentMessageId);
      
    } catch (error) {
      console.error('[Gemini 分類助手] [下載按鈕] 提取 URL 時發生錯誤:', error);
      return null;
    }
  }
  
  // 通過虛擬點擊按鈕來獲取真實的下載 URL
  async function extractUrlByVirtualClick(button, imgElement, currentMessageId) {
    return new Promise((resolve) => {
      let resolved = false;
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          console.log('[Gemini 分類助手] [下載按鈕] ⏰ 虛擬點擊超時，未獲取到 URL');
          resolve(null);
        }
      }, 5000); // 5 秒超時
      
      // 設置網絡請求攔截器（臨時）
      const originalFetch = window.fetch;
      const originalXHROpen = XMLHttpRequest.prototype.open;
      let interceptedUrl = null;
      
      const fetchWrapper = function(...args) {
        const url = args[0];
        if (typeof url === 'string' && url.includes('googleusercontent.com') && 
            (url.includes('gg-dl') || url.includes('rd-gg-dl') || url.includes('image_generation'))) {
          interceptedUrl = url;
          console.log('[Gemini 分類助手] [下載按鈕] ✓ 攔截到 fetch 請求:', url.substring(0, 100));
          if (!resolved) {
            resolved = true;
            clearTimeout(timeout);
            window.fetch = originalFetch;
            XMLHttpRequest.prototype.open = originalXHROpen;
            sendImageToSidePanel(url, currentMessageId, imgElement);
            resolve(url);
          }
        }
        return originalFetch.apply(this, args);
      };
      
      const xhrWrapper = function(method, url, ...rest) {
        if (typeof url === 'string' && url.includes('googleusercontent.com') && 
            (url.includes('gg-dl') || url.includes('rd-gg-dl') || url.includes('image_generation'))) {
          interceptedUrl = url;
          console.log('[Gemini 分類助手] [下載按鈕] ✓ 攔截到 XHR 請求:', url.substring(0, 100));
          if (!resolved) {
            resolved = true;
            clearTimeout(timeout);
            window.fetch = originalFetch;
            XMLHttpRequest.prototype.open = originalXHROpen;
            sendImageToSidePanel(url, currentMessageId, imgElement);
            resolve(url);
          }
        }
        return originalXHROpen.apply(this, [method, url, ...rest]);
      };
      
      // 臨時替換 fetch 和 XHR
      window.fetch = fetchWrapper;
      XMLHttpRequest.prototype.open = xhrWrapper;
      
      // 監聽下載菜單的出現（如果點擊後會顯示菜單）
      const menuObserver = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
          mutation.addedNodes.forEach((node) => {
            if (node.nodeType === 1) {
              // 查找菜單中的下載連結
              const downloadLinks = node.querySelectorAll ? node.querySelectorAll('a[href*="googleusercontent.com"], a[href*="download"]') : [];
              downloadLinks.forEach(link => {
                const href = link.getAttribute('href') || link.href;
                if (href && href.includes('googleusercontent.com') && 
                    (href.includes('gg-dl') || href.includes('rd-gg-dl') || href.includes('image_generation'))) {
                  if (!resolved) {
                    resolved = true;
                    clearTimeout(timeout);
                    menuObserver.disconnect();
                    window.fetch = originalFetch;
                    XMLHttpRequest.prototype.open = originalXHROpen;
                    console.log('[Gemini 分類助手] [下載按鈕] ✓ 從菜單中提取到 URL:', href.substring(0, 100));
                    sendImageToSidePanel(href, currentMessageId, imgElement);
                    resolve(href);
                  }
                }
              });
            }
          });
        });
      });
      
      menuObserver.observe(document.body, { childList: true, subtree: true });
      
      // 執行虛擬點擊
      try {
        // 觸發完整的事件序列
        button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, buttons: 1 }));
        button.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
        button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        button.click();
        
        console.log('[Gemini 分類助手] [下載按鈕] ✓ 已執行虛擬點擊，等待攔截下載請求...');
      } catch (error) {
        console.error('[Gemini 分類助手] [下載按鈕] ❌ 虛擬點擊失敗:', error);
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          menuObserver.disconnect();
          window.fetch = originalFetch;
          XMLHttpRequest.prototype.open = originalXHROpen;
          resolve(null);
        }
      }
    });
  }

  // 自動下載圖片（在 content script 中觸發下載）
  function downloadImageLocally(imageData) {
    try {
      if (!imageData.url && !imageData.base64) {
        console.error('[Gemini 分類助手] [自動下載] 沒有可下載的圖片 URL 或 Base64');
        return;
      }

      // 如果使用 Base64，需要先轉換為 Blob
      if (imageData.base64) {
        try {
          // 移除 data URL 前綴（如果有的話）
          const base64Data = imageData.base64.includes(',') 
            ? imageData.base64.split(',')[1] 
            : imageData.base64;
          
          // 轉換 Base64 字符串為二進制數據
          const byteCharacters = atob(base64Data);
          const byteNumbers = new Array(byteCharacters.length);
          for (let i = 0; i < byteCharacters.length; i++) {
            byteNumbers[i] = byteCharacters.charCodeAt(i);
          }
          const byteArray = new Uint8Array(byteNumbers);
          
          // 創建 Blob
          const blob = new Blob([byteArray], { type: 'image/png' });
          const url = URL.createObjectURL(blob);
          
          // 創建下載鏈接
          const a = document.createElement('a');
          a.href = url;
          const filename = `gemini-image-${imageData.id || Date.now()}-${Date.now()}.png`;
          a.download = filename;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          
          // 清理 URL
          setTimeout(() => URL.revokeObjectURL(url), 100);
          
          console.log('[Gemini 分類助手] [自動下載] ✓ Base64 圖片已下載:', filename);
        } catch (error) {
          console.error('[Gemini 分類助手] [自動下載] Base64 轉換失敗:', error);
          // 如果 Base64 轉換失敗，嘗試使用 URL
          if (imageData.url) {
            const a = document.createElement('a');
            a.href = imageData.url;
            a.download = `gemini-image-${imageData.id || Date.now()}-${Date.now()}.png`;
            a.target = '_blank';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
          }
        }
      } else if (imageData.url) {
        // 使用 URL 下載（通過新標籤頁打開或使用 fetch）
        const a = document.createElement('a');
        a.href = imageData.url;
        a.download = `gemini-image-${imageData.id || Date.now()}-${Date.now()}.png`;
        a.target = '_blank';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        
        console.log('[Gemini 分類助手] [自動下載] ✓ 圖片 URL 已觸發下載:', imageData.url.substring(0, 100));
      }
    } catch (error) {
      console.error('[Gemini 分類助手] [自動下載] 下載過程發生錯誤:', error);
    }
  }

  // 記錄圖片路徑（保存到 chrome.storage）
  async function recordImagePath(imageData) {
    try {
      if (!isRuntimeValid()) {
        // 靜默處理，不輸出錯誤（避免重複日誌）
        return;
      }

      const userProfile = imageData.userProfile || currentUserProfile || 'default';
      const chatId = imageData.chatId || currentChatId;
      
      if (!chatId) {
        console.error('[Gemini 分類助手] [圖片記錄] 缺少 chatId，無法保存');
        return;
      }

      // 【修正通訊崩潰】所有 sendMessage 前必須加上檢查，防止 context invalidated 錯誤
      if (!chrome.runtime?.id) {
        // 靜默處理，不輸出警告（避免重複日誌）
        return;
      }
      
      // 【資源清理】禁止存儲 Base64：嚴禁將圖片轉為 Base64 存入 chrome.storage，這會導致 QuotaExceededError 配額溢出
      // 發送消息到 background.js 保存圖片記錄
      chrome.runtime.sendMessage({
        action: 'RECORD_IMAGE',
        data: {
          id: imageData.id,
          requestId: imageData.requestId,
          url: imageData.url,
          base64: null, // 禁止 Base64 存儲
          alt: imageData.alt || '生成的圖片',
          timestamp: imageData.timestamp || Date.now(),
          timestampDisplay: imageData.timestampDisplay || new Date().toLocaleTimeString('zh-TW', {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
          }),
          chatId: chatId,
          userProfile: userProfile,
          metadata: imageData.metadata || imageData.bardVeMetadataKey || null,
          width: imageData.width || null,
          height: imageData.height || null,
          downloaded: false // 標記是否已下載
        }
      }, (response) => {
        if (chrome.runtime.lastError) {
          console.error('[Gemini 分類助手] [圖片記錄] 保存失敗:', chrome.runtime.lastError.message);
          return;
        }
        if (response && response.status === 'ok') {
          console.log('[Gemini 分類助手] [圖片記錄] ✓ 圖片路徑已記錄到數據庫');
        }
      });
    } catch (error) {
      console.error('[Gemini 分類助手] [圖片記錄] 記錄過程發生錯誤:', error);
    }
  }

  // 發送圖片到 Side Panel（整合 currentMessageId）
  function sendImageToSidePanel(imageUrl, currentMessageId, imgElement) {
    // 靜默處理，不輸出錯誤（避免重複日誌）
    if (!isRuntimeValid()) {
      return;
    }
    
    // 【過濾無效 URL】跳過 blob:null/ 開頭的無效 URL
    if (imageUrl && typeof imageUrl === 'string' && imageUrl.startsWith('blob:null/')) {
      // console.log('[Gemini 分類助手] [圖片過濾] ⏭️ 跳過無效的 blob:null URL:', imageUrl.substring(0, 50)); // 已禁用，避免大量日誌
      return;
    }
    
    try {
      // 不要再跑 convertImageToBase64 了，這是導致崩潰的主因
      const imageData = {
        id: currentMessageId || Date.now().toString(),
        requestId: currentMessageId,
        url: imageUrl, 
        base64: null, // 設為 null，節省 99% 的空間
        alt: imgElement ? (imgElement.alt || '生成的圖片') : '生成的圖片',
        timestamp: Date.now(),
        timestampDisplay: new Date().toLocaleTimeString('zh-TW', {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit'
        }),
        chatId: currentChatId,
        userProfile: currentUserProfile || 'default',
        width: imgElement ? (imgElement.naturalWidth || imgElement.width || null) : null,
        height: imgElement ? (imgElement.naturalHeight || imgElement.height || null) : null
      };
      
      console.log('[Gemini 分類助手] [圖片發送] ✓ 發送圖片到 Side Panel:', {
        id: imageData.id.substring(0, 30),
        requestId: currentMessageId ? currentMessageId.substring(0, 30) : '無',
        url: imageUrl.substring(0, 80)
      });
      
      // 1. 記錄圖片路徑到數據庫
      recordImagePath(imageData).then(() => {
        console.log('[Gemini 分類助手] [圖片記錄] ✓ 圖片已記錄');
      }).catch(err => {
        console.error('[Gemini 分類助手] [圖片記錄] 記錄失敗:', err);
      });
      
      // 2. 檢查圖片大小並下載（只有大於100KB的才下載）
      try {
        checkImageSizeAndDownload(imageData);
      } catch (error) {
        console.error('[Gemini 分類助手] [自動下載] 下載失敗:', error);
      }
      
      // 【修正通訊崩潰】所有 sendMessage 前必須加上檢查，防止 context invalidated 錯誤
      if (!chrome.runtime?.id) {
        // 靜默處理，不輸出警告（避免重複日誌）
        return;
      }
      
      // 3. 發送到 Side Panel
      chrome.runtime.sendMessage({
        action: 'IMAGES_DETECTED',
        data: [imageData]
      }, (response) => {
        if (chrome.runtime.lastError) {
          console.error('[Gemini 分類助手] [圖片發送] 發送失敗:', chrome.runtime.lastError.message);
          return;
        }
        if (response && response.status === 'ok') {
          console.log('[Gemini 分類助手] [圖片發送] ✓ 圖片已成功傳送到 Side Panel');
        }
      });
    } catch (error) {
      console.error('[Gemini 分類助手] [圖片發送] 發送過程發生錯誤:', error);
    }
  }

  // 獲取真實圖片路徑（從 message-content 和 image-button 中提取）
  // 【暴力修正版】getRealImagePath：無視 ID 限制，只要發現 lh3.googleusercontent.com 或 blob: 就視為生成圖
  function getRealImagePath(container, isManualClick = false) {
    try {
      console.log('[Gemini 分類助手] [圖片追蹤] 🔥 暴力模式：開始鎖定真實路徑...');
      
      // 1. 暴力搜索：查找所有可能的圖片元素（不限制類名）
      const img = container.querySelector('button.image-button img') || 
                  container.querySelector('img.image') ||
                  container.querySelector('img');

      if (!img) {
        console.log('[Gemini 分類助手] [圖片追蹤] ⚠️ 未找到圖片元素');
        return null;
      }

      const currentSrc = img.src || img.getAttribute('src') || '';

      // 2. 【嚴格過濾】只抓真正的長路徑大圖：
      // - 如果 src 字串長度小於 200，絕對不要抓取（真正的原圖路徑很長）
      // - 如果包含 /profile/picture/，絕對不要抓取
      if (currentSrc.length < 200) {
        console.log('[Gemini 分類助手] [圖片追蹤] ⚠️ 跳過：src 長度 < 200（長度：' + currentSrc.length + '），可能不是真正的原圖');
        return null;
      }
      
      if (currentSrc.includes('/profile/picture/') || currentSrc.includes('profile/picture') || currentSrc.includes('/picture/')) {
        console.log('[Gemini 分類助手] [圖片追蹤] ⚠️ 跳過：偵測到 /profile/picture/ 佔位符');
        return null;
      }

      // 3. 【過濾 "gemini-image-r_" 類型的圖片】檢查 URL 中是否包含特定模式（佔位符或縮略圖）
      // 這些 URL 通常包含 "r_" 後跟短 ID，我們要過濾掉這些
      if (currentSrc.includes('/r_') || currentSrc.match(/\/r_[a-f0-9]{8,16}[^\/]*$/)) {
        // 檢查是否是真正的圖片 URL（長度足夠）還是佔位符
        // 如果 URL 中包含 "/r_" 且沒有包含 "gg-dl" 或 "rd-gg-dl"，很可能是佔位符
        if (!currentSrc.includes('gg-dl') && !currentSrc.includes('rd-gg-dl') && !currentSrc.includes('image_generation')) {
          console.log('[Gemini 分類助手] [圖片追蹤] ⚠️ 跳過：偵測到 "r_" 佔位符 URL（gemini-image-r_ 類型）');
          return null;
        }
      }
      
      // 4. 【無視 ID 限制】只要發現 lh3.googleusercontent.com 或包含 googleusercontent.com 且長度足夠，就視為生成圖
      // 優先選擇包含特定關鍵詞的 URL（這些是真正的高質量原圖）
      const isGeneratedImage = (currentSrc.includes('lh3.googleusercontent.com') || 
                                currentSrc.includes('googleusercontent.com')) &&
                                (currentSrc.includes('gg-dl') || 
                                 currentSrc.includes('rd-gg-dl') || 
                                 currentSrc.includes('image_generation') ||
                                 currentSrc.includes('/rd-gg-dl/'));

      if (!isGeneratedImage) {
        console.log('[Gemini 分類助手] [圖片追蹤] ⚠️ 跳過：不符合生成圖條件（缺少關鍵詞：gg-dl, rd-gg-dl, image_generation）');
        return null;
      }
      
      // 4. 【統一去重】使用 urlKey 而不是完整的 currentSrc，與 triggerAutoDownload 保持一致
      const urlKey = getUrlKey(currentSrc, 200);
      if (!isManualClick && processedImageUrls.has(urlKey)) {
        console.log('[Gemini 分類助手] [圖片追蹤] ⏭️  跳過：URL 已處理過（去重）');
        return null;
      }
      
      // 5. 標記為已處理（去重）- 使用 urlKey
      processedImageUrls.add(urlKey);
      
      // 7. 嘗試從下載按鈕獲取更高質量的圖片 URL（如果有的話）
      let finalSrc = currentSrc;
      try {
        const downloadButton = container.querySelector('download-generated-image-button, [class*="download-generated-image-button"], button[aria-label*="下載"], button[aria-label*="download"]');
        if (downloadButton) {
          const jslog = downloadButton.getAttribute('jslog') || '';
          const urlMatches = jslog.match(/https?:\/\/[^\s"']+/g);
          if (urlMatches && urlMatches.length > 0) {
            // 優先選擇最長的 URL（通常是最高質量的原圖）
            const sortedUrls = urlMatches
              .filter(url => url.includes('googleusercontent.com') && url.length > currentSrc.length)
              .sort((a, b) => b.length - a.length);
            
            if (sortedUrls.length > 0) {
              finalSrc = sortedUrls[0];
              console.log('[Gemini 分類助手] [圖片追蹤] 🎯 從下載按鈕獲取到更高質量的 URL（長度：' + finalSrc.length + '）');
            }
          }
        }
      } catch (e) {
        // 如果提取失敗，使用原始 URL
      }
      
      // 8. 生成 ID（不等待 BardVeMetadataKey，直接使用時間戳）
      const requestId = 'img_' + Date.now();

      console.log('[Gemini 分類助手] [圖片追蹤] ✅ 成功鎖定真實路徑！');
      console.log('[Gemini 分類助手] [圖片追蹤]   src 長度:', finalSrc.length);
      console.log('[Gemini 分類助手] [圖片追蹤]   src 預覽:', finalSrc.substring(0, 200));
      console.log('[Gemini 分類助手] [圖片追蹤]   requestId:', requestId);

      return {
        id: requestId,
        fullPath: finalSrc,
        metadata: '',
        imgElement: img
      };
    } catch (error) {
      console.error('[Gemini 分類助手] [圖片追蹤] ❌ 提取路徑時發生錯誤:', error);
      return null;
    }
  }

  // 【暴力修正版】extractGeneratedImages：無視 ID 限制，暴力搜索所有符合條件的圖片
  async function extractGeneratedImages() {
    try {
      if (!currentChatId) {
        console.log('[Gemini 分類助手] [圖片追蹤] ⚠️ 跳過提取，因為沒有當前對話 ID');
        return;
      }
      
      console.log('[Gemini 分類助手] [圖片追蹤] 🔥 ========== 暴力模式：開始追蹤和提取圖片 ==========');
      console.log('[Gemini 分類助手] [圖片追蹤]   當前 URL:', window.location.href);
      console.log('[Gemini 分類助手] [圖片追蹤]   當前 ChatId:', currentChatId);
      
      let totalImagesFound = 0;
      let imagesProcessed = 0;
      
      // 【暴力策略】直接搜索所有 button.image-button 和符合條件的 img
      console.log('[Gemini 分類助手] [圖片追蹤] 🔥 暴力策略：搜索所有 button.image-button');
      const imageButtons = document.querySelectorAll('button.image-button');
      console.log('[Gemini 分類助手] [圖片追蹤]   找到', imageButtons.length, '個 button.image-button');
      
      imageButtons.forEach((button, index) => {
        try {
          const img = button.querySelector('img');
          if (!img) return;
          
          const imgSrc = img.src || '';
          const className = img.className || '';
          
          console.log('[Gemini 分類助手] [圖片追蹤]   檢查 button #' + (index + 1), {
            srcLength: imgSrc.length,
            hasLoaded: className.includes('loaded'),
            srcPreview: imgSrc.substring(0, 100)
          });
          
          // 【跳過佔位符】寫死規則
          if (imgSrc.length < 100 || imgSrc.includes('/profile/picture/') || imgSrc.includes('profile/picture')) {
            console.log('[Gemini 分類助手] [圖片追蹤]     跳過：佔位符');
            // 設置監控，等待圖片載入
            setupImageObserver(button.parentElement || button);
            return;
          }
          
          // 【過濾無效 URL】跳過 blob:null/ 開頭的無效 URL
          if (imgSrc && imgSrc.startsWith('blob:null/')) {
            // console.log('[Gemini 分類助手] [圖片追蹤]     ⏭️ 跳過：無效的 blob:null URL'); // 已禁用，避免大量日誌
            return;
          }
          
          // 【無視 ID 限制】只要發現 lh3.googleusercontent.com 或 blob: 開頭，就視為生成圖
          const isGeneratedImage = imgSrc.includes('lh3.googleusercontent.com') || 
                                    imgSrc.includes('googleusercontent.com') ||
                                    (imgSrc.startsWith('blob:') && !imgSrc.startsWith('blob:null/'));
          
          if (isGeneratedImage) {
            // 【自動模式降溫】若 URL 不含 gg-dl 或 image_generation 關鍵字（代表只是 200K 的預覽圖），則不執行 triggerAutoDownload
            const isHighQualityImage = imgSrc.includes('gg-dl') || imgSrc.includes('rd-gg-dl') || imgSrc.includes('image_generation');
            if (!isHighQualityImage) {
              console.log('[Gemini 分類助手] [圖片追蹤]     ⏭️ 跳過：URL 不含 gg-dl 或 image_generation（可能是預覽圖）');
              // 設置監控，等待高質量圖片載入
              setupImageObserver(button.parentElement || button);
              return;
            }
            
            // 【統一去重】檢查是否已處理過（使用 urlKey）
            const urlKey = getUrlKey(imgSrc, 200);
            if (processedImageUrls.has(urlKey)) {
              console.log('[Gemini 分類助手] [圖片追蹤]     ⏭️ 跳過：已處理過');
              return;
            }
            
            const requestId = 'img_' + Date.now() + '_' + index;
            console.log('[Gemini 分類助手] [圖片追蹤]     ✅ 找到生成圖！立即提取');
            console.log('[Gemini 分類助手] [圖片追蹤]       URL:', imgSrc.substring(0, 150));
            
            // 【即時回傳】立即執行 sendImageToSidePanel
            sendImageToSidePanel(imgSrc, requestId, img);
            // 先從內存緩存中移除，讓 triggerAutoDownload 自己處理去重（包括持久化資料庫檢查）
            processedImageUrls.delete(urlKey);
            triggerAutoDownload(imgSrc, requestId, null, 'highres', 'extractGeneratedImages');
            
            imagesProcessed++;
            totalImagesFound++;
            } else {
              // 如果類名包含 loaded，強行提取
              if (className.includes('loaded')) {
                // 【自動模式降溫】即使是 loaded，也要檢查是否為高質量圖片
                const isHighQualityImage = imgSrc.includes('gg-dl') || imgSrc.includes('rd-gg-dl') || imgSrc.includes('image_generation');
                if (!isHighQualityImage) {
                  console.log('[Gemini 分類助手] [圖片追蹤]     ⏭️ 跳過：loaded 但 URL 不含 gg-dl 或 image_generation（可能是預覽圖）');
                  return;
                }
                
                // 【統一去重】檢查是否已處理過（使用 urlKey）
                const urlKey = getUrlKey(imgSrc, 200);
                if (processedImageUrls.has(urlKey)) {
                  console.log('[Gemini 分類助手] [圖片追蹤]     ⏭️ 跳過：已處理過');
                  return;
                }
                
                console.log('[Gemini 分類助手] [圖片追蹤]     🔥 類名包含 loaded，強行提取');
                const requestId = 'img_' + Date.now() + '_' + index;
                sendImageToSidePanel(imgSrc, requestId, img);
                // 先從內存緩存中移除，讓 triggerAutoDownload 自己處理去重（包括持久化資料庫檢查）
                processedImageUrls.delete(urlKey);
                triggerAutoDownload(imgSrc, requestId, null, 'highres', 'extractGeneratedImages_loaded');
                imagesProcessed++;
                totalImagesFound++;
              } else {
                // 設置監控
                setupImageObserver(button.parentElement || button);
              }
            }
        } catch (e) {
          console.error('[Gemini 分類助手] [圖片追蹤]   處理 button 時發生錯誤:', e);
        }
      });
      
      // 【暴力策略】直接搜索所有包含 googleusercontent.com 或 blob: 的 img
      console.log('[Gemini 分類助手] [圖片追蹤] 🔥 暴力策略：搜索所有符合條件的 img');
      const allImages = document.querySelectorAll('img');
      let directImageCount = 0;
      
      allImages.forEach((img, index) => {
        try {
          const imgSrc = img.src || '';
          
          // 【跳過佔位符】寫死規則
          if (imgSrc.length < 100 || imgSrc.includes('/profile/picture/') || imgSrc.includes('profile/picture')) {
            return;
          }
          
          // 【無視 ID 限制】只要發現 lh3.googleusercontent.com 或 blob: 開頭，就視為生成圖
          const isGeneratedImage = imgSrc.includes('lh3.googleusercontent.com') || 
                                    imgSrc.includes('googleusercontent.com') ||
                                    (imgSrc.startsWith('blob:') && !imgSrc.startsWith('blob:null/'));
          
          if (isGeneratedImage) {
            // 檢查是否已經在 button.image-button 中處理過
            const isInButton = img.closest('button.image-button');
            if (isInButton) {
              return; // 已經處理過
            }
            
            // 【自動模式降溫】若 URL 不含 gg-dl 或 image_generation 關鍵字（代表只是 200K 的預覽圖），則不執行 triggerAutoDownload
            const isHighQualityImage = imgSrc.includes('gg-dl') || imgSrc.includes('rd-gg-dl') || imgSrc.includes('image_generation');
            if (!isHighQualityImage) {
              return; // 跳過預覽圖
            }
            
            const requestId = 'img_direct_' + Date.now() + '_' + index;
            console.log('[Gemini 分類助手] [圖片追蹤]     ✅ 直接找到生成圖！立即提取');
            console.log('[Gemini 分類助手] [圖片追蹤]       URL:', imgSrc.substring(0, 150));
            
            // 【即時回傳】立即執行 sendImageToSidePanel
            sendImageToSidePanel(imgSrc, requestId, img);
            triggerAutoDownload(imgSrc, requestId);
            
            directImageCount++;
            imagesProcessed++;
            totalImagesFound++;
          }
        } catch (e) {
          console.error('[Gemini 分類助手] [圖片追蹤]   處理 img 時發生錯誤:', e);
        }
      });
      
      console.log('[Gemini 分類助手] [圖片追蹤] 📊 統計:');
      console.log('[Gemini 分類助手] [圖片追蹤]   從 button.image-button 找到:', imagesProcessed - directImageCount);
      console.log('[Gemini 分類助手] [圖片追蹤]   直接找到的圖片:', directImageCount);
      console.log('[Gemini 分類助手] [圖片追蹤]   總計:', totalImagesFound);
      console.log('[Gemini 分類助手] [圖片追蹤] ========================================');
      
      // 備用邏輯：如果暴力搜索沒找到，使用 getRealImagePath 嘗試提取
      if (totalImagesFound === 0) {
        console.log('[Gemini 分類助手] [圖片追蹤] 🔥 暴力搜索未找到圖片，嘗試備用策略...');
        
        // 搜索所有 button.image-button 並設置監控
        const allImageButtons = document.querySelectorAll('button.image-button');
        allImageButtons.forEach((button) => {
          setupImageObserver(button.parentElement || button);
        });
      }
      
    } catch (error) {
      console.error('[Gemini 分類助手] [圖片追蹤] ❌ 提取生成圖片時發生錯誤:', error);
      console.error('[Gemini 分類助手] [圖片追蹤] 錯誤堆疊:', error.stack);
    }
  }

  // 分析頁面結構（用於調試）
  function analyzePageStructure() {
    console.log('[Gemini 分類助手] [頁面分析] ========== 開始分析頁面結構 ==========');
    
    // 分析所有可能的輸入元素
    const allInputs = document.querySelectorAll('textarea, div[contenteditable="true"], input[type="text"]');
    console.log('[Gemini 分類助手] [頁面分析] 找到', allInputs.length, '個可能的輸入元素');
    
    // 分析所有圖片元素
    console.log('[Gemini 分類助手] [頁面分析] ========== 分析圖片元素 ==========');
    const allImages = document.querySelectorAll('img, [role="img"], canvas, svg, [class*="image"], [class*="Image"], [class*="generated"], [class*="result"]');
    console.log('[Gemini 分類助手] [頁面分析] 找到', allImages.length, '個可能的圖片元素');
    
    allImages.forEach((img, index) => {
      if (index < 10) { // 只顯示前 10 個
        console.log(`[Gemini 分類助手] [頁面分析] 圖片 #${index + 1}:`, {
          tagName: img.tagName,
          className: img.className?.substring(0, 100),
          src: img.getAttribute('src')?.substring(0, 100) || '(無 src)',
          dataSrc: img.getAttribute('data-src')?.substring(0, 100) || '(無 data-src)',
          dataOriginal: img.getAttribute('data-original')?.substring(0, 100) || '(無 data-original)',
          role: img.getAttribute('role'),
          'aria-label': img.getAttribute('aria-label'),
          'data-type': img.getAttribute('data-type'),
          parentClass: img.parentElement?.className?.substring(0, 100) || '(無父元素)',
          hasDownloadButton: !!img.closest('[class*="download"], button[aria-label*="下載"], button[aria-label*="download"]')
        });
      }
    });
    
    // 分析圖片容器
    console.log('[Gemini 分類助手] [頁面分析] ========== 分析圖片容器 ==========');
    const imageContainers = document.querySelectorAll('[class*="image"], [class*="generated"], [class*="result"], [data-type="image"]');
    console.log('[Gemini 分類助手] [頁面分析] 找到', imageContainers.length, '個可能的圖片容器');
    
    imageContainers.forEach((container, index) => {
      if (index < 10) { // 只顯示前 10 個
        const imgs = container.querySelectorAll('img');
        const downloadBtns = container.querySelectorAll('button[aria-label*="下載"], button[aria-label*="download"], [class*="download"]');
        console.log(`[Gemini 分類助手] [頁面分析] 容器 #${index + 1}:`, {
          className: container.className?.substring(0, 100),
          tagName: container.tagName,
          imageCount: imgs.length,
          downloadButtonCount: downloadBtns.length,
          firstImageSrc: imgs[0]?.getAttribute('src')?.substring(0, 100) || '(無圖片)',
          downloadUrl: downloadBtns[0]?.getAttribute('href')?.substring(0, 100) || downloadBtns[0]?.getAttribute('data-url')?.substring(0, 100) || '(無下載 URL)'
        });
      }
    });
    
    allInputs.forEach((el, idx) => {
      const rect = el.getBoundingClientRect();
      const tagName = el.tagName;
      const isContentEditable = el.isContentEditable;
      const placeholder = el.getAttribute('placeholder') || el.getAttribute('aria-label') || '';
      const className = el.className || '';
      const id = el.id || '';
      const role = el.getAttribute('role') || '';
      
      if (rect.width > 0 && rect.height > 0) {
        console.log(`[Gemini 分類助手] [頁面分析] 輸入元素 ${idx + 1}:`, {
          tagName,
          isContentEditable,
          placeholder: placeholder.substring(0, 50),
          className: className.substring(0, 100),
          id,
          role,
          visible: rect.width > 0 && rect.height > 0,
          position: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
        });
      }
    });
    
    // 分析所有可能的發送按鈕
    const allButtons = document.querySelectorAll('button, div[role="button"]');
    console.log('[Gemini 分類助手] [頁面分析] 找到', allButtons.length, '個可能的按鈕元素');
    
    const sendButtons = [];
    allButtons.forEach((btn, idx) => {
      const rect = btn.getBoundingClientRect();
      const ariaLabel = btn.getAttribute('aria-label') || '';
      const className = btn.className || '';
      const id = btn.id || '';
      const innerHTML = btn.innerHTML.substring(0, 100);
      
      // 檢查是否可能是發送按鈕
      const isLikelySendButton = 
        ariaLabel.toLowerCase().includes('send') ||
        ariaLabel.toLowerCase().includes('發送') ||
        ariaLabel.toLowerCase().includes('submit') ||
        className.toLowerCase().includes('send') ||
        innerHTML.includes('send') ||
        innerHTML.includes('發送') ||
        btn.querySelector('svg[class*="send"]') !== null ||
        btn.querySelector('svg path[d*="M"]') !== null; // SVG 圖標
      
      if (rect.width > 0 && rect.height > 0 && isLikelySendButton) {
        sendButtons.push(btn);
        console.log(`[Gemini 分類助手] [頁面分析] 可能的發送按鈕 ${idx + 1}:`, {
          ariaLabel,
          className: className.substring(0, 100),
          id,
          innerHTML: innerHTML.substring(0, 50),
          position: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
        });
      }
    });
    
    return { inputs: Array.from(allInputs), sendButtons };
  }

  // 查找 Gemini 輸入框（帶重試機制）
  async function findInputElement(maxRetries = 3, retryDelay = 500) {
    console.log('[Gemini 分類助手] [發送消息] 開始查找輸入框 (最大重試次數:', maxRetries, ')');
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      console.log(`[Gemini 分類助手] [發送消息] 嘗試 ${attempt}/${maxRetries}...`);
      
      // 優先選擇器：contentEditable 元素（Gemini 主要使用這個）
      const inputSelectors = [
        // 精確匹配（優先）
        'div[contenteditable="true"][role="textbox"]',
        '[contenteditable="true"][role="textbox"]',
        'div[contenteditable="true"]',
        // 包含 rich-textarea 相關的元素
        '[class*="rich-textarea"]',
        '[class*="richTextarea"]',
        '[class*="RichTextarea"]',
        // textarea 備選
        'textarea[placeholder*="Message"]',
        'textarea[placeholder*="輸入"]',
        'textarea[placeholder*="message"]',
        'textarea[aria-label*="Message"]',
        'textarea[aria-label*="輸入"]',
        // 通用選擇器（最後備選）
        'textarea'
      ];

      for (const selector of inputSelectors) {
        try {
          const elements = document.querySelectorAll(selector);
          
          for (const el of elements) {
            const rect = el.getBoundingClientRect();
            const isVisible = rect.width > 0 && rect.height > 0;
            
            if (!isVisible) continue;
            
            // 檢查是否在對話輸入區域（通常在頁面底部）
            const isNearBottom = rect.y > window.innerHeight * 0.5;
            const isInMain = el.closest('[role="main"], main') !== null;
            const isInInputContainer = el.closest('[class*="input"], [class*="composer"], [class*="textarea"], [class*="message-input"], [class*="chat-input"], form') !== null;
            
            if (isNearBottom || isInMain || isInInputContainer || elements.length === 1) {
              console.log(`[Gemini 分類助手] [發送消息] ✓ 找到輸入框 (選擇器: ${selector}):`, {
                tagName: el.tagName,
                isContentEditable: el.isContentEditable,
                role: el.getAttribute('role') || '',
                placeholder: el.getAttribute('placeholder') || el.getAttribute('aria-label') || '',
                className: (el.className || '').substring(0, 100),
                position: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }
              });
              return el;
            }
          }
        } catch (e) {
          console.warn(`[Gemini 分類助手] [發送消息] 選擇器 "${selector}" 查詢出錯:`, e.message);
          continue;
        }
      }
      
      // 如果這不是最後一次嘗試，等待後重試
      if (attempt < maxRetries) {
        console.log(`[Gemini 分類助手] [發送消息] 未找到輸入框，等待 ${retryDelay}ms 後重試...`);
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      }
    }
    
    console.error('[Gemini 分類助手] [發送消息] ❌ 經過', maxRetries, '次嘗試後仍找不到輸入框');
    return null;
  }

  // 查找發送按鈕
  function findSendButton(inputElement) {
    console.log('[Gemini 分類助手] [發送消息] 開始查找發送按鈕...');
    
    // 優先選擇器（支持中英文）
    const sendButtonSelectors = [
      // 精確匹配 aria-label（中英文）
      'button[aria-label*="Send message"]',
      'button[aria-label*="傳送訊息"]',
      'button[aria-label*="Send"]',
      'button[aria-label*="發送"]',
      'button[aria-label*="傳送"]',
      // 通用匹配
      'button[aria-label*="send"]',
      'button[aria-label*="Send"]',
      // 類型匹配
      'button[type="submit"]',
      // div 作為按鈕
      'div[role="button"][aria-label*="Send"]',
      'div[role="button"][aria-label*="傳送"]',
      'div[role="button"][aria-label*="發送"]'
    ];

    // 首先在輸入框附近查找
    if (inputElement) {
      const inputParent = inputElement.closest('form, div[class*="input"], div[class*="composer"], div[class*="container"], div[class*="chat"]');
      if (inputParent) {
        for (const selector of sendButtonSelectors) {
          try {
            const buttons = inputParent.querySelectorAll(selector);
            for (const btn of buttons) {
              const rect = btn.getBoundingClientRect();
              if (rect.width > 0 && rect.height > 0 && !btn.disabled) {
                console.log(`[Gemini 分類助手] [發送消息] ✓ 在輸入框附近找到發送按鈕 (選擇器: ${selector}):`, {
                  tagName: btn.tagName,
                  ariaLabel: btn.getAttribute('aria-label') || '',
                  disabled: btn.disabled,
                  position: { x: Math.round(rect.x), y: Math.round(rect.y) }
                });
                return btn;
              }
            }
          } catch (e) {
            continue;
          }
        }
      }
    }
    
    // 如果在輸入框附近沒找到，在整個文檔中查找（但在頁面底部）
    for (const selector of sendButtonSelectors) {
      try {
        const buttons = document.querySelectorAll(selector);
        for (const btn of buttons) {
          const rect = btn.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0 && rect.y > window.innerHeight * 0.6 && !btn.disabled) {
            console.log(`[Gemini 分類助手] [發送消息] ✓ 在頁面底部找到發送按鈕 (選擇器: ${selector}):`, {
              tagName: btn.tagName,
              ariaLabel: btn.getAttribute('aria-label') || '',
              disabled: btn.disabled,
              position: { x: Math.round(rect.x), y: Math.round(rect.y) }
            });
            return btn;
          }
        }
      } catch (e) {
        continue;
      }
    }
    
    console.warn('[Gemini 分類助手] [發送消息] ⚠️ 找不到發送按鈕');
    return null;
  }

  // 發送消息到 Gemini（從側邊欄調用）- 異步函數
  async function sendMessageToGemini(messageText) {
    if (!messageText || !messageText.trim()) {
      console.error('[Gemini 分類助手] [發送消息] ❌ 消息內容為空');
      return { success: false, error: '消息內容為空' };
    }

    try {
      console.log('[Gemini 分類助手] [發送消息] ========== 開始發送消息 ==========');
      console.log('[Gemini 分類助手] [發送消息] 消息內容:', messageText.substring(0, 100) + (messageText.length > 100 ? '...' : ''));
      console.log('[Gemini 分類助手] [發送消息] 消息長度:', messageText.length, '字符');

      // 步驟 1: 查找輸入框（帶重試機制）
      const inputElement = await findInputElement(3, 500);
      
      if (!inputElement) {
        console.error('[Gemini 分類助手] [發送消息] ❌ 找不到輸入框');
        // 輸出頁面結構分析（用於調試）
        analyzePageStructure();
        return { success: false, error: '找不到輸入框（頁面可能還在加載中）' };
      }

      console.log('[Gemini 分類助手] [發送消息] ✓ 輸入框查找成功');

      // 步驟 2: 聚焦輸入框
      console.log('[Gemini 分類助手] [發送消息] 聚焦輸入框...');
      try {
        inputElement.focus();
        inputElement.click(); // 確保獲得焦點
        // 滾動到可見區域
        inputElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
        console.log('[Gemini 分類助手] [發送消息] ✓ 輸入框已聚焦');
      } catch (e) {
        console.warn('[Gemini 分類助手] [發送消息] 聚焦輸入框時發生錯誤:', e.message);
      }

      // 等待焦點穩定
      await new Promise(resolve => setTimeout(resolve, 200));

      // 步驟 3: 清空現有內容（如果有）
      console.log('[Gemini 分類助手] [發送消息] 清空現有內容...');
      try {
        if (inputElement.tagName === 'TEXTAREA') {
          inputElement.value = '';
        } else if (inputElement.isContentEditable) {
          inputElement.textContent = '';
          inputElement.innerText = '';
        }
      } catch (e) {
        console.warn('[Gemini 分類助手] [發送消息] 清空內容時發生錯誤:', e.message);
      }

      // 步驟 4: 使用 document.execCommand('insertText') 填入文字（最可靠的方法）
      console.log('[Gemini 分類助手] [發送消息] 使用 execCommand 填入文字...');
      try {
        // 確保輸入框有焦點
        inputElement.focus();
        
        // 使用 document.execCommand('insertText') 模擬真實鍵盤輸入
        // 這能最有效地觸發前端框架的狀態更新
        const success = document.execCommand('insertText', false, messageText);
        
        if (success) {
          console.log('[Gemini 分類助手] [發送消息] ✓ execCommand 成功填入文字');
        } else {
          console.warn('[Gemini 分類助手] [發送消息] ⚠️ execCommand 返回 false，嘗試備用方法');
          
          // 備用方法：如果 execCommand 失敗，使用直接設置（適用於 textarea）
          if (inputElement.tagName === 'TEXTAREA') {
            inputElement.value = messageText;
            // 觸發事件
            inputElement.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
            inputElement.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
            console.log('[Gemini 分類助手] [發送消息] ✓ 使用備用方法（textarea.value）填入文字');
          } else if (inputElement.isContentEditable) {
            // 對於 contentEditable，使用 InputEvent
            inputElement.textContent = messageText;
            const inputEvent = new InputEvent('input', {
              bubbles: true,
              cancelable: true,
              inputType: 'insertText',
              data: messageText
            });
            inputElement.dispatchEvent(inputEvent);
            console.log('[Gemini 分類助手] [發送消息] ✓ 使用備用方法（InputEvent）填入文字');
          }
        }
        
        // 驗證文字是否已填入
        const currentText = inputElement.tagName === 'TEXTAREA' 
          ? inputElement.value 
          : (inputElement.textContent || inputElement.innerText || '');
        
        if (currentText.trim() === messageText.trim()) {
          console.log('[Gemini 分類助手] [發送消息] ✓ 文字已成功填入（驗證通過）');
        } else {
          console.warn('[Gemini 分類助手] [發送消息] ⚠️ 文字填入驗證失敗（當前:', currentText.substring(0, 50), '，預期:', messageText.substring(0, 50), ')');
        }
      } catch (e) {
        console.error('[Gemini 分類助手] [發送消息] ❌ 填入文字時發生錯誤:', e);
        return { success: false, error: '填入文字失敗: ' + e.message };
      }

      // 等待一下確保前端框架已更新狀態（這很重要！）
      console.log('[Gemini 分類助手] [發送消息] 等待 500ms 讓前端框架更新狀態...');
      await new Promise(resolve => setTimeout(resolve, 500));

      // 步驟 5: 查找並點擊發送按鈕
      console.log('[Gemini 分類助手] [發送消息] 查找發送按鈕...');
      const sendButton = findSendButton(inputElement);
      
      if (sendButton) {
        console.log('[Gemini 分類助手] [發送消息] ✓ 找到發送按鈕，準備點擊');
        
        // 檢查按鈕是否啟用
        if (sendButton.disabled) {
          console.warn('[Gemini 分類助手] [發送消息] ⚠️ 發送按鈕被禁用，可能需要再等待一段時間...');
          // 再等待一下
          await new Promise(resolve => setTimeout(resolve, 300));
        }
        
        try {
          // 點擊發送按鈕
          sendButton.click();
          console.log('[Gemini 分類助手] [發送消息] ✓ 已點擊發送按鈕');
          console.log('[Gemini 分類助手] [發送消息] ========== 消息發送完成（方法：按鈕） ==========');
          return { success: true, method: 'button' };
        } catch (e) {
          console.error('[Gemini 分類助手] [發送消息] ❌ 點擊按鈕時發生錯誤:', e);
          // 繼續嘗試鍵盤方式
        }
      }

      // 步驟 6: 如果沒找到按鈕，嘗試按 Enter 鍵發送
      console.log('[Gemini 分類助手] [發送消息] ⚠️ 找不到發送按鈕或按鈕點擊失敗，嘗試按 Enter 鍵發送');
      
      // 確保輸入框有焦點
      inputElement.focus();
      
      // 模擬 Enter 鍵（不帶 Shift，確保發送而不是換行）
      const enterKeyDown = new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true
      });
      inputElement.dispatchEvent(enterKeyDown);
      
      await new Promise(resolve => setTimeout(resolve, 50));
      
      const enterKeyPress = new KeyboardEvent('keypress', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true
      });
      inputElement.dispatchEvent(enterKeyPress);
      
      await new Promise(resolve => setTimeout(resolve, 50));
      
      const enterKeyUp = new KeyboardEvent('keyup', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true
      });
      inputElement.dispatchEvent(enterKeyUp);
      
      console.log('[Gemini 分類助手] [發送消息] ✓ 已發送 Enter 鍵事件');
      console.log('[Gemini 分類助手] [發送消息] ========== 消息發送完成（方法：鍵盤） ==========');
      return { success: true, method: 'keyboard' };

    } catch (error) {
      console.error('[Gemini 分類助手] [發送消息] ❌ 發送消息時發生錯誤:', error);
      console.error('[Gemini 分類助手] [發送消息] 錯誤堆疊:', error.stack);
      return { success: false, error: error.message };
    }
  }
  
  // 修復：在異步函數中使用 await
  // 由於 sendMessageToGemini 需要調用異步操作，我們需要將其改為異步函數

  // ========== 新增功能：圖片攔截器 ==========
  
  // 【四選一策略】以「回應」為單位，每個回應只下載第一張圖片
  function setupDownloadButtonObserver() {
    if (!autoDownloadEnabled) return;
    // 立即掃描已存在的回應區塊
    const existingContainers = document.querySelectorAll('[class*="model-response"], [class*="modelResponse"], [class*="assistant-message"], [data-role="model"], [data-role="assistant"]');
    existingContainers.forEach(container => {
      handleNewResponse(container);
    });
    
    // 使用 MutationObserver 監控新的回應區塊
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (mutation.addedNodes) {
          mutation.addedNodes.forEach(node => {
            if (node.nodeType === 1) {
              // 檢查是否是回應區塊
              const isResponseContainer = node.matches && (
                node.matches('[class*="model-response"]') ||
                node.matches('[class*="modelResponse"]') ||
                node.matches('[class*="assistant-message"]') ||
                node.matches('[data-role="model"]') ||
                node.matches('[data-role="assistant"]')
              );
              
              if (isResponseContainer) {
                handleNewResponse(node);
              } else {
                // 檢查子元素中是否有回應區塊
                const containers = node.querySelectorAll ? node.querySelectorAll('[class*="model-response"], [class*="modelResponse"], [class*="assistant-message"], [data-role="model"], [data-role="assistant"]') : [];
                containers.forEach(container => {
                  handleNewResponse(container);
                });
              }
            }
          });
        }
      });
    });
    
    // 監控整個文檔
    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  }
  
  // 【四選一策略】處理新回應：以回應為單位，只下載第一張圖片
  function handleNewResponse(container) {
    if (!autoDownloadEnabled) return;
    // 檢查是否已處理過
    if (container.dataset.downloaded === 'true') {
      return;
    }
    
    // 等待2秒讓圖片載入
    setTimeout(() => {
      // 找到該回應裡面的所有下載按鈕
      const allButtons = container.querySelectorAll('button[data-test-id="download-generated-image-button"]');
      
      if (allButtons.length > 0) {
        // ★ 策略核心：只拿第一個 (index 0)
        const firstButton = allButtons[0];
        
        console.log('[Gemini 分類助手] [策略] 發現圖片群組，僅下載第一張代表圖');
        
        // 點擊第一個按鈕
        firstButton.click();
        
        // 標記整個容器已處理，防止後續重複下載其他張
        container.dataset.downloaded = 'true';
      }
    }, 2000);
  }
  
  // 判斷是否是下載按鈕
  function isDownloadButton(element) {
    if (!element || element.tagName !== 'BUTTON') return false;
    
    // 檢查 data-test-id（最精確）
    if (element.getAttribute('data-test-id') === 'download-generated-image-button') {
      return true;
    }
    
    // 檢查類名
    if (element.classList?.contains('download-generated-image-button')) {
      return true;
    }
    
    // 檢查 aria-label
    const ariaLabel = element.getAttribute('aria-label') || '';
    if ((ariaLabel.includes('下載') || ariaLabel.includes('download')) && 
        (ariaLabel.includes('原尺寸') || ariaLabel.includes('original'))) {
      return true;
    }
    
    // 檢查 jslog 中是否包含 BardVeMetadataKey
    const jslog = element.getAttribute('jslog') || '';
    if (jslog.includes('BardVeMetadataKey') && (ariaLabel.includes('下載') || ariaLabel.includes('download'))) {
      return true;
    }
    
    return false;
  }
  
  // 存儲檢測到的下載按鈕列表（用於測試）
  let detectedDownloadButtons = [];

  // 更新下載按鈕列表（用於測試）
  function updateDownloadButtonsList() {
    try {
      detectedDownloadButtons = [];
      const buttonSelectors = [
        'button[data-test-id="download-generated-image-button"]',
        'button.download-generated-image-button',
        '[data-test-id*="download-generated-image"]',
        'button[aria-label*="下載"]',
        'button[aria-label*="download"]',
        'download-generated-image-button button',
        '.generated-image-expansion-dialog-bottom-action-buttons button',
        '.generated-image-expansion-dialog-bottom-action-buttons a',
        '[role="menuitem"][aria-label*="下載"]',
        '[role="menuitem"][aria-label*="download"]'
      ];
      
      buttonSelectors.forEach(selector => {
        document.querySelectorAll(selector).forEach(button => {
          if (isDownloadButton(button) && !detectedDownloadButtons.includes(button)) {
            detectedDownloadButtons.push(button);
          }
        });
      });
      
      // 靜默更新按鈕列表（不輸出日誌）
    } catch (error) {
      console.error('[Gemini 分類助手] [下載按鈕] 更新按鈕列表時發生錯誤:', error);
    }
  }

  function isElementVisible(el) {
    try {
      if (!el || !el.getBoundingClientRect) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    } catch (e) {
      return false;
    }
  }

  function findBestDownloadButton() {
    updateDownloadButtonsList();
    if (detectedDownloadButtons.length > 0) {
      const visible = detectedDownloadButtons.find(isElementVisible);
      return visible || detectedDownloadButtons[0];
    }

    // 最後保底：嘗試在對話框動作區找按鈕
    const fallbackSelectors = [
      '.generated-image-expansion-dialog-bottom-action-buttons button',
      '.generated-image-expansion-dialog-bottom-action-buttons a',
      'button[aria-label*="下載"]',
      'button[aria-label*="download"]'
    ];
    for (const selector of fallbackSelectors) {
      const el = document.querySelector(selector);
      if (el) return el;
    }
    return null;
  }

  // 獲取下載按鈕列表（用於測試）
  function getDownloadButtonsList() {
    updateDownloadButtonsList();
    return detectedDownloadButtons.map((button, index) => {
      return {
        index: index,
        ariaLabel: button.getAttribute('aria-label') || '',
        dataTestId: button.getAttribute('data-test-id') || '',
        jslog: button.getAttribute('jslog') || '',
        html: button.outerHTML.substring(0, 200)
      };
    });
  }

  // 【全自動觸發流程】當偵測到新的圖片按鈕且圖片類名為 loaded 時，自動執行一次模擬點擊以觸發網路請求
  function autoTriggerDownloadButton(button) {
    try {
      // 查找按鈕附近的圖片元素
      const container = button.closest('[role="img"], [class*="image"], [class*="generated"]') || button.parentElement;
      if (!container) return;
      
      // 查找圖片元素（可能在按鈕的父容器或兄弟元素中）
      const img = container.querySelector('img') || 
                  button.parentElement?.querySelector('img') ||
                  button.previousElementSibling?.querySelector('img') ||
                  button.nextElementSibling?.querySelector('img');
      
      if (!img) {
        // 如果找不到圖片，設置一個 MutationObserver 等待圖片出現
        const imgObserver = new MutationObserver((mutations) => {
          mutations.forEach((mutation) => {
            if (mutation.addedNodes) {
              mutation.addedNodes.forEach(node => {
                  if (node.nodeType === 1) {
                    const foundImg = node.querySelector && node.querySelector('img');
                    if (foundImg) {
                      // className 可能是字符串或 DOMTokenList，需要轉換
                      const className = typeof foundImg.className === 'string' 
                        ? foundImg.className 
                        : (foundImg.className?.baseVal || foundImg.className?.toString() || '');
                      if (className && className.includes('loaded')) {
                        console.log('[Gemini 分類助手] [全自動觸發] 🔥 檢測到圖片類名包含 loaded，自動觸發下載按鈕點擊');
                        triggerButtonClick(button);
                        imgObserver.disconnect();
                      }
                    }
                  }
              });
            }
          });
        });
        
        imgObserver.observe(container, { childList: true, subtree: true });
        
        // 30秒後自動停止監控
        setTimeout(() => imgObserver.disconnect(), 30000);
        return;
      }
      
      // 檢查圖片類名是否包含 loaded
      if (img.className && img.className.includes('loaded')) {
        console.log('[Gemini 分類助手] [全自動觸發] 🔥 檢測到圖片類名包含 loaded，自動觸發下載按鈕點擊');
        triggerButtonClick(button);
        return;
      }
      
      // 如果圖片還沒有 loaded 類名，設置 MutationObserver 監聽類名變化
      const classObserver = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
          if (mutation.attributeName === 'class' && mutation.target === img) {
            const className = img.className || '';
            if (className.includes('loaded')) {
              console.log('[Gemini 分類助手] [全自動觸發] 🔥 檢測到圖片類名變更為包含 loaded，自動觸發下載按鈕點擊');
              triggerButtonClick(button);
              classObserver.disconnect();
            }
          }
        });
      });
      
      classObserver.observe(img, { attributes: true, attributeFilter: ['class'] });
      
      // 30秒後自動停止監控
      setTimeout(() => classObserver.disconnect(), 30000);
    } catch (error) {
      console.error('[Gemini 分類助手] [全自動觸發] ❌ 自動觸發下載按鈕時發生錯誤:', error);
    }
  }
  
  // 觸發按鈕點擊的輔助函數
  function triggerButtonClick(button) {
    try {
      // 設置攔截器以監控點擊後的網絡請求
      if (!button._interceptors) {
        setupButtonClickInterceptor(button);
      }
      
      // 使用組合點擊，確保觸發 Google 的非同步請求
      // 1. 先觸發 mousedown
      button.dispatchEvent(new MouseEvent('mousedown', { 
        bubbles: true, 
        cancelable: true,
        view: window,
        detail: 1
      }));
      
      // 2. 觸發 mouseup
      button.dispatchEvent(new MouseEvent('mouseup', { 
        bubbles: true, 
        cancelable: true,
        view: window,
        detail: 1
      }));
      
      // 3. 觸發 click
      button.dispatchEvent(new MouseEvent('click', { 
        bubbles: true, 
        cancelable: true,
        view: window,
        detail: 1
      }));
      
      // 4. 最後調用原生 click（確保兼容性）
      button.click();
      
      console.log('[Gemini 分類助手] [全自動觸發] ✓ 已自動觸發下載按鈕點擊，正在監控網絡請求...');
      
      // 監控按鈕狀態變化（可能顯示 spinner）
      const checkButtonState = () => {
        const spinner = button.querySelector('mat-spinner, [class*="spinner"], [class*="loading"]');
        if (spinner) {
          console.log('[Gemini 分類助手] [全自動觸發] 🔄 檢測到按鈕進入加載狀態');
        }
      };
      
      // 立即檢查一次
      checkButtonState();
      
      // 持續監控 5 秒
      const stateObserver = new MutationObserver(() => {
        checkButtonState();
      });
      stateObserver.observe(button, { 
        childList: true, 
        subtree: true, 
        attributes: true,
        attributeFilter: ['class']
      });
      
      setTimeout(() => {
        stateObserver.disconnect();
      }, 5000);
      
    } catch (error) {
      console.error('[Gemini 分類助手] [全自動觸發] ❌ 觸發按鈕點擊時發生錯誤:', error);
    }
  }

  // 點擊指定索引的下載按鈕（用於測試）
  function clickDownloadButtonByIndex(index) {
    try {
      // 【修正下載限制】每次點擊前，強制調用 processedImageUrls.clear() 確保繞過所有去重邏輯
      processedImageUrls.clear();

      updateDownloadButtonsList();
      const allButtonsNow = detectedDownloadButtons;
      
      if (allButtonsNow.length === 0) {
        console.warn(`[Gemini 分類助手] [下載按鈕測試] 未找到任何下載按鈕，改用自動搜尋`);
        return clickBestDownloadButton();
      }
      
      if (index < 0 || index >= allButtonsNow.length) {
        console.warn(`[Gemini 分類助手] [下載按鈕測試] 按鈕索引超出範圍: ${index} (總共 ${allButtonsNow.length} 個按鈕)`);
        return { status: 'error', error: `按鈕索引超出範圍: ${index} (總共 ${allButtonsNow.length} 個按鈕)` };
      }
      
      const button = allButtonsNow[index];

      if (button) {
        console.log(`[Gemini 分類助手] [下載按鈕測試] ⚡ 執行第 ${index} 個按鈕的下載序列`);
        startGlobalDownloadMonitor();
        
        // 【追蹤記錄】為測試點擊設置監聽記錄
        const clickTimestamp = Date.now();
        const urlRedirectChain = [];
        
        // 記錄測試點擊事件
        recordClickMonitorEvent('TEST_BUTTON_CLICKED', {
          buttonIndex: index,
          buttonJslog: button.getAttribute('jslog')?.substring(0, 500) || '',
          ariaLabel: button.getAttribute('aria-label') || '',
          dataTestId: button.getAttribute('data-test-id') || '',
          buttonHtml: button.outerHTML.substring(0, 300),
          totalButtons: allButtonsNow.length
        });
        
        // 設置按鈕點擊攔截器（用於追蹤網絡請求）
        setupButtonClickInterceptor(button);
        
        // 嘗試從按鈕中提取 URL（如果有的話）
        try {
          const extractedUrl = extractHighQualityUrlFromButton(button);
          if (extractedUrl) {
            console.log('[Gemini 分類助手] [下載按鈕測試] 🔍 從按鈕提取到 URL:', extractedUrl.substring(0, 200));
            
            recordClickMonitorEvent('TEST_URL_EXTRACTED', {
              buttonIndex: index,
              extractedUrl: extractedUrl.substring(0, 500),
              isGgDl: extractedUrl.includes('gg-dl'),
              isRdGgDl: extractedUrl.includes('rd-gg-dl')
            });
            
            // 如果提取到 gg-dl 或 rd-gg-dl URL，自動觸發完整追蹤
            if (extractedUrl.includes('gg-dl') || extractedUrl.includes('rd-gg-dl')) {
              console.log('[Gemini 分類助手] [下載按鈕測試] 🚀 檢測到下載 URL，自動觸發完整追蹤模式');
              trackImageUrlRedirectChain(extractedUrl, 4).then(result => {
                if (result.success) {
                  console.log('[Gemini 分類助手] [下載按鈕測試] ✅ 追蹤成功，已下載圖片');
                  recordClickMonitorEvent('TEST_TRACK_SUCCESS', {
                    buttonIndex: index,
                    finalUrl: result.finalUrl?.substring(0, 500),
                    steps: result.chain?.length || 0
                  });
                } else {
                  console.log('[Gemini 分類助手] [下載按鈕測試] ⚠️ 追蹤未完成:', result.reason);
                  recordClickMonitorEvent('TEST_TRACK_FAILED', {
                    buttonIndex: index,
                    reason: result.reason,
                    steps: result.chain?.length || 0
                  });
                }
              }).catch(err => {
                console.error('[Gemini 分類助手] [下載按鈕測試] ❌ 追蹤失敗:', err);
                recordClickMonitorEvent('TEST_TRACK_ERROR', {
                  buttonIndex: index,
                  error: err.message
                });
              });
            }
          }
        } catch (extractError) {
          console.warn('[Gemini 分類助手] [下載按鈕測試] 提取 URL 失敗:', extractError);
        }
        
        // 使用組合點擊，確保觸發 Google 的非同步請求
        button.dispatchEvent(new MouseEvent('mousedown', {
          bubbles: true, 
          cancelable: true, 
          view: window,
          isTrusted: false // 標記為程序觸發
        }));
        button.dispatchEvent(new MouseEvent('mouseup', {
          bubbles: true, 
          cancelable: true, 
          view: window,
          isTrusted: false
        }));
        button.dispatchEvent(new MouseEvent('click', {
          bubbles: true, 
          cancelable: true, 
          view: window,
          isTrusted: false
        }));
        button.click();
        
        console.log('[Gemini 分類助手] [下載按鈕測試] ✓ 已點擊按鈕，正在監控網絡請求...');
        
        return { status: 'ok', message: `已點擊第 ${index} 個按鈕，正在追蹤記錄` };
      } else {
        console.warn(`[Gemini 分類助手] [下載按鈕測試] 按鈕不存在: 索引 ${index}`);
        return { status: 'error', error: `按鈕不存在: 索引 ${index}` };
      }
    } catch (error) {
      console.error('[Gemini 分類助手] [下載按鈕測試] 點擊按鈕時發生錯誤:', error);
      recordClickMonitorEvent('TEST_BUTTON_CLICK_ERROR', {
        error: error.message || String(error)
      });
      return { status: 'error', error: error.message || String(error) };
    }
  }

  // 自動尋找最佳下載按鈕並點擊（用於測試）
  function clickBestDownloadButton() {
    try {
      processedImageUrls.clear();
      const button = findBestDownloadButton();
      if (!button) {
        console.warn('[Gemini 分類助手] [下載按鈕測試] 自動搜尋失敗：未找到按鈕');
        return { status: 'error', error: '未找到下載按鈕' };
      }

      console.log('[Gemini 分類助手] [下載按鈕測試] ⚡ 自動找到按鈕，準備點擊');
      startGlobalDownloadMonitor();

      // 設置攔截器，開始監聽 URL 轉向
      setupButtonClickInterceptor(button);

      // 記錄測試點擊事件
      recordClickMonitorEvent('TEST_BUTTON_CLICKED', {
        button: button,
        buttonJslog: button.getAttribute('jslog')?.substring(0, 500) || '',
        ariaLabel: button.getAttribute('aria-label') || '',
        dataTestId: button.getAttribute('data-test-id') || '',
        buttonHtml: button.outerHTML.substring(0, 300),
        totalButtons: detectedDownloadButtons.length
      });

      // 使用組合點擊，確保觸發 Google 的非同步請求
      button.dispatchEvent(new MouseEvent('mousedown', {
        bubbles: true,
        cancelable: true,
        view: window,
        isTrusted: false
      }));
      button.dispatchEvent(new MouseEvent('mouseup', {
        bubbles: true,
        cancelable: true,
        view: window,
        isTrusted: false
      }));
      button.dispatchEvent(new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        view: window,
        isTrusted: false
      }));
      button.click();

      return { status: 'ok', message: '已自動點擊下載按鈕，正在追蹤記錄' };
    } catch (error) {
      console.error('[Gemini 分類助手] [下載按鈕測試] 自動點擊失敗:', error);
      return { status: 'error', error: error.message || String(error) };
    }
  }

  // 從下載按鈕提取高畫質 URL（多種策略）
  function extractHighQualityUrlFromButton(button) {
    try {
      const jslog = button.getAttribute('jslog') || '';
      
      // 策略 1: 從 jslog 中提取 URL（如果有的話）
      const urlMatches = jslog.match(/https?:\/\/[^\s"']+/g);
      if (urlMatches && urlMatches.length > 0) {
        const sortedUrls = urlMatches
          .filter(url => url.includes('googleusercontent.com'))
          .sort((a, b) => b.length - a.length);
        
        if (sortedUrls.length > 0) {
          const originalUrl = extractOriginalImageUrl(sortedUrls[0], button);
          return originalUrl;
        }
      }
      
      // 策略 2: 從 BardVeMetadataKey 提取 ID，構建原始圖片 URL
      if (jslog.includes('BardVeMetadataKey')) {
        const metadataMatch = jslog.match(/BardVeMetadataKey:\[\["([^"]+)"/);
        if (metadataMatch && metadataMatch[1]) {
          const requestId = metadataMatch[1];
          
          // 嘗試從附近的 img 元素獲取 URL（並構建原始 URL）
          const nearbyImg = findNearbyImageForButton(button);
          if (nearbyImg) {
            // 支持從背景圖提取的圖片
            let imgSrc = nearbyImg.src;
            if (!imgSrc && nearbyImg.dataset?.backgroundImage === 'true') {
              // 從背景圖中提取
              try {
                const computedStyle = window.getComputedStyle(button);
                const backgroundImage = computedStyle.backgroundImage;
                if (backgroundImage && backgroundImage !== 'none') {
                  const urlMatch = backgroundImage.match(/url\(['"]?([^'"]+)['"]?\)/);
                  if (urlMatch && urlMatch[1]) {
                    imgSrc = urlMatch[1];
                  }
                }
              } catch (error) {
                console.error('[Gemini 分類助手] [高畫質提取] 從背景圖提取時發生錯誤:', error);
              }
            }
            
            if (imgSrc) {
              const originalUrl = buildOriginalImageUrlFromButton(imgSrc, requestId);
              if (originalUrl) {
                sendImageToSidePanel(originalUrl, requestId, nearbyImg);
                triggerAutoDownload(originalUrl, requestId);
                return originalUrl;
              }
            }
          }
        }
      }
      
      // 策略 2.5: 直接從按鈕的背景圖中提取（新增）
      if (button && button.classList && button.classList.contains('image-button')) {
        try {
          const computedStyle = window.getComputedStyle(button);
          const backgroundImage = computedStyle.backgroundImage;
          
          if (backgroundImage && backgroundImage !== 'none') {
            const urlMatch = backgroundImage.match(/url\(['"]?([^'"]+)['"]?\)/);
            if (urlMatch && urlMatch[1]) {
              const bgUrl = urlMatch[1];
              if (bgUrl.includes('googleusercontent.com') && bgUrl.length > 200) {
                console.log('[Gemini 分類助手] [高畫質提取] ✓ 從按鈕背景圖中提取到 URL:', bgUrl.substring(0, 100));
                const requestId = extractRequestIdFromButton(button) || 'bg_' + Date.now();
                const originalUrl = extractOriginalImageUrl(bgUrl, button);
                if (originalUrl) {
                  return originalUrl;
                }
              }
            }
          }
        } catch (error) {
          console.error('[Gemini 分類助手] [高畫質提取] 從背景圖提取時發生錯誤:', error);
        }
      }
      
      // 策略 3: 從按鈕的 href 或 data-href 屬性提取
      const href = button.getAttribute('href') || button.getAttribute('data-href') || '';
      if (href && href.includes('googleusercontent.com') && href.length > 200) {
        const originalUrl = extractOriginalImageUrl(href, button);
        return originalUrl;
      }
      
      // 策略 4: 自動點擊按鈕觸發下載（突破表層限制）
      setupButtonClickInterceptor(button);
      
      // 延遲後自動點擊按鈕（給按鈕時間完成初始化）
      setTimeout(() => {
        try {
          // 檢查按鈕是否仍然存在且可見
          if (button.isConnected && button.offsetParent !== null) {
            console.log('[Gemini 分類助手] [下載按鈕] 🔔 觸發點擊下載按鈕');
            
            // 觸發點擊事件
            button.click();
            
            // 如果直接點擊無效，嘗試觸發 mousedown 和 mouseup 事件
            setTimeout(() => {
              const mouseDownEvent = new MouseEvent('mousedown', {
                bubbles: true,
                cancelable: true,
                view: window
              });
              const mouseUpEvent = new MouseEvent('mouseup', {
                bubbles: true,
                cancelable: true,
                view: window
              });
              button.dispatchEvent(mouseDownEvent);
              setTimeout(() => {
                button.dispatchEvent(mouseUpEvent);
                button.click();
              }, 50);
            }, 100);
          }
        } catch (error) {
          console.error('[Gemini 分類助手] [下載按鈕] ❌ 自動點擊失敗:', error);
        }
      }, 300);
      
      // 策略 5: 查找附近的 img 元素
      const nearbyImg = findNearbyImageForButton(button);
      if (nearbyImg && nearbyImg.src && nearbyImg.src.includes('googleusercontent.com') && nearbyImg.src.length > 200) {
        const originalUrl = extractOriginalImageUrl(nearbyImg.src, button);
        return originalUrl;
      }
      
    } catch (error) {
      console.error('[Gemini 分類助手] [下載按鈕] ❌ 提取 URL 時發生錯誤:', error);
    }
    return null;
  }
  
  // 查找按鈕附近的圖片元素
  function findNearbyImageForButton(button) {
    // 策略 1: 檢查按鈕本身是否是 button.image-button，嘗試從背景圖中提取
    if (button && button.classList && button.classList.contains('image-button')) {
      try {
        // 從 computed style 中提取背景圖 URL
        const computedStyle = window.getComputedStyle(button);
        const backgroundImage = computedStyle.backgroundImage;
        
        if (backgroundImage && backgroundImage !== 'none') {
          // 提取 URL（格式可能是 url("...") 或 url('...')）
          const urlMatch = backgroundImage.match(/url\(['"]?([^'"]+)['"]?\)/);
          if (urlMatch && urlMatch[1]) {
            const bgUrl = urlMatch[1];
            // 檢查是否是有效的圖片 URL
            if (bgUrl.includes('googleusercontent.com') && bgUrl.length > 200) {
              console.log('[Gemini 分類助手] [背景圖提取] ✓ 從 button.image-button 的背景圖中提取到 URL:', bgUrl.substring(0, 100));
              // 創建一個臨時的 img 元素來返回（用於兼容現有邏輯）
              const tempImg = document.createElement('img');
              tempImg.src = bgUrl;
              tempImg.dataset.backgroundImage = 'true';
              return tempImg;
            }
          }
        }
      } catch (error) {
        console.error('[Gemini 分類助手] [背景圖提取] 提取背景圖時發生錯誤:', error);
      }
    }
    
    // 策略 2: 在同一個容器中查找
    const container = button.closest('[class*="image"], [class*="attachment"], model-response, [class*="response"], button.image-button');
    if (container) {
      // 優先查找 button.image-button 內的 img
      const imgInButton = container.querySelector('button.image-button img[src*="googleusercontent.com"]');
      if (imgInButton) return imgInButton;
      
      // 查找其他 img
      const img = container.querySelector('img[src*="googleusercontent.com"]');
      if (img) return img;
    }
    
    // 策略 3: 在同一個父元素中查找
    let parent = button.parentElement;
    let depth = 0;
    while (parent && depth < 5) {
      const img = parent.querySelector('img[src*="googleusercontent.com"]');
      if (img) return img;
      parent = parent.parentElement;
      depth++;
    }
    
    // 策略 4: 在前後兄弟元素中查找
    let sibling = button.previousElementSibling;
    depth = 0;
    while (sibling && depth < 3) {
      const img = sibling.querySelector('img[src*="googleusercontent.com"]');
      if (img) return img;
      sibling = sibling.previousElementSibling;
      depth++;
    }
    
    sibling = button.nextElementSibling;
    depth = 0;
    while (sibling && depth < 3) {
      const img = sibling.querySelector('img[src*="googleusercontent.com"]');
      if (img) return img;
      sibling = sibling.nextElementSibling;
      depth++;
    }
    
    return null;
  }
  
  // 構建原始圖片 URL（移除尺寸限制）
  function buildOriginalImageUrlFromButton(currentUrl, requestId) {
    try {
      // 移除尺寸參數（=s1024, =s512 等），構建原始尺寸 URL
      let originalUrl = currentUrl.replace(/=s\d+(-rj)?/gi, '');
      
      // 添加原始尺寸參數（s0 = 原始尺寸）
      if (!originalUrl.includes('=s')) {
        originalUrl += (originalUrl.includes('?') ? '&' : '?') + '=s0';
      } else {
        originalUrl = originalUrl.replace(/=s\d+/, '=s0');
      }
      
      return originalUrl;
    } catch (error) {
      console.error('[Gemini 分類助手] 構建原始 URL 時發生錯誤:', error);
      return null;
    }
  }
  
  // 提取原始圖片 URL（簡化版：只做 URL 轉換，不進行 DOM 爬蟲）
  function extractOriginalImageUrl(url, button) {
    // 如果 URL 無效，嘗試從按鈕的背景圖中提取
    if ((!url || !url.includes('googleusercontent.com')) && button && button.classList && button.classList.contains('image-button')) {
      try {
        const computedStyle = window.getComputedStyle(button);
        const backgroundImage = computedStyle.backgroundImage;
        
        if (backgroundImage && backgroundImage !== 'none') {
          const urlMatch = backgroundImage.match(/url\(['"]?([^'"]+)['"]?\)/);
          if (urlMatch && urlMatch[1]) {
            const bgUrl = urlMatch[1];
            if (bgUrl.includes('googleusercontent.com') && bgUrl.length > 200) {
              console.log('[Gemini 分類助手] [URL提取] ✓ 從背景圖中提取到 URL:', bgUrl.substring(0, 100));
              url = bgUrl;
            }
          }
        }
      } catch (error) {
        console.error('[Gemini 分類助手] [URL提取] 從背景圖提取時發生錯誤:', error);
      }
    }
    
    if (!url || !url.includes('googleusercontent.com')) return null;
    
    try {
      let originalUrl = url;
      
      // 移除尺寸參數（=s1024, =s512 等），構建原始尺寸 URL
      originalUrl = originalUrl.replace(/=s\d+(-rj)?/gi, '');
      
      // 添加原始尺寸參數（s0 = 原始尺寸）
      if (!originalUrl.includes('=s')) {
        originalUrl += (originalUrl.includes('?') ? '&' : '?') + '=s0';
      } else {
        originalUrl = originalUrl.replace(/=s\d+/, '=s0');
      }
      
      // 查找附近的圖片元素（用於發送）
      const nearbyImg = button ? findNearbyImageForButton(button) : null;
      
      // 獲取 requestId
      let requestId;
      if (button && button.dataset.manualTest === 'true') {
        requestId = 'manual_test_' + Date.now();
      } else {
        requestId = button ? extractRequestIdFromButton(button) : 'auto_' + Date.now();
      }
      
      // 使用現有的發送和下載邏輯
      if (nearbyImg) {
        // 如果 nearbyImg 是從背景圖提取的，使用原始 URL
        const imgSrc = nearbyImg.dataset?.backgroundImage === 'true' ? originalUrl : (nearbyImg.src || originalUrl);
        sendImageToSidePanel(imgSrc, requestId, nearbyImg);
      }
      triggerAutoDownload(originalUrl, requestId);
      
      return originalUrl;
    } catch (error) {
      return null;
    }
  }
  
  // 從按鈕提取 Request ID
  function extractRequestIdFromButton(button) {
    try {
      const jslog = button.getAttribute('jslog') || '';
      if (jslog.includes('BardVeMetadataKey')) {
        const metadataMatch = jslog.match(/BardVeMetadataKey:\[\["([^"]+)"/);
        if (metadataMatch && metadataMatch[1]) {
          return metadataMatch[1];
        }
      }
    } catch (e) {
      // 忽略錯誤
    }
    return 'btn_' + Date.now();
  }
  
  
  // 暴露調試函數到全局（方便在控制台調用）
  // 確保在全局作用域中定義，不依賴於 IIFE 的執行時機
  if (typeof window !== 'undefined') {
    window.geminiAssistantDebug = {
      // 分析頁面結構
      analyzePage: function() {
        console.log('=== Gemini 助手頁面結構分析 ===');
        console.log('URL:', window.location.href);
        console.log('ChatId:', typeof currentChatId !== 'undefined' ? currentChatId : '(未定義)');
        console.log('Title:', typeof currentTitle !== 'undefined' ? currentTitle : '(未定義)');
        console.log('User Profile:', typeof currentUserProfile !== 'undefined' ? currentUserProfile : '(未定義)');
        
        // 分析標題
        console.log('\n--- 標題分析 ---');
        console.log('document.title:', document.title);
        const h1s = document.querySelectorAll('h1');
        console.log('H1 數量:', h1s.length);
        h1s.forEach((h1, i) => {
          console.log(`H1 #${i + 1}:`, h1.innerText || h1.textContent);
        });
        
        // 分析包含 /app/ 的鏈接
        console.log('\n--- 對話鏈接分析 ---');
        const links = document.querySelectorAll('a[href*="/app/"]');
        console.log('包含 /app/ 的鏈接數量:', links.length);
        links.slice(0, 10).forEach((link, i) => {
          console.log(`鏈接 #${i + 1}:`, {
            href: link.href,
            text: (link.innerText || link.textContent || '').trim().substring(0, 100),
            ariaLabel: link.getAttribute('aria-label') || '',
            className: link.className?.substring(0, 100) || ''
          });
        });
        
        // 分析消息元素
        console.log('\n--- 消息元素分析 ---');
        const messageSelectors = [
          '[class*="user-query"]',
          '[class*="userQuery"]',
          '[class*="model-response"]',
          '[class*="modelResponse"]',
          '[role="article"]',
          '[class*="turn"]',
          '[class*="message"]'
        ];
        
        messageSelectors.forEach(selector => {
          try {
            const elements = document.querySelectorAll(selector);
            if (elements.length > 0) {
              console.log(`${selector}: 找到 ${elements.length} 個元素`);
              elements.slice(0, 3).forEach((el, i) => {
                const text = (el.innerText || el.textContent || '').trim();
                if (text.length > 0) {
                  console.log(`  [${i + 1}] 文本預覽:`, text.substring(0, 100));
                  console.log(`      類名:`, el.className?.substring(0, 100));
                }
              });
            }
          } catch (e) {
            console.warn(`選擇器 "${selector}" 查詢出錯:`, e.message);
          }
        });
        
        // 分析所有包含文本的 div
        console.log('\n--- 包含文本的容器分析 ---');
        const allDivs = document.querySelectorAll('div');
        const textDivs = Array.from(allDivs).filter(div => {
          const text = (div.innerText || div.textContent || '').trim();
          return text.length > 20 && text.length < 5000;
        });
        console.log(`找到 ${textDivs.length} 個包含文本的 div`);
        textDivs.slice(0, 10).forEach((div, i) => {
          const text = (div.innerText || div.textContent || '').trim();
          console.log(`容器 #${i + 1}:`, {
            className: div.className?.substring(0, 100) || '(無)',
            textPreview: text.substring(0, 100),
            dataRole: div.getAttribute('data-role') || '(無)'
          });
        });
      },
      
      // 手動提取標題
      extractTitle: function() {
        console.log('=== 手動提取標題 ===');
        if (typeof extractTitle === 'function') {
          extractTitle();
        } else {
          console.error('extractTitle 函數未定義');
        }
      },
      
      // 手動提取消息
      extractMessages: function() {
        console.log('=== 手動提取消息 ===');
        if (typeof scrapeMessages === 'function') {
          const messages = scrapeMessages();
          console.log('提取到的消息:', messages);
          return messages;
        } else {
          console.error('scrapeMessages 函數未定義');
          return [];
        }
      },
      
      // 獲取當前狀態
      getStatus: function() {
        return {
          chatId: typeof currentChatId !== 'undefined' ? currentChatId : null,
          title: typeof currentTitle !== 'undefined' ? currentTitle : null,
          userProfile: typeof currentUserProfile !== 'undefined' ? currentUserProfile : null,
          url: window.location.href,
          isMonitoring: typeof isMonitoring !== 'undefined' ? isMonitoring : false
        };
      }
    };
    
    console.log('[Gemini 分類助手] 調試工具已載入，使用 window.geminiAssistantDebug 訪問');
    console.log('[Gemini 分類助手] 可用方法:');
    console.log('  - window.geminiAssistantDebug.analyzePage() - 分析頁面結構');
    console.log('  - window.geminiAssistantDebug.extractTitle() - 手動提取標題');
    console.log('  - window.geminiAssistantDebug.extractMessages() - 手動提取消息');
    console.log('  - window.geminiAssistantDebug.getStatus() - 獲取當前狀態');
  }

  // 全局攔截器管理：支持多個按鈕同時攔截
  if (!window._geminiInterceptors) {
    window._geminiInterceptors = {
      activeButtons: new Set(),
      originalFetch: window.fetch,
      originalXHROpen: XMLHttpRequest.prototype.open,
      originalXHRSend: XMLHttpRequest.prototype.send,
      fetchWrapper: null,
      xhrWrapper: null,
      xhrSendWrapper: null,
      extractedImageUrls: new Set() // 用於去重已提取的圖片 URL
    };
    
    // 從 batchexecute API 響應中提取圖片 URL 和元數據
    function extractImageUrlFromBatchexecuteResponse(responseText, requestUrl) {
      try {
        // 響應格式可能是：
        // 1. )]}'\n[["wrb.fr","c8o8Fe","[\"https://...\"]",...]]
        // 2. )]}'\n500\n[["wrb.fr","c8o8Fe","[\"https://...\"]",...]]
        let jsonText = responseText.trim();
        
        // 跳過安全前綴 )]}'\n
        if (jsonText.startsWith(")]}'\n")) {
          jsonText = jsonText.substring(5);
        } else if (jsonText.startsWith(")]}'")) {
          jsonText = jsonText.substring(4);
        }
        
        // 跳過可能的數字行（如 "500"）
        const lines = jsonText.split('\n');
        let dataLine = null;
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed && trimmed.startsWith('[')) {
            dataLine = trimmed;
            break;
          }
        }
        
        if (!dataLine) {
          // 如果沒有找到以 [ 開頭的行，嘗試直接解析整個文本
          dataLine = jsonText;
        }
        
        const data = JSON.parse(dataLine);
        if (!Array.isArray(data)) return null;
        
        // 從請求 URL 中提取 chatId
        const chatIdMatch = requestUrl?.match(/source-path=%2Fapp%2F([^&]+)/);
        const chatId = chatIdMatch ? decodeURIComponent(chatIdMatch[1]) : null;
        
        // 遍歷所有數組項，查找包含圖片 URL 的項
        for (const item of data) {
          if (!Array.isArray(item) || item.length < 3) continue;
          
          // 檢查第二個元素（索引 2）是否為字符串數組（包含 URL）
          // 格式: ["wrb.fr","c8o8Fe","[\"https://...\"]",...]
          const urlArrayStr = item[2];
          if (typeof urlArrayStr === 'string') {
            try {
              // 解析嵌套的 JSON 字符串數組
              const urlArray = JSON.parse(urlArrayStr);
              if (Array.isArray(urlArray)) {
                for (const urlItem of urlArray) {
                  // urlItem 可能是字符串 URL 或包含更多信息的數組
                  let imageUrl = null;
                  let token = null;
                  let metadata = null;
                  
                  if (typeof urlItem === 'string' && urlItem.startsWith('http')) {
                    imageUrl = urlItem;
                  } else if (Array.isArray(urlItem)) {
                    // 解析複雜結構，查找 URL、token 和 metadata
                    // 格式: [null,null,null,[null,null,null,null,null,"$TOKEN"],["http://googleusercontent.com/image_generation_content/36",0],null,[19,""],null,null,null,null,null,"miti7mmiti7mmiti"],["r_b011e2b6cbf5e439","rc_313d452a7e5de5b8","c_4a19065cee80feea",null,"miti7mmiti7mmiti"]
                    for (const subItem of urlItem) {
                      if (typeof subItem === 'string') {
                        if (subItem.startsWith('http')) {
                          imageUrl = subItem;
                        } else if (subItem.startsWith('$') || subItem.length > 100) {
                          // 可能是 token
                          token = subItem;
                        } else if (subItem.startsWith('r_') || subItem.startsWith('rc_') || subItem.startsWith('c_')) {
                          // 可能是 metadata ID
                          if (!metadata) metadata = [];
                          metadata.push(subItem);
                        }
                      } else if (Array.isArray(subItem)) {
                        // 遞歸查找
                        for (const deepItem of subItem) {
                          if (typeof deepItem === 'string') {
                            if (deepItem.startsWith('http')) {
                              imageUrl = deepItem;
                            } else if (deepItem.startsWith('$') || deepItem.length > 100) {
                              token = deepItem;
                            }
                          }
                        }
                      }
                    }
                  }
                  
                  // 檢查是否為圖片 URL
                  if (imageUrl && typeof imageUrl === 'string' && imageUrl.startsWith('http')) {
                    const isImageUrl = imageUrl.includes('gg-dl') || 
                                      imageUrl.includes('rd-gg-dl') || 
                                      imageUrl.includes('/gg/') ||
                                      imageUrl.includes('image_generation') ||
                                      (imageUrl.includes('googleusercontent.com') && imageUrl.length > 200);
                    
                    if (isImageUrl) {
                      // 找到圖片 URL
                      if (!window._geminiInterceptors.extractedImageUrls.has(imageUrl)) {
                        window._geminiInterceptors.extractedImageUrls.add(imageUrl);
                        
                        console.log('[Gemini 分類助手] [API 攔截] ✓ 從 batchexecute 響應中提取到圖片信息:', {
                          url: imageUrl.substring(0, 100),
                          chatId: chatId,
                          token: token ? token.substring(0, 50) + '...' : null,
                          metadata: metadata
                        });
                        
                        // 根據 metadata 查找對應的下載按鈕
                        let targetButton = null;
                        if (metadata && metadata.length > 0) {
                          // 使用 metadata 中的 ID 查找按鈕
                          const metadataStr = metadata.join(',');
                          const buttons = document.querySelectorAll('button[data-test-id="download-generated-image-button"]');
                          for (const btn of buttons) {
                            const jslog = btn.getAttribute('jslog') || '';
                            if (jslog.includes(metadata[0]) || jslog.includes(metadataStr)) {
                              targetButton = btn;
                              console.log('[Gemini 分類助手] [API 攔截] ✓ 找到匹配的下載按鈕（通過 metadata）');
                              break;
                            }
                          }
                        }
                        
                        // 如果沒找到，嘗試通過 chatId 查找最近的按鈕
                        if (!targetButton && chatId) {
                          const buttons = document.querySelectorAll('button[data-test-id="download-generated-image-button"]');
                          if (buttons.length > 0) {
                            // 選擇最後一個按鈕（通常是最新的）
                            targetButton = buttons[buttons.length - 1];
                            console.log('[Gemini 分類助手] [API 攔截] ✓ 使用最新的下載按鈕');
                          }
                        }
                        
                        // 如果找到按鈕，設置攔截器並模擬點擊
                        if (targetButton) {
                          setupButtonClickInterceptor(targetButton);
                          
                          // 延遲模擬點擊，確保按鈕已準備好
                          setTimeout(() => {
                            try {
                              console.log('[Gemini 分類助手] [API 攔截] 🔥 模擬點擊下載按鈕以觸發下載');
                              triggerButtonClick(targetButton);
                              
                              // 監控後續的網絡請求（通過攔截器）
                              // 攔截器會在按鈕點擊後自動監控 fetch/XHR 請求
                            } catch (error) {
                              console.error('[Gemini 分類助手] [API 攔截] 模擬點擊失敗:', error);
                            }
                          }, 500);
                        }
                        
                        // 通知所有活躍的按鈕
                        window._geminiInterceptors.activeButtons.forEach(btn => {
                          if (btn._interceptors && !btn._interceptors.downloadLinkFound) {
                            extractOriginalImageUrl(imageUrl, btn);
                          }
                        });
                        
                        // 發送給 background 保存並觸發下載
                        chrome.runtime.sendMessage({
                          action: 'IMAGE_URL_EXTRACTED',
                          url: imageUrl,
                          source: 'batchexecute_api',
                          chatId: chatId,
                          metadata: metadata,
                          token: token
                        }).catch(() => {
                          // 忽略錯誤
                        });
                        
                        return imageUrl;
                      }
                    }
                  }
                }
              } else if (typeof urlArray === 'string' && urlArray.startsWith('http')) {
                // 如果解析後是單個 URL 字符串
                const url = urlArray;
                if (url.includes('gg-dl') || 
                    url.includes('rd-gg-dl') || 
                    url.includes('/gg/') ||
                    url.includes('image_generation') ||
                    (url.includes('googleusercontent.com') && url.length > 200)) {
                  if (!window._geminiInterceptors.extractedImageUrls.has(url)) {
                    window._geminiInterceptors.extractedImageUrls.add(url);
                    console.log('[Gemini 分類助手] [API 攔截] ✓ 從 batchexecute 響應中提取到圖片 URL:', url.substring(0, 100));
                    
                    // 查找並模擬點擊按鈕
                    const buttons = document.querySelectorAll('button[data-test-id="download-generated-image-button"]');
                    if (buttons.length > 0) {
                      const targetButton = buttons[buttons.length - 1];
                      setupButtonClickInterceptor(targetButton);
                      setTimeout(() => {
                        triggerButtonClick(targetButton);
                      }, 500);
                    }
                    
                    window._geminiInterceptors.activeButtons.forEach(btn => {
                      if (btn._interceptors && !btn._interceptors.downloadLinkFound) {
                        extractOriginalImageUrl(url, btn);
                      }
                    });
                    
                    chrome.runtime.sendMessage({
                      action: 'IMAGE_URL_EXTRACTED',
                      url: url,
                      source: 'batchexecute_api',
                      chatId: chatId
                    }).catch(() => {});
                    
                    return url;
                  }
                }
              }
            } catch (e) {
              // 解析失敗，繼續下一個項
              console.log('[Gemini 分類助手] [API 攔截] 解析 URL 數組失敗:', e.message);
            }
          }
        }
      } catch (error) {
        // 解析失敗，忽略
        console.log('[Gemini 分類助手] [API 攔截] 解析 batchexecute 響應失敗:', error.message);
      }
      return null;
    }
    
    // 設置全局 fetch 包裝器（只設置一次）
    window._geminiInterceptors.fetchWrapper = function(...args) {
      const url = args[0];
      const requestUrl = typeof url === 'string' ? url : (url?.url || '');
      if (typeof requestUrl === 'string') {
        // 攔截 batchexecute API
        if (requestUrl.includes('batchexecute') && requestUrl.includes('BardChatUi')) {
          return window._geminiInterceptors.originalFetch.apply(this, args).then(response => {
            // 克隆響應以便讀取
            const clonedResponse = response.clone();
            clonedResponse.text().then(text => {
              extractImageUrlFromBatchexecuteResponse(text, requestUrl);
            }).catch(() => {});
            // 全域記錄 responseURL（只記錄連結）
            if (clickMonitorStarted && shouldLogResponseUrl(response?.url || requestUrl)) {
              recordClickMonitorEvent('NETWORK_RESPONSE_URL', {
                requestUrl: requestUrl.substring(0, 500),
                responseUrl: (response?.url || requestUrl).substring(0, 500),
                source: 'global_fetch',
                timeSinceClick: firstUserClickAt ? Date.now() - firstUserClickAt : null
              });
            }
            return response;
          });
        }
        
        // 攔截 googleusercontent.com 請求
        if (requestUrl.includes('googleusercontent.com')) {
          // 通知所有活躍的按鈕
          window._geminiInterceptors.activeButtons.forEach(btn => {
            if (btn._interceptors && !btn._interceptors.downloadLinkFound) {
              extractOriginalImageUrl(requestUrl, btn);
            }
          });
        }
      }
      return window._geminiInterceptors.originalFetch.apply(this, args).then(response => {
        const responseUrl = response?.url || requestUrl;
        if (clickMonitorStarted && shouldLogResponseUrl(responseUrl)) {
          recordClickMonitorEvent('NETWORK_RESPONSE_URL', {
            requestUrl: requestUrl.substring(0, 500),
            responseUrl: responseUrl.substring(0, 500),
            source: 'global_fetch',
            captureLocation: 'content_fetch',
            timeSinceClick: firstUserClickAt ? Date.now() - firstUserClickAt : null
          });

          if (Date.now() <= globalDownloadMonitorUntil &&
              isDownloadUrl(responseUrl) &&
              !globalTrackedResponseUrls.has(responseUrl)) {
            globalTrackedResponseUrls.add(responseUrl);
            recordClickMonitorEvent('AUTO_TRACK_FROM_RESPONSE_URL', {
              responseUrl: responseUrl.substring(0, 500),
              source: 'global_fetch'
            });
            trackImageUrlRedirectChain(responseUrl, 4).catch(err => {
              recordClickMonitorEvent('TRACK_ERROR', {
                url: responseUrl.substring(0, 300),
                error: err?.message || String(err)
              });
            });
          }

          if (Date.now() <= globalDownloadMonitorUntil &&
              responseUrl.includes('rd-gg-dl') &&
              !triggerAutoDownloadOnceUrls.has(responseUrl)) {
            triggerAutoDownloadOnceUrls.add(responseUrl);
            attemptAutoDownloadMulti(responseUrl, 'global_fetch');
          }
        }
        return response;
      });
    };
    
    // 設置全局 XHR 包裝器（只設置一次）
    window._geminiInterceptors.xhrWrapper = function(method, url, ...rest) {
      if (typeof url === 'string' && url.includes('googleusercontent.com')) {
        // 通知所有活躍的按鈕
        window._geminiInterceptors.activeButtons.forEach(btn => {
          if (btn._interceptors && !btn._interceptors.downloadLinkFound) {
            extractOriginalImageUrl(url, btn);
          }
        });
      }
      return window._geminiInterceptors.originalXHROpen.apply(this, [method, url, ...rest]);
    };
    
    // 攔截 XHR send 以讀取響應
    window._geminiInterceptors.xhrSendWrapper = function(...args) {
      const xhr = this;
      const originalOnReadyStateChange = xhr.onreadystatechange;
      
      xhr.onreadystatechange = function() {
        if (xhr.readyState === 4) {
          const url = xhr.responseURL || '';
          if (clickMonitorStarted && shouldLogResponseUrl(url)) {
            recordClickMonitorEvent('NETWORK_RESPONSE_URL', {
              requestUrl: url.substring(0, 500),
              responseUrl: url.substring(0, 500),
              source: 'global_xhr',
              captureLocation: 'content_xhr',
              timeSinceClick: firstUserClickAt ? Date.now() - firstUserClickAt : null
            });

            if (Date.now() <= globalDownloadMonitorUntil &&
                isDownloadUrl(url) &&
                !globalTrackedResponseUrls.has(url)) {
              globalTrackedResponseUrls.add(url);
              recordClickMonitorEvent('AUTO_TRACK_FROM_RESPONSE_URL', {
                responseUrl: url.substring(0, 500),
                source: 'global_xhr'
              });
              trackImageUrlRedirectChain(url, 4).catch(err => {
                recordClickMonitorEvent('TRACK_ERROR', {
                  url: url.substring(0, 300),
                  error: err?.message || String(err)
                });
              });
            }

            if (Date.now() <= globalDownloadMonitorUntil &&
                url.includes('rd-gg-dl') &&
                !triggerAutoDownloadOnceUrls.has(url)) {
              triggerAutoDownloadOnceUrls.add(url);
              attemptAutoDownloadMulti(url, 'global_xhr');
            }
          }
          if (xhr.status === 200) {
          if (url.includes('batchexecute') && url.includes('BardChatUi')) {
            try {
              extractImageUrlFromBatchexecuteResponse(xhr.responseText, url);
            } catch (e) {
              // 忽略錯誤
            }
          }
          }
        }
        
        if (originalOnReadyStateChange) {
          originalOnReadyStateChange.apply(this, arguments);
        }
      };
      
      return window._geminiInterceptors.originalXHRSend.apply(this, args);
    };
    
    // 應用全局包裝器
    window.fetch = window._geminiInterceptors.fetchWrapper;
    XMLHttpRequest.prototype.open = window._geminiInterceptors.xhrWrapper;
    XMLHttpRequest.prototype.send = window._geminiInterceptors.xhrSendWrapper;
  }
  
  // 設置按鈕點擊攔截器（最佳方案：監控點擊後的菜單和網絡請求）
  // 監聽記錄系統：記錄用戶點擊下載按鈕後的所有變化
  let clickMonitorRecords = [];
  const MAX_MONITOR_RECORDS = 100; // 最多保留 100 條記錄
  const downloadRecordIdByKey = new Map(); // downloadId 或 URL -> recordId
  let clickMonitorStarted = false;
  let firstUserClickAt = null;
  let globalDownloadMonitorUntil = 0;
  const globalTrackedResponseUrls = new Set();
  const triggerAutoDownloadOnceUrls = new Set();
  const multiDownloadAttemptOnceUrls = new Set();
  let autoDownloadSuccessOnce = false;
  const stopAutoDownloadAfterSuccess = true;

  function markAutoDownloadSuccess(url, source) {
    if (autoDownloadSuccessOnce) return;
    autoDownloadSuccessOnce = true;
    recordClickMonitorEvent('AUTO_DOWNLOAD_SUCCESS_ONCE', {
      url: url ? url.substring(0, 300) : null,
      source: source || 'unknown'
    });
  }
  
  // 【優化】批量發送記錄（防抖機制）
  let pendingRecords = [];
  let recordBatchTimer = null;
  const RECORD_BATCH_INTERVAL = 500; // 每 500ms 批量發送一次
  
  // 【優化】URL 追蹤去重（避免重複追蹤同一個 URL）
  const trackingUrls = new Set();
  
  // 【優化】統一的 URL 檢查函數
  function isDownloadUrl(url) {
    if (!url || typeof url !== 'string') return false;
    return url.includes('gg-dl') || 
           url.includes('rd-gg-dl') ||
           url.includes('rd-gg') ||
           url.includes('googleusercontent.com') ||
           url.includes('work.fife.usercontent.google.com') ||
           url.includes('lh3.google.com/rd-gg') ||
           (url.includes('rd-gg') && url.includes('s0-d-I'));
  }

  function shouldLogResponseUrl(url) {
    if (!url || typeof url !== 'string') return false;
    return url.includes('googleusercontent.com') ||
           url.includes('lh3.google.com') ||
           url.includes('work.fife.usercontent.google.com') ||
           url.includes('rd-gg') ||
           url.includes('gg-dl');
  }

  function startGlobalDownloadMonitor(durationMs = 90000) {
    globalDownloadMonitorUntil = Date.now() + durationMs;
  }

  // 多方案自動下載（順序嘗試）
  async function attemptAutoDownloadMulti(url, source) {
    if (!url || multiDownloadAttemptOnceUrls.has(url)) return;
    if (stopAutoDownloadAfterSuccess && autoDownloadSuccessOnce) return;
    multiDownloadAttemptOnceUrls.add(url);

    // 方案 A: 交由 background 使用 downloads API（避免開新分頁）
    try {
      if (isRuntimeValid()) {
        const response = await new Promise((resolve) => {
          try {
            chrome.runtime.sendMessage({
              action: 'FORCE_DOWNLOAD_URL',
              url: url,
              reason: 'autoResponseUrl',
              source: source
            }, (resp) => resolve(resp || null));
          } catch (err) {
            resolve({ status: 'error', error: err?.message || String(err) });
          }
        });

        if (response && response.status === 'ok') {
          recordClickMonitorEvent('AUTO_TRIGGER_DOWNLOAD', {
            responseUrl: url.substring(0, 500),
            source: source,
            method: 'background_download'
          });
          markAutoDownloadSuccess(url, 'background_download');
          return;
        }
      }
    } catch (err) {
      recordClickMonitorEvent('AUTO_TRIGGER_DOWNLOAD_FAILED', {
        responseUrl: url.substring(0, 300),
        source: source,
        method: 'background_download',
        error: err?.message || String(err)
      });
    }

    // 方案 B: 既有 triggerAutoDownload（downloads API）
    try {
      recordClickMonitorEvent('AUTO_TRIGGER_DOWNLOAD', {
        responseUrl: url.substring(0, 500),
        source: source,
        method: 'triggerAutoDownload'
      });
      await triggerAutoDownload(url, `auto_${Date.now()}`, null, 'highres', 'autoResponseUrl');
    } catch (err) {
      recordClickMonitorEvent('AUTO_TRIGGER_DOWNLOAD_FAILED', {
        responseUrl: url.substring(0, 300),
        source: source,
        method: 'triggerAutoDownload',
        error: err?.message || String(err)
      });
    }

    // 方案 C: 在頁面內用 <a> 觸發下載（可能會開新分頁，之後關閉）
    try {
      let originalTabId = null;
      if (isRuntimeValid()) {
        originalTabId = await new Promise((resolve) => {
          try {
            chrome.runtime.sendMessage({ action: 'GET_ACTIVE_TAB_ID' }, (resp) => {
              resolve(resp?.tabId || null);
            });
          } catch (err) {
            resolve(null);
          }
        });
      }
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.target = '_blank';
      anchor.rel = 'noopener noreferrer';
      anchor.download = '';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      recordClickMonitorEvent('AUTO_TRIGGER_DOWNLOAD', {
        responseUrl: url.substring(0, 500),
        source: source,
        method: 'anchor_click'
      });

      if (isRuntimeValid()) {
        setTimeout(() => {
          chrome.runtime.sendMessage({
            action: 'CLOSE_DOWNLOAD_TABS',
            url: url,
            returnTabId: originalTabId
          }).catch(() => {});
        }, 1500);
      }
    } catch (err) {
      recordClickMonitorEvent('AUTO_TRIGGER_DOWNLOAD_FAILED', {
        responseUrl: url.substring(0, 300),
        source: source,
        method: 'anchor_click',
        error: err?.message || String(err)
      });
    }
  }
  
  // 【完整追蹤記錄】提取 URL 模式（用於分析）
  function extractUrlPattern(url) {
    if (!url || typeof url !== 'string') return null;
    
    try {
      const urlObj = new URL(url);
      return {
        protocol: urlObj.protocol,
        hostname: urlObj.hostname,
        pathname: urlObj.pathname.substring(0, 200), // 限制長度
        searchParams: Object.fromEntries(Array.from(urlObj.searchParams.entries()).slice(0, 10)), // 只取前 10 個參數
        hasGgDl: url.includes('gg-dl'),
        hasRdGgDl: url.includes('rd-gg-dl'),
        hasS0: url.includes('=s0') || url.includes('s0-d-I'),
        hasAlr: url.includes('alr=yes'),
        urlLength: url.length
      };
    } catch (e) {
      return {
        raw: url.substring(0, 200),
        hasGgDl: url.includes('gg-dl'),
        hasRdGgDl: url.includes('rd-gg-dl'),
        hasS0: url.includes('=s0') || url.includes('s0-d-I'),
        urlLength: url.length
      };
    }
  }
  
  // 完整的原始圖追蹤模式：自動追蹤 URL 重定向鏈（最多 4 次）
  async function trackImageUrlRedirectChain(startUrl, maxSteps = 4, currentStep = 0, redirectChain = []) {
    try {
      if (currentStep >= maxSteps) {
        console.warn('[Gemini 分類助手] [原始圖追蹤] ⚠️ 已達到最大追蹤次數:', maxSteps);
        recordClickMonitorEvent('TRACK_MAX_STEPS_REACHED', {
          startUrl: startUrl.substring(0, 500),
          finalUrl: redirectChain.length > 0 ? redirectChain[redirectChain.length - 1].url : startUrl,
          steps: redirectChain.length,
          redirectChain: redirectChain
        });
        return { success: false, reason: 'max_steps', chain: redirectChain };
      }
      
      if (!startUrl || typeof startUrl !== 'string') {
        return { success: false, reason: 'invalid_url', chain: redirectChain };
      }
      
      // 【優化】URL 去重：檢查是否正在追蹤或已追蹤過
      const urlKey = startUrl.substring(0, 200); // 使用前 200 字符作為 key
      if (trackingUrls.has(urlKey)) {
        console.log('[Gemini 分類助手] [原始圖追蹤] ⏭️ 跳過：URL 正在追蹤中:', urlKey.substring(0, 100));
        return { success: false, reason: 'already_tracking', chain: redirectChain };
      }
      
      // 【優化】使用統一的 URL 檢查函數
      if (!isDownloadUrl(startUrl)) {
        return { success: false, reason: 'not_download_url', chain: redirectChain };
      }
      
      // 標記為正在追蹤
      trackingUrls.add(urlKey);
      
      // 設置超時清理（30 秒後自動移除，防止永久佔用）
      setTimeout(() => {
        trackingUrls.delete(urlKey);
      }, 30000);
      
      console.log(`[Gemini 分類助手] [原始圖追蹤] 🔍 步驟 ${currentStep + 1}/${maxSteps}: 追蹤 URL:`, startUrl.substring(0, 200));
      
      // 記錄當前步驟
      const stepRecord = {
        step: currentStep + 1,
        url: startUrl,
        timestamp: Date.now(),
        type: currentStep === 0 ? 'INITIAL' : 'REDIRECT'
      };
      redirectChain.push(stepRecord);
      
      recordClickMonitorEvent('TRACK_STEP', {
        step: currentStep + 1,
        url: startUrl.substring(0, 500),
        fullUrl: startUrl, // 完整 URL
        urlPattern: extractUrlPattern(startUrl),
        redirectChain: redirectChain.map(r => ({ 
          step: r.step, 
          type: r.type,
          url: r.url.substring(0, 200),
          urlPattern: extractUrlPattern(r.url)
        })),
        maxSteps: maxSteps,
        currentStep: currentStep
      });
      
      // 發送請求追蹤重定向
      try {
        const response = await fetch(startUrl, {
          method: 'GET',
          redirect: 'follow', // 自動跟隨重定向
          credentials: 'include'
        });
        
        // 檢查響應 URL（可能發生重定向）
        const finalUrl = response.url || response.redirected ? response.url : startUrl;
        
        if (finalUrl !== startUrl) {
          console.log(`[Gemini 分類助手] [原始圖追蹤] 🔀 檢測到重定向:`, finalUrl.substring(0, 200));
          
          recordClickMonitorEvent('TRACK_REDIRECT', {
            step: currentStep + 1,
            fromUrl: startUrl.substring(0, 500),
            toUrl: finalUrl.substring(0, 500),
            redirectChain: redirectChain.length
          });
          
          // 檢查是否為最終的下載 URL（包含 s0-d-I 或類似標記）
          const isFinalDownloadUrl = finalUrl.includes('s0-d-I') || 
                                     finalUrl.includes('=s0') ||
                                     (finalUrl.includes('rd-gg-dl') && finalUrl.includes('s0'));
          
          if (isFinalDownloadUrl) {
            console.log('[Gemini 分類助手] [原始圖追蹤] ✅ 找到最終下載 URL:', finalUrl.substring(0, 200));
            
            stepRecord.finalUrl = finalUrl;
            stepRecord.isFinal = true;
            
            recordClickMonitorEvent('TRACK_FINAL_URL', {
              finalUrl: finalUrl.substring(0, 500),
              totalSteps: redirectChain.length,
              redirectChain: redirectChain.map(r => ({ step: r.step, url: r.url.substring(0, 200) }))
            });
            
            // 自動下載圖片
            await triggerAutoDownload(finalUrl, `track_${Date.now()}`, null, 'highres', 'trackImageUrlRedirectChain');
            
            // 清理追蹤標記
            trackingUrls.delete(urlKey);
            
            return { success: true, finalUrl: finalUrl, chain: redirectChain };
          }
          
          // 遞歸追蹤下一個 URL
          return await trackImageUrlRedirectChain(finalUrl, maxSteps, currentStep + 1, redirectChain);
        }
        
        // 如果沒有重定向，嘗試從響應文本中提取 URL
        if (response.ok) {
          const contentType = response.headers.get('content-type') || '';
          
          if (contentType.includes('text') || contentType.includes('html')) {
            try {
              const text = await response.clone().text();
              
              // 查找可能的 URL（包含 rd-gg-dl, rd-gg, s0-d-I 等）
              const urlPatterns = [
                /https?:\/\/[^\s"']*work\.fife\.usercontent\.google\.com[^\s"']*rd-gg-dl[^\s"']*s0-d-I[^\s"']*/,
                /https?:\/\/[^\s"']*lh3\.google[^\s"']*rd-gg[^\s"']*s0-d-I[^\s"']*/,
                /https?:\/\/[^\s"']*rd-gg-dl[^\s"']*s0-d-I[^\s"']*/,
                /https?:\/\/[^\s"']*rd-gg[^\s"']*s0-d-I[^\s"']*/
              ];
              
              for (const pattern of urlPatterns) {
                const urlMatch = text.match(pattern);
                if (urlMatch && urlMatch[0] && urlMatch[0] !== startUrl) {
                  const foundUrl = urlMatch[0];
                  console.log('[Gemini 分類助手] [原始圖追蹤] 🔍 從響應中提取到 URL:', foundUrl.substring(0, 200));
                  
                  recordClickMonitorEvent('TRACK_URL_EXTRACTED', {
                    step: currentStep + 1,
                    fromUrl: startUrl.substring(0, 500),
                    extractedUrl: foundUrl.substring(0, 500),
                    redirectChain: redirectChain.length
                  });
                  
                  // 遞歸追蹤提取到的 URL
                  return await trackImageUrlRedirectChain(foundUrl, maxSteps, currentStep + 1, redirectChain);
                }
              }
            } catch (e) {
              console.warn('[Gemini 分類助手] [原始圖追蹤] 讀取響應文本失敗:', e);
            }
          } else if (contentType.includes('image')) {
            // 如果響應本身就是圖片，直接下載
            console.log('[Gemini 分類助手] [原始圖追蹤] ✅ 響應為圖片，直接下載:', startUrl.substring(0, 200));
            
            stepRecord.isFinal = true;
            stepRecord.isImage = true;
            
            await triggerAutoDownload(startUrl, `track_${Date.now()}`, null, 'highres', 'trackImageUrlRedirectChain');
            
            // 清理追蹤標記
            trackingUrls.delete(urlKey);
            
            return { success: true, finalUrl: startUrl, chain: redirectChain, isImage: true };
          }
        }
        
        // 如果沒有找到下一個 URL，返回當前結果
        console.log('[Gemini 分類助手] [原始圖追蹤] ⚠️ 未找到下一個 URL，停止追蹤');
        
        // 清理追蹤標記
        trackingUrls.delete(urlKey);
        
        return { success: false, reason: 'no_next_url', chain: redirectChain };
        
      } catch (error) {
        console.error('[Gemini 分類助手] [原始圖追蹤] ❌ 追蹤失敗:', error);
        
        // 清理追蹤標記
        trackingUrls.delete(urlKey);
        
        recordClickMonitorEvent('TRACK_ERROR', {
          step: currentStep + 1,
          url: startUrl.substring(0, 500),
          error: error.message,
          redirectChain: redirectChain.length
        });
        
        return { success: false, reason: 'error', error: error.message, chain: redirectChain };
      }
    } catch (error) {
      console.error('[Gemini 分類助手] [原始圖追蹤] ❌ 追蹤過程發生錯誤:', error);
      
      // 清理追蹤標記
      const urlKey = startUrl ? startUrl.substring(0, 200) : '';
      if (urlKey) {
        trackingUrls.delete(urlKey);
      }
      
      return { success: false, reason: 'exception', error: error.message, chain: redirectChain };
    }
  }
  
  // 【優化】批量發送記錄
  function flushPendingRecords() {
    if (pendingRecords.length === 0) return;
    
    const recordsToSend = [...pendingRecords];
    pendingRecords = [];
    
    if (!isRuntimeValid()) return;
    
    // 批量發送到 background.js
    recordsToSend.forEach(record => {
      chrome.runtime.sendMessage({
        action: 'RECORD_CLICK_MONITOR',
        record: record
      }).catch(() => {
        // 靜默處理錯誤
      });
    });
    
    // 批量通知 sidepanel（只發送最後一條，避免過多更新）
    if (recordsToSend.length > 0) {
      const lastRecord = recordsToSend[recordsToSend.length - 1];
      chrome.runtime.sendMessage({
        action: 'CLICK_MONITOR_UPDATED',
        record: lastRecord,
        batchCount: recordsToSend.length
      }).catch(() => {
        // 靜默處理錯誤
      });
    }
  }
  
  // 【完整追蹤記錄系統】記錄按鈕的完整信息（用於後續分析優化）
  function recordDetailedButtonInfo(button, eventType = 'BUTTON_CLICKED') {
    try {
      if (!button || !button.nodeName) return null;
      
      // 提取按鈕的完整 DOM 結構信息
      const buttonInfo = {
        // 基本屬性
        tagName: button.tagName,
        id: button.id || null,
        className: button.className || '',
        classList: Array.from(button.classList || []),
        
        // 屬性
        attributes: {},
        dataAttributes: {},
        ariaAttributes: {},
        
        // 內容
        innerHTML: button.innerHTML.substring(0, 500), // 限制長度
        innerText: (button.innerText || button.textContent || '').substring(0, 200),
        outerHTML: button.outerHTML.substring(0, 1000), // 限制長度
        
        // 位置和尺寸
        boundingRect: button.getBoundingClientRect ? {
          x: Math.round(button.getBoundingClientRect().x),
          y: Math.round(button.getBoundingClientRect().y),
          width: Math.round(button.getBoundingClientRect().width),
          height: Math.round(button.getBoundingClientRect().height),
          top: Math.round(button.getBoundingClientRect().top),
          left: Math.round(button.getBoundingClientRect().left),
          right: Math.round(button.getBoundingClientRect().right),
          bottom: Math.round(button.getBoundingClientRect().bottom)
        } : null,
        
        // 樣式
        computedStyle: null, // 將在需要時提取
        
        // 父元素信息
        parentElement: button.parentElement ? {
          tagName: button.parentElement.tagName,
          className: button.parentElement.className || '',
          id: button.parentElement.id || null
        } : null,
        
        // 兄弟元素
        siblings: {
          previous: button.previousElementSibling ? {
            tagName: button.previousElementSibling.tagName,
            className: button.previousElementSibling.className || ''
          } : null,
          next: button.nextElementSibling ? {
            tagName: button.nextElementSibling.tagName,
            className: button.nextElementSibling.className || ''
          } : null
        },
        
        // 子元素
        children: Array.from(button.children || []).slice(0, 5).map(child => ({
          tagName: child.tagName,
          className: child.className || '',
          innerText: (child.innerText || child.textContent || '').substring(0, 50)
        })),
        
        // 特殊屬性
        jslog: button.getAttribute('jslog') || null,
        dataTestId: button.getAttribute('data-test-id') || null,
        ariaLabel: button.getAttribute('aria-label') || null,
        role: button.getAttribute('role') || null,
        disabled: button.disabled || false,
        hidden: button.hidden || false,
        
        // 事件相關
        hasClickHandler: !!(button.onclick || button.getAttribute('onclick')),
        eventListeners: null // 無法直接獲取，但可以標記
        
      };
      
      // 提取所有屬性
      if (button.attributes) {
        Array.from(button.attributes).forEach(attr => {
          if (attr.name.startsWith('data-')) {
            buttonInfo.dataAttributes[attr.name] = attr.value.substring(0, 500);
          } else if (attr.name.startsWith('aria-')) {
            buttonInfo.ariaAttributes[attr.name] = attr.value.substring(0, 500);
          } else {
            buttonInfo.attributes[attr.name] = attr.value.substring(0, 500);
          }
        });
      }
      
      // 提取計算樣式（關鍵屬性）
      try {
        if (window.getComputedStyle) {
          const computed = window.getComputedStyle(button);
          buttonInfo.computedStyle = {
            display: computed.display,
            visibility: computed.visibility,
            opacity: computed.opacity,
            position: computed.position,
            zIndex: computed.zIndex,
            cursor: computed.cursor,
            pointerEvents: computed.pointerEvents,
            backgroundColor: computed.backgroundColor,
            color: computed.color,
            fontSize: computed.fontSize,
            fontWeight: computed.fontWeight,
            padding: computed.padding,
            margin: computed.margin,
            border: computed.border
          };
        }
      } catch (e) {
        // 忽略樣式提取錯誤
      }
      
      return buttonInfo;
    } catch (error) {
      console.error('[Gemini 分類助手] [追蹤記錄] 提取按鈕信息失敗:', error);
      return null;
    }
  }
  
  // 記錄監聽事件（優化版：批量發送 + 詳細記錄）
  function recordClickMonitorEvent(eventType, data) {
    try {
      if (!clickMonitorStarted && eventType !== 'FIRST_USER_CLICK') {
        return null;
      }
      // 【完整追蹤記錄】如果是按鈕點擊事件，記錄完整的按鈕信息
      let detailedButtonInfo = null;
      if ((eventType === 'BUTTON_CLICKED' || eventType === 'TEST_BUTTON_CLICKED') && data && data.button) {
        detailedButtonInfo = recordDetailedButtonInfo(data.button);
      }
      
      // 【優化】限制數據大小，避免過大的記錄
      const optimizedData = {};
      for (const [key, value] of Object.entries(data || {})) {
        // 跳過 button 對象（已經提取為 detailedButtonInfo）
        if (key === 'button' && value && value.nodeName) {
          continue;
        }
        
        if (typeof value === 'string' && value.length > 1000) {
          optimizedData[key] = value.substring(0, 1000) + '...';
        } else if (typeof value === 'object' && value !== null) {
          // 限制嵌套對象的深度
          try {
            const jsonStr = JSON.stringify(value);
            optimizedData[key] = jsonStr.length > 1000 ? JSON.parse(jsonStr.substring(0, 1000) + '...') : value;
          } catch {
            optimizedData[key] = '[Object]';
          }
        } else {
          optimizedData[key] = value;
        }
      }
      
      // 如果有詳細按鈕信息，添加到數據中
      if (detailedButtonInfo) {
        optimizedData.detailedButtonInfo = detailedButtonInfo;
      }
      
      const record = {
        id: `monitor_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        timestamp: Date.now(),
        timestampDisplay: new Date().toLocaleTimeString('zh-TW', {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          fractionalSecondDigits: 3
        }),
        eventType: eventType,
        data: optimizedData,
        chatId: currentChatId,
        userProfile: currentUserProfile || 'default',
        url: window.location.href.substring(0, 200), // 限制 URL 長度
        pageTitle: document.title.substring(0, 200),
        userAgent: navigator.userAgent.substring(0, 200),
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight
        },
        firstUserClickAt: firstUserClickAt
      };
      
      clickMonitorRecords.push(record);
      
      // 限制記錄數量
      if (clickMonitorRecords.length > MAX_MONITOR_RECORDS) {
        clickMonitorRecords.shift();
      }
      
      // 【優化】添加到待發送隊列，使用防抖批量發送
      pendingRecords.push(record);
      
      // 清除舊的定時器
      if (recordBatchTimer) {
        clearTimeout(recordBatchTimer);
      }
      
      // 設置新的定時器（防抖）
      recordBatchTimer = setTimeout(() => {
        flushPendingRecords();
        recordBatchTimer = null;
      }, RECORD_BATCH_INTERVAL);
      
      // 如果待發送記錄過多，立即發送（防止內存積累）
      if (pendingRecords.length >= 20) {
        flushPendingRecords();
        if (recordBatchTimer) {
          clearTimeout(recordBatchTimer);
          recordBatchTimer = null;
        }
      }
      return record;
    } catch (error) {
      console.error('[Gemini 分類助手] [監聽記錄] 記錄失敗:', error);
      return null;
    }
  }

  // 【監聽記錄】從第一次滑鼠點擊開始記錄
  function setupFirstClickRecorder() {
    if (window._geminiFirstClickRecorderSetup) return;
    window._geminiFirstClickRecorderSetup = true;

    document.addEventListener('click', (e) => {
      if (!e.isTrusted) return;
      // 每次點擊都刷新監聽窗口，避免延遲請求漏掉
      startGlobalDownloadMonitor();

      if (!clickMonitorStarted) {
        clickMonitorStarted = true;
        firstUserClickAt = Date.now();

        recordClickMonitorEvent('FIRST_USER_CLICK', {
          clickTimestamp: firstUserClickAt,
          clickCoordinates: e.clientX && e.clientY ? {
            x: e.clientX,
            y: e.clientY,
            pageX: e.pageX,
            pageY: e.pageY
          } : null,
          target: {
            tagName: e.target?.tagName || null,
            id: e.target?.id || null,
            className: e.target?.className || null
          }
        });
      }

      // 針對圖像動作圖示（<>）建立按鈕攔截器
      try {
        const iconEl = e.target?.closest?.('mat-icon, .mat-icon, .google-symbols, [class*="mat-icon"]');
        const iconText = (iconEl?.textContent || '').trim();
        const ariaLabel = iconEl?.getAttribute('aria-label') || iconEl?.parentElement?.getAttribute('aria-label') || '';
        const title = iconEl?.getAttribute('title') || iconEl?.parentElement?.getAttribute('title') || '';
        const labelText = `${iconText} ${ariaLabel} ${title}`.toLowerCase();

        const isImageActionIcon =
          labelText.includes('<>') ||
          labelText.includes('open') ||
          labelText.includes('open_in_new') ||
          labelText.includes('download') ||
          labelText.includes('original') ||
          labelText.includes('新分頁') ||
          labelText.includes('原始') ||
          labelText.includes('下載') ||
          iconEl?.className?.toString().includes('google-symbols');

        if (isImageActionIcon) {
          const clickable = e.target?.closest?.('button, a, [role="button"], [role="menuitem"]');
          if (clickable) {
            setupButtonClickInterceptor(clickable);
            recordClickMonitorEvent('IMAGE_ACTION_ICON_CLICKED', {
              iconText: iconText,
              ariaLabel: ariaLabel,
              title: title,
              targetTag: clickable.tagName,
              targetClass: clickable.className || ''
            });
          }
        }
      } catch (error) {
        console.warn('[Gemini 分類助手] [監聽記錄] 處理圖示點擊失敗:', error);
      }
    }, true);
  }

  // 【追蹤記錄】更新既有記錄（同一條 DOWNLOAD_STARTED）
  function updateClickMonitorRecord(recordId, patchData) {
    if (!recordId || !patchData) return;

    try {
      const idx = clickMonitorRecords.findIndex(r => r.id === recordId);
      if (idx >= 0) {
        const existing = clickMonitorRecords[idx];
        const mergedData = {
          ...(existing.data || {}),
          ...(patchData.data || patchData || {})
        };
        clickMonitorRecords[idx] = {
          ...existing,
          data: mergedData,
          updatedAt: Date.now()
        };
      }
    } catch (e) {
      console.warn('[Gemini 分類助手] [監聽記錄] 更新本地記錄失敗:', e);
    }

    if (isRuntimeValid()) {
      chrome.runtime.sendMessage({
        action: 'UPDATE_CLICK_MONITOR_RECORD',
        recordId,
        userProfile: currentUserProfile || 'default',
        patch: patchData
      }).catch(() => {});
    }
  }

  function setupButtonClickInterceptor(button) {
    // 避免重複設置
    if (button.dataset.interceptorSetup === 'true') {
      return;
    }
    button.dataset.interceptorSetup = 'true';
    
    // 為每個按鈕創建獨立的攔截器狀態
      if (!button._interceptors) {
        button._interceptors = {
          cleanupTimer: null,
          downloadLinkFound: false,
          monitorObserver: null, // 用於監聽 DOM 變化
          networkRequests: [], // 記錄網絡請求
          domChanges: [] // 記錄 DOM 變化
        };
      }
    const buttonInterceptors = button._interceptors;
    
    // 監控按鈕點擊（使用事件管理器）
    const clickHandler = (e) => {
      const clickTimestamp = Date.now();

      // 如果尚未啟動記錄，從這次點擊開始
      if (!clickMonitorStarted) {
        clickMonitorStarted = true;
        firstUserClickAt = clickTimestamp;
        recordClickMonitorEvent('FIRST_USER_CLICK', {
          clickTimestamp: clickTimestamp,
          source: 'download_button_click',
          clickCoordinates: e.clientX && e.clientY ? {
            x: e.clientX,
            y: e.clientY,
            pageX: e.pageX,
            pageY: e.pageY
          } : null,
          target: {
            tagName: button.tagName,
            id: button.id || null,
            className: button.className || null
          }
        });
      }
      
      // URL 重定向追蹤（每次點擊都重新初始化）
      const urlRedirectChain = [];
      
      // 記錄按鈕點擊
      logOperation('BUTTON_CLICKED', {
        buttonJslog: button.getAttribute('jslog')?.substring(0, 500) || '',
        ariaLabel: button.getAttribute('aria-label') || '',
        dataTestId: button.getAttribute('data-test-id') || ''
      });
      
      // 【監聽記錄】記錄按鈕點擊事件（包含完整的按鈕信息）
      recordClickMonitorEvent('BUTTON_CLICKED', {
        button: button, // 傳遞按鈕對象，用於提取詳細信息
        buttonJslog: button.getAttribute('jslog')?.substring(0, 500) || '',
        ariaLabel: button.getAttribute('aria-label') || '',
        dataTestId: button.getAttribute('data-test-id') || '',
        buttonHtml: button.outerHTML.substring(0, 300),
        isUserClick: e.isTrusted === true, // 判斷是否為用戶真實點擊
        clickCoordinates: e.clientX && e.clientY ? {
          x: e.clientX,
          y: e.clientY,
          pageX: e.pageX,
          pageY: e.pageY
        } : null,
        clickTimestamp: clickTimestamp
      });
      
      // 記錄按鈕初始狀態（包含完整按鈕信息）
      const initialButtonState = {
        className: button.className || '',
        ariaLabel: button.getAttribute('aria-label') || '',
        innerHTML: button.innerHTML.substring(0, 200),
        disabled: button.disabled,
        hasSpinner: !!button.querySelector('mat-spinner, [class*="spinner"], [class*="loading"]')
      };
      
      // 【完整追蹤記錄】記錄按鈕的完整信息
      const detailedButtonInfo = recordDetailedButtonInfo(button);
      
      recordClickMonitorEvent('BUTTON_STATE_INITIAL', {
        buttonState: initialButtonState,
        detailedButtonInfo: detailedButtonInfo
      });
      
      // 清理之前的攔截器和定時器（如果存在）
      if (buttonInterceptors.cleanupTimer) {
        timerManager.clear(`button_cleanup_${button._eventManagerKey}`);
        buttonInterceptors.cleanupTimer = null;
      }
      
      // 重置下載連結找到標記
      buttonInterceptors.downloadLinkFound = false;
      
      // 將按鈕添加到活躍按鈕集合
      window._geminiInterceptors.activeButtons.add(button);
      
      // 清理函數：當找到連結時立即清理
      const cleanupOnLinkFound = () => {
        buttonInterceptors.downloadLinkFound = true;
        // 從活躍按鈕集合中移除
        window._geminiInterceptors.activeButtons.delete(button);
      };
      
      // 提取菜單中的下載連結的函數（強化選單掃描邏輯，捕捉「所有」可疑元素）
      const extractLinksFromMenu = (menu) => {
        if (buttonInterceptors.downloadLinkFound) return true;
        
        // 【處理「直接下載」狀態】如果偵測到選單文字包含「正在下載原尺寸圖片」，這代表下載已由系統觸發
        const menuText = menu.innerText || menu.textContent || '';
        if (menuText.includes('正在下載原尺寸圖片') || menuText.includes('下載中') || menuText.includes('Downloading')) {
          cleanupOnLinkFound();
          buttonInterceptors.downloadLinkFound = true;
          return true;
        }

        return false;
      };
      
      // 【監聽記錄】設置 DOM 變化監聽器（監聽按鈕及其父元素的變化）
      if (buttonInterceptors.monitorObserver) {
        buttonInterceptors.monitorObserver.disconnect();
      }
      
      buttonInterceptors.monitorObserver = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
          // 記錄 DOM 變化
          const changeData = {
            type: mutation.type,
            target: mutation.target.tagName || 'unknown',
            targetClass: mutation.target.className || '',
            attributeName: mutation.attributeName || null,
            oldValue: mutation.oldValue || null,
            addedNodes: mutation.addedNodes.length,
            removedNodes: mutation.removedNodes.length
          };
          
          // 檢查按鈕狀態變化
          if (mutation.target === button || button.contains(mutation.target)) {
            const currentState = {
              className: button.className || '',
              ariaLabel: button.getAttribute('aria-label') || '',
              hasSpinner: !!button.querySelector('mat-spinner, [class*="spinner"], [class*="loading"]'),
              disabled: button.disabled
            };
            
            recordClickMonitorEvent('BUTTON_STATE_CHANGED', {
              change: changeData,
              currentState: currentState,
              timeSinceClick: Date.now() - clickTimestamp
            });
          }
          
          // 檢查是否有下載相關的文本出現
          if (mutation.addedNodes.length > 0) {
            mutation.addedNodes.forEach(node => {
              if (node.nodeType === 1) { // Element node
                const text = node.innerText || node.textContent || '';
                if (text.includes('下載') || text.includes('download') || 
                    text.includes('正在下載') || text.includes('Downloading')) {
                  recordClickMonitorEvent('DOWNLOAD_TEXT_DETECTED', {
                    text: text.substring(0, 200),
                    element: node.tagName,
                    className: node.className || ''
                  });
                }
              }
            });
          }
        });
      });
      
      // 監聽按鈕及其父元素的變化
      const parentContainer = button.closest('[role="img"], [class*="image"], [class*="generated"]') || button.parentElement;
      if (parentContainer) {
        buttonInterceptors.monitorObserver.observe(parentContainer, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['class', 'aria-label', 'disabled'],
          characterData: true
        });
      }
      
      // 【監聽記錄】監聽網絡請求（通過 fetch 和 XHR 攔截器）
      const originalFetch = window.fetch;
      const originalXHR = window.XMLHttpRequest;
      
      // 【優化】使用統一的 URL 檢查函數
      const isDownloadRelatedUrl = isDownloadUrl;
      
      // 記錄 fetch 請求
      const fetchWrapper = async (...args) => {
        const url = args[0]?.toString() || '';
        if (isDownloadRelatedUrl(url)) {
          const requestId = `fetch_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
          urlRedirectChain.push({
            id: requestId,
            step: urlRedirectChain.length + 1,
            url: url,
            type: 'REQUEST',
            timestamp: Date.now(),
            timeSinceClick: Date.now() - clickTimestamp
          });
          
          recordClickMonitorEvent('NETWORK_REQUEST_FETCH', {
            url: url.substring(0, 500),
            fullUrl: url, // 保留完整 URL 用於分析
            method: args[1]?.method || 'GET',
            headers: args[1]?.headers ? Object.keys(args[1].headers) : null, // 只記錄 header 鍵名
            step: urlRedirectChain.length,
            timeSinceClick: Date.now() - clickTimestamp,
            isGoogleusercontent: url.includes('googleusercontent.com'),
            isGoogleCom: url.includes('lh3.google.com/rd-gg'),
            isGgDl: url.includes('gg-dl'),
            isRdGgDl: url.includes('rd-gg-dl'),
            urlPattern: extractUrlPattern(url) // 提取 URL 模式用於分析
          });
          
          try {
            const response = await originalFetch.apply(this, args);
            
            // 檢查響應 URL（可能發生重定向）
            if (response && response.url) {
              const redirectUrl = response.url;
              recordClickMonitorEvent('NETWORK_RESPONSE_URL', {
                requestUrl: url.substring(0, 500),
                responseUrl: redirectUrl.substring(0, 500),
                step: urlRedirectChain.length,
                timeSinceClick: Date.now() - clickTimestamp
              });

              if (redirectUrl !== url) {
              urlRedirectChain.push({
                id: `redirect_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                step: urlRedirectChain.length + 1,
                url: redirectUrl,
                type: 'REDIRECT',
                fromUrl: url,
                timestamp: Date.now(),
                timeSinceClick: Date.now() - clickTimestamp
              });
              
              recordClickMonitorEvent('URL_REDIRECT', {
                fromUrl: url.substring(0, 500),
                toUrl: redirectUrl.substring(0, 500),
                step: urlRedirectChain.length,
                timeSinceClick: Date.now() - clickTimestamp,
                isGoogleusercontent: url.includes('googleusercontent.com'),
                isGoogleCom: redirectUrl.includes('lh3.google.com/rd-gg')
              });
              }
            }
            
            // 嘗試讀取響應內容（如果是文本，可能包含下一個 URL）
            if (response.ok && response.headers.get('content-type')?.includes('text')) {
              try {
                const text = await response.clone().text();
                
                // 查找可能的 URL（包含 rd-gg, rd-gg-dl, work.fife.usercontent 和 s0-d-I）
                const urlPatterns = [
                  /https?:\/\/[^\s"']*work\.fife\.usercontent\.google\.com[^\s"']*rd-gg-dl[^\s"']*s0-d-I[^\s"']*/,
                  /https?:\/\/[^\s"']*lh3\.google[^\s"']*rd-gg[^\s"']*s0-d-I[^\s"']*/,
                  /https?:\/\/[^\s"']*rd-gg-dl[^\s"']*s0-d-I[^\s"']*/,
                  /https?:\/\/[^\s"']*rd-gg[^\s"']*s0-d-I[^\s"']*/
                ];
                
                for (const pattern of urlPatterns) {
                  const urlMatch = text.match(pattern);
                  if (urlMatch && urlMatch[0] && urlMatch[0] !== url) {
                    const foundUrl = urlMatch[0];
                    urlRedirectChain.push({
                      id: `found_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                      step: urlRedirectChain.length + 1,
                      url: foundUrl,
                      type: 'FOUND_IN_RESPONSE',
                      fromUrl: url,
                      timestamp: Date.now(),
                      timeSinceClick: Date.now() - clickTimestamp
                    });
                    
                    recordClickMonitorEvent('URL_FOUND_IN_RESPONSE', {
                      fromUrl: url.substring(0, 500),
                      foundUrl: foundUrl.substring(0, 500),
                      step: urlRedirectChain.length,
                      timeSinceClick: Date.now() - clickTimestamp
                    });
                    
                    // 【完整追蹤模式】如果找到 URL，自動觸發完整追蹤
                    if (foundUrl.includes('rd-gg-dl') || foundUrl.includes('rd-gg')) {
                      console.log('[Gemini 分類助手] [原始圖追蹤] 🚀 自動觸發完整追蹤模式:', foundUrl.substring(0, 200));
                      trackImageUrlRedirectChain(foundUrl, 4).then(result => {
                        if (result.success) {
                          console.log('[Gemini 分類助手] [原始圖追蹤] ✅ 追蹤成功，已下載圖片');
                        } else {
                          console.log('[Gemini 分類助手] [原始圖追蹤] ⚠️ 追蹤未完成:', result.reason);
                        }
                      }).catch(err => {
                        console.error('[Gemini 分類助手] [原始圖追蹤] ❌ 追蹤失敗:', err);
                      });
                    }
                    
                    break; // 找到第一個匹配的 URL 就停止
                  }
                }
              } catch (e) {
                // 忽略讀取錯誤
              }
            }
            
            // 【完整追蹤模式】如果請求的 URL 包含 gg-dl，自動觸發完整追蹤
            if (url.includes('gg-dl') && response.ok) {
              console.log('[Gemini 分類助手] [原始圖追蹤] 🚀 檢測到 gg-dl URL，自動觸發完整追蹤模式');
              trackImageUrlRedirectChain(url, 4).then(result => {
                if (result.success) {
                  console.log('[Gemini 分類助手] [原始圖追蹤] ✅ 追蹤成功，已下載圖片');
                } else {
                  console.log('[Gemini 分類助手] [原始圖追蹤] ⚠️ 追蹤未完成:', result.reason);
                }
              }).catch(err => {
                console.error('[Gemini 分類助手] [原始圖追蹤] ❌ 追蹤失敗:', err);
              });
            }
            
            return response;
          } catch (error) {
            recordClickMonitorEvent('NETWORK_ERROR', {
              url: url.substring(0, 500),
              error: error.message,
              timeSinceClick: Date.now() - clickTimestamp
            });
            throw error;
          }
        }
        return originalFetch.apply(this, args);
      };
      
      // 記錄 XHR 請求
      const xhrWrapper = function() {
        const xhr = new originalXHR();
        const originalOpen = xhr.open;
        const originalSend = xhr.send;
        
        xhr.open = function(method, url, ...rest) {
          if (isDownloadRelatedUrl(url)) {
            const requestId = `xhr_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            urlRedirectChain.push({
              id: requestId,
              step: urlRedirectChain.length + 1,
              url: url,
              type: 'REQUEST',
              timestamp: Date.now(),
              timeSinceClick: Date.now() - clickTimestamp
            });
            
            recordClickMonitorEvent('NETWORK_REQUEST_XHR', {
              url: url.substring(0, 500),
              method: method,
              step: urlRedirectChain.length,
              timeSinceClick: Date.now() - clickTimestamp,
              isGoogleusercontent: url.includes('googleusercontent.com'),
              isGoogleCom: url.includes('lh3.google.com/rd-gg')
            });
            
            // 監聽 readyState 變化以捕獲響應
            const originalOnReadyStateChange = xhr.onreadystatechange;
            xhr.onreadystatechange = function() {
              if (xhr.readyState === 4) {
                // 檢查響應 URL（可能發生重定向）
                if (xhr.responseURL) {
                  const redirectUrl = xhr.responseURL;
                  recordClickMonitorEvent('NETWORK_RESPONSE_URL', {
                    requestUrl: url.substring(0, 500),
                    responseUrl: redirectUrl.substring(0, 500),
                    step: urlRedirectChain.length,
                    timeSinceClick: Date.now() - clickTimestamp
                  });

                  if (redirectUrl !== url) {
                  urlRedirectChain.push({
                    id: `redirect_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                    step: urlRedirectChain.length + 1,
                    url: redirectUrl,
                    type: 'REDIRECT',
                    fromUrl: url,
                    timestamp: Date.now(),
                    timeSinceClick: Date.now() - clickTimestamp
                  });
                  
                  recordClickMonitorEvent('URL_REDIRECT', {
                    fromUrl: url.substring(0, 500),
                    toUrl: redirectUrl.substring(0, 500),
                    step: urlRedirectChain.length,
                    timeSinceClick: Date.now() - clickTimestamp,
                    isGoogleusercontent: url.includes('googleusercontent.com'),
                    isGoogleCom: redirectUrl.includes('lh3.google.com/rd-gg')
                  });
                  }
                }
                
                // 嘗試從響應文本中提取 URL
                if (xhr.responseText && typeof xhr.responseText === 'string') {
                  const urlMatch = xhr.responseText.match(/https?:\/\/[^\s"']*lh3\.google[^\s"']*rd-gg[^\s"']*s0-d-I[^\s"']*/);
                  if (urlMatch && urlMatch[0] !== url) {
                    const foundUrl = urlMatch[0];
                    urlRedirectChain.push({
                      id: `found_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                      step: urlRedirectChain.length + 1,
                      url: foundUrl,
                      type: 'FOUND_IN_RESPONSE',
                      fromUrl: url,
                      timestamp: Date.now(),
                      timeSinceClick: Date.now() - clickTimestamp
                    });
                    
                    recordClickMonitorEvent('URL_FOUND_IN_RESPONSE', {
                      fromUrl: url.substring(0, 500),
                      foundUrl: foundUrl.substring(0, 500),
                      step: urlRedirectChain.length,
                      timeSinceClick: Date.now() - clickTimestamp
                    });
                  }
                }
              }
              
              if (originalOnReadyStateChange) {
                originalOnReadyStateChange.apply(this, arguments);
              }
            };
          }
          return originalOpen.apply(this, [method, url, ...rest]);
        };
        
        return xhr;
      };
      
      // 臨時替換（僅在監聽期間）
      window.fetch = fetchWrapper;
      window.XMLHttpRequest = xhrWrapper;
      
      // 8 秒後清理攔截器狀態（避免影響其他功能）
      buttonInterceptors.cleanupTimer = timerManager.setTimeout(
        `button_cleanup_${button._eventManagerKey}`,
        () => {
        // 恢復原始函數
        window.fetch = originalFetch;
        window.XMLHttpRequest = originalXHR;
        
        // 停止 DOM 監聽
        if (buttonInterceptors.monitorObserver) {
          buttonInterceptors.monitorObserver.disconnect();
          buttonInterceptors.monitorObserver = null;
        }
        
        // 記錄監聽結束（包含 URL 重定向鏈）
        recordClickMonitorEvent('MONITOR_ENDED', {
          duration: Date.now() - clickTimestamp,
          networkRequests: buttonInterceptors.networkRequests.length,
          domChanges: buttonInterceptors.domChanges.length,
          redirectChainLength: urlRedirectChain.length,
          // 【優化】只記錄 URL 的關鍵部分，不記錄完整鏈
          redirectChainSummary: urlRedirectChain.map(r => ({
            step: r.step,
            type: r.type,
            urlPreview: r.url.substring(0, 100)
          }))
        });
        
        // 【優化】確保待發送的記錄都被發送
        if (recordBatchTimer) {
          clearTimeout(recordBatchTimer);
          flushPendingRecords();
          recordBatchTimer = null;
        }
        
        // 從活躍按鈕集合中移除
        window._geminiInterceptors.activeButtons.delete(button);
        buttonInterceptors.cleanupTimer = null;
      }, 8000);
    };
    
    // 使用事件管理器添加監聽器（便於清理）
    eventManager.add(button, 'click', clickHandler, false);
    
    // 保存清理函數到按鈕對象
    button._cleanupClickHandler = () => {
      eventManager.remove(button, 'click', clickHandler);
    };
  }
  
  console.log('[Gemini 分類助手] Content Script 初始化完成');

})();

// 在 IIFE 外部立即暴露調試工具，確保全局可用
if (typeof window !== 'undefined') {
  // 立即定義，不等待
  window.geminiAssistantDebug = {
        // 分析頁面結構
        analyzePage: function() {
          console.log('=== Gemini 助手頁面結構分析 ===');
          console.log('URL:', window.location.href);
          
          // 嘗試從 URL 提取 chatId
          const urlMatch = window.location.href.match(/\/app\/([^/?#]+)/);
          const chatId = urlMatch ? urlMatch[1] : '(未找到)';
          console.log('ChatId (從 URL):', chatId);
          
          // 分析標題
          console.log('\n--- 標題分析 ---');
          console.log('document.title:', document.title);
          const h1s = document.querySelectorAll('h1');
          console.log('H1 數量:', h1s.length);
          h1s.forEach((h1, i) => {
            const text = (h1.innerText || h1.textContent || '').trim();
            if (text.length > 0) {
              console.log(`H1 #${i + 1}:`, text);
            }
          });
          
          // 分析包含 /app/ 的鏈接
          console.log('\n--- 對話鏈接分析 ---');
          const links = document.querySelectorAll('a[href*="/app/"]');
          console.log('包含 /app/ 的鏈接數量:', links.length);
          links.slice(0, 10).forEach((link, i) => {
            const text = (link.innerText || link.textContent || '').trim();
            if (text.length > 0) {
              console.log(`鏈接 #${i + 1}:`, {
                href: link.href,
                text: text.substring(0, 100),
                ariaLabel: link.getAttribute('aria-label') || '',
                className: link.className?.substring(0, 100) || ''
              });
            }
          });
          
          // 分析消息元素
          console.log('\n--- 消息元素分析 ---');
          const messageSelectors = [
            '[class*="user-query"]',
            '[class*="userQuery"]',
            '[class*="model-response"]',
            '[class*="modelResponse"]',
            '[role="article"]',
            '[class*="turn"]',
            '[class*="message"]',
            '[class*="Message"]',
            '[class*="chat"]',
            '[class*="Chat"]'
          ];
          
          messageSelectors.forEach(selector => {
            try {
              const elements = document.querySelectorAll(selector);
              if (elements.length > 0) {
                console.log(`${selector}: 找到 ${elements.length} 個元素`);
                elements.slice(0, 3).forEach((el, i) => {
                  const text = (el.innerText || el.textContent || '').trim();
                  if (text.length > 0) {
                    console.log(`  [${i + 1}] 文本預覽:`, text.substring(0, 100));
                    console.log(`      類名:`, el.className?.substring(0, 100) || '(無)');
                    console.log(`      data-role:`, el.getAttribute('data-role') || '(無)');
                  }
                });
              }
            } catch (e) {
              // 忽略選擇器錯誤
            }
          });
          
          // 分析所有包含文本的 div
          console.log('\n--- 包含文本的容器分析 (前 20 個) ---');
          const allDivs = document.querySelectorAll('div');
          const textDivs = Array.from(allDivs).filter(div => {
            const text = (div.innerText || div.textContent || '').trim();
            return text.length > 20 && text.length < 5000;
          });
          console.log(`找到 ${textDivs.length} 個包含文本的 div`);
          textDivs.slice(0, 20).forEach((div, i) => {
            const text = (div.innerText || div.textContent || '').trim();
            console.log(`容器 #${i + 1}:`, {
              className: div.className?.substring(0, 150) || '(無)',
              textPreview: text.substring(0, 150),
              dataRole: div.getAttribute('data-role') || '(無)',
              id: div.id || '(無)',
              tagName: div.tagName
            });
          });
        },
        
        // 獲取當前狀態
        getStatus: function() {
          const urlMatch = window.location.href.match(/\/app\/([^/?#]+)/);
          return {
            chatId: urlMatch ? urlMatch[1] : null,
            url: window.location.href,
            title: document.title
          };
        }
      };
      
  console.log('[Gemini 分類助手] 調試工具已載入（外部版本）');
  console.log('[Gemini 分類助手] 使用 window.geminiAssistantDebug.analyzePage() 分析頁面結構');
}
