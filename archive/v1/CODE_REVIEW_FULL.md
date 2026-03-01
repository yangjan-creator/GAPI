# GAPI 代碼檢視完整報告

**彙總日期**：2026-03-01  
**原則**：只記錄問題，不改代碼

---

## P0 - API 規格與認證

### 光一檢視發現

**問題：API 規格定義不一致**
- 錯誤碼定義不一致：`API_SPEC.md` 定義 `expired_token`，但 `mcp_server.py` 未區分過期 vs 無效
- HTTP/WebSocket 訊息類型命名不一致：文檔用 `api_key`，實際用 `token` 參數
- 缺少 `rate_limit` 錯誤處理：定義了但未實作

**問題：WebSocket 認證邏輯問題**
- **前端 Token 簽名與 Server 驗證完全不匹配**：Server 端用 HMAC-SHA256 動態計算，但前端用硬編碼 `dev_signature`
- Server 端簽名驗證邏輯與前端不匹配
- 開發模式硬編碼 Secret Key
- Token 過期檢查時區問題
- WebSocket 認證超時處理不完整

**問題：Session 管理問題**
- Session 清理機制缺失：`disconnect()` 未調用 `store.delete_session()`
- Extension ID 重複連接處理：舊 session 沒有被清理

**問題：其他**
- CORS 設定過寬 (`allow_origins = ["*"]`)
- 錯誤訊息暴露內部細節
- 缺少請求日誌

---

### 深檢視發現

**問題：Token 簽名完全不匹配**
- Client (`background.js`) 使用硬編碼 `dev_signature`
- Server (`mcp_server.py`) 使用 HMAC-SHA256 動態計算
- **結論**：認證機制完全失效，任何請求都會失敗

**問題：Client 缺少驗證**
- `validate_token` 函數未在 client 端實作

**問題：AUTH_SECRET 暴露**
- `AUTH_SECRET = "gapi_dev_secret_key_change_in_production"` 硬編碼

---

### 光三檢視發現（第四次）

**問題：Token 簽名匹配問題（最嚴重）**
- 客戶端 (`background.js:40`)：使用硬編碼 `"dev_signature"`
  ```javascript
  const token = `ext_${extensionId}_${timestamp}_dev_signature`;
  ```
- 伺服器端 (`mcp_server.py`)：使用 HMAC-SHA256 動態計算簽名
  ```python
  signature = hmac.new(AUTH_SECRET.encode(), message.encode(), hashlib.sha256).hexdigest()[:16]
  ```
- **影響**：WebSocket 和 HTTP 認證完全失效，所有認證請求都會失敗

**問題：安全密鑰硬編碼**
- 位置：`mcp_server.py:24`
- 內容：`AUTH_SECRET = "gapi_dev_secret_key_change_in_production"`
- 風險：生產環境安全風險，密鑰應從環境變數讀取

**問題：Session 清理機制缺失**
- WebSocket 斷線時 Session 清理不完全
- `WebSocketManager.disconnect()` 方法中，extension mapping 清理邏輯有缺陷

**問題：CORS 設定過於寬鬆**
- CORS 設定允許所有來源：`origins = ["*"]`

**問題：Token 解析潛在問題**
- Token 解析使用 `_` 分割，extension_id 包含底線時會解析錯誤
- 範例：`ext_test_ext_1234567890_signature` 會被錯誤解析

**問題：開發模式安全繞過**
- `verify_auth` 函數在無 credentials 時返回 `None` 而非錯誤

**問題：API 規格一致性問題**
- `/v1/conversations` 列表端點載入所有訊息的 N+1 查詢問題

---

## P1 - 數據提取與儲存

### 光二檢視發現

**問題：檔案路徑問題**
- 在 `projects/GAPI` 目錄中未找到 `content.js` 和 `background.js`
- 懷疑實際路徑可能在 Extension 專案中

**問題：Server 儲存路由問題**
- 缺乏實際的儲存路由實作
- 只處理了認證，儲存機制未完成

---

### 訊檢視發現

**問題：角色判定模糊性 (Role Ambiguity)**
- `scrapeMessages` 中，對於無法透過類名明確判定的訊息，採用了 `index % 2 === 0` 的簡單假設
- 在 Gemini 頁面中，若存在系統提示、錯誤訊息或連續多則模型回覆時，此邏輯會導致角色歸屬錯誤

**問題：提取 ID 的不穩定性**
- ID 生成邏輯 (`user_${messageHash}_${elementIndex}`) 具有極高的不穩定性
- 若頁面動態載入舊訊息，`elementIndex` 會改變，導致已儲存的訊息在比對時被視為「新訊息」而重複存入

**問題：DOM 緩存潛在 stale 問題**
- `domCache` 設置了 5 秒 TTL
- 在 Gemini 這類高度動態的 SPA 中，5 秒內元素可能已經過期但仍存在於緩存中

**問題：對話與訊息建立的時序矛盾**
- `/v1/conversations` (POST) 建立對話時會生成 `conv_{now}`，但 `content.js` 抓取到的 `chatId` 通常是 Google 生成的 UUID
- Server 缺乏「以外部 ID 建立對話」的顯式路由，容易導致資料庫中同一對話存在多份記錄

**問題：外鍵約束風險**
- `messages` 表對 `conversation_id` 有外鍵約束
- 若 `content.js` 傳回一個 Server 尚未建立的 `chatId`，該寫入操作將會失敗

**問題：附件存儲格式不一**
- API 規格定義 `attachments` 為 `List[str]`，但在 `messages` 表中是以 `TEXT` (JSON string) 存儲
- 若 `row["attachments"]` 為空字串而非 `NULL`，`json.loads` 可能拋錯

**問題：圖片上傳路徑漏洞**
- `get_image` 路由允許直接透過 `image_id` 路徑訪問
- 若傳入 `../../` 等攻擊字串，可能導致目錄穿越風險

**問題：WebSocket 認證 Token 偽造風險**
- `background.js` 中 `generateToken` 的實作目前僅為靜態字串拼接 (`dev_signature`)

**問題：發送狀態的雙重機制不一致**
- WebSocket (`message_send`) 與 HTTP POST (`/v1/messages`) 兩種路徑
- WebSocket 回傳 `message_sent` (status: ok)，HTTP 回傳 `queued`
- Server 端的 `simulate_ai_response` 只與 WebSocket 綁定

---

### 碼檢視發現

**問題：DOM 依賴脆弱性**
- 訊息提取高度依賴特定的 CSS class (如 `user-query`, `model-response`)
- 若 Gemini 前端更新 class 名稱，提取邏輯將立即失效
- 缺乏基於語義結構或穩定屬性的後備提取方案

**問題：訊息 ID 不穩定性**
- `content.js` 中的 ID 生成邏輯使用內容雜湊與 DOM 索引
- 若頁面重繪或歷史訊息加載導致索引變化，可能生成新的 ID，導致後端判定為新訊息而產生重複數據

**問題：觸發機制過於頻繁**
- `MutationObserver` 監聽範圍較廣
- `scrapeMessages` 觸發頻率較高
- 在動態生成的長對話中可能造成客戶端效能壓力

**問題：格式轉換一致性**
- `content-gapi-formatter.js` 定義了標準格式，但 `content.js` 在某些錯誤處理路徑下可能直接返回原始結構或空數據

**問題：雙重數據源權責不清**
- 系統同時維護瀏覽器端的 `IndexedDB` (`db.js`, `background.js`) 與 Python 伺服器端的 `SQLite` (`mcp_server.py`)
- 缺乏明確的「單一真理來源 (Source of Truth)」定義

**問題：路由冗餘**
- `content.js` 發出 `GAPI_conversation_data` 事件，同時 `saveConversationMessages` 也會觸發 HTTP 請求

**問題：Mock 數據殘留**
- 伺服器端的 `simulate_ai_response` 函數目前僅回傳固定的模擬文字

**問題：角色定位衝突 (Split Brain)**
- 當透過 API (`/v1/messages`) 發送訊息時，Server 端會生成一個模擬回應存入 DB
- 同時，Web UI 上真實的 Gemini 回應會被 `content.js` 抓取並存入 DB
- 這會導致資料庫中同時存在「模擬回應」與「真實回應」，造成數據汙染

**問題：回傳路徑斷裂**
- Server 端有 WebSocket 推送機制 (`message_stream`)，但 `background.js` 收到後僅做 Log 記錄或轉發
- 並未見到 `content.js` 有邏輯將此模擬訊息渲染回 Web UI

---

## P2 - Admin Web 與 DOM 監聽器

### 光三檢視發現

**問題：MutationObserver 未正確清理**
- 缺乏統一的清理機制
- 重複設置觀察器：沒有檢查機制避免重複
- 觀察器管理器使用不一致：部分用 manager，部分直接創建
- 缺乏全局清理機制：沒有 `beforeunload`/`pagehide` 清理
- 局部觀察器未設置超時：長期運行的觀察器可能累積

**問題：其他**
- console.log 過多
- 錯誤處理重複

---

### 影檢視發現

**問題：Admin Web - ExtensionApi 異常處理**
- `admin-web/src/api.ts` 中 `ExtensionApi` 類的 `connectAdminEvents` 方法未處理 `port.onMessage` 的異常捕獲

**問題：Admin Web - 上傳流程**
- `App.tsx` 中 `sendMessage()` 函數在 `imageFile` 上傳流程中，未對 `uploadId` 的有效性進行二次驗證
- 若 `uploadBegin` 成功但 `uploadChunk` 失敗，`uploadAbort` 未在錯誤路徑中被呼叫

**問題：Admin Web - LogView**
- 日誌顯示器未實現自動滾動到最新訊息的平滑動畫

**問題：DOM 監聽器 - 監聽範圍**
- `setupDownloadButtonObserver()` 使用 `MutationObserver` 監聽 `document.body`，但未限制監聽範圍
- 在複雜頁面時觸發過度的 `handleNewResponse` 檢查，造成 CPU 消耗飆升

**問題：DOM 監聽器 - handleNewResponse**
- `setTimeout(..., 2000)` 非同步延遲執行，若在 2 秒內該回應區塊被移除，`allButtons` 會引用已不存在的 DOM 元素

**問題：DOM 監聽器 - isDownloadButton**
- 依賴 `data-test-id="download-generated-image-button"`，但 Google 會不定期變更此屬性

**問題：MutationObserver 未呼叫 disconnect()**
- `setupDownloadButtonObserver()` 建立的 MutationObserver 實例從未呼叫 `observer.disconnect()`

**問題：fetch/XHR 全局代理未清除**
- `setupButtonClickInterceptor()` 中的 `fetchWrapper`、`xhrWrapper` 在 `cleanupTimer`（8 秒）到期後僅移除事件監聽器，但未清除全局代理

**問題：clickMonitorRecords 陣列無上限**
- `recordClickMonitorEvent()` 持續將完整 DOM 節點和 `outerHTML`（長達 1000 字元）存入陣列
- 在長時間使用下，陣列不斷膨脹，有觸發 OOM 風險

---

### 深檢視發現（第二次）

**問題：observerManager 未被充分利用**
- `observerManager` 物件存在且功能完整，但許多局部 MutationObserver 仍直接創建不通過它
- 直接創建的觀察器：`classObserver`、`imgObserver`、`menuObserver`、`stateObserver`、`buttonInterceptors.monitorObserver`

**問題：歷史 API 覆蓋未還原**
- `setupURLMonitoring` 覆蓋了 `history.pushState` 和 `history.replaceState`
- `stopMonitoring` 僅清理了 `urlCheckInterval`，未還原原始函數

**問題：popstate 事件監聽器未移除**
- `window.addEventListener('popstate', ...)` 沒有對應的 `removeEventListener`

**問題：observerManager.disconnectAll 從未被調用**
- `observerManager` 有 `disconnectAll()` 方法，但從未被調用

**問題：局部 MutationObserver 依賴 setTimeout 清理**
- 例如 `setTimeout(() => imgObserver.disconnect(), 30000)`
- 若對話在30秒內切換，這些 Observer 可能未及時清理

**問題：多條圖片監控路徑的清理邏輯不一致**
- `setupImageObserver`、`setupImageMonitoring`、`setupAutoImageTrigger` 等多個函數各自實現監控邏輯
- 清理代碼分散，難以維護

**問題：Admin Web - useEffect 依賴項**
- 多個 `useEffect` 使用 `eslint-disable-next-line react-hooks/exhaustive-deps` 註解

**問題：Admin Web - refreshTimerRef**
- `scheduleRefresh` 函數會設置 `setTimeout`，但在組件卸載時沒有最終清理

---

## P3.1 - 圖片上傳服務

### 光四檢視發現

**問題：AUTH_SECRET 硬編碼**
- 開發用密鑰寫死

**問題：CORS 配置過於寬鬆**
- `allow_origins=["*"]`

**問題：開發模式允許無認證訪問**
- 生產環境風險

**問題：MIME 類型推斷不嚴謹**
- 未知類型預設為 `.png`

**問題：缺少檔案大小限制**
- 可能導致儲存空間濫用

**問題：缺少圖片驗證**
- 未驗證有效性格式

**問題：URL 路徑暴露內部結構**
- 暴露儲存路徑

**問題：程式碼重複**
- `image_upload.py` 與 `mcp_server.py` 函數完全重複

---

### 光三檢視發現（第三次）

**問題：開發模式無認證漏洞**
- `verify_auth` 函數在開發模式下允許無認證訪問

**問題：檔案類型驗證不足**
- 僅依賴檔案副檔名和 Content-Type 判斷 MIME 類型
- 缺乏實際檔案內容的魔術位元組檢查

**問題：無檔案大小限制**
- 未對上傳的圖片檔案大小進行限制

**問題：路徑遍歷風險**
- `get_image_storage_path` 函數使用使用者提供的檔名

**問題：重複的 `decode_base64_image` 函數**
- `/server/image_upload.py:201` 和 `/server/mcp_server.py:836` 都有相同功能的函數

**問題：重複的資料庫操作邏輯**
- `save_image_to_database` 與 `store.save_image` 執行相同操作

**問題：SQLite 資料庫併發問題**
- 多個圖片上傳同時發生時可能出現資料庫鎖定問題

**問題：無上傳速率限制**
- 缺乏對單一使用者或 IP 的圖片上傳頻率限制

---

### 光二檢視發現（第六次）

**問題：圖片上傳服務代碼未找到**
- 在可見的專案結構中未找到圖片上傳服務的具體實作程式碼

**問題：API Key 硬編碼**
- `api_key_manager.py` 中 `get_secret()` 函式硬編碼了 `"a_very_secret_and_long_key_for_testing"`

**問題：API Key 驗證不足**
- `validate_api_key` 函式僅檢查金鑰的格式，並未進行實際的 HMAC 簽名比對

**問題：Mock 儲存**
- `api_key_manager.py` 使用全域字典 `_API_KEY_STORE` 作為金鑰的記憶體中儲存庫

**問題：程式碼重複/結構**
- API Key 邏輯分散於 `server/mcp_server.py` 和 `api_key_manager.py`

---

## P3.2 - API Key 認證

### 光五檢視發現

**問題：API Key 格式安全性不足**
- signature 僅 24 字元

**問題：API Key 驗證邏輯缺陷**
- 未驗證 signature 有效性

**問題：API Key 明文儲存**
- 資料庫中以明文存放

**問題：API Key 洩漏風險**
- HTTP 回傳中明文傳輸

**問題：管理員權限檢查缺失**
- 普通 Key 持有者可管理其他 Key

**問題：API Key 名稱注入風險**
- 輸入未驗證

**問題：WebSocket 缺乏 API Key 支援**

**問題：靜態 Secret Key 風險**

**問題：缺乏 API Key 使用統計**

**問題：Token 生成演算法可預測**

---

### 光二檢視發現（第二次）

**問題：API Key 驗證依賴資料庫**
- 驗證邏輯檢索資料庫中的 Key，但從未重新計算 HMAC 簽名來比對
- 驗證只檢查 Key 字串是否存在於資料庫中且 `is_active = 1`

**問題：缺乏權限區分**
- `verify_auth` 只驗證 Token/Key 是否有效，未區分權限級別
- 管理員端點檢查僅為 `if auth is None: raise HTTPException`

---

### 光一檢視發現（第二次）

**問題：硬編碼的認證密鑰**
- `AUTH_SECRET = "gapi_dev_secret_key_change_in_production"` 直接寫死在代碼中
- 建議：改用環境變數

**問題：客戶端使用假簽名**
- `background.js:40` 使用固定字串 `"dev_signature"` 作為簽名
- 伺服器端驗證邏輯完全可被繞過

**問題：WebSocket 逾時後仍允許連接**
- 逾時後會發送錯誤訊息，但未強制關閉 WebSocket 連接

**問題：開發模式繞過認證**
- `verify_auth` 返回 `None` 允許訪問

**問題：API Key 明文儲存**
- API Key 以明文儲存於 SQLite 資料庫

**問題：缺少 Rate Limiting**

**問題：CORS 允許所有來源**
- `origins = ["*"]`

**問題：Session ID 長度**
- 僅 16 bytes

**問題：Client ID 可偽造**
- `client_id` 直接從 URL 路徑取得，未經驗證

**問題：Token 過期檢查邏輯**
- Token 過期檢查使用客戶端提供的 timestamp

**問題：缺少日誌記錄**

**問題：無 HTTPS 強制**
- WebSocket URL 使用 `ws://localhost:18799`

---

### 深檢視發現（第四次）

**問題：開發模式繞過所有認證**
- 位置：`mcp_server.py:554-556`
- 如果 HTTP 請求沒有提供認證信息，服務器直接返回 `None` 允許訪問

**問題：API Key 創建端點無保護**
- `POST /v1/auth/api-keys` 端點沒有管理員認證保護

**問題：硬編碼認證密鑰**
- `AUTH_SECRET = "gapi_dev_secret_key_change_in_production"` 是硬編碼的預設密鑰

**問題：圖片端點無認證**
- `GET /v1/images/{image_id}` 端點不需要認證即可訪問上傳的圖片

**問題：Token 簽名過短**
- 只使用 HMAC-SHA256 的前 16 個字符

**問題：API Key 簽名過短**
- 只使用 24 個字符

**問題：CORS 完全開放**
- `origins = ["*"]`

**問題：WebSocket 認證超時過長**
- 10 秒超時可能被利用進行拒絕服務攻擊

**問題：background.js 簡化版 Token 生成**
- 使用固定的 `dev_signature`，繞過了實際的 HMAC 驗證

**問題：缺少速率限制**

**問題：Token 過期時間過長**
- 預設 1 小時過期時間增加了 Token 盜用風險

**問題：API Key 資料表允許空過期時間**
- 可以設定為 NULL（永不过期）

**問題：管理員權限檢查不完整**

**問題：敏感資訊暴露**

**問題：SQLite 資料庫無加密**
- API Keys 資料表中的 api_key 以明文存儲

---

*最後更新：2026-03-01 20:15 GMT+8*
