"""Tests for P4 Active Pages API — 10 test cases (P-01 through P-10).

Coverage:
- ActivePageRegistry unit tests: empty state, update/get, remove
- WebSocket pages_sync: sync ok, empty sync, disconnect cleanup, registry update
- HTTP GET /v1/pages: empty response, auth required, site filter

Registry tests use direct access to ``mcp_server.page_registry``.
WebSocket tests use ``ws_app`` + ``test_client`` fixtures (Starlette TestClient).
HTTP tests use the ``client`` fixture (httpx AsyncClient).
"""

import importlib
import json
import os
import sys
import time
from pathlib import Path
from typing import Generator

import pytest

# ---------------------------------------------------------------------------
# Path setup — must happen before any local imports
# ---------------------------------------------------------------------------
SERVER_DIR = Path(__file__).parent.parent
sys.path.insert(0, str(SERVER_DIR))

os.environ["GAPI_AUTH_SECRET"] = "test_secret_key_for_testing"
os.environ["GAPI_DEV_MODE"] = "false"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_valid_token(extension_id: str = "test_ext") -> str:
    """Generate a fresh, valid HMAC token for the given extension."""
    from auth import generate_token
    return generate_token(extension_id, int(time.time() * 1000))


def _auth_message(token: str) -> str:
    """Serialise a well-formed auth WebSocket message."""
    return json.dumps({"type": "auth", "payload": {"token": token}})


def _make_auth_headers() -> dict:
    """Generate a fresh bearer-token header from the reloaded auth module."""
    import auth
    token = auth.generate_token("test", int(time.time() * 1000))
    return {"Authorization": f"Bearer {token}"}


SAMPLE_PAGES = [
    {"tab_id": 1, "url": "https://gemini.google.com/app/abc", "title": "Gemini Chat", "site": "gemini"},
    {"tab_id": 2, "url": "https://claude.ai/chat/xyz", "title": "Claude Chat", "site": "claude"},
]


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture()
def ws_app(tmp_path) -> Generator:
    """Reload application modules with a fresh temp database and return the app."""
    db_path = str(tmp_path / "test_pages.db")
    os.environ["GAPI_DB_PATH"] = db_path

    import auth
    importlib.reload(auth)
    import rate_limiter
    importlib.reload(rate_limiter)
    import mcp_server
    importlib.reload(mcp_server)

    yield mcp_server


@pytest.fixture()
def test_client(ws_app):
    """Starlette synchronous TestClient wrapping the reloaded app."""
    from starlette.testclient import TestClient

    with TestClient(ws_app.app) as client:
        yield client


# ---------------------------------------------------------------------------
# P-01: Registry empty on init
# ---------------------------------------------------------------------------

@pytest.mark.p1
def test_P01_registry_empty(ws_app):
    """P-01: A fresh ActivePageRegistry returns an empty list from get_all()."""
    assert ws_app.page_registry.get_all() == []


# ---------------------------------------------------------------------------
# P-02: Registry update and get
# ---------------------------------------------------------------------------

@pytest.mark.p1
def test_P02_registry_update_and_get(ws_app):
    """P-02: After update(), get_all() returns pages with extension_id field."""
    pages = [{"tab_id": 1, "url": "https://gemini.google.com", "site": "gemini"}]
    ws_app.page_registry.update("ext_abc", pages)

    result = ws_app.page_registry.get_all()
    assert len(result) == 1
    assert result[0]["tab_id"] == 1
    assert result[0]["extension_id"] == "ext_abc"
    assert result[0]["site"] == "gemini"


# ---------------------------------------------------------------------------
# P-03: Registry remove
# ---------------------------------------------------------------------------

@pytest.mark.p1
def test_P03_registry_remove(ws_app):
    """P-03: After remove(), the extension's pages disappear from get_all()."""
    ws_app.page_registry.update("ext_a", [{"tab_id": 1}])
    ws_app.page_registry.update("ext_b", [{"tab_id": 2}])
    assert len(ws_app.page_registry.get_all()) == 2

    ws_app.page_registry.remove("ext_a")
    result = ws_app.page_registry.get_all()
    assert len(result) == 1
    assert result[0]["extension_id"] == "ext_b"


# ---------------------------------------------------------------------------
# P-04: WebSocket pages_sync returns pages_sync_ok with count
# ---------------------------------------------------------------------------

@pytest.mark.p0
def test_P04_ws_pages_sync(test_client):
    """P-04: After auth, sending pages_sync returns pages_sync_ok with correct count."""
    token = _make_valid_token()

    with test_client.websocket_connect("/ws/client_p04") as ws:
        ws.send_text(_auth_message(token))
        auth_resp = json.loads(ws.receive_text())
        assert auth_resp["type"] == "auth_ok"

        ws.send_text(json.dumps({
            "type": "pages_sync",
            "payload": {"pages": SAMPLE_PAGES}
        }))
        response = json.loads(ws.receive_text())

    assert response["type"] == "pages_sync_ok"
    assert response["payload"]["count"] == 2


# ---------------------------------------------------------------------------
# P-05: WebSocket pages_sync with empty pages
# ---------------------------------------------------------------------------

@pytest.mark.p0
def test_P05_ws_pages_sync_empty(test_client):
    """P-05: Sending an empty pages list returns pages_sync_ok with count=0."""
    token = _make_valid_token()

    with test_client.websocket_connect("/ws/client_p05") as ws:
        ws.send_text(_auth_message(token))
        auth_resp = json.loads(ws.receive_text())
        assert auth_resp["type"] == "auth_ok"

        ws.send_text(json.dumps({
            "type": "pages_sync",
            "payload": {"pages": []}
        }))
        response = json.loads(ws.receive_text())

    assert response["type"] == "pages_sync_ok"
    assert response["payload"]["count"] == 0


# ---------------------------------------------------------------------------
# P-06: WebSocket disconnect clears pages from registry
# ---------------------------------------------------------------------------

@pytest.mark.p0
def test_P06_ws_disconnect_clears_pages(ws_app, test_client):
    """P-06: After a connection sends pages and disconnects, the registry is cleared."""
    token = _make_valid_token()

    with test_client.websocket_connect("/ws/client_p06") as ws:
        ws.send_text(_auth_message(token))
        auth_resp = json.loads(ws.receive_text())
        assert auth_resp["type"] == "auth_ok"

        ws.send_text(json.dumps({
            "type": "pages_sync",
            "payload": {"pages": SAMPLE_PAGES}
        }))
        sync_resp = json.loads(ws.receive_text())
        assert sync_resp["type"] == "pages_sync_ok"

        # Verify pages are in registry while connected
        assert len(ws_app.page_registry.get_all()) == 2

    # After disconnect, give server a moment to clean up
    time.sleep(0.2)
    assert ws_app.page_registry.get_all() == []


# ---------------------------------------------------------------------------
# P-07: WebSocket pages_sync updates HTTP endpoint
# ---------------------------------------------------------------------------

@pytest.mark.p0
def test_P07_ws_pages_sync_updates_registry(ws_app, test_client):
    """P-07: Pages synced via WebSocket are visible through GET /v1/pages."""
    token = _make_valid_token()

    with test_client.websocket_connect("/ws/client_p07") as ws:
        ws.send_text(_auth_message(token))
        auth_resp = json.loads(ws.receive_text())
        assert auth_resp["type"] == "auth_ok"

        ws.send_text(json.dumps({
            "type": "pages_sync",
            "payload": {"pages": SAMPLE_PAGES}
        }))
        sync_resp = json.loads(ws.receive_text())
        assert sync_resp["type"] == "pages_sync_ok"

        # While still connected, verify registry has the pages
        all_pages = ws_app.page_registry.get_all()
        assert len(all_pages) == 2

        sites = {p["site"] for p in all_pages}
        assert "gemini" in sites
        assert "claude" in sites

        # Verify extension_id is attached
        for page in all_pages:
            assert "extension_id" in page


# ---------------------------------------------------------------------------
# P-08: GET /v1/pages with no connected extension
# ---------------------------------------------------------------------------

@pytest.mark.p0
@pytest.mark.asyncio
async def test_P08_get_pages_no_extension(tmp_path):
    """P-08: With no connected extension, GET /v1/pages returns empty pages and total=0."""
    db_path = str(tmp_path / "test_p08.db")
    os.environ["GAPI_DB_PATH"] = db_path

    import auth
    importlib.reload(auth)
    import rate_limiter
    importlib.reload(rate_limiter)
    import mcp_server
    importlib.reload(mcp_server)

    from httpx import AsyncClient, ASGITransport
    transport = ASGITransport(app=mcp_server.app)

    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        headers = _make_auth_headers()
        resp = await ac.get("/v1/pages", headers=headers)

    assert resp.status_code == 200
    data = resp.json()
    assert data["pages"] == []
    assert data["meta"]["total"] == 0


# ---------------------------------------------------------------------------
# P-09: GET /v1/pages requires auth
# ---------------------------------------------------------------------------

@pytest.mark.p0
@pytest.mark.asyncio
async def test_P09_get_pages_requires_auth(tmp_path):
    """P-09: GET /v1/pages without a token returns 401."""
    db_path = str(tmp_path / "test_p09.db")
    os.environ["GAPI_DB_PATH"] = db_path

    import auth
    importlib.reload(auth)
    import rate_limiter
    importlib.reload(rate_limiter)
    import mcp_server
    importlib.reload(mcp_server)

    from httpx import AsyncClient, ASGITransport
    transport = ASGITransport(app=mcp_server.app)

    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        resp = await ac.get("/v1/pages")

    assert resp.status_code == 401


# ---------------------------------------------------------------------------
# P-10: GET /v1/pages with site filter
# ---------------------------------------------------------------------------

@pytest.mark.p0
@pytest.mark.asyncio
async def test_P10_get_pages_site_filter(tmp_path):
    """P-10: GET /v1/pages?site=gemini returns only gemini pages."""
    db_path = str(tmp_path / "test_p10.db")
    os.environ["GAPI_DB_PATH"] = db_path

    import auth
    importlib.reload(auth)
    import rate_limiter
    importlib.reload(rate_limiter)
    import mcp_server
    importlib.reload(mcp_server)

    # Seed the registry directly
    mcp_server.page_registry.update("ext_filter", [
        {"tab_id": 1, "url": "https://gemini.google.com/app/a", "title": "Gemini", "site": "gemini"},
        {"tab_id": 2, "url": "https://claude.ai/chat/b", "title": "Claude", "site": "claude"},
        {"tab_id": 3, "url": "https://gemini.google.com/app/c", "title": "Gemini 2", "site": "gemini"},
    ])

    from httpx import AsyncClient, ASGITransport
    transport = ASGITransport(app=mcp_server.app)

    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        headers = _make_auth_headers()
        resp = await ac.get("/v1/pages", params={"site": "gemini"}, headers=headers)

    assert resp.status_code == 200
    data = resp.json()
    assert data["meta"]["total"] == 2
    for page in data["pages"]:
        assert page["site"] == "gemini"
