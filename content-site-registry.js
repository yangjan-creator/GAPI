// Content Site Registry
// adapter 登錄中心，提供站點偵測與 adapter 查詢

(function() {
  'use strict';

  const adapters = {};
  let currentAdapter = null;
  let currentSiteName = null;

  const registry = {
    register(name, adapter) {
      if (!name || !adapter) {
        console.warn('[SiteRegistry] register: name and adapter are required');
        return;
      }
      adapters[name] = adapter;
      console.log('[SiteRegistry] Registered adapter:', name);
    },

    detectCurrentSite() {
      const hostname = window.location.hostname;
      for (const [name, adapter] of Object.entries(adapters)) {
        if (adapter.hostPatterns && adapter.hostPatterns.some(p => hostname.includes(p))) {
          currentSiteName = name;
          currentAdapter = adapter;
          console.log('[SiteRegistry] Detected site:', name);
          return name;
        }
      }
      currentSiteName = null;
      currentAdapter = null;
      return null;
    },

    getCurrentAdapter() {
      if (!currentAdapter) {
        this.detectCurrentSite();
      }
      return currentAdapter;
    },

    getCurrentSiteName() {
      if (!currentSiteName) {
        this.detectCurrentSite();
      }
      return currentSiteName;
    },

    getAdapter(name) {
      return adapters[name] || null;
    },

    listAdapters() {
      return Object.keys(adapters);
    }
  };

  window.__GAPI_SiteRegistry = registry;
})();
