"""GAPI Authentication Module

Handles token generation/validation, API key management, and auth dependencies.
"""

import os
import time
import secrets
import hashlib
import hmac
import logging
from typing import Optional
from fastapi import HTTPException, Depends
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials

logger = logging.getLogger("gapi.auth")

# Configuration from environment
AUTH_SECRET = os.environ.get("GAPI_AUTH_SECRET")
if not AUTH_SECRET:
    AUTH_SECRET = "dev_secret_" + secrets.token_hex(16)
    logger.warning(
        "GAPI_AUTH_SECRET not set — using generated dev secret. "
        "Set GAPI_AUTH_SECRET environment variable for production."
    )

DEV_MODE = os.environ.get("GAPI_DEV_MODE", "false").lower() == "true"
TOKEN_EXPIRE_SECONDS = 3600  # 1 hour

security = HTTPBearer(auto_error=False)


def generate_token(extension_id: str, timestamp: int) -> str:
    """Generate an authentication token with HMAC-SHA256 signature."""
    message = f"{extension_id}:{timestamp}"
    signature = hmac.new(
        AUTH_SECRET.encode(),
        message.encode(),
        hashlib.sha256
    ).hexdigest()[:32]
    return f"ext_{extension_id}_{timestamp}_{signature}"


def validate_token(token: str) -> Optional[dict]:
    """Validate a token and return its claims, or None if invalid."""
    if not token or not token.startswith("ext_"):
        return None

    try:
        # Token format: ext_{extension_id}_{timestamp}_{signature}
        # Use rsplit to handle extension_ids containing underscores
        without_prefix = token[4:]  # Remove "ext_"
        # Split from right: last part is signature, second-to-last is timestamp
        parts = without_prefix.rsplit("_", 2)
        if len(parts) < 3:
            return None

        extension_id = parts[0]
        timestamp = int(parts[1])
        signature = parts[2]

        # Check expiration
        now_ms = int(time.time() * 1000)
        if now_ms - timestamp > TOKEN_EXPIRE_SECONDS * 1000:
            return None

        # Verify signature
        expected = hmac.new(
            AUTH_SECRET.encode(),
            f"{extension_id}:{timestamp}".encode(),
            hashlib.sha256
        ).hexdigest()[:32]

        if not hmac.compare_digest(signature, expected):
            return None

        return {"extension_id": extension_id, "timestamp": timestamp}
    except (ValueError, IndexError):
        return None


def generate_api_key(name: str, expires_at: Optional[int] = None) -> tuple[str, str]:
    """Generate an API key pair (key_id, api_key)."""
    key_id = f"key_{secrets.token_hex(8)}"
    random_part = secrets.token_hex(16)
    timestamp = int(time.time() * 1000)
    message = f"{random_part}:{timestamp}:{name}"
    signature = hmac.new(
        AUTH_SECRET.encode(),
        message.encode(),
        hashlib.sha256
    ).hexdigest()[:32]
    api_key = f"gapi_{random_part}_{signature}"
    return key_id, api_key


def hash_api_key(api_key: str) -> str:
    """Hash an API key for storage."""
    return hashlib.sha256(api_key.encode()).hexdigest()


def validate_api_key(api_key: str, store) -> Optional[dict]:
    """Validate an API key against the database."""
    if not api_key or not api_key.startswith("gapi_"):
        return None

    try:
        api_key_hash = hash_api_key(api_key)
        key_record = store.get_api_key_by_hash(api_key_hash)
        if not key_record:
            return None

        if not key_record.get("is_active", 0):
            return None

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


def create_verify_auth(store):
    """Create a verify_auth dependency with access to the store."""
    async def verify_auth(
        credentials: Optional[HTTPAuthorizationCredentials] = Depends(security)
    ):
        if not credentials:
            if DEV_MODE:
                logger.debug("Dev mode: allowing unauthenticated access")
                return {"type": "dev", "extension_id": "dev"}
            raise HTTPException(status_code=401, detail="Authentication required")

        token = credentials.credentials

        # API Key (gapi_ prefix)
        if token.startswith("gapi_"):
            validation = validate_api_key(token, store)
            if validation:
                return {"type": "api_key", **validation}
            raise HTTPException(status_code=401, detail="Invalid or expired API key")

        # Token (ext_ prefix)
        validation = validate_token(token)
        if validation:
            return {"type": "token", **validation}

        raise HTTPException(status_code=401, detail="Invalid or expired token")

    return verify_auth
