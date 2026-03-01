# GAPI Interface Specification v2.0

## Overview

GAPI Server 與 Extension (background.js) 之間的通訊介面規格。

## Base URL & WebSocket

- **HTTP Base**: `http://localhost:18799`
- **WebSocket**: `ws://localhost:18799/ws/{client_id}`
- **API Prefix**: `/v1`

## Authentication

所有 API 端點（除 `/status`）需要 Bearer Token 認證。

### Token 格式

```
ext_{extension_id}_{timestamp}_{hmac_sha256_signature_32chars}
```

### 取得 Token

```
POST /v1/auth/token?extension_id={id}
Rate Limit: 10 req/min

Response:
{
  "token": "ext_myext_1700000000000_abc123...",
  "expires_at": 1700003600000
}
```

### 使用 Token

所有 HTTP 端點使用 Bearer Token：
```
Authorization: Bearer ext_myext_1700000000000_abc123...
```

或使用 API Key：
```
Authorization: Bearer gapi_random_signature
```

### DEV_MODE

設定 `GAPI_DEV_MODE=true` 時，無 credentials 的請求會以 dev identity 通過認證。
生產環境必須設為 `false`。

---

## WebSocket Protocol

### 認證流程

**Client -> Server:**
```json
{
  "type": "auth",
  "payload": {
    "token": "ext_{extension_id}_{timestamp}_{signature}"
  }
}
```

**Server -> Client (成功):**
```json
{
  "type": "auth_ok",
  "payload": {
    "session_id": "random_url_safe_string",
    "expires_at": 1700003600000
  }
}
```

**Server -> Client (失敗):**
```json
{
  "type": "auth_error",
  "payload": {
    "error": "invalid_token | timeout | invalid_format | auth_required",
    "message": "描述"
  }
}
```

- 認證超時：5 秒
- 超時後伺服器強制關閉連接（code 1008）
- 同一 extension 的新連接會自動斷開舊連接

### 訊息類型

#### `ping` / `pong`
```json
// Client -> Server
{ "type": "ping" }

// Server -> Client
{ "type": "pong", "ts": 1700000000000 }
```

#### `conversation_sync`
```json
// Client -> Server
{
  "type": "conversation_sync",
  "payload": { "conversation_id": "conv_123" }
}

// Server -> Client
{
  "type": "conversation_data",
  "payload": {
    "conversation_id": "conv_123",
    "title": "My Chat",
    "messages": [
      { "id": "msg_1", "role": "user", "content": "Hello", "timestamp": 1700000000000 }
    ]
  }
}
```

#### `message_send`
```json
// Client -> Server
{
  "type": "message_send",
  "payload": {
    "conversation_id": "conv_123",
    "content": "Hello AI"
  }
}

// Server -> Client
{
  "type": "message_sent",
  "payload": { "message_id": "msg_xxx_abc1", "status": "ok" }
}
```

---

## HTTP API Endpoints

### Common Headers

所有回應包含：
- `X-Request-ID`: 請求追蹤 ID

Rate Limit 回應包含：
- `X-RateLimit-Limit`: 限制數
- `X-RateLimit-Remaining`: 剩餘數
- `X-RateLimit-Reset`: 重設時間（unix timestamp）

### 錯誤回應格式

```json
{
  "error": {
    "code": "INTERNAL_ERROR",
    "message": "描述（不暴露內部細節）"
  }
}
```

### GET /status
健康檢查（無需認證）
```json
{
  "status": "ok",
  "service": "GAPI Server",
  "version": "2.0.0",
  "timestamp": 1700000000000
}
```

### POST /v1/auth/token
產生認證 Token（Rate: 10/min）

Query: `?extension_id=xxx`

```json
// Response
{ "token": "ext_xxx_ts_sig", "expires_at": 1700003600000 }
```

### POST /v1/auth/validate
驗證 Token（Rate: 10/min）

Query: `?token=xxx`

```json
// Response (valid)
{ "valid": true, "extension_id": "xxx" }

// Response (invalid)
{ "valid": false }
```

### POST /v1/auth/api-keys
建立 API Key（需認證，Rate: 10/min）

```json
// Request
{ "name": "My Key", "expires_in_days": 30 }

// Response（api_key 僅返回一次）
{
  "key_id": "key_abc123",
  "api_key": "gapi_random_signature",
  "name": "My Key",
  "created_at": 1700000000000,
  "expires_at": 1702592000000
}
```

### GET /v1/auth/api-keys
列出 API Keys（需認證）

```json
{
  "api_keys": [
    { "key_id": "key_abc", "name": "My Key", "created_at": 0, "expires_at": 0, "is_active": 1 }
  ]
}
```

### DELETE /v1/auth/api-keys/{key_id}
撤銷 API Key（需認證）

```json
{ "status": "revoked", "key_id": "key_abc" }
```

### POST /v1/auth/api-keys/validate
驗證 API Key（Rate: 10/min）

Query: `?api_key=gapi_xxx`

```json
{ "valid": true, "key_id": "key_abc", "name": "My Key" }
```

### GET /v1/conversations
列出對話（需認證，cursor 分頁）

Query: `?limit=50&cursor=1700000000000`

```json
{
  "conversations": [
    { "id": "conv_123", "title": "Chat", "created_at": 0, "updated_at": 0 }
  ],
  "meta": { "cursor": 1700000000000, "has_more": true }
}
```

### GET /v1/conversations/{id}
取得對話詳情（需認證）

```json
{
  "id": "conv_123",
  "title": "Chat",
  "created_at": 0,
  "updated_at": 0,
  "messages": [
    {
      "id": "msg_1",
      "conversation_id": "conv_123",
      "role": "user",
      "content": "Hello",
      "attachments": null,
      "timestamp": 1700000000000
    }
  ]
}
```

### POST /v1/conversations
建立對話（需認證）

```json
// Request
{ "title": "New Chat" }

// Response
{ "id": "conv_ts_hex", "title": "New Chat", "created_at": 0, "updated_at": 0 }
```

### POST /v1/messages
發送訊息（需認證）

```json
// Request
{ "conversation_id": "conv_123", "content": "Hello", "attachments": [] }

// Response
{ "message_id": "msg_ts_hex", "status": "queued" }
```

### POST /v1/images/upload
上傳圖片 - base64（需認證，Rate: 10/min）

Content-Type: `multipart/form-data`
Fields: `image_data` (base64), `conversation_id` (optional), `filename` (optional)

限制：
- 最大 10MB（可配置）
- 允許 MIME：image/jpeg, image/png, image/gif, image/webp
- 驗證 magic bytes

```json
// Response
{
  "image_id": "img_ts_hex",
  "url": "/v1/images/2026/03/01/img_ts_hex.png",
  "filename": "upload_ts.png",
  "mime_type": "image/png",
  "size": 12345,
  "created_at": 1700000000000
}
```

### POST /v1/images/upload-file
上傳圖片 - File（需認證，Rate: 10/min）

Content-Type: `multipart/form-data`
Fields: `file` (binary), `conversation_id` (optional)

### GET /v1/images/{image_id}
取得圖片（需認證）

Returns: `FileResponse` with correct MIME type

### GET /v1/images
列出圖片（需認證）

Query: `?conversation_id=xxx`

```json
{ "images": [...], "count": 5 }
```

### DELETE /v1/images/{image_id}
刪除圖片（需認證）

```json
{ "status": "deleted", "image_id": "img_xxx" }
```

### POST /v1/bridge
CDP 橋接（legacy，無需認證）

```json
// Request
{ "kind": "click", "ref": "element_ref" }

// Response
{ "ok": true, "latency_ms": 1, "physical_trace": { "status": "success" } }
```

---

## Data Models

### Message
```typescript
interface Message {
  id: string;                    // "msg_{timestamp}_{hex}"
  conversation_id: string;
  role: "user" | "model" | "system";
  content: string;
  attachments?: string[] | null; // JSON array
  timestamp: number;             // ms since epoch
}
```

### Conversation
```typescript
interface Conversation {
  id: string;                    // "conv_{timestamp}_{hex}"
  title: string;
  created_at: number;
  updated_at: number;
  messages?: Message[];          // Only in detail endpoint
}
```

---

## Rate Limits

| 端點 | 限制 |
|------|------|
| 認證端點 (`/v1/auth/*`) | 10 req/min per IP |
| 圖片上傳 (`/v1/images/upload*`) | 10 req/min per IP |
| 一般端點 | 60 req/min per IP |

超過限制返回 HTTP 429 + Retry-After header。

---

## Error Codes

| HTTP Status | Code | 說明 |
|-------------|------|------|
| 400 | — | 請求格式錯誤 |
| 401 | — | 認證失敗或缺少認證 |
| 404 | — | 資源不存在 |
| 429 | — | 速率限制 |
| 500 | `INTERNAL_ERROR` | 伺服器內部錯誤 |

WebSocket 錯誤：
| Error | 說明 |
|-------|------|
| `timeout` | 認證超時（5 秒） |
| `invalid_format` | 無效 JSON |
| `auth_required` | 首條訊息必須是 auth |
| `invalid_token` | Token 無效或過期 |
| `invalid_json` | 後續訊息 JSON 格式錯誤 |
| `conversation_not_found` | 對話不存在 |
| `unknown_message_type` | 未知訊息類型 |
