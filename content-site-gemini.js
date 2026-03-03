// Gemini Site Adapter
// 從 content.js 提取的 Gemini 專用 selector 和站點工具函式

(function() {
  'use strict';

  const GeminiAdapter = {
    name: 'gemini',
    label: 'Google Gemini',
    hostPatterns: ['gemini.google.com'],

    // ========== URL 工具 ==========

    isOnSite(url) {
      return (url || '').includes('gemini.google.com');
    },

    getChatIdFromUrl(url) {
      try {
        if (!url) return null;
        const m = url.match(/\/app\/([^/?#]+)/);
        return (m && m[1]) ? m[1] : null;
      } catch {
        return null;
      }
    },

    parseConversationFromUrl(url) {
      if (!url || !this.isOnSite(url)) return null;
      const chatId = this.getChatIdFromUrl(url);
      const isAppPage = url.includes('/app');
      return { chatId, isAppPage };
    },

    // ========== 用戶偵測 ==========

    detectUserProfile() {
      try {
        // 策略 0: 從 URL 判斷 Google 帳號索引
        try {
          const pathname = window.location.pathname || '';
          const href = window.location.href || '';
          const uMatch = pathname.match(/\/u\/(\d+)\//);
          if (uMatch && uMatch[1] !== undefined) {
            return `u${uMatch[1]}`;
          }
          const authMatch = href.match(/[?&]authuser=(\d+)/);
          if (authMatch && authMatch[1] !== undefined) {
            return `u${authMatch[1]}`;
          }
        } catch (e) {
          // 忽略 URL 解析失敗
        }

        // 策略 1: 從頁面元素中獲取用戶信息
        const userSelectors = [
          '[aria-label*="Google Account"]',
          '[aria-label*="Google 帳戶"]',
          '[aria-label*="Google 帳號"]',
          'a[href*="myaccount.google.com"]',
          'img[alt*="@"]',
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

            const emailMatch = (alt + ' ' + ariaLabel).match(/([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9_-]+)/);
            if (emailMatch && emailMatch[1]) {
              return emailMatch[1].split('@')[0].replace(/[^a-zA-Z0-9]/g, '_');
            }

            if (href) {
              const authMatch = href.match(/[?&]authuser=(\d+)/);
              if (authMatch && authMatch[1] !== undefined) {
                return `u${authMatch[1]}`;
              }
            }

            if (src.includes('googleusercontent.com')) {
              const userIdMatch = src.match(/\/a\/([^\/]+)/);
              if (userIdMatch && userIdMatch[1]) {
                return userIdMatch[1].substring(0, 20);
              }
            }
          }
        }

        // 策略 2: 從 localStorage 獲取
        try {
          for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && (key.includes('user') || key.includes('account') || key.includes('email'))) {
              const value = localStorage.getItem(key);
              if (value) {
                try {
                  const parsed = JSON.parse(value);
                  if (parsed.email) {
                    return parsed.email.split('@')[0].replace(/[^a-zA-Z0-9]/g, '_');
                  }
                } catch (e) {
                  const emailMatch = value.match(/([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9_-]+)/);
                  if (emailMatch && emailMatch[1]) {
                    return emailMatch[1].split('@')[0].replace(/[^a-zA-Z0-9]/g, '_');
                  }
                }
              }
            }
          }
        } catch (e) {
          // 無法訪問 localStorage
        }

        return null; // 未檢測到，交給呼叫端用 'default'
      } catch (error) {
        console.error('[GeminiAdapter] detectUserProfile error:', error);
        return null;
      }
    },

    // ========== DOM Selector 陣列 ==========

    userMessageSelectors: [
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
      '[class*="turn"]:has([class*="user"]),',
      '[class*="turn"]:has([data-role="user"])',
      '[class*="message-container"]:has([class*="user"])',
      '[class*="chat-message"]:has([class*="user"])',
      'div[class*="message"]:not([class*="model"]):not([class*="assistant"]):not([class*="system"])'
    ],

    modelResponseSelectors: [
      'message-content',
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
      '[class*="turn"]:has([class*="model"]),',
      '[class*="turn"]:has([class*="assistant"])',
      '[class*="turn"]:has([data-role="model"])',
      '[class*="turn"]:has([data-role="assistant"])',
      '[class*="message-container"]:has([class*="model"])',
      '[class*="message-container"]:has([class*="assistant"])',
      '[class*="chat-message"]:has([class*="model"])',
      '[class*="chat-message"]:has([class*="assistant"])'
    ],

    inputSelectors: [
      'div[contenteditable="true"][role="textbox"]',
      '[contenteditable="true"][role="textbox"]',
      'div[contenteditable="true"]',
      '[class*="rich-textarea"]',
      '[class*="richTextarea"]',
      '[class*="RichTextarea"]',
      'textarea[placeholder*="Message"]',
      'textarea[placeholder*="輸入"]',
      'textarea[placeholder*="message"]',
      'textarea[aria-label*="Message"]',
      'textarea[aria-label*="輸入"]',
      'textarea'
    ],

    sendButtonSelectors: [
      'button[aria-label*="Send message"]',
      'button[aria-label*="傳送訊息"]',
      'button[aria-label*="Send"]',
      'button[aria-label*="發送"]',
      'button[aria-label*="傳送"]',
      'button[aria-label*="send"]',
      'button[type="submit"]',
      'div[role="button"][aria-label*="Send"]',
      'div[role="button"][aria-label*="傳送"]',
      'div[role="button"][aria-label*="發送"]'
    ],

    // 簡易 scraper selector（用於 GET_LAST_RESPONSE 等快速操作）
    scraperSelector: 'message-content, .message-content',

    // ========== Debug Selector ==========
    debugSelectors: [
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
    ],

    // ========== 打字模擬配置 ==========
    typingConfig: {
      nearbyKeys: {
        'a':'sq','b':'vn','c':'xv','d':'sf','e':'wr','f':'dg','g':'fh',
        'h':'gj','i':'uo','j':'hk','k':'jl','l':'k;','m':'n,','n':'bm',
        'o':'ip','p':'o[','q':'wa','r':'et','s':'ad','t':'ry','u':'yi',
        'v':'cb','w':'qe','x':'zc','y':'tu','z':'xa',
        '1':'2','2':'13','3':'24','4':'35','5':'46','6':'57','7':'68','8':'79','9':'80','0':'9'
      },
      typoRate: 0.05,
      pauseAfterPunct: [300, 700],
      pauseAfterSpace: [80, 250],
      normalDelay: [40, 160],
      burstDelay: [20, 60]
    },

    // ========== URL 與對話偵測（P3.5） ==========

    conversationIdAttributes: ['data-conversation-id', 'data-chat-id', 'data-chatid'],
    hasMessagesSelector: '[class*="message"], [class*="user-query"], [class*="model-response"]',
    appPathPattern: '/app',

    chatIdFromDOM() {
      for (const attr of this.conversationIdAttributes) {
        const el = document.querySelector(`[${attr}]`);
        if (el) { return el.getAttribute(attr); }
      }
      return null;
    },

    // ========== 標題提取（P3.5） ==========

    sidebarLinkSelector(chatId) {
      return `a[href*="/app/${chatId}"]`;
    },

    sidebarContainerSelectors: [
      '[class*="conversation-list"] a[href*="/app/"]',
      '[class*="chat-list"] a[href*="/app/"]',
      '[class*="thread-list"] a[href*="/app/"]',
      '[role="list"] a[href*="/app/"]',
      'ul[class*="conversation"] a[href*="/app/"]',
      'div[class*="conversation"] a[href*="/app/"]'
    ],

    selectedItemSelectors(chatId) {
      const p = `/app/${chatId}`;
      return [
        `a[href*="${p}"][aria-current="page"]`,
        `[aria-selected="true"] a[href*="${p}"]`,
        `[aria-current="page"] a[href*="${p}"]`,
        `[class*="selected"] a[href*="${p}"]`,
        `[class*="active"] a[href*="${p}"]`
      ];
    },

    genericTitlePatterns: [
      'Gemini', 'Chat', 'Conversation', 'New Chat', 'Google',
      '新的對話', '和 Gemini 的對話', '對話', 'Google Gemini',
      'New Conversation', '開始對話', 'Start Chat', '新的', 'New',
      '收合選單', '幽默一點', '幽默', '一點'
    ],

    navigationTextPatterns: [
      '我的內容', '我的', '內容', 'Gem', '程式夥伴',
      'Menu', 'Settings', '設定', '選單', '導航', 'Navigation',
      '對話列表', 'Conversation List', '收合選單'
    ],

    // ========== 圖片提取（P3.5） ==========

    generatedImageSelector: '[jslog*="BardVeMetadataKey"]',

    isGeneratedImage(el) {
      const jslog = el.getAttribute('jslog') || '';
      return jslog.includes('BardVeMetadataKey');
    },

    extractImageId(el) {
      const jslog = el.getAttribute('jslog') || '';
      const m = jslog.match(/BardVeMetadataKey:\[\["([^"]+)"/);
      return m ? m[1] : null;
    },

    imageDownloadSelectors: [
      'button[jslog*="BardVeMetadataKey"]',
      'button.image-button[jslog*="BardVeMetadataKey"]'
    ]
  };

  // 註冊到 SiteRegistry
  if (window.__GAPI_SiteRegistry) {
    window.__GAPI_SiteRegistry.register('gemini', GeminiAdapter);
  } else {
    console.error('[GeminiAdapter] SiteRegistry not found! Ensure content-site-registry.js loads first.');
  }
})();
