import re
import time
from collections.abc import Awaitable, Callable, MutableSequence
from typing import Any
from uuid import uuid4

import structlog
from prometheus_client import Counter, Histogram
from structlog.contextvars import bind_contextvars, clear_contextvars

Request = MutableSequence[tuple[bytes, bytes]]
ASGIApp = Callable[
    [
        dict[str, Any],
        Callable[[], Awaitable[dict[str, Any]]],
        Callable[[dict[str, Any]], Awaitable[None]],
    ],
    Awaitable[None],
]

REQUESTS = Counter(
    "voiceverse_ai_http_requests_total",
    "Total HTTP requests handled by the AI service.",
    ("method", "route", "status"),
)
REQUEST_DURATION = Histogram(
    "voiceverse_ai_http_request_duration_seconds",
    "AI service HTTP request duration in seconds.",
    ("method", "route"),
)

_REQUEST_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")


class RequestContextMiddleware:
    """Pure ASGI middleware for request correlation, metrics, and access logs."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app
        self.logger = structlog.get_logger("voiceverse_ai.http")

    async def __call__(
        self,
        scope: dict[str, Any],
        receive: Callable[[], Awaitable[dict[str, Any]]],
        send: Callable[[dict[str, Any]], Awaitable[None]],
    ) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        headers = dict(scope.get("headers", []))
        supplied_id = headers.get(b"x-request-id", b"").decode("ascii", errors="ignore")
        request_id = supplied_id if _REQUEST_ID_PATTERN.fullmatch(supplied_id) else str(uuid4())
        bind_contextvars(request_id=request_id)

        method = str(scope.get("method", "UNKNOWN"))
        started_at = time.perf_counter()
        status_code = 500

        async def send_with_context(message: dict[str, Any]) -> None:
            nonlocal status_code
            if message["type"] == "http.response.start":
                status_code = int(message["status"])
                response_headers: Request = message.setdefault("headers", [])
                response_headers.append((b"x-request-id", request_id.encode("ascii")))
            await send(message)

        try:
            await self.app(scope, receive, send_with_context)
        finally:
            route = getattr(scope.get("route"), "path", "unmatched")
            duration = time.perf_counter() - started_at
            REQUESTS.labels(method=method, route=route, status=str(status_code)).inc()
            REQUEST_DURATION.labels(method=method, route=route).observe(duration)
            self.logger.info(
                "request_complete",
                method=method,
                route=route,
                status_code=status_code,
                duration_ms=round(duration * 1_000, 2),
            )
            clear_contextvars()
