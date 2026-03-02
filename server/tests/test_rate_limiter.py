"""Tests for rate_limiter.py

Test IDs:
    R-01: RateLimiter.check() allows requests within limit -> True
    R-02: RateLimiter.check() rejects requests over limit -> False
    R-03: RateLimiter.check() resets after window slides
    R-04: RateLimiter.remaining() correctly calculates remaining = limit - count
    R-05: RateLimiter.reset_time() returns first_request_time + window
    R-06: Different keys are independent
    R-07: get_client_key() prefers X-Forwarded-For header
    R-08: check_rate_limit() raises HTTPException 429 with rate limit headers
"""

import time
from unittest.mock import MagicMock

import pytest
from fastapi import HTTPException

from rate_limiter import RateLimiter, check_rate_limit, get_client_key


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _fresh_limiter() -> RateLimiter:
    """Return a new RateLimiter instance isolated from the global one."""
    return RateLimiter()


def _mock_request(
    forwarded_for: str | None = None,
    client_host: str | None = None,
) -> MagicMock:
    """Build a minimal mock of fastapi.Request."""
    request = MagicMock()
    headers: dict[str, str] = {}
    if forwarded_for is not None:
        headers["x-forwarded-for"] = forwarded_for
    request.headers.get = lambda key, default=None: headers.get(key, default)
    if client_host is not None:
        request.client = MagicMock()
        request.client.host = client_host
    else:
        request.client = None
    return request


# ---------------------------------------------------------------------------
# R-01: allows within limit
# ---------------------------------------------------------------------------

@pytest.mark.p0
def test_r01_check_allows_within_limit():
    """R-01: check() returns True for every request up to and including limit."""
    limiter = _fresh_limiter()
    limit = 3
    key = "r01_key"

    results = [limiter.check(key, limit, window=60.0) for _ in range(limit)]

    assert all(results), (
        f"Expected all {limit} requests to be allowed, got: {results}"
    )


# ---------------------------------------------------------------------------
# R-02: rejects over limit
# ---------------------------------------------------------------------------

@pytest.mark.p0
def test_r02_check_rejects_over_limit():
    """R-02: check() returns False once the limit is exhausted."""
    limiter = _fresh_limiter()
    limit = 3
    key = "r02_key"

    # Exhaust the limit
    for _ in range(limit):
        limiter.check(key, limit, window=60.0)

    result = limiter.check(key, limit, window=60.0)

    assert result is False, "Expected False when limit is exceeded"


# ---------------------------------------------------------------------------
# R-03: resets after window slides
# ---------------------------------------------------------------------------

@pytest.mark.p1
def test_r03_check_resets_after_window_slides():
    """R-03: check() allows again after the sliding window expires.

    Uses a 0.1-second window and sleeps 0.15 seconds so the test stays fast.
    """
    limiter = _fresh_limiter()
    limit = 2
    window = 0.1  # seconds
    key = "r03_key"

    # Exhaust the limit inside the first window
    for _ in range(limit):
        limiter.check(key, limit, window=window)

    # Confirm the limit is hit
    assert limiter.check(key, limit, window=window) is False, (
        "Should be rate-limited before window expires"
    )

    # Wait for the window to slide past all recorded timestamps
    time.sleep(0.15)

    # After the window has passed, a new request should be allowed
    result = limiter.check(key, limit, window=window)
    assert result is True, "Expected True after the sliding window expired"


# ---------------------------------------------------------------------------
# R-04: remaining() returns limit - count
# ---------------------------------------------------------------------------

@pytest.mark.p0
def test_r04_remaining_returns_limit_minus_count():
    """R-04: remaining() correctly reflects consumed slots."""
    limiter = _fresh_limiter()
    limit = 5
    key = "r04_key"

    assert limiter.remaining(key, limit, window=60.0) == 5

    limiter.check(key, limit, window=60.0)
    assert limiter.remaining(key, limit, window=60.0) == 4

    limiter.check(key, limit, window=60.0)
    limiter.check(key, limit, window=60.0)
    assert limiter.remaining(key, limit, window=60.0) == 2


# ---------------------------------------------------------------------------
# R-05: reset_time() returns first_request_time + window
# ---------------------------------------------------------------------------

@pytest.mark.p0
def test_r05_reset_time_returns_first_request_plus_window():
    """R-05: reset_time() equals the timestamp of the first request + window."""
    limiter = _fresh_limiter()
    limit = 10
    window = 60.0
    key = "r05_key"

    before = time.time()
    limiter.check(key, limit, window=window)
    after = time.time()

    reset = limiter.reset_time(key, window=window)

    expected_low = int(before + window)
    expected_high = int(after + window)

    assert expected_low <= reset <= expected_high, (
        f"reset_time() {reset} not in expected range [{expected_low}, {expected_high}]"
    )


# ---------------------------------------------------------------------------
# R-06: different keys are independent
# ---------------------------------------------------------------------------

@pytest.mark.p0
def test_r06_different_keys_are_independent():
    """R-06: Exhausting ip_a's limit has no effect on ip_b."""
    limiter = _fresh_limiter()
    limit = 2
    key_a = "ip_a"
    key_b = "ip_b"

    # Exhaust ip_a
    for _ in range(limit):
        limiter.check(key_a, limit, window=60.0)
    assert limiter.check(key_a, limit, window=60.0) is False, (
        "ip_a should be rate-limited"
    )

    # ip_b should still have its full quota
    assert limiter.remaining(key_b, limit, window=60.0) == limit, (
        "ip_b remaining count should be unaffected by ip_a"
    )
    assert limiter.check(key_b, limit, window=60.0) is True, (
        "ip_b should be allowed independently of ip_a"
    )


# ---------------------------------------------------------------------------
# R-07: get_client_key() prefers X-Forwarded-For
# ---------------------------------------------------------------------------

@pytest.mark.p1
def test_r07_get_client_key_prefers_x_forwarded_for():
    """R-07: X-Forwarded-For is used when present, ignoring client.host."""
    request = _mock_request(
        forwarded_for="203.0.113.5, 10.0.0.1",
        client_host="192.168.1.1",
    )

    key = get_client_key(request)

    assert key == "203.0.113.5", (
        f"Expected first IP from X-Forwarded-For, got: {key!r}"
    )


@pytest.mark.p1
def test_r07_get_client_key_falls_back_to_client_host():
    """R-07 (fallback): Falls back to client.host when X-Forwarded-For is absent."""
    request = _mock_request(client_host="10.1.2.3")

    key = get_client_key(request)

    assert key == "10.1.2.3", (
        f"Expected client.host as fallback, got: {key!r}"
    )


@pytest.mark.p1
def test_r07_get_client_key_returns_unknown_when_no_client():
    """R-07 (unknown): Returns 'unknown' when neither header nor client is present."""
    request = _mock_request()  # no forwarded_for, no client_host

    key = get_client_key(request)

    assert key == "unknown"


# ---------------------------------------------------------------------------
# R-08: check_rate_limit() raises HTTPException 429 with headers
# ---------------------------------------------------------------------------

@pytest.mark.p0
def test_r08_check_rate_limit_raises_429_with_headers(monkeypatch):
    """R-08: check_rate_limit() raises HTTPException(429) and includes rate limit headers."""
    from rate_limiter import rate_limiter as global_limiter

    limit = 2
    window = 60.0
    client_ip = "r08_test_ip"

    # Exhaust the global limiter for this key directly so check_rate_limit
    # will encounter an already-saturated window.
    for _ in range(limit):
        global_limiter.check(client_ip, limit, window=window)

    request = _mock_request(client_host=client_ip)

    with pytest.raises(HTTPException) as exc_info:
        check_rate_limit(request, limit=limit, window=window)

    exc = exc_info.value
    assert exc.status_code == 429, f"Expected 429, got {exc.status_code}"
    assert exc.detail == "Too many requests"

    headers = exc.headers
    assert headers is not None, "HTTPException should carry response headers"
    assert headers.get("X-RateLimit-Limit") == str(limit)
    assert headers.get("X-RateLimit-Remaining") == "0"
    assert "X-RateLimit-Reset" in headers, "X-RateLimit-Reset header must be present"
    assert headers.get("Retry-After") == str(int(window))
