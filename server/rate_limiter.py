"""GAPI Rate Limiter

Simple in-memory sliding window rate limiter per IP/key.
"""

import os
import time
import logging
from collections import defaultdict
from fastapi import Request, HTTPException

logger = logging.getLogger("gapi.ratelimit")

DEFAULT_RATE_LIMIT = int(os.environ.get("GAPI_RATE_LIMIT", "60"))  # per minute


class RateLimiter:
    """In-memory sliding window rate limiter."""

    def __init__(self):
        self._requests: dict[str, list[float]] = defaultdict(list)

    def _cleanup(self, key: str, window: float):
        """Remove expired entries."""
        cutoff = time.time() - window
        self._requests[key] = [t for t in self._requests[key] if t > cutoff]

    def check(self, key: str, limit: int, window: float = 60.0) -> bool:
        """Check if request is allowed. Returns True if allowed."""
        self._cleanup(key, window)
        if len(self._requests[key]) >= limit:
            return False
        self._requests[key].append(time.time())
        return True

    def remaining(self, key: str, limit: int, window: float = 60.0) -> int:
        """Get remaining requests in the current window."""
        self._cleanup(key, window)
        return max(0, limit - len(self._requests[key]))

    def reset_time(self, key: str, window: float = 60.0) -> int:
        """Get the reset time (unix timestamp) for the current window."""
        if self._requests[key]:
            return int(self._requests[key][0] + window)
        return int(time.time() + window)


# Global instance
rate_limiter = RateLimiter()


def get_client_key(request: Request) -> str:
    """Extract a rate limit key from the request (IP or auth token)."""
    # Use forwarded IP if behind proxy
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    if request.client:
        return request.client.host
    return "unknown"


def check_rate_limit(
    request: Request,
    limit: int = DEFAULT_RATE_LIMIT,
    window: float = 60.0
):
    """FastAPI dependency for rate limiting."""
    key = get_client_key(request)
    if not rate_limiter.check(key, limit, window):
        remaining = rate_limiter.remaining(key, limit, window)
        reset = rate_limiter.reset_time(key, window)
        raise HTTPException(
            status_code=429,
            detail="Too many requests",
            headers={
                "X-RateLimit-Limit": str(limit),
                "X-RateLimit-Remaining": str(remaining),
                "X-RateLimit-Reset": str(reset),
                "Retry-After": str(int(window)),
            }
        )


def rate_limit_auth(request: Request):
    """Rate limit for auth endpoints: 10 req/min."""
    check_rate_limit(request, limit=10)


def rate_limit_upload(request: Request):
    """Rate limit for upload endpoints: 10 req/min."""
    key = f"upload:{get_client_key(request)}"
    if not rate_limiter.check(key, 10):
        raise HTTPException(status_code=429, detail="Too many upload requests")


def rate_limit_default(request: Request):
    """Rate limit for general endpoints: 60 req/min."""
    check_rate_limit(request, limit=DEFAULT_RATE_LIMIT)
