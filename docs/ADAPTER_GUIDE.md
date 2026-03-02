# GAPI Site Adapter 開發指南

本文檔供 Agent 或開發者參考，說明如何為新的 AI 聊天網站撰寫 Adapter 並接入 GAPI 通用引擎。

---

## 架構總覽

```
manifest.json
  content_scripts.js 載入順序（關鍵！）:
    1. content-site-registry.js   ← 全局 Registry，掛在 window.__GAPI_SiteRegistry
    2. content-site-gemini.js     ← Gemini adapter，自我註冊
    3. content-site-claude.js     ← Claude adapter，自我註冊
    4. content-site-{name}.js     ← 你的新 adapter
    5. content.js                 ← 通用引擎，透過 Registry 取得當前 adapter
```

**引擎邏輯流程：**

```
頁面載入 → Registry 根據 hostname 偵測站點 → 選定 adapter
        → content.js 通用引擎透過 adapter 取得所有站點專用資訊
        → URL 解析、對話偵測、標題提取、圖片處理 全部委派給 adapter
```

Registry 的 `detectCurrentSite()` 用 `window.location.hostname` 比對每個 adapter 的 `hostPatterns` 陣列。第一個匹配的 adapter 成為 `currentAdapter`。

---

## 建立新 Adapter 的完整步驟

### Step 1: 建立檔案

建立 `content-site-{name}.js`，例如 `content-site-chatgpt.js`。

### Step 2: 撰寫 Adapter 物件

以下是完整的介面定義。**所有屬性都必須提供**，沒有功能的用 `null`/空陣列/`return null` 佔位。

```javascript
// ChatGPT Site Adapter
(function() {
  'use strict';

  const ChatGPTAdapter = {
    // ====================================================================
    // 1. 站點識別（必填）
    // ====================================================================
    name: 'chatgpt',                        // 唯一識別名稱
    label: 'OpenAI ChatGPT',                // 顯示用標籤
    hostPatterns: ['chatgpt.com', 'chat.openai.com'],  // hostname 匹配陣列

    // ====================================================================
    // 2. URL 工具（必填）
    // ====================================================================

    // 判斷 URL 是否屬於此站點
    isOnSite(url) {
      return (url || '').includes('chatgpt.com') || (url || '').includes('chat.openai.com');
    },

    // 從 URL 提取對話 ID（chatId）
    // ChatGPT URL: https://chatgpt.com/c/{uuid}
    getChatIdFromUrl(url) {
      try {
        if (!url) return null;
        const m = url.match(/\/c\/([a-f0-9-]+)/);
        return (m && m[1]) ? m[1] : null;
      } catch { return null; }
    },

    // 解析 URL 取得對話資訊
    parseConversationFromUrl(url) {
      if (!url || !this.isOnSite(url)) return null;
      const chatId = this.getChatIdFromUrl(url);
      const isChatPage = url.includes('/c/');
      return { chatId, isAppPage: isChatPage };
    },

    // ====================================================================
    // 3. URL 與對話偵測（必填）
    // ====================================================================

    // 對話頁面的 URL 路徑前綴（用於判斷是否在對話頁面）
    appPathPattern: '/c',

    // DOM 中可能存在的對話 ID data 屬性名稱（備選偵測）
    conversationIdAttributes: ['data-conversation-id'],

    // 從 DOM data 屬性提取 chatId（當 URL 中沒有時的備選方案）
    chatIdFromDOM() {
      for (const attr of this.conversationIdAttributes) {
        const el = document.querySelector(`[${attr}]`);
        if (el) return el.getAttribute(attr);
      }
      return null;
    },

    // 判斷頁面上是否已有對話訊息的 selector
    hasMessagesSelector: '[data-message-author-role]',

    // ====================================================================
    // 4. 用戶偵測（必填，可 return null）
    // ====================================================================

    detectUserProfile() {
      // 如果站點不需要多帳號區分，直接 return null
      return null;
    },

    // ====================================================================
    // 5. DOM Selector 陣列（必填）
    // ====================================================================

    // 用戶訊息元素 selector（由寬鬆到嚴格排列）
    userMessageSelectors: [
      '[data-message-author-role="user"]',
      '[class*="user-message"]'
    ],

    // AI 回覆元素 selector
    modelResponseSelectors: [
      '[data-message-author-role="assistant"]',
      '[class*="assistant-message"]'
    ],

    // 輸入框 selector
    inputSelectors: [
      '#prompt-textarea',
      'textarea[placeholder]',
      'div[contenteditable="true"]'
    ],

    // 發送按鈕 selector
    sendButtonSelectors: [
      'button[data-testid="send-button"]',
      'button[aria-label*="Send"]'
    ],

    // 簡易 scraper selector（GET_LAST_RESPONSE 快速操作用）
    scraperSelector: '[data-message-author-role="assistant"]',

    // 調試用 selector
    debugSelectors: [
      '[data-message-author-role="user"]',
      '[data-message-author-role="assistant"]',
      '[class*="message"]'
    ],

    // ====================================================================
    // 6. 標題提取（必填）
    // ====================================================================

    // 回傳 CSS selector 字串，用於在側邊欄中找到指定 chatId 的對話連結
    sidebarLinkSelector(chatId) {
      return `a[href*="/c/${chatId}"]`;
    },

    // 側邊欄中對話列表區域的 selector（用於縮小搜索範圍）
    sidebarContainerSelectors: [
      'nav a[href*="/c/"]'
    ],

    // 側邊欄中「當前選中」的對話項 selector（最準確的標題來源）
    selectedItemSelectors(chatId) {
      return [
        `a[href*="/c/${chatId}"][class*="active"]`,
        `a[href*="/c/${chatId}"][aria-current="page"]`
      ];
    },

    // 需排除的通用/站點品牌名稱標題（這些不是真正的對話標題）
    genericTitlePatterns: [
      'ChatGPT', 'New Chat', 'New chat', 'Chat'
    ],

    // 需排除的導航菜單文字（出現在側邊欄但不是對話標題）
    navigationTextPatterns: [
      'Explore GPTs', 'Settings', 'Upgrade', 'Help'
    ],

    // ====================================================================
    // 7. 圖片提取（必填，無圖片功能時用 null 佔位）
    // ====================================================================

    // 生成圖片容器的 CSS selector（null = 此站點無生成圖片功能）
    generatedImageSelector: null,

    // 判斷 DOM 元素是否為生成圖片
    isGeneratedImage(el) { return false; },

    // 從 DOM 元素提取圖片 ID
    extractImageId(el) { return null; },

    // 圖片下載按鈕的 selector 陣列
    imageDownloadSelectors: [],

    // ====================================================================
    // 8. 打字模擬配置（必填）
    // ====================================================================

    typingConfig: {
      nearbyKeys: {
        'a':'sq','b':'vn','c':'xv','d':'sf','e':'wr','f':'dg','g':'fh',
        'h':'gj','i':'uo','j':'hk','k':'jl','l':'k;','m':'n,','n':'bm',
        'o':'ip','p':'o[','q':'wa','r':'et','s':'ad','t':'ry','u':'yi',
        'v':'cb','w':'qe','x':'zc','y':'tu','z':'xa',
        '1':'2','2':'13','3':'24','4':'35','5':'46','6':'57','7':'68',
        '8':'79','9':'80','0':'9'
      },
      typoRate: 0.05,
      pauseAfterPunct: [300, 700],
      pauseAfterSpace: [80, 250],
      normalDelay: [40, 160],
      burstDelay: [20, 60]
    }
  };

  // 註冊到 SiteRegistry（固定格式，不要修改）
  if (window.__GAPI_SiteRegistry) {
    window.__GAPI_SiteRegistry.register('chatgpt', ChatGPTAdapter);
  } else {
    console.error('[ChatGPTAdapter] SiteRegistry not found!');
  }
})();
```

### Step 3: 註冊到 manifest.json

在 `manifest.json` 中新增兩處：

```jsonc
{
  "host_permissions": [
    // ... 既有的 ...
    "https://chatgpt.com/*",         // ← 新增
    "https://chat.openai.com/*"      // ← 新增
  ],
  "content_scripts": [{
    "matches": [
      // ... 既有的 ...
      "https://chatgpt.com/*",       // ← 新增
      "https://chat.openai.com/*"    // ← 新增
    ],
    "js": [
      "content-site-registry.js",
      "content-site-gemini.js",
      "content-site-claude.js",
      "content-site-chatgpt.js",     // ← 新增（在 content.js 之前）
      "content.js"
    ]
  }]
}
```

**關鍵：** adapter 檔案必須在 `content.js` **之前**載入。

---

## Adapter 介面速查表

| 類別 | 屬性/方法 | 型別 | 用途 |
|------|-----------|------|------|
| **站點識別** | `name` | `string` | 唯一 ID |
| | `label` | `string` | 顯示名稱 |
| | `hostPatterns` | `string[]` | hostname 匹配 |
| **URL 工具** | `isOnSite(url)` | `→ bool` | URL 是否屬於此站點 |
| | `getChatIdFromUrl(url)` | `→ string\|null` | 從 URL 提取對話 ID |
| | `parseConversationFromUrl(url)` | `→ {chatId, isAppPage}\|null` | 解析 URL |
| | `appPathPattern` | `string` | 對話頁面路徑前綴 |
| **對話偵測** | `conversationIdAttributes` | `string[]` | DOM data 屬性名稱 |
| | `chatIdFromDOM()` | `→ string\|null` | 從 DOM 提取 chatId |
| | `hasMessagesSelector` | `string` | 判斷頁面有無訊息 |
| **用戶偵測** | `detectUserProfile()` | `→ string\|null` | 偵測當前用戶 |
| **DOM Selector** | `userMessageSelectors` | `string[]` | 用戶訊息元素 |
| | `modelResponseSelectors` | `string[]` | AI 回覆元素 |
| | `inputSelectors` | `string[]` | 輸入框 |
| | `sendButtonSelectors` | `string[]` | 發送按鈕 |
| | `scraperSelector` | `string` | 快速 scraper |
| | `debugSelectors` | `string[]` | 調試用 |
| **標題提取** | `sidebarLinkSelector(chatId)` | `→ string` | 側欄中指定對話的連結 selector |
| | `sidebarContainerSelectors` | `string[]` | 側欄對話列表區域 |
| | `selectedItemSelectors(chatId)` | `→ string[]` | 當前選中項 selector |
| | `genericTitlePatterns` | `string[]` | 需排除的品牌/通用文字 |
| | `navigationTextPatterns` | `string[]` | 需排除的導航文字 |
| **圖片提取** | `generatedImageSelector` | `string\|null` | 生成圖片容器 selector |
| | `isGeneratedImage(el)` | `→ bool` | 元素是否為生成圖片 |
| | `extractImageId(el)` | `→ string\|null` | 從元素提取圖片 ID |
| | `imageDownloadSelectors` | `string[]` | 下載按鈕 selector |
| **打字模擬** | `typingConfig` | `object` | 人類打字模擬參數 |

---

## 引擎如何使用 Adapter

以下說明 `content.js` 通用引擎的呼叫模式，幫助你理解每個屬性的實際用途。

### URL 與對話偵測

```javascript
// content.js: checkURLAndExtractConversation()
const adapter = window.__GAPI_SiteRegistry.getCurrentAdapter();

// 1. 先從 URL 解析 chatId
let chatId = adapter.getChatIdFromUrl(window.location.href);

// 2. 如果 URL 中沒有，檢查是否在對話頁面
if (!chatId && url.includes(adapter.appPathPattern)) {
  // 3. 嘗試從 DOM 提取
  chatId = adapter.chatIdFromDOM();

  // 4. 最後檢查是否有訊息存在（用 hasMessagesSelector）
  if (!chatId) {
    const hasMessages = document.querySelectorAll(adapter.hasMessagesSelector).length > 0;
    if (hasMessages) chatId = 'temp_' + Date.now();
  }
}
```

### 標題提取

```javascript
// content.js: extractTitle()
// 策略 0.0: 先找側邊欄中的選中項
const selectors = adapter.selectedItemSelectors(currentChatId);
// 策略 0.1: 精確匹配 chatId 連結
const linkSelector = adapter.sidebarLinkSelector(currentChatId);
// 策略 0.2: 在對話列表區域查找
const containerSelectors = adapter.sidebarContainerSelectors;
// 排除判斷
const isGenericTitle = adapter.genericTitlePatterns.includes(text);
const isNavText = adapter.navigationTextPatterns.includes(text);
```

### 圖片提取

```javascript
// content.js: extractImages()
// 如果 adapter 沒有圖片功能，generatedImageSelector 為 null，跳過
if (adapter.generatedImageSelector) {
  const containers = element.querySelectorAll(adapter.generatedImageSelector);
  containers.forEach(container => {
    if (adapter.isGeneratedImage(container)) {
      const imageId = adapter.extractImageId(container);
      // ... 處理圖片 ...
    }
  });
}
```

---

## Selector 研究方法

研究新站點時的實作流程：

### 1. 開啟 DevTools 分析頁面結構

```javascript
// 在目標網站的 Console 中執行，快速找到可用 selector

// 找用戶訊息
document.querySelectorAll('[data-message-author-role="user"]')
document.querySelectorAll('[class*="user"]')

// 找 AI 回覆
document.querySelectorAll('[data-message-author-role="assistant"]')
document.querySelectorAll('[class*="assistant"]')

// 找輸入框
document.querySelectorAll('textarea')
document.querySelectorAll('[contenteditable="true"]')

// 找發送按鈕
document.querySelectorAll('button[type="submit"]')
document.querySelectorAll('button[aria-label*="Send"]')

// 找側邊欄對話列表
document.querySelectorAll('nav a')
```

### 2. 確認 URL 格式

```
Gemini:  https://gemini.google.com/app/{chatId}
Claude:  https://claude.ai/chat/{uuid}
ChatGPT: https://chatgpt.com/c/{uuid}
```

### 3. 確認哪些文字需要排除

在側邊欄中觀察：
- 站點品牌名（如 "ChatGPT"）→ 加入 `genericTitlePatterns`
- 導航按鈕文字（如 "Explore GPTs"）→ 加入 `navigationTextPatterns`

### 4. 確認圖片功能

- 如果站點支援圖片生成（如 DALL-E），找出圖片容器的識別方式
- 如果不支援，設為 `null` / `return false` / `return null`

---

## 驗證清單

完成 adapter 後，執行以下驗證：

```bash
# 1. 語法檢查
node -c content-site-{name}.js

# 2. 確認 adapter 不引用其他站點的 selector
grep -c 'gemini.google.com' content-site-{name}.js   # 應為 0
grep -c '/app/' content-site-{name}.js                # 應為 0（除非此站也用 /app/）
grep -c 'BardVeMetadataKey' content-site-{name}.js    # 應為 0（除非此站也用此屬性）

# 3. 確認 content.js 沒有新增硬編碼
grep -c '/app/' content.js                            # 應維持 0
grep -c 'BardVeMetadataKey' content.js                # 應維持 0
```

---

## 現有 Adapter 參考

| Adapter | 檔案 | 狀態 | 特殊功能 |
|---------|------|------|----------|
| Gemini | `content-site-gemini.js` | 完整實作 | 多帳號偵測、圖片生成提取 |
| Claude | `content-site-claude.js` | 佔位架構 | selector 待驗證 |

---

## 常見陷阱

1. **載入順序**：adapter 必須在 `content.js` 之前載入，否則 Registry 中找不到
2. **`sidebarLinkSelector('')`**：引擎會傳入空字串來取得「所有對話連結」的 selector，你的實作要能處理（如 `a[href*="/c/"]` 匹配所有對話）
3. **`null` 安全**：圖片相關屬性允許為 `null`，引擎會跳過；但其他屬性不可為 `null`
4. **`hostPatterns` 精確性**：不要用太寬鬆的 pattern（如 `'google'`），會誤匹配其他 Google 服務
5. **IIFE 包裝**：整個 adapter 必須用 `(function(){ ... })();` 包裝，避免污染全局作用域
6. **`this` 引用**：adapter 內的方法若需引用自身屬性，使用 `this.xxx`（如 `this.conversationIdAttributes`）
