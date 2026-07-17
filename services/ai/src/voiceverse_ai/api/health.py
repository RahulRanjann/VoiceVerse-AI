from datetime import UTC, datetime
from typing import Literal

from fastapi import APIRouter, Request
from pydantic import BaseModel

from voiceverse_ai.core.config import Settings
from voiceverse_ai.media.errors import media_error
from voiceverse_ai.media.storage import ObjectStore
from voiceverse_ai.media.tools import MediaToolchain
from voiceverse_ai.speech.errors import speech_error
from voiceverse_ai.speech.service import SpeechExecutionService, enabled_speech_capabilities
from voiceverse_ai.translation.errors import translation_error
from voiceverse_ai.translation.service import TranslationExecutionService


class HealthResponse(BaseModel):
    service: str
    status: Literal["ok"]
    timestamp: datetime


router = APIRouter(prefix="/health", tags=["health"])


@router.get("/live", response_model=HealthResponse)
async def liveness() -> HealthResponse:
    return HealthResponse(
        service="voiceverse-ai-service",
        status="ok",
        timestamp=datetime.now(UTC),
    )


@router.get("/ready", response_model=HealthResponse)
async def readiness(request: Request) -> HealthResponse:
    toolchain: MediaToolchain = request.app.state.media_toolchain
    if not toolchain.is_ready():
        raise media_error(
            "MEDIA_TOOL_UNAVAILABLE", "The required media toolchain is unavailable.", 503
        )
    service: SpeechExecutionService = request.app.state.speech_execution_service
    settings: Settings = request.app.state.settings
    storage: ObjectStore = request.app.state.object_store
    if settings.s3_bucket is None or not await storage.is_ready(bucket=settings.s3_bucket):
        raise media_error(
            "STORAGE_UNAVAILABLE",
            "The configured object storage scope is unavailable.",
            503,
        )
    unavailable = [
        capability.value
        for capability in enabled_speech_capabilities(settings)
        if not service.is_ready(capability)
    ]
    if unavailable:
        raise speech_error(
            "SPEECH_PROVIDER_NOT_READY",
            "An enabled speech capability provider is not ready.",
            503,
        )
    translation_service: TranslationExecutionService = (
        request.app.state.translation_execution_service
    )
    if settings.translation_enabled and not translation_service.is_ready():
        raise translation_error(
            "TRANSLATION_PROVIDER_NOT_READY",
            "The enabled translation provider is not ready.",
            503,
        )
    return HealthResponse(
        service="voiceverse-ai-service",
        status="ok",
        timestamp=datetime.now(UTC),
    )
