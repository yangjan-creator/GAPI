"""Shared fixtures for GAPI server tests."""

import os
import sys
import time
import pytest
import base64
from pathlib import Path

# Add server directory to path for imports
SERVER_DIR = Path(__file__).parent.parent
sys.path.insert(0, str(SERVER_DIR))

# Set test environment before importing modules
os.environ["GAPI_AUTH_SECRET"] = "test_secret_key_for_testing"
os.environ["GAPI_DEV_MODE"] = "false"

FIXTURES_DIR = Path(__file__).parent / "fixtures"


@pytest.fixture
def temp_db(tmp_path):
    """Create a temporary SQLite database path."""
    db_path = str(tmp_path / "test_gapi.db")
    os.environ["GAPI_DB_PATH"] = db_path
    return db_path


@pytest.fixture
def store(temp_db):
    """Create a fresh SQLiteStore instance with temp database."""
    from mcp_server import SQLiteStore
    return SQLiteStore(temp_db)


@pytest.fixture
def valid_token():
    """Generate a valid HMAC token for testing."""
    from auth import generate_token
    timestamp = int(time.time() * 1000)
    token = generate_token("test_extension", timestamp)
    return token


@pytest.fixture
def expired_token():
    """Generate an expired HMAC token for testing."""
    from auth import generate_token
    timestamp = int(time.time() * 1000) - 4000 * 1000  # 4000 seconds ago (>3600)
    token = generate_token("test_extension", timestamp)
    return token


@pytest.fixture
def valid_api_key(store):
    """Generate and store a valid API key."""
    from auth import generate_api_key, hash_api_key
    key_id, api_key = generate_api_key("test_key")
    store.create_api_key(key_id, hash_api_key(api_key), "test_key")
    return {"key_id": key_id, "api_key": api_key}


@pytest.fixture
def auth_headers(valid_token):
    """HTTP headers with valid Bearer token."""
    return {"Authorization": f"Bearer {valid_token}"}


@pytest.fixture
def api_key_headers(valid_api_key):
    """HTTP headers with valid API key."""
    return {"Authorization": f"Bearer {valid_api_key['api_key']}"}


@pytest.fixture
async def client(temp_db):
    """Create an async httpx test client for the FastAPI app."""
    import importlib
    # Reload modules to pick up test env vars
    os.environ["GAPI_DB_PATH"] = temp_db

    import auth
    importlib.reload(auth)
    import rate_limiter
    importlib.reload(rate_limiter)
    import mcp_server
    importlib.reload(mcp_server)

    from httpx import AsyncClient, ASGITransport

    transport = ASGITransport(app=mcp_server.app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac


@pytest.fixture
def sample_png():
    """Read sample PNG fixture."""
    return (FIXTURES_DIR / "sample.png").read_bytes()


@pytest.fixture
def sample_jpg():
    """Read sample JPEG fixture."""
    return (FIXTURES_DIR / "sample.jpg").read_bytes()


@pytest.fixture
def fake_image():
    """Read fake image (HTML) fixture."""
    return (FIXTURES_DIR / "fake_image.html").read_bytes()


@pytest.fixture
def large_file():
    """Read large file fixture (>10MB)."""
    return (FIXTURES_DIR / "large_file.bin").read_bytes()


@pytest.fixture
def sample_png_base64(sample_png):
    """Base64 data URL of sample PNG."""
    b64 = base64.b64encode(sample_png).decode()
    return f"data:image/png;base64,{b64}"


@pytest.fixture
def sample_conversation(store):
    """Create a sample conversation in the store."""
    conv_id = "conv_test_001"
    store.create_conversation(conv_id, "Test Conversation")
    return conv_id


@pytest.fixture
def sample_message(store, sample_conversation):
    """Create a sample message in a conversation."""
    from mcp_server import Message
    msg = Message(
        id="msg_test_001",
        conversation_id=sample_conversation,
        role="user",
        content="Hello, test message",
        timestamp=int(time.time() * 1000),
    )
    store.add_message(msg)
    return msg


@pytest.fixture
def temp_images_dir(tmp_path):
    """Create a temporary images directory."""
    images_dir = tmp_path / "images"
    images_dir.mkdir()
    return images_dir
