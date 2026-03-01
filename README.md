# GAPI — Gemini API Bridge

Chrome 擴充功能 + Python 伺服器，提供 Gemini 對話的 API 存取、圖片上傳與管理面板。

## 快速開始

```bash
# 安裝依賴
cd server && pip install -r requirements.txt

# 啟動伺服器（開發模式）
GAPI_DEV_MODE=true python3 mcp_server.py

# 啟動伺服器（生產模式）
export GAPI_AUTH_SECRET="your-secret-key"
python3 mcp_server.py
```

伺服器啟動在 `http://localhost:18799`，API 文件在 `/docs`。

## 架構

| 模組 | 技術 | 說明 |
|------|------|------|
| Server | FastAPI + SQLite | API 伺服器、WebSocket、認證 |
| Extension | Chrome MV3 | DOM 擷取、訊息同步 |
| Admin Web | React + Vite | 管理面板 |

詳見 [ARCHITECTURE.md](ARCHITECTURE.md) 和 [API_SPEC.md](API_SPEC.md)。

## 環境變數

| 變數 | 必要 | 說明 |
|------|------|------|
| `GAPI_AUTH_SECRET` | 生產環境 | 認證密鑰 |
| `GAPI_DEV_MODE` | 否 | 開發模式（預設 false） |
| `GAPI_ALLOWED_ORIGINS` | 否 | CORS 來源（逗號分隔） |

完整清單見 `server/.env.example`。

## 變更記錄

見 [CHANGELOG.md](CHANGELOG.md)。
