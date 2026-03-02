export type PageId = 'conversations' | 'api-keys' | 'site-config' | 'settings';

export interface ConversationMeta {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
}

export interface Message {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  attachments?: string[] | null;
  timestamp: number;
}

export interface ConversationDetail {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
  messages: Message[];
}

export interface ApiKeyInfo {
  key_id: string;
  name: string;
  created_at: number;
  expires_at: number | null;
  is_active: number;
}

export interface ApiKeyCreateResponse {
  key_id: string;
  api_key: string;
  name: string;
  created_at: number;
  expires_at: number | null;
}

export interface ImageInfo {
  image_id: string;
  url: string;
  filename: string;
  mime_type: string;
  size: number;
  conversation_id: string | null;
  created_at: number;
}

export interface SiteConfig {
  id: string;
  url_pattern: string;
  name: string;
  selectors: {
    content?: string;
    title?: string;
    messages?: string;
    input?: string;
  };
  enabled: boolean;
  created_at: number;
  updated_at: number;
}

export interface StatusResponse {
  status: string;
  service: string;
  version: string;
  timestamp: number;
}
