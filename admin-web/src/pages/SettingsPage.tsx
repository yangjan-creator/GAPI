import React, { useState } from 'react';
import type { StatusResponse } from '../types';
import { GapiClient, GapiError } from '../client';

interface SettingsPageProps {
  apiKey: string;
  baseUrl: string;
  defaultBaseUrl: string;
  serverStatus: StatusResponse | null;
  onSave: (apiKey: string, baseUrl: string) => void;
  onLogout: () => void;
}

export function SettingsPage({
  apiKey,
  baseUrl,
  defaultBaseUrl,
  serverStatus,
  onSave,
  onLogout,
}: SettingsPageProps) {
  const [draftKey, setDraftKey] = useState(apiKey);
  const [draftUrl, setDraftUrl] = useState(baseUrl || defaultBaseUrl);
  const [showKey, setShowKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  const handleTest = async () => {
    if (!draftKey.trim() || !draftUrl.trim()) return;
    setTesting(true);
    setTestResult(null);
    try {
      const client = new GapiClient(draftUrl.trim(), draftKey.trim());
      const [validation, status] = await Promise.all([
        client.validateApiKey(draftKey.trim()),
        client.getStatus(),
      ]);
      if (validation.valid) {
        setTestResult({
          ok: true,
          message: `連線成功 - ${status.service} v${status.version}（Key: ${validation.name || validation.key_id}）`,
        });
      } else {
        setTestResult({ ok: false, message: 'API Key 無效' });
      }
    } catch (e) {
      const msg = e instanceof GapiError ? e.message : (e instanceof Error ? e.message : String(e));
      setTestResult({ ok: false, message: `連線失敗: ${msg}` });
    } finally {
      setTesting(false);
    }
  };

  const handleSave = () => {
    onSave(draftKey.trim(), draftUrl.trim());
  };

  return (
    <div className="page-settings">
      <div className="dashboard-section">
        <div className="section-header">
          <h2>伺服器連線設定</h2>
        </div>

        <div className="settings-form">
          <div className="form-group">
            <label htmlFor="settings-url">Server URL</label>
            <input
              id="settings-url"
              className="input"
              type="url"
              value={draftUrl}
              onChange={(e) => setDraftUrl(e.target.value)}
              placeholder={defaultBaseUrl}
            />
          </div>

          <div className="form-group">
            <label htmlFor="settings-key">API Key</label>
            <div className="input-with-toggle">
              <input
                id="settings-key"
                className="input"
                type={showKey ? 'text' : 'password'}
                value={draftKey}
                onChange={(e) => setDraftKey(e.target.value)}
                placeholder="gapi_..."
                autoComplete="off"
              />
              <button
                type="button"
                className="btn-toggle-vis"
                onClick={() => setShowKey((v) => !v)}
                aria-label={showKey ? '隱藏 API Key' : '顯示 API Key'}
              >
                {showKey ? '隱藏' : '顯示'}
              </button>
            </div>
          </div>

          <div className="settings-actions">
            <button
              className="btn"
              onClick={handleTest}
              disabled={testing || !draftKey.trim() || !draftUrl.trim()}
            >
              {testing ? '測試中...' : '測試連線'}
            </button>
            <button
              className="btn-primary"
              onClick={handleSave}
              disabled={!draftKey.trim() || !draftUrl.trim()}
            >
              儲存
            </button>
            {apiKey && (
              <button className="btn btn-danger" onClick={onLogout}>
                登出
              </button>
            )}
          </div>

          {testResult && (
            <div
              className={`test-result ${testResult.ok ? 'test-ok' : 'test-fail'}`}
              role="status"
              aria-live="polite"
            >
              {testResult.message}
            </div>
          )}
        </div>
      </div>

      {serverStatus && (
        <div className="dashboard-section" style={{ marginTop: '16px' }}>
          <div className="section-header">
            <h2>伺服器狀態</h2>
          </div>
          <div className="status-info">
            <div className="status-row">
              <span className="status-label">服務</span>
              <span>{serverStatus.service}</span>
            </div>
            <div className="status-row">
              <span className="status-label">版本</span>
              <span>{serverStatus.version}</span>
            </div>
            <div className="status-row">
              <span className="status-label">狀態</span>
              <span className="status-pill ok">{serverStatus.status}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
