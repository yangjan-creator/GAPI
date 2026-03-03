# GAPI API Quick Reference

**Base URL:** `http://localhost:18799`
**Auth:** Most endpoints require `Authorization: Bearer <token>` header.

## Get Token

```bash
# Get a token (no auth required, rate limited 10/min)
TOKEN=$(curl -s -X POST "http://localhost:18799/v1/auth/token?extension_id=my-client" | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")
```

Token is valid for 1 hour. Reuse it — no need to request a new one for each call.

---

## Tab Control (Core)

### List Active Pages
```bash
curl -s http://localhost:18799/v1/pages \
  -H "Authorization: Bearer $TOKEN"
```
Returns all browser tabs with Gemini/Claude open. Each tab has `tab_id`, `url`, `site`, `chat_id`, `title`.

### Create New Tab
```bash
curl -s -X POST http://localhost:18799/v1/tabs/create \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://gemini.google.com/app"}'
```
Opens a new browser tab. To reopen a specific conversation:
```bash
-d '{"url": "https://gemini.google.com/app/d37bda7662d1e23b"}'
```

### Send Message to Tab
```bash
curl -s -X POST http://localhost:18799/v1/tabs/{tab_id}/send \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"message": "你好", "wait_response": true, "timeout": 30}'
```
- `wait_response: true` — waits for send confirmation (not AI reply)
- `wait_response: false` — fire and forget, returns `command_id`

### Get Last AI Response
```bash
curl -s -X POST http://localhost:18799/v1/tabs/{tab_id}/get-response \
  -H "Authorization: Bearer $TOKEN"
```
Scrapes the last AI response from the tab's DOM. Call this after sending a message and waiting for Gemini to finish.

### Get Tab Info (Title, Chat ID)
```bash
curl -s http://localhost:18799/v1/tabs/{tab_id}/info \
  -H "Authorization: Bearer $TOKEN"
```
Returns conversation `chat_id`, `title`, and `url`.

---

## Full Workflow Example

```bash
# 1. Get token
TOKEN=$(curl -s -X POST "http://localhost:18799/v1/auth/token?extension_id=demo" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")

# 2. Check pages
curl -s http://localhost:18799/v1/pages -H "Authorization: Bearer $TOKEN"
# → find tab_id from result, e.g. 2121985188

# 3. Send a question
curl -s -X POST http://localhost:18799/v1/tabs/2121985188/send \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"message": "什麼是量子計算？", "wait_response": true}'

# 4. Wait for Gemini to respond (10-20 seconds)
sleep 15

# 5. Get the response
curl -s -X POST http://localhost:18799/v1/tabs/2121985188/get-response \
  -H "Authorization: Bearer $TOKEN"
```

---

## Extension Management

### Reload Extension
```bash
# Soft reload (reinject content scripts, no restart)
curl -s -X POST http://localhost:18799/v1/extension/reload \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"mode": "soft"}'

# Hard reload (kill Chrome + restart)
curl -s -X POST http://localhost:18799/v1/extension/reload \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"mode": "hard", "urls": ["https://gemini.google.com/app"]}'
```

---

## Health Check (No Auth)

```bash
curl -s http://localhost:18799/status
# → {"status":"ok", "connected_extensions":1, ...}
```

---

## Other Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/v1/auth/token?extension_id=xxx` | Get auth token |
| POST | `/v1/auth/validate` | Validate token |
| POST | `/v1/auth/api-keys` | Create API key |
| GET | `/v1/auth/api-keys` | List API keys |
| DELETE | `/v1/auth/api-keys/{key_id}` | Delete API key |
| GET | `/v1/conversations` | List conversations |
| GET | `/v1/conversations/{id}` | Get conversation detail |
| POST | `/v1/conversations` | Create conversation |
| POST | `/v1/messages` | Save message |
| POST | `/v1/images/upload` | Upload image (base64) |
| POST | `/v1/images/upload-file` | Upload image (multipart) |
| GET | `/v1/images/{image_id}` | Get image |
| GET | `/v1/images` | List images |
| DELETE | `/v1/images/{image_id}` | Delete image |
| GET | `/v1/config/sites` | List site configs |
| POST | `/v1/config/sites` | Create site config |
| DELETE | `/v1/config/sites/{id}` | Delete site config |
| POST | `/v1/bridge` | Bridge message |
| WS | `/ws/{client_id}` | WebSocket connection |

---

## Server Management

```bash
# Start
bash /home/sky/.openclaw/workspace/projects/GAPI/start.sh

# Stop
bash /home/sky/.openclaw/workspace/projects/GAPI/stop.sh

# Logs
tail -f /home/sky/.openclaw/workspace/projects/GAPI/server/gapi.log
```

**Docs:** http://localhost:18799/docs (Swagger UI)
