// Claude Site Adapter
// Full adapter for claude.ai DOM extraction and interaction.
//
// Claude.ai uses React with Tailwind CSS and a ProseMirror-based input editor.
// Key DOM patterns (researched from live inspections and open-source exporters):
//
//   Conversation URL : https://claude.ai/chat/{uuid}
//   New conversation : https://claude.ai/new
//   Message turns    : [role="group"][aria-label="Message actions"] distinguishes
//                      human vs. assistant by presence of a feedback button.
//   Title            : [data-testid="chat-title-button"] .truncate
//   Input            : div.ProseMirror[contenteditable="true"]
//   Send button      : button[data-testid="send-button"] or aria-label="Send Message"
//   Sidebar          : nav a[href*="/chat/"]
//   API endpoint     : /api/organizations/{orgId}/chat_conversations/{id}?tree=true
//   Org cookie       : lastActiveOrg={orgId}
//
// Because Claude's React app may change class names across deploys, every
// selector list uses multiple fallbacks ordered from most-specific to broadest.
// All public methods return null/empty rather than throwing when selectors miss.

(function() {
  'use strict';

  const ClaudeAdapter = {
    name: 'claude',
    label: 'Claude',
    hostPatterns: ['claude.ai'],

    // ========== URL Utilities ==========

    isOnSite(url) {
      return (url || '').includes('claude.ai');
    },

    getChatIdFromUrl(url) {
      try {
        if (!url) return null;
        // Claude URL: https://claude.ai/chat/{uuid}
        const m = url.match(/\/chat\/([0-9a-f-]{36}|[^/?#]+)/);
        return (m && m[1]) ? m[1] : null;
      } catch {
        return null;
      }
    },

    parseConversationFromUrl(url) {
      if (!url || !this.isOnSite(url)) return null;
      const chatId = this.getChatIdFromUrl(url);
      const isChatPage = /\/chat(\/|$)/.test(url) || url.includes('/new');
      return { chatId, isAppPage: isChatPage };
    },

    // ========== User Detection ==========

    detectUserProfile() {
      // Claude does not expose multi-account switching in the DOM in the same
      // way as Google (no /u/N/ path). We attempt to detect the active
      // organization ID from cookies, which serves as an account identifier.
      try {
        // Strategy 1: Extract org ID from lastActiveOrg cookie
        const orgMatch = (document.cookie || '').match(/lastActiveOrg=([^;]+)/);
        if (orgMatch && orgMatch[1]) {
          return orgMatch[1].substring(0, 20);
        }

        // Strategy 2: Look for user avatar or account menu elements
        const avatarSelectors = [
          'button[data-testid="user-menu"] img',
          'button[data-testid="user-button"] img',
          '[data-testid="avatar"]',
          'img[alt*="@"]',
          '[aria-label*="Account"]',
          '[aria-label*="Profile"]',
          '[aria-label*="User menu"]'
        ];

        for (const selector of avatarSelectors) {
          try {
            const el = document.querySelector(selector);
            if (el) {
              const alt = el.getAttribute('alt') || '';
              const ariaLabel = el.getAttribute('aria-label') || '';
              const emailMatch = (alt + ' ' + ariaLabel).match(
                /([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9_-]+)/
              );
              if (emailMatch && emailMatch[1]) {
                return emailMatch[1].split('@')[0].replace(/[^a-zA-Z0-9]/g, '_');
              }
            }
          } catch {
            continue;
          }
        }

        return null;
      } catch (error) {
        console.error('[ClaudeAdapter] detectUserProfile error:', error);
        return null;
      }
    },

    // ========== DOM Selector Arrays ==========

    // User message turn containers.
    // Claude wraps each conversation turn in a container. Human turns can be
    // identified by data-testid attributes or by the absence of a feedback
    // button inside the message action group.
    userMessageSelectors: [
      // data-testid based (most stable across deploys)
      '[data-testid="user-message"]',
      '[data-testid="human-turn"]',
      '[data-testid="user-turn"]',
      // Attribute-based variants
      '[data-human-turn="true"]',
      '[data-is-human-message="true"]',
      // Role-based (React/ARIA patterns)
      '[data-role="user"]',
      '[data-message-author-role="user"]',
      '[data-sender="human"]',
      // Class-based fallbacks (Tailwind utility classes)
      '[class*="human-turn"]',
      '[class*="human-message"]',
      '[class*="user-message"]',
      '[class*="user-turn"]'
    ],

    // Assistant (model) response turn containers.
    // Claude's assistant responses often contain a ".font-claude-message" class
    // for the prose content and can be identified by the presence of a feedback
    // (thumbs-up) button in the action bar.
    modelResponseSelectors: [
      // data-testid based
      '[data-testid="ai-turn"]',
      '[data-testid="assistant-turn"]',
      '[data-testid="assistant-message"]',
      '[data-testid="claude-message"]',
      // Attribute-based variants
      '[data-ai-turn="true"]',
      '[data-is-ai-message="true"]',
      // Role-based
      '[data-role="assistant"]',
      '[data-message-author-role="assistant"]',
      '[data-sender="assistant"]',
      // Tailwind class: font-claude-message (stable across many builds)
      '.font-claude-message',
      // Class-based fallbacks
      '[class*="ai-turn"]',
      '[class*="ai-message"]',
      '[class*="assistant-turn"]',
      '[class*="assistant-message"]',
      '[class*="claude-message"]',
      // Broader fallback: response containers
      '[class*="response-content"]'
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
      // data-testid based
      '[data-testid="composer-input"] [contenteditable="true"]',
      '[data-testid="chat-input"] [contenteditable="true"]',
      // Broader fallback: any contenteditable textbox role
      'div[contenteditable="true"][role="textbox"]',
      // Textarea fallback (in case Claude switches away from ProseMirror)
      'textarea[placeholder*="message" i]',
      'textarea[placeholder*="Claude" i]',
      'textarea[aria-label*="message" i]',
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
      'button[aria-label="Send"]',
      // Broader aria-label partial match
      'button[aria-label*="Send"]',
      // Fallback: submit button in the composer form
      'form button[type="submit"]',
      'button[type="submit"]'
    ],

    // Stop generation button selectors.
    // Used by waitForResponse to detect when Claude is still generating.
    stopButtonSelectors: [
      'button[data-testid="stop-button"]',
      'button[aria-label="Stop generating"]',
      'button[aria-label="Stop"]',
      'button[aria-label*="Stop"]',
      'button[aria-label*="stop"]',
      '[class*="stop-button"]'
    ],

    // Quick scraper selector for GET_LAST_RESPONSE operations.
    // Targets the prose content of the last assistant turn.
    // .font-claude-message is a stable Tailwind class applied to Claude's
    // response text across UI versions.
    scraperSelector:
      '.font-claude-message, ' +
      '[data-testid="ai-turn"], ' +
      '[data-testid="assistant-message"], ' +
      '[data-role="assistant"], ' +
      '[class*="assistant-message"], ' +
      '[class*="ai-turn"]',

    // ========== Debug Selectors ==========
    // Used by the debug panel to show matching elements and counts.
    debugSelectors: [
      // Human/user message selectors
      '[data-testid="user-message"]',
      '[data-testid="human-turn"]',
      '[data-role="user"]',
      '[data-message-author-role="user"]',
      '[data-sender="human"]',
      '[class*="human-turn"]',
      '[class*="user-message"]',
      // Assistant/AI message selectors
      '[data-testid="ai-turn"]',
      '[data-testid="assistant-message"]',
      '[data-role="assistant"]',
      '[data-message-author-role="assistant"]',
      '[data-sender="assistant"]',
      '.font-claude-message',
      '[class*="ai-turn"]',
      '[class*="assistant-message"]',
      // Message action groups (verified from claude-chat-exporter)
      '[role="group"][aria-label="Message actions"]',
      // Title
      '[data-testid="chat-title-button"]',
      // Copy button
      'button[data-testid="action-bar-copy"]',
      // Feedback button (assistant-only indicator)
      'button[aria-label="Give positive feedback"]',
      // Input
      'div.ProseMirror[contenteditable="true"]',
      // Send button
      'button[data-testid="send-button"]'
    ],

    // ========== Typing Simulation Config ==========
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

    // ========== URL and Conversation Detection ==========

    // Claude does not embed the conversation ID in DOM data attributes in a
    // standardised way, so URL is the primary source via getChatIdFromUrl().
    // These attributes are speculative fallbacks.
    conversationIdAttributes: [
      'data-conversation-id',
      'data-chat-id',
      'data-conversation-uuid'
    ],

    // Selector that confirms the page contains chat messages.
    // Matches if at least one human or AI turn is present.
    // Uses multiple fallback strategies to handle DOM changes.
    hasMessagesSelector:
      '[data-testid="human-turn"], ' +
      '[data-testid="ai-turn"], ' +
      '[data-testid="user-message"], ' +
      '[data-testid="assistant-message"], ' +
      '[data-role="user"], ' +
      '[data-role="assistant"], ' +
      '.font-claude-message, ' +
      '[role="group"][aria-label="Message actions"]',

    appPathPattern: '/chat',

    chatIdFromDOM() {
      // Strategy 1: Try data attributes on DOM elements
      for (const attr of this.conversationIdAttributes) {
        try {
          const el = document.querySelector(`[${attr}]`);
          if (el) {
            const value = el.getAttribute(attr);
            if (value) return value;
          }
        } catch {
          continue;
        }
      }

      // Strategy 2: Extract from the current URL as fallback
      return this.getChatIdFromUrl(window.location.href);
    },

    // ========== Title Extraction ==========

    // Returns the CSS selector for the sidebar link to a specific chat.
    // When chatId is empty/null, returns the selector matching ALL chat links
    // (used by the engine to enumerate all conversations).
    sidebarLinkSelector(chatId) {
      if (!chatId) {
        return 'a[href*="/chat/"]';
      }
      return `a[href*="/chat/${chatId}"]`;
    },

    // Title element selectors (the title displayed in the header/sidebar).
    // Verified from claude-chat-exporter: data-testid="chat-title-button"
    // contains a .truncate child with the title text.
    titleSelectors: [
      '[data-testid="chat-title-button"] .truncate',
      'button[data-testid="chat-title-button"] div.truncate',
      '[data-testid="chat-title-button"]',
      '[data-testid="conversation-title"]',
      'h1[class*="title"]',
      'header [class*="title"]'
    ],

    // Sidebar conversation list container selectors.
    // Claude renders conversations in a nav element containing an ordered or
    // unordered list of anchor tags pointing to /chat/{uuid}.
    sidebarContainerSelectors: [
      // Primary: nav-scoped links (most reliable)
      'nav a[href*="/chat/"]',
      // Sidebar with specific data attributes
      '[data-testid="sidebar"] a[href*="/chat/"]',
      '[data-testid="conversation-list"] a[href*="/chat/"]',
      // Class-based fallbacks
      '[class*="sidebar"] a[href*="/chat/"]',
      '[class*="conversation-list"] a[href*="/chat/"]',
      '[class*="chat-list"] a[href*="/chat/"]',
      // Generic list-based fallbacks
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
        // data-testid based active state
        `[data-testid="active-conversation"] a[href*="${path}"]`,
        // Class-based: React may apply bg-* or text-* classes to active items
        `[aria-selected="true"] a[href*="${path}"]`,
        `[class*="active"] a[href*="${path}"]`,
        `[class*="selected"] a[href*="${path}"]`,
        `[class*="current"] a[href*="${path}"]`
      ];
    },

    // Titles to exclude because they are generic brand names or defaults,
    // not real conversation titles set by the user or summarised from content.
    genericTitlePatterns: [
      'Claude',
      'New chat',
      'New Chat',
      'New conversation',
      'New Conversation',
      'Untitled',
      'Untitled conversation',
      'Start a new chat',
      'Chat',
      'claude.ai'
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
      'Previous 30 days',
      'Older',
      'Projects',
      'Home',
      'Search',
      'New chat'
    ],

    // ========== Message Differentiation ==========
    //
    // Claude.ai uses [role="group"][aria-label="Message actions"] for each
    // message's action bar. Human and Claude action bars are structurally
    // identical EXCEPT that Claude's bars include a thumbs-up feedback button:
    //   button[aria-label="Give positive feedback"]
    //
    // This is used as a secondary heuristic when data-testid or data-role
    // selectors do not match (DOM refresh may remove those attributes).

    /**
     * Given a message action group element, determine if it belongs to an
     * assistant (Claude) response.
     * @param {Element} actionGroup - An element matching [role="group"][aria-label="Message actions"]
     * @returns {boolean}
     */
    isAssistantActionGroup(actionGroup) {
      if (!actionGroup) return false;
      return !!actionGroup.querySelector('button[aria-label="Give positive feedback"]');
    },

    /**
     * Get all message action groups on the page, split into human and assistant.
     * Each group is associated with its closest ancestor message container.
     * @returns {{ human: Element[], assistant: Element[] }}
     */
    getMessageGroups() {
      const groups = { human: [], assistant: [] };
      try {
        const actionGroups = document.querySelectorAll(
          '[role="group"][aria-label="Message actions"]'
        );
        actionGroups.forEach(group => {
          if (this.isAssistantActionGroup(group)) {
            groups.assistant.push(group);
          } else {
            groups.human.push(group);
          }
        });
      } catch (error) {
        console.error('[ClaudeAdapter] getMessageGroups error:', error);
      }
      return groups;
    },

    // ========== ProseMirror Message Sending ==========
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
        try {
          const el = document.querySelector(sel);
          if (el) {
            const rect = el.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              editor = el;
              log('info', 'Found editor via selector:', sel);
              break;
            }
          }
        } catch {
          continue;
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
        try {
          const btn = document.querySelector(sel);
          if (btn) {
            const rect = btn.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              sendBtn = btn;
              log('info', 'Found send button via selector:', sel);
              break;
            }
          }
        } catch {
          continue;
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

    // ========== Response Completion Detection ==========

    /**
     * Detect whether Claude has finished generating a response.
     * Checks for the absence of a stop button and streaming indicators.
     * @returns {boolean} true if Claude appears to have finished responding
     */
    isResponseComplete() {
      try {
        // Check if a stop button is present (indicates active generation)
        for (const sel of this.stopButtonSelectors) {
          try {
            const btn = document.querySelector(sel);
            if (btn) {
              const rect = btn.getBoundingClientRect();
              if (rect.width > 0 && rect.height > 0) {
                return false; // Stop button visible = still generating
              }
            }
          } catch {
            continue;
          }
        }

        // Check for streaming/thinking indicators
        const streamingSelectors = [
          '[class*="streaming"]',
          '[class*="thinking"]',
          '[data-is-streaming="true"]',
          '[data-testid="thinking-indicator"]',
          '.animate-pulse',
          '[class*="cursor-blink"]',
          '[class*="typing-indicator"]'
        ];

        for (const sel of streamingSelectors) {
          try {
            const el = document.querySelector(sel);
            if (el) {
              const rect = el.getBoundingClientRect();
              if (rect.width > 0 && rect.height > 0) {
                return false; // Streaming indicator visible
              }
            }
          } catch {
            continue;
          }
        }

        return true; // No generation indicators found
      } catch {
        return true; // Assume complete on error
      }
    },

    /**
     * Wait for Claude to finish responding. Polls isResponseComplete() with
     * increasing intervals until the response is done or timeout is reached.
     * @param {number} [timeoutMs=120000] - Maximum wait time in milliseconds
     * @param {number} [pollIntervalMs=500] - Initial polling interval
     * @returns {Promise<boolean>} true if response completed, false if timed out
     */
    async waitForResponse(timeoutMs = 120000, pollIntervalMs = 500) {
      const startTime = Date.now();
      let interval = pollIntervalMs;

      // First, wait for generation to start (the stop button to appear)
      // This avoids returning immediately before Claude begins responding
      let generationStarted = false;
      const startWaitLimit = Math.min(10000, timeoutMs / 2);

      while (Date.now() - startTime < startWaitLimit) {
        if (!this.isResponseComplete()) {
          generationStarted = true;
          break;
        }
        await new Promise(r => setTimeout(r, 200));
      }

      if (!generationStarted) {
        // Generation may have already completed very quickly, or never started.
        // Check if there are any message action groups (indicating a response exists).
        const hasMessages = document.querySelector(this.hasMessagesSelector);
        if (hasMessages) {
          return true; // There are messages on the page; response may already be done
        }
      }

      // Now wait for generation to complete
      while (Date.now() - startTime < timeoutMs) {
        if (this.isResponseComplete()) {
          // Double-check after a short delay to avoid premature detection
          // (e.g., brief pause between streaming chunks)
          await new Promise(r => setTimeout(r, 1000));
          if (this.isResponseComplete()) {
            return true;
          }
        }
        await new Promise(r => setTimeout(r, interval));
        // Gradually increase polling interval to reduce CPU usage
        interval = Math.min(interval * 1.2, 2000);
      }

      console.warn('[ClaudeAdapter] waitForResponse timed out after', timeoutMs, 'ms');
      return false;
    },

    // ========== Title Extraction (API-based) ==========

    /**
     * Attempt to extract the conversation title using Claude's internal API.
     * This is more reliable than DOM scraping as Claude's API returns the
     * canonical conversation name.
     * @param {string} [chatId] - Conversation UUID; defaults to current URL
     * @returns {Promise<string|null>} The conversation title or null
     */
    async fetchTitleFromAPI(chatId) {
      try {
        const id = chatId || this.getChatIdFromUrl(window.location.href);
        if (!id) return null;

        const orgMatch = (document.cookie || '').match(/lastActiveOrg=([^;]+)/);
        if (!orgMatch || !orgMatch[1]) return null;

        const orgId = orgMatch[1];
        const url = `/api/organizations/${orgId}/chat_conversations/${id}?tree=true&rendering_mode=messages&render_all_tools=true`;

        const response = await fetch(url, {
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' }
        });

        if (!response.ok) return null;

        const data = await response.json();
        return (data && data.name) ? data.name.trim() : null;
      } catch {
        return null;
      }
    },

    /**
     * Extract conversation title from DOM elements.
     * Uses the verified data-testid="chat-title-button" selector first,
     * then falls back to sidebar link text.
     * @returns {string|null}
     */
    extractTitleFromDOM() {
      try {
        // Strategy 1: Use title element selectors (verified from chat-exporter)
        for (const sel of this.titleSelectors) {
          try {
            const el = document.querySelector(sel);
            if (el) {
              const text = (el.textContent || el.innerText || '').trim();
              if (text && text.length >= 2 && text.length <= 300) {
                // Check if it is a generic/brand title
                const isGeneric = this.genericTitlePatterns.some(
                  pattern => text.toLowerCase() === pattern.toLowerCase()
                );
                if (!isGeneric) {
                  return text;
                }
              }
            }
          } catch {
            continue;
          }
        }

        // Strategy 2: Use document.title (Claude sets it to the conversation name)
        const docTitle = (document.title || '').trim();
        if (docTitle) {
          // Claude's document.title is often "conversation name - Claude"
          // Strip the " - Claude" suffix
          const stripped = docTitle.replace(/\s*[-|]\s*Claude\s*$/i, '').trim();
          if (stripped && stripped.length >= 2 && stripped.length <= 300) {
            const isGeneric = this.genericTitlePatterns.some(
              pattern => stripped.toLowerCase() === pattern.toLowerCase()
            );
            if (!isGeneric) {
              return stripped;
            }
          }
        }

        return null;
      } catch {
        return null;
      }
    },

    // ========== Image Extraction ==========
    // Claude (as of 2026) does not generate images in the same way as Gemini
    // (no DALL-E/Imagen equivalent). However, users may upload images, and
    // Claude may display image attachments. These selectors handle user-uploaded
    // images that appear in the conversation.

    generatedImageSelector: null,

    isGeneratedImage() {
      return false;
    },

    extractImageId() {
      return null;
    },

    imageDownloadSelectors: [],

    // Selectors for user-uploaded image attachments in conversation turns.
    // These are not AI-generated but may need extraction for conversation export.
    uploadedImageSelectors: [
      '[data-testid="file-thumbnail"] img',
      '[data-testid="attachment-thumbnail"] img',
      '[class*="attachment"] img',
      '[class*="uploaded-image"] img',
      '[class*="file-preview"] img',
      'img[class*="attachment"]'
    ]
  };

  // Register with SiteRegistry
  if (window.__GAPI_SiteRegistry) {
    window.__GAPI_SiteRegistry.register('claude', ClaudeAdapter);
  } else {
    console.error('[ClaudeAdapter] SiteRegistry not found! Ensure content-site-registry.js loads first.');
  }
})();
