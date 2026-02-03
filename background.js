// Background Service Worker
// 處理 Side Panel 的開啟邏輯和擴充功能的核心功能

// 本地資料庫（IndexedDB）
// - 用於保存大量對話訊息，避免 chrome.storage.local 配額與大物件讀寫成本
importScripts('db.js');

// R2 儲存客戶端
// - 用於將對話紀錄上傳到 Cloudflare R2 並從 R2 查詢
importScripts('r2.js');

// ========== Admin Web Realtime Push (externally_connectable) ==========
// Keep service worker alive while admin page is open via Port.
const adminPorts = new Set();

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

chrome.runtime.onInstalled.addListener(async () => {
  console.log('Gemini 對話分類助手已安裝');
  
  // 設置 Side Panel 為在 Gemini 網頁上自動啟用
  await chrome.sidePanel.setOptions({
    path: 'sidepanel.html',
    enabled: true
  });
  
  // 初始化專案存儲（如果不存在）
  chrome.storage.local.get(['interceptedImages', 'projects'], (result) => {
    if (!result.interceptedImages) {
      chrome.storage.local.set({ interceptedImages: [] });
    }
    if (!result.projects) {
      chrome.storage.local.set({
        projects: {
          eell: { name: 'EELL', images: [] },
          badmintonComic: { name: '羽球漫畫', images: [] }
        }
      });
    }
  });
});

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

// 當標籤頁更新時，檢查是否為 Gemini 網頁
chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  // 只有在 URL 改變時才檢查（避免過度觸發）
  if (info.url || info.status === 'complete') {
    await manageSidePanelForTab(tabId, tab);
  }
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
  // 嘗試發送給所有 Gemini 標籤頁
  chrome.tabs.query({ url: 'https://gemini.google.com/*' }, (tabs) => {
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
      
      // 檢查是否已有 Gemini 標籤頁開啟
      const tabs = await chrome.tabs.query({ url: 'https://gemini.google.com/*' });
      
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
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
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

    chrome.tabs.query({ url: '*://gemini.google.com/*' }, (tabs) => {
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
    const m = url.match(/\/app\/([^/?#]+)/);
    if (m && m[1]) return m[1];
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

async function findGeminiTabForProfile(userProfile) {
  const tabs = await chrome.tabs.query({ url: 'https://gemini.google.com/*' });
  if (!tabs || tabs.length === 0) return null;
  const wanted = userProfile || 'default';
  for (const t of tabs) {
    const p = parseUserProfileFromUrl(t.url || '') || 'default';
    if (p === wanted) return t;
  }
  // fallback: any gemini tab
  return tabs[0] || null;
}

async function findGeminiTabForProfileAndChat(userProfile, chatId) {
  const tabs = await chrome.tabs.query({ url: 'https://gemini.google.com/*' });
  if (!tabs || tabs.length === 0) return null;

  const wantedProfile = userProfile || 'default';
  const wantedChatId = String(chatId || '');

  // 1) exact match: same profile + same chatId by URL
  for (const t of tabs) {
    const p = parseUserProfileFromUrl(t.url || '') || 'default';
    const c = parseChatIdFromUrl(t.url || '');
    if (p === wantedProfile && c === wantedChatId) return t;
  }

  // 2) exact match by ping (more reliable if URL changes)
  for (const t of tabs) {
    const p = parseUserProfileFromUrl(t.url || '') || 'default';
    if (p !== wantedProfile) continue;
    const resp = await pingGeminiTab(t.id);
    if (resp && resp.status === 'ok' && String(resp.chatId || '') === wantedChatId) return t;
  }

  // 3) fallback: any same profile
  for (const t of tabs) {
    const p = parseUserProfileFromUrl(t.url || '') || 'default';
    if (p === wantedProfile) return t;
  }

  return tabs[0] || null;
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
      const tabs = await chrome.tabs.query({ url: 'https://gemini.google.com/*' });
      const out = [];
      for (const t of tabs || []) {
        const url = t.url || '';
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

    // 找到 Gemini 標籤頁並發送消息
    const tabs = await chrome.tabs.query({ url: 'https://gemini.google.com/*' });
    
    if (tabs.length === 0) {
      sendResponse({ success: false, error: '找不到 Gemini 標籤頁，請先打開 Gemini 頁面' });
      return;
    }

    // 使用第一個 Gemini 標籤頁
    const geminiTab = tabs[0];
    
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
        
        sendResponse({ 
          success: true, 
          sessionId: sessionId,
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
    
    remoteSessions.set(sessionId, {
      messages: [],
      images: [],
      createdAt: Date.now()
    });

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
      sessionId: sessionId
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
          // 只獲取發送時間之後的新消息（助手回復）
          const newMessages = response.messages.filter(msg => 
            (msg.role === 'model' || msg.role === 'assistant') &&
            msg.timestamp > sendTimestamp
          );
          
          if (newMessages.length > 0) {
            // 記錄新消息到會話
            newMessages.forEach(msg => {
              const exists = session.messages.some(m => 
                m.role === 'assistant' && m.text === msg.text
              );
              
              if (!exists) {
                session.messages.push({
                  role: 'assistant',
                  text: msg.text || '',
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
      badmintonComic: { name: '羽球漫畫', images: [] }
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
