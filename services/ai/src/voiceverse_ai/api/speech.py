import hmac
from typing import Annotated, Any, cast

from fastapi import APIRouter, Request, Security
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from voiceverse_ai.core.config import Settings
from voiceverse_ai.media.errors import media_error
from voiceverse_ai.media.models import ErrorResponse
from voiceverse_ai.speech.errors import speech_error
from voiceverse_ai.speech.models import (
    SpeakerDiarizationRequest,
    SpeakerDiarizationResponse,
    SpeechCapability,
    SpeechCapabilityReadinessResponse,
    TranscriptionRequest,
    TranscriptionResponse,
    VocalSeparationRequest,
    VocalSeparationResponse,
)
from voiceverse_ai.speech.service import SpeechExecutionService, enabled_speech_capabilities

router = APIRouter(prefix="/internal/v1", tags=["internal-speech"])
_bearer = HTTPBearer(auto_error=False)
_error_responses: dict[int | str, dict[str, Any]] = {
    401: {"model": ErrorResponse},
    403: {"model": ErrorResponse},
    409: {"model": ErrorResponse},
    413: {"model": ErrorResponse},
    422: {"model": ErrorResponse},
    429: {"model": ErrorResponse},
    500: {"model": ErrorResponse},
    502: {"model": ErrorResponse},
    503: {"model": ErrorResponse},
    504: {"model": ErrorResponse},
    507: {"model": ErrorResponse},
}
BearerCredentials = Annotated[HTTPAuthorizationCredentials | None, Security(_bearer)]


def authorize_internal_request(
    settings: Settings,
    credentials: HTTPAuthorizationCredentials | None,
) -> None:
    configured = settings.internal_api_token
    if configured is None:
        raise media_error(
            "INTERNAL_AUTH_NOT_CONFIGURED",
            "Internal authentication is not configured.",
            503,
        )
    if (
        credentials is None
        or credentials.scheme.lower() != "bearer"
        or not hmac.compare_digest(
            credentials.credentials.encode("utf-8"),
            configured.get_secret_value().encode("utf-8"),
        )
    ):
        raise media_error(
            "AUTHENTICATION_REQUIRED",
            "Valid internal authentication is required.",
            401,
        )


def _authorize_request(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None,
    bucket: str,
    capability: SpeechCapability,
) -> SpeechExecutionService:
    settings: Settings = request.app.state.settings
    authorize_internal_request(settings, credentials)
    if settings.s3_bucket is None:
        raise media_error(
            "STORAGE_SCOPE_NOT_CONFIGURED",
            "Internal storage scope is not configured.",
            503,
        )
    if not hmac.compare_digest(bucket, settings.s3_bucket):
        raise media_error(
            "STORAGE_SCOPE_FORBIDDEN",
            "Requested storage scope is not permitted.",
            403,
        )
    if capability not in enabled_speech_capabilities(settings):
        raise speech_error(
            "SPEECH_CAPABILITY_DISABLED",
            "The requested speech capability is disabled.",
            503,
        )
    return cast("SpeechExecutionService", request.app.state.speech_execution_service)


@router.get(
    "/speech-capabilities/{capability}",
    response_model=SpeechCapabilityReadinessResponse,
    responses=_error_responses,
)
async def speech_capability_readiness(
    capability: SpeechCapability,
    request: Request,
    credentials: BearerCredentials,
) -> SpeechCapabilityReadinessResponse:
    """Authenticated deployment handshake used by the control-plane worker."""
    settings: Settings = request.app.state.settings
    authorize_internal_request(settings, credentials)
    if capability not in enabled_speech_capabilities(settings):
        raise speech_error(
            "SPEECH_CAPABILITY_DISABLED",
            "The requested speech capability is disabled.",
            503,
        )
    service: SpeechExecutionService = request.app.state.speech_execution_service
    return SpeechCapabilityReadinessResponse(
        capability=capability,
        model=service.capability_descriptor(capability),
    )


@router.post(
    "/vocal-separations",
    response_model=VocalSeparationResponse,
    responses=_error_responses,
)
async def separate_vocals(
    payload: VocalSeparationRequest,
    request: Request,
    credentials: BearerCredentials,
) -> VocalSeparationResponse:
    service = _authorize_request(
        request,
        credentials,
        payload.bucket,
        SpeechCapability.VOCAL_SEPARATION,
    )
    return await service.separate(payload)


@router.post(
    "/transcriptions",
    response_model=TranscriptionResponse,
    responses=_error_responses,
)
async def transcribe(
    payload: TranscriptionRequest,
    request: Request,
    credentials: BearerCredentials,
) -> TranscriptionResponse:
    service = _authorize_request(
        request,
        credentials,
        payload.bucket,
        SpeechCapability.TRANSCRIPTION,
    )
    return await service.transcribe(payload)


@router.post(
    "/speaker-diarizations",
    response_model=SpeakerDiarizationResponse,
    responses=_error_responses,
)
async def diarize_speakers(
    payload: SpeakerDiarizationRequest,
    request: Request,
    credentials: BearerCredentials,
) -> SpeakerDiarizationResponse:
    service = _authorize_request(
        request,
        credentials,
        payload.bucket,
        SpeechCapability.SPEAKER_DIARIZATION,
    )
    return await service.diarize(payload)
