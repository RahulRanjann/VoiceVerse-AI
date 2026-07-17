from typing import Any

from fastapi import APIRouter, Request

from voiceverse_ai.api.speech import BearerCredentials, authorize_internal_request
from voiceverse_ai.core.config import Settings
from voiceverse_ai.media.models import ErrorResponse
from voiceverse_ai.translation.errors import translation_error
from voiceverse_ai.translation.models import (
    TranslationCapabilityReadinessResponse,
    TranslationRequest,
    TranslationResponse,
)
from voiceverse_ai.translation.service import TranslationExecutionService

router = APIRouter(prefix="/internal/v1", tags=["internal-translation"])
_error_responses: dict[int | str, dict[str, Any]] = {
    401: {"model": ErrorResponse},
    409: {"model": ErrorResponse},
    413: {"model": ErrorResponse},
    422: {"model": ErrorResponse},
    429: {"model": ErrorResponse},
    500: {"model": ErrorResponse},
    502: {"model": ErrorResponse},
    503: {"model": ErrorResponse},
    504: {"model": ErrorResponse},
}


@router.get(
    "/translation-capability",
    response_model=TranslationCapabilityReadinessResponse,
    responses=_error_responses,
)
async def translation_capability_readiness(
    request: Request,
    credentials: BearerCredentials,
) -> TranslationCapabilityReadinessResponse:
    settings: Settings = request.app.state.settings
    authorize_internal_request(settings, credentials)
    if not settings.translation_enabled:
        raise translation_error(
            "TRANSLATION_CAPABILITY_DISABLED",
            "Scene translation is disabled.",
            503,
        )
    service: TranslationExecutionService = request.app.state.translation_execution_service
    return TranslationCapabilityReadinessResponse(model=service.capability_descriptor())


@router.post(
    "/translations",
    response_model=TranslationResponse,
    responses=_error_responses,
)
async def translate_scene(
    payload: TranslationRequest,
    request: Request,
    credentials: BearerCredentials,
) -> TranslationResponse:
    settings: Settings = request.app.state.settings
    authorize_internal_request(settings, credentials)
    if not settings.translation_enabled:
        raise translation_error(
            "TRANSLATION_CAPABILITY_DISABLED",
            "Scene translation is disabled.",
            503,
        )
    service: TranslationExecutionService = request.app.state.translation_execution_service
    return await service.translate(payload)
