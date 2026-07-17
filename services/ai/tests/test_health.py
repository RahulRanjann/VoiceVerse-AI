import sys
from collections.abc import AsyncIterator
from typing import cast

import pytest
from asgi_lifespan import LifespanManager
from httpx import ASGITransport, AsyncClient

from voiceverse_ai.core.config import Settings
from voiceverse_ai.main import create_app
from voiceverse_ai.media.storage import ObjectStore
from voiceverse_ai.media.tools import MediaToolchain


class ReadinessObjectStore:
    def __init__(self, *, ready: bool = True) -> None:
        self.ready = ready

    async def is_ready(self, *, bucket: str) -> bool:
        return self.ready and bucket == "voiceverse-test"


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


@pytest.fixture
async def client() -> AsyncIterator[AsyncClient]:
    settings = Settings(
        environment="test",
        ffmpeg_binary=sys.executable,
        ffprobe_binary=sys.executable,
        s3_bucket="voiceverse-test",
    )
    app = create_app(
        settings,
        media_toolchain=MediaToolchain(settings),
        speech_object_store=cast("ObjectStore", ReadinessObjectStore()),
    )
    async with LifespanManager(app) as manager:
        transport = ASGITransport(app=manager.app)
        async with AsyncClient(transport=transport, base_url="http://testserver") as test_client:
            yield test_client


@pytest.mark.anyio
async def test_liveness_contract_and_request_correlation(client: AsyncClient) -> None:
    response = await client.get("/health/live", headers={"x-request-id": "test-request-123"})

    assert response.status_code == 200
    assert response.headers["x-request-id"] == "test-request-123"
    assert response.json()["service"] == "voiceverse-ai-service"
    assert response.json()["status"] == "ok"


@pytest.mark.anyio
async def test_invalid_request_id_is_replaced(client: AsyncClient) -> None:
    response = await client.get("/health/live", headers={"x-request-id": "invalid id\n"})

    assert response.status_code == 200
    assert response.headers["x-request-id"] != "invalid id\n"


@pytest.mark.anyio
async def test_readiness_and_metrics_are_uncached(client: AsyncClient) -> None:
    readiness = await client.get("/health/ready")
    metrics = await client.get("/metrics")

    assert readiness.status_code == 200
    assert readiness.json()["status"] == "ok"
    assert metrics.status_code == 200
    assert metrics.headers["cache-control"] == "no-store"
    assert "voiceverse_ai_http_requests_total" in metrics.text


@pytest.mark.anyio
async def test_readiness_fails_when_media_toolchain_is_missing() -> None:
    settings = Settings(
        environment="test",
        ffmpeg_binary="voiceverse-missing-ffmpeg",
        ffprobe_binary="voiceverse-missing-ffprobe",
        s3_bucket="voiceverse-test",
    )
    app = create_app(
        settings,
        media_toolchain=MediaToolchain(settings),
        speech_object_store=cast("ObjectStore", ReadinessObjectStore()),
    )
    async with (
        LifespanManager(app) as manager,
        AsyncClient(
            transport=ASGITransport(app=manager.app), base_url="http://testserver"
        ) as test_client,
    ):
        response = await test_client.get("/health/ready")

    assert response.status_code == 503
    assert response.json()["error"]["code"] == "MEDIA_TOOL_UNAVAILABLE"


@pytest.mark.anyio
async def test_readiness_fails_when_executor_storage_is_unavailable() -> None:
    settings = Settings(
        environment="test",
        ffmpeg_binary=sys.executable,
        ffprobe_binary=sys.executable,
        s3_bucket="voiceverse-test",
    )
    app = create_app(
        settings,
        media_toolchain=MediaToolchain(settings),
        speech_object_store=cast("ObjectStore", ReadinessObjectStore(ready=False)),
    )
    async with (
        LifespanManager(app) as manager,
        AsyncClient(
            transport=ASGITransport(app=manager.app), base_url="http://testserver"
        ) as test_client,
    ):
        response = await test_client.get("/health/ready")

    assert response.status_code == 503
    assert response.json()["error"]["code"] == "STORAGE_UNAVAILABLE"
