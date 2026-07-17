import hmac
from typing import Annotated, Any

import structlog
from fastapi import APIRouter, Request, Security
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from voiceverse_ai.core.config import Settings
from voiceverse_ai.media.errors import media_error
from voiceverse_ai.media.models import (
    ErrorResponse,
    MediaPreparationRequest,
    MediaPreparationResponse,
)
from voiceverse_ai.media.service import MediaPreparationExecutor

router = APIRouter(prefix="/internal/v1", tags=["internal-media"])
_bearer = HTTPBearer(auto_error=False)
_error_responses: dict[int | str, dict[str, Any]] = {
    401: {"model": ErrorResponse},
    403: {"model": ErrorResponse},
    404: {"model": ErrorResponse},
    409: {"model": ErrorResponse},
    413: {"model": ErrorResponse},
    422: {"model": ErrorResponse},
    500: {"model": ErrorResponse},
    502: {"model": ErrorResponse},
    503: {"model": ErrorResponse},
    504: {"model": ErrorResponse},
    507: {"model": ErrorResponse},
}


def _authorize(
    settings: Settings,
    credentials: HTTPAuthorizationCredentials | None,
) -> None:
    configured = settings.internal_api_token
    if configured is None:
        raise media_error(
            "INTERNAL_AUTH_NOT_CONFIGURED", "Internal authentication is not configured.", 503
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
            "AUTHENTICATION_REQUIRED", "Valid internal authentication is required.", 401
        )


BearerCredentials = Annotated[HTTPAuthorizationCredentials | None, Security(_bearer)]


@router.post(
    "/media-preparations",
    response_model=MediaPreparationResponse,
    responses=_error_responses,
)
async def prepare_media(
    payload: MediaPreparationRequest,
    request: Request,
    credentials: BearerCredentials,
) -> MediaPreparationResponse:
    settings: Settings = request.app.state.settings
    _authorize(settings, credentials)
    if settings.s3_bucket is None:
        raise media_error(
            "STORAGE_SCOPE_NOT_CONFIGURED",
            "Internal storage scope is not configured.",
            503,
        )
    if not hmac.compare_digest(payload.bucket, settings.s3_bucket):
        raise media_error(
            "STORAGE_SCOPE_FORBIDDEN",
            "Requested storage scope is not permitted.",
            403,
        )
    executor: MediaPreparationExecutor = request.app.state.media_preparation_executor
    structlog.get_logger("voiceverse_ai.media_api").info(
        "media_preparation_requested",
        execution_id=str(payload.execution_id),
        attempt_id=str(payload.attempt_id),
    )
    return await executor.prepare(payload)
