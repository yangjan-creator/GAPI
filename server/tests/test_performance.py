"""Performance tests for the GAPI server.

Test IDs:
    P-01: 100 concurrent conversation list requests -> all 200, average <200ms
    P-02: RateLimiter with 10000 keys cleanup -> no memory leak
    P-03: SQLite WAL mode concurrent read/write -> no "database locked" errors
    P-04: Multiple WebSocket connections (20) -> all authenticate successfully
"""

import asyncio
import json
import os
import sys
import threading
import time
import uuid
from pathlib import Path
from typing import List

import pytest

SERVER_DIR = Path(__file__).parent.parent
sys.path.insert(0, str(SERVER_DIR))

os.environ["GAPI_AUTH_SECRET"] = "test_secret_key_for_testing"
os.environ["GAPI_DEV_MODE"] = "false"


# ---------------------------------------------------------------------------
# P-01: 100 concurrent conversation list requests
# ---------------------------------------------------------------------------


@pytest.mark.p2
@pytest.mark.slow
@pytest.mark.asyncio
async def test_p01_concurrent_conversation_list(tmp_path):
    """P-01: 100 concurrent GET /v1/conversations requests all return 200 with avg <200ms.

    Uses asyncio.gather to fire requests in parallel through an in-process
    ASGITransport so no actual TCP stack overhead is incurred.
    """
    import importlib

    db_path = str(tmp_path / "p01_test.db")
    os.environ["GAPI_DB_PATH"] = db_path

    import auth
    importlib.reload(auth)
    import rate_limiter
    importlib.reload(rate_limiter)
    import mcp_server
    importlib.reload(mcp_server)

    from auth import generate_token
    from httpx import AsyncClient, ASGITransport

    timestamp = int(time.time() * 1000)
    token = generate_token("test", timestamp)
    headers = {"Authorization": f"Bearer {token}"}

    transport = ASGITransport(app=mcp_server.app)

    async with AsyncClient(transport=transport, base_url="http://test") as client:
        num_requests = 100

        async def single_request() -> float:
            """Send one GET request and return elapsed seconds."""
            start = time.monotonic()
            response = await client.get("/v1/conversations", headers=headers)
            elapsed = time.monotonic() - start
            assert response.status_code == 200, (
                f"Expected 200 OK but got {response.status_code}: {response.text}"
            )
            return elapsed

        durations: List[float] = await asyncio.gather(
            *[single_request() for _ in range(num_requests)]
        )

    average_ms = (sum(durations) / len(durations)) * 1000

    assert len(durations) == num_requests, (
        f"Expected {num_requests} completed requests, got {len(durations)}"
    )
    assert average_ms < 200, (
        f"Average response time {average_ms:.1f}ms exceeded 200ms threshold"
    )


# ---------------------------------------------------------------------------
# P-02: RateLimiter with 10000 keys — no memory leak after cleanup
# ---------------------------------------------------------------------------


@pytest.mark.p2
@pytest.mark.slow
def test_p02_rate_limiter_10000_keys_no_memory_leak():
    """P-02: Adding 10000 unique keys and calling cleanup leaves no stale entries.

    After the window expires all timestamps are pruned by _cleanup().  The
    internal dict keys remain (defaultdict behaviour) but their value lists
    must be empty, proving no timestamp data is retained.
    """
    from rate_limiter import RateLimiter

    limiter = RateLimiter()
    num_keys = 10_000
    # Use an extremely short window so entries expire immediately.
    window = 0.001  # 1 ms

    for i in range(num_keys):
        key = f"client_{i}"
        limiter.check(key, limit=1, window=window)

    # All timestamps are now older than the window; allow time to pass.
    time.sleep(0.05)

    # Trigger cleanup for every key by calling remaining().
    live_entries = 0
    for i in range(num_keys):
        key = f"client_{i}"
        limiter._cleanup(key, window)
        live_entries += len(limiter._requests[key])

    assert live_entries == 0, (
        f"Expected 0 live timestamp entries after cleanup, found {live_entries}"
    )

    # Verify the limiter is still functional for new requests after cleanup.
    assert limiter.check("new_client", limit=5, window=60.0) is True, (
        "RateLimiter must still accept requests after mass cleanup"
    )


# ---------------------------------------------------------------------------
# P-03: SQLite WAL mode concurrent read/write — no "database locked" errors
# ---------------------------------------------------------------------------


@pytest.mark.p2
@pytest.mark.slow
def test_p03_sqlite_wal_concurrent_read_write(store):
    """P-03: Concurrent reader and writer threads produce no OperationalError.

    SQLiteStore enables WAL mode and busy_timeout=5000ms.  This test spins up
    one writer thread (inserting conversations) and four reader threads (listing
    conversations) running simultaneously to confirm that no "database locked"
    errors surface under concurrent load.
    """
    from mcp_server import SQLiteStore, Message

    num_writes = 50
    num_readers = 4
    reads_per_thread = 30
    errors: List[str] = []
    write_lock = threading.Lock()

    def writer_task() -> None:
        for i in range(num_writes):
            conv_id = f"conv_perf_{uuid.uuid4().hex}"
            try:
                store.create_conversation(conv_id, f"Perf Conversation {i}")
                # Add a message to trigger update_conversation as well.
                msg = Message(
                    id=f"msg_perf_{uuid.uuid4().hex}",
                    conversation_id=conv_id,
                    role="user",
                    content=f"Message content {i}",
                    timestamp=int(time.time() * 1000),
                )
                store.add_message(msg)
            except Exception as exc:
                with write_lock:
                    errors.append(f"Writer error: {exc}")

    def reader_task(thread_index: int) -> None:
        for _ in range(reads_per_thread):
            try:
                store.list_conversations(limit=20)
            except Exception as exc:
                with write_lock:
                    errors.append(f"Reader {thread_index} error: {exc}")

    threads = [threading.Thread(target=writer_task)]
    for idx in range(num_readers):
        threads.append(threading.Thread(target=reader_task, args=(idx,)))

    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=30)

    locked_errors = [e for e in errors if "database is locked" in e.lower()]

    assert not locked_errors, (
        f"Encountered 'database locked' errors under concurrent load: {locked_errors}"
    )
    assert not errors, (
        f"Unexpected errors during concurrent read/write test: {errors}"
    )


# ---------------------------------------------------------------------------
# P-04: 20 WebSocket connections — all authenticate successfully
# ---------------------------------------------------------------------------


@pytest.mark.p2
@pytest.mark.slow
@pytest.mark.asyncio
async def test_p04_multiple_websocket_connections_authenticate(tmp_path):
    """P-04: 20 concurrent WebSocket connections all complete auth_ok handshake.

    Each connection uses a distinct extension_id so the WebSocketManager does
    not evict previous sessions.  The test verifies that every connection
    receives an ``auth_ok`` message.
    """
    import importlib

    db_path = str(tmp_path / "p04_test.db")
    os.environ["GAPI_DB_PATH"] = db_path

    import auth
    importlib.reload(auth)
    import rate_limiter
    importlib.reload(rate_limiter)
    import mcp_server
    importlib.reload(mcp_server)

    from auth import generate_token
    from starlette.testclient import TestClient

    num_connections = 20
    results: List[str] = []
    errors: List[str] = []

    def connect_and_auth(index: int) -> None:
        """Open a WebSocket, send auth, collect the response type."""
        extension_id = f"perf_ext_{index}_{uuid.uuid4().hex[:8]}"
        timestamp = int(time.time() * 1000)
        token = generate_token(extension_id, timestamp)
        client_id = f"client_{index}"

        try:
            with TestClient(mcp_server.app) as test_client:
                with test_client.websocket_connect(f"/ws/{client_id}") as ws:
                    auth_payload = json.dumps({
                        "type": "auth",
                        "payload": {"token": token},
                    })
                    ws.send_text(auth_payload)
                    response_text = ws.receive_text()
                    response = json.loads(response_text)
                    results.append(response.get("type", "unknown"))
        except Exception as exc:
            errors.append(f"Connection {index} error: {exc}")

    threads = [
        threading.Thread(target=connect_and_auth, args=(i,))
        for i in range(num_connections)
    ]

    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=30)

    assert not errors, (
        f"WebSocket connection errors: {errors}"
    )
    assert len(results) == num_connections, (
        f"Expected {num_connections} responses, got {len(results)}"
    )

    non_auth_ok = [r for r in results if r != "auth_ok"]
    assert not non_auth_ok, (
        f"Some connections did not receive auth_ok: {non_auth_ok}"
    )
