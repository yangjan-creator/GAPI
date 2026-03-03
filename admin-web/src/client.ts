import type {
  StatusResponse,
  ConversationMeta,
  ConversationDetail,
  ApiKeyInfo,
  ApiKeyCreateResponse,
  ImageInfo,
  SiteConfig,
  PagesResponse,
  TabInspectResult,
  NebulaFile,
  ReloadResponse,
} from './types';

export class GapiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'GapiError';
  }

  get isUnauthorized(): boolean {
    return this.status === 401;
  }

  get isNotFound(): boolean {
    return this.status === 404;
  }

  get isRateLimited(): boolean {
    return this.status === 429;
  }
}

export class GapiClient {
  constructor(
    private baseUrl: string,
    private apiKey: string,
  ) {}

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      ...((options.headers as Record<string, string>) || {}),
    };

    if (!(options.body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
    }

    const response = await fetch(url, { ...options, headers });

    if (!response.ok) {
      let message = `HTTP ${response.status}`;
      try {
        const body = await response.json();
        message = body?.error?.message || body?.detail || message;
      } catch {
        // use default message
      }
      throw new GapiError(response.status, message);
    }

    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      return response.json();
    }
    return response as unknown as T;
  }

  // ========== Status ==========

  async getStatus(): Promise<StatusResponse> {
    // Status endpoint doesn't require auth
    const response = await fetch(`${this.baseUrl}/status`);
    if (!response.ok) throw new GapiError(response.status, 'Server unreachable');
    return response.json();
  }

  // ========== Auth ==========

  async validateApiKey(key: string): Promise<{ valid: boolean; key_id?: string; name?: string }> {
    const response = await fetch(`${this.baseUrl}/v1/auth/api-keys/validate?api_key=${encodeURIComponent(key)}`, {
      method: 'POST',
    });
    if (!response.ok) throw new GapiError(response.status, 'Validation failed');
    return response.json();
  }

  async listApiKeys(): Promise<ApiKeyInfo[]> {
    const data = await this.request<{ api_keys: ApiKeyInfo[] }>('/v1/auth/api-keys');
    return data.api_keys;
  }

  async createApiKey(name: string, expiresInDays?: number): Promise<ApiKeyCreateResponse> {
    return this.request<ApiKeyCreateResponse>('/v1/auth/api-keys', {
      method: 'POST',
      body: JSON.stringify({ name, expires_in_days: expiresInDays || null }),
    });
  }

  async revokeApiKey(keyId: string): Promise<void> {
    await this.request(`/v1/auth/api-keys/${encodeURIComponent(keyId)}`, { method: 'DELETE' });
  }

  // ========== Conversations ==========

  async listConversations(limit = 50, cursor?: number): Promise<{
    conversations: ConversationMeta[];
    meta: { cursor: number | null; has_more: boolean };
  }> {
    const params = new URLSearchParams({ limit: String(limit) });
    if (cursor != null) params.set('cursor', String(cursor));
    return this.request(`/v1/conversations?${params}`);
  }

  async getConversation(id: string): Promise<ConversationDetail> {
    return this.request(`/v1/conversations/${encodeURIComponent(id)}`);
  }

  async createConversation(title?: string): Promise<ConversationDetail> {
    return this.request('/v1/conversations', {
      method: 'POST',
      body: JSON.stringify({ title: title || null }),
    });
  }

  // ========== Messages ==========

  async sendMessage(
    conversationId: string,
    content: string,
    attachments?: string[],
  ): Promise<{ message_id: string; status: string }> {
    return this.request('/v1/messages', {
      method: 'POST',
      body: JSON.stringify({
        conversation_id: conversationId,
        content,
        attachments: attachments || null,
      }),
    });
  }

  // ========== Images ==========

  async uploadImage(file: File, conversationId?: string): Promise<ImageInfo> {
    const formData = new FormData();
    formData.append('file', file);
    if (conversationId) formData.append('conversation_id', conversationId);
    return this.request('/v1/images/upload-file', {
      method: 'POST',
      body: formData,
    });
  }

  async listImages(conversationId?: string): Promise<ImageInfo[]> {
    const params = conversationId ? `?conversation_id=${encodeURIComponent(conversationId)}` : '';
    const data = await this.request<{ images: ImageInfo[]; count: number }>(`/v1/images${params}`);
    return data.images;
  }

  async getImageBlobUrl(imageId: string): Promise<string> {
    const response = await fetch(`${this.baseUrl}/v1/images/${encodeURIComponent(imageId)}`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
    if (!response.ok) throw new GapiError(response.status, 'Image not found');
    const blob = await response.blob();
    return URL.createObjectURL(blob);
  }

  async deleteImage(imageId: string): Promise<void> {
    await this.request(`/v1/images/${encodeURIComponent(imageId)}`, { method: 'DELETE' });
  }

  // ========== Site Configs ==========

  async listSiteConfigs(): Promise<SiteConfig[]> {
    const data = await this.request<{ configs: SiteConfig[] }>('/v1/config/sites');
    return data.configs;
  }

  async saveSiteConfig(config: Omit<SiteConfig, 'created_at' | 'updated_at'>): Promise<SiteConfig> {
    return this.request('/v1/config/sites', {
      method: 'POST',
      body: JSON.stringify(config),
    });
  }

  async deleteSiteConfig(id: string): Promise<void> {
    await this.request(`/v1/config/sites/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  // ========== Pages & Tabs ==========

  async getPages(): Promise<PagesResponse> {
    return this.request('/v1/pages');
  }

  async inspectTab(
    tabId: number,
    action: string,
    payload?: Record<string, unknown>,
  ): Promise<TabInspectResult> {
    return this.request(`/v1/tabs/${encodeURIComponent(tabId)}/inspect`, {
      method: 'POST',
      body: JSON.stringify({ action, ...payload }),
    });
  }

  async sendToTab(
    tabId: number,
    message: string,
  ): Promise<{ status: string; message_id?: string }> {
    return this.request(`/v1/tabs/${encodeURIComponent(tabId)}/send`, {
      method: 'POST',
      body: JSON.stringify({ message }),
    });
  }

  async getTabResponse(tabId: number): Promise<TabInspectResult> {
    return this.request(`/v1/tabs/${encodeURIComponent(tabId)}/get-response`, {
      method: 'POST',
    });
  }

  async navigateTab(tabId: number, url: string): Promise<{ status: string }> {
    return this.request(`/v1/tabs/${encodeURIComponent(tabId)}/navigate`, {
      method: 'POST',
      body: JSON.stringify({ url }),
    });
  }

  // ========== Nebula Files ==========

  async getNebulaFiles(tabId: number): Promise<{ files: NebulaFile[] }> {
    return this.request(`/v1/nebula/tabs/${encodeURIComponent(tabId)}/files`);
  }

  async getNebulaFileContent(tabId: number, fileId: string): Promise<{ content: string; file: NebulaFile }> {
    return this.request(`/v1/nebula/tabs/${encodeURIComponent(tabId)}/files/${encodeURIComponent(fileId)}`);
  }

  // ========== Extension Reload ==========

  async reloadExtension(mode: string): Promise<ReloadResponse> {
    return this.request('/v1/extension/reload', {
      method: 'POST',
      body: JSON.stringify({ mode }),
    });
  }
}
