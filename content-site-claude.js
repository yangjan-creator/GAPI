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

    // ========== ProseMirror 訊息發送 ==========
    // Claude uses a ProseMirror-based rich text editor. Standard DOM
    // manipulation (execCommand, textContent, InputEvent) does NOT work
    // because ProseMirror maintains its own internal document model and
    // ignores external DOM changes. The reliable approach is to simulate
    // a clipboard paste event, which ProseMirror processes through its
    // own input handling pipeline (handlePaste).

    /**
     * Send a message to Claude's ProseMirror editor.
     * This is the adapter-level override called by content.js when it
     * detects that the current adapter provides a sendMessage method.
     *
     * @param {string} text - The message text to send.
     * @returns {Promise<{success: boolean, method?: string, reason?: string}>}
     */
    async sendMessage(text) {
      const log = (level, ...args) => {
        const prefix = '[ClaudeAdapter] [sendMessage]';
        if (level === 'error') console.error(prefix, ...args);
        else if (level === 'warn') console.warn(prefix, ...args);
        else console.log(prefix, ...args);
      };

      log('info', '========== Begin send message ==========');
      log('info', 'Text length:', text.length, '| Preview:', text.substring(0, 80));

      // --- Step 1: Find the ProseMirror editor element ---
      let editor = null;
      for (const sel of this.inputSelectors) {
        const el = document.querySelector(sel);
        if (el) {
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            editor = el;
            log('info', 'Found editor via selector:', sel);
            break;
          }
        }
      }

      if (!editor) {
        log('error', 'ProseMirror editor element not found');
        return { success: false, reason: 'ProseMirror editor not found' };
      }

      // --- Step 2: Focus the editor ---
      editor.focus();
      // Click to ensure the cursor is placed inside the editor
      editor.click();
      await new Promise(r => setTimeout(r, 150));

      // --- Step 3: Clear any existing content ---
      // Select all existing content so the paste replaces it
      const existingText = (editor.textContent || '').trim();
      if (existingText.length > 0) {
        log('info', 'Clearing existing content:', existingText.substring(0, 50));
        // Use Ctrl+A to select all, then delete
        editor.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'a', code: 'KeyA', keyCode: 65,
          ctrlKey: true, metaKey: false,
          bubbles: true, cancelable: true
        }));
        await new Promise(r => setTimeout(r, 50));
        editor.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Backspace', code: 'Backspace', keyCode: 8,
          bubbles: true, cancelable: true
        }));
        await new Promise(r => setTimeout(r, 100));
      }

      // --- Step 4: Insert text via clipboard paste simulation ---
      // This is the key technique: ProseMirror listens for paste events
      // and processes them through its handlePaste pipeline. By creating
      // a ClipboardEvent with a DataTransfer containing our text, we
      // feed ProseMirror through its standard input path.
      log('info', 'Inserting text via clipboard paste simulation...');

      let pasteSucceeded = false;

      try {
        const clipboardData = new DataTransfer();
        clipboardData.setData('text/plain', text);
        const pasteEvent = new ClipboardEvent('paste', {
          bubbles: true,
          cancelable: true,
          clipboardData: clipboardData
        });
        editor.dispatchEvent(pasteEvent);

        // Wait for ProseMirror to process the paste event
        await new Promise(r => setTimeout(r, 300));

        // Verify the text was inserted
        const editorText = (editor.textContent || editor.innerText || '').trim();
        const expectedTrimmed = text.trim();

        if (editorText.length > 0 && editorText.includes(expectedTrimmed.substring(0, 20))) {
          log('info', 'Paste simulation succeeded. Editor text length:', editorText.length);
          pasteSucceeded = true;
        } else {
          log('warn', 'Paste simulation may have failed. Editor text:', editorText.substring(0, 100));
        }
      } catch (pasteErr) {
        log('warn', 'Paste simulation threw error:', pasteErr.message);
      }

      // --- Step 4b: Fallback — try InputEvent with insertFromPaste ---
      // Some ProseMirror builds also respond to beforeinput/input events
      // with inputType "insertFromPaste".
      if (!pasteSucceeded) {
        log('info', 'Trying fallback: InputEvent insertFromPaste...');
        try {
          editor.focus();
          const beforeInput = new InputEvent('beforeinput', {
            bubbles: true,
            cancelable: true,
            inputType: 'insertFromPaste',
            data: text,
            dataTransfer: (() => {
              const dt = new DataTransfer();
              dt.setData('text/plain', text);
              return dt;
            })()
          });
          editor.dispatchEvent(beforeInput);

          await new Promise(r => setTimeout(r, 200));

          const editorText2 = (editor.textContent || editor.innerText || '').trim();
          if (editorText2.length > 0 && editorText2.includes(text.trim().substring(0, 20))) {
            log('info', 'insertFromPaste fallback succeeded.');
            pasteSucceeded = true;
          }
        } catch (fallbackErr) {
          log('warn', 'insertFromPaste fallback error:', fallbackErr.message);
        }
      }

      // --- Step 4c: Fallback — try execCommand insertText ---
      // Last resort for editors that may accept execCommand
      if (!pasteSucceeded) {
        log('info', 'Trying last resort: execCommand insertText...');
        try {
          editor.focus();
          document.execCommand('selectAll', false, null);
          document.execCommand('delete', false, null);
          document.execCommand('insertText', false, text);
          await new Promise(r => setTimeout(r, 200));

          const editorText3 = (editor.textContent || editor.innerText || '').trim();
          if (editorText3.length > 0 && editorText3.includes(text.trim().substring(0, 20))) {
            log('info', 'execCommand fallback succeeded.');
            pasteSucceeded = true;
          }
        } catch (execErr) {
          log('warn', 'execCommand fallback error:', execErr.message);
        }
      }

      if (!pasteSucceeded) {
        log('error', 'All text insertion methods failed');
        return { success: false, reason: 'Failed to insert text into ProseMirror editor' };
      }

      // --- Step 5: Wait briefly, then find and click the send button ---
      // Simulate a brief pause (as if the user reviews before sending)
      await new Promise(r => setTimeout(r, 200 + Math.random() * 300));

      log('info', 'Looking for send button...');
      let sendBtn = null;
      for (const sel of this.sendButtonSelectors) {
        const btn = document.querySelector(sel);
        if (btn) {
          const rect = btn.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            sendBtn = btn;
            log('info', 'Found send button via selector:', sel);
            break;
          }
        }
      }

      if (sendBtn) {
        // Wait for the button to become enabled (ProseMirror state update
        // may take a tick to propagate to React, which enables the button)
        let waitAttempts = 0;
        while (sendBtn.disabled && waitAttempts < 15) {
          await new Promise(r => setTimeout(r, 200));
          waitAttempts++;
          log('info', 'Waiting for send button to enable... attempt', waitAttempts);
        }

        if (sendBtn.disabled) {
          log('warn', 'Send button still disabled after waiting. Attempting click anyway.');
        }

        sendBtn.click();
        log('info', 'Clicked send button');

        // Verify: wait and check if editor was cleared (indicating submission)
        await new Promise(r => setTimeout(r, 500));
        const postSendText = (editor.textContent || editor.innerText || '').trim();
        if (postSendText.length === 0 || postSendText !== text.trim()) {
          log('info', '========== Message sent successfully (button) ==========');
          return { success: true, method: 'claude_paste_button' };
        } else {
          log('warn', 'Editor not cleared after button click. Text still present.');
        }
      } else {
        log('warn', 'Send button not found, trying Enter key...');
      }

      // --- Step 6: Fallback — press Enter to send ---
      editor.focus();
      const enterEvent = new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true
      });
      editor.dispatchEvent(enterEvent);

      await new Promise(r => setTimeout(r, 500));

      const postEnterText = (editor.textContent || editor.innerText || '').trim();
      if (postEnterText.length === 0 || postEnterText !== text.trim()) {
        log('info', '========== Message sent successfully (enter) ==========');
        return { success: true, method: 'claude_paste_enter' };
      }

      log('error', 'Message may not have been sent — editor not cleared after submit');
      return { success: false, reason: 'Input not cleared after submit — message may not have been sent' };
    },

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
