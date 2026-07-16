from datetime import UTC, datetime
from typing import Literal

from fastapi import APIRouter
from pydantic import BaseModel


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
async def readiness() -> HealthResponse:
    # Storage, queue, and model-registry checks are added with the stages that
    # consume them. Liveness and readiness stay separate contracts from day one.
    return HealthResponse(
        service="voiceverse-ai-service",
        status="ok",
        timestamp=datetime.now(UTC),
    )
