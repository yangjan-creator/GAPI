"""
GAPI Server - Gemini API Server with WebSocket Authentication
Based on API_SPEC.md
"""
import os
import sqlite3
from contextlib import contextmanager
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import BaseModel
from typing import List, Dict, Optional
import uvicorn
import time
import json
import secrets
import hashlib
import hmac
from datetime import datetime

app = FastAPI(title="GAPI Server", version="1.0.0")

# ========== Security ==========
security = HTTPBearer(auto_error=False)

# ========== Configuration ==========
# 認證 Secret Key (在生產環境應從環境變數讀取)
AUTH_SECRET = "gapi_dev_secret_key_change_in_production"
TOKEN_EXPIRE_SECONDS = 3600  # 1 hour

# SQLite Database Path
DB_PATH = os.path.join(os.path.dirname(__file__), "gapi.db")

# CORS Middleware for WebSocket support
origins = ["*"]
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ========== Data Models ==========
class AuthRequest(BaseModel):
    token: str


class AuthResponse(BaseModel):
    type: str = "auth_ok"
    payload: dict


class Message(BaseModel):
    id: str
    conversation_id: str
    role: str  # "user", "model", "system"
    content: str
    attachments: Optional[List[str]] = None
    timestamp: int


class Conversation(BaseModel):
    id: str
    title: str
    created_at: int
    updated_at: int
    messages: List[Message] = []


class ConversationCreate(BaseModel):
    title: Optional[str] = None


class MessageSend(BaseModel):
    conversation_id: str
    content: str
    attachments: Optional[List[str]] = None


# ========== SQLite Storage ==========
class SQLiteStore:
    """SQLite 持久化儲存"""
    
    def __init__(self, db_path: str = DB_PATH):
        self.db_path = db_path
        self._init_db()
    
    @contextmanager
    def _get_connection(self):
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()
    
    def _init_db(self):
        """初始化數據庫表結構"""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            # Sessions 表
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS sessions (
                    session_id TEXT PRIMARY KEY,
                    extension_id TEXT NOT NULL,
                    expires_at INTEGER NOT NULL,
                    created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
                )
            """)
            # Conversations 表
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS conversations (
                    id TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                )
            """)
            # Messages 表
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS messages (
                    id TEXT PRIMARY KEY,
                    conversation_id TEXT NOT NULL,
                    role TEXT NOT NULL,
                    content TEXT NOT NULL,
                    attachments TEXT,
                    timestamp INTEGER NOT NULL,
                    FOREIGN KEY (conversation_id) REFERENCES conversations(id)
                )
            """)
            # Tokens 表
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS tokens (
                    token TEXT PRIMARY KEY,
                    extension_id TEXT NOT NULL,
                    expires_at INTEGER NOT NULL,
                    created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
                )
            """)
            # API Keys 表
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS api_keys (
                    key_id TEXT PRIMARY KEY,
                    api_key TEXT NOT NULL UNIQUE,
                    name TEXT NOT NULL,
                    created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
                    expires_at INTEGER,
                    is_active INTEGER DEFAULT 1
                )
            """)
            # 建立範例數據（如果沒有數據）
            cursor.execute("SELECT COUNT(*) FROM conversations")
            if cursor.fetchone()[0] == 0:
                now = int(time.time() * 1000)
                cursor.execute(
                    "INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
                    ("conv_sample_001", "Sample Chat", now - 86400000, now)
                )
                cursor.execute(
                    "INSERT INTO messages (id, conversation_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)",
                    ("msg_001", "conv_sample_001", "user", "Hello, AI!", now - 3600000)
                )
                cursor.execute(
                    "INSERT INTO messages (id, conversation_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)",
                    ("msg_002", "conv_sample_001", "model", "Hello! How can I help you today?", now - 3500000)
                )
    
    # ========== Session Methods ==========
    def create_session(self, session_id: str, extension_id: str, expires_at: int):
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "INSERT OR REPLACE INTO sessions (session_id, extension_id, expires_at) VALUES (?, ?, ?)",
                (session_id, extension_id, expires_at)
            )
    
    def get_session(self, session_id: str) -> Optional[dict]:
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM sessions WHERE session_id = ?", (session_id,))
            row = cursor.fetchone()
            if row:
                return dict(row)
            return None
    
    def delete_session(self, session_id: str):
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("DELETE FROM sessions WHERE session_id = ?", (session_id,))
    
    # ========== Conversation Methods ==========
    def list_conversations(self) -> List[Conversation]:
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM conversations ORDER BY updated_at DESC")
            rows = cursor.fetchall()
            conversations = []
            for row in rows:
                conv = Conversation(
                    id=row["id"],
                    title=row["title"],
                    created_at=row["created_at"],
                    updated_at=row["updated_at"],
                    messages=self.get_messages(row["id"])
                )
                conversations.append(conv)
            return conversations
    
    def get_conversation(self, conv_id: str) -> Optional[Conversation]:
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM conversations WHERE id = ?", (conv_id,))
            row = cursor.fetchone()
            if row:
                return Conversation(
                    id=row["id"],
                    title=row["title"],
                    created_at=row["created_at"],
                    updated_at=row["updated_at"],
                    messages=self.get_messages(row["id"])
                )
            return None
    
    def create_conversation(self, conv_id: str, title: str) -> Conversation:
        now = int(time.time() * 1000)
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
                (conv_id, title, now, now)
            )
        return Conversation(id=conv_id, title=title, created_at=now, updated_at=now, messages=[])
    
    def update_conversation(self, conv_id: str):
        now = int(time.time() * 1000)
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("UPDATE conversations SET updated_at = ? WHERE id = ?", (now, conv_id))
    
    # ========== Message Methods ==========
    def get_messages(self, conv_id: str) -> List[Message]:
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "SELECT * FROM messages WHERE conversation_id = ? ORDER BY timestamp ASC",
                (conv_id,)
            )
            rows = cursor.fetchall()
            messages = []
            for row in rows:
                attachments = json.loads(row["attachments"]) if row["attachments"] else None
                messages.append(Message(
                    id=row["id"],
                    conversation_id=row["conversation_id"],
                    role=row["role"],
                    content=row["content"],
                    attachments=attachments,
                    timestamp=row["timestamp"]
                ))
            return messages
    
    def add_message(self, msg: Message):
        with self._get_connection() as conn:
            cursor = conn.cursor()
            attachments_json = json.dumps(msg.attachments) if msg.attachments else None
            cursor.execute(
                "INSERT INTO messages (id, conversation_id, role, content, attachments, timestamp) VALUES (?, ?, ?, ?, ?, ?)",
                (msg.id, msg.conversation_id, msg.role, msg.content, attachments_json, msg.timestamp)
            )
        self.update_conversation(msg.conversation_id)
    
    # ========== Token Methods ==========
    def save_token(self, token: str, extension_id: str, expires_at: int):
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "INSERT OR REPLACE INTO tokens (token, extension_id, expires_at) VALUES (?, ?, ?)",
                (token, extension_id, expires_at)
            )
    
    def get_token(self, token: str) -> Optional[dict]:
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM tokens WHERE token = ?", (token,))
            row = cursor.fetchone()
            if row:
                return dict(row)
            return None
    
    # ========== API Key Methods ==========
    def create_api_key(self, key_id: str, api_key: str, name: str, expires_at: Optional[int] = None):
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "INSERT INTO api_keys (key_id, api_key, name, expires_at) VALUES (?, ?, ?, ?)",
                (key_id, api_key, name, expires_at)
            )
    
    def get_api_key(self, api_key: str) -> Optional[dict]:
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM api_keys WHERE api_key = ? AND is_active = 1", (api_key,))
            row = cursor.fetchone()
            if row:
                return dict(row)
            return None
    
    def get_api_key_by_id(self, key_id: str) -> Optional[dict]:
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM api_keys WHERE key_id = ?", (key_id,))
            row = cursor.fetchone()
            if row:
                return dict(row)
            return None
    
    def list_api_keys(self) -> List[dict]:
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT key_id, name, created_at, expires_at, is_active FROM api_keys ORDER BY created_at DESC")
            rows = cursor.fetchall()
            return [dict(row) for row in rows]
    
    def revoke_api_key(self, key_id: str) -> bool:
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("UPDATE api_keys SET is_active = 0 WHERE key_id = ?", (key_id,))
            return cursor.rowcount > 0
    
    def delete_api_key(self, key_id: str) -> bool:
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("DELETE FROM api_keys WHERE key_id = ?", (key_id,))
            return cursor.rowcount > 0


# 全局存儲實例
store = SQLiteStore()


# ========== Authentication Utilities ==========
def generate_token(extension_id: str, timestamp: int) -> str:
    """生成認證 Token"""
    message = f"{extension_id}:{timestamp}"
    signature = hmac.new(
        AUTH_SECRET.encode(),
        message.encode(),
        hashlib.sha256
    ).hexdigest()
    return f"ext_{extension_id}_{timestamp}_{signature[:16]}"


def validate_token(token: str) -> Optional[dict]:
    """驗證 Token 是否有效"""
    if not token or not token.startswith("ext_"):
        return None
    
    try:
        # 解析 token: ext_{extension_id}_{timestamp}_{signature}
        parts = token.split("_")
        if len(parts) < 4:
            return None
        
        extension_id = parts[1]
        timestamp = int(parts[2])
        signature = parts[3]
        
        # 檢查是否過期
        now_ms = int(time.time() * 1000)
        if now_ms - timestamp > TOKEN_EXPIRE_SECONDS * 1000:
            return None
        
        # 驗證簽名
        expected_signature = hmac.new(
            AUTH_SECRET.encode(),
            f"{extension_id}:{timestamp}".encode(),
            hashlib.sha256
        ).hexdigest()[:16]
        
        if signature != expected_signature:
            return None
        
        return {
            "extension_id": extension_id,
            "timestamp": timestamp
        }
    except (ValueError, IndexError):
        return None


# ========== API Key Authentication Utilities ==========
def generate_api_key(name: str, expires_at: Optional[int] = None) -> tuple[str, str]:
    """
    產生 API Key
    返回: (key_id, api_key)
    """
    key_id = f"key_{secrets.token_hex(8)}"
    # 生成 API Key: gapi_{random}_{hmac_signature}
    random_part = secrets.token_hex(16)
    timestamp = int(time.time() * 1000)
    message = f"{random_part}:{timestamp}:{name}"
    signature = hmac.new(
        AUTH_SECRET.encode(),
        message.encode(),
        hashlib.sha256
    ).hexdigest()[:24]
    api_key = f"gapi_{random_part}_{signature}"
    return key_id, api_key


def validate_api_key(api_key: str) -> Optional[dict]:
    """
    驗證 API Key 是否有效
    格式: gapi_{random}_{signature}
    """
    if not api_key or not api_key.startswith("gapi_"):
        return None
    
    try:
        parts = api_key.split("_")
        if len(parts) != 3:
            return None
        
        random_part = parts[1]
        signature = parts[2]
        
        # 從資料庫獲取 API Key 記錄
        key_record = store.get_api_key(api_key)
        if not key_record:
            return None
        
        # 檢查是否啟用
        if not key_record.get("is_active", 0):
            return None
        
        # 檢查過期時間
        expires_at = key_record.get("expires_at")
        if expires_at:
            now_ms = int(time.time() * 1000)
            if now_ms > expires_at:
                return None
        
        return {
            "key_id": key_record["key_id"],
            "name": key_record["name"],
            "created_at": key_record["created_at"]
        }
    except (ValueError, IndexError):
        return None


# ========== WebSocket Manager ==========
class WebSocketManager:
    def __init__(self):
        self.active_connections: Dict[str, WebSocket] = {}  # session_id -> websocket
        self.extension_to_session: Dict[str, str] = {}  # extension_id -> session_id

    async def connect(self, websocket: WebSocket, session_id: str):
        await websocket.accept()
        self.active_connections[session_id] = websocket

    def disconnect(self, session_id: str):
        if session_id in self.active_connections:
            del self.active_connections[session_id]
        
        # 清理 extension mapping
        ext_id = None
        for ext, sess in self.extension_to_session.items():
            if sess == session_id:
                ext_id = ext
                break
        if ext_id:
            del self.extension_to_session[ext_id]

    async def send(self, session_id: str, message: dict):
        if session_id in self.active_connections:
            await self.active_connections[session_id].send_text(json.dumps(message))

    async def broadcast(self, message: dict):
        msg_str = json.dumps(message)
        for connection in self.active_connections.values():
            await connection.send_text(msg_str)


manager = WebSocketManager()


# ========== WebSocket Endpoint ==========
@app.websocket("/ws/{client_id}")
async def websocket_endpoint(websocket: WebSocket, client_id: str):
    """
    WebSocket 端點：
    - client_id = extension_id
    - 支援認證流程
    - 處理訊息同步與發送
    """
    session_id = None
    authenticated = False
    
    try:
        await websocket.accept()
        
        # 等待認證訊息
        try:
            auth_data = await asyncio_wait_first(
                websocket.receive_text(),
                timeout=10  # 10 秒內需完成認證
            )
        except asyncio.TimeoutError:
            await websocket.send_text(json.dumps({
                "type": "auth_error",
                "payload": {"error": "timeout", "message": "認證超時"}
            }))
            return
        
        try:
            auth_msg = json.loads(auth_data)
        except json.JSONDecodeError:
            await websocket.send_text(json.dumps({
                "type": "auth_error",
                "payload": {"error": "invalid_format", "message": "Invalid JSON"}
            }))
            return
        
        # 處理認證
        if auth_msg.get("type") == "auth":
            token = auth_msg.get("payload", {}).get("token")
            validation = validate_token(token)
            
            if validation:
                authenticated = True
                session_id = secrets.token_urlsafe(16)
                extension_id = validation["extension_id"]
                expires_at = int(time.time() * 1000) + TOKEN_EXPIRE_SECONDS * 1000
                
                # 註冊 session
                store.sessions[session_id] = {
                    "extension_id": extension_id,
                    "expires_at": expires_at
                }
                manager.extension_to_session[extension_id] = session_id
                await manager.connect(websocket, session_id)
                
                # 回傳認證成功
                await websocket.send_text(json.dumps({
                    "type": "auth_ok",
                    "payload": {
                        "session_id": session_id,
                        "expires_at": expires_at
                    }
                }))
            else:
                await websocket.send_text(json.dumps({
                    "type": "auth_error",
                    "payload": {"error": "invalid_token", "message": "認證失敗"}
                }))
                return
        else:
            await websocket.send_text(json.dumps({
                "type": "auth_error",
                "payload": {"error": "auth_required", "message": "需要先進行認證"}
            }))
            return
        
        # 處理後續訊息
        while True:
            data = await websocket.receive_text()
            try:
                msg = json.loads(data)
                await handle_websocket_message(websocket, session_id, msg)
            except json.JSONDecodeError:
                await websocket.send_text(json.dumps({
                    "type": "error",
                    "payload": {"error": "invalid_json", "message": "Invalid JSON format"}
                }))
                
    except WebSocketDisconnect:
        if session_id:
            manager.disconnect(session_id)
            print(f"[GAPI] Client {client_id} disconnected")


async def handle_websocket_message(websocket: WebSocket, session_id: str, msg: dict):
    """處理 WebSocket 訊息"""
    msg_type = msg.get("type")
    payload = msg.get("payload", {})
    
    if msg_type == "ping":
        await websocket.send_text(json.dumps({
            "type": "pong",
            "ts": int(time.time() * 1000)
        }))
    
    elif msg_type == "conversation_sync":
        conv_id = payload.get("conversation_id")
        conv = store.get_conversation(conv_id) if conv_id else None
        if conv:
            await websocket.send_text(json.dumps({
                "type": "conversation_data",
                "payload": {
                    "conversation_id": conv.id,
                    "title": conv.title,
                    "messages": [m.dict() for m in conv.messages]
                }
            }))
        else:
            await websocket.send_text(json.dumps({
                "type": "error",
                "payload": {"error": "conversation_not_found"}
            }))
    
    elif msg_type == "message_send":
        conv_id = payload.get("conversation_id")
        content = payload.get("content", "")
        
        # 使用 SQLiteStore 檢查對話是否存在
        conv = store.get_conversation(conv_id)
        if not conv:
            await websocket.send_text(json.dumps({
                "type": "error",
                "payload": {"error": "conversation_not_found"}
            }))
            return
        
        # 建立新訊息
        now = int(time.time() * 1000)
        new_msg = Message(
            id=f"msg_{now}",
            conversation_id=conv_id,
            role="user",
            content=content,
            timestamp=now
        )
        
        # 使用 SQLiteStore 儲存訊息
        store.add_message(new_msg)
        
        await websocket.send_text(json.dumps({
            "type": "message_sent",
            "payload": {
                "message_id": new_msg.id,
                "status": "ok"
            }
        }))
        
        # 模擬 AI 回應 (實際應調用 Gemini API)
        await simulate_ai_response(websocket, conv_id, new_msg.id)
    
    else:
        await websocket.send_text(json.dumps({
            "type": "error",
            "payload": {"error": "unknown_message_type"}
        }))


async def simulate_ai_response(websocket: WebSocket, conv_id: str, user_msg_id: str):
    """模擬 AI 回應 (placeholder)"""
    time.sleep(0.5)  # 模擬延遲
    
    now = int(time.time() * 1000)
    ai_msg_id = f"msg_{now}"
    
    # 流式回傳
    response_text = "This is a simulated AI response. Integrate with Gemini API here."
    for i in range(0, len(response_text), 10):
        delta = response_text[i:i+10]
        await websocket.send_text(json.dumps({
            "type": "message_stream",
            "payload": {
                "message_id": ai_msg_id,
                "delta": delta,
                "done": False
            }
        }))
    
    # 完成
    await websocket.send_text(json.dumps({
        "type": "message_stream",
        "payload": {
            "message_id": ai_msg_id,
            "delta": "",
            "done": True
        }
    }))
    
    # 保存 AI 訊息到 SQLite
    ai_msg = Message(
        id=ai_msg_id,
        conversation_id=conv_id,
        role="model",
        content=response_text,
        timestamp=int(time.time() * 1000)
    )
    store.add_message(ai_msg)


# ========== HTTP Endpoints ==========
@app.get("/status")
def health_check():
    """健康檢查"""
    return {
        "status": "ok",
        "service": "GAPI Server",
        "version": "1.0.0",
        "timestamp": int(time.time() * 1000)
    }


@app.post("/v1/auth/token")
def generate_auth_token(extension_id: str):
    """
    產生認證 Token (供 Extension 調用)
    """
    timestamp = int(time.time() * 1000)
    token = generate_token(extension_id, timestamp)
    
    return {
        "token": token,
        "expires_at": timestamp + TOKEN_EXPIRE_SECONDS * 1000
    }


@app.post("/v1/auth/validate")
def validate_auth_token(token: str):
    """驗證 Token"""
    validation = validate_token(token)
    if validation:
        return {
            "valid": True,
            "extension_id": validation["extension_id"]
        }
    return {"valid": False}


# ========== API Key Endpoints ==========
class APIKeyCreate(BaseModel):
    name: str
    expires_in_days: Optional[int] = None  # None = 永不过期


class APIKeyResponse(BaseModel):
    key_id: str
    api_key: str
    name: str
    created_at: int
    expires_at: Optional[int] = None


@app.post("/v1/auth/api-keys", response_model=APIKeyResponse)
def create_api_key(data: APIKeyCreate):
    """
    產生新的 API Key
    - name: API Key 名稱/描述
    - expires_in_days: 過期天數 (可選，不填則永不过期)
    
    注意：api_key 只會在建立時返回一次，請妥善保存！
    """
    expires_at = None
    if data.expires_in_days:
        expires_at = int(time.time() * 1000) + data.expires_in_days * 24 * 60 * 60 * 1000
    
    key_id, api_key = generate_api_key(data.name, expires_at)
    now = int(time.time() * 1000)
    
    # 儲存到資料庫
    store.create_api_key(key_id, api_key, data.name, expires_at)
    
    return APIKeyResponse(
        key_id=key_id,
        api_key=api_key,
        name=data.name,
        created_at=now,
        expires_at=expires_at
    )


@app.get("/v1/auth/api-keys")
def list_api_keys(auth = Depends(verify_auth)):
    """
    列出所有 API Keys (需管理員認證)
    注意：此處返回的清單不包含實際的 api_key 值
    """
    if auth is None:
        raise HTTPException(status_code=401, detail="Administrator authentication required")
    
    keys = store.list_api_keys()
    return {"api_keys": keys}


@app.delete("/v1/auth/api-keys/{key_id}")
def revoke_api_key(key_id: str, auth = Depends(verify_auth)):
    """
    撤銷 API Key (標記為 inactive)
    """
    if auth is None:
        raise HTTPException(status_code=401, detail="Administrator authentication required")
    
    success = store.revoke_api_key(key_id)
    if not success:
        raise HTTPException(status_code=404, detail="API Key not found")
    
    return {"status": "revoked", "key_id": key_id}


@app.post("/v1/auth/api-keys/validate")
def validate_api_key_endpoint(api_key: str):
    """
    驗證 API Key 是否有效
    """
    validation = validate_api_key(api_key)
    if validation:
        return {
            "valid": True,
            "key_id": validation["key_id"],
            "name": validation["name"]
        }
    return {"valid": False}


# ========== Authentication Dependency (Updated) ==========
async def verify_auth(credentials = Depends(HTTPBearer(auto_error=False))):
    """驗證 HTTP Bearer Token 或 API Key"""
    if not credentials:
        # 開發模式：允許無認證訪問（生產環境應移除）
        return None
    
    token = credentials.credentials
    
    # 優先驗證 API Key (gapi_ 開頭)
    if token.startswith("gapi_"):
        validation = validate_api_key(token)
        if validation:
            return {"type": "api_key", **validation}
        raise HTTPException(status_code=401, detail="Invalid or expired API Key")
    
    # 驗證 Token (ext_ 開頭)
    validation = validate_token(token)
    if validation:
        return {"type": "token", **validation}
    
    raise HTTPException(status_code=401, detail="Invalid or expired token")


# ========== HTTP Endpoints ==========
@app.get("/v1/conversations")
async def list_conversations(auth = Depends(verify_auth)):
    """取得對話列表（需認證）"""
    conversations = store.list_conversations()
    return {
        "conversations": [
            {
                "id": conv.id,
                "title": conv.title,
                "created_at": conv.created_at,
                "updated_at": conv.updated_at
            }
            for conv in conversations
        ]
    }


@app.get("/v1/conversations/{conversation_id}")
async def get_conversation(conversation_id: str, auth = Depends(verify_auth)):
    """取得特定對話（需認證）"""
    conv = store.get_conversation(conversation_id)
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found")
    
    return {
        "id": conv.id,
        "title": conv.title,
        "created_at": conv.created_at,
        "updated_at": conv.updated_at,
        "messages": [m.dict() for m in conv.messages]
    }


@app.post("/v1/conversations")
async def create_conversation(data: ConversationCreate = None, auth = Depends(verify_auth)):
    """建立新對話（需認證）"""
    now = int(time.time() * 1000)
    conv_id = f"conv_{now}"
    title = data.title if data and data.title else "New Chat"
    
    new_conv = store.create_conversation(conv_id, title)
    
    return {
        "id": conv_id,
        "title": title,
        "created_at": now
    }


@app.post("/v1/messages")
async def send_message(data: MessageSend, auth = Depends(verify_auth)):
    """發送訊息（需認證）"""
    conv_id = data.conversation_id
    
    # 檢查對話是否存在
    conv = store.get_conversation(conv_id)
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found")
    
    now = int(time.time() * 1000)
    msg_id = f"msg_{now}"
    
    new_msg = Message(
        id=msg_id,
        conversation_id=conv_id,
        role="user",
        content=data.content,
        attachments=data.attachments,
        timestamp=now
    )
    
    # 儲存到 SQLite
    store.add_message(new_msg)
    
    return {
        "message_id": msg_id,
        "status": "queued"
    }


# ========== Legacy CDP Bridge (保持向後相容) ==========
class BrowserAction(BaseModel):
    kind: str
    ref: str | None = None
    text: str | None = None
    targetId: str | None = None


@app.post("/v1/bridge")
async def cdp_bridge(action: BrowserAction):
    """CDP 橋接器 (向後相容)"""
    print(f"[GAPI] 接收物理指令: {action.kind} on {action.ref}")
    
    start_time = time.time()
    
    if action.kind == "click":
        result = {"status": "success", "method": "Input.dispatchMouseEvent"}
    elif action.kind == "type":
        result = {"status": "success", "method": "Input.dispatchKeyEvent", "payload": action.text}
    else:
        result = {"status": "unknown"}

    return {
        "ok": True,
        "latency_ms": int((time.time() - start_time) * 1000),
        "physical_trace": result
    }


# ========== Timeout Helper ==========
import asyncio

async def asyncio_wait_first(coro, timeout):
    """等待第一個結果，超時則拋出 TimeoutError"""
    try:
        return await asyncio.wait_for(coro, timeout=timeout)
    except asyncio.TimeoutError:
        raise asyncio.TimeoutError()


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=18799)
