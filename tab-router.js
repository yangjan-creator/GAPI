// Tab Router
// Background importScripts 模組，抽象化分頁查詢
// 取代 background.js 中寫死的 gemini.google.com URL 查詢

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
  nebula: {
    name: 'nebula',
    label: 'Nebula',
    urlPatterns: ['https://www.nebula.gg/*'],
    hostIncludes: 'nebula.gg'
  }
};

function getSiteFromUrl(url) {
  if (!url) return null;
  for (const [name, site] of Object.entries(SUPPORTED_SITES)) {
    if (url.includes(site.hostIncludes)) return name;
  }
  return null;
}

async function findAllTabsForSite(siteName) {
  const site = SUPPORTED_SITES[siteName];
  if (!site) return [];
  const tabs = await chrome.tabs.query({ url: site.urlPatterns });
  return tabs || [];
}

async function findAllSupportedTabs() {
  const allPatterns = Object.values(SUPPORTED_SITES).flatMap(s => s.urlPatterns);
  const tabs = await chrome.tabs.query({ url: allPatterns });
  return (tabs || []).map(t => ({
    ...t,
    site: getSiteFromUrl(t.url) || 'unknown'
  }));
}

async function findTabForSite(siteName, userProfile) {
  const tabs = await findAllTabsForSite(siteName);
  if (!tabs || tabs.length === 0) return null;
  const wanted = userProfile || 'default';
  for (const t of tabs) {
    const p = parseUserProfileFromUrl(t.url || '') || 'default';
    if (p === wanted) return t;
  }
  return tabs[0] || null;
}

async function findTabForSiteAndChat(siteName, userProfile, chatId) {
  const tabs = await findAllTabsForSite(siteName);
  if (!tabs || tabs.length === 0) return null;

  const wantedProfile = userProfile || 'default';
  const wantedChatId = String(chatId || '');

  for (const t of tabs) {
    const p = parseUserProfileFromUrl(t.url || '') || 'default';
    const c = parseChatIdFromUrl(t.url || '');
    if (p === wantedProfile && c === wantedChatId) return t;
  }

  for (const t of tabs) {
    const p = parseUserProfileFromUrl(t.url || '') || 'default';
    if (p !== wantedProfile) continue;
    const resp = await pingGeminiTab(t.id);
    if (resp && resp.status === 'ok' && String(resp.chatId || '') === wantedChatId) return t;
  }

  for (const t of tabs) {
    const p = parseUserProfileFromUrl(t.url || '') || 'default';
    if (p === wantedProfile) return t;
  }

  return tabs[0] || null;
}

async function findTabById(tabId) {
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    return null;
  }
}
