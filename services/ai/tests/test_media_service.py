import hashlib
import json
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any, cast
from uuid import UUID

import pytest

from voiceverse_ai.core.config import Settings
from voiceverse_ai.media.errors import MediaExecutionError
from voiceverse_ai.media.models import ArtifactKind, MediaPreparationRequest
from voiceverse_ai.media.service import MediaPreparationService
from voiceverse_ai.media.storage import ObjectStore
from voiceverse_ai.media.tools import MediaToolchain

SOURCE = b"verified media input"
SOURCE_SHA = hashlib.sha256(SOURCE).hexdigest()


def _source_probe(
    *,
    container: str = "mov,mp4,m4a,3gp,3g2,mj2",
    duration: str = "1.250",
    include_audio: bool = True,
    include_video: bool = True,
) -> dict[str, Any]:
    streams: list[dict[str, Any]] = []
    if include_video:
        streams.append(
            {
                "index": 0,
                "codec_type": "video",
                "codec_name": "h264",
                "profile": "High",
                "width": 1920,
                "height": 1080,
                "avg_frame_rate": "24000/1001",
                "time_base": "1/24000",
                "start_time": "-0.042",
                "duration": duration,
                "bit_rate": "1200000",
                "tags": {"language": "UND"},
                "disposition": {"default": 1},
            }
        )
    if include_audio:
        streams.extend(
            [
                {
                    "index": 1,
                    "codec_type": "audio",
                    "codec_name": "aac",
                    "profile": "LC",
                    "channels": 2,
                    "channel_layout": "stereo",
                    "sample_rate": "48000",
                    "time_base": "1/48000",
                    "duration": duration,
                    "bit_rate": "192000",
                    "tags": {"language": "hin"},
                    "disposition": {"default": 0},
                },
                {
                    "index": 2,
                    "codec_type": "audio",
                    "codec_name": "aac",
                    "profile": "LC",
                    "channels": 2,
                    "channel_layout": "stereo",
                    "sample_rate": "44100",
                    "duration": duration,
                    "tags": {"language": "eng"},
                    "disposition": {"default": 1},
                },
            ]
        )
    return {
        "streams": streams,
        "format": {
            "format_name": container,
            "duration": duration,
            "bit_rate": "1400000",
        },
    }


def _audio_probe(*, channels: int, sample_rate: int) -> dict[str, Any]:
    return {
        "streams": [
            {
                "index": 0,
                "codec_type": "audio",
                "codec_name": "flac",
                "channels": channels,
                "sample_rate": str(sample_rate),
                "duration": "1.250",
                "disposition": {"default": 1},
            }
        ],
        "format": {"format_name": "flac", "duration": "1.250"},
    }


@dataclass(frozen=True)
class Upload:
    key: str
    content: bytes
    media_type: str
    sha256: str
    metadata: Mapping[str, str]


class FakeStorage:
    def __init__(self) -> None:
        self.uploads: list[Upload] = []

    async def is_ready(self, *, bucket: str) -> bool:
        return bucket == "voiceverse-test"

    async def download_verified(
        self,
        *,
        bucket: str,
        key: str,
        destination: Path,
        expected_size: int,
        expected_sha256: str,
        max_size: int,
    ) -> None:
        assert bucket == "voiceverse-test"
        assert key == "sources/01/source"
        assert expected_size == len(SOURCE)
        assert expected_sha256 == SOURCE_SHA
        assert max_size >= len(SOURCE)
        destination.write_bytes(SOURCE)

    async def upload_immutable(
        self,
        *,
        bucket: str,
        key: str,
        source: Path,
        media_type: str,
        sha256: str,
        metadata: Mapping[str, str],
    ) -> None:
        assert bucket == "voiceverse-test"
        self.uploads.append(
            Upload(
                key=key,
                content=source.read_bytes(),
                media_type=media_type,
                sha256=sha256,
                metadata=metadata,
            )
        )


class FakeToolchain:
    def __init__(self, source_probe: dict[str, Any] | None = None) -> None:
        self.source_probe = source_probe or _source_probe()
        self.selected_stream_index: int | None = None

    async def versions(self) -> tuple[str, str]:
        return "8.0-test", "8.0-test"

    async def probe(self, source: Path) -> dict[str, Any]:
        if source.name == "source.media":
            return self.source_probe
        if source.name == "canonical.flac":
            return _audio_probe(channels=2, sample_rate=48_000)
        return _audio_probe(channels=1, sample_rate=16_000)

    async def transcode_audio(
        self,
        *,
        source: Path,
        stream_index: int,
        canonical_output: Path,
        analysis_output: Path,
    ) -> None:
        assert source.read_bytes() == SOURCE
        self.selected_stream_index = stream_index
        canonical_output.write_bytes(b"canonical-flac")
        analysis_output.write_bytes(b"analysis-flac")


def _settings(tmp_path: Path, **updates: object) -> Settings:
    values: dict[str, object] = {
        "environment": "test",
        "app_version": "test-build",
        "internal_api_token": "test-internal-token-with-32-characters",
        "media_scratch_root": tmp_path,
        "media_max_input_bytes": 1_048_576,
        "media_max_output_bytes": 1_048_576,
    }
    values.update(updates)
    return Settings(**cast("Any", values))


def _request() -> MediaPreparationRequest:
    return MediaPreparationRequest(
        execution_id=UUID("018f0000-0000-7000-8000-000000000001"),
        attempt_id=UUID("018f0000-0000-7000-8000-000000000002"),
        bucket="voiceverse-test",
        configuration_hash="f" * 64,
        source_key="sources/01/source",
        canonical_audio_key="artifacts/01/canonical",
        analysis_audio_key="artifacts/01/analysis",
        probe_manifest_key="artifacts/01/manifest",
        expected_source_size_bytes=len(SOURCE),
        expected_source_sha256=SOURCE_SHA,
        preferred_audio_language_tag="en-US",
    )


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


@pytest.mark.anyio
async def test_prepares_verified_immutable_artifacts_and_sanitized_manifest(
    tmp_path: Path,
) -> None:
    storage = FakeStorage()
    tools = FakeToolchain()
    service = MediaPreparationService(
        settings=_settings(tmp_path),
        storage=cast("ObjectStore", storage),
        toolchain=cast("MediaToolchain", tools),
    )

    response = await service.prepare(_request())

    assert tools.selected_stream_index == 2
    assert response.source.audio_selection_method == "DEFAULT_THEN_LANGUAGE_THEN_LOWEST_INDEX"
    assert response.source.audio_selection_reason == "DEFAULT_DISPOSITION"
    assert response.source.preferred_audio_language_tag == "en-us"
    assert [stream.stream_index for stream in response.source.audio_streams] == [1, 2]
    assert response.source.selected_audio.language_tag == "en"
    assert response.source.video_streams[0].start_time_ms == -42
    assert {artifact.kind for artifact in response.artifacts} == set(ArtifactKind)
    assert {upload.key for upload in storage.uploads} == {
        "artifacts/01/canonical",
        "artifacts/01/analysis",
        "artifacts/01/manifest",
    }
    manifest_upload = next(
        upload for upload in storage.uploads if upload.media_type == "application/json"
    )
    manifest = json.loads(manifest_upload.content)
    assert len(manifest["artifacts"]) == 2
    assert manifest["source"]["selectedAudio"]["languageTag"] == "en"
    assert "sourceKey" not in manifest
    assert b"sources/01/source" not in manifest_upload.content
    assert hashlib.sha256(manifest_upload.content).hexdigest() == manifest_upload.sha256
    assert not list(tmp_path.iterdir())


@pytest.mark.anyio
async def test_rejects_source_without_audio_and_cleans_scratch(tmp_path: Path) -> None:
    storage = FakeStorage()
    service = MediaPreparationService(
        settings=_settings(tmp_path),
        storage=cast("ObjectStore", storage),
        toolchain=cast("MediaToolchain", FakeToolchain(_source_probe(include_audio=False))),
    )

    with pytest.raises(MediaExecutionError) as caught:
        await service.prepare(_request())

    assert caught.value.code == "MEDIA_NO_AUDIO_STREAM"
    assert storage.uploads == []
    assert not list(tmp_path.iterdir())


@pytest.mark.anyio
async def test_rejects_audio_only_mp4_family_source(tmp_path: Path) -> None:
    service = MediaPreparationService(
        settings=_settings(tmp_path),
        storage=cast("ObjectStore", FakeStorage()),
        toolchain=cast("MediaToolchain", FakeToolchain(_source_probe(include_video=False))),
    )

    with pytest.raises(MediaExecutionError) as caught:
        await service.prepare(_request())

    assert caught.value.code == "MEDIA_VIDEO_STREAM_MISSING"


@pytest.mark.anyio
async def test_rejects_non_mp4_container_even_when_it_has_video(tmp_path: Path) -> None:
    service = MediaPreparationService(
        settings=_settings(tmp_path),
        storage=cast("ObjectStore", FakeStorage()),
        toolchain=cast("MediaToolchain", FakeToolchain(_source_probe(container="matroska,webm"))),
    )

    with pytest.raises(MediaExecutionError) as caught:
        await service.prepare(_request())

    assert caught.value.code == "MEDIA_CONTAINER_UNSUPPORTED"


@pytest.mark.anyio
async def test_rejects_media_over_duration_limit(tmp_path: Path) -> None:
    service = MediaPreparationService(
        settings=_settings(tmp_path, media_max_duration_seconds=1),
        storage=cast("ObjectStore", FakeStorage()),
        toolchain=cast("MediaToolchain", FakeToolchain(_source_probe(duration="1.001"))),
    )

    with pytest.raises(MediaExecutionError) as caught:
        await service.prepare(_request())

    assert caught.value.code == "MEDIA_DURATION_TOO_LONG"


@pytest.mark.anyio
async def test_language_preference_breaks_non_default_stream_ties(tmp_path: Path) -> None:
    probe = _source_probe()
    for stream in probe["streams"]:
        if stream.get("codec_type") == "audio":
            stream["disposition"]["default"] = 0
    tools = FakeToolchain(probe)
    service = MediaPreparationService(
        settings=_settings(tmp_path),
        storage=cast("ObjectStore", FakeStorage()),
        toolchain=cast("MediaToolchain", tools),
    )

    response = await service.prepare(_request())

    assert tools.selected_stream_index == 2
    assert response.source.audio_selection_reason == "PREFERRED_LANGUAGE_BASE"


@pytest.mark.anyio
async def test_unavailable_secure_scratch_has_stable_error(tmp_path: Path) -> None:
    service = MediaPreparationService(
        settings=_settings(tmp_path / "not-created"),
        storage=cast("ObjectStore", FakeStorage()),
        toolchain=cast("MediaToolchain", FakeToolchain()),
    )

    with pytest.raises(MediaExecutionError) as caught:
        await service.prepare(_request())

    assert caught.value.code == "MEDIA_SCRATCH_UNAVAILABLE"
