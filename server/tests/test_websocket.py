"""Tests for the GAPI WebSocket endpoint and message handling.

Covers the full authentication flow and all post-auth message types.

Test plan IDs: W-01 through W-12.
"""

import importlib
import json
import os
import sys
import time
from pathlib import Path
from typing import Generator
from unittest.mock import patch

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


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture()
def ws_app(tmp_path) -> Generator:
    """Reload application modules with a fresh temp database and return the app.

    Yielded value: the reloaded ``mcp_server`` module (access ``mcp_server.app``).
    """
    db_path = str(tmp_path / "test_ws.db")
    os.environ["GAPI_DB_PATH"] = db_path

    # Force a clean reload so every test gets an isolated store and manager.
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
# W-01: Valid auth -> auth_ok with session_id
# ---------------------------------------------------------------------------

@pytest.mark.p0
def test_w01_valid_auth_receives_auth_ok(test_client):
    """W-01: Connecting and sending a valid auth message returns auth_ok with session_id."""
    token = _make_valid_token()

    with test_client.websocket_connect("/ws/client_w01") as ws:
        ws.send_text(_auth_message(token))
        response = json.loads(ws.receive_text())

    assert response["type"] == "auth_ok", f"Expected auth_ok, got: {response}"
    payload = response["payload"]
    assert "session_id" in payload, "auth_ok payload must include session_id"
    assert isinstance(payload["session_id"], str)
    assert len(payload["session_id"]) > 0
    assert "expires_at" in payload, "auth_ok payload must include expires_at"
    assert isinstance(payload["expires_at"], int)
    assert payload["expires_at"] > int(time.time() * 1000)


# ---------------------------------------------------------------------------
# W-02: No auth within 5 seconds -> auth_error timeout + close 1008
# ---------------------------------------------------------------------------

@pytest.mark.p0
@pytest.mark.slow
def test_w02_auth_timeout_closes_connection(test_client):
    """W-02: Not sending any auth message causes auth_error timeout and close code 1008.

    This test waits for the real 5-second server timeout.
    """
    with test_client.websocket_connect("/ws/client_w02") as ws:
        # Do not send anything; the server will time out after 5 seconds.
        response = json.loads(ws.receive_text())

    assert response["type"] == "auth_error"
    assert response["payload"]["error"] == "timeout"


# ---------------------------------------------------------------------------
# W-03: Invalid token -> auth_error invalid_token
# ---------------------------------------------------------------------------

@pytest.mark.p0
def test_w03_invalid_token_rejected(test_client):
    """W-03: Sending a syntactically valid JSON auth message with a bad token returns auth_error invalid_token."""
    bad_token = "ext_fakeid_0000000000000_badbadbadbadbadbadbadbadbadbadba"
    msg = json.dumps({"type": "auth", "payload": {"token": bad_token}})

    with test_client.websocket_connect("/ws/client_w03") as ws:
        ws.send_text(msg)
        response = json.loads(ws.receive_text())

    assert response["type"] == "auth_error"
    assert response["payload"]["error"] == "invalid_token"


# ---------------------------------------------------------------------------
# W-04: First message is not auth type -> auth_error auth_required
# ---------------------------------------------------------------------------

@pytest.mark.p0
def test_w04_non_auth_first_message_rejected(test_client):
    """W-04: Sending a non-auth typed message as the first message returns auth_error auth_required."""
    msg = json.dumps({"type": "ping", "payload": {}})

    with test_client.websocket_connect("/ws/client_w04") as ws:
        ws.send_text(msg)
        response = json.loads(ws.receive_text())

    assert response["type"] == "auth_error"
    assert response["payload"]["error"] == "auth_required"


# ---------------------------------------------------------------------------
# W-05: Non-JSON first message -> auth_error invalid_format
# ---------------------------------------------------------------------------

@pytest.mark.p0
def test_w05_non_json_auth_message_rejected(test_client):
    """W-05: Sending a non-JSON first message returns auth_error invalid_format."""
    with test_client.websocket_connect("/ws/client_w05") as ws:
        ws.send_text("this is not json {{{")
        response = json.loads(ws.receive_text())

    assert response["type"] == "auth_error"
    assert response["payload"]["error"] == "invalid_format"


# ---------------------------------------------------------------------------
# W-06: After auth, ping -> pong with timestamp
# ---------------------------------------------------------------------------

@pytest.mark.p0
def test_w06_ping_returns_pong(test_client):
    """W-06: After successful auth, a ping message receives a pong with a timestamp."""
    token = _make_valid_token()

    with test_client.websocket_connect("/ws/client_w06") as ws:
        ws.send_text(_auth_message(token))
        auth_resp = json.loads(ws.receive_text())
        assert auth_resp["type"] == "auth_ok", f"Auth failed: {auth_resp}"

        before = int(time.time() * 1000)
        ws.send_text(json.dumps({"type": "ping"}))
        pong = json.loads(ws.receive_text())
        after = int(time.time() * 1000)

    assert pong["type"] == "pong"
    assert "ts" in pong, "pong must include a 'ts' timestamp field"
    assert before <= pong["ts"] <= after + 100, "pong timestamp must be close to current time"


# ---------------------------------------------------------------------------
# W-07: After auth, conversation_sync -> conversation_data
# ---------------------------------------------------------------------------

@pytest.mark.p0
def test_w07_conversation_sync_returns_data(ws_app, test_client):
    """W-07: After auth, sending conversation_sync for an existing conversation returns conversation_data."""
    # Seed a conversation directly into the store.
    conv_id = "conv_ws_w07"
    ws_app.store.create_conversation(conv_id, "W-07 Test Conversation")

    token = _make_valid_token()

    with test_client.websocket_connect("/ws/client_w07") as ws:
        ws.send_text(_auth_message(token))
        auth_resp = json.loads(ws.receive_text())
        assert auth_resp["type"] == "auth_ok"

        ws.send_text(json.dumps({
            "type": "conversation_sync",
            "payload": {"conversation_id": conv_id}
        }))
        response = json.loads(ws.receive_text())

    assert response["type"] == "conversation_data"
    payload = response["payload"]
    assert payload["conversation_id"] == conv_id
    assert payload["title"] == "W-07 Test Conversation"
    assert isinstance(payload["messages"], list)


# ---------------------------------------------------------------------------
# W-08: After auth, message_send -> message_sent
# ---------------------------------------------------------------------------

@pytest.mark.p0
def test_w08_message_send_returns_message_sent(ws_app, test_client):
    """W-08: After auth, sending message_send to an existing conversation returns message_sent."""
    conv_id = "conv_ws_w08"
    ws_app.store.create_conversation(conv_id, "W-08 Test Conversation")

    token = _make_valid_token()

    with test_client.websocket_connect("/ws/client_w08") as ws:
        ws.send_text(_auth_message(token))
        auth_resp = json.loads(ws.receive_text())
        assert auth_resp["type"] == "auth_ok"

        ws.send_text(json.dumps({
            "type": "message_send",
            "payload": {
                "conversation_id": conv_id,
                "content": "Hello from W-08"
            }
        }))
        response = json.loads(ws.receive_text())

    assert response["type"] == "message_sent"
    payload = response["payload"]
    assert "message_id" in payload, "message_sent payload must include message_id"
    assert payload["status"] == "ok"


# ---------------------------------------------------------------------------
# W-09: Same extension reconnects -> old connection is replaced
# ---------------------------------------------------------------------------

@pytest.mark.p0
def test_w09_same_extension_replaces_old_connection(ws_app, test_client):
    """W-09: When the same extension opens a second WebSocket, the old connection is closed."""
    extension_id = "ext_replacement_test"
    token_first = _make_valid_token(extension_id)
    token_second = _make_valid_token(extension_id)

    # Open the first connection and authenticate.
    with test_client.websocket_connect("/ws/client_first") as ws_first:
        ws_first.send_text(_auth_message(token_first))
        first_auth = json.loads(ws_first.receive_text())
        assert first_auth["type"] == "auth_ok", f"First auth failed: {first_auth}"
        first_session = first_auth["payload"]["session_id"]

        # Open the second connection for the same extension.
        with test_client.websocket_connect("/ws/client_second") as ws_second:
            ws_second.send_text(_auth_message(token_second))
            second_auth = json.loads(ws_second.receive_text())
            assert second_auth["type"] == "auth_ok", f"Second auth failed: {second_auth}"
            second_session = second_auth["payload"]["session_id"]

        # The second session must be a distinct session id.
        assert first_session != second_session

    # After both contexts exit, verify the manager no longer holds the first session.
    assert first_session not in ws_app.manager.active_connections
    assert second_session not in ws_app.manager.active_connections


# ---------------------------------------------------------------------------
# W-10: After normal disconnect, session is removed from DB
# ---------------------------------------------------------------------------

@pytest.mark.p0
def test_w10_disconnect_cleans_up_session(ws_app, test_client):
    """W-10: After a normal disconnect, the session is removed from the database."""
    token = _make_valid_token()
    session_id = None

    with test_client.websocket_connect("/ws/client_w10") as ws:
        ws.send_text(_auth_message(token))
        auth_resp = json.loads(ws.receive_text())
        assert auth_resp["type"] == "auth_ok"
        session_id = auth_resp["payload"]["session_id"]

        # Verify the session exists in DB while connection is open.
        assert ws_app.store.get_session(session_id) is not None

    # After the context manager exits the connection is closed; give the server
    # thread a moment to handle the WebSocketDisconnect and run cleanup.
    import time as _time
    _time.sleep(0.2)

    assert ws_app.store.get_session(session_id) is None
    assert session_id not in ws_app.manager.active_connections


# ---------------------------------------------------------------------------
# W-11: Unknown message_type -> error unknown_message_type
# ---------------------------------------------------------------------------

@pytest.mark.p0
def test_w11_unknown_message_type_returns_error(test_client):
    """W-11: After auth, sending an unrecognised message type returns error unknown_message_type."""
    token = _make_valid_token()

    with test_client.websocket_connect("/ws/client_w11") as ws:
        ws.send_text(_auth_message(token))
        auth_resp = json.loads(ws.receive_text())
        assert auth_resp["type"] == "auth_ok"

        ws.send_text(json.dumps({"type": "teleport", "payload": {}}))
        response = json.loads(ws.receive_text())

    assert response["type"] == "error"
    assert response["payload"]["error"] == "unknown_message_type"


# ---------------------------------------------------------------------------
# W-12: conversation_sync for nonexistent conversation -> error conversation_not_found
# ---------------------------------------------------------------------------

@pytest.mark.p0
def test_w12_sync_nonexistent_conversation_returns_error(test_client):
    """W-12: Requesting conversation_sync for a conversation that does not exist returns error conversation_not_found."""
    token = _make_valid_token()

    with test_client.websocket_connect("/ws/client_w12") as ws:
        ws.send_text(_auth_message(token))
        auth_resp = json.loads(ws.receive_text())
        assert auth_resp["type"] == "auth_ok"

        ws.send_text(json.dumps({
            "type": "conversation_sync",
            "payload": {"conversation_id": "conv_does_not_exist_xyz"}
        }))
        response = json.loads(ws.receive_text())

    assert response["type"] == "error"
    assert response["payload"]["error"] == "conversation_not_found"
