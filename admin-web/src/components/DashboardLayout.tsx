import React from 'react';
import type { PageId, StatusResponse } from '../types';

interface NavTab {
  id: PageId;
  label: string;
}

const ALL_TABS: NavTab[] = [
  { id: 'conversations', label: '對話' },
  { id: 'api-keys', label: 'API Keys' },
  { id: 'site-config', label: '網站設定' },
  { id: 'tab-manager', label: 'Tab Manager' },
  { id: 'settings', label: '設定' },
];

interface DashboardLayoutProps {
  children: React.ReactNode;
  activePage: PageId;
  onNavigate: (page: PageId) => void;
  serverStatus: StatusResponse | null;
  isAuthenticated: boolean;
}

export function DashboardLayout({
  children,
  activePage,
  onNavigate,
  serverStatus,
  isAuthenticated,
}: DashboardLayoutProps) {
  const visibleTabs = isAuthenticated ? ALL_TABS : ALL_TABS.filter((t) => t.id === 'settings');

  return (
    <div className="dashboard-layout">
      <header className="dashboard-header">
        <div className="header-content">
          <h1 className="header-title">GAPI 管理面板</h1>
          <div className="header-meta">
            {serverStatus ? (
              <span className="status-pill ok">
                {serverStatus.service} v{serverStatus.version}
              </span>
            ) : (
              <span className="status-pill warn">未連線</span>
            )}
          </div>
        </div>
        <nav className="nav-tabs" role="tablist" aria-label="Main navigation">
          {visibleTabs.map((tab) => (
            <button
              key={tab.id}
              role="tab"
              aria-selected={activePage === tab.id}
              className={`nav-tab${activePage === tab.id ? ' nav-tab-active' : ''}`}
              onClick={() => onNavigate(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </header>
      <main className="dashboard-main">{children}</main>
    </div>
  );
}
