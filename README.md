# GAPI — AI Chat Bridge

Chrome 擴充功能 + API Server，讓你透過 API 控制 Gemini/Claude 網頁版的對話、圖片上傳與管理。

## 系統需求

- Python 3.10+
- Chrome 瀏覽器
- Linux / WSL2

## 安裝步驟

### 1. 啟動 Server

```bash
cd /home/sky/.openclaw/workspace/projects/GAPI
bash start.sh
```

啟動腳本會自動完成以下工作：
- 建立 Python 虛擬環境（`server/venv/`）
- 安裝依賴（FastAPI, Uvicorn 等）
- 從 `.env.example` 建立 `.env` 並自動產生認證密鑰
- 在背景啟動 Server（PID 寫入 `server/.gapi.pid`）

### 2. 安裝 Chrome 擴充功能

1. 打開 `chrome://extensions`
2. 右上角開啟「開發人員模式」
3. 點「載入未封裝項目」
4. 選擇 GAPI 專案目錄（包含 `manifest.json` 的那個資料夾）
5. 確認擴充功能出現且無錯誤

### 3. 驗證連線

```bash
# 檢查 Server 狀態
curl http://localhost:18799/status

# 預期回應：
# {"status":"ok","service":"GAPI Server","version":"2.0.0",...}
```

打開一個 Gemini 分頁，等待 5 秒讓擴充功能建立 WebSocket 連線，然後查詢活躍頁面：

```bash
# 取得 Token（開發模式可跳過）
TOKEN=$(curl -s -X POST "http://localhost:18799/v1/auth/token?extension_id=test" | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")

# 查詢頁面
curl -H "Authorization: Bearer $TOKEN" http://localhost:18799/v1/conversations
```

## 日常使用

### 啟動 / 停止

```bash
bash start.sh    # 啟動（重複執行會提示已在運行）
bash stop.sh     # 停止
```

### 查看狀態

```bash
curl -s http://localhost:18799/status | python3 -m json.tool
```

### API 端點速查

| 端點 | 方法 | 說明 |
|------|------|------|
| `/status` | GET | 健康檢查（無需認證） |
| `/v1/auth/token` | POST | 產生認證 Token |
| `/v1/auth/api-keys` | POST/GET | 管理 API Keys |
| `/v1/conversations` | GET | 對話列表 |
| `/v1/conversations/{id}` | GET | 對話詳情（含訊息） |
| `/v1/conversations` | POST | 建立對話 |
| `/v1/messages` | POST | 發送訊息 |
| `/v1/images/upload` | POST | 上傳圖片（base64） |
| `/v1/images/upload-file` | POST | 上傳圖片（檔案） |
| `/v1/images/{id}` | GET/DELETE | 取得/刪除圖片 |
| `/v1/images` | GET | 圖片列表 |
| `/ws/{client_id}` | WS | WebSocket 即時通訊 |

完整 API 文件：啟動 Server 後訪問 `http://localhost:18799/docs`

詳細規格見 [API_SPEC.md](API_SPEC.md)。

### Admin Web 面板

```bash
cd admin-web && npm install && npm run dev
```

打開 `http://localhost:5173`

## 環境變數

所有變數定義在 `server/.env`（首次啟動時從 `.env.example` 自動建立）：

| 變數 | 預設值 | 說明 |
|------|--------|------|
| `GAPI_AUTH_SECRET` | （自動產生） | 認證密鑰，用於簽發 Token |
| `GAPI_DEV_MODE` | `false` | 開發模式，`true` 時允許無認證存取 |
| `GAPI_ALLOWED_ORIGINS` | `http://localhost:5173,chrome-extension://*` | CORS 允許來源 |
| `GAPI_MAX_UPLOAD_SIZE` | `10485760` | 圖片上傳大小限制（bytes，預設 10MB） |
| `GAPI_DB_PATH` | `./gapi.db` | SQLite 資料庫路徑 |
| `GAPI_IMAGE_DIR` | `./images` | 圖片儲存目錄 |
| `GAPI_RATE_LIMIT` | `60` | 一般端點速率限制（次/分鐘） |

## 故障排除

| 問題 | 解法 |
|------|------|
| Server 啟動失敗 | 確認 port 18799 沒被占用：`lsof -i :18799` |
| Extension 沒連上 | 到 `chrome://extensions` 檢查有無錯誤，點「重新載入」 |
| Token 驗證失敗 | 確認 `server/.env` 的 `GAPI_AUTH_SECRET` 有值 |
| 圖片上傳失敗 | 確認檔案小於 10MB，格式為 JPEG/PNG/GIF/WebP |
| WebSocket 斷線 | 檢查 Server 是否存活：`curl localhost:18799/status` |

## 架構

```
GAPI/
├── server/           # FastAPI 後端（Python）
│   ├── mcp_server.py # 主程式
│   ├── auth.py       # 認證模組
│   ├── image_service.py
│   └── rate_limiter.py
├── background.js     # Extension Service Worker
├── content.js        # Extension Content Script
├── manifest.json     # Chrome Extension Manifest V3
├── admin-web/        # React + Vite 管理面板
├── start.sh          # 一鍵啟動
└── stop.sh           # 一鍵停止
```

詳細架構見 [ARCHITECTURE.md](ARCHITECTURE.md)。

## 變更記錄

見 [CHANGELOG.md](CHANGELOG.md)。
