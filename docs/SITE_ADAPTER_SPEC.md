# GAPI Site Adapter Development Specification

## Overview

GAPI (Gemini API Integration) is a Chrome MV3 browser extension that connects to AI chat platforms through a unified adapter pattern. Each supported website (Gemini, Claude, etc.) has its own **Site Adapter** module that defines how to interact with that site's DOM, detect conversations, extract messages, and simulate user input.

This specification provides everything you need to develop a new Site Adapter.

---

## Architecture Overview

### Adapter Registry Pattern

All adapters are discovered and managed through `content-site-registry.js`, which maintains a global registry accessible to content scripts:

```javascript
window.__GAPI_SiteRegistry  // Global registry object
```

### Execution Flow

1. **Extension Load**: Browser loads `manifest.json` → injects content scripts
2. **Script Injection**: In execution order:
   - `content-site-registry.js` (establishes registry)
   - `content-site-gemini.js` (registers Gemini adapter)
   - `content-site-claude.js` (registers Claude adapter)
   - `content.js` (main content script)
3. **Site Detection**: `content.js` calls `registry.detectCurrentSite()` based on hostname
4. **Adapter Use**: Content script uses adapter's selectors and utilities for DOM manipulation
5. **Background Integration**: `background.js` uses `tab-router.js` to discover tabs by site

### File Structure

```
GAPI/
├── manifest.json                 # Extension configuration
├── content-site-registry.js      # Adapter registration system
├── content-site-gemini.js        # Gemini adapter (reference)
├── content-site-claude.js        # Claude adapter (template)
├── content.js                    # Main content script
├── background.js                 # Background service worker
├── tab-router.js                 # Tab discovery by site
└── docs/
    └── SITE_ADAPTER_SPEC.md      # This file
```

---

## Adapter Interface

Each adapter is a JavaScript object registered with the Site Registry. All properties are required unless marked otherwise.

### Core Metadata

| Property | Type | Description | Example |
|----------|------|-------------|---------|
| `name` | string | Unique adapter identifier (lowercase) | `'gemini'`, `'claude'` |
| `label` | string | Display name for the site | `'Google Gemini'`, `'Claude'` |
| `hostPatterns` | string[] | Hostname patterns to match (used in site detection) | `['gemini.google.com']` |

### URL Utilities

These methods extract and parse URL components for conversation tracking.

#### `isOnSite(url: string): boolean`

Checks if a URL belongs to this site.

```javascript
isOnSite(url) {
  return (url || '').includes('gemini.google.com');
}
```

#### `getChatIdFromUrl(url: string): string | null`

Extracts the conversation ID from a URL. Returns `null` if not found.

```javascript
getChatIdFromUrl(url) {
  try {
    if (!url) return null;
    const m = url.match(/\/app\/([^/?#]+)/);
    return (m && m[1]) ? m[1] : null;
  } catch {
    return null;
  }
}
```

Different platforms use different URL patterns:
- **Gemini**: `https://gemini.google.com/app/{chatId}`
- **Claude**: `https://claude.ai/chat/{uuid}`
- **Custom**: `https://yoursite.com/c/{id}` → modify regex accordingly

#### `parseConversationFromUrl(url: string): {chatId: string | null, isAppPage: boolean} | null`

Combines URL parsing with page type detection. Used by tab router to identify conversation contexts.

```javascript
parseConversationFromUrl(url) {
  if (!url || !this.isOnSite(url)) return null;
  const chatId = this.getChatIdFromUrl(url);
  const isAppPage = url.includes('/app');
  return { chatId, isAppPage };
}
```

### User Detection

#### `detectUserProfile(): string | null`

Detects the logged-in user for multi-account support. Returns a unique identifier or `null` if not applicable.

Strategy:
1. Check URL parameters (`?authuser=0`, `?u=1`)
2. Parse DOM elements (profile images, account links)
3. Query `localStorage` for cached user data
4. Return normalized string (email prefix, user ID)

```javascript
detectUserProfile() {
  // Strategy 0: Check URL parameters
  try {
    const uMatch = window.location.pathname.match(/\/u\/(\d+)\//);
    if (uMatch) return `u${uMatch[1]}`;
  } catch (e) {}

  // Strategy 1: Parse DOM elements
  const userSelectors = [
    '[aria-label*="Google Account"]',
    'a[href*="myaccount.google.com"]',
    'img[alt*="@"]'
  ];
  for (const selector of userSelectors) {
    const el = document.querySelector(selector);
    if (!el) continue;

    const email = el.getAttribute('alt')?.match(/([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+)/)?.[1];
    if (email) return email.split('@')[0];
  }

  // Strategy 2: Query localStorage
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.includes('user') || key?.includes('email')) {
        const value = localStorage.getItem(key);
        const parsed = JSON.parse(value);
        if (parsed?.email) return parsed.email.split('@')[0];
      }
    }
  } catch (e) {}

  return null;
}
```

**For single-account platforms** (like Claude), simply return `null`.

### DOM Selectors

These are arrays of CSS selectors to find message elements, input fields, and buttons. The content script tries each selector in order until one matches.

#### `userMessageSelectors: string[]`

CSS selectors to find user (human) messages in the conversation. Each selector should match a message container element.

```javascript
userMessageSelectors: [
  '[class*="user-query"]',
  '[class*="user-message"]',
  '[data-role="user"]',
  '[class*="human"]',
  '[role="article"][class*="user"]'
]
```

**Debugging tip**: Open DevTools on the site, select a user message, inspect the element, note its classes and attributes. Add selectors for these patterns.

#### `modelResponseSelectors: string[]`

CSS selectors to find model (AI) responses in the conversation.

```javascript
modelResponseSelectors: [
  '[class*="model-response"]',
  '[class*="assistant-message"]',
  '[data-role="model"]',
  '[data-role="assistant"]',
  '[class*="message"][class*="assistant"]'
]
```

#### `inputSelectors: string[]`

CSS selectors to find the message input field. Usually a `contenteditable div` or `textarea`.

```javascript
inputSelectors: [
  'div[contenteditable="true"][role="textbox"]',
  'textarea[placeholder*="Message"]',
  'textarea[aria-label*="輸入"]',
  'textarea'
]
```

#### `sendButtonSelectors: string[]`

CSS selectors to find the send/submit button. The content script will click this button to submit messages.

```javascript
sendButtonSelectors: [
  'button[aria-label*="Send message"]',
  'button[aria-label*="傳送"]',
  'button[type="submit"]',
  'div[role="button"][aria-label*="Send"]'
]
```

### Scraping and Debug

#### `scraperSelector: string | null`

A quick selector for message content extraction (used by `GET_LAST_RESPONSE` commands). Optional; if `null`, falls back to slower parsing.

```javascript
scraperSelector: '.message-content'
```

#### `debugSelectors: string[]`

A comprehensive list of all selectors used for debugging purposes. Includes all message, input, and button selectors in one array.

```javascript
debugSelectors: [
  '[class*="user-query"]',
  '[class*="user-message"]',
  '[class*="model-response"]',
  '[class*="assistant-message"]',
  '[data-role="user"]',
  '[data-role="assistant"]',
  '[class*="message"]'
]
```

### Typing Simulation

#### `typingConfig: object`

Configuration for human-like typing simulation. Used when sending messages.

```javascript
typingConfig: {
  // Nearby keys on QWERTY keyboard (for simulating typos)
  nearbyKeys: {
    'a': 'sq', 'b': 'vn', 'c': 'xv', 'd': 'sf', 'e': 'wr',
    'f': 'dg', 'g': 'fh', 'h': 'gj', 'i': 'uo', 'j': 'hk',
    'k': 'jl', 'l': 'k;', 'm': 'n,', 'n': 'bm', 'o': 'ip',
    'p': 'o[', 'q': 'wa', 'r': 'et', 's': 'ad', 't': 'ry',
    'u': 'yi', 'v': 'cb', 'w': 'qe', 'x': 'zc', 'y': 'tu',
    'z': 'xa', '1': '2', '2': '13', '3': '24', '4': '35',
    '5': '46', '6': '57', '7': '68', '8': '79', '9': '80', '0': '9'
  },

  // Typo probability (0-1)
  typoRate: 0.05,

  // Pause duration after punctuation (milliseconds)
  pauseAfterPunct: [300, 700],

  // Pause duration after space
  pauseAfterSpace: [80, 250],

  // Normal keystroke interval
  normalDelay: [40, 160],

  // Burst typing interval (faster)
  burstDelay: [20, 60]
}
```

### Conversation Detection

These properties help the extension detect whether a page has an active conversation and extract conversation metadata.

#### `conversationIdAttributes: string[]`

DOM attributes that might contain the conversation ID. The adapter tries each attribute on any element.

```javascript
conversationIdAttributes: ['data-conversation-id', 'data-chat-id', 'data-chatid']
```

#### `hasMessagesSelector: string`

CSS selector to detect if the current page has any messages (i.e., a conversation is loaded).

```javascript
hasMessagesSelector: '[class*="message"], [class*="user-query"], [class*="model-response"]'
```

#### `appPathPattern: string`

URL path segment that indicates a chat/conversation page (vs. home page).

```javascript
appPathPattern: '/app'  // Gemini
appPathPattern: '/chat' // Claude
```

#### `chatIdFromDOM(): string | null`

Extracts conversation ID from the current page's DOM (as fallback if URL parsing fails).

```javascript
chatIdFromDOM() {
  for (const attr of this.conversationIdAttributes) {
    const el = document.querySelector(`[${attr}]`);
    if (el) return el.getAttribute(attr);
  }
  return null;
}
```

### Title Extraction (Sidebar)

These properties help extract conversation titles from the sidebar navigation.

#### `sidebarLinkSelector(chatId: string): string`

Returns a CSS selector to find the sidebar link for a specific conversation.

```javascript
sidebarLinkSelector(chatId) {
  return `a[href*="/app/${chatId}"]`;
}
```

#### `sidebarContainerSelectors: string[]`

Selectors to find sidebar/navigation containers that list all conversations.

```javascript
sidebarContainerSelectors: [
  '[class*="conversation-list"] a[href*="/app/"]',
  '[class*="chat-list"] a[href*="/app/"]',
  '[role="list"] a[href*="/app/"]',
  'ul[class*="conversation"] a[href*="/app/"]'
]
```

#### `selectedItemSelectors(chatId: string): string[]`

Returns selectors to find the currently selected conversation in the sidebar.

```javascript
selectedItemSelectors(chatId) {
  const p = `/app/${chatId}`;
  return [
    `a[href*="${p}"][aria-current="page"]`,
    `[aria-selected="true"] a[href*="${p}"]`,
    `[class*="active"] a[href*="${p}"]`
  ];
}
```

#### `genericTitlePatterns: string[]`

Patterns that commonly appear in default/untitled conversation names. Used to filter out generic titles.

```javascript
genericTitlePatterns: [
  'Gemini', 'Chat', 'Conversation', 'New Chat', 'New',
  '新的對話', '新的', 'Untitled', 'Default'
]
```

#### `navigationTextPatterns: string[]`

Patterns that appear in navigation UI (menu, settings, etc.). Used to exclude non-conversation items.

```javascript
navigationTextPatterns: [
  'Settings', '設定', 'Menu', 'Help', '導航',
  '我的內容', 'Navigation', '選單'
]
```

### Image Extraction

Properties for detecting and downloading generated images from conversations.

#### `generatedImageSelector: string | null`

CSS selector to find generated images. Set to `null` if the site doesn't generate images.

```javascript
generatedImageSelector: '[jslog*="BardVeMetadataKey"]'  // Gemini
generatedImageSelector: null  // Claude (doesn't generate images)
```

#### `isGeneratedImage(el: HTMLElement): boolean`

Helper to determine if an element is a generated image (vs. user-uploaded).

```javascript
isGeneratedImage(el) {
  const jslog = el.getAttribute('jslog') || '';
  return jslog.includes('BardVeMetadataKey');
}
```

#### `extractImageId(el: HTMLElement): string | null`

Extracts a unique ID from a generated image element (used for download tracking).

```javascript
extractImageId(el) {
  const jslog = el.getAttribute('jslog') || '';
  const m = jslog.match(/BardVeMetadataKey:\[\["([^"]+)"/);
  return m ? m[1] : null;
}
```

#### `imageDownloadSelectors: string[]`

Selectors for download/save buttons associated with generated images.

```javascript
imageDownloadSelectors: [
  'button[jslog*="BardVeMetadataKey"]',
  'button.image-button[jslog*="BardVeMetadataKey"]'
]
```

---

## Registration Flow

### Step 1: Create Adapter File

Create a new file following the IIFE (Immediately Invoked Function Expression) pattern to avoid global namespace pollution:

```javascript
// content-site-yoursite.js
(function() {
  'use strict';

  const YourAdapter = {
    name: 'yoursite',
    label: 'Your Site',
    hostPatterns: ['yoursite.com'],
    // ... all properties ...
  };

  if (window.__GAPI_SiteRegistry) {
    window.__GAPI_SiteRegistry.register('yoursite', YourAdapter);
  } else {
    console.error('[YourAdapter] SiteRegistry not found!');
  }
})();
```

### Step 2: Verify Registry Exists

Always check that `window.__GAPI_SiteRegistry` exists before registering. The registry is created by `content-site-registry.js`, which must load first.

```javascript
if (window.__GAPI_SiteRegistry) {
  window.__GAPI_SiteRegistry.register(name, adapter);
}
```

### Step 3: Script Load Order Matters

The `manifest.json` must list scripts in dependency order:

```json
{
  "content_scripts": [
    {
      "matches": ["https://yoursite.com/*"],
      "js": [
        "content-site-registry.js",      // 1. Registry first
        "content-site-gemini.js",        // 2. Adapters
        "content-site-claude.js",        // 3. Adapters
        "content-site-yoursite.js",      // 4. New adapter
        "content.js"                     // 5. Main script last
      ],
      "run_at": "document_idle"
    }
  ]
}
```

---

## Manifest Configuration

To add a new site adapter, update `manifest.json` in two places:

### Update `host_permissions`

Add the site's domain to allow content script injection:

```json
{
  "host_permissions": [
    "https://gemini.google.com/*",
    "https://claude.ai/*",
    "https://yoursite.com/*"        // Add here
  ]
}
```

### Update `content_scripts`

Add the site pattern to `matches` and include the adapter file in `js`:

```json
{
  "content_scripts": [
    {
      "matches": [
        "https://gemini.google.com/*",
        "https://claude.ai/*",
        "https://yoursite.com/*"      // Add here
      ],
      "js": [
        "content-site-registry.js",
        "content-site-gemini.js",
        "content-site-claude.js",
        "content-site-yoursite.js",    // Add here
        "content.js"
      ],
      "run_at": "document_idle"
    }
  ]
}
```

---

## Tab Router Integration

The background service worker uses `tab-router.js` to discover browser tabs by site. To add a new site, update the `SUPPORTED_SITES` configuration:

```javascript
// In tab-router.js
const SUPPORTED_SITES = {
  gemini: {
    name: 'gemini',
    label: 'Google Gemini',
    urlPatterns: ['https://gemini.google.com/*'],
    hostIncludes: 'gemini.google.com'
  },
  claude: {
    name: 'claude',
    label: 'Claude',
    urlPatterns: ['https://claude.ai/*'],
    hostIncludes: 'claude.ai'
  },
  yoursite: {
    name: 'yoursite',
    label: 'Your Site',
    urlPatterns: ['https://yoursite.com/*'],
    hostIncludes: 'yoursite.com'           // Add here
  }
};
```

The router then uses these patterns to:
- Find all tabs for a specific site: `findAllTabsForSite('yoursite')`
- Find all supported tabs: `findAllSupportedTabs()`
- Find a tab for a specific conversation: `findTabForSiteAndChat('yoursite', userProfile, chatId)`

---

## Development Workflow

### Phase 1: Research DOM Structure

Before writing code, inspect the target site's DOM:

1. Open the site in Chrome
2. Open DevTools (F12)
3. Open the Console
4. Inspect a user message: right-click → Inspect
5. Note the element's classes, attributes, and hierarchy
6. Repeat for model response, input field, send button
7. Test selectors in the console:

```javascript
// Test userMessageSelectors
document.querySelectorAll('[class*="user-message"]')

// Test inputSelectors
document.querySelector('div[contenteditable="true"]')
```

### Phase 2: Create Adapter File

Copy the template (provided in section below) and fill in your selectors:

```bash
cp content-site-template.js content-site-yoursite.js
```

### Phase 3: Implement Selectors

Go through each property systematically:

```javascript
const YourAdapter = {
  name: 'yoursite',
  label: 'Your Site',
  hostPatterns: ['yoursite.com'],

  // Test each selector in DevTools console
  userMessageSelectors: [ /* your selectors */ ],
  modelResponseSelectors: [ /* your selectors */ ],
  inputSelectors: [ /* your selectors */ ],
  sendButtonSelectors: [ /* your selectors */ ],

  // ... other properties ...
};
```

### Phase 4: Update manifest.json

Add your site and adapter file:

```json
{
  "host_permissions": ["https://yoursite.com/*"],
  "content_scripts": [{
    "matches": ["https://yoursite.com/*"],
    "js": [
      "content-site-registry.js",
      "content-site-gemini.js",
      "content-site-claude.js",
      "content-site-yoursite.js",
      "content.js"
    ]
  }]
}
```

### Phase 5: Update tab-router.js

Add your site to `SUPPORTED_SITES`.

### Phase 6: Load and Test Extension

1. **In Chrome**: Go to `chrome://extensions/`
2. **Enable Developer Mode** (top right)
3. **Load unpacked**: Select the GAPI directory
4. **Open the site** in a new tab
5. **Open DevTools** → Console
6. **Check for errors**: Look for `[YourAdapter]` messages

### Phase 7: Verify via API

The background service worker exposes a `pages_sync` API endpoint. Query it to verify your adapter is detected:

```javascript
// In Chrome DevTools Console (on the site)
chrome.runtime.sendMessage({ action: 'getPageState' }, (response) => {
  console.log(response);
  // Should show: { site: 'yoursite', chatId: '...', ... }
});
```

---

## Testing Checklist

Before declaring an adapter complete, verify all functionality:

- [ ] **Site detection**: Extension correctly identifies the site when you load it
- [ ] **User message finding**: All user messages are detected with `userMessageSelectors`
- [ ] **Model response finding**: All model responses are detected with `modelResponseSelectors`
- [ ] **Input field location**: Input field is found and can receive focus
- [ ] **Send button location**: Send button is clickable
- [ ] **Chat ID extraction**: URL parsing correctly extracts conversation ID
- [ ] **Fallback extraction**: `chatIdFromDOM()` works if URL parsing fails
- [ ] **Sidebar title extraction**: Conversation titles are readable from sidebar links
- [ ] **Multi-user support** (if applicable): User detection works for multiple accounts
- [ ] **Pages sync API**: Background worker correctly reports the site in `pages_sync` response
- [ ] **No console errors**: No JavaScript errors or warnings related to your adapter
- [ ] **Content script injection**: Verify in DevTools Network tab that all scripts load
- [ ] **No false positives**: Ensure selectors don't match unrelated elements

---

## Template

Copy this template to create a new adapter:

```javascript
// content-site-yoursite.js
// Your Site Adapter

(function() {
  'use strict';

  const YourSiteAdapter = {
    name: 'yoursite',
    label: 'Your Site',
    hostPatterns: ['yoursite.com'],

    // ========== URL Tools ==========

    isOnSite(url) {
      return (url || '').includes('yoursite.com');
    },

    getChatIdFromUrl(url) {
      try {
        if (!url) return null;
        // Extract chat ID from URL pattern: https://yoursite.com/chat/{id}
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

    // ========== User Detection ==========

    detectUserProfile() {
      // For single-account platforms, return null
      // For multi-account, extract user ID from DOM or localStorage
      try {
        const userEmail = document.querySelector('[data-user-email]')?.getAttribute('data-user-email');
        if (userEmail) return userEmail.split('@')[0];
      } catch (e) {}
      return null;
    },

    // ========== DOM Selectors ==========

    userMessageSelectors: [
      '[class*="user-message"]',
      '[data-role="user"]',
      '[class*="human"]'
    ],

    modelResponseSelectors: [
      '[class*="assistant-message"]',
      '[data-role="assistant"]',
      '[class*="model"]'
    ],

    inputSelectors: [
      'div[contenteditable="true"][role="textbox"]',
      'textarea[placeholder*="Message"]',
      'textarea'
    ],

    sendButtonSelectors: [
      'button[aria-label*="Send"]',
      'button[type="submit"]',
      'div[role="button"][aria-label*="Send"]'
    ],

    scraperSelector: '.message-content',

    debugSelectors: [
      '[class*="user-message"]',
      '[class*="assistant-message"]',
      '[data-role="user"]',
      '[data-role="assistant"]',
      '[class*="message"]'
    ],

    // ========== Typing Simulation ==========

    typingConfig: {
      nearbyKeys: {
        'a': 'sq', 'b': 'vn', 'c': 'xv', 'd': 'sf', 'e': 'wr',
        'f': 'dg', 'g': 'fh', 'h': 'gj', 'i': 'uo', 'j': 'hk',
        'k': 'jl', 'l': 'k;', 'm': 'n,', 'n': 'bm', 'o': 'ip',
        'p': 'o[', 'q': 'wa', 'r': 'et', 's': 'ad', 't': 'ry',
        'u': 'yi', 'v': 'cb', 'w': 'qe', 'x': 'zc', 'y': 'tu',
        'z': 'xa', '1': '2', '2': '13', '3': '24', '4': '35',
        '5': '46', '6': '57', '7': '68', '8': '79', '9': '80', '0': '9'
      },
      typoRate: 0.05,
      pauseAfterPunct: [300, 700],
      pauseAfterSpace: [80, 250],
      normalDelay: [40, 160],
      burstDelay: [20, 60]
    },

    // ========== Conversation Detection ==========

    conversationIdAttributes: ['data-conversation-id', 'data-chat-id'],
    hasMessagesSelector: '[class*="message"]',
    appPathPattern: '/chat',

    chatIdFromDOM() {
      for (const attr of this.conversationIdAttributes) {
        const el = document.querySelector(`[${attr}]`);
        if (el) return el.getAttribute(attr);
      }
      return null;
    },

    // ========== Title Extraction ==========

    sidebarLinkSelector(chatId) {
      return `a[href*="/chat/${chatId}"]`;
    },

    sidebarContainerSelectors: [
      'nav a[href*="/chat/"]',
      '[class*="sidebar"] a[href*="/chat/"]',
      '[role="navigation"] a[href*="/chat/"]'
    ],

    selectedItemSelectors(chatId) {
      return [
        `a[href*="/chat/${chatId}"][aria-current="page"]`,
        `[aria-selected="true"] a[href*="/chat/${chatId}"]`,
        `[class*="active"] a[href*="/chat/${chatId}"]`
      ];
    },

    genericTitlePatterns: [
      'New Chat', 'Untitled', 'Default', 'New',
      '新的對話', '新的'
    ],

    navigationTextPatterns: [
      'Settings', 'Help', 'Menu', '設定', '幫助', '選單'
    ],

    // ========== Image Extraction ==========

    generatedImageSelector: '[class*="generated-image"]',

    isGeneratedImage(el) {
      return el.classList.contains('generated-image');
    },

    extractImageId(el) {
      return el.getAttribute('data-image-id');
    },

    imageDownloadSelectors: [
      'button[data-image-download]',
      'button[aria-label*="Download"]'
    ]
  };

  // Register adapter
  if (window.__GAPI_SiteRegistry) {
    window.__GAPI_SiteRegistry.register('yoursite', YourSiteAdapter);
  } else {
    console.error('[YourSiteAdapter] SiteRegistry not found!');
  }
})();
```

---

## Known Gotchas

### Shadow DOM Issues

Some frameworks use Shadow DOM, which is hidden from normal `document.querySelector()`. If selectors aren't finding elements:

```javascript
// Check for Shadow DOM
const element = document.querySelector('[class*="message"]');
if (element && element.shadowRoot) {
  // Shadow DOM detected, need different approach
  const shadowChild = element.shadowRoot.querySelector('.child');
}
```

Workaround: Use `document.querySelectorAll()` and manually traverse, or target elements outside the Shadow DOM.

### Dynamic Class Names (CSS Modules)

Many modern sites use hashed CSS classes like `_abc12def_message` that change on every build. These are hard to target. Instead:

1. **Use data attributes**: Look for `data-testid`, `data-role`, `data-message-type`
2. **Use stable parents**: Target by role or ARIA attributes
3. **Use partial matching**: `[class*="message"]` matches any class containing "message"

```javascript
// Instead of:
// '.xyz12345_message'

// Use:
'[class*="message"]'
'[data-testid="user-message"]'
'[role="article"]'
```

### Single Page Application (SPA) Navigation

When a SPA changes routes without reloading, the DOM might be recreated. The content script must handle:

1. **Mutation observers**: Detect DOM changes
2. **Event listeners**: Listen to navigation events
3. **Periodic checks**: Poll for changes

Example (if needed by your adapter):

```javascript
detectMessageChanges() {
  const observer = new MutationObserver(() => {
    const messages = document.querySelectorAll(this.userMessageSelectors[0]);
    console.log(`Detected ${messages.length} messages`);
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true
  });
}
```

### Content Script Injection Timing

Content scripts run at `document_idle` (after page load). However, some sites dynamically inject content later. If selectors aren't finding elements:

1. **Wait longer**: Use `setTimeout()` to retry after initial load
2. **Check DOM readiness**: Verify `document.body` exists
3. **Use mutation observers**: Detect when content is added

```javascript
function waitForElement(selector, timeout = 5000) {
  return new Promise((resolve) => {
    if (document.querySelector(selector)) {
      resolve(document.querySelector(selector));
      return;
    }

    const observer = new MutationObserver(() => {
      const el = document.querySelector(selector);
      if (el) {
        observer.disconnect();
        resolve(el);
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });

    setTimeout(() => {
      observer.disconnect();
      resolve(null);
    }, timeout);
  });
}
```

### ProseMirror vs Textarea Input

Some sites use rich text editors (ProseMirror, Draft.js) instead of plain textareas. These require special handling:

1. **Target contenteditable divs**: `div[contenteditable="true"]`
2. **Simulate input events**: `dispatchEvent(new InputEvent('input', { ... }))`
3. **Handle paste events**: `dispatchEvent(new ClipboardEvent('paste', { ... }))`

Avoid assuming `textarea` exists. Modern chat apps typically use `div[contenteditable="true"]`.

### Tab Router Pinged/Pong Issues

The background worker uses `pingGeminiTab()` to check if a tab is responsive. If this fails:

1. **Ensure content script loaded**: Check DevTools Console on the tab
2. **Verify message listeners**: Content script should have `chrome.runtime.onMessage.addListener()`
3. **Check extension context**: If extension reloads, old tabs become unresponsive

---

## Reference Implementation: Gemini Adapter

The Gemini adapter in `content-site-gemini.js` is a complete, production-ready example. Key patterns:

```javascript
// 1. IIFE wraps everything
(function() {
  'use strict';

  const GeminiAdapter = {
    // 2. All required properties implemented
    name: 'gemini',
    label: 'Google Gemini',
    hostPatterns: ['gemini.google.com'],

    // 3. Multiple fallback selectors
    userMessageSelectors: [
      '[class*="user-query"]',
      '[class*="userQuery"]',
      '[class*="user_query"]',
      '[class*="user-message"]',
      // ... many more
    ],

    // 4. User detection with multiple strategies
    detectUserProfile() {
      // Try URL first, then DOM, then localStorage
      // ...
    },

    // 5. Conversation detection
    chatIdFromDOM() {
      // Fallback if URL parsing fails
      // ...
    },
  };

  // 6. Safe registration with error handling
  if (window.__GAPI_SiteRegistry) {
    window.__GAPI_SiteRegistry.register('gemini', GeminiAdapter);
  } else {
    console.error('[GeminiAdapter] SiteRegistry not found!');
  }
})();
```

Study this file as your primary reference when implementing new adapters.

---

## Troubleshooting

### Adapter Not Detected

**Symptom**: Console shows `[SiteRegistry] Detected site: null`

**Solution**:
1. Check `hostPatterns` in your adapter matches the current URL
2. Verify script load order in manifest.json
3. Check DevTools Console for adapter registration messages

```javascript
// In console:
window.__GAPI_SiteRegistry.listAdapters()  // Should include your adapter
window.__GAPI_SiteRegistry.detectCurrentSite()  // Should return your adapter name
```

### Selectors Not Finding Elements

**Symptom**: Content script can't find messages, input field, or send button

**Solution**:
1. Inspect elements in DevTools
2. Test selectors in Console:
   ```javascript
   document.querySelectorAll('[class*="user-message"]')  // Should find elements
   ```
3. Add more fallback selectors
4. Check for Shadow DOM

### Script Injection Fails

**Symptom**: Content script doesn't load at all

**Solution**:
1. Verify `manifest.json` has correct `matches` pattern
2. Verify `host_permissions` includes the site
3. Check Chrome's extension error log: `chrome://extensions/` → your extension → "Errors"

---

## Checklist for Submission

Before committing a new adapter:

- [ ] All required properties implemented (see Adapter Interface section)
- [ ] All CSS selectors tested and working
- [ ] `manifest.json` updated with `host_permissions` and `content_scripts`
- [ ] `tab-router.js` updated with `SUPPORTED_SITES` entry
- [ ] No console errors on the target site
- [ ] All testing checklist items passed
- [ ] Code follows IIFE pattern and doesn't pollute global namespace
- [ ] Error handling is defensive (all methods return null on failure)
- [ ] Comments explain non-obvious selectors or logic
- [ ] Selectors include multiple fallbacks (at least 3-5 per property)
- [ ] README or comments document the site-specific quirks (if any)

---

## Additional Resources

- **Chrome Extension Manifest V3 Docs**: https://developer.chrome.com/docs/extensions/mv3/
- **CSS Selectors Guide**: https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_Selectors
- **DevTools Inspector**: F12 in Chrome, then Inspect Elements
- **Content Scripts**: https://developer.chrome.com/docs/extensions/mv3/content_scripts/

---

## Questions?

If you encounter issues not covered in this spec:

1. Check the Gemini adapter (`content-site-gemini.js`) for patterns
2. Review the gotchas section above
3. Test selectors in Chrome DevTools Console
4. Check extension errors at `chrome://extensions/`
5. Refer to site's HTML structure and framework documentation
