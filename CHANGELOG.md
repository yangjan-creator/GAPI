# GAPI Changelog

## v2.0.0 — 全面修復、強化與優化 (2026-03-01)

經多位 agent 聯合代碼審查（CODE_REVIEW_FULL.md）發現 50+ 個問題後，執行一次性全面修復。

### 認證系統修復 (P0)
- **Token 簽名統一**：前後端統一使用 HMAC-SHA256，移除所有 `dev_signature` 硬編碼
- **Token 簽名加長**：從 16 字元增加到 32 字元
- **Token 解析修正**：改用 `rsplit` 處理含底線的 extension_id
- **常數時間比較**：使用 `hmac.compare_digest` 防止時序攻擊
- **環境變數認證**：`AUTH_SECRET` 從 `GAPI_AUTH_SECRET` 環境變數讀取，未設定時啟動警告
- **DEV_MODE 控制**：無 credentials 時，DEV_MODE=true 返回 dev identity，否則 401
- **API Key 雜湊儲存**：明文 API Key 改為 SHA-256 雜湊後儲存
- **API Key 建立需認證**：`POST /v1/auth/api-keys` 現在需要已認證的請求
- **Session 清理**：WebSocket disconnect 時正確刪除 session
- **重複連接處理**：同一 extension 的新連接會先斷開舊連接
- **認證超時縮短**：WebSocket 認證超時從 10 秒減到 5 秒，超時後強制關閉連接

### 安全強化
- **CORS 收緊**：從 `["*"]` 改為環境變數配置（預設 localhost + chrome-extension）
- **路徑遍歷防護**：圖片路徑使用 `resolve()` + prefix check 驗證
- **檔名清理**：移除不安全字元，限制長度
- **Magic Bytes 驗證**：上傳圖片驗證 JPEG/PNG/GIF/WebP 的 magic bytes
- **檔案大小限制**：預設 10MB，可透過環境變數配置
- **MIME 白名單**：僅允許 image/jpeg、image/png、image/gif、image/webp
- **速率限制**：認證端點 10/min、上傳 10/min、一般 60/min
- **錯誤回應標準化**：統一格式，不暴露內部細節
- **Request ID**：所有回應包含 `X-Request-ID` header

### 程式碼重構
- **模組化**：提取 `auth.py`、`image_service.py`、`rate_limiter.py`
- **刪除重複**：移除 `image_upload.py` 和 `mcp_server_additions.py`（完全重複）
- **移除 Mock**：刪除 `simulate_ai_response()` 和 sample data 插入
- **程式碼縮減**：`mcp_server.py` 從 1,308 行重構到 ~550 行

### 資料層修復
- **WAL Mode**：啟用 SQLite WAL journal mode 改善併發
- **Busy Timeout**：設定 5 秒超時避免鎖定錯誤
- **Foreign Keys**：啟用外鍵約束
- **N+1 修復**：`list_conversations()` 不再載入 messages
- **Cursor 分頁**：對話列表支援 cursor-based 分頁
- **索引新增**：messages(conversation_id)、messages(timestamp)、images(conversation_id)、sessions(extension_id)
- **Attachments 修正**：解析前檢查 null/空字串，統一為 list 格式
- **自動遷移**：api_key column 自動遷移為 api_key_hash

### Client 端修復 (background.js)
- **TokenManager**：新增 token 管理器，從 server 取得 token、快取到 chrome.storage.local、過期前 5 分鐘自動更新
- **移除 dev_signature**：所有硬編碼 token 生成替換為 TokenManager
- **adminPorts 限制**：上限 20 個，超出自動斷開最舊的
- **語法錯誤修正**：修復斷行中文字串和 class 範圍錯誤

### Client 端修復 (content.js)
- **Observer 清理**：`stopMonitoring()` 呼叫 `observerManager.disconnectAll()`
- **History API 還原**：cleanup 時還原原始 pushState/replaceState
- **popstate 移除**：cleanup 時 removeEventListener
- **fetch/XHR 還原**：cleanup 時還原原始全域方法
- **eventManager 清理**：cleanup 時呼叫 `eventManager.cleanup()`
- **頁面卸載清理**：新增 beforeunload/pagehide 事件觸發 stopMonitoring

### Admin Web 修復 (App.tsx + api.ts)
- **XSS 防護**：移除不安全 HTML 渲染，改用安全文字渲染
- **useEffect 修正**：5 處 eslint-disable 改為正確的 useCallback + 依賴陣列
- **上傳錯誤處理**：try/finally 確保失敗時呼叫 uploadAbort
- **事件監聽防護**：connectAdminEvents 加入 try-catch

### 基礎設施
- **版本鎖定**：fastapi==0.115.0, uvicorn==0.30.0, pydantic==2.9.0, python-multipart==0.0.9
- **結構化日誌**：所有 print() 替換為 logging 模組
- **環境變數範本**：新增 `server/.env.example`

---

## v1.0.0 — 初始版本

- 基礎 FastAPI 伺服器
- WebSocket 認證流程
- 對話與訊息 CRUD
- 圖片上傳（base64 + file）
- Chrome 擴充功能（content.js + background.js）
- Admin Web 管理面板
