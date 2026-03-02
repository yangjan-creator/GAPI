import React, { useCallback, useEffect, useState } from 'react';
import type { SiteConfig } from '../types';
import type { GapiClient } from '../client';

interface SiteConfigPageProps {
  client: GapiClient;
}

const EMPTY_SELECTORS = { content: '', title: '', messages: '', input: '' };

interface FormState {
  id: string;
  name: string;
  url_pattern: string;
  selectors: { content: string; title: string; messages: string; input: string };
  enabled: boolean;
}

const EMPTY_FORM: FormState = {
  id: '',
  name: '',
  url_pattern: '',
  selectors: { ...EMPTY_SELECTORS },
  enabled: true,
};

export function SiteConfigPage({ client }: SiteConfigPageProps) {
  const [configs, setConfigs] = useState<SiteConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const loadConfigs = useCallback(async () => {
    try {
      const data = await client.listSiteConfigs();
      setConfigs(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    loadConfigs();
  }, [loadConfigs]);

  const handleNew = () => {
    setEditing({ ...EMPTY_FORM });
  };

  const handleEdit = (config: SiteConfig) => {
    setEditing({
      id: config.id,
      name: config.name,
      url_pattern: config.url_pattern,
      selectors: {
        content: config.selectors.content || '',
        title: config.selectors.title || '',
        messages: config.selectors.messages || '',
        input: config.selectors.input || '',
      },
      enabled: config.enabled,
    });
  };

  const handleSave = async () => {
    if (!editing || !editing.name.trim() || !editing.url_pattern.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const selectors: Record<string, string> = {};
      if (editing.selectors.content) selectors.content = editing.selectors.content;
      if (editing.selectors.title) selectors.title = editing.selectors.title;
      if (editing.selectors.messages) selectors.messages = editing.selectors.messages;
      if (editing.selectors.input) selectors.input = editing.selectors.input;

      await client.saveSiteConfig({
        id: editing.id || `site_${Date.now().toString(36)}`,
        url_pattern: editing.url_pattern.trim(),
        name: editing.name.trim(),
        selectors,
        enabled: editing.enabled,
      });
      setEditing(null);
      await loadConfigs();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    setError(null);
    try {
      await client.deleteSiteConfig(id);
      setConfirmDelete(null);
      await loadConfigs();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleToggle = async (config: SiteConfig) => {
    setError(null);
    try {
      await client.saveSiteConfig({
        id: config.id,
        url_pattern: config.url_pattern,
        name: config.name,
        selectors: config.selectors,
        enabled: !config.enabled,
      });
      await loadConfigs();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const updateField = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setEditing((prev) => (prev ? { ...prev, [key]: value } : null));
  };

  const updateSelector = (key: keyof FormState['selectors'], value: string) => {
    setEditing((prev) =>
      prev ? { ...prev, selectors: { ...prev.selectors, [key]: value } } : null,
    );
  };

  return (
    <div className="page-site-config">
      {error && (
        <div className="toast-error" role="alert" aria-live="assertive">
          <div className="toast-title">Error</div>
          <div className="toast-msg">{error}</div>
          <button className="btn-close" onClick={() => setError(null)} aria-label="關閉錯誤訊息">
            &times;
          </button>
        </div>
      )}

      {/* Edit/Create Form */}
      {editing && (
        <div className="dashboard-section" style={{ marginBottom: '16px' }}>
          <div className="section-header">
            <h2>{editing.id ? '編輯網站設定' : '新增網站設定'}</h2>
            <button className="btn" onClick={() => setEditing(null)}>取消</button>
          </div>
          <div className="site-form">
            <div className="form-group">
              <label htmlFor="site-name">名稱</label>
              <input
                id="site-name"
                className="input"
                type="text"
                value={editing.name}
                onChange={(e) => updateField('name', e.target.value)}
                placeholder="例：Gemini"
              />
            </div>
            <div className="form-group">
              <label htmlFor="site-pattern">URL Pattern</label>
              <input
                id="site-pattern"
                className="input"
                type="text"
                value={editing.url_pattern}
                onChange={(e) => updateField('url_pattern', e.target.value)}
                placeholder="例：https://gemini.google.com/*"
              />
            </div>

            <fieldset className="selectors-fieldset">
              <legend>CSS Selectors</legend>
              <div className="form-group">
                <label htmlFor="sel-content">Content</label>
                <input
                  id="sel-content"
                  className="input mono"
                  type="text"
                  value={editing.selectors.content}
                  onChange={(e) => updateSelector('content', e.target.value)}
                  placeholder=".conversation-container"
                />
              </div>
              <div className="form-group">
                <label htmlFor="sel-title">Title</label>
                <input
                  id="sel-title"
                  className="input mono"
                  type="text"
                  value={editing.selectors.title}
                  onChange={(e) => updateSelector('title', e.target.value)}
                  placeholder=".conversation-title"
                />
              </div>
              <div className="form-group">
                <label htmlFor="sel-messages">Messages</label>
                <input
                  id="sel-messages"
                  className="input mono"
                  type="text"
                  value={editing.selectors.messages}
                  onChange={(e) => updateSelector('messages', e.target.value)}
                  placeholder=".message-content"
                />
              </div>
              <div className="form-group">
                <label htmlFor="sel-input">Input</label>
                <input
                  id="sel-input"
                  className="input mono"
                  type="text"
                  value={editing.selectors.input}
                  onChange={(e) => updateSelector('input', e.target.value)}
                  placeholder=".ql-editor"
                />
              </div>
            </fieldset>

            <div className="form-group form-toggle">
              <label>
                <input
                  type="checkbox"
                  checked={editing.enabled}
                  onChange={(e) => updateField('enabled', e.target.checked)}
                />
                <span>啟用</span>
              </label>
            </div>

            <div className="settings-actions">
              <button
                className="btn-primary"
                onClick={handleSave}
                disabled={saving || !editing.name.trim() || !editing.url_pattern.trim()}
              >
                {saving ? '儲存中...' : '儲存'}
              </button>
              <button className="btn" onClick={() => setEditing(null)}>取消</button>
            </div>
          </div>
        </div>
      )}

      {/* Config List */}
      <div className="dashboard-section">
        <div className="section-header">
          <h2>網站設定</h2>
          {!editing && (
            <button className="btn-primary" onClick={handleNew}>新增網站</button>
          )}
        </div>

        {loading ? (
          <div className="empty">載入中...</div>
        ) : configs.length === 0 ? (
          <div className="empty">尚無網站設定，點擊「新增網站」開始配置</div>
        ) : (
          <div className="site-config-list">
            {configs.map((config) => (
              <div key={config.id} className={`site-card${config.enabled ? '' : ' site-disabled'}`}>
                <div className="site-card-header">
                  <div className="site-card-title">
                    <strong>{config.name}</strong>
                    <span className={`status-pill ${config.enabled ? 'ok' : 'warn'}`}>
                      {config.enabled ? '啟用' : '停用'}
                    </span>
                  </div>
                  <div className="site-card-actions">
                    <button className="btn" onClick={() => handleToggle(config)}>
                      {config.enabled ? '停用' : '啟用'}
                    </button>
                    <button className="btn" onClick={() => handleEdit(config)}>編輯</button>
                    {confirmDelete === config.id ? (
                      <>
                        <button className="btn btn-danger" onClick={() => handleDelete(config.id)}>
                          確認刪除
                        </button>
                        <button className="btn" onClick={() => setConfirmDelete(null)}>取消</button>
                      </>
                    ) : (
                      <button className="btn btn-danger" onClick={() => setConfirmDelete(config.id)}>
                        刪除
                      </button>
                    )}
                  </div>
                </div>
                <div className="site-card-url mono">{config.url_pattern}</div>
                {config.selectors && Object.keys(config.selectors).length > 0 && (
                  <div className="site-card-selectors">
                    {Object.entries(config.selectors).map(([key, val]) =>
                      val ? (
                        <span key={key} className="selector-tag">
                          <span className="selector-key">{key}:</span> {val}
                        </span>
                      ) : null,
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
