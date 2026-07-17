from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any, cast

import pytest
from asgi_lifespan import LifespanManager
from httpx import ASGITransport, AsyncClient

from voiceverse_ai.core.config import Settings
from voiceverse_ai.main import create_app
from voiceverse_ai.media.errors import media_error
from voiceverse_ai.media.models import (
    ArtifactKind,
    ArtifactMetadata,
    AudioStreamMetadata,
    MediaPreparationRequest,
    MediaPreparationResponse,
    SourceMediaMetadata,
    ToolVersions,
    VideoStreamMetadata,
)
from voiceverse_ai.media.service import MediaPreparationExecutor
from voiceverse_ai.media.tools import MediaToolchain

TOKEN = "test-internal-token-with-32-characters"
PAYLOAD = {
    "executionId": "018f0000-0000-7000-8000-000000000001",
    "attemptId": "018f0000-0000-7000-8000-000000000002",
    "bucket": "voiceverse-test",
    "configurationHash": "f" * 64,
    "sourceKey": "sources/01/source",
    "canonicalAudioKey": "artifacts/01/canonical",
    "analysisAudioKey": "artifacts/01/analysis",
    "probeManifestKey": "artifacts/01/manifest",
    "expectedSourceSizeBytes": 123,
    "expectedSourceSha256": "a" * 64,
    "preferredAudioLanguageTag": "en-US",
}


def _result(payload: MediaPreparationRequest) -> MediaPreparationResponse:
    audio = AudioStreamMetadata(
        stream_index=1,
        codec_name="aac",
        channels=2,
        sample_rate_hz=48_000,
        is_default=True,
    )
    return MediaPreparationResponse(
        execution_id=payload.execution_id,
        attempt_id=payload.attempt_id,
        producer_version="test-executor-version",
        source=SourceMediaMetadata(
            size_bytes=123,
            sha256="a" * 64,
            container_formats=["mp4"],
            duration_ms=1_000,
            audio_streams=[audio],
            selected_audio=audio,
            audio_selection_method="DEFAULT_THEN_LANGUAGE_THEN_LOWEST_INDEX",
            audio_selection_reason="DEFAULT_DISPOSITION",
            preferred_audio_language_tag="en-us",
            video_streams=[
                VideoStreamMetadata(
                    stream_index=0,
                    codec_name="h264",
                    width=1920,
                    height=1080,
                    is_default=True,
                )
            ],
        ),
        artifacts=[
            ArtifactMetadata(
                kind=ArtifactKind.CANONICAL_AUDIO,
                media_type="audio/flac",
                size_bytes=12,
                sha256="b" * 64,
                codec_name="flac",
                sample_rate_hz=48_000,
                channels=2,
            )
        ],
        tools=ToolVersions(ffmpeg="8.0", ffprobe="8.0"),
    )


class FakeExecutor:
    def __init__(self, *, fail: bool = False) -> None:
        self.calls = 0
        self.fail = fail

    async def prepare(self, request: MediaPreparationRequest) -> MediaPreparationResponse:
        self.calls += 1
        if self.fail:
            raise media_error("MEDIA_PROBE_FAILED", "Media structure could not be validated.", 422)
        return _result(request)


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


async def _client(
    tmp_path: Path,
    executor: FakeExecutor,
    *,
    token: str | None = TOKEN,
) -> AsyncIterator[AsyncClient]:
    settings = Settings(
        **cast(
            "Any",
            {
                "environment": "test",
                "internal_api_token": token,
                "media_scratch_root": tmp_path,
                "s3_bucket": "voiceverse-test",
            },
        )
    )
    toolchain = MediaToolchain(
        Settings(
            environment="test",
            ffmpeg_binary="/usr/bin/true",
            ffprobe_binary="/usr/bin/true",
        )
    )
    app = create_app(
        settings,
        media_preparation_executor=cast("MediaPreparationExecutor", executor),
        media_toolchain=toolchain,
    )
    async with LifespanManager(app) as manager:
        transport = ASGITransport(app=manager.app)
        async with AsyncClient(transport=transport, base_url="http://testserver") as client:
            yield client


@pytest.mark.anyio
async def test_internal_endpoint_requires_and_accepts_dedicated_bearer(tmp_path: Path) -> None:
    executor = FakeExecutor()
    async for client in _client(tmp_path, executor):
        unauthorized = await client.post("/internal/v1/media-preparations", json=PAYLOAD)
        authorized = await client.post(
            "/internal/v1/media-preparations",
            json=PAYLOAD,
            headers={"Authorization": f"Bearer {TOKEN}"},
        )

    assert unauthorized.status_code == 401
    assert unauthorized.json()["error"]["code"] == "AUTHENTICATION_REQUIRED"
    assert authorized.status_code == 200
    assert authorized.json()["source"]["audioSelectionMethod"].startswith("DEFAULT_")
    assert executor.calls == 1


@pytest.mark.anyio
async def test_internal_endpoint_rejects_bucket_outside_configured_scope(
    tmp_path: Path,
) -> None:
    executor = FakeExecutor()
    async for client in _client(tmp_path, executor):
        response = await client.post(
            "/internal/v1/media-preparations",
            json={**PAYLOAD, "bucket": "another-valid-bucket"},
            headers={"Authorization": f"Bearer {TOKEN}"},
        )

    assert response.status_code == 403
    assert response.json()["error"]["code"] == "STORAGE_SCOPE_FORBIDDEN"
    assert executor.calls == 0


@pytest.mark.anyio
async def test_internal_endpoint_returns_stable_validation_and_execution_errors(
    tmp_path: Path,
) -> None:
    executor = FakeExecutor(fail=True)
    async for client in _client(tmp_path, executor):
        invalid = await client.post(
            "/internal/v1/media-preparations",
            json={**PAYLOAD, "sourceKey": "../not-opaque"},
            headers={"Authorization": f"Bearer {TOKEN}"},
        )
        failed = await client.post(
            "/internal/v1/media-preparations",
            json=PAYLOAD,
            headers={"Authorization": f"Bearer {TOKEN}"},
        )

    assert invalid.status_code == 422
    assert invalid.json() == {
        "error": {"code": "INVALID_REQUEST", "message": "Request validation failed."}
    }
    assert failed.status_code == 422
    assert failed.json()["error"]["code"] == "MEDIA_PROBE_FAILED"


@pytest.mark.anyio
async def test_internal_endpoint_is_unavailable_when_auth_is_not_configured(
    tmp_path: Path,
) -> None:
    executor = FakeExecutor()
    async for client in _client(tmp_path, executor, token=None):
        response = await client.post(
            "/internal/v1/media-preparations",
            json=PAYLOAD,
            headers={"Authorization": f"Bearer {TOKEN}"},
        )

    assert response.status_code == 503
    assert response.json()["error"]["code"] == "INTERNAL_AUTH_NOT_CONFIGURED"
    assert executor.calls == 0
