"""GAPI Server - Gemini API Server with WebSocket Authentication

Based on API_SPEC.md. Provides conversation management, image upload,
and WebSocket-based real-time communication for the GAPI Chrome extension.
"""

import os
import sqlite3
import uuid
import json
import time
import hmac
import hashlib
import secrets
import logging
import asyncio
from pathlib import Path
from contextlib import asynccontextmanager, contextmanager
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

# ========== Lifespan ==========
@asynccontextmanager
async def lifespan(app):
    logger.info("GAPI Server v2.0.0 starting")
    logger.info("DEV_MODE=%s", DEV_MODE)
    logger.info("CORS origins: %s", ALLOWED_ORIGINS)
    logger.info("Image dir: %s", IMAGES_DIR)
    logger.info("Database: %s", DB_PATH)
    yield


# ========== FastAPI App ==========
app = FastAPI(title="GAPI Server", version="2.0.0", lifespan=lifespan)

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
    role: Optional[str] = "user"


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


class SiteConfigCreate(BaseModel):
    id: Optional[str] = None
    url_pattern: str
    name: str
    selectors: dict
    enabled: bool = True


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

            cursor.execute("""
                CREATE TABLE IF NOT EXISTS site_configs (
                    id TEXT PRIMARY KEY,
                    url_pattern TEXT NOT NULL,
                    name TEXT NOT NULL,
                    selectors TEXT NOT NULL,
                    enabled INTEGER DEFAULT 1,
                    created_at INTEGER,
                    updated_at INTEGER
                )
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

    # ========== Site Config Methods ==========
    def list_site_configs(self) -> List[dict]:
        with self._get_connection() as conn:
            rows = conn.execute(
                "SELECT * FROM site_configs ORDER BY created_at DESC"
            ).fetchall()
            results = []
            for row in rows:
                d = dict(row)
                try:
                    d["selectors"] = json.loads(d["selectors"])
                except (json.JSONDecodeError, TypeError):
                    d["selectors"] = {}
                d["enabled"] = bool(d["enabled"])
                results.append(d)
            return results

    def upsert_site_config(self, config_id: str, url_pattern: str, name: str,
                           selectors: dict, enabled: bool = True) -> dict:
        now = int(time.time() * 1000)
        selectors_json = json.dumps(selectors)
        with self._get_connection() as conn:
            existing = conn.execute(
                "SELECT created_at FROM site_configs WHERE id = ?", (config_id,)
            ).fetchone()
            if existing:
                conn.execute(
                    "UPDATE site_configs SET url_pattern = ?, name = ?, selectors = ?, "
                    "enabled = ?, updated_at = ? WHERE id = ?",
                    (url_pattern, name, selectors_json, int(enabled), now, config_id)
                )
                created_at = existing["created_at"]
            else:
                conn.execute(
                    "INSERT INTO site_configs (id, url_pattern, name, selectors, enabled, "
                    "created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (config_id, url_pattern, name, selectors_json, int(enabled), now, now)
                )
                created_at = now
        return {
            "id": config_id, "url_pattern": url_pattern, "name": name,
            "selectors": selectors, "enabled": enabled,
            "created_at": created_at, "updated_at": now
        }

    def delete_site_config(self, config_id: str) -> bool:
        with self._get_connection() as conn:
            cursor = conn.execute(
                "DELETE FROM site_configs WHERE id = ?", (config_id,)
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
            page_registry.remove(ext_to_remove)
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

    async def send_to_extension(self, extension_id: str, message: dict):
        """Send a message to a specific extension's WebSocket."""
        session_id = self.extension_to_session.get(extension_id)
        if session_id:
            await self.send(session_id, message)
            return True
        return False

    def find_extension_for_tab(self, tab_id: int) -> Optional[str]:
        """Find which extension owns a given tab_id."""
        for ext_id in self.extension_to_session:
            pages = page_registry.get_pages(ext_id)
            for p in pages:
                if p.get("tab_id") == tab_id:
                    return ext_id
        return None


# Pending tab commands awaiting extension response
pending_tab_commands: Dict[str, asyncio.Future] = {}

manager = WebSocketManager()


# ========== Active Page Registry ==========
class ActivePageRegistry:
    """Tracks active browser pages reported by extensions."""

    def __init__(self):
        self._pages: Dict[str, list] = {}
        self._last_updated: Dict[str, int] = {}

    def update(self, extension_id: str, pages: list):
        self._pages[extension_id] = pages
        self._last_updated[extension_id] = int(time.time() * 1000)

    def remove(self, extension_id: str):
        self._pages.pop(extension_id, None)
        self._last_updated.pop(extension_id, None)

    def get_pages(self, extension_id: str) -> list:
        return self._pages.get(extension_id, [])

    def get_all(self) -> list:
        result = []
        for ext_id, pages in self._pages.items():
            for page in pages:
                result.append({**page, "extension_id": ext_id})
        return result


page_registry = ActivePageRegistry()


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
            # Inline diagnosis: determine why validate_token returned None
            failure_reason = "malformed"
            if token and token.startswith("ext_"):
                try:
                    parts = token[4:].rsplit("_", 2)
                    if len(parts) >= 3:
                        ext_id, ts_str, sig = parts[0], parts[1], parts[2]
                        ts = int(ts_str)
                        now_ms = int(time.time() * 1000)
                        if now_ms - ts > TOKEN_EXPIRE_SECONDS * 1000:
                            failure_reason = "expired"
                        else:
                            expected = hmac.new(
                                AUTH_SECRET.encode(),
                                f"{ext_id}:{ts}".encode(),
                                hashlib.sha256
                            ).hexdigest()[:32]
                            if not hmac.compare_digest(sig, expected):
                                failure_reason = "bad_signature"
                except (ValueError, IndexError):
                    failure_reason = "malformed"

            logger.warning(
                "WebSocket auth failed for client %s: reason=%s",
                client_id, failure_reason
            )
            await websocket.send_text(json.dumps({
                "type": "auth_error",
                "payload": {
                    "error": "invalid_token",
                    "message": "Authentication failed",
                    "reason": failure_reason
                }
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

    elif msg_type == "tab_command_result":
        # Extension responding to a tab_command
        command_id = payload.get("command_id")
        if command_id and command_id in pending_tab_commands:
            future = pending_tab_commands.pop(command_id)
            if not future.done():
                future.set_result(payload)

    elif msg_type == "pages_sync":
        pages = payload.get("pages", [])
        ext_id = None
        for eid, sid in manager.extension_to_session.items():
            if sid == session_id:
                ext_id = eid
                break
        if ext_id:
            page_registry.update(ext_id, pages)
            await websocket.send_text(json.dumps({
                "type": "pages_sync_ok",
                "payload": {"count": len(pages)}
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
        "connected_extensions": len(manager.active_connections),
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


# ========== Active Pages Endpoint ==========
@app.get("/v1/pages")
async def list_active_pages(
    site: Optional[str] = None,
    auth=Depends(verify_auth)
):
    """List active browser pages with conversation state."""
    pages = page_registry.get_all()
    if site:
        pages = [p for p in pages if p.get("site") == site]
    return {
        "pages": pages,
        "meta": {
            "total": len(pages),
            "connected_extensions": len(manager.active_connections),
            "timestamp": int(time.time() * 1000)
        }
    }


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

    msg_role = data.role if data.role in ("user", "model", "assistant") else "user"

    new_msg = Message(
        id=msg_id,
        conversation_id=data.conversation_id,
        role=msg_role,
        content=data.content,
        attachments=data.attachments,
        timestamp=now
    )
    store.add_message(new_msg)

    # Broadcast to connected WebSocket clients so extensions can act on new messages
    if msg_role == "user":
        await manager.broadcast({
            "type": "message_pending",
            "payload": {
                "message_id": msg_id,
                "conversation_id": data.conversation_id,
                "content": data.content,
                "timestamp": now
            }
        })

    return {"message_id": msg_id, "status": "queued"}


# ========== Tab Command Endpoints ==========

class TabSendRequest(BaseModel):
    message: str
    wait_response: bool = True
    timeout: int = 60


@app.post("/v1/tabs/{tab_id}/send")
async def send_to_tab(tab_id: int, data: TabSendRequest, auth=Depends(verify_auth)):
    """Send a message to a browser tab via the connected extension."""
    ext_id = manager.find_extension_for_tab(tab_id)
    if not ext_id:
        raise HTTPException(status_code=404, detail="Tab not found or no extension connected")

    command_id = f"cmd_{int(time.time() * 1000)}_{secrets.token_hex(4)}"

    # Send tab_command to extension via WebSocket
    sent = await manager.send_to_extension(ext_id, {
        "type": "tab_command",
        "payload": {
            "command_id": command_id,
            "tab_id": tab_id,
            "action": "sendMessage",
            "message": data.message
        }
    })

    if not sent:
        raise HTTPException(status_code=502, detail="Extension WebSocket not available")

    if not data.wait_response:
        return {"command_id": command_id, "status": "sent"}

    # Wait for extension to respond via tab_command_result
    loop = asyncio.get_event_loop()
    future = loop.create_future()
    pending_tab_commands[command_id] = future

    try:
        result = await asyncio.wait_for(future, timeout=data.timeout)
        return {"command_id": command_id, "status": "ok", "result": result}
    except asyncio.TimeoutError:
        pending_tab_commands.pop(command_id, None)
        raise HTTPException(status_code=504, detail="Extension did not respond in time")


@app.post("/v1/tabs/{tab_id}/get-response")
async def get_tab_response(tab_id: int, auth=Depends(verify_auth)):
    """Get the last AI response from a browser tab."""
    ext_id = manager.find_extension_for_tab(tab_id)
    if not ext_id:
        raise HTTPException(status_code=404, detail="Tab not found or no extension connected")

    command_id = f"cmd_{int(time.time() * 1000)}_{secrets.token_hex(4)}"

    sent = await manager.send_to_extension(ext_id, {
        "type": "tab_command",
        "payload": {
            "command_id": command_id,
            "tab_id": tab_id,
            "action": "GET_LAST_RESPONSE"
        }
    })

    if not sent:
        raise HTTPException(status_code=502, detail="Extension WebSocket not available")

    loop = asyncio.get_event_loop()
    future = loop.create_future()
    pending_tab_commands[command_id] = future

    try:
        result = await asyncio.wait_for(future, timeout=30)
        return {"command_id": command_id, "status": "ok", "result": result}
    except asyncio.TimeoutError:
        pending_tab_commands.pop(command_id, None)
        raise HTTPException(status_code=504, detail="Extension did not respond in time")


class InspectRequest(BaseModel):
    action: str = "inspectDOM"
    selector: Optional[str] = None
    message_index: Optional[int] = None

@app.post("/v1/tabs/{tab_id}/inspect")
async def inspect_tab_dom(tab_id: int, body: InspectRequest = None, auth=Depends(verify_auth)):
    """Inspect DOM selectors on a browser tab for debugging.

    Actions:
      - inspectDOM: scan common selectors for messages, inputs, buttons
      - inspectMessages: list all message blocks with structure
      - inspectReply: inspect the last reply block children
      - inspectToolCalls: deep-inspect tool call summaries and file refs (Nebula)
      - expandToolCalls: click tool call summaries to expand, then read content
      - customQuery: run an arbitrary CSS selector (pass via 'selector' param)

    Optional params:
      - selector: CSS selector string for customQuery action
      - message_index: 0-based index of a specific message block to inspect
    """
    inspect_action = body.action if body else "inspectDOM"
    ext_id = manager.find_extension_for_tab(tab_id)
    if not ext_id:
        # Fallback: try any connected extension (for tabs not yet in adapter registry)
        if manager.extension_to_session:
            ext_id = next(iter(manager.extension_to_session))
        else:
            raise HTTPException(status_code=404, detail="No extension connected")

    command_id = f"cmd_{int(time.time() * 1000)}_{secrets.token_hex(4)}"

    payload = {
        "command_id": command_id,
        "tab_id": tab_id,
        "action": inspect_action
    }
    if body and body.selector:
        payload["selector"] = body.selector
    if body and body.message_index is not None:
        payload["message_index"] = body.message_index

    sent = await manager.send_to_extension(ext_id, {
        "type": "tab_command",
        "payload": payload
    })

    if not sent:
        raise HTTPException(status_code=502, detail="Extension WebSocket not available")

    loop = asyncio.get_event_loop()
    future = loop.create_future()
    pending_tab_commands[command_id] = future

    try:
        result = await asyncio.wait_for(future, timeout=15)
        return {"command_id": command_id, "status": "ok", "result": result}
    except asyncio.TimeoutError:
        pending_tab_commands.pop(command_id, None)
        raise HTTPException(status_code=504, detail="Extension did not respond in time")


@app.get("/v1/tabs/{tab_id}/info")
async def get_tab_info(tab_id: int, auth=Depends(verify_auth)):
    """Get conversation info (chatId, title) from a browser tab."""
    ext_id = manager.find_extension_for_tab(tab_id)
    if not ext_id:
        raise HTTPException(status_code=404, detail="Tab not found or no extension connected")

    command_id = f"cmd_{int(time.time() * 1000)}_{secrets.token_hex(4)}"

    sent = await manager.send_to_extension(ext_id, {
        "type": "tab_command",
        "payload": {
            "command_id": command_id,
            "tab_id": tab_id,
            "action": "getInfo"
        }
    })

    if not sent:
        raise HTTPException(status_code=502, detail="Extension WebSocket not available")

    loop = asyncio.get_event_loop()
    future = loop.create_future()
    pending_tab_commands[command_id] = future

    try:
        result = await asyncio.wait_for(future, timeout=10)
        return {"command_id": command_id, "status": "ok", "result": result}
    except asyncio.TimeoutError:
        pending_tab_commands.pop(command_id, None)
        raise HTTPException(status_code=504, detail="Extension did not respond in time")


class TabCreateRequest(BaseModel):
    url: str = "https://gemini.google.com/app"
    wait_ready: bool = True  # wait for tab to register in active pages


@app.post("/v1/tabs/create")
async def create_tab(data: TabCreateRequest, auth=Depends(verify_auth)):
    """Create a new browser tab via the connected extension."""
    if not manager.extension_to_session:
        raise HTTPException(status_code=404, detail="No extensions connected")

    ext_id = next(iter(manager.extension_to_session))
    command_id = f"cmd_{int(time.time() * 1000)}_{secrets.token_hex(4)}"

    sent = await manager.send_to_extension(ext_id, {
        "type": "tab_command",
        "payload": {
            "command_id": command_id,
            "tab_id": 0,
            "action": "createTab",
            "message": data.url
        }
    })

    if not sent:
        raise HTTPException(status_code=502, detail="Extension WebSocket not available")

    loop = asyncio.get_event_loop()
    future = loop.create_future()
    pending_tab_commands[command_id] = future

    try:
        result = await asyncio.wait_for(future, timeout=15)
        return {"command_id": command_id, "status": "ok", "result": result}
    except asyncio.TimeoutError:
        pending_tab_commands.pop(command_id, None)
        raise HTTPException(status_code=504, detail="Tab creation timed out")


# ========== Extension Management ==========
class ReloadRequest(BaseModel):
    mode: str = "soft"  # "soft" = reinject scripts, "hard" = restart Chrome
    urls: Optional[list] = None  # tabs to open after restart

@app.post("/v1/extension/reload")
async def reload_extension(data: ReloadRequest = ReloadRequest(), auth=Depends(verify_auth)):
    """Reload extension. mode=soft|full|hard."""
    if data.mode == "full":
        # Full reload: chrome.runtime.reload() via WebSocket
        sent = 0
        for client_id, ws in list(manager.active_connections.items()):
            try:
                await ws.send_text(json.dumps({
                    "type": "reload_extension",
                    "payload": {"mode": "full"}
                }))
                sent += 1
            except Exception:
                pass
        if sent == 0:
            raise HTTPException(status_code=404, detail="No extensions connected")
        return {
            "status": "ok",
            "mode": "full",
            "message": f"Full reload sent to {sent} extension(s)",
            "note": "Extension will restart and reconnect automatically"
        }

    if data.mode == "hard":
        import subprocess, shutil
        urls = data.urls or ["https://gemini.google.com"]
        try:
            # Kill Chrome — try WSL path first, then bare command
            taskkill = "/mnt/c/Windows/system32/taskkill.exe"
            if not os.path.exists(taskkill):
                taskkill = shutil.which("taskkill.exe") or "taskkill.exe"
            subprocess.run([taskkill, "/F", "/IM", "chrome.exe"],
                           capture_output=True, timeout=10)
            await asyncio.sleep(3)
            # Reopen Chrome — use cmd.exe to launch (most reliable from WSL)
            url_args = " ".join(f'"{u}"' for u in urls)
            subprocess.Popen(
                ["cmd.exe", "/C", "start", "", "chrome.exe"] + urls,
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
            )
        except Exception as e:
            logger.error("Hard reload failed: %s", e)
            raise HTTPException(status_code=500, detail=f"Hard reload failed: {e}")
        return {
            "status": "ok",
            "mode": "hard",
            "message": "Chrome restarted",
            "urls": urls,
            "note": "Extension will auto-load and reconnect"
        }

    # Soft mode: reinject content scripts via WebSocket
    sent = 0
    for client_id, ws in list(manager.active_connections.items()):
        try:
            await ws.send_text(json.dumps({
                "type": "reload_extension",
                "payload": {"mode": "soft"}
            }))
            sent += 1
        except Exception:
            pass
    if sent == 0:
        raise HTTPException(status_code=404, detail="No extensions connected")
    return {"status": "ok", "mode": "soft", "message": f"Reinject sent to {sent} extension(s)"}


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


# ========== Site Config Endpoints ==========
@app.get("/v1/config/sites")
async def list_site_configs_endpoint(auth=Depends(verify_auth)):
    """List all site configurations."""
    configs = store.list_site_configs()
    return {"configs": configs}


@app.post("/v1/config/sites")
async def upsert_site_config_endpoint(data: SiteConfigCreate, auth=Depends(verify_auth)):
    """Create or update a site configuration."""
    config_id = data.id or f"site_{secrets.token_hex(8)}"
    result = store.upsert_site_config(
        config_id=config_id,
        url_pattern=data.url_pattern,
        name=data.name,
        selectors=data.selectors,
        enabled=data.enabled
    )
    return result


@app.delete("/v1/config/sites/{config_id}")
async def delete_site_config_endpoint(config_id: str, auth=Depends(verify_auth)):
    """Delete a site configuration."""
    success = store.delete_site_config(config_id)
    if not success:
        raise HTTPException(status_code=404, detail="Site config not found")
    return {"status": "deleted", "config_id": config_id}


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



if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=18799)
