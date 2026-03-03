// Nebula Site Adapter
// Selectors for nebula.gg AI agent chat platform.
// Nebula uses React with Tailwind CSS. Key patterns:
//   - Messages: .user-message-block / .nebula-message-block
//   - Input: contenteditable div with role="textbox" and data-placeholder
//   - Sidebar: channel list with /chat/channel/ links

(function() {
  'use strict';

  const NebulaAdapter = {
    name: 'nebula',
    label: 'Nebula',
    hostPatterns: ['www.nebula.gg', 'nebula.gg'],

    // ========== URL 工具 ==========

    isOnSite(url) {
      return (url || '').includes('nebula.gg');
    },

    getChatIdFromUrl(url) {
      try {
        if (!url) return null;
        // Nebula URL: https://www.nebula.gg/chat/channel/thrd_xxx
        const m = url.match(/\/chat\/channel\/([^/?#]+)/);
        return (m && m[1]) ? m[1] : null;
      } catch {
        return null;
      }
    },

    parseConversationFromUrl(url) {
      if (!url || !this.isOnSite(url)) return null;
      const chatId = this.getChatIdFromUrl(url);
      const isChatPage = url.includes('/chat');
      return { chatId, isAppPage: isChatPage };
    },

    // ========== 用戶偵測 ==========

    detectUserProfile() {
      // Nebula shows username in message blocks
      try {
        const userBlock = document.querySelector('.user-message-block');
        if (userBlock) {
          const nameEl = userBlock.querySelector('[class*="username"], [class*="name"]');
          if (nameEl) return nameEl.textContent.trim();
        }
      } catch {}
      return null;
    },

    // ========== DOM Selector 陣列 ==========

    // User message containers
    userMessageSelectors: [
      '.user-message-block',
      '[class*="user-message"]',
      '[class*="human-message"]',
      '[data-role="user"]'
    ],

    // AI response containers
    modelResponseSelectors: [
      '.nebula-message-block',
      '[class*="nebula-message"]',
      '[class*="bot-message"]',
      '[class*="assistant-message"]',
      '[data-role="assistant"]'
    ],

    // Input selectors
    inputSelectors: [
      'div[contenteditable="true"][role="textbox"]',
      'div[contenteditable="true"][data-placeholder]',
      'div[contenteditable="true"]'
    ],

    // Send button selectors
    sendButtonSelectors: [
      'button[aria-label*="Send"]',
      'button[aria-label*="send"]',
      'button[type="submit"]',
      'button[class*="send"]'
    ],

    // Scraper selector for GET_LAST_RESPONSE
    scraperSelector: '[class*="message-block"]',

    // ========== Debug Selectors ==========
    debugSelectors: [
      '.user-message-block',
      '.nebula-message-block',
      '[class*="user-message"]',
      '[class*="nebula-message"]',
      '[class*="message-block"]'
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
      typoRate: 0.03,
      pauseAfterPunct: [200, 500],
      pauseAfterSpace: [60, 200],
      normalDelay: [30, 120],
      burstDelay: [15, 50]
    },

    // ========== URL 與對話偵測 ==========

    conversationIdAttributes: ['data-channel-id', 'data-thread-id'],

    hasMessagesSelector: '[class*="message-block"]',

    appPathPattern: '/chat',

    chatIdFromDOM() {
      for (const attr of this.conversationIdAttributes) {
        const el = document.querySelector(`[${attr}]`);
        if (el) return el.getAttribute(attr);
      }
      return null;
    },

    // ========== 標題提取 ==========

    sidebarLinkSelector(chatId) {
      if (!chatId) return 'a[href*="/chat/channel/"]';
      return `a[href*="/chat/channel/${chatId}"]`;
    },

    sidebarContainerSelectors: [
      'nav a[href*="/chat/channel/"]',
      '[class*="sidebar"] a[href*="/chat/channel/"]',
      '[class*="channel-list"] a[href*="/chat/channel/"]',
      'a[href*="/chat/channel/"]'
    ],

    selectedItemSelectors(chatId) {
      const path = `/chat/channel/${chatId}`;
      return [
        `a[href*="${path}"][aria-current="page"]`,
        `[aria-selected="true"] a[href*="${path}"]`,
        `[class*="active"] a[href*="${path}"]`,
        `[class*="selected"] a[href*="${path}"]`
      ];
    },

    genericTitlePatterns: [
      'Nebula',
      'New chat',
      'New Channel',
      'Untitled'
    ],

    navigationTextPatterns: [
      'Settings',
      'Help',
      'Upgrade',
      'Channels',
      'Today',
      'Yesterday'
    ],

    // ========== 圖片提取 ==========
    generatedImageSelector: null,
    isGeneratedImage() { return false; },
    extractImageId() { return null; },
    imageDownloadSelectors: []
  };

  // 註冊到 SiteRegistry
  if (window.__GAPI_SiteRegistry) {
    window.__GAPI_SiteRegistry.register('nebula', NebulaAdapter);
  } else {
    console.error('[NebulaAdapter] SiteRegistry not found! Ensure content-site-registry.js loads first.');
  }
})();
