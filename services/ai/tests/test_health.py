from collections.abc import AsyncIterator

import pytest
from asgi_lifespan import LifespanManager
from httpx import ASGITransport, AsyncClient

from voiceverse_ai.core.config import Settings
from voiceverse_ai.main import create_app


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


@pytest.fixture
async def client() -> AsyncIterator[AsyncClient]:
    app = create_app(Settings(environment="test"))
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
