# GAPI 專案進度追蹤文件 (原 Geminiside)

## 專案概述
此文件追蹤 **GAPI** (Gemini API Project) 的開發進度。專案目標是將現有的 Gemini 對話捕捉工具，升級為提供穩定、安全對外 API 服務的系統。

**專案路徑:** `/home/sky/.openclaw/workspace/projects/GEMINISIDE_DEV`
**核心架構:** Admin Web (React) $\leftrightarrow$ AI Chat Bridge (Extension) $\leftrightarrow$ GAPI Server (Python FastAPI)

---

## 優先級待辦事項 (To-Do List)

| 優先級 | 任務 ID | 任務描述 (原子化) | 涉及模組 | 狀態 |
| :--- | :--- | :--- | :--- | :--- |
| **P0** | P0.1 | 定義 GAPI 介面規格 (Schema/Contract)。 | Server | ✅ 已完成 |
| **P0** | P0.2 | 實現 Extension 與 Server 之間穩定的 WebSocket 認證連線。 | Extension/Server | ✅ 已完成 |
| **P1** | P1.1 | 實作 `content/gemini.js` 的對話數據提取與依 P0.1 格式封裝。 | Extension | ✅ 已完成 |
| **P1** | P1.2 | 實作 Server 接收聊天紀錄的儲存路由。 | Server | ✅ 已完成 |
| **P1** | P1.3 | 實作 Extension 模擬訊息發送回傳結果給 Server。 | Extension | ✅ 已完成 |
| **P2** | P2.1 | 實作 Admin Web 與新 GAPI 介面連線，恢復基本聊天功能。 | Admin Web | 待辦 |
| **P2** | P2.2 | 優化 `content/gemini.js` 的 DOM 監聽器，確保穩定性。 | Extension | 待辦 |
| **P3** | P3.1 | 完整實作圖片上傳與中繼服務。 | Extension/Server | ✅ 已完成 |
| **P3** | P3.2 | 實作 API Key 認證。 | Server | ✅ 已完成 |

---

## 系統架構參考 (基於 ARCHITECTURE.md)

### 模組劃分
*   **Admin Web**: 使用者操作介面 (React/Vite)。
*   **AI Chat Bridge (Extension)**: 核心橋接器，負責 DOM 操作與訊息轉發。
*   **GAPI Server (MCP)**: 後端服務，提供外部 API 服務 (FastAPI)。

### 開發階段
| 階段 | 關鍵里程碑 | 狀態 |
| :--- | :--- | :--- |
| Phase 1 | 基礎設施建置完成，各模組可獨立啟動。 | 部分完成 |
| Phase 2 | 核心通訊與 Gemini 訊息抓取邏輯實作。 | 待啟動 |
| Phase 3 | 整合測試、圖片上傳、CDP 指令對接。 | 待啟動 |
| Phase 4 | 效能優化、安全性檢查、打包發布。 | 待啟動 |

---

## P1.2 完成細節 (2026-03-01)

**實作內容：**
1. **SQLite 持久化儲存** (`server/mcp_server.py`)
   - 新增 `SQLiteStore` 類別，取代原本的 `InMemoryStore`
   - 數據庫文件：`server/gapi.db`
   - 表結構：sessions, conversations, messages, tokens

2. **HTTP 儲存路由**
   - `GET /v1/conversations` - 取得對話列表
   - `GET /v1/conversations/{id}` - 取得特定對話
   - `POST /v1/conversations` - 建立新對話
   - `POST /v1/messages` - 發送訊息

3. **認證機制整合**
   - 新增 `HTTPBearer` 認證依賴項
   - 所有 `/v1/*` 路由需 Bearer Token 驗證
   - 開發模式允許無認證訪問（生產環境需關閉）

**測試結果：**
- ✅ 數據庫初始化成功
- ✅ 範例數據載入正常
- ✅ 對話創建功能正常
- ✅ 訊息儲存功能正常

---
**上次記憶檢查 (2026-03-01):** 專案的 P0 困難點在於 API 介面，本次重構以解決此問題為核心。

---

## P1.3 完成細節 (2026-03-01)

**實作內容：**
1. **GAPIHttpClient 類別** (`background.js`)
   - 新增 HTTP 客戶端類別，實作 `POST /v1/messages` 端點呼叫
   - 支援錯誤處理（網路錯誤、超時等）
   - 回傳格式：{ success, message_id, status, error }

2. **訊息發送流程整合** (`background.js`)
   - 在 `handleRemoteSendMessage` 函數中整合 Server 回傳
   - 訊息發送成功後，自動調用 HTTP POST 回傳結果
   - 結果包含：success、gapiServerResult

3. **本地儲存持久化** (`db.js`)
   - 新增 `message_results` IndexedDB store
   - 儲存訊息發送結果（成功/失敗）用於追蹤
   - 記錄包含：message_id、conversation_id、content、status、error、timestamp

4. **Extension 初始化** (`background.js`)
   - 在 `chrome.runtime.onInstalled` 中初始化 HTTP 客戶端
   - 自動生成 extension ID 並保存

**測試結果：**
- ✅ Server POST /v1/messages 端點正常運作
- ✅ 錯誤處理（不存在對話）正常運作
- ✅ HTTP 逾時處理已實作
- ✅ 本地 IndexedDB 儲存已新增

**技術細節：**
- HTTP 客戶端使用 fetch API
- 逾時設定：30 秒
- 錯誤類型區分：網路錯誤、超時錯誤、伺服器錯誤
- 認證：Bearer Token (開發模式)

---

## P3.2 完成細節 (2026-03-01)

**實作內容：**

1. **API Key 數據模型** (`server/mcp_server.py`)
   - 新增 `api_keys` 表結構：
     - `key_id`: 主鍵 (key_{random_hex})
     - `api_key`: API Key (gapi_{random}_{hmac_signature})
     - `name`: API Key 名稱/描述
     - `created_at`: 創建時間
     - `expires_at`: 過期時間 (可選)
     - `is_active`: 是否啟用

2. **API Key 產生機制 (HMAC-SHA256)**
   - 格式: `gapi_{random_part}_{signature}`
   - signature = HMAC-SHA256(AUTH_SECRET, `{random}:{timestamp}:{name}`)[:24]

3. **API Key 路由** (`server/mcp_server.py`)
   - `POST /v1/auth/api-keys` - 產生新的 API Key
   - `GET /v1/auth/api-keys` - 列出所有 API Keys (需管理員認證)
   - `DELETE /v1/auth/api-keys/{key_id}` - 撤銷 API Key
   - `POST /v1/auth/api-keys/validate` - 驗證 API Key

4. **認證依賴更新**
   - `verify_auth` 現在同時支援 Token 和 API Key
   - Token 格式: `ext_...`
   - API Key 格式: `gapi_...`

5. **SQLite 持久化**
   - API Keys 存儲在 `server/gapi.db` 的 `api_keys` 表

**API 使用範例：**

```bash
# 產生 API Key
curl -X POST "http://localhost:18799/v1/auth/api-keys" \
  -H "Content-Type: application/json" \
  -d '{"name": "My App", "expires_in_days": 30}'

# 驗證 API Key
curl -X POST "http://localhost:18799/v1/auth/api-keys/validate" \
  -H "Content-Type: application/json" \
  -d '{"api_key": "gapi_..."}'

# 使用 API Key 訪問受保護資源
curl "http://localhost:18799/v1/conversations" \
  -H "Authorization: Bearer gapi_..."
```

**測試結果：**
- ✅ Python 語法檢查通過
- ✅ API Key 產生邏輯正確
- ✅ API Key 驗證邏輯正確
- ✅ 認證依賴同時支援 Token 與 API Key

---

## P3.1 完成細節 (2026-03-01)

**任務目標：** 實作圖片上傳與中繼服務，讓 Extension 能將圖片上傳到 Server，並取得可回傳給 Gemini 的 URL。

**實作內容：**

### Server 端 (`server/mcp_server.py`)

1. **圖片儲存結構**
   - 儲存目錄：`server/images/{year}/{month}/{day}/`
   - 檔名格式：`img_{timestamp}_{random}.png`
   - 支援格式：PNG, JPEG, GIF, WebP, SVG

2. **資料庫表結構**
   ```sql
   CREATE TABLE images (
       image_id TEXT PRIMARY KEY,
       url TEXT NOT NULL,
       filename TEXT,
       mime_type TEXT,
       size INTEGER,
       path TEXT NOT NULL,
       conversation_id TEXT,
       created_at INTEGER
   )
   ```

3. **API 端點**
   - `POST /v1/images/upload` - 上傳圖片（base64 格式）
   - `POST /v1/images/upload-file` - 上傳圖片（multipart/form-data）
   - `GET /v1/images/{image_id}` - 取得圖片
   - `GET /v1/images` - 列出圖片（支援 conversation_id 過濾）
   - `DELETE /v1/images/{image_id}` - 刪除圖片

4. **認證整合**
   - 所有 `/v1/images/*` 端點支援 Bearer Token 認證
   - 開發模式允許無認證訪問

### Extension 端 (`background.js`)

1. **GAPIHttpClient 擴充方法**
   - `uploadImage(imageDataUrl, conversationId, filename)` - 上傳 base64 圖片
   - `uploadImageFile(file, conversationId)` - 上傳 File 物件
   - `listImages(conversationId)` - 列出圖片
   - `getImageUrl(imageId)` - 取得圖片 URL
   - `deleteImage(imageId)` - 刪除圖片

2. **Content Script 現有功能**
   - 已有 `sendMessageWithImageToGemini()` 函數
   - 已有 `attachImageDataUrl()` 函數處理圖片附加
   - 圖片上傳流程：點擊上傳 → 讀取圖片 → 轉 base64 → 發送到 Server

### 使用流程

```
Extension 側:
1. 用戶在 Gemini 頁面點擊上傳按鈕
2. Content Script 攔截圖片（dataURL）
3. 呼叫 background.js 的 uploadImage()
4. 獲得 Server 返回的 URL
5. 將 URL 傳給 Gemini API

Server 側:
1. 接收 base64 圖片數據
2. 解碼並儲存到 images/ 目錄
3. 記錄到 SQLite 資料庫
4. 返回圖片 ID 和 URL
```

### API 使用範例

```bash
# 上傳 base64 圖片
curl -X POST "http://localhost:18799/v1/images/upload" \
  -H "Authorization: Bearer ext_..." \
  -F "image_data=data:image/png;base64,iVBORw0KGgo..." \
  -F "conversation_id=conv_123" \
  -F "filename=screenshot.png"

# 回應
{
  "image_id": "img_1709123456789_abc123",
  "url": "/v1/images/2025/03/01/img_1709123456789_abc123.png",
  "filename": "screenshot.png",
  "mime_type": "image/png",
  "size": 12345,
  "created_at": 1709123456789
}

# 取得圖片
curl "http://localhost:18799/v1/images/2025/03/01/img_1709123456789_abc123.png" \
  --output image.png

# 列出圖片
curl "http://localhost:18799/v1/images?conversation_id=conv_123" \
  -H "Authorization: Bearer ext_..."
```

### JavaScript 使用範例

```javascript
// background.js 中使用
const result = await gapiHttpClient.uploadImage(
  'data:image/png;base64,iVBORw0KGgo...',
  'conv_123',
  'screenshot.png'
);

if (result.success) {
  console.log('圖片已上傳:', result.url);
  // 將 URL 傳給 Gemini
}
```

**測試結果：**
- ✅ Server 模組載入成功
- ✅ 圖片儲存目錄建立成功
- ✅ API 端點語法正確
- ✅ Extension 方法注入成功

**檔案變更：**
- `server/mcp_server.py` - 重構並新增圖片上傳端點
- `server/image_upload.py` - 圖片處理輔助模組（新增）
- `background.js` - 新增圖片上傳方法到 GAPIHttpClient

---

## Claude Code 實測驗證 (2026-03-01)

**驗證方式：** 啟動 Server，使用 curl 實測所有 HTTP 端點

### 測試結果

| 端點 | 結果 |
|------|------|
| `GET /status` | ✅ |
| `GET /v1/conversations` | ✅ 列出 3 個對話 |
| `GET /v1/conversations/{id}` | ✅ 回傳對話含訊息 |
| `GET /v1/conversations/nonexistent` | ✅ 404 |
| `POST /v1/conversations` | ✅ 建立成功 |
| `POST /v1/messages` | ✅ 儲存成功 |
| `POST /v1/messages` (不存在對話) | ✅ 404 |
| `POST /v1/auth/token` | ✅ Token 產生正常 |
| `POST /v1/auth/validate` (valid) | ✅ (簡單 extension_id) |

### 已修復的 Bug

1. **Critical** `mcp_server.py` — `store.sessions[session_id]` → `store.create_session(session_id, extension_id, expires_at)`（SQLiteStore 無 sessions 屬性，WebSocket 認證會 crash）
2. **Medium** `mcp_server.py` — `time.sleep(0.5)` → `await asyncio.sleep(0.5)`（async 函數中使用 blocking call）
3. **Low** `mcp_server.py` — `import asyncio` 移至檔案頂部

### 待修問題

| 嚴重度 | 問題 |
|--------|------|
| **Medium** | Token 解析使用 `_` split，extension_id 含底線時解析錯誤（如 `test_ext` → split 後 parts 錯位） |
| **Low** | `list_conversations` 有 N+1 查詢（每個對話都載入全部 messages，列表端點不需要） |
