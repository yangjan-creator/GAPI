# GAPI API 操作調用文檔

Base URL: `http://localhost:18799`

---

## 系統架構概覽

```
外部程式 (curl/Python/OpenClaw)
    │
    ├── HTTP API ──→ GAPI Server (port 18799) ──→ SQLite DB
    │                    │
    │                    ├── WebSocket ←──→ Chrome Extension (background.js)
    │                    │                       │
    │                    │                       ├── Content Script → Gemini 分頁 1
    │                    │                       ├── Content Script → Gemini 分頁 2
    │                    │                       └── Content Script → Claude 分頁
    │                    │
    │                    └── /v1/pages ← Extension 定期回報活躍分頁
    │
    └── Swagger UI: http://localhost:18799/docs
```

**兩條控制路徑：**
1. **HTTP API → Server → WebSocket → Extension** — 透過 GAPI Server 間接控制
2. **chrome.runtime.sendMessageExternal** — 直接呼叫 Extension（需要 Extension ID）

本文檔只涵蓋 **路徑 1（HTTP API）**，這是推薦的使用方式。

---

## 目錄

1. [準備工作：取得認證](#1-準備工作取得認證)
2. [查看分頁：我有哪些頁面可以控制？](#2-查看分頁我有哪些頁面可以控制)
3. [指揮分頁：透過 API 發送訊息給 AI](#3-指揮分頁透過-api-發送訊息給-ai)
4. [完整操作範例：從零開始到收到回覆](#4-完整操作範例從零開始到收到回覆)
5. [對話管理](#5-對話管理)
6. [圖片管理](#6-圖片管理)
7. [分頁控制](#7-分頁控制)
8. [頁面檢查與資料擷取](#8-頁面檢查與資料擷取)
9. [Nebula 整合](#9-nebula-整合)
10. [Extension 管理](#10-extension-管理)
11. [站點配置](#11-站點配置)
12. [WebSocket 即時通訊](#12-websocket-即時通訊)
13. [錯誤處理與速率限制](#13-錯誤處理與速率限制)
14. [API Key 管理（長期使用）](#14-api-key-管理長期使用)

---

## 1. 準備工作：取得認證

所有 API 呼叫（除了 `/status`）都需要 Bearer Token。

### 第一步：確認 Server 活著

```bash
curl -s http://localhost:18799/status | python3 -m json.tool
```

預期回應：
```json
{
    "status": "ok",
    "service": "GAPI Server",
    "version": "2.0.0",
    "timestamp": 1772465267814
}
```

### 第二步：取得 Token

```bash
# 取得 Token 並存到變數
TOKEN=$(curl -s -X POST "http://localhost:18799/v1/auth/token?extension_id=my_app" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")

echo "Token: $TOKEN"
# 輸出類似：Token: ext_my_app_1772465300000_a3f8b2c1d4e5...
```

Token 格式：`ext_{extension_id}_{timestamp}_{hmac_signature}`

> Token 有效期約 1 小時。長期使用請建立 API Key（見第 14 節）。

### 驗證 Token 是否有效

```bash
curl -s -X POST "http://localhost:18799/v1/auth/validate?token=$TOKEN" | python3 -m json.tool
```

```json
{ "valid": true, "extension_id": "my_app" }
```

---

## 2. 查看分頁：我有哪些頁面可以控制？

Extension 安裝後，會自動偵測所有支援的 AI 網站分頁（Gemini、Claude 等），並定期回報給 Server。

### 2.1 列出所有活躍分頁

```bash
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:18799/v1/pages | python3 -m json.tool
```

回應範例（假設開了兩個 Gemini 分頁）：

```json
{
    "pages": [
        {
            "tab_id": 1847205382,
            "url": "https://gemini.google.com/app",
            "site": "gemini",
            "chat_id": null,
            "title": "Google Gemini",
            "user_profile": "default",
            "monitoring": false,
            "extension_id": "abcdefghijklmnopqrstuvwxyz"
        },
        {
            "tab_id": 1847205399,
            "url": "https://gemini.google.com/app/abc123def456",
            "site": "gemini",
            "chat_id": "abc123def456",
            "title": "量子計算討論",
            "user_profile": "default",
            "monitoring": true,
            "extension_id": "abcdefghijklmnopqrstuvwxyz"
        }
    ],
    "meta": {
        "total": 2,
        "connected_extensions": 1,
        "timestamp": 1772465300000
    }
}
```

### 每個欄位的意思

| 欄位 | 說明 | 範例 |
|------|------|------|
| `tab_id` | Chrome 分頁的唯一 ID，用來指定要控制哪個分頁 | `1847205382` |
| `url` | 分頁的完整 URL | `https://gemini.google.com/app` |
| `site` | 站點類型 | `gemini`、`claude`、`unknown` |
| `chat_id` | 該分頁正在進行的對話 ID（從 URL 解析） | `abc123def456` 或 `null`（新對話） |
| `title` | 分頁標題 | `Google Gemini` |
| `user_profile` | Google 帳號 profile（多帳號登入時區分） | `default`、`u0`、`u1` |
| `monitoring` | 是否正在監聽回覆 | `true` / `false` |
| `extension_id` | 回報此分頁的 Extension ID | `abcdefghijklmnop...` |

### 2.2 只看 Gemini 分頁

```bash
curl -s -H "Authorization: Bearer $TOKEN" "http://localhost:18799/v1/pages?site=gemini" | python3 -m json.tool
```

### 2.3 只看 Claude 分頁

```bash
curl -s -H "Authorization: Bearer $TOKEN" "http://localhost:18799/v1/pages?site=claude" | python3 -m json.tool
```

### 2.4 如何判斷分頁狀態

```
pages 回傳空陣列？
  └── Extension 沒連上 → 檢查 chrome://extensions 確認已安裝且無錯誤
      或：沒有打開支援的 AI 網站分頁

pages 有資料但 chat_id 是 null？
  └── 這是新對話分頁，還沒開始聊天

pages 有 chat_id？
  └── 這是進行中的對話，可以繼續發送訊息

meta.connected_extensions 是 0？
  └── Extension 的 WebSocket 還沒連上 Server
      → 重新載入 Extension 或等待自動重連
```

---

## 3. 指揮分頁：透過 API 發送訊息給 AI

### 核心流程

```
你的程式                    GAPI Server              Extension              Gemini 頁面
   │                           │                        │                      │
   ├── POST /v1/messages ─────→│                        │                      │
   │                           ├── WebSocket broadcast ─→│                      │
   │                           │   (message_pending)     ├── sendMessage ──────→│
   │                           │                        │                      │ (AI 思考中...)
   │   { status: "queued" } ←──┤                        │                      │
   │                           │                        │←── 回覆完成 ─────────┤
   │                           │←── conversation_sync ──┤                      │
   │                           │                        │                      │
   ├── GET /v1/conversations/X →│                        │                      │
   │   { messages: [...] }  ←──┤                        │                      │
```

### 3.1 發送訊息

```bash
# 先建立一個對話
CONV_ID=$(curl -s -X POST http://localhost:18799/v1/conversations \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title": "API 測試"}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")

echo "對話 ID: $CONV_ID"

# 發送訊息
curl -s -X POST http://localhost:18799/v1/messages \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"conversation_id\": \"$CONV_ID\", \"content\": \"用一句話解釋什麼是 API\"}" \
  | python3 -m json.tool
```

回應：
```json
{
    "message_id": "msg_1772465350000_e5f6g7h8",
    "status": "queued"
}
```

> `status: "queued"` 表示訊息已進入佇列。Server 會透過 WebSocket 通知 Extension，
> Extension 再把文字打進 Gemini 頁面的輸入框並送出。

### 3.2 POST /v1/messages 參數

| 欄位 | 類型 | 必填 | 說明 |
|------|------|------|------|
| `conversation_id` | string | 是 | 對話 ID（從 POST /v1/conversations 取得） |
| `content` | string | 是 | 要發送的訊息內容 |
| `role` | string | 否 | 預設 `user`。也可以是 `model` 或 `assistant`（用於記錄 AI 回覆） |
| `attachments` | string[] | 否 | 圖片附件 ID 列表 |

### 3.3 查詢對話結果（等 AI 回覆）

發送訊息後，AI 需要時間思考。你可以定期查詢對話內容：

```bash
# 等幾秒讓 AI 回覆
sleep 10

# 查詢對話（含所有訊息）
curl -s -H "Authorization: Bearer $TOKEN" \
  "http://localhost:18799/v1/conversations/$CONV_ID" | python3 -m json.tool
```

回應範例：
```json
{
    "id": "conv_1772465340000_a1b2c3d4",
    "title": "API 測試",
    "created_at": 1772465340000,
    "updated_at": 1772465355000,
    "messages": [
        {
            "id": "msg_1772465350000_e5f6g7h8",
            "conversation_id": "conv_1772465340000_a1b2c3d4",
            "role": "user",
            "content": "用一句話解釋什麼是 API",
            "attachments": null,
            "timestamp": 1772465350000
        },
        {
            "id": "msg_1772465355000_f6g7h8i9",
            "conversation_id": "conv_1772465340000_a1b2c3d4",
            "role": "model",
            "content": "API 是一組規則和協議，讓不同的軟體程式可以互相溝通和交換資料。",
            "attachments": null,
            "timestamp": 1772465355000
        }
    ]
}
```

---

## 4. 完整操作範例：從零開始到收到回覆

### 範例 A：用 Bash 腳本自動化

```bash
#!/bin/bash
# gapi_chat.sh — 透過 GAPI 向 Gemini 發送問題並取得回覆

BASE="http://localhost:18799"
MESSAGE="$1"

if [ -z "$MESSAGE" ]; then
  echo "用法: bash gapi_chat.sh '你的問題'"
  exit 1
fi

# 1. 取得 Token
echo "[1/5] 取得認證..."
TOKEN=$(curl -s -X POST "$BASE/v1/auth/token?extension_id=chat_script" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")

# 2. 確認有 Gemini 分頁
echo "[2/5] 檢查 Gemini 分頁..."
PAGES=$(curl -s -H "Authorization: Bearer $TOKEN" "$BASE/v1/pages?site=gemini")
PAGE_COUNT=$(echo "$PAGES" | python3 -c "import sys,json; print(json.load(sys.stdin)['meta']['total'])")

if [ "$PAGE_COUNT" = "0" ]; then
  echo "[ERROR] 沒有找到 Gemini 分頁！請先在 Chrome 打開 gemini.google.com"
  exit 1
fi

echo "  找到 $PAGE_COUNT 個 Gemini 分頁"
echo "$PAGES" | python3 -c "
import sys,json
data = json.load(sys.stdin)
for p in data['pages']:
    print(f\"  - tab_id={p['tab_id']} title={p.get('title','')} chat_id={p.get('chat_id','新對話')}\")
"

# 3. 建立對話
echo "[3/5] 建立對話..."
CONV_ID=$(curl -s -X POST "$BASE/v1/conversations" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title": "CLI Chat"}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")

# 4. 發送訊息
echo "[4/5] 發送訊息: $MESSAGE"
curl -s -X POST "$BASE/v1/messages" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"conversation_id\": \"$CONV_ID\", \"content\": \"$MESSAGE\"}" > /dev/null

# 5. 等待回覆
echo "[5/5] 等待 AI 回覆..."
for i in $(seq 1 12); do
  sleep 5
  RESULT=$(curl -s -H "Authorization: Bearer $TOKEN" "$BASE/v1/conversations/$CONV_ID")
  MSG_COUNT=$(echo "$RESULT" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('messages',[])))")

  if [ "$MSG_COUNT" -gt "1" ]; then
    echo ""
    echo "=== AI 回覆 ==="
    echo "$RESULT" | python3 -c "
import sys,json
msgs = json.load(sys.stdin)['messages']
for m in msgs:
    role = '你' if m['role']=='user' else 'AI'
    print(f'[{role}] {m[\"content\"][:200]}')
"
    exit 0
  fi
  echo "  等待中... ($((i*5)) 秒)"
done

echo "[TIMEOUT] 60 秒內未收到回覆"
```

用法：
```bash
bash gapi_chat.sh "台灣最高的山是什麼？"
```

### 範例 B：用 Python 操作

```python
"""gapi_client.py — GAPI Python 操作範例"""
import requests
import time

BASE = "http://localhost:18799"

def get_token():
    """取得認證 Token"""
    r = requests.post(f"{BASE}/v1/auth/token", params={"extension_id": "python_client"})
    return r.json()["token"]

def list_pages(token, site=None):
    """列出活躍分頁"""
    params = {"site": site} if site else {}
    r = requests.get(f"{BASE}/v1/pages", headers={"Authorization": f"Bearer {token}"}, params=params)
    return r.json()

def create_conversation(token, title="Python Chat"):
    """建立對話"""
    r = requests.post(f"{BASE}/v1/conversations",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        json={"title": title})
    return r.json()

def send_message(token, conversation_id, content):
    """發送訊息"""
    r = requests.post(f"{BASE}/v1/messages",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        json={"conversation_id": conversation_id, "content": content})
    return r.json()

def get_conversation(token, conversation_id):
    """取得對話詳情"""
    r = requests.get(f"{BASE}/v1/conversations/{conversation_id}",
        headers={"Authorization": f"Bearer {token}"})
    return r.json()

def chat(question, wait_seconds=60):
    """一次完整的問答流程"""
    token = get_token()

    # 確認有分頁
    pages = list_pages(token, site="gemini")
    if pages["meta"]["total"] == 0:
        print("沒有 Gemini 分頁！請先打開 gemini.google.com")
        return None

    print(f"找到 {pages['meta']['total']} 個 Gemini 分頁：")
    for p in pages["pages"]:
        print(f"  tab_id={p['tab_id']}  title={p.get('title','')}  chat_id={p.get('chat_id','新對話')}")

    # 建立對話並發送
    conv = create_conversation(token)
    print(f"\n對話 ID: {conv['id']}")

    result = send_message(token, conv["id"], question)
    print(f"訊息狀態: {result['status']}")

    # 等待回覆
    for i in range(wait_seconds // 5):
        time.sleep(5)
        data = get_conversation(token, conv["id"])
        messages = data.get("messages", [])
        if len(messages) > 1:
            print(f"\n--- AI 回覆 ---")
            for m in messages:
                role = "你" if m["role"] == "user" else "AI"
                print(f"[{role}] {m['content']}")
            return data
        print(f"  等待中... ({(i+1)*5}s)")

    print("超時，未收到回覆")
    return None


if __name__ == "__main__":
    chat("Python 的 GIL 是什麼？用簡單的比喻解釋")
```

---

## 5. 對話管理

### 5.1 建立對話

```bash
curl -s -X POST http://localhost:18799/v1/conversations \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title": "我的對話"}' | python3 -m json.tool
```

```json
{
    "id": "conv_1772465340000_a1b2c3d4",
    "title": "我的對話",
    "created_at": 1772465340000,
    "updated_at": 1772465340000
}
```

### 5.2 列出所有對話

```bash
# 預設取 50 筆
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:18799/v1/conversations | python3 -m json.tool

# 分頁：取 10 筆，從指定 cursor 開始
curl -s -H "Authorization: Bearer $TOKEN" \
  "http://localhost:18799/v1/conversations?limit=10&cursor=1772465340000" | python3 -m json.tool
```

### 5.3 取得對話詳情（含所有訊息）

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  http://localhost:18799/v1/conversations/conv_1772465340000_a1b2c3d4 | python3 -m json.tool
```

---

## 6. 圖片管理

### 6.1 上傳圖片（檔案方式，推薦）

```bash
curl -s -X POST http://localhost:18799/v1/images/upload-file \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@screenshot.png" \
  -F "conversation_id=conv_xxx" | python3 -m json.tool
```

```json
{
    "image_id": "img_1772465400000_abcd1234",
    "url": "/v1/images/2026/03/02/img_1772465400000_abcd1234.png",
    "filename": "screenshot.png",
    "mime_type": "image/png",
    "size": 12345,
    "created_at": 1772465400000
}
```

### 6.2 上傳圖片（Base64 方式）

```bash
IMG_B64=$(base64 -w0 photo.png)
curl -s -X POST http://localhost:18799/v1/images/upload \
  -H "Authorization: Bearer $TOKEN" \
  -F "image_data=$IMG_B64" \
  -F "filename=photo.png" | python3 -m json.tool
```

### 6.3 下載圖片

```bash
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:18799/v1/images/img_xxx --output downloaded.png
```

### 6.4 列出圖片

```bash
# 全部
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:18799/v1/images | python3 -m json.tool

# 按對話篩選
curl -s -H "Authorization: Bearer $TOKEN" \
  "http://localhost:18799/v1/images?conversation_id=conv_xxx" | python3 -m json.tool
```

### 6.5 刪除圖片

```bash
curl -s -X DELETE -H "Authorization: Bearer $TOKEN" \
  http://localhost:18799/v1/images/img_xxx | python3 -m json.tool
```

限制：最大 10MB，格式 JPEG / PNG / GIF / WebP。

---

## 7. 分頁控制

### 7.1 導航分頁到指定 URL

讓指定分頁導航到新的 URL。Server 透過 WebSocket 將導航指令傳送給 Extension，Extension 再操作 Chrome 分頁。

```bash
curl -s -X POST http://localhost:18799/v1/tabs/1847205382/navigate \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://gemini.google.com/app"}' | python3 -m json.tool
```

回應範例：

```json
{
    "command_id": "cmd_1772465500000_x1y2z3",
    "status": "ok",
    "result": {
        "status": "success",
        "tab_id": 1847205382,
        "url": "https://gemini.google.com/app"
    }
}
```

#### POST /v1/tabs/{tab_id}/navigate 參數

| 欄位 | 類型 | 必填 | 說明 |
|------|------|------|------|
| `url` | string | 是 | 要導航到的目標 URL |

> `tab_id` 從 `GET /v1/pages` 取得。導航完成後，Extension 會自動回報分頁的新狀態。

---

## 8. 頁面檢查與資料擷取

透過 `POST /v1/tabs/{tab_id}/inspect` 端點，可以對指定分頁執行各種檢查與資料擷取動作。

### 8.1 擷取對話中的圖片

從目前的對話頁面擷取所有圖片 URL。支援 Gemini、Claude 及一般網頁。

```bash
curl -s -X POST http://localhost:18799/v1/tabs/1847205382/inspect \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"action": "EXTRACT_IMAGES"}' | python3 -m json.tool
```

回應範例：

```json
{
    "command_id": "cmd_1772465510000_a1b2c3",
    "status": "ok",
    "result": {
        "images": [
            "https://lh3.googleusercontent.com/...",
            "https://gemini.google.com/share/img/..."
        ],
        "count": 2,
        "site": "gemini"
    }
}
```

### 8.2 自訂 CSS 查詢（customQuery）

在指定分頁上執行自訂的 CSS 選擇器查詢，取得匹配元素的內容。

```bash
curl -s -X POST http://localhost:18799/v1/tabs/1847205382/inspect \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"action": "customQuery", "selector": "div.response-content"}' | python3 -m json.tool
```

#### POST /v1/tabs/{tab_id}/inspect 參數

| 欄位 | 類型 | 必填 | 說明 |
|------|------|------|------|
| `action` | string | 是 | 要執行的動作（見下方列表） |
| `selector` | string | 視動作而定 | CSS 選擇器（`customQuery` 時必填） |

#### 支援的 action 列表

| action | 說明 | 適用站點 |
|--------|------|----------|
| `EXTRACT_IMAGES` | 擷取對話中的圖片 URL | Gemini、Claude、一般網頁 |
| `inspectToolCalls` | 列出 Nebula 對話中的 tool calls | Nebula |
| `expandToolCalls` | 展開並取得 tool calls 的完整內容 | Nebula |
| `customQuery` | 執行自訂 CSS 選擇器查詢 | 所有站點 |

> Nebula 專屬的 inspect 動作（`inspectToolCalls`、`expandToolCalls`）需要分頁開啟 `nebula.gg/chat/channel/*` 頁面。詳見第 9 節。

---

## 9. Nebula 整合

GAPI 支援 [Nebula](https://nebula.gg) 平台的對話分頁。以下端點專門用於 Nebula 的檔案管理與工具呼叫檢查。

> **前提條件**：目標分頁必須開啟 `nebula.gg/chat/channel/*` 頁面。先用 `GET /v1/pages` 確認有 Nebula 分頁，取得對應的 `tab_id`。

### 9.1 列出 Nebula 討論串中的檔案

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  http://localhost:18799/v1/nebula/tabs/1847205400/files | python3 -m json.tool
```

回應範例：

```json
{
    "files": [
        {
            "id": "file_abc123",
            "filename": "main.py",
            "file_extension": ".py",
            "size_bytes": 2048,
            "folder_path": "/src",
            "source": "assistant",
            "created_at": "2026-03-03T10:30:00Z"
        },
        {
            "id": "file_def456",
            "filename": "config.json",
            "file_extension": ".json",
            "size_bytes": 512,
            "folder_path": "/",
            "source": "user",
            "created_at": "2026-03-03T10:28:00Z"
        }
    ],
    "meta": {
        "total": 2,
        "tab_id": 1847205400
    }
}
```

#### 檔案欄位說明

| 欄位 | 類型 | 說明 |
|------|------|------|
| `id` | string | 檔案唯一 ID |
| `filename` | string | 檔案名稱 |
| `file_extension` | string | 副檔名（含點號） |
| `size_bytes` | number | 檔案大小（位元組） |
| `folder_path` | string | 檔案在專案中的路徑 |
| `source` | string | 來源：`user`（使用者上傳）或 `assistant`（AI 產生） |
| `created_at` | string | 建立時間（ISO 8601） |

### 9.2 取得 Nebula 檔案內容

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  http://localhost:18799/v1/nebula/tabs/1847205400/files/file_abc123 | python3 -m json.tool
```

回應範例（文字檔）：

```json
{
    "id": "file_abc123",
    "filename": "main.py",
    "content": "import os\nimport sys\n\ndef main():\n    print('Hello from Nebula')\n\nif __name__ == '__main__':\n    main()\n",
    "content_type": "text/plain"
}
```

回應範例（JSON 檔）：

```json
{
    "id": "file_def456",
    "filename": "config.json",
    "content": {
        "debug": true,
        "port": 8080
    },
    "content_type": "application/json"
}
```

> 回應的 `content` 欄位類型取決於檔案類型：純文字檔回傳字串，JSON 檔回傳解析後的物件。

### 9.3 檢查 Nebula 工具呼叫（Tool Calls）

#### 列出工具呼叫

```bash
curl -s -X POST http://localhost:18799/v1/tabs/1847205400/inspect \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"action": "inspectToolCalls"}' | python3 -m json.tool
```

回應範例：

```json
{
    "command_id": "cmd_1772465520000_t1u2v3",
    "status": "ok",
    "result": {
        "tool_calls": [
            {
                "index": 0,
                "name": "create_file",
                "summary": "建立 main.py"
            },
            {
                "index": 1,
                "name": "run_command",
                "summary": "執行 python main.py"
            }
        ],
        "count": 2
    }
}
```

#### 展開工具呼叫詳情

```bash
curl -s -X POST http://localhost:18799/v1/tabs/1847205400/inspect \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"action": "expandToolCalls"}' | python3 -m json.tool
```

回應範例：

```json
{
    "command_id": "cmd_1772465530000_w1x2y3",
    "status": "ok",
    "result": {
        "tool_calls": [
            {
                "index": 0,
                "name": "create_file",
                "input": {
                    "path": "/src/main.py",
                    "content": "import os\n..."
                },
                "output": "File created successfully"
            },
            {
                "index": 1,
                "name": "run_command",
                "input": {
                    "command": "python main.py"
                },
                "output": "Hello from Nebula"
            }
        ],
        "count": 2
    }
}
```

---

## 10. Extension 管理

### 10.1 重新載入 Extension

提供三種模式重新載入 Extension，從輕量到完整重啟。

```
POST /v1/extension/reload
```

#### 模式 A：軟重載（soft）

重新注入 Content Script 到所有分頁。需要 Extension 的 WebSocket 連線處於活躍狀態。

```bash
curl -s -X POST http://localhost:18799/v1/extension/reload \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"mode": "soft"}' | python3 -m json.tool
```

#### 模式 B：完整重載（full）

呼叫 `chrome.runtime.reload()` 重新載入整個 Extension。需要 Extension 的 WebSocket 連線處於活躍狀態。

```bash
curl -s -X POST http://localhost:18799/v1/extension/reload \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"mode": "full"}' | python3 -m json.tool
```

#### 模式 C：硬重啟（hard）

終止 Chrome 程序並重新啟動。這是最強力的模式，不需要 WebSocket 連線。可選擇性指定重啟後要開啟的頁面。

```bash
# 硬重啟，不指定頁面（Chrome 恢復上次的分頁）
curl -s -X POST http://localhost:18799/v1/extension/reload \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"mode": "hard"}' | python3 -m json.tool

# 硬重啟，指定要開啟的頁面
curl -s -X POST http://localhost:18799/v1/extension/reload \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "mode": "hard",
    "urls": [
      "https://gemini.google.com/app",
      "https://nebula.gg/chat/channel/my-project"
    ]
  }' | python3 -m json.tool
```

#### POST /v1/extension/reload 參數

| 欄位 | 類型 | 必填 | 說明 |
|------|------|------|------|
| `mode` | string | 是 | 重載模式：`soft`、`full`、`hard` |
| `urls` | string[] | 否 | `hard` 模式專用：重啟後要開啟的頁面 URL 列表 |

#### 三種模式比較

| 模式 | 需要連線 | 影響範圍 | 使用場景 |
|------|----------|----------|----------|
| `soft` | 是 | 僅 Content Script | Content Script 更新後重新注入 |
| `full` | 是 | 整個 Extension | Extension 程式碼變更、Service Worker 異常 |
| `hard` | 否 | Chrome + Extension | Extension 完全無回應、WebSocket 斷線無法恢復 |

> **注意**：`hard` 模式會關閉所有 Chrome 視窗和分頁。確保已儲存工作後再使用。

---

## 11. 站點配置

管理 Extension 的 DOM 選擇器配置（進階用途，一般不需要動）。

```bash
# 列出
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:18799/v1/config/sites | python3 -m json.tool

# 新增/更新
curl -s -X POST http://localhost:18799/v1/config/sites \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "url_pattern": "gemini.google.com",
    "name": "Gemini",
    "selectors": {"input": ".ql-editor", "send_button": "button[aria-label=\"Send\"]"},
    "enabled": true
  }' | python3 -m json.tool

# 刪除
curl -s -X DELETE -H "Authorization: Bearer $TOKEN" \
  http://localhost:18799/v1/config/sites/site_abc123 | python3 -m json.tool
```

---

## 12. WebSocket 即時通訊

如果你需要即時接收 AI 回覆（不想 polling），可以用 WebSocket。

### Python 範例

```python
import asyncio, json, requests, websockets

BASE = "http://localhost:18799"

async def realtime_chat():
    # 1. 取得 Token
    token = requests.post(f"{BASE}/v1/auth/token",
        params={"extension_id": "ws_client"}).json()["token"]

    # 2. 建立 WebSocket 連線
    async with websockets.connect(f"ws://localhost:18799/ws/my_client") as ws:

        # 3. 認證（必須在 5 秒內完成）
        await ws.send(json.dumps({
            "type": "auth",
            "payload": {"token": token}
        }))
        auth_resp = json.loads(await ws.recv())
        print(f"認證結果: {auth_resp['type']}")  # auth_ok

        if auth_resp["type"] != "auth_ok":
            print("認證失敗！")
            return

        # 4. 持續監聽訊息
        print("已連線，等待事件...")
        async for raw in ws:
            msg = json.loads(raw)
            print(f"收到: {msg['type']} → {json.dumps(msg.get('payload',{}), ensure_ascii=False)[:100]}")

asyncio.run(realtime_chat())
```

### WebSocket 訊息類型

| 你發送 | Server 回覆 | 說明 |
|--------|-------------|------|
| `{"type":"ping"}` | `{"type":"pong","ts":...}` | 心跳 |
| `{"type":"conversation_sync","payload":{"conversation_id":"conv_xxx"}}` | `{"type":"conversation_data","payload":{...}}` | 同步對話 |
| `{"type":"message_send","payload":{"conversation_id":"conv_xxx","content":"你好"}}` | `{"type":"message_sent","payload":{"message_id":"msg_xxx","status":"ok"}}` | 發送訊息 |
| `{"type":"pages_sync","payload":{"pages":[...]}}` | `{"type":"pages_sync_ok","payload":{"count":N}}` | 頁面同步 |

### Server 主動推送

當有人透過 HTTP `POST /v1/messages` 發送 user 訊息時，所有 WebSocket 連線會收到：

```json
{
  "type": "message_pending",
  "payload": {
    "message_id": "msg_xxx",
    "conversation_id": "conv_xxx",
    "content": "問題內容",
    "timestamp": 1772465350000
  }
}
```

---

## 13. 錯誤處理與速率限制

### HTTP 狀態碼

| 狀態碼 | 說明 | 常見原因 |
|--------|------|----------|
| 400 | 請求格式錯誤 | JSON 格式錯、缺少必填欄位 |
| 401 | 認證失敗 | Token 過期或無效 |
| 404 | 資源不存在 | 對話 ID 或圖片 ID 不存在 |
| 429 | 速率限制 | 請求太頻繁，等 `Retry-After` 秒後重試 |
| 500 | 伺服器錯誤 | 檢查 Server 日誌 |

### 速率限制

| 端點類別 | 限制 | 回應 Header |
|----------|------|-------------|
| `/v1/auth/*` | 10 次/分鐘 | `X-RateLimit-Remaining` |
| `/v1/images/upload*` | 10 次/分鐘 | `X-RateLimit-Remaining` |
| 其他端點 | 60 次/分鐘 | `X-RateLimit-Remaining` |

---

## 14. API Key 管理（長期使用）

Token 約 1 小時過期。如果你的腳本要長期運行，建立 API Key 更方便。

### 建立 API Key

```bash
curl -s -X POST http://localhost:18799/v1/auth/api-keys \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "my-automation", "expires_in_days": 90}' | python3 -m json.tool
```

```json
{
    "key_id": "key_abc123",
    "api_key": "gapi_xxxxxxxxxxxxxxxxxxxxxxxx",
    "name": "my-automation",
    "created_at": 1772465300000,
    "expires_at": 1780241300000
}
```

> `api_key` 只顯示一次！請立即保存。

### 用 API Key 呼叫 API

```bash
# API Key 直接當 Bearer Token 使用
APIKEY="gapi_xxxxxxxxxxxxxxxxxxxxxxxx"

curl -s -H "Authorization: Bearer $APIKEY" http://localhost:18799/v1/pages | python3 -m json.tool
curl -s -H "Authorization: Bearer $APIKEY" http://localhost:18799/v1/conversations | python3 -m json.tool
```

### 管理 API Keys

```bash
# 列出所有 Keys
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:18799/v1/auth/api-keys | python3 -m json.tool

# 撤銷某個 Key
curl -s -X DELETE -H "Authorization: Bearer $TOKEN" http://localhost:18799/v1/auth/api-keys/key_abc123

# 驗證 Key 是否有效
curl -s -X POST "http://localhost:18799/v1/auth/api-keys/validate?api_key=gapi_xxx" | python3 -m json.tool
```

---

## 端點速查表

| 端點 | 方法 | 認證 | 說明 |
|------|------|------|------|
| `/status` | GET | 不需要 | 健康檢查 |
| `/docs` | GET | 不需要 | Swagger 互動文件 |
| `/v1/auth/token` | POST | 不需要 | 取得 Token |
| `/v1/auth/validate` | POST | 不需要 | 驗證 Token |
| `/v1/auth/api-keys` | POST | 需要 | 建立 API Key |
| `/v1/auth/api-keys` | GET | 需要 | 列出 API Keys |
| `/v1/auth/api-keys/{id}` | DELETE | 需要 | 撤銷 API Key |
| `/v1/auth/api-keys/validate` | POST | 不需要 | 驗證 API Key |
| `/v1/pages` | GET | 需要 | **列出活躍分頁** |
| `/v1/conversations` | GET | 需要 | 對話列表 |
| `/v1/conversations/{id}` | GET | 需要 | 對話詳情 |
| `/v1/conversations` | POST | 需要 | 建立對話 |
| `/v1/messages` | POST | 需要 | **發送訊息** |
| `/v1/images/upload` | POST | 需要 | 上傳圖片（base64） |
| `/v1/images/upload-file` | POST | 需要 | 上傳圖片（檔案） |
| `/v1/images/{id}` | GET | 需要 | 下載圖片 |
| `/v1/images` | GET | 需要 | 圖片列表 |
| `/v1/images/{id}` | DELETE | 需要 | 刪除圖片 |
| `/v1/tabs/{tab_id}/navigate` | POST | 需要 | **導航分頁到指定 URL** |
| `/v1/tabs/{tab_id}/inspect` | POST | 需要 | **頁面檢查與資料擷取** |
| `/v1/nebula/tabs/{tab_id}/files` | GET | 需要 | **列出 Nebula 檔案** |
| `/v1/nebula/tabs/{tab_id}/files/{file_id}` | GET | 需要 | **取得 Nebula 檔案內容** |
| `/v1/extension/reload` | POST | 需要 | **重新載入 Extension** |
| `/v1/config/sites` | GET/POST | 需要 | 站點配置 |
| `/v1/config/sites/{id}` | DELETE | 需要 | 刪除站點配置 |
| `/v1/bridge` | POST | 不需要 | CDP 橋接（Legacy） |
| `/ws/{client_id}` | WS | 連線後認證 | WebSocket 即時通訊 |
