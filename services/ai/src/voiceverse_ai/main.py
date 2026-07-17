from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import structlog
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response
from prometheus_client import CONTENT_TYPE_LATEST, generate_latest

from voiceverse_ai.api.health import router as health_router
from voiceverse_ai.api.media import router as media_router
from voiceverse_ai.api.speech import router as speech_router
from voiceverse_ai.api.translation import router as translation_router
from voiceverse_ai.core.config import Settings, get_settings
from voiceverse_ai.core.logging import configure_logging
from voiceverse_ai.core.middleware import (
    InternalSpeechRequestGuardMiddleware,
    RequestContextMiddleware,
)
from voiceverse_ai.core.telemetry import configure_telemetry
from voiceverse_ai.media.errors import MediaExecutionError
from voiceverse_ai.media.service import MediaPreparationExecutor, MediaPreparationService
from voiceverse_ai.media.storage import ObjectStore, S3ObjectStore
from voiceverse_ai.media.tools import MediaToolchain
from voiceverse_ai.speech.providers import (
    SpeakerDiarizationProvider,
    TranscriptionProvider,
    VocalSeparationProvider,
)
from voiceverse_ai.speech.service import SpeechAudioProbe, SpeechExecutionService
from voiceverse_ai.translation.providers import (
    DeterministicTranslationProvider,
    TranslationProvider,
)
from voiceverse_ai.translation.service import TranslationExecutionService


def create_app(
    settings: Settings | None = None,
    *,
    media_preparation_executor: MediaPreparationExecutor | None = None,
    media_toolchain: MediaToolchain | None = None,
    vocal_separation_provider: VocalSeparationProvider | None = None,
    transcription_provider: TranscriptionProvider | None = None,
    diarization_provider: SpeakerDiarizationProvider | None = None,
    speech_object_store: ObjectStore | None = None,
    speech_audio_probe: SpeechAudioProbe | None = None,
    translation_provider: TranslationProvider | None = None,
) -> FastAPI:
    resolved_settings = settings or get_settings()
    if (
        isinstance(translation_provider, DeterministicTranslationProvider)
        and resolved_settings.environment != "test"
    ):
        raise ValueError("DeterministicTranslationProvider is allowed only in tests")
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
    resolved_toolchain = media_toolchain or MediaToolchain(resolved_settings)
    resolved_object_store = speech_object_store or S3ObjectStore(resolved_settings)
    resolved_executor = media_preparation_executor or MediaPreparationService(
        settings=resolved_settings,
        storage=resolved_object_store,
        toolchain=resolved_toolchain,
    )
    speech_execution_service = SpeechExecutionService(
        settings=resolved_settings,
        storage=resolved_object_store,
        audio_probe=speech_audio_probe or resolved_toolchain,
        vocal_separation_provider=vocal_separation_provider,
        transcription_provider=transcription_provider,
        diarization_provider=diarization_provider,
    )
    resolved_translation_provider = translation_provider
    if (
        resolved_translation_provider is None
        and resolved_settings.translation_provider == "deterministic"
    ):
        resolved_translation_provider = DeterministicTranslationProvider(
            model_id=resolved_settings.translation_model_id,
            model_revision=resolved_settings.translation_model_revision,
            runtime_version=resolved_settings.translation_runtime_version,
        )
    translation_execution_service = TranslationExecutionService(
        settings=resolved_settings,
        provider=resolved_translation_provider,
    )
    application.state.settings = resolved_settings
    application.state.media_toolchain = resolved_toolchain
    application.state.media_preparation_executor = resolved_executor
    application.state.object_store = resolved_object_store
    application.state.speech_execution_service = speech_execution_service
    application.state.translation_execution_service = translation_execution_service
    application.add_middleware(
        InternalSpeechRequestGuardMiddleware,
        settings=resolved_settings,
    )
    # Request context is added last so it remains the outermost middleware and
    # correlation IDs cover requests rejected by the internal execution guard.
    application.add_middleware(RequestContextMiddleware)
    application.include_router(health_router)
    application.include_router(media_router)
    application.include_router(speech_router)
    application.include_router(translation_router)

    @application.get("/metrics", include_in_schema=False)
    async def metrics() -> Response:
        return Response(
            content=generate_latest(),
            media_type=CONTENT_TYPE_LATEST,
            headers={"Cache-Control": "no-store"},
        )

    @application.exception_handler(MediaExecutionError)
    async def media_execution_error_handler(
        _request: Request, error: MediaExecutionError
    ) -> JSONResponse:
        return JSONResponse(
            status_code=error.status_code,
            content={"error": {"code": error.code, "message": error.message}},
            headers={"Cache-Control": "no-store"},
        )

    @application.exception_handler(RequestValidationError)
    async def request_validation_error_handler(
        _request: Request, _error: RequestValidationError
    ) -> JSONResponse:
        return JSONResponse(
            status_code=422,
            content={
                "error": {
                    "code": "INVALID_REQUEST",
                    "message": "Request validation failed.",
                }
            },
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
