"""GAPI Image Service Module

Handles image storage, validation, base64 decoding, and path management.
"""

import os
import re
import base64
import uuid
import time
import logging
from pathlib import Path
from typing import Dict, Optional
from datetime import datetime

logger = logging.getLogger("gapi.image")

# Configuration from environment
MAX_UPLOAD_SIZE = int(os.environ.get("GAPI_MAX_UPLOAD_SIZE", str(10 * 1024 * 1024)))  # 10MB default
IMAGES_DIR = Path(os.environ.get(
    "GAPI_IMAGE_DIR",
    os.path.join(os.path.dirname(__file__), "images")
))
IMAGES_DIR.mkdir(exist_ok=True)

# Allowed MIME types
ALLOWED_MIME_TYPES = {"image/jpeg", "image/png", "image/gif", "image/webp"}

# MIME to extension mapping
MIME_TO_EXT = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
}

EXT_TO_MIME = {
    "png": "image/png",
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "gif": "image/gif",
    "webp": "image/webp",
}

# Magic bytes for file type validation
MAGIC_BYTES = {
    b"\xff\xd8\xff": "image/jpeg",
    b"\x89PNG": "image/png",
    b"GIF8": "image/gif",
    b"RIFF": "image/webp",  # WebP starts with RIFF
}


def validate_magic_bytes(data: bytes) -> Optional[str]:
    """Validate image data by checking magic bytes. Returns detected MIME type or None."""
    for magic, mime in MAGIC_BYTES.items():
        if data[:len(magic)] == magic:
            return mime
    return None


def sanitize_filename(filename: str, max_length: int = 100) -> str:
    """Sanitize a filename to prevent path traversal and special characters."""
    # Remove directory components
    filename = os.path.basename(filename)
    # Replace unsafe characters
    filename = re.sub(r'[^\w\-.]', '_', filename)
    # Limit length
    if len(filename) > max_length:
        name, ext = os.path.splitext(filename)
        filename = name[:max_length - len(ext)] + ext
    return filename


def get_image_storage_path(filename: str) -> Path:
    """Generate a date-based storage path for an image, with path traversal protection."""
    safe_filename = sanitize_filename(filename)
    now = datetime.now()
    date_path = IMAGES_DIR / str(now.year) / f"{now.month:02d}" / f"{now.day:02d}"
    date_path.mkdir(parents=True, exist_ok=True)
    full_path = (date_path / safe_filename).resolve()

    # Path traversal protection
    if not str(full_path).startswith(str(IMAGES_DIR.resolve())):
        raise ValueError("Invalid file path")

    return full_path


def save_image_to_file(image_data: bytes, filename: str, mime_type: str = "image/png") -> Dict:
    """Save image data to the filesystem and return metadata."""
    # Validate size
    if len(image_data) > MAX_UPLOAD_SIZE:
        raise ValueError(f"Image too large: {len(image_data)} bytes (max {MAX_UPLOAD_SIZE})")

    # Validate MIME type
    if mime_type not in ALLOWED_MIME_TYPES:
        raise ValueError(f"Unsupported MIME type: {mime_type}")

    # Validate magic bytes
    detected_mime = validate_magic_bytes(image_data)
    if detected_mime is None:
        raise ValueError("File content does not match a supported image format")
    if detected_mime != mime_type:
        logger.warning("MIME type mismatch: declared=%s detected=%s, using detected", mime_type, detected_mime)
        mime_type = detected_mime

    # Generate unique ID and filename
    image_id = f"img_{int(time.time() * 1000)}_{uuid.uuid4().hex[:8]}"
    ext = MIME_TO_EXT.get(mime_type, ".png")
    safe_filename = f"{image_id}{ext}"
    file_path = get_image_storage_path(safe_filename)

    with open(file_path, "wb") as f:
        f.write(image_data)

    relative_path = file_path.relative_to(IMAGES_DIR)
    url = f"/v1/images/{relative_path}"

    return {
        "image_id": image_id,
        "url": url,
        "path": str(file_path),
        "filename": sanitize_filename(filename),
        "mime_type": mime_type,
        "size": len(image_data),
        "created_at": int(time.time() * 1000),
    }


def decode_base64_image(data_url: str) -> tuple[bytes, str, str]:
    """Decode a base64 data URL into (image_data, mime_type, filename)."""
    if not data_url.startswith("data:"):
        raise ValueError("Invalid data URL format")

    parts = data_url.split(",", 1)
    if len(parts) != 2:
        raise ValueError("Invalid data URL format")

    header, base64_data = parts

    # Extract MIME type
    mime_type = "image/png"
    if ":" in header:
        mime_part = header.split(":")[1].split(";")[0]
        if mime_part in ALLOWED_MIME_TYPES:
            mime_type = mime_part

    try:
        image_data = base64.b64decode(base64_data)
    except Exception as e:
        raise ValueError(f"Failed to decode base64: {e}")

    ext = MIME_TO_EXT.get(mime_type, ".png").lstrip(".")
    filename = f"upload_{int(time.time() * 1000)}.{ext}"

    return image_data, mime_type, filename


def resolve_image_path(image_id: str, image_info: Optional[dict] = None) -> Optional[Path]:
    """Resolve an image ID or path to a filesystem path, with traversal protection."""
    if image_info:
        file_path = Path(image_info["path"]).resolve()
    else:
        file_path = (IMAGES_DIR / image_id).resolve()

    # Path traversal protection
    if not str(file_path).startswith(str(IMAGES_DIR.resolve())):
        return None

    if not file_path.exists():
        return None

    return file_path
