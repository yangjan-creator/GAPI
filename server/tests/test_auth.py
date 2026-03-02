"""Tests for the GAPI auth module.

Covers token generation/validation, API key lifecycle, and the
create_verify_auth FastAPI dependency.

Test plan IDs: A-01 through A-18.
"""

import hmac
import time
from typing import Optional
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from auth import (
    generate_api_key,
    generate_token,
    hash_api_key,
    validate_api_key,
    validate_token,
    create_verify_auth,
    TOKEN_EXPIRE_SECONDS,
)


# ---------------------------------------------------------------------------
# Token generation
# ---------------------------------------------------------------------------


@pytest.mark.p0
def test_generate_token_format():
    """A-01: generate_token() produces the format ext_{id}_{ts}_{sig32}."""
    extension_id = "my_ext"
    timestamp = int(time.time() * 1000)

    token = generate_token(extension_id, timestamp)

    assert token.startswith("ext_"), "token must begin with 'ext_'"
    # Remove prefix and split on the last two underscores
    without_prefix = token[4:]
    parts = without_prefix.rsplit("_", 2)
    assert len(parts) == 3, "token must have three segments after 'ext_'"
    recovered_id, recovered_ts, signature = parts
    assert recovered_id == extension_id
    assert recovered_ts == str(timestamp)
    assert len(signature) == 32, "signature segment must be 32 hex characters"
    assert all(c in "0123456789abcdef" for c in signature), "signature must be hex"


@pytest.mark.p0
def test_generate_token_deterministic():
    """A-02: generate_token() is deterministic for the same inputs."""
    extension_id = "stable_ext"
    timestamp = 1700000000000

    token_a = generate_token(extension_id, timestamp)
    token_b = generate_token(extension_id, timestamp)

    assert token_a == token_b


# ---------------------------------------------------------------------------
# Token validation — happy path
# ---------------------------------------------------------------------------


@pytest.mark.p0
def test_validate_token_fresh(valid_token):
    """A-03: validate_token() validates a fresh token and returns claims."""
    result = validate_token(valid_token)

    assert result is not None
    assert "extension_id" in result
    assert "timestamp" in result
    assert result["extension_id"] == "test_extension"
    assert isinstance(result["timestamp"], int)


# ---------------------------------------------------------------------------
# Token validation — rejection cases
# ---------------------------------------------------------------------------


@pytest.mark.p0
def test_validate_token_expired(expired_token):
    """A-04: validate_token() rejects an expired token and returns None."""
    result = validate_token(expired_token)

    assert result is None


@pytest.mark.p1
def test_validate_token_tampered_signature():
    """A-05: validate_token() rejects a token with a tampered signature."""
    timestamp = int(time.time() * 1000)
    token = generate_token("ext_tamper", timestamp)
    # Replace the last character of the signature with a different one
    tampered = token[:-1] + ("0" if token[-1] != "0" else "1")

    result = validate_token(tampered)

    assert result is None


@pytest.mark.p0
@pytest.mark.parametrize("bad_value", [
    "",
    None,
])
def test_validate_token_rejects_empty_or_none(bad_value):
    """A-06: validate_token() rejects empty string and None, returns None."""
    result = validate_token(bad_value)

    assert result is None


@pytest.mark.p1
@pytest.mark.parametrize("bad_token", [
    "totally_wrong",
    "ext_",
    "ext_onlyone",
    "ext_two_parts",
    "Bearer ext_something_123_abc",
    "EXT_myext_1700000000000_" + "a" * 32,  # wrong prefix case
])
def test_validate_token_rejects_malformed(bad_token):
    """A-07: validate_token() rejects malformed tokens, returns None."""
    result = validate_token(bad_token)

    assert result is None


@pytest.mark.p1
def test_validate_token_extension_id_with_underscores():
    """A-08: validate_token() handles extension_id containing underscores via rsplit."""
    extension_id = "my_complex_ext_id"
    timestamp = int(time.time() * 1000)
    token = generate_token(extension_id, timestamp)

    result = validate_token(token)

    assert result is not None
    assert result["extension_id"] == extension_id
    assert result["timestamp"] == timestamp


@pytest.mark.p1
def test_validate_token_uses_compare_digest():
    """A-09: validate_token() uses hmac.compare_digest for constant-time comparison."""
    import inspect
    import auth as auth_module

    source = inspect.getsource(auth_module.validate_token)
    assert "hmac.compare_digest" in source, (
        "validate_token must use hmac.compare_digest for constant-time comparison"
    )


# ---------------------------------------------------------------------------
# API key generation
# ---------------------------------------------------------------------------


@pytest.mark.p0
def test_generate_api_key_format():
    """A-10: generate_api_key() returns key_id starting with 'key_' and api_key with 'gapi_'."""
    key_id, api_key = generate_api_key("my_service")

    assert key_id.startswith("key_"), f"key_id must start with 'key_', got: {key_id}"
    assert api_key.startswith("gapi_"), f"api_key must start with 'gapi_', got: {api_key}"


@pytest.mark.p0
def test_generate_api_key_unique_across_calls():
    """A-11: generate_api_key() produces different keys on each invocation."""
    _, api_key_1 = generate_api_key("svc")
    _, api_key_2 = generate_api_key("svc")

    assert api_key_1 != api_key_2


# ---------------------------------------------------------------------------
# API key hashing
# ---------------------------------------------------------------------------


@pytest.mark.p0
def test_hash_api_key_length():
    """A-12: hash_api_key() produces a 64-character hex string (SHA-256 digest)."""
    api_key = "gapi_somerandombits_andsig"

    result = hash_api_key(api_key)

    assert isinstance(result, str)
    assert len(result) == 64
    assert all(c in "0123456789abcdef" for c in result)


@pytest.mark.p0
def test_hash_api_key_deterministic():
    """A-13: hash_api_key() returns the same digest for the same input."""
    api_key = "gapi_stable_key_for_hashing"

    hash_a = hash_api_key(api_key)
    hash_b = hash_api_key(api_key)

    assert hash_a == hash_b


# ---------------------------------------------------------------------------
# API key validation against the store
# ---------------------------------------------------------------------------


@pytest.mark.p0
def test_validate_api_key_valid(store, valid_api_key):
    """A-14: validate_api_key() validates a key present in the DB and returns claims."""
    api_key = valid_api_key["api_key"]
    expected_key_id = valid_api_key["key_id"]

    result = validate_api_key(api_key, store)

    assert result is not None
    assert result["key_id"] == expected_key_id
    assert result["name"] == "test_key"
    assert "created_at" in result


@pytest.mark.p0
def test_validate_api_key_not_in_db(store):
    """A-15: validate_api_key() rejects a key not present in the DB, returns None."""
    _, unknown_key = generate_api_key("ghost_service")

    result = validate_api_key(unknown_key, store)

    assert result is None


@pytest.mark.p1
def test_validate_api_key_inactive(store, valid_api_key):
    """A-16: validate_api_key() rejects a key whose is_active flag is 0, returns None."""
    key_id = valid_api_key["key_id"]
    api_key = valid_api_key["api_key"]

    store.revoke_api_key(key_id)
    result = validate_api_key(api_key, store)

    assert result is None


@pytest.mark.p1
def test_validate_api_key_expired(store):
    """A-17: validate_api_key() rejects a key whose expires_at is in the past, returns None."""
    key_id, api_key = generate_api_key("expiry_test")
    past_expires_at = int(time.time() * 1000) - 60_000  # 1 minute ago
    store.create_api_key(key_id, hash_api_key(api_key), "expiry_test", expires_at=past_expires_at)

    result = validate_api_key(api_key, store)

    assert result is None


# ---------------------------------------------------------------------------
# create_verify_auth dependency
# ---------------------------------------------------------------------------


@pytest.mark.p0
@pytest.mark.asyncio
async def test_create_verify_auth_dev_mode_allows_unauthenticated(store):
    """A-18: create_verify_auth() returns dev identity when DEV_MODE is True and no credentials."""
    import auth as auth_module
    from fastapi import HTTPException

    verify_auth = create_verify_auth(store)

    with patch.object(auth_module, "DEV_MODE", True):
        # Pass credentials=None to simulate missing Authorization header
        result = await verify_auth(credentials=None)

    assert result is not None
    assert result["type"] == "dev"
    assert result["extension_id"] == "dev"
