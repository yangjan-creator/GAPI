// Claude Site Adapter
// Researched selectors for claude.ai DOM structure (as of 2025).
// Claude uses React with Tailwind CSS. Key patterns:
//   - Conversation turns: data-testid="human-turn" / data-testid="ai-turn"
//   - Message content: .font-claude-message for assistant prose
//   - Input: ProseMirror contenteditable div with data-placeholder attribute
//   - Send button: button with aria-label="Send Message" (capital M) or data-testid="send-button"
//   - Sidebar: nav > ol/ul > li > a[href*="/chat/"]

(function() {
  'use strict';

  const ClaudeAdapter = {
    name: 'claude',
    label: 'Claude',
    hostPatterns: ['claude.ai'],

    // ========== URL 工具 ==========

    isOnSite(url) {
      return (url || '').includes('claude.ai');
    },

    getChatIdFromUrl(url) {
      try {
        if (!url) return null;
        // Claude URL: https://claude.ai/chat/{uuid}
        const m = url.match(/\/chat\/([^/?#]+)/);
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
      // Claude does not use multi-account switching; return null.
      return null;
    },

    // ========== DOM Selector 陣列 ==========

    // User message turn containers.
    // Claude wraps each turn in a div identified by data-testid="human-turn".
    // Fallback: the inner .font-human-message element or any element marked
    // with [data-is-human-turn] that React may set.
    userMessageSelectors: [
      // 2026 DOM: data-testid based
      '[data-testid="user-message"]',
      '[data-testid="human-turn"]',
      // Older builds
      '[data-human-turn="true"]',
      // Class-based fallback
      '[class*="human-turn"]',
      // Generic role-based fallbacks
      '[data-role="user"]',
      '[data-message-author-role="user"]'
    ],

    // Assistant (model) response turn containers.
    // The outer wrapper uses data-testid="ai-turn"; the rich prose content
    // inside uses the Tailwind utility class "font-claude-message".
    modelResponseSelectors: [
      // 2026 DOM: class-based response containers
      '[class*="response"]',
      // data-testid based (may return in future builds)
      '[data-testid="ai-turn"]',
      // Older attribute variant
      '[data-ai-turn="true"]',
      // Class-based fallback
      '[class*="ai-turn"]',
      // Tailwind utility class (older builds)
      '.font-claude-message',
      // Generic role-based fallbacks
      '[data-role="assistant"]',
      '[data-message-author-role="assistant"]'
    ],

    // Input selectors for the ProseMirror contenteditable composer.
    // Claude's input is a div.ProseMirror inside a wrapper that carries
    // data-placeholder. The aria-label on the outer wrapper is typically
    // "Write your prompt to Claude" or similar locale-dependent text.
    inputSelectors: [
      // Most specific: ProseMirror editor div with contenteditable
      'div.ProseMirror[contenteditable="true"]',
      // The wrapper div that carries the placeholder attribute
      'div[contenteditable="true"][data-placeholder]',
      // Broader fallback: any contenteditable textbox role
      'div[contenteditable="true"][role="textbox"]',
      // Widest fallback
      'div[contenteditable="true"]'
    ],

    // Send button selectors.
    // Claude uses aria-label="Send Message" (capital M) on the primary button.
    // The data-testid="send-button" attribute is set in the React component.
    sendButtonSelectors: [
      // Primary: data-testid (most stable across UI refreshes)
      'button[data-testid="send-button"]',
      // aria-label variations (Claude uses "Send Message" with capital M)
      'button[aria-label="Send Message"]',
      'button[aria-label="Send message"]',
      // Broader aria-label partial match
      'button[aria-label*="Send"]',
      // Fallback: submit button in the composer form
      'button[type="submit"]'
    ],

    // Quick scraper selector for GET_LAST_RESPONSE operations.
    // Targets the prose content of the last assistant turn.
    // .font-claude-message is a stable Tailwind class applied to Claude's
    // response text across UI versions.
    scraperSelector: '[class*="response"]',

    // ========== Debug Selectors ==========
    // Used by the debug panel to show matching elements and counts.
    debugSelectors: [
      '[data-testid="human-turn"]',
      '[data-testid="ai-turn"]',
      '.font-claude-message',
      '[data-role="user"]',
      '[data-role="assistant"]',
      '[data-message-author-role="user"]',
      '[data-message-author-role="assistant"]',
      '[class*="human-turn"]',
      '[class*="ai-turn"]'
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

    // ========== URL 與對話偵測 ==========

    // Claude does not embed the conversation ID in DOM data attributes in a
    // standardised way, so this list is speculative. The URL is the primary
    // source via getChatIdFromUrl().
    conversationIdAttributes: ['data-conversation-id'],

    // Selector that confirms the page contains chat messages.
    // Matches if at least one human or AI turn is present.
    hasMessagesSelector: '[data-testid="human-turn"], [data-testid="ai-turn"]',

    appPathPattern: '/chat',

    chatIdFromDOM() {
      // Try conversationIdAttributes first (usually not present on claude.ai,
      // but kept as a safety fallback).
      for (const attr of this.conversationIdAttributes) {
        const el = document.querySelector(`[${attr}]`);
        if (el) {
          return el.getAttribute(attr);
        }
      }
      return null;
    },

    // ========== 標題提取 ==========

    // Returns the CSS selector for the sidebar link to a specific chat.
    // When chatId is empty, returns the selector matching ALL chat links
    // (used by the engine to enumerate all conversations).
    sidebarLinkSelector(chatId) {
      if (!chatId) {
        return 'a[href*="/chat/"]';
      }
      return `a[href*="/chat/${chatId}"]`;
    },

    // Sidebar conversation list container selectors.
    // Claude renders conversations in a nav element containing an ordered or
    // unordered list of anchor tags pointing to /chat/{uuid}.
    sidebarContainerSelectors: [
      // Primary: nav-scoped links (most reliable)
      'nav a[href*="/chat/"]',
      // Fallback: any sidebar-like list with chat links
      '[class*="sidebar"] a[href*="/chat/"]',
      '[class*="conversation-list"] a[href*="/chat/"]',
      'ol a[href*="/chat/"]',
      'ul a[href*="/chat/"]'
    ],

    // Selectors for the currently active/selected conversation item.
    // Claude sets aria-current="page" on the active link, and may also add
    // an "active" or "selected" class via Tailwind variants.
    selectedItemSelectors(chatId) {
      const path = `/chat/${chatId}`;
      return [
        // Most reliable: aria-current on the exact link
        `a[href*="${path}"][aria-current="page"]`,
        // Fallback: parent element marked as current
        `[aria-current="page"] a[href*="${path}"]`,
        // Class-based: React may apply bg-* or text-* classes to active items
        `[aria-selected="true"] a[href*="${path}"]`,
        `[class*="active"] a[href*="${path}"]`,
        `[class*="selected"] a[href*="${path}"]`
      ];
    },

    // Titles to exclude because they are generic brand names or defaults,
    // not real conversation titles set by the user or summarised from content.
    genericTitlePatterns: [
      'Claude',
      'New chat',
      'New Chat',
      'Untitled',
      'Start a new chat',
      'Chat'
    ],

    // Navigation UI text to exclude from title extraction.
    // These strings appear in the sidebar but are not conversation titles.
    navigationTextPatterns: [
      'Settings',
      'Help & support',
      'Help',
      'Upgrade plan',
      'Upgrade',
      'Starred',
      'Recents',
      'Today',
      'Yesterday',
      'Previous 7 days',
      'Previous 30 days'
    ],

    // ========== 圖片提取 ==========
    // Claude (as of 2025) does not support AI-generated image output in the
    // same way as Gemini (no DALL-E equivalent). Set to null to skip.

    generatedImageSelector: null,
    isGeneratedImage() { return false; },
    extractImageId() { return null; },
    imageDownloadSelectors: []
  };

  // 註冊到 SiteRegistry
  if (window.__GAPI_SiteRegistry) {
    window.__GAPI_SiteRegistry.register('claude', ClaudeAdapter);
  } else {
    console.error('[ClaudeAdapter] SiteRegistry not found! Ensure content-site-registry.js loads first.');
  }
})();
