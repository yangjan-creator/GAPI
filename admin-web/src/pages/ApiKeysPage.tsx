import React, { useCallback, useEffect, useState } from 'react';
import type { ApiKeyInfo, ApiKeyCreateResponse } from '../types';
import type { GapiClient } from '../client';

interface ApiKeysPageProps {
  client: GapiClient;
}

export function ApiKeysPage({ client }: ApiKeysPageProps) {
  const [keys, setKeys] = useState<ApiKeyInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Create form
  const [newName, setNewName] = useState('');
  const [newExpireDays, setNewExpireDays] = useState('');
  const [creating, setCreating] = useState(false);
  const [createdKey, setCreatedKey] = useState<ApiKeyCreateResponse | null>(null);
  const [copied, setCopied] = useState(false);

  // Revoke confirmation
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);

  const loadKeys = useCallback(async () => {
    try {
      const data = await client.listApiKeys();
      setKeys(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    loadKeys();
  }, [loadKeys]);

  const handleCreate = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    setError(null);
    setCreatedKey(null);
    try {
      const days = newExpireDays ? parseInt(newExpireDays, 10) : undefined;
      const result = await client.createApiKey(newName.trim(), days);
      setCreatedKey(result);
      setNewName('');
      setNewExpireDays('');
      await loadKeys();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  };

  const handleRevoke = async (keyId: string) => {
    setError(null);
    try {
      await client.revokeApiKey(keyId);
      setConfirmRevoke(null);
      await loadKeys();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleCopy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // fallback: do nothing
    }
  };

  const formatTime = (ts: number) => {
    try {
      return new Date(ts).toLocaleString('zh-TW');
    } catch {
      return '';
    }
  };

  return (
    <div className="page-api-keys">
      {error && (
        <div className="toast-error" role="alert" aria-live="assertive">
          <div className="toast-title">Error</div>
          <div className="toast-msg">{error}</div>
          <button className="btn-close" onClick={() => setError(null)} aria-label="關閉錯誤訊息">
            &times;
          </button>
        </div>
      )}

      {/* Create Key */}
      <div className="dashboard-section">
        <div className="section-header">
          <h2>建立 API Key</h2>
        </div>
        <div className="create-key-form">
          <div className="form-group">
            <label htmlFor="key-name">名稱</label>
            <input
              id="key-name"
              className="input"
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="例：admin-dashboard"
              disabled={creating}
            />
          </div>
          <div className="form-group">
            <label htmlFor="key-expire">過期天數 (可選)</label>
            <input
              id="key-expire"
              className="input"
              type="number"
              min="1"
              value={newExpireDays}
              onChange={(e) => setNewExpireDays(e.target.value)}
              placeholder="留空 = 永不過期"
              disabled={creating}
            />
          </div>
          <button className="btn-primary" onClick={handleCreate} disabled={creating || !newName.trim()}>
            {creating ? '建立中...' : '建立'}
          </button>
        </div>

        {createdKey && (
          <div className="created-key-display" role="status" aria-live="polite">
            <div className="created-key-warning">
              請立即複製此 API Key，之後將無法再次查看：
            </div>
            <div className="created-key-value">
              <code>{createdKey.api_key}</code>
              <button className="btn" onClick={() => handleCopy(createdKey.api_key)}>
                {copied ? '已複製' : '複製'}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Key List */}
      <div className="dashboard-section" style={{ marginTop: '16px' }}>
        <div className="section-header">
          <h2>API Keys</h2>
        </div>

        {loading ? (
          <div className="empty">載入中...</div>
        ) : keys.length === 0 ? (
          <div className="empty">尚無 API Key</div>
        ) : (
          <div className="keys-table-wrapper">
            <table className="keys-table" role="table">
              <thead>
                <tr>
                  <th scope="col">Key ID</th>
                  <th scope="col">名稱</th>
                  <th scope="col">建立時間</th>
                  <th scope="col">過期時間</th>
                  <th scope="col">狀態</th>
                  <th scope="col">操作</th>
                </tr>
              </thead>
              <tbody>
                {keys.map((k) => (
                  <tr key={k.key_id} className={k.is_active ? '' : 'row-revoked'}>
                    <td className="mono">{k.key_id}</td>
                    <td>{k.name}</td>
                    <td>{formatTime(k.created_at)}</td>
                    <td>{k.expires_at ? formatTime(k.expires_at) : '永久'}</td>
                    <td>
                      <span className={`status-pill ${k.is_active ? 'ok' : 'warn'}`}>
                        {k.is_active ? '啟用' : '已撤銷'}
                      </span>
                    </td>
                    <td>
                      {k.is_active && (
                        confirmRevoke === k.key_id ? (
                          <div className="confirm-actions">
                            <button className="btn btn-danger" onClick={() => handleRevoke(k.key_id)}>
                              確認撤銷
                            </button>
                            <button className="btn" onClick={() => setConfirmRevoke(null)}>
                              取消
                            </button>
                          </div>
                        ) : (
                          <button className="btn btn-danger" onClick={() => setConfirmRevoke(k.key_id)}>
                            撤銷
                          </button>
                        )
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
