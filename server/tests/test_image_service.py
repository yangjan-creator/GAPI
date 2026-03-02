"""Tests for image_service.py — 14 test cases (I-01 through I-14).

Coverage:
- validate_magic_bytes: JPEG, PNG, GIF, WebP detection, non-image rejection
- sanitize_filename: path traversal removal, special-char replacement, length truncation
- get_image_storage_path: date-based path generation, path traversal protection
- save_image_to_file: size limit, MIME allowlist, MIME mismatch handling
- decode_base64_image: data URL decoding to (bytes, mime_type, filename)
"""

import struct
from datetime import datetime
from pathlib import Path
from unittest.mock import patch

import pytest

from image_service import (
    decode_base64_image,
    get_image_storage_path,
    save_image_to_file,
    sanitize_filename,
    validate_magic_bytes,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_gif_bytes() -> bytes:
    """Return minimal valid GIF87a header bytes."""
    return b"GIF87a" + b"\x00" * 10


def _make_webp_bytes() -> bytes:
    """Return minimal valid WebP/RIFF header bytes."""
    # RIFF....WEBP
    size = struct.pack("<I", 4)
    return b"RIFF" + size + b"WEBP"


# ---------------------------------------------------------------------------
# validate_magic_bytes — I-01 through I-05
# ---------------------------------------------------------------------------

@pytest.mark.p0
def test_I01_validate_magic_bytes_jpeg(sample_jpg):
    """I-01: JPEG magic bytes \\xff\\xd8\\xff -> 'image/jpeg'."""
    result = validate_magic_bytes(sample_jpg)
    assert result == "image/jpeg"


@pytest.mark.p0
def test_I02_validate_magic_bytes_png(sample_png):
    """I-02: PNG magic bytes \\x89PNG -> 'image/png'."""
    result = validate_magic_bytes(sample_png)
    assert result == "image/png"


@pytest.mark.p0
def test_I03_validate_magic_bytes_gif():
    """I-03: GIF magic bytes GIF8 -> 'image/gif'."""
    gif_data = _make_gif_bytes()
    result = validate_magic_bytes(gif_data)
    assert result == "image/gif"


@pytest.mark.p0
def test_I04_validate_magic_bytes_webp():
    """I-04: WebP RIFF header -> 'image/webp'."""
    webp_data = _make_webp_bytes()
    result = validate_magic_bytes(webp_data)
    assert result == "image/webp"


@pytest.mark.p0
def test_I05_validate_magic_bytes_non_image_returns_none(fake_image):
    """I-05: Non-image bytes (HTML) -> None."""
    result = validate_magic_bytes(fake_image)
    assert result is None


# ---------------------------------------------------------------------------
# sanitize_filename — I-06 through I-08
# ---------------------------------------------------------------------------

@pytest.mark.p0
def test_I06_sanitize_filename_removes_path_components():
    """I-06: Path traversal components stripped, only basename kept."""
    result = sanitize_filename("../../etc/passwd")
    assert result == "passwd"
    assert "/" not in result
    assert ".." not in result


@pytest.mark.p1
def test_I07_sanitize_filename_replaces_special_chars():
    """I-07: Spaces and angle-bracket chars replaced with underscores."""
    result = sanitize_filename("a b<c>.png")
    assert result == "a_b_c_.png"


@pytest.mark.p1
def test_I08_sanitize_filename_truncates_to_max_length():
    """I-08: Filename longer than max_length is truncated to exactly max_length chars."""
    long_name = "a" * 200 + ".png"
    result = sanitize_filename(long_name, max_length=100)
    assert len(result) == 100
    assert result.endswith(".png")


# ---------------------------------------------------------------------------
# get_image_storage_path — I-09 through I-10
# ---------------------------------------------------------------------------

@pytest.mark.p0
def test_I09_get_image_storage_path_date_based(temp_images_dir):
    """I-09: Returned path includes year/month/day components under IMAGES_DIR."""
    now = datetime.now()
    expected_year = str(now.year)
    expected_month = f"{now.month:02d}"
    expected_day = f"{now.day:02d}"

    with patch("image_service.IMAGES_DIR", temp_images_dir):
        path = get_image_storage_path("photo.png")

    parts = path.parts
    assert expected_year in parts
    assert expected_month in parts
    assert expected_day in parts
    assert str(temp_images_dir) in str(path)


@pytest.mark.p0
def test_I10_get_image_storage_path_blocks_path_traversal(temp_images_dir):
    """I-10: Path traversal filename raises ValueError."""
    with patch("image_service.IMAGES_DIR", temp_images_dir):
        # sanitize_filename strips directory components, so we simulate a case
        # where the resolved path would escape IMAGES_DIR by patching the
        # sanitize_filename call to return a raw traversal string.
        with patch("image_service.sanitize_filename", return_value="../../../../../etc/passwd"):
            with pytest.raises(ValueError, match="Invalid file path"):
                get_image_storage_path("../../../../../etc/passwd")


# ---------------------------------------------------------------------------
# save_image_to_file — I-11 through I-13
# ---------------------------------------------------------------------------

@pytest.mark.p0
def test_I11_save_image_rejects_file_over_10mb(large_file, temp_images_dir):
    """I-11: File larger than MAX_UPLOAD_SIZE raises ValueError."""
    with patch("image_service.IMAGES_DIR", temp_images_dir):
        with pytest.raises(ValueError, match="Image too large"):
            save_image_to_file(large_file, "large.png", "image/png")


@pytest.mark.p0
def test_I12_save_image_rejects_unsupported_mime(sample_png, temp_images_dir):
    """I-12: Unsupported MIME type 'image/bmp' raises ValueError."""
    with patch("image_service.IMAGES_DIR", temp_images_dir):
        with pytest.raises(ValueError, match="Unsupported MIME type"):
            save_image_to_file(sample_png, "photo.bmp", "image/bmp")


@pytest.mark.p1
def test_I13_save_image_uses_detected_mime_on_mismatch(sample_png, temp_images_dir):
    """I-13: When declared MIME mismatches magic bytes, detected MIME is used in metadata."""
    # sample_png has PNG magic bytes; declare it as JPEG — service should use "image/png".
    with patch("image_service.IMAGES_DIR", temp_images_dir):
        metadata = save_image_to_file(sample_png, "photo.jpg", "image/jpeg")

    assert metadata["mime_type"] == "image/png"
    assert metadata["size"] == len(sample_png)
    assert Path(metadata["path"]).suffix == ".png"


# ---------------------------------------------------------------------------
# decode_base64_image — I-14
# ---------------------------------------------------------------------------

@pytest.mark.p0
def test_I14_decode_base64_image_returns_bytes_mime_filename(sample_png, sample_png_base64):
    """I-14: Data URL decodes to (image_bytes, mime_type, filename) triple."""
    image_data, mime_type, filename = decode_base64_image(sample_png_base64)

    assert isinstance(image_data, bytes)
    assert image_data == sample_png
    assert mime_type == "image/png"
    assert isinstance(filename, str)
    assert filename.endswith(".png")
    assert len(filename) > 0
