// Nebula Site Adapter
// Selectors for nebula.gg AI agent chat platform.
// Nebula uses Next.js (Turbopack) + React + Tailwind CSS + shadcn/ui.
// Key patterns:
//   - Messages: .user-message-block (id=user-block-evt_XXX), reply in children[1]
//   - Input: <div contenteditable="true" role="textbox"> (not textarea)
//   - Send: <button type="submit"> with ArrowRight SVG inside <form>
//   - Sidebar: channel list with /chat/channel/ links
//   - Tool calls: collapsed summary "Nebula exchanged N messages and executed N tools"
//   - File refs: file paths like "docs/filename.md" appear in reply text after tool execution
//   - File content: NOT rendered in DOM — stored in Nebula's /files backend

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

    // Input selectors (Nebula uses contenteditable div with role="textbox")
    inputSelectors: [
      // Primary: contenteditable div with role textbox (confirmed via DOM inspection)
      'div[contenteditable="true"][role="textbox"]',
      // Contenteditable with data-placeholder
      'div[contenteditable="true"][data-placeholder]',
      // Generic contenteditable
      'div[contenteditable="true"]',
      // Fallback: textarea
      'textarea',
      // shadcn/ui Input pattern
      '[data-slot="input"]'
    ],

    // Send button selectors (submit button with ArrowRight SVG in form)
    sendButtonSelectors: [
      // Primary: submit button in form (most reliable for Nebula)
      'form button[type="submit"]',
      // Submit button anywhere
      'button[type="submit"]',
      // aria-label variations
      'button[aria-label*="Send"]',
      'button[aria-label*="send"]',
      // Button with arrow icon (Nebula uses ArrowRight SVG)
      'button:has(svg)',
      // Class-based
      'button[class*="send"]',
      // Role-based fallback
      '[role="button"][aria-label*="Send"]'
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

    // ========== Tool Call & File Reference Selectors ==========

    // Regex pattern to match Nebula tool call summary lines
    toolCallSummaryPattern: /(?:exchanged\s+\d+\s+messages?\s+and\s+)?executed\s+\d+\s+tools?/i,

    // File path pattern: matches paths like /filename.md, docs/filename.md
    filePathPattern: /[\w/.-]+\.\w{1,5}$/,

    // Selectors for tool call summary elements within reply divs
    toolCallSelectors: [
      // Tool call summary line (collapsed)
      '[class*="tool-call"]',
      '[class*="tool-summary"]',
      '[class*="tool-execution"]',
      // Generic collapsible sections
      'details summary',
      '[aria-expanded]',
      '[class*="collapsible"]',
      '[class*="expandable"]'
    ],

    // Selectors for file references in Nebula replies
    fileReferenceSelectors: [
      'a[href*="/files"]',
      'a[href*="/file/"]',
      'a[href$=".md"]',
      '[class*="file-ref"]',
      '[class*="file-link"]',
      '[class*="file-card"]',
      '[class*="file-preview"]'
    ],

    // Selectors for expanded content areas
    expandedContentSelectors: [
      '[aria-expanded="true"]',
      'details[open]',
      '[class*="expanded"]',
      '[class*="code-block"]',
      'pre code',
      '[class*="markdown-body"]',
      '[class*="markdown-content"]'
    ],

    /**
     * Extract file references from a reply element.
     * Returns an array of { path, name, type } objects.
     */
    extractFileRefs(replyEl) {
      if (!replyEl) return [];
      const refs = [];
      const text = replyEl.innerText || '';
      // Match lines that look like file paths
      const lines = text.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (this.filePathPattern.test(trimmed) && trimmed.length < 200) {
          refs.push({
            path: trimmed,
            name: trimmed.split('/').pop(),
            type: trimmed.split('.').pop()
          });
        }
      }
      // Also check anchor elements
      replyEl.querySelectorAll('a[href]').forEach(a => {
        const href = a.getAttribute('href') || '';
        if (href.includes('/files') || href.includes('.md') || href.includes('/file/')) {
          refs.push({
            path: href,
            name: (a.textContent || '').trim() || href.split('/').pop(),
            type: href.split('.').pop(),
            href
          });
        }
      });
      return refs;
    },

    /**
     * Check if a message block contains tool call summaries.
     */
    hasToolCalls(blockEl) {
      if (!blockEl) return false;
      const reply = blockEl.children[1];
      if (!reply) return false;
      return this.toolCallSummaryPattern.test(reply.innerText || '');
    },

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
