"""HTTP API endpoint tests for GAPI server — 26 test cases (H-01 through H-26).

Coverage:
- Health check: GET /status
- Auth endpoints: token generation, validation, rate limiting
- API Key endpoints: create, list, revoke, validate
- Conversation endpoints: create, list with cursor pagination, get by ID
- Message endpoints: send, missing conversation, attachments
- Image endpoints: base64 upload, file upload, get, list, delete, invalid data

All tests use the ``client`` fixture (httpx AsyncClient against the ASGI app).
Auth tokens are generated inline via ``auth.generate_token`` because the
``client`` fixture reloads modules, which invalidates any token produced by a
different module instance.
"""

import base64
import io
import time
from pathlib import Path

import pytest

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

FIXTURES_DIR = Path(__file__).parent / "fixtures"


def _make_auth_headers() -> dict:
    """Generate a fresh bearer-token header from the reloaded auth module.

    Must be called *inside* a test body (after the client fixture has
    reloaded ``auth``) so that the HMAC secret used to sign the token
    matches the secret used by the running app.
    """
    import auth
    token = auth.generate_token("test", int(time.time() * 1000))
    return {"Authorization": f"Bearer {token}"}


def _minimal_png() -> bytes:
    """Return the smallest possible valid PNG (1x1 white pixel)."""
    # Pre-built 1×1 pixel white PNG (67 bytes) — avoids PIL/Pillow dependency.
    return (
        b"\x89PNG\r\n\x1a\n"                     # PNG signature
        b"\x00\x00\x00\rIHDR"                    # IHDR chunk length + type
        b"\x00\x00\x00\x01"                      # width  = 1
        b"\x00\x00\x00\x01"                      # height = 1
        b"\x08\x02"                              # bit depth = 8, colour type = RGB
        b"\x00\x00\x00"                          # compression/filter/interlace
        b"\x90wS\xde"                            # IHDR CRC
        b"\x00\x00\x00\x0cIDATx\x9cc\xf8\x0f"   # IDAT chunk
        b"\x00\x00\x01\x01\x00\x05\x18\xd8N"    # compressed pixel data + CRC
        b"\x00\x00\x00\x00IEND\xaeB`\x82"        # IEND chunk
    )


def _png_as_data_url(png_bytes: bytes | None = None) -> str:
    """Return a ``data:image/png;base64,...`` URL from raw PNG bytes."""
    raw = png_bytes if png_bytes is not None else _minimal_png()
    encoded = base64.b64encode(raw).decode()
    return f"data:image/png;base64,{encoded}"


# ---------------------------------------------------------------------------
# H-01: Health check
# ---------------------------------------------------------------------------

@pytest.mark.p0
@pytest.mark.asyncio
async def test_H01_status_returns_ok(client):
    """H-01: GET /status returns 200 with status 'ok' and version '2.0.0'."""
    response = await client.get("/status")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["version"] == "2.0.0"


# ---------------------------------------------------------------------------
# H-02 – H-06: Auth token endpoints
# ---------------------------------------------------------------------------

@pytest.mark.p0
@pytest.mark.asyncio
async def test_H02_generate_token_returns_token_and_expires_at(client):
    """H-02: POST /v1/auth/token?extension_id=test returns token and expires_at."""
    response = await client.post("/v1/auth/token", params={"extension_id": "test"})
    assert response.status_code == 200
    body = response.json()
    assert "token" in body
    assert body["token"].startswith("ext_test_")
    assert "expires_at" in body
    assert isinstance(body["expires_at"], int)
    assert body["expires_at"] > int(time.time() * 1000)


@pytest.mark.p0
@pytest.mark.asyncio
async def test_H03_generate_token_without_extension_id_returns_422(client):
    """H-03: POST /v1/auth/token without extension_id returns 422."""
    response = await client.post("/v1/auth/token")
    assert response.status_code == 422


@pytest.mark.p0
@pytest.mark.asyncio
async def test_H04_auth_token_rate_limit_returns_429_after_10_requests(client):
    """H-04: POST /v1/auth/token >10/min returns 429 on the 11th request."""
    params = {"extension_id": "rate_test"}
    # Exhaust the 10-request window
    for _ in range(10):
        r = await client.post("/v1/auth/token", params=params)
        # Each of the first 10 must succeed (200)
        assert r.status_code == 200, f"Expected 200 on request within limit, got {r.status_code}"

    # The 11th request must be rejected
    r = await client.post("/v1/auth/token", params=params)
    assert r.status_code == 429


@pytest.mark.p0
@pytest.mark.asyncio
async def test_H05_validate_valid_token_returns_valid_true(client):
    """H-05: POST /v1/auth/validate with a valid token returns valid: true."""
    import auth
    token = auth.generate_token("ext_validate", int(time.time() * 1000))
    response = await client.post("/v1/auth/validate", params={"token": token})
    assert response.status_code == 200
    body = response.json()
    assert body["valid"] is True
    assert "extension_id" in body


@pytest.mark.p0
@pytest.mark.asyncio
async def test_H06_validate_invalid_token_returns_valid_false(client):
    """H-06: POST /v1/auth/validate with an invalid token returns valid: false."""
    response = await client.post("/v1/auth/validate", params={"token": "not_a_real_token"})
    assert response.status_code == 200
    body = response.json()
    assert body["valid"] is False


# ---------------------------------------------------------------------------
# H-07 – H-12: API Key endpoints
# ---------------------------------------------------------------------------

@pytest.mark.p0
@pytest.mark.asyncio
async def test_H07_create_api_key_with_auth_returns_key_pair(client):
    """H-07: POST /v1/auth/api-keys with auth creates and returns a key pair."""
    headers = _make_auth_headers()
    payload = {"name": "ci-key"}
    response = await client.post("/v1/auth/api-keys", json=payload, headers=headers)
    assert response.status_code == 200
    body = response.json()
    assert "key_id" in body
    assert "api_key" in body
    assert body["api_key"].startswith("gapi_")
    assert body["name"] == "ci-key"


@pytest.mark.p0
@pytest.mark.asyncio
async def test_H08_create_api_key_without_auth_returns_401(client):
    """H-08: POST /v1/auth/api-keys without auth returns 401."""
    payload = {"name": "no-auth-key"}
    response = await client.post("/v1/auth/api-keys", json=payload)
    assert response.status_code == 401


@pytest.mark.p0
@pytest.mark.asyncio
async def test_H09_list_api_keys_does_not_expose_raw_api_key(client):
    """H-09: GET /v1/auth/api-keys lists keys without raw api_key values."""
    headers = _make_auth_headers()
    # Create a key first so the list is non-empty
    await client.post(
        "/v1/auth/api-keys",
        json={"name": "list-test-key"},
        headers=headers,
    )

    response = await client.get("/v1/auth/api-keys", headers=headers)
    assert response.status_code == 200
    body = response.json()
    assert "api_keys" in body
    assert isinstance(body["api_keys"], list)
    assert len(body["api_keys"]) >= 1

    for key_entry in body["api_keys"]:
        # The raw api_key must never appear in the list response
        assert "api_key" not in key_entry
        assert "key_id" in key_entry
        assert "name" in key_entry


@pytest.mark.p0
@pytest.mark.asyncio
async def test_H10_delete_api_key_revokes_it(client):
    """H-10: DELETE /v1/auth/api-keys/{id} revokes the key."""
    headers = _make_auth_headers()
    # Create a key to revoke
    create_resp = await client.post(
        "/v1/auth/api-keys",
        json={"name": "to-revoke"},
        headers=headers,
    )
    assert create_resp.status_code == 200
    key_id = create_resp.json()["key_id"]

    delete_resp = await client.delete(f"/v1/auth/api-keys/{key_id}", headers=headers)
    assert delete_resp.status_code == 200
    body = delete_resp.json()
    assert body["status"] == "revoked"
    assert body["key_id"] == key_id


@pytest.mark.p0
@pytest.mark.asyncio
async def test_H11_validate_api_key_with_valid_key_returns_valid_true(client):
    """H-11: POST /v1/auth/api-keys/validate with a valid key returns valid: true."""
    headers = _make_auth_headers()
    create_resp = await client.post(
        "/v1/auth/api-keys",
        json={"name": "validate-me"},
        headers=headers,
    )
    assert create_resp.status_code == 200
    api_key = create_resp.json()["api_key"]

    validate_resp = await client.post(
        "/v1/auth/api-keys/validate",
        params={"api_key": api_key},
    )
    assert validate_resp.status_code == 200
    body = validate_resp.json()
    assert body["valid"] is True
    assert "key_id" in body


@pytest.mark.p0
@pytest.mark.asyncio
async def test_H12_validate_api_key_with_revoked_key_returns_valid_false(client):
    """H-12: POST /v1/auth/api-keys/validate with a revoked key returns valid: false."""
    headers = _make_auth_headers()
    # Create then immediately revoke
    create_resp = await client.post(
        "/v1/auth/api-keys",
        json={"name": "soon-revoked"},
        headers=headers,
    )
    assert create_resp.status_code == 200
    key_id = create_resp.json()["key_id"]
    api_key = create_resp.json()["api_key"]

    await client.delete(f"/v1/auth/api-keys/{key_id}", headers=headers)

    validate_resp = await client.post(
        "/v1/auth/api-keys/validate",
        params={"api_key": api_key},
    )
    assert validate_resp.status_code == 200
    body = validate_resp.json()
    assert body["valid"] is False


# ---------------------------------------------------------------------------
# H-13 – H-17: Conversation endpoints
# ---------------------------------------------------------------------------

@pytest.mark.p0
@pytest.mark.asyncio
async def test_H13_create_conversation_returns_200_with_id(client):
    """H-13: POST /v1/conversations creates a conversation and returns its id."""
    headers = _make_auth_headers()
    response = await client.post(
        "/v1/conversations",
        json={"title": "Test Chat"},
        headers=headers,
    )
    assert response.status_code == 200
    body = response.json()
    assert "id" in body
    assert body["id"].startswith("conv_")
    assert body["title"] == "Test Chat"
    assert "created_at" in body
    assert "updated_at" in body


@pytest.mark.p0
@pytest.mark.asyncio
async def test_H14_list_conversations_returns_list_with_meta_cursor(client):
    """H-14: GET /v1/conversations returns conversations list and meta.cursor."""
    headers = _make_auth_headers()
    # Create at least one conversation
    await client.post("/v1/conversations", json={"title": "List Test"}, headers=headers)

    response = await client.get("/v1/conversations", headers=headers)
    assert response.status_code == 200
    body = response.json()
    assert "conversations" in body
    assert isinstance(body["conversations"], list)
    assert len(body["conversations"]) >= 1
    assert "meta" in body
    assert "cursor" in body["meta"]
    assert "has_more" in body["meta"]


@pytest.mark.p0
@pytest.mark.asyncio
async def test_H15_list_conversations_with_cursor_returns_older_data(client):
    """H-15: GET /v1/conversations with cursor returns only data older than the cursor."""
    headers = _make_auth_headers()

    # Create two conversations slightly apart in time
    await client.post("/v1/conversations", json={"title": "Older Chat"}, headers=headers)
    time.sleep(0.01)
    newer_resp = await client.post(
        "/v1/conversations", json={"title": "Newer Chat"}, headers=headers
    )
    newer_updated_at = newer_resp.json()["updated_at"]

    # Use the newer conversation's updated_at as the cursor — we should only see older ones
    response = await client.get(
        "/v1/conversations",
        params={"cursor": newer_updated_at},
        headers=headers,
    )
    assert response.status_code == 200
    body = response.json()
    for conv in body["conversations"]:
        assert conv["updated_at"] < newer_updated_at


@pytest.mark.p0
@pytest.mark.asyncio
async def test_H16_get_conversation_returns_conversation_with_messages(client):
    """H-16: GET /v1/conversations/{id} returns the conversation with its messages list."""
    headers = _make_auth_headers()
    # Create conversation via HTTP so the reloaded store is used
    create_resp = await client.post(
        "/v1/conversations",
        json={"title": "Message Holder"},
        headers=headers,
    )
    conv_id = create_resp.json()["id"]

    response = await client.get(f"/v1/conversations/{conv_id}", headers=headers)
    assert response.status_code == 200
    body = response.json()
    assert body["id"] == conv_id
    assert body["title"] == "Message Holder"
    assert "messages" in body
    assert isinstance(body["messages"], list)


@pytest.mark.p0
@pytest.mark.asyncio
async def test_H17_get_conversation_with_invalid_id_returns_404(client):
    """H-17: GET /v1/conversations/{id} with a non-existent ID returns 404."""
    headers = _make_auth_headers()
    response = await client.get("/v1/conversations/conv_does_not_exist", headers=headers)
    assert response.status_code == 404


# ---------------------------------------------------------------------------
# H-18 – H-20: Message endpoints
# ---------------------------------------------------------------------------

@pytest.mark.p0
@pytest.mark.asyncio
async def test_H18_send_message_returns_message_id_and_status(client):
    """H-18: POST /v1/messages sends a message and returns message_id + status."""
    headers = _make_auth_headers()
    # Create a conversation first
    create_resp = await client.post(
        "/v1/conversations",
        json={"title": "Chat for Messages"},
        headers=headers,
    )
    conv_id = create_resp.json()["id"]

    msg_resp = await client.post(
        "/v1/messages",
        json={"conversation_id": conv_id, "content": "Hello world"},
        headers=headers,
    )
    assert msg_resp.status_code == 200
    body = msg_resp.json()
    assert "message_id" in body
    assert body["message_id"].startswith("msg_")
    assert body["status"] == "queued"


@pytest.mark.p0
@pytest.mark.asyncio
async def test_H19_send_message_to_nonexistent_conversation_returns_404(client):
    """H-19: POST /v1/messages to a non-existent conversation returns 404."""
    headers = _make_auth_headers()
    msg_resp = await client.post(
        "/v1/messages",
        json={"conversation_id": "conv_ghost", "content": "Will this work?"},
        headers=headers,
    )
    assert msg_resp.status_code == 404


@pytest.mark.p0
@pytest.mark.asyncio
async def test_H20_send_message_with_attachments_stores_them(client):
    """H-20: POST /v1/messages with attachments stores them and they appear in conversation."""
    headers = _make_auth_headers()
    # Create conversation
    create_resp = await client.post(
        "/v1/conversations",
        json={"title": "Attachment Chat"},
        headers=headers,
    )
    conv_id = create_resp.json()["id"]

    attachment_ids = ["img_001", "img_002"]
    msg_resp = await client.post(
        "/v1/messages",
        json={
            "conversation_id": conv_id,
            "content": "See attached",
            "attachments": attachment_ids,
        },
        headers=headers,
    )
    assert msg_resp.status_code == 200

    # Verify the message appears in the conversation with attachments intact
    conv_resp = await client.get(f"/v1/conversations/{conv_id}", headers=headers)
    assert conv_resp.status_code == 200
    messages = conv_resp.json()["messages"]
    assert len(messages) == 1
    assert messages[0]["attachments"] == attachment_ids


# ---------------------------------------------------------------------------
# H-21 – H-26: Image endpoints
# ---------------------------------------------------------------------------

@pytest.mark.p0
@pytest.mark.asyncio
async def test_H21_upload_image_base64_returns_200(client):
    """H-21: POST /v1/images/upload with a valid base64 PNG returns 200 with image metadata."""
    headers = _make_auth_headers()
    png_bytes = _minimal_png()
    data_url = _png_as_data_url(png_bytes)

    response = await client.post(
        "/v1/images/upload",
        data={"image_data": data_url},
        headers=headers,
    )
    assert response.status_code == 200
    body = response.json()
    assert "image_id" in body
    assert body["image_id"].startswith("img_")
    assert "url" in body
    assert body["mime_type"] == "image/png"
    assert body["size"] == len(png_bytes)


@pytest.mark.p0
@pytest.mark.asyncio
async def test_H22_upload_image_file_jpeg_returns_200(client):
    """H-22: POST /v1/images/upload-file with a JPEG file returns 200."""
    headers = _make_auth_headers()
    jpg_bytes = (FIXTURES_DIR / "sample.jpg").read_bytes()

    response = await client.post(
        "/v1/images/upload-file",
        files={"file": ("photo.jpg", io.BytesIO(jpg_bytes), "image/jpeg")},
        headers=headers,
    )
    assert response.status_code == 200
    body = response.json()
    assert "image_id" in body
    assert body["mime_type"] == "image/jpeg"
    assert body["size"] == len(jpg_bytes)


@pytest.mark.p0
@pytest.mark.asyncio
async def test_H23_get_image_downloads_uploaded_image(client):
    """H-23: GET /v1/images/{id} downloads a previously uploaded image."""
    headers = _make_auth_headers()
    png_bytes = _minimal_png()
    data_url = _png_as_data_url(png_bytes)

    upload_resp = await client.post(
        "/v1/images/upload",
        data={"image_data": data_url},
        headers=headers,
    )
    assert upload_resp.status_code == 200
    image_id = upload_resp.json()["image_id"]

    get_resp = await client.get(f"/v1/images/{image_id}", headers=headers)
    assert get_resp.status_code == 200
    assert get_resp.headers["content-type"].startswith("image/png")
    assert get_resp.content == png_bytes


@pytest.mark.p0
@pytest.mark.asyncio
async def test_H24_list_images_returns_image_list(client):
    """H-24: GET /v1/images returns a list of uploaded images with count."""
    headers = _make_auth_headers()
    png_bytes = _minimal_png()
    data_url = _png_as_data_url(png_bytes)

    # Upload one image so the list is non-empty
    await client.post(
        "/v1/images/upload",
        data={"image_data": data_url},
        headers=headers,
    )

    response = await client.get("/v1/images", headers=headers)
    assert response.status_code == 200
    body = response.json()
    assert "images" in body
    assert isinstance(body["images"], list)
    assert "count" in body
    assert body["count"] >= 1


@pytest.mark.p0
@pytest.mark.asyncio
async def test_H25_delete_image_removes_it(client):
    """H-25: DELETE /v1/images/{id} deletes the image and returns status 'deleted'."""
    headers = _make_auth_headers()
    png_bytes = _minimal_png()
    data_url = _png_as_data_url(png_bytes)

    upload_resp = await client.post(
        "/v1/images/upload",
        data={"image_data": data_url},
        headers=headers,
    )
    assert upload_resp.status_code == 200
    image_id = upload_resp.json()["image_id"]

    delete_resp = await client.delete(f"/v1/images/{image_id}", headers=headers)
    assert delete_resp.status_code == 200
    body = delete_resp.json()
    assert body["status"] == "deleted"
    assert body["image_id"] == image_id

    # Confirm it's gone: a subsequent GET should return 404
    get_resp = await client.get(f"/v1/images/{image_id}", headers=headers)
    assert get_resp.status_code == 404


@pytest.mark.p0
@pytest.mark.asyncio
async def test_H26_upload_non_image_data_returns_400(client):
    """H-26: POST /v1/images/upload with non-image base64 data returns 400."""
    headers = _make_auth_headers()
    # Encode plain HTML as a "PNG" data URL — magic byte check will reject it
    fake_data = base64.b64encode(b"<html>not an image</html>").decode()
    data_url = f"data:image/png;base64,{fake_data}"

    response = await client.post(
        "/v1/images/upload",
        data={"image_data": data_url},
        headers=headers,
    )
    assert response.status_code == 400
