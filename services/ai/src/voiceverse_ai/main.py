from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import structlog
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response
from prometheus_client import CONTENT_TYPE_LATEST, generate_latest

from voiceverse_ai.api.health import router as health_router
from voiceverse_ai.core.config import Settings, get_settings
from voiceverse_ai.core.logging import configure_logging
from voiceverse_ai.core.middleware import RequestContextMiddleware
from voiceverse_ai.core.telemetry import configure_telemetry


def create_app(settings: Settings | None = None) -> FastAPI:
    resolved_settings = settings or get_settings()
    configure_logging(resolved_settings.log_level)

    @asynccontextmanager
    async def lifespan(application: FastAPI) -> AsyncIterator[None]:
        shutdown_telemetry = configure_telemetry(application, resolved_settings)
        yield
        shutdown_telemetry()

    application = FastAPI(
        title="VoiceVerse AI Execution Plane",
        description="Internal AI and media execution APIs for VoiceVerse AI.",
        version=resolved_settings.app_version,
        lifespan=lifespan,
    )
    application.add_middleware(RequestContextMiddleware)
    application.include_router(health_router)

    @application.get("/metrics", include_in_schema=False)
    async def metrics() -> Response:
        return Response(
            content=generate_latest(),
            media_type=CONTENT_TYPE_LATEST,
            headers={"Cache-Control": "no-store"},
        )

    @application.exception_handler(Exception)
    async def unhandled_exception_handler(_request: Request, error: Exception) -> JSONResponse:
        structlog.get_logger("voiceverse_ai.errors").exception(
            "unhandled_exception",
            error_type=type(error).__name__,
        )
        return JSONResponse(
            status_code=500,
            content={"detail": "An unexpected internal error occurred."},
        )

    return application


app = create_app()
