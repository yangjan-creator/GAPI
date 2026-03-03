import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { PageId, StatusResponse } from './types';
import { GapiClient } from './client';
import { DashboardLayout } from './components/DashboardLayout';
import { SettingsPage } from './pages/SettingsPage';
import { ConversationsPage } from './pages/ConversationsPage';
import { ApiKeysPage } from './pages/ApiKeysPage';
import { SiteConfigPage } from './pages/SiteConfigPage';
import { TabManagerPage } from './pages/TabManagerPage';

const LS_KEY_API_KEY = 'gapi_admin_api_key';
const LS_KEY_BASE_URL = 'gapi_admin_base_url';
const DEFAULT_BASE_URL = 'http://localhost:18799';
const STATUS_POLL_INTERVAL = 30_000;

export function App() {
  const [apiKey, setApiKey] = useState<string>(() => localStorage.getItem(LS_KEY_API_KEY) || '');
  const [baseUrl, setBaseUrl] = useState<string>(() => localStorage.getItem(LS_KEY_BASE_URL) || DEFAULT_BASE_URL);
  const [activePage, setActivePage] = useState<PageId>(() => (apiKey ? 'conversations' : 'settings'));
  const [serverStatus, setServerStatus] = useState<StatusResponse | null>(null);

  const client = useMemo(() => {
    if (!apiKey || !baseUrl) return null;
    return new GapiClient(baseUrl, apiKey);
  }, [apiKey, baseUrl]);

  const isAuthenticated = !!apiKey && !!client;

  const handleSaveSettings = useCallback((newApiKey: string, newBaseUrl: string) => {
    setApiKey(newApiKey);
    setBaseUrl(newBaseUrl);
    localStorage.setItem(LS_KEY_API_KEY, newApiKey);
    localStorage.setItem(LS_KEY_BASE_URL, newBaseUrl);
    if (newApiKey) setActivePage('conversations');
  }, []);

  const handleLogout = useCallback(() => {
    setApiKey('');
    localStorage.removeItem(LS_KEY_API_KEY);
    setServerStatus(null);
    setActivePage('settings');
  }, []);

  // Status polling
  useEffect(() => {
    if (!client) return;

    let stopped = false;
    const poll = async () => {
      if (stopped || document.hidden) return;
      try {
        const status = await client.getStatus();
        if (!stopped) setServerStatus(status);
      } catch {
        if (!stopped) setServerStatus(null);
      }
    };

    poll();
    const timer = window.setInterval(poll, STATUS_POLL_INTERVAL);
    const onVisibility = () => {
      if (!document.hidden) poll();
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      stopped = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [client]);

  // Force settings page when not authenticated
  useEffect(() => {
    if (!isAuthenticated && activePage !== 'settings') {
      setActivePage('settings');
    }
  }, [isAuthenticated, activePage]);

  const renderPage = () => {
    switch (activePage) {
      case 'conversations':
        return client ? <ConversationsPage client={client} /> : null;
      case 'api-keys':
        return client ? <ApiKeysPage client={client} /> : null;
      case 'site-config':
        return client ? <SiteConfigPage client={client} /> : null;
      case 'tab-manager':
        return client ? <TabManagerPage client={client} /> : null;
      case 'settings':
        return (
          <SettingsPage
            apiKey={apiKey}
            baseUrl={baseUrl}
            defaultBaseUrl={DEFAULT_BASE_URL}
            serverStatus={serverStatus}
            onSave={handleSaveSettings}
            onLogout={handleLogout}
          />
        );
      default:
        return null;
    }
  };

  return (
    <DashboardLayout
      activePage={activePage}
      onNavigate={setActivePage}
      serverStatus={serverStatus}
      isAuthenticated={isAuthenticated}
    >
      {renderPage()}
    </DashboardLayout>
  );
}
