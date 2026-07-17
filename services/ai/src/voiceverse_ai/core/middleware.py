import hmac
import re
import time
from collections.abc import MutableSequence
from uuid import uuid4

import structlog
from prometheus_client import Counter, Histogram
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send
from structlog.contextvars import bind_contextvars, clear_contextvars

from voiceverse_ai.core.config import Settings

Request = MutableSequence[tuple[bytes, bytes]]

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
_SPEECH_EXECUTION_PATHS = frozenset(
    {
        "/internal/v1/vocal-separations",
        "/internal/v1/transcriptions",
        "/internal/v1/speaker-diarizations",
    }
)
_SPEECH_CAPABILITY_PREFIX = "/internal/v1/speech-capabilities/"
_TRANSLATION_EXECUTION_PATH = "/internal/v1/translations"
_TRANSLATION_CAPABILITY_PATH = "/internal/v1/translation-capability"


class InternalSpeechRequestGuardMiddleware:
    """Authenticates speech and translation requests before reading bounded bodies.

    FastAPI resolves body models before endpoint dependencies. Keeping this guard
    at the ASGI boundary prevents an unauthenticated peer from making the process
    buffer or validate JSON and caps chunked bodies that have no Content-Length.
    Endpoint authorization remains in place as defense in depth.
    """

    def __init__(self, app: ASGIApp, *, settings: Settings) -> None:
        self.app = app
        self._token = (
            settings.internal_api_token.get_secret_value().encode("utf-8")
            if settings.internal_api_token is not None
            else None
        )
        self._speech_maximum_body_bytes = settings.speech_max_request_body_bytes
        self._translation_maximum_body_bytes = settings.translation_max_request_body_bytes

    async def __call__(
        self,
        scope: Scope,
        receive: Receive,
        send: Send,
    ) -> None:
        if scope["type"] != "http" or not self._is_guarded_route(scope):
            await self.app(scope, receive, send)
            return

        authentication_error = self._authentication_error(scope)
        if authentication_error is not None:
            status_code, code, message = authentication_error
            await self._send_error(scope, receive, send, status_code, code, message)
            return

        if self._requires_bounded_body(scope):
            maximum_body_bytes = self._maximum_body_bytes(scope)
            content_length_error = self._validate_content_length(scope, maximum_body_bytes)
            if content_length_error is not None:
                status_code, code, message = content_length_error
                await self._send_error(scope, receive, send, status_code, code, message)
                return

            body = await self._receive_bounded_body(receive, maximum_body_bytes)
            if body is None:
                code, message = self._request_too_large_error(scope)
                await self._send_error(
                    scope,
                    receive,
                    send,
                    413,
                    code,
                    message,
                )
                return

            delivered = False

            async def replay_body() -> Message:
                nonlocal delivered
                if delivered:
                    return {"type": "http.request", "body": b"", "more_body": False}
                delivered = True
                return {"type": "http.request", "body": body, "more_body": False}

            await self.app(scope, replay_body, send)
            return

        await self.app(scope, receive, send)

    @staticmethod
    def _is_guarded_route(scope: Scope) -> bool:
        path = str(scope.get("path", ""))
        return (
            path in _SPEECH_EXECUTION_PATHS
            or path.startswith(_SPEECH_CAPABILITY_PREFIX)
            or path in (_TRANSLATION_EXECUTION_PATH, _TRANSLATION_CAPABILITY_PATH)
        )

    @staticmethod
    def _requires_bounded_body(scope: Scope) -> bool:
        return str(scope.get("method", "")).upper() == "POST" and (
            str(scope.get("path", "")) in _SPEECH_EXECUTION_PATHS
            or str(scope.get("path", "")) == _TRANSLATION_EXECUTION_PATH
        )

    def _maximum_body_bytes(self, scope: Scope) -> int:
        if str(scope.get("path", "")) == _TRANSLATION_EXECUTION_PATH:
            return self._translation_maximum_body_bytes
        return self._speech_maximum_body_bytes

    @staticmethod
    def _request_too_large_error(scope: Scope) -> tuple[str, str]:
        if str(scope.get("path", "")) == _TRANSLATION_EXECUTION_PATH:
            return (
                "TRANSLATION_REQUEST_TOO_LARGE",
                "The translation request body exceeds the configured size limit.",
            )
        return (
            "SPEECH_REQUEST_TOO_LARGE",
            "The speech request body exceeds the configured size limit.",
        )

    def _authentication_error(self, scope: Scope) -> tuple[int, str, str] | None:
        if self._token is None:
            return (
                503,
                "INTERNAL_AUTH_NOT_CONFIGURED",
                "Internal authentication is not configured.",
            )
        authorization_headers = [
            value
            for name, value in scope.get("headers", [])
            if bytes(name).lower() == b"authorization"
        ]
        if len(authorization_headers) != 1:
            return (401, "AUTHENTICATION_REQUIRED", "Valid internal authentication is required.")
        scheme, separator, credential = bytes(authorization_headers[0]).partition(b" ")
        if (
            separator != b" "
            or scheme.lower() != b"bearer"
            or not credential
            or b" " in credential
            or not hmac.compare_digest(credential, self._token)
        ):
            return (401, "AUTHENTICATION_REQUIRED", "Valid internal authentication is required.")
        return None

    def _validate_content_length(
        self,
        scope: Scope,
        maximum_body_bytes: int,
    ) -> tuple[int, str, str] | None:
        values = [
            value
            for name, value in scope.get("headers", [])
            if bytes(name).lower() == b"content-length"
        ]
        if not values:
            return None
        if len(values) != 1:
            return (422, "INVALID_REQUEST", "Request validation failed.")
        try:
            length = int(bytes(values[0]).decode("ascii"))
        except (UnicodeDecodeError, ValueError):
            return (422, "INVALID_REQUEST", "Request validation failed.")
        if length < 0:
            return (422, "INVALID_REQUEST", "Request validation failed.")
        if length > maximum_body_bytes:
            code, message = self._request_too_large_error(scope)
            return (
                413,
                code,
                message,
            )
        return None

    @staticmethod
    async def _receive_bounded_body(
        receive: Receive,
        maximum_body_bytes: int,
    ) -> bytes | None:
        body = bytearray()
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return b""
            chunk = bytes(message.get("body", b""))
            if len(body) + len(chunk) > maximum_body_bytes:
                return None
            body.extend(chunk)
            if not message.get("more_body", False):
                return bytes(body)

    @staticmethod
    async def _send_error(
        scope: Scope,
        receive: Receive,
        send: Send,
        status_code: int,
        code: str,
        message: str,
    ) -> None:
        response = JSONResponse(
            status_code=status_code,
            content={"error": {"code": code, "message": message}},
            headers={"Cache-Control": "no-store"},
        )
        await response(scope, receive, send)


class RequestContextMiddleware:
    """Pure ASGI middleware for request correlation, metrics, and access logs."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app
        self.logger = structlog.get_logger("voiceverse_ai.http")

    async def __call__(
        self,
        scope: Scope,
        receive: Receive,
        send: Send,
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

        async def send_with_context(message: Message) -> None:
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
