"""GAPI Server - Gemini API Server with WebSocket Authentication

Based on API_SPEC.md. Provides conversation management, image upload,
and WebSocket-based real-time communication for the GAPI Chrome extension.
"""

import os
import sqlite3
import uuid
import json
import time
import secrets
import logging
import asyncio
from pathlib import Path
from contextlib import contextmanager
from typing import List, Dict, Optional

from fastapi import (
    FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect,
    Depends, UploadFile, File, Form
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel
import uvicorn

from auth import (
    generate_token, validate_token, generate_api_key, hash_api_key,
    validate_api_key, create_verify_auth, AUTH_SECRET, DEV_MODE,
    TOKEN_EXPIRE_SECONDS
)
from image_service import (
    save_image_to_file, decode_base64_image, resolve_image_path,
    IMAGES_DIR, ALLOWED_MIME_TYPES, EXT_TO_MIME
)
from rate_limiter import rate_limit_auth, rate_limit_upload, rate_limit_default

# ========== Logging ==========
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S"
)
logger = logging.getLogger("gapi.server")

# ========== Configuration ==========
DB_PATH = os.environ.get(
    "GAPI_DB_PATH",
    os.path.join(os.path.dirname(__file__), "gapi.db")
)

ALLOWED_ORIGINS = os.environ.get(
    "GAPI_ALLOWED_ORIGINS",
    "http://localhost:5173,chrome-extension://*"
).split(",")

# ========== FastAPI App ==========
app = FastAPI(title="GAPI Server", version="2.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ========== Request ID Middleware ==========
@app.middleware("http")
async def add_request_id(request: Request, call_next):
    request_id = request.headers.get("X-Request-ID", secrets.token_hex(8))
    response = await call_next(request)
    response.headers["X-Request-ID"] = request_id
    return response


# ========== Error Handler ==========
@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    request_id = request.headers.get("X-Request-ID", "unknown")
    logger.error("Unhandled error request_id=%s: %s", request_id, exc, exc_info=True)
    return JSONResponse(
        status_code=500,
        content={"error": {"code": "INTERNAL_ERROR", "message": "Internal server error"}},
    )


# ========== Data Models ==========
class Message(BaseModel):
    id: str
    conversation_id: str
    role: str
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


class ImageUploadResponse(BaseModel):
    image_id: str
    url: str
    filename: str
    mime_type: str
    size: int
    created_at: int


class APIKeyCreate(BaseModel):
    name: str
    expires_in_days: Optional[int] = None


class APIKeyResponse(BaseModel):
    key_id: str
    api_key: str
    name: str
    created_at: int
    expires_at: Optional[int] = None


class BrowserAction(BaseModel):
    kind: str
    ref: Optional[str] = None
    text: Optional[str] = None
    targetId: Optional[str] = None


# ========== SQLite Storage ==========
class SQLiteStore:
    """SQLite persistent storage with WAL mode and connection pooling."""

    def __init__(self, db_path: str = DB_PATH):
        self.db_path = db_path
        self._init_db()

    @contextmanager
    def _get_connection(self):
        conn = sqlite3.connect(self.db_path, timeout=10)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA busy_timeout=5000")
        conn.execute("PRAGMA foreign_keys=ON")
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def _init_db(self):
        """Initialize database tables and indexes."""
        with self._get_connection() as conn:
            cursor = conn.cursor()

            cursor.execute("""
                CREATE TABLE IF NOT EXISTS sessions (
                    session_id TEXT PRIMARY KEY,
                    extension_id TEXT NOT NULL,
                    expires_at INTEGER NOT NULL,
                    created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
                )
            """)

            cursor.execute("""
                CREATE TABLE IF NOT EXISTS conversations (
                    id TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                )
            """)

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

            cursor.execute("""
                CREATE TABLE IF NOT EXISTS tokens (
                    token TEXT PRIMARY KEY,
                    extension_id TEXT NOT NULL,
                    expires_at INTEGER NOT NULL,
                    created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
                )
            """)

            cursor.execute("""
                CREATE TABLE IF NOT EXISTS api_keys (
                    key_id TEXT PRIMARY KEY,
                    api_key_hash TEXT NOT NULL UNIQUE,
                    name TEXT NOT NULL,
                    created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
                    expires_at INTEGER,
                    is_active INTEGER DEFAULT 1
                )
            """)

            cursor.execute("""
                CREATE TABLE IF NOT EXISTS images (
                    image_id TEXT PRIMARY KEY,
                    url TEXT NOT NULL,
                    filename TEXT,
                    mime_type TEXT,
                    size INTEGER,
                    path TEXT NOT NULL,
                    conversation_id TEXT,
                    created_at INTEGER,
                    FOREIGN KEY (conversation_id) REFERENCES conversations(id)
                )
            """)

            # Indexes
            cursor.execute("""
                CREATE INDEX IF NOT EXISTS idx_messages_conversation_id
                ON messages(conversation_id)
            """)
            cursor.execute("""
                CREATE INDEX IF NOT EXISTS idx_messages_timestamp
                ON messages(timestamp)
            """)
            cursor.execute("""
                CREATE INDEX IF NOT EXISTS idx_images_conversation_id
                ON images(conversation_id)
            """)
            cursor.execute("""
                CREATE INDEX IF NOT EXISTS idx_sessions_extension_id
                ON sessions(extension_id)
            """)

            # Migrate: rename api_key column to api_key_hash if needed
            try:
                cursor.execute("SELECT api_key_hash FROM api_keys LIMIT 1")
            except sqlite3.OperationalError:
                try:
                    cursor.execute("ALTER TABLE api_keys RENAME COLUMN api_key TO api_key_hash")
                    logger.info("Migrated api_keys.api_key -> api_key_hash")
                except sqlite3.OperationalError:
                    pass

    # ========== Session Methods ==========
    def create_session(self, session_id: str, extension_id: str, expires_at: int):
        with self._get_connection() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO sessions (session_id, extension_id, expires_at) VALUES (?, ?, ?)",
                (session_id, extension_id, expires_at)
            )

    def get_session(self, session_id: str) -> Optional[dict]:
        with self._get_connection() as conn:
            row = conn.execute(
                "SELECT * FROM sessions WHERE session_id = ?", (session_id,)
            ).fetchone()
            return dict(row) if row else None

    def delete_session(self, session_id: str):
        with self._get_connection() as conn:
            conn.execute("DELETE FROM sessions WHERE session_id = ?", (session_id,))

    def delete_sessions_for_extension(self, extension_id: str):
        with self._get_connection() as conn:
            conn.execute("DELETE FROM sessions WHERE extension_id = ?", (extension_id,))

    # ========== Conversation Methods ==========
    def list_conversations(self, limit: int = 50, cursor: Optional[int] = None) -> List[dict]:
        """List conversations metadata only (no messages loaded)."""
        with self._get_connection() as conn:
            if cursor:
                rows = conn.execute(
                    "SELECT id, title, created_at, updated_at FROM conversations "
                    "WHERE updated_at < ? ORDER BY updated_at DESC LIMIT ?",
                    (cursor, limit)
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT id, title, created_at, updated_at FROM conversations "
                    "ORDER BY updated_at DESC LIMIT ?",
                    (limit,)
                ).fetchall()
            return [dict(row) for row in rows]

    def get_conversation(self, conv_id: str) -> Optional[Conversation]:
        with self._get_connection() as conn:
            row = conn.execute(
                "SELECT * FROM conversations WHERE id = ?", (conv_id,)
            ).fetchone()
            if not row:
                return None
            return Conversation(
                id=row["id"],
                title=row["title"],
                created_at=row["created_at"],
                updated_at=row["updated_at"],
                messages=self.get_messages(row["id"])
            )

    def create_conversation(self, conv_id: str, title: str) -> dict:
        now = int(time.time() * 1000)
        with self._get_connection() as conn:
            conn.execute(
                "INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
                (conv_id, title, now, now)
            )
        return {"id": conv_id, "title": title, "created_at": now, "updated_at": now}

    def update_conversation(self, conv_id: str):
        now = int(time.time() * 1000)
        with self._get_connection() as conn:
            conn.execute(
                "UPDATE conversations SET updated_at = ? WHERE id = ?", (now, conv_id)
            )

    # ========== Message Methods ==========
    def get_messages(self, conv_id: str, limit: int = 200, cursor: Optional[int] = None) -> List[Message]:
        with self._get_connection() as conn:
            if cursor:
                rows = conn.execute(
                    "SELECT * FROM messages WHERE conversation_id = ? AND timestamp > ? "
                    "ORDER BY timestamp ASC LIMIT ?",
                    (conv_id, cursor, limit)
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT * FROM messages WHERE conversation_id = ? "
                    "ORDER BY timestamp ASC LIMIT ?",
                    (conv_id, limit)
                ).fetchall()

            messages = []
            for row in rows:
                raw_attachments = row["attachments"]
                attachments = None
                if raw_attachments and raw_attachments.strip():
                    try:
                        attachments = json.loads(raw_attachments)
                        if not isinstance(attachments, list):
                            attachments = [attachments]
                    except (json.JSONDecodeError, TypeError):
                        attachments = None

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
            attachments_json = json.dumps(msg.attachments) if msg.attachments else None
            conn.execute(
                "INSERT INTO messages (id, conversation_id, role, content, attachments, timestamp) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (msg.id, msg.conversation_id, msg.role, msg.content, attachments_json, msg.timestamp)
            )
        self.update_conversation(msg.conversation_id)

    # ========== Token Methods ==========
    def save_token(self, token: str, extension_id: str, expires_at: int):
        with self._get_connection() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO tokens (token, extension_id, expires_at) VALUES (?, ?, ?)",
                (token, extension_id, expires_at)
            )

    def get_token(self, token: str) -> Optional[dict]:
        with self._get_connection() as conn:
            row = conn.execute(
                "SELECT * FROM tokens WHERE token = ?", (token,)
            ).fetchone()
            return dict(row) if row else None

    # ========== API Key Methods ==========
    def create_api_key(self, key_id: str, api_key_hash: str, name: str,
                       expires_at: Optional[int] = None):
        with self._get_connection() as conn:
            conn.execute(
                "INSERT INTO api_keys (key_id, api_key_hash, name, expires_at) VALUES (?, ?, ?, ?)",
                (key_id, api_key_hash, name, expires_at)
            )

    def get_api_key_by_hash(self, api_key_hash: str) -> Optional[dict]:
        with self._get_connection() as conn:
            row = conn.execute(
                "SELECT * FROM api_keys WHERE api_key_hash = ? AND is_active = 1",
                (api_key_hash,)
            ).fetchone()
            return dict(row) if row else None

    def list_api_keys(self) -> List[dict]:
        with self._get_connection() as conn:
            rows = conn.execute(
                "SELECT key_id, name, created_at, expires_at, is_active "
                "FROM api_keys ORDER BY created_at DESC"
            ).fetchall()
            return [dict(row) for row in rows]

    def revoke_api_key(self, key_id: str) -> bool:
        with self._get_connection() as conn:
            cursor = conn.execute(
                "UPDATE api_keys SET is_active = 0 WHERE key_id = ?", (key_id,)
            )
            return cursor.rowcount > 0

    # ========== Image Methods ==========
    def save_image(self, image_id: str, url: str, filename: str, mime_type: str,
                   size: int, path: str, conversation_id: Optional[str] = None) -> bool:
        with self._get_connection() as conn:
            now = int(time.time() * 1000)
            conn.execute(
                "INSERT INTO images (image_id, url, filename, mime_type, size, path, "
                "conversation_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (image_id, url, filename, mime_type, size, path, conversation_id, now)
            )
            return True

    def get_image(self, image_id: str) -> Optional[dict]:
        with self._get_connection() as conn:
            row = conn.execute(
                "SELECT * FROM images WHERE image_id = ?", (image_id,)
            ).fetchone()
            return dict(row) if row else None

    def list_images(self, conversation_id: Optional[str] = None, limit: int = 100) -> List[dict]:
        with self._get_connection() as conn:
            if conversation_id:
                rows = conn.execute(
                    "SELECT * FROM images WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?",
                    (conversation_id, limit)
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT * FROM images ORDER BY created_at DESC LIMIT ?", (limit,)
                ).fetchall()
            return [dict(row) for row in rows]

    def delete_image(self, image_id: str) -> bool:
        with self._get_connection() as conn:
            cursor = conn.execute(
                "DELETE FROM images WHERE image_id = ?", (image_id,)
            )
            return cursor.rowcount > 0


# ========== Global Instances ==========
store = SQLiteStore()
verify_auth = create_verify_auth(store)


# ========== WebSocket Manager ==========
class WebSocketManager:
    def __init__(self):
        self.active_connections: Dict[str, WebSocket] = {}
        self.extension_to_session: Dict[str, str] = {}

    async def connect(self, websocket: WebSocket, session_id: str, extension_id: str):
        # Disconnect existing session for this extension
        if extension_id in self.extension_to_session:
            old_session = self.extension_to_session[extension_id]
            await self.force_disconnect(old_session)
            logger.info("Disconnected old session %s for extension %s", old_session, extension_id)

        self.active_connections[session_id] = websocket
        self.extension_to_session[extension_id] = session_id

    async def force_disconnect(self, session_id: str):
        """Force disconnect an existing session."""
        ws = self.active_connections.get(session_id)
        if ws:
            try:
                await ws.close(code=1000, reason="Replaced by new connection")
            except Exception:
                pass
        self.disconnect(session_id)

    def disconnect(self, session_id: str):
        self.active_connections.pop(session_id, None)
        # Clean up extension mapping
        ext_to_remove = None
        for ext_id, sess_id in self.extension_to_session.items():
            if sess_id == session_id:
                ext_to_remove = ext_id
                break
        if ext_to_remove:
            del self.extension_to_session[ext_to_remove]
        # Clean up session from database
        store.delete_session(session_id)

    async def send(self, session_id: str, message: dict):
        ws = self.active_connections.get(session_id)
        if ws:
            await ws.send_text(json.dumps(message))

    async def broadcast(self, message: dict):
        msg_str = json.dumps(message)
        for ws in self.active_connections.values():
            try:
                await ws.send_text(msg_str)
            except Exception:
                pass


manager = WebSocketManager()


# ========== WebSocket Endpoint ==========
@app.websocket("/ws/{client_id}")
async def websocket_endpoint(websocket: WebSocket, client_id: str):
    """WebSocket endpoint with authentication flow."""
    session_id = None

    try:
        await websocket.accept()

        # Wait for auth message (5 second timeout)
        try:
            auth_data = await asyncio.wait_for(
                websocket.receive_text(),
                timeout=5
            )
        except asyncio.TimeoutError:
            await websocket.send_text(json.dumps({
                "type": "auth_error",
                "payload": {"error": "timeout", "message": "Authentication timed out"}
            }))
            await websocket.close(code=1008)
            return

        try:
            auth_msg = json.loads(auth_data)
        except json.JSONDecodeError:
            await websocket.send_text(json.dumps({
                "type": "auth_error",
                "payload": {"error": "invalid_format", "message": "Invalid JSON"}
            }))
            await websocket.close(code=1008)
            return

        if auth_msg.get("type") != "auth":
            await websocket.send_text(json.dumps({
                "type": "auth_error",
                "payload": {"error": "auth_required", "message": "Authentication required"}
            }))
            await websocket.close(code=1008)
            return

        token = auth_msg.get("payload", {}).get("token")
        validation = validate_token(token)

        if not validation:
            logger.warning("WebSocket auth failed for client %s", client_id)
            await websocket.send_text(json.dumps({
                "type": "auth_error",
                "payload": {"error": "invalid_token", "message": "Authentication failed"}
            }))
            await websocket.close(code=1008)
            return

        # Auth successful
        session_id = secrets.token_urlsafe(16)
        extension_id = validation["extension_id"]
        expires_at = int(time.time() * 1000) + TOKEN_EXPIRE_SECONDS * 1000

        store.create_session(session_id, extension_id, expires_at)
        await manager.connect(websocket, session_id, extension_id)

        logger.info("WebSocket authenticated: client=%s session=%s", client_id, session_id)

        await websocket.send_text(json.dumps({
            "type": "auth_ok",
            "payload": {"session_id": session_id, "expires_at": expires_at}
        }))

        # Message loop
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
            logger.info("Client %s disconnected (session=%s)", client_id, session_id)
    except Exception as e:
        logger.error("WebSocket error for client %s: %s", client_id, e)
        if session_id:
            manager.disconnect(session_id)


async def handle_websocket_message(websocket: WebSocket, session_id: str, msg: dict):
    """Handle incoming WebSocket messages."""
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
                    "messages": [m.model_dump() for m in conv.messages]
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

        conv = store.get_conversation(conv_id)
        if not conv:
            await websocket.send_text(json.dumps({
                "type": "error",
                "payload": {"error": "conversation_not_found"}
            }))
            return

        now = int(time.time() * 1000)
        new_msg = Message(
            id=f"msg_{now}_{secrets.token_hex(4)}",
            conversation_id=conv_id,
            role="user",
            content=content,
            timestamp=now
        )
        store.add_message(new_msg)

        await websocket.send_text(json.dumps({
            "type": "message_sent",
            "payload": {"message_id": new_msg.id, "status": "ok"}
        }))

    else:
        await websocket.send_text(json.dumps({
            "type": "error",
            "payload": {"error": "unknown_message_type"}
        }))


# ========== HTTP Endpoints ==========
@app.get("/status")
def health_check():
    """Health check endpoint."""
    return {
        "status": "ok",
        "service": "GAPI Server",
        "version": "2.0.0",
        "timestamp": int(time.time() * 1000)
    }


@app.post("/v1/auth/token")
def generate_auth_token(
    extension_id: str,
    request: Request,
    _: None = Depends(rate_limit_auth)
):
    """Generate an authentication token for the given extension."""
    timestamp = int(time.time() * 1000)
    token = generate_token(extension_id, timestamp)
    logger.info("Token generated for extension=%s", extension_id)
    return {
        "token": token,
        "expires_at": timestamp + TOKEN_EXPIRE_SECONDS * 1000
    }


@app.post("/v1/auth/validate")
def validate_auth_token(
    token: str,
    _: None = Depends(rate_limit_auth)
):
    """Validate a token."""
    validation = validate_token(token)
    if validation:
        return {"valid": True, "extension_id": validation["extension_id"]}
    return {"valid": False}


# ========== API Key Endpoints ==========
@app.post("/v1/auth/api-keys", response_model=APIKeyResponse)
def create_api_key_endpoint(
    data: APIKeyCreate,
    request: Request,
    auth=Depends(verify_auth),
    _: None = Depends(rate_limit_auth)
):
    """Create a new API key (requires authentication)."""
    expires_at = None
    if data.expires_in_days:
        expires_at = int(time.time() * 1000) + data.expires_in_days * 86400000

    key_id, api_key = generate_api_key(data.name, expires_at)
    now = int(time.time() * 1000)

    # Store hashed key
    store.create_api_key(key_id, hash_api_key(api_key), data.name, expires_at)
    logger.info("API key created: key_id=%s name=%s", key_id, data.name)

    return APIKeyResponse(
        key_id=key_id,
        api_key=api_key,
        name=data.name,
        created_at=now,
        expires_at=expires_at
    )


@app.get("/v1/auth/api-keys")
def list_api_keys_endpoint(auth=Depends(verify_auth)):
    """List all API keys (requires authentication)."""
    keys = store.list_api_keys()
    return {"api_keys": keys}


@app.delete("/v1/auth/api-keys/{key_id}")
def revoke_api_key_endpoint(key_id: str, auth=Depends(verify_auth)):
    """Revoke an API key."""
    success = store.revoke_api_key(key_id)
    if not success:
        raise HTTPException(status_code=404, detail="API key not found")
    logger.info("API key revoked: key_id=%s", key_id)
    return {"status": "revoked", "key_id": key_id}


@app.post("/v1/auth/api-keys/validate")
def validate_api_key_endpoint(
    api_key: str,
    _: None = Depends(rate_limit_auth)
):
    """Validate an API key."""
    validation = validate_api_key(api_key, store)
    if validation:
        return {"valid": True, "key_id": validation["key_id"], "name": validation["name"]}
    return {"valid": False}


# ========== Conversation Endpoints ==========
@app.get("/v1/conversations")
async def list_conversations_endpoint(
    limit: int = 50,
    cursor: Optional[int] = None,
    auth=Depends(verify_auth)
):
    """List conversations (metadata only, no messages)."""
    conversations = store.list_conversations(limit=min(limit, 100), cursor=cursor)
    next_cursor = conversations[-1]["updated_at"] if conversations else None
    return {
        "conversations": conversations,
        "meta": {"cursor": next_cursor, "has_more": len(conversations) == limit}
    }


@app.get("/v1/conversations/{conversation_id}")
async def get_conversation_endpoint(conversation_id: str, auth=Depends(verify_auth)):
    """Get a conversation with its messages."""
    conv = store.get_conversation(conversation_id)
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found")

    return {
        "id": conv.id,
        "title": conv.title,
        "created_at": conv.created_at,
        "updated_at": conv.updated_at,
        "messages": [m.model_dump() for m in conv.messages]
    }


@app.post("/v1/conversations")
async def create_conversation_endpoint(
    data: ConversationCreate = None,
    auth=Depends(verify_auth)
):
    """Create a new conversation."""
    now = int(time.time() * 1000)
    conv_id = f"conv_{now}_{secrets.token_hex(4)}"
    title = data.title if data and data.title else "New Chat"
    result = store.create_conversation(conv_id, title)
    return result


@app.post("/v1/messages")
async def send_message_endpoint(data: MessageSend, auth=Depends(verify_auth)):
    """Send a message to a conversation."""
    conv = store.get_conversation(data.conversation_id)
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found")

    now = int(time.time() * 1000)
    msg_id = f"msg_{now}_{secrets.token_hex(4)}"

    new_msg = Message(
        id=msg_id,
        conversation_id=data.conversation_id,
        role="user",
        content=data.content,
        attachments=data.attachments,
        timestamp=now
    )
    store.add_message(new_msg)
    return {"message_id": msg_id, "status": "queued"}


# ========== Image Endpoints ==========
@app.post("/v1/images/upload", response_model=ImageUploadResponse)
async def upload_image(
    image_data: str = Form(...),
    conversation_id: Optional[str] = Form(None),
    filename: Optional[str] = Form(None),
    auth=Depends(verify_auth),
    _: None = Depends(rate_limit_upload)
):
    """Upload an image (base64 format)."""
    try:
        image_bytes, mime_type, original_filename = decode_base64_image(image_data)
        final_filename = filename or original_filename
        result = save_image_to_file(image_bytes, final_filename, mime_type)

        store.save_image(
            image_id=result["image_id"],
            url=result["url"],
            filename=result["filename"],
            mime_type=result["mime_type"],
            size=result["size"],
            path=result["path"],
            conversation_id=conversation_id
        )

        return ImageUploadResponse(**{k: result[k] for k in ImageUploadResponse.model_fields})
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error("Image upload failed: %s", e)
        raise HTTPException(status_code=500, detail="Upload failed")


@app.post("/v1/images/upload-file", response_model=ImageUploadResponse)
async def upload_image_file(
    file: UploadFile = File(...),
    conversation_id: Optional[str] = Form(None),
    auth=Depends(verify_auth),
    _: None = Depends(rate_limit_upload)
):
    """Upload an image (file upload)."""
    try:
        image_bytes = await file.read()
        mime_type = file.content_type or "image/png"

        if file.filename:
            ext = file.filename.rsplit(".", 1)[-1].lower() if "." in file.filename else "png"
            mime_type = EXT_TO_MIME.get(ext, mime_type)

        result = save_image_to_file(image_bytes, file.filename or "upload.png", mime_type)

        store.save_image(
            image_id=result["image_id"],
            url=result["url"],
            filename=result["filename"],
            mime_type=result["mime_type"],
            size=result["size"],
            path=result["path"],
            conversation_id=conversation_id
        )

        return ImageUploadResponse(**{k: result[k] for k in ImageUploadResponse.model_fields})
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error("File upload failed: %s", e)
        raise HTTPException(status_code=500, detail="Upload failed")


@app.get("/v1/images/{image_id:path}")
async def get_image_endpoint(image_id: str, auth=Depends(verify_auth)):
    """Get an image by ID or path."""
    image_info = store.get_image(image_id)
    file_path = resolve_image_path(image_id, image_info)

    if not file_path:
        raise HTTPException(status_code=404, detail="Image not found")

    mime_type = image_info["mime_type"] if image_info else "image/png"
    return FileResponse(path=file_path, media_type=mime_type, filename=file_path.name)


@app.get("/v1/images")
async def list_images_endpoint(
    conversation_id: Optional[str] = None,
    auth=Depends(verify_auth)
):
    """List images, optionally filtered by conversation."""
    images = store.list_images(conversation_id=conversation_id)
    return {"images": images, "count": len(images)}


@app.delete("/v1/images/{image_id}")
async def delete_image_endpoint(image_id: str, auth=Depends(verify_auth)):
    """Delete an image."""
    image_info = store.get_image(image_id)
    if not image_info:
        raise HTTPException(status_code=404, detail="Image not found")

    file_path = Path(image_info["path"])
    if file_path.exists():
        file_path.unlink()

    store.delete_image(image_id)
    return {"status": "deleted", "image_id": image_id}


# ========== Legacy CDP Bridge ==========
@app.post("/v1/bridge")
async def cdp_bridge(action: BrowserAction):
    """CDP bridge (legacy compatibility)."""
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


# ========== Startup ==========
@app.on_event("startup")
async def startup_event():
    logger.info("GAPI Server v2.0.0 starting")
    logger.info("DEV_MODE=%s", DEV_MODE)
    logger.info("CORS origins: %s", ALLOWED_ORIGINS)
    logger.info("Image dir: %s", IMAGES_DIR)
    logger.info("Database: %s", DB_PATH)


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=18799)
