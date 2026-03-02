"""Tests for SQLiteStore — D-01 through D-16.

Covers schema initialisation, session CRUD, conversation listing with cursor
and limit, nested message loading, API key lifecycle, image CRUD, and WAL mode.
"""

import sqlite3
import time
import uuid

import pytest

from mcp_server import Message, SQLiteStore


# ---------------------------------------------------------------------------
# Schema / initialisation
# ---------------------------------------------------------------------------


@pytest.mark.p0
def test_d01_init_db_creates_all_six_tables(store: SQLiteStore, temp_db: str):
    """D-01: _init_db() creates all 6 expected tables."""
    with sqlite3.connect(temp_db) as conn:
        rows = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
        ).fetchall()
    table_names = {row[0] for row in rows}
    expected = {"api_keys", "conversations", "images", "messages", "sessions", "tokens"}
    assert expected.issubset(table_names), (
        f"Missing tables: {expected - table_names}"
    )


@pytest.mark.p0
def test_d02_init_db_creates_all_four_indexes(store: SQLiteStore, temp_db: str):
    """D-02: _init_db() creates all 4 expected indexes."""
    with sqlite3.connect(temp_db) as conn:
        rows = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='index' ORDER BY name"
        ).fetchall()
    index_names = {row[0] for row in rows}
    expected = {
        "idx_images_conversation_id",
        "idx_messages_conversation_id",
        "idx_messages_timestamp",
        "idx_sessions_extension_id",
    }
    assert expected.issubset(index_names), (
        f"Missing indexes: {expected - index_names}"
    )


# ---------------------------------------------------------------------------
# Session methods
# ---------------------------------------------------------------------------


@pytest.mark.p0
def test_d03_create_session_then_get_session_returns_session(store: SQLiteStore):
    """D-03: create_session() followed by get_session() returns the stored row."""
    session_id = "sess_" + uuid.uuid4().hex
    extension_id = "ext_001"
    expires_at = int(time.time() * 1000) + 3_600_000

    store.create_session(session_id, extension_id, expires_at)
    result = store.get_session(session_id)

    assert result is not None
    assert result["session_id"] == session_id
    assert result["extension_id"] == extension_id
    assert result["expires_at"] == expires_at


@pytest.mark.p0
def test_d04_delete_session_then_get_session_returns_none(store: SQLiteStore):
    """D-04: delete_session() removes the row; get_session() returns None."""
    session_id = "sess_" + uuid.uuid4().hex
    store.create_session(session_id, "ext_002", int(time.time() * 1000) + 3_600_000)

    store.delete_session(session_id)
    result = store.get_session(session_id)

    assert result is None


@pytest.mark.p1
def test_d05_delete_sessions_for_extension_batch_deletes(store: SQLiteStore):
    """D-05: delete_sessions_for_extension() removes all sessions for that extension_id."""
    ext_id = "ext_batch"
    other_ext_id = "ext_other"
    expires_at = int(time.time() * 1000) + 3_600_000

    ids_to_delete = ["sess_a1", "sess_a2", "sess_a3"]
    id_to_keep = "sess_b1"

    for sid in ids_to_delete:
        store.create_session(sid, ext_id, expires_at)
    store.create_session(id_to_keep, other_ext_id, expires_at)

    store.delete_sessions_for_extension(ext_id)

    for sid in ids_to_delete:
        assert store.get_session(sid) is None, f"Expected {sid} to be deleted"
    assert store.get_session(id_to_keep) is not None, "Session for other extension must survive"


# ---------------------------------------------------------------------------
# Conversation listing
# ---------------------------------------------------------------------------


@pytest.mark.p0
def test_d06_list_conversations_sorted_by_updated_at_desc(store: SQLiteStore):
    """D-06: list_conversations() returns conversations sorted by updated_at DESC."""
    base_ts = int(time.time() * 1000)

    ids_and_ts = [
        ("conv_old", base_ts - 2000),
        ("conv_mid", base_ts - 1000),
        ("conv_new", base_ts),
    ]
    for conv_id, ts in ids_and_ts:
        with store._get_connection() as conn:
            conn.execute(
                "INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
                (conv_id, conv_id, ts, ts),
            )

    results = store.list_conversations()
    returned_ids = [r["id"] for r in results]

    assert returned_ids == ["conv_new", "conv_mid", "conv_old"]


@pytest.mark.p1
def test_d07_list_conversations_with_cursor_returns_older_items(store: SQLiteStore):
    """D-07: list_conversations() with cursor returns only conversations older than cursor."""
    base_ts = int(time.time() * 1000)

    conversations = [
        ("conv_1", base_ts - 3000),
        ("conv_2", base_ts - 2000),
        ("conv_3", base_ts - 1000),
        ("conv_4", base_ts),
    ]
    for conv_id, ts in conversations:
        with store._get_connection() as conn:
            conn.execute(
                "INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
                (conv_id, conv_id, ts, ts),
            )

    # cursor = updated_at of conv_3; should return only conv_2 and conv_1
    cursor = base_ts - 1000
    results = store.list_conversations(cursor=cursor)
    returned_ids = {r["id"] for r in results}

    assert "conv_4" not in returned_ids, "conv_4 is newer than cursor; must be excluded"
    assert "conv_3" not in returned_ids, "conv_3 equals cursor; must be excluded (strict <)"
    assert {"conv_1", "conv_2"}.issubset(returned_ids)


@pytest.mark.p1
def test_d08_list_conversations_with_limit_does_not_exceed_count(store: SQLiteStore):
    """D-08: list_conversations() with limit respects the maximum count."""
    base_ts = int(time.time() * 1000)

    for i in range(10):
        with store._get_connection() as conn:
            ts = base_ts + i
            conn.execute(
                "INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
                (f"conv_{i:02d}", f"Conv {i}", ts, ts),
            )

    results = store.list_conversations(limit=4)
    assert len(results) <= 4


# ---------------------------------------------------------------------------
# Conversation retrieval with nested messages
# ---------------------------------------------------------------------------


@pytest.mark.p0
def test_d09_get_conversation_includes_nested_messages(store: SQLiteStore):
    """D-09: get_conversation() returns a Conversation with its messages populated."""
    conv_id = "conv_nested"
    store.create_conversation(conv_id, "Nested Test")

    ts = int(time.time() * 1000)
    msg_a = Message(
        id="msg_nested_a",
        conversation_id=conv_id,
        role="user",
        content="Hello",
        timestamp=ts,
    )
    msg_b = Message(
        id="msg_nested_b",
        conversation_id=conv_id,
        role="assistant",
        content="Hi there",
        timestamp=ts + 1,
    )
    store.add_message(msg_a)
    store.add_message(msg_b)

    conversation = store.get_conversation(conv_id)

    assert conversation is not None
    assert conversation.id == conv_id
    assert len(conversation.messages) == 2
    message_ids = {m.id for m in conversation.messages}
    assert message_ids == {"msg_nested_a", "msg_nested_b"}


# ---------------------------------------------------------------------------
# Conversation creation
# ---------------------------------------------------------------------------


@pytest.mark.p0
def test_d10_create_conversation_is_queryable(store: SQLiteStore):
    """D-10: create_conversation() (save_conversation) persists and is retrievable."""
    conv_id = "conv_create_" + uuid.uuid4().hex
    title = "My New Conversation"

    returned = store.create_conversation(conv_id, title)

    assert returned["id"] == conv_id
    assert returned["title"] == title

    fetched = store.get_conversation(conv_id)
    assert fetched is not None
    assert fetched.id == conv_id
    assert fetched.title == title


# ---------------------------------------------------------------------------
# Message methods
# ---------------------------------------------------------------------------


@pytest.mark.p0
def test_d11_add_message_creates_and_is_queryable(store: SQLiteStore):
    """D-11: add_message() persists the message; it appears via get_messages()."""
    conv_id = "conv_msg_" + uuid.uuid4().hex
    store.create_conversation(conv_id, "Message Test")

    ts = int(time.time() * 1000)
    msg = Message(
        id="msg_basic_001",
        conversation_id=conv_id,
        role="user",
        content="Test content",
        timestamp=ts,
    )
    store.add_message(msg)

    messages = store.get_messages(conv_id)

    assert len(messages) == 1
    saved = messages[0]
    assert saved.id == "msg_basic_001"
    assert saved.role == "user"
    assert saved.content == "Test content"
    assert saved.timestamp == ts


@pytest.mark.p1
def test_d12_add_message_with_attachments_serializes_correctly(store: SQLiteStore):
    """D-12: add_message() with attachments JSON-serializes; get_messages() deserializes correctly."""
    conv_id = "conv_attach_" + uuid.uuid4().hex
    store.create_conversation(conv_id, "Attachment Test")

    attachments = ["https://example.com/img1.png", "https://example.com/img2.jpg"]
    msg = Message(
        id="msg_attach_001",
        conversation_id=conv_id,
        role="user",
        content="See attached images",
        attachments=attachments,
        timestamp=int(time.time() * 1000),
    )
    store.add_message(msg)

    messages = store.get_messages(conv_id)

    assert len(messages) == 1
    saved = messages[0]
    assert saved.attachments is not None
    assert isinstance(saved.attachments, list)
    assert saved.attachments == attachments


# ---------------------------------------------------------------------------
# API key methods
# ---------------------------------------------------------------------------


@pytest.mark.p0
def test_d13_create_api_key_then_get_by_hash_finds_it(store: SQLiteStore):
    """D-13: create_api_key() then get_api_key_by_hash() returns the active key row."""
    key_id = "key_" + uuid.uuid4().hex
    api_key_hash = "sha256_" + uuid.uuid4().hex
    name = "Integration Test Key"

    store.create_api_key(key_id, api_key_hash, name)
    result = store.get_api_key_by_hash(api_key_hash)

    assert result is not None
    assert result["key_id"] == key_id
    assert result["api_key_hash"] == api_key_hash
    assert result["name"] == name
    assert result["is_active"] == 1


@pytest.mark.p0
def test_d14_revoke_api_key_sets_is_active_to_zero(store: SQLiteStore):
    """D-14: revoke_api_key() sets is_active = 0; get_api_key_by_hash() no longer finds it."""
    key_id = "key_revoke_" + uuid.uuid4().hex
    api_key_hash = "sha256_revoke_" + uuid.uuid4().hex

    store.create_api_key(key_id, api_key_hash, "Key To Revoke")

    revoked = store.revoke_api_key(key_id)
    assert revoked is True

    # get_api_key_by_hash filters on is_active = 1, so it must return None
    result = store.get_api_key_by_hash(api_key_hash)
    assert result is None, "Revoked key must not be returned by get_api_key_by_hash"

    # Confirm the row still exists but with is_active = 0
    all_keys = store.list_api_keys()
    matching = [k for k in all_keys if k["key_id"] == key_id]
    assert len(matching) == 1
    assert matching[0]["is_active"] == 0


# ---------------------------------------------------------------------------
# Image methods
# ---------------------------------------------------------------------------


@pytest.mark.p0
def test_d15_save_image_then_get_image_crud_works(store: SQLiteStore):
    """D-15: save_image() persists the record; get_image() retrieves full data."""
    image_id = "img_" + uuid.uuid4().hex
    url = f"http://localhost:8000/images/{image_id}.png"
    filename = "screenshot.png"
    mime_type = "image/png"
    size = 20_480
    path = f"/data/images/{image_id}.png"

    store.save_image(
        image_id=image_id,
        url=url,
        filename=filename,
        mime_type=mime_type,
        size=size,
        path=path,
    )
    result = store.get_image(image_id)

    assert result is not None
    assert result["image_id"] == image_id
    assert result["url"] == url
    assert result["filename"] == filename
    assert result["mime_type"] == mime_type
    assert result["size"] == size
    assert result["path"] == path
    assert result["conversation_id"] is None


# ---------------------------------------------------------------------------
# WAL mode
# ---------------------------------------------------------------------------


@pytest.mark.p0
def test_d16_wal_mode_is_enabled(store: SQLiteStore, temp_db: str):
    """D-16: WAL mode is active; PRAGMA journal_mode returns 'wal'."""
    with sqlite3.connect(temp_db) as conn:
        row = conn.execute("PRAGMA journal_mode").fetchone()
    assert row is not None
    assert row[0].lower() == "wal", (
        f"Expected journal_mode='wal', got '{row[0]}'"
    )
