import asyncio
import hashlib
import json
import shutil
import subprocess
from collections.abc import AsyncIterator, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any, cast
from uuid import UUID

import pytest
from asgi_lifespan import LifespanManager
from httpx import ASGITransport, AsyncByteStream, AsyncClient
from pydantic import ValidationError

from voiceverse_ai.core.config import Settings
from voiceverse_ai.main import create_app
from voiceverse_ai.media.errors import MediaExecutionError
from voiceverse_ai.media.storage import ObjectStore
from voiceverse_ai.media.tools import MediaToolchain
from voiceverse_ai.speech.models import (
    AudioOutputMetadata,
    DiarizationProviderResult,
    ModelDescriptor,
    ProviderSpeakerTurn,
    SeparationProviderResult,
    SpeakerDiarizationRequest,
    SpeechArtifactReference,
    SpeechCapability,
    SpeechInputArtifactKind,
    TranscriptionProviderResult,
    TranscriptionRequest,
    TranscriptSegment,
    TranscriptWord,
    VocalSeparationRequest,
)
from voiceverse_ai.speech.providers import (
    SeparationOutputPaths,
    SpeakerDiarizationProvider,
    TranscriptionProvider,
    VocalSeparationProvider,
)
from voiceverse_ai.speech.service import (
    SpeechAudioProbe,
    SpeechExecutionLimiter,
    SpeechExecutionService,
)

TOKEN = "test-internal-speech-token-with-32-characters"
BUCKET = "voiceverse-test"
EXECUTION_ID = UUID("018f0000-0000-7000-8000-000000000101")
ATTEMPT_ID = UUID("018f0000-0000-7000-8000-000000000102")
ARTIFACT_ID = UUID("018f0000-0000-7000-8000-000000000103")
INPUT = b"verified-private-flac"
INPUT_SHA = hashlib.sha256(INPUT).hexdigest()
DURATION_US = 2_000_000
TEST_MODEL = ModelDescriptor(
    provider="test-provider",
    model_id="test/model",
    model_revision="0123456789abcdef",
    runtime_version="1.0.0",
)


def _probe_document(
    *,
    sample_rate_hz: int = 48_000,
    channels: int = 2,
    duration: object = "2.000000",
    stream_duration: object | None = None,
    codec_name: str = "flac",
    format_name: str = "flac",
    extra_streams: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    return {
        "format": {"format_name": format_name, "duration": duration},
        "streams": [
            {
                "codec_type": "audio",
                "codec_name": codec_name,
                "sample_rate": str(sample_rate_hz),
                "channels": channels,
                "duration": stream_duration if stream_duration is not None else duration,
            },
            *(extra_streams or []),
        ],
    }


class FakeAudioProbe:
    def __init__(
        self,
        overrides: Mapping[str, Mapping[str, Any] | BaseException] | None = None,
    ) -> None:
        self._overrides = dict(overrides or {})
        self.calls: list[Path] = []

    def is_ready(self) -> bool:
        return True

    async def probe(self, source: Path) -> Mapping[str, Any]:
        self.calls.append(source)
        override = self._overrides.get(source.name)
        if isinstance(override, BaseException):
            raise override
        if override is not None:
            return override
        if source.name == "isolated-speech.flac":
            return _probe_document(sample_rate_hz=16_000, channels=1)
        return _probe_document()


class MutatingAudioProbe(FakeAudioProbe):
    async def probe(self, source: Path) -> Mapping[str, Any]:
        if source.name == "vocals.flac":
            source.write_bytes(source.read_bytes() + b"changed-during-probe")
        return await super().probe(source)


@dataclass(frozen=True, slots=True)
class Upload:
    key: str
    content: bytes
    media_type: str
    sha256: str
    metadata: Mapping[str, str]


class FakeStorage:
    def __init__(self) -> None:
        self.downloads = 0
        self.uploads: list[Upload] = []

    async def is_ready(self, *, bucket: str) -> bool:
        return bucket == BUCKET

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
        assert bucket == BUCKET
        assert key.startswith("artifacts/")
        assert expected_size == len(INPUT)
        assert expected_sha256 == INPUT_SHA
        assert max_size >= len(INPUT)
        self.downloads += 1
        destination.write_bytes(INPUT)

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
        assert bucket == BUCKET
        content = source.read_bytes()
        assert hashlib.sha256(content).hexdigest() == sha256
        self.uploads.append(
            Upload(
                key=key,
                content=content,
                media_type=media_type,
                sha256=sha256,
                metadata=metadata,
            )
        )


class CoordinatedFailingUploadStorage(FakeStorage):
    def __init__(self) -> None:
        super().__init__()
        self.failed = asyncio.Event()
        self.slow_upload_started = asyncio.Event()
        self.release_slow_upload = asyncio.Event()

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
        if key == "outputs/vocals.flac":
            self.failed.set()
            raise MediaExecutionError(
                code="STORAGE_UPLOAD_FAILED",
                message="The immutable artifact upload failed.",
                status_code=502,
            )
        if key == "outputs/accompaniment.flac":
            self.slow_upload_started.set()
            await self.release_slow_upload.wait()
            # Cleanup must not remove a file while another upload is still reading it.
            assert source.is_file()
        await super().upload_immutable(
            bucket=bucket,
            key=key,
            source=source,
            media_type=media_type,
            sha256=sha256,
            metadata=metadata,
        )


class ProviderBase:
    def __init__(self, *, ready: bool = True) -> None:
        self.ready = ready
        self.calls = 0
        self.descriptor = TEST_MODEL

    def is_ready(self) -> bool:
        return self.ready


class FakeSeparationProvider(ProviderBase):
    async def separate(
        self,
        source: Path,
        outputs: SeparationOutputPaths,
        *,
        duration_us: int,
        sample_rate_hz: int,
        channels: int,
    ) -> SeparationProviderResult:
        self.calls += 1
        assert source.read_bytes() == INPUT
        outputs.vocal_stem.write_bytes(b"vocal-flac")
        outputs.accompaniment_stem.write_bytes(b"accompaniment-flac")
        outputs.isolated_speech.write_bytes(b"isolated-speech-flac")
        return SeparationProviderResult(
            vocal_stem=AudioOutputMetadata(
                sample_rate_hz=sample_rate_hz,
                channels=channels,
                duration_us=duration_us,
            ),
            accompaniment_stem=AudioOutputMetadata(
                sample_rate_hz=sample_rate_hz,
                channels=channels,
                duration_us=duration_us,
            ),
            isolated_speech=AudioOutputMetadata(
                sample_rate_hz=16_000,
                channels=1,
                duration_us=duration_us,
            ),
        )


class SymlinkSeparationProvider(FakeSeparationProvider):
    async def separate(
        self,
        source: Path,
        outputs: SeparationOutputPaths,
        *,
        duration_us: int,
        sample_rate_hz: int,
        channels: int,
    ) -> SeparationProviderResult:
        result = await super().separate(
            source,
            outputs,
            duration_us=duration_us,
            sample_rate_hz=sample_rate_hz,
            channels=channels,
        )
        outputs.vocal_stem.unlink()
        outputs.vocal_stem.symlink_to(source)
        return result


class RealFlacSeparationProvider(ProviderBase):
    async def separate(
        self,
        source: Path,
        outputs: SeparationOutputPaths,
        *,
        duration_us: int,
        sample_rate_hz: int,
        channels: int,
    ) -> SeparationProviderResult:
        assert source.is_file()

        async def generate(path: Path, rate: int, channel_layout: str) -> None:
            await asyncio.to_thread(
                subprocess.run,
                [
                    "ffmpeg",
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-f",
                    "lavfi",
                    "-i",
                    f"anullsrc=r={rate}:cl={channel_layout}",
                    "-t",
                    str(duration_us / 1_000_000),
                    "-c:a",
                    "flac",
                    "-compression_level",
                    "0",
                    str(path),
                ],
                check=True,
                capture_output=True,
            )

        await asyncio.gather(
            generate(outputs.vocal_stem, sample_rate_hz, "stereo"),
            generate(outputs.accompaniment_stem, sample_rate_hz, "stereo"),
            generate(outputs.isolated_speech, 16_000, "mono"),
        )
        return SeparationProviderResult(
            vocal_stem=AudioOutputMetadata(
                sample_rate_hz=sample_rate_hz,
                channels=channels,
                duration_us=duration_us,
            ),
            accompaniment_stem=AudioOutputMetadata(
                sample_rate_hz=sample_rate_hz,
                channels=channels,
                duration_us=duration_us,
            ),
            isolated_speech=AudioOutputMetadata(
                sample_rate_hz=16_000,
                channels=1,
                duration_us=duration_us,
            ),
        )


class FakeTranscriptionProvider(ProviderBase):
    async def transcribe(
        self,
        source: Path,
        *,
        duration_us: int,
        source_language_tag: str,
    ) -> TranscriptionProviderResult:
        self.calls += 1
        assert source.read_bytes() == INPUT
        assert duration_us == DURATION_US
        assert source_language_tag == "en-US"
        return TranscriptionProviderResult(
            detected_language="en",
            language_probability=0.98,
            segments=[
                TranscriptSegment(
                    ordinal=0,
                    start_us=100_000,
                    end_us=900_000,
                    text="Hello world.",
                    average_log_probability=-0.2,
                    no_speech_probability=0.01,
                    words=[
                        TranscriptWord(
                            ordinal=0,
                            start_us=100_000,
                            end_us=400_000,
                            text="Hello",
                            probability=0.99,
                        ),
                        TranscriptWord(
                            ordinal=1,
                            start_us=450_000,
                            end_us=900_000,
                            text="world.",
                            probability=0.96,
                        ),
                    ],
                )
            ],
        )


class FakeDiarizationProvider(ProviderBase):
    async def diarize(
        self,
        source: Path,
        *,
        duration_us: int,
    ) -> DiarizationProviderResult:
        self.calls += 1
        assert source.read_bytes() == INPUT
        assert duration_us == DURATION_US
        return DiarizationProviderResult(
            # Deliberately unsorted with overlap. Canonicalization must use time,
            # not provider label order.
            turns=[
                ProviderSpeakerTurn(
                    start_us=600_000,
                    end_us=1_200_000,
                    provider_speaker_label="SPEAKER_A",
                ),
                ProviderSpeakerTurn(
                    start_us=100_000,
                    end_us=800_000,
                    provider_speaker_label="SPEAKER_Z",
                ),
            ],
            exclusive_turns=[
                ProviderSpeakerTurn(
                    start_us=100_000,
                    end_us=600_000,
                    provider_speaker_label="SPEAKER_Z",
                ),
                ProviderSpeakerTurn(
                    start_us=600_000,
                    end_us=1_200_000,
                    provider_speaker_label="SPEAKER_A",
                ),
            ],
        )


class FailingTranscriptionProvider(FakeTranscriptionProvider):
    async def transcribe(
        self,
        source: Path,
        *,
        duration_us: int,
        source_language_tag: str,
    ) -> TranscriptionProviderResult:
        raise RuntimeError("sensitive provider detail")


class BlockingTranscriptionProvider(FakeTranscriptionProvider):
    def __init__(self) -> None:
        super().__init__()
        self.entered = asyncio.Event()
        self.release = asyncio.Event()

    async def transcribe(
        self,
        source: Path,
        *,
        duration_us: int,
        source_language_tag: str,
    ) -> TranscriptionProviderResult:
        self.entered.set()
        await self.release.wait()
        return await super().transcribe(
            source,
            duration_us=duration_us,
            source_language_tag=source_language_tag,
        )


class CancellationAwareTranscriptionProvider(FakeTranscriptionProvider):
    def __init__(self) -> None:
        super().__init__()
        self.entered = asyncio.Event()
        self.cancelled = asyncio.Event()
        self.release_cleanup = asyncio.Event()
        self.cleaned = False

    async def transcribe(
        self,
        source: Path,
        *,
        duration_us: int,
        source_language_tag: str,
    ) -> TranscriptionProviderResult:
        self.entered.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            self.cancelled.set()
            await self.release_cleanup.wait()
            self.cleaned = True
            raise
        raise AssertionError("unreachable")


class TimingOutSeparationProvider(FakeSeparationProvider):
    async def separate(
        self,
        source: Path,
        outputs: SeparationOutputPaths,
        *,
        duration_us: int,
        sample_rate_hz: int,
        channels: int,
    ) -> SeparationProviderResult:
        await asyncio.Event().wait()
        raise AssertionError("unreachable")


class TimingOutDiarizationProvider(FakeDiarizationProvider):
    async def diarize(
        self,
        source: Path,
        *,
        duration_us: int,
    ) -> DiarizationProviderResult:
        await asyncio.Event().wait()
        raise AssertionError("unreachable")


class ExplodingRequestStream(AsyncByteStream):
    def __init__(self) -> None:
        self.iterated = False

    async def __aiter__(self) -> AsyncIterator[bytes]:
        self.iterated = True
        raise AssertionError("an unauthorized or declared-oversize body was read")
        yield b""  # type: ignore[unreachable]  # pragma: no cover


class ChunkedRequestStream(AsyncByteStream):
    def __init__(self, chunks: tuple[bytes, ...]) -> None:
        self._chunks = chunks
        self.emitted = 0

    async def __aiter__(self) -> AsyncIterator[bytes]:
        for chunk in self._chunks:
            self.emitted += 1
            yield chunk


def _settings(tmp_path: Path, **updates: object) -> Settings:
    values: dict[str, object] = {
        "environment": "test",
        "app_version": "test-build",
        "internal_api_token": TOKEN,
        "s3_bucket": BUCKET,
        "speech_scratch_root": tmp_path,
        "speech_vocal_separation_enabled": True,
        "speech_transcription_enabled": True,
        "speech_diarization_enabled": True,
    }
    values.update(updates)
    return Settings(**cast("Any", values))


def _artifact(
    kind: SpeechInputArtifactKind,
    *,
    sample_rate_hz: int,
    channels: int,
) -> SpeechArtifactReference:
    return SpeechArtifactReference(
        artifact_id=ARTIFACT_ID,
        kind=kind,
        storage_key=f"artifacts/{kind.value.lower()}.flac",
        byte_size=len(INPUT),
        sha256=INPUT_SHA,
        media_type="audio/flac",
        duration_us=DURATION_US,
        sample_rate_hz=sample_rate_hz,
        channels=channels,
    )


def _separation_request() -> VocalSeparationRequest:
    return VocalSeparationRequest(
        execution_id=EXECUTION_ID,
        attempt_id=ATTEMPT_ID,
        bucket=BUCKET,
        configuration_hash="f" * 64,
        expected_model=TEST_MODEL,
        input_artifact=_artifact(
            SpeechInputArtifactKind.CANONICAL_AUDIO,
            sample_rate_hz=48_000,
            channels=2,
        ),
        vocal_stem_key="outputs/vocals.flac",
        accompaniment_stem_key="outputs/accompaniment.flac",
        isolated_speech_key="outputs/isolated.flac",
        manifest_key="outputs/separation.json",
    )


def _transcription_request() -> TranscriptionRequest:
    return TranscriptionRequest(
        execution_id=EXECUTION_ID,
        attempt_id=ATTEMPT_ID,
        bucket=BUCKET,
        configuration_hash="e" * 64,
        expected_model=TEST_MODEL,
        input_artifact=_artifact(
            SpeechInputArtifactKind.ISOLATED_SPEECH_AUDIO,
            sample_rate_hz=16_000,
            channels=1,
        ),
        source_language_tag="en-US",
        manifest_key="outputs/transcript.json",
    )


def _diarization_request() -> SpeakerDiarizationRequest:
    return SpeakerDiarizationRequest(
        execution_id=EXECUTION_ID,
        attempt_id=ATTEMPT_ID,
        bucket=BUCKET,
        configuration_hash="d" * 64,
        expected_model=TEST_MODEL,
        input_artifact=_artifact(
            SpeechInputArtifactKind.ANALYSIS_AUDIO,
            sample_rate_hz=16_000,
            channels=1,
        ),
        manifest_key="outputs/diarization.json",
    )


def _service(
    tmp_path: Path,
    storage: FakeStorage,
    *,
    separation: VocalSeparationProvider | None = None,
    transcription: TranscriptionProvider | None = None,
    diarization: SpeakerDiarizationProvider | None = None,
    audio_probe: SpeechAudioProbe | None = None,
    settings: Settings | None = None,
    limiter: SpeechExecutionLimiter | None = None,
) -> SpeechExecutionService:
    return SpeechExecutionService(
        settings=settings or _settings(tmp_path),
        storage=cast("ObjectStore", storage),
        audio_probe=audio_probe or FakeAudioProbe(),
        vocal_separation_provider=separation,
        transcription_provider=transcription,
        diarization_provider=diarization,
        limiter=limiter,
    )


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


@pytest.mark.anyio
async def test_separation_writes_stems_then_immutable_completion_manifest(
    tmp_path: Path,
) -> None:
    storage = FakeStorage()
    provider = FakeSeparationProvider()
    audio_probe = FakeAudioProbe()
    service = _service(
        tmp_path,
        storage,
        separation=provider,
        audio_probe=audio_probe,
    )

    response = await service.separate(_separation_request())

    assert provider.calls == 1
    assert len(response.artifacts) == 4
    assert [upload.key for upload in storage.uploads][-1] == "outputs/separation.json"
    manifest = json.loads(storage.uploads[-1].content)
    assert manifest["schemaVersion"] == "voiceverse.separation.v1"
    assert manifest["timeline"] == {
        "durationUs": DURATION_US,
        "intervalConvention": "HALF_OPEN",
        "originUs": 0,
    }
    assert {item["kind"] for item in manifest["artifacts"]} == {
        "ANALYSIS_VOCAL_STEM",
        "ANALYSIS_ACCOMPANIMENT_STEM",
        "ISOLATED_SPEECH_AUDIO",
    }
    assert storage.uploads[-1].metadata["model-revision"] == "0123456789abcdef"
    assert {path.name for path in audio_probe.calls} == {
        "vocals.flac",
        "accompaniment.flac",
        "isolated-speech.flac",
    }
    audio_artifacts = [artifact for artifact in response.artifacts if artifact.codec_name == "flac"]
    assert {(artifact.sample_rate_hz, artifact.channels) for artifact in audio_artifacts} == {
        (48_000, 2),
        (16_000, 1),
    }
    assert all(artifact.duration_us == DURATION_US for artifact in audio_artifacts)
    assert not list(tmp_path.iterdir())


@pytest.mark.anyio
@pytest.mark.skipif(
    shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None,
    reason="Speech FLAC verification integration requires ffmpeg and ffprobe",
)
async def test_real_media_toolchain_independently_verifies_generated_flac(
    tmp_path: Path,
) -> None:
    settings = _settings(tmp_path)
    storage = FakeStorage()
    response = await _service(
        tmp_path,
        storage,
        separation=RealFlacSeparationProvider(),
        audio_probe=MediaToolchain(settings),
        settings=settings,
    ).separate(_separation_request())

    audio_artifacts = [artifact for artifact in response.artifacts if artifact.codec_name == "flac"]
    assert len(audio_artifacts) == 3
    assert all(upload.content.startswith(b"fLaC") for upload in storage.uploads[:3])
    assert not list(tmp_path.iterdir())


@pytest.mark.parametrize(
    "probe_result",
    [
        RuntimeError("sensitive decoder detail"),
        _probe_document(codec_name="mp3"),
        _probe_document(format_name="wav"),
        _probe_document(sample_rate_hz=44_100),
        _probe_document(channels=1),
        _probe_document(duration="2.200000"),
        _probe_document(extra_streams=[{"codec_type": "video", "codec_name": "h264"}]),
        _probe_document(duration="2.000000", stream_duration="1.800000"),
    ],
    ids=[
        "probe-failure",
        "wrong-codec",
        "wrong-container",
        "wrong-sample-rate",
        "wrong-channels",
        "wrong-duration",
        "additional-stream",
        "inconsistent-duration",
    ],
)
@pytest.mark.anyio
async def test_generated_stems_fail_closed_when_independent_probe_is_invalid(
    tmp_path: Path,
    probe_result: Mapping[str, Any] | BaseException,
) -> None:
    storage = FakeStorage()
    probe = FakeAudioProbe({"vocals.flac": probe_result})

    with pytest.raises(MediaExecutionError) as invalid_output:
        await _service(
            tmp_path,
            storage,
            separation=FakeSeparationProvider(),
            audio_probe=probe,
        ).separate(_separation_request())

    assert invalid_output.value.code == "SPEECH_OUTPUT_INVALID"
    assert invalid_output.value.status_code == 500
    assert "sensitive" not in invalid_output.value.message
    assert storage.uploads == []
    assert not list(tmp_path.iterdir())


@pytest.mark.anyio
async def test_generated_stems_reject_symlinks_and_files_changed_during_probe(
    tmp_path: Path,
) -> None:
    symlink_root = tmp_path / "symlink"
    mutation_root = tmp_path / "mutation"
    symlink_root.mkdir()
    mutation_root.mkdir()

    symlink_probe = FakeAudioProbe()
    with pytest.raises(MediaExecutionError) as symlink_error:
        await _service(
            symlink_root,
            FakeStorage(),
            separation=SymlinkSeparationProvider(),
            audio_probe=symlink_probe,
        ).separate(_separation_request())
    assert symlink_error.value.code == "SPEECH_OUTPUT_INVALID"
    assert "vocals.flac" not in {path.name for path in symlink_probe.calls}
    assert not list(symlink_root.iterdir())

    with pytest.raises(MediaExecutionError) as mutation_error:
        await _service(
            mutation_root,
            FakeStorage(),
            separation=FakeSeparationProvider(),
            audio_probe=MutatingAudioProbe(),
        ).separate(_separation_request())
    assert mutation_error.value.code == "SPEECH_OUTPUT_CHANGED_DURING_VALIDATION"
    assert not list(mutation_root.iterdir())


@pytest.mark.anyio
async def test_parallel_stem_uploads_are_drained_before_workspace_cleanup(
    tmp_path: Path,
) -> None:
    storage = CoordinatedFailingUploadStorage()
    service = _service(tmp_path, storage, separation=FakeSeparationProvider())

    execution = asyncio.create_task(service.separate(_separation_request()))
    await storage.failed.wait()
    await storage.slow_upload_started.wait()
    await asyncio.sleep(0)

    assert not execution.done()
    workspaces = list(tmp_path.iterdir())
    assert len(workspaces) == 1
    assert (workspaces[0] / "accompaniment.flac").is_file()

    storage.release_slow_upload.set()
    with pytest.raises(MediaExecutionError) as upload_error:
        await execution
    assert upload_error.value.code == "STORAGE_UPLOAD_FAILED"
    assert not list(tmp_path.iterdir())


@pytest.mark.anyio
async def test_transcription_returns_only_compact_summary_and_private_manifest(
    tmp_path: Path,
) -> None:
    storage = FakeStorage()
    service = _service(tmp_path, storage, transcription=FakeTranscriptionProvider())

    response = await service.transcribe(_transcription_request())

    assert response.summary.segment_count == 1
    assert response.summary.word_count == 2
    assert "segments" not in response.model_dump(mode="json", by_alias=True)
    manifest = json.loads(storage.uploads[0].content)
    assert manifest["language"]["requestedBcp47"] == "en-US"
    assert manifest["segments"][0]["words"][1]["endUs"] == 900_000
    assert manifest["timeline"]["intervalConvention"] == "HALF_OPEN"


@pytest.mark.anyio
async def test_diarization_preserves_overlap_and_canonicalizes_speakers_by_time(
    tmp_path: Path,
) -> None:
    storage = FakeStorage()
    service = _service(tmp_path, storage, diarization=FakeDiarizationProvider())

    response = await service.diarize(_diarization_request())

    assert response.summary.speaker_count == 2
    manifest = json.loads(storage.uploads[0].content)
    assert manifest["speakers"][0] == {
        "firstTurnUs": 100_000,
        "localSpeakerKey": "speaker-0001",
        "providerLabel": "SPEAKER_Z",
        "totalSpeechUs": 700_000,
    }
    assert manifest["turns"][0]["speakerKey"] == "speaker-0001"
    assert manifest["turns"][1]["startUs"] < manifest["turns"][0]["endUs"]
    assert manifest["exclusiveTurns"][1]["speakerKey"] == "speaker-0002"


@pytest.mark.anyio
async def test_missing_unready_and_failed_providers_have_sanitized_stable_errors(
    tmp_path: Path,
) -> None:
    request = _transcription_request()
    missing = _service(tmp_path, FakeStorage())
    with pytest.raises(MediaExecutionError) as missing_error:
        await missing.transcribe(request)
    assert missing_error.value.code == "SPEECH_PROVIDER_NOT_CONFIGURED"

    unavailable = _service(
        tmp_path,
        FakeStorage(),
        transcription=FakeTranscriptionProvider(ready=False),
    )
    assert not unavailable.is_ready(SpeechCapability.TRANSCRIPTION)
    with pytest.raises(MediaExecutionError) as unavailable_error:
        await unavailable.transcribe(request)
    assert unavailable_error.value.code == "SPEECH_PROVIDER_NOT_READY"

    missing_scratch_settings = _settings(tmp_path / "missing")
    missing_scratch = _service(
        tmp_path,
        FakeStorage(),
        transcription=FakeTranscriptionProvider(),
        settings=missing_scratch_settings,
    )
    assert not missing_scratch.is_ready(SpeechCapability.TRANSCRIPTION)

    failed = _service(
        tmp_path,
        FakeStorage(),
        transcription=FailingTranscriptionProvider(),
    )
    with pytest.raises(MediaExecutionError) as provider_error:
        await failed.transcribe(request)
    assert provider_error.value.code == "TRANSCRIPTION_PROVIDER_FAILED"
    assert "sensitive" not in provider_error.value.message


@pytest.mark.anyio
async def test_model_identity_mismatch_fails_before_input_download_or_gpu_work(
    tmp_path: Path,
) -> None:
    storage = FakeStorage()
    provider = FakeTranscriptionProvider()
    request = _transcription_request().model_copy(
        update={
            "expected_model": TEST_MODEL.model_copy(
                update={"runtime_version": "different-container-image"}
            )
        }
    )

    with pytest.raises(MediaExecutionError) as mismatch:
        await _service(tmp_path, storage, transcription=provider).transcribe(request)

    assert mismatch.value.code == "SPEECH_PROVIDER_MODEL_MISMATCH"
    assert storage.downloads == 0
    assert provider.calls == 0


@pytest.mark.anyio
async def test_concurrency_is_rejected_without_leaking_workspaces(tmp_path: Path) -> None:
    provider = BlockingTranscriptionProvider()
    service = _service(
        tmp_path,
        FakeStorage(),
        transcription=provider,
        limiter=SpeechExecutionLimiter(1),
    )
    first = asyncio.create_task(service.transcribe(_transcription_request()))
    await provider.entered.wait()

    with pytest.raises(MediaExecutionError) as saturated:
        await service.transcribe(_transcription_request())
    assert saturated.value.code == "SPEECH_EXECUTOR_SATURATED"

    provider.release.set()
    await first
    assert not list(tmp_path.iterdir())


@pytest.mark.anyio
async def test_provider_deadline_waits_for_cancellation_cleanup_then_removes_workspace(
    tmp_path: Path,
) -> None:
    provider = CancellationAwareTranscriptionProvider()
    service = _service(
        tmp_path,
        FakeStorage(),
        transcription=provider,
        settings=_settings(tmp_path, speech_transcription_timeout_seconds=1),
    )

    execution = asyncio.create_task(service.transcribe(_transcription_request()))
    await provider.entered.wait()
    await asyncio.wait_for(provider.cancelled.wait(), timeout=2)

    assert not execution.done()
    assert len(list(tmp_path.iterdir())) == 1
    provider.release_cleanup.set()

    with pytest.raises(MediaExecutionError) as timeout_error:
        await execution
    assert timeout_error.value.code == "TRANSCRIPTION_PROVIDER_TIMEOUT"
    assert timeout_error.value.status_code == 504
    assert provider.cleaned
    assert not list(tmp_path.iterdir())


@pytest.mark.anyio
async def test_each_gpu_capability_has_an_independent_provider_deadline(tmp_path: Path) -> None:
    separation_root = tmp_path / "separation"
    diarization_root = tmp_path / "diarization"
    separation_root.mkdir()
    diarization_root.mkdir()
    separation = _service(
        separation_root,
        FakeStorage(),
        separation=TimingOutSeparationProvider(),
        settings=_settings(
            separation_root,
            speech_vocal_separation_timeout_seconds=1,
            speech_diarization_timeout_seconds=10,
        ),
    )
    diarization = _service(
        diarization_root,
        FakeStorage(),
        diarization=TimingOutDiarizationProvider(),
        settings=_settings(
            diarization_root,
            speech_vocal_separation_timeout_seconds=10,
            speech_diarization_timeout_seconds=1,
        ),
    )

    async def capture_timeout(operation: object) -> MediaExecutionError:
        with pytest.raises(MediaExecutionError) as error:
            await cast("Any", operation)
        return error.value

    separation_error, diarization_error = await asyncio.gather(
        capture_timeout(separation.separate(_separation_request())),
        capture_timeout(diarization.diarize(_diarization_request())),
    )

    assert separation_error.code == "VOCAL_SEPARATION_PROVIDER_TIMEOUT"
    assert diarization_error.code == "DIARIZATION_PROVIDER_TIMEOUT"
    assert not list(separation_root.iterdir())
    assert not list(diarization_root.iterdir())


@pytest.mark.anyio
async def test_invalid_provider_timelines_and_missing_outputs_fail_closed(tmp_path: Path) -> None:
    class InvalidTimelineProvider(FakeTranscriptionProvider):
        async def transcribe(
            self,
            source: Path,
            *,
            duration_us: int,
            source_language_tag: str,
        ) -> TranscriptionProviderResult:
            result = await super().transcribe(
                source,
                duration_us=duration_us,
                source_language_tag=source_language_tag,
            )
            return TranscriptionProviderResult(
                detected_language=result.detected_language,
                segments=[
                    TranscriptSegment(
                        ordinal=0,
                        start_us=duration_us,
                        end_us=duration_us + 1,
                        text="outside",
                    )
                ],
            )

    with pytest.raises(MediaExecutionError) as timeline_error:
        await _service(
            tmp_path,
            FakeStorage(),
            transcription=InvalidTimelineProvider(),
        ).transcribe(_transcription_request())
    assert timeline_error.value.code == "TRANSCRIPT_TIMELINE_INVALID"

    class OverlappingSegmentsProvider(FakeTranscriptionProvider):
        async def transcribe(
            self,
            source: Path,
            *,
            duration_us: int,
            source_language_tag: str,
        ) -> TranscriptionProviderResult:
            return TranscriptionProviderResult(
                detected_language="en",
                segments=[
                    TranscriptSegment(
                        ordinal=0,
                        start_us=100,
                        end_us=600,
                        text="first",
                    ),
                    TranscriptSegment(
                        ordinal=1,
                        start_us=500,
                        end_us=900,
                        text="second",
                    ),
                ],
            )

    with pytest.raises(MediaExecutionError) as overlap_error:
        await _service(
            tmp_path,
            FakeStorage(),
            transcription=OverlappingSegmentsProvider(),
        ).transcribe(_transcription_request())
    assert overlap_error.value.code == "TRANSCRIPT_TIMELINE_INVALID"

    class ConstructedOverlappingWordsProvider(FakeTranscriptionProvider):
        async def transcribe(
            self,
            source: Path,
            *,
            duration_us: int,
            source_language_tag: str,
        ) -> TranscriptionProviderResult:
            segment = TranscriptSegment.model_construct(
                ordinal=0,
                start_us=100,
                end_us=900,
                text="overlapping words",
                average_log_probability=None,
                no_speech_probability=None,
                words=[
                    TranscriptWord(ordinal=0, start_us=100, end_us=600, text="first"),
                    TranscriptWord(ordinal=1, start_us=500, end_us=900, text="second"),
                ],
            )
            return TranscriptionProviderResult.model_construct(
                detected_language="en",
                language_probability=None,
                segments=[segment],
            )

    with pytest.raises(MediaExecutionError) as word_overlap_error:
        await _service(
            tmp_path,
            FakeStorage(),
            transcription=ConstructedOverlappingWordsProvider(),
        ).transcribe(_transcription_request())
    assert word_overlap_error.value.code == "TRANSCRIPT_TIMELINE_INVALID"

    class MissingOutputProvider(FakeSeparationProvider):
        async def separate(
            self,
            source: Path,
            outputs: SeparationOutputPaths,
            *,
            duration_us: int,
            sample_rate_hz: int,
            channels: int,
        ) -> SeparationProviderResult:
            return SeparationProviderResult(
                vocal_stem=AudioOutputMetadata(
                    sample_rate_hz=sample_rate_hz,
                    channels=channels,
                    duration_us=duration_us,
                ),
                accompaniment_stem=AudioOutputMetadata(
                    sample_rate_hz=sample_rate_hz,
                    channels=channels,
                    duration_us=duration_us,
                ),
                isolated_speech=AudioOutputMetadata(
                    sample_rate_hz=16_000,
                    channels=1,
                    duration_us=duration_us,
                ),
            )

    with pytest.raises(MediaExecutionError) as output_error:
        await _service(
            tmp_path,
            FakeStorage(),
            separation=MissingOutputProvider(),
        ).separate(_separation_request())
    assert output_error.value.code == "SPEECH_OUTPUT_INVALID"


@pytest.mark.anyio
async def test_invalid_exclusive_turns_and_separation_metadata_fail_closed(
    tmp_path: Path,
) -> None:
    class OverlappingExclusiveProvider(FakeDiarizationProvider):
        async def diarize(
            self,
            source: Path,
            *,
            duration_us: int,
        ) -> DiarizationProviderResult:
            result = await super().diarize(source, duration_us=duration_us)
            return DiarizationProviderResult(
                turns=result.turns,
                exclusive_turns=[
                    ProviderSpeakerTurn(
                        start_us=100,
                        end_us=500,
                        provider_speaker_label="A",
                    ),
                    ProviderSpeakerTurn(
                        start_us=400,
                        end_us=600,
                        provider_speaker_label="B",
                    ),
                ],
            )

    with pytest.raises(MediaExecutionError) as exclusive_error:
        await _service(
            tmp_path,
            FakeStorage(),
            diarization=OverlappingExclusiveProvider(),
        ).diarize(_diarization_request())
    assert exclusive_error.value.code == "DIARIZATION_EXCLUSIVE_TIMELINE_INVALID"

    class WrongFormatProvider(FakeSeparationProvider):
        async def separate(
            self,
            source: Path,
            outputs: SeparationOutputPaths,
            *,
            duration_us: int,
            sample_rate_hz: int,
            channels: int,
        ) -> SeparationProviderResult:
            result = await super().separate(
                source,
                outputs,
                duration_us=duration_us,
                sample_rate_hz=sample_rate_hz,
                channels=channels,
            )
            return result.model_copy(
                update={
                    "isolated_speech": AudioOutputMetadata(
                        sample_rate_hz=48_000,
                        channels=2,
                        duration_us=duration_us,
                    )
                }
            )

    with pytest.raises(MediaExecutionError) as format_error:
        await _service(
            tmp_path,
            FakeStorage(),
            separation=WrongFormatProvider(),
        ).separate(_separation_request())
    assert format_error.value.code == "SPEECH_OUTPUT_FORMAT_INVALID"


def test_request_contract_rejects_unsafe_or_ambiguous_object_keys() -> None:
    request = _separation_request().model_dump(mode="json", by_alias=True)
    request["manifestKey"] = "../escape.json"
    with pytest.raises(ValidationError, match="opaque relative key"):
        VocalSeparationRequest.model_validate(request)

    request = _separation_request().model_dump(mode="json", by_alias=True)
    request["manifestKey"] = request["vocalStemKey"]
    with pytest.raises(ValidationError, match="must be distinct"):
        VocalSeparationRequest.model_validate(request)

    with pytest.raises(ValidationError, match="half-open"):
        TranscriptWord(
            ordinal=0,
            start_us=100,
            end_us=100,
            text="invalid",
        )

    with pytest.raises(ValidationError, match="words must not overlap"):
        TranscriptSegment(
            ordinal=0,
            start_us=0,
            end_us=1_000,
            text="overlapping words",
            words=[
                TranscriptWord(ordinal=0, start_us=0, end_us=600, text="first"),
                TranscriptWord(ordinal=1, start_us=500, end_us=1_000, text="second"),
            ],
        )

    with pytest.raises(ValidationError, match="at most 100 characters"):
        ProviderSpeakerTurn(
            start_us=0,
            end_us=1,
            provider_speaker_label="s" * 101,
        )


def _payload(
    request: VocalSeparationRequest | TranscriptionRequest | SpeakerDiarizationRequest,
) -> dict[str, Any]:
    return request.model_dump(mode="json", by_alias=True)


async def _api_client(
    tmp_path: Path,
    *,
    settings: Settings,
    storage: FakeStorage,
    separation: FakeSeparationProvider | None = None,
    transcription: FakeTranscriptionProvider | None = None,
    diarization: FakeDiarizationProvider | None = None,
) -> AsyncIterator[AsyncClient]:
    toolchain = FakeAudioProbe()
    app = create_app(
        settings,
        # Exercise the production wiring: when no dedicated speech probe is
        # supplied, the resolved media toolchain is also the independent probe.
        media_toolchain=cast("MediaToolchain", toolchain),
        vocal_separation_provider=separation,
        transcription_provider=transcription,
        diarization_provider=diarization,
        speech_object_store=cast("ObjectStore", storage),
    )
    async with (
        LifespanManager(app) as manager,
        AsyncClient(
            transport=ASGITransport(app=manager.app),
            base_url="http://testserver",
        ) as client,
    ):
        yield client


@pytest.mark.anyio
async def test_internal_speech_endpoints_require_auth_and_enforce_bucket_scope(
    tmp_path: Path,
) -> None:
    storage = FakeStorage()
    provider = FakeTranscriptionProvider()
    async for client in _api_client(
        tmp_path,
        settings=_settings(tmp_path),
        storage=storage,
        transcription=provider,
    ):
        unauthorized = await client.post(
            "/internal/v1/transcriptions",
            json=_payload(_transcription_request()),
        )
        forbidden_payload = _payload(_transcription_request())
        forbidden_payload["bucket"] = "another-valid-bucket"
        forbidden = await client.post(
            "/internal/v1/transcriptions",
            json=forbidden_payload,
            headers={"Authorization": f"Bearer {TOKEN}"},
        )
        authorized = await client.post(
            "/internal/v1/transcriptions",
            json=_payload(_transcription_request()),
            headers={"Authorization": f"Bearer {TOKEN}"},
        )

    assert unauthorized.status_code == 401
    assert forbidden.status_code == 403
    assert authorized.status_code == 200
    assert authorized.json()["summary"]["wordCount"] == 2
    assert provider.calls == 1


@pytest.mark.anyio
async def test_speech_guard_authenticates_before_reading_and_bounds_chunked_bodies(
    tmp_path: Path,
) -> None:
    provider = FakeTranscriptionProvider()
    settings = _settings(tmp_path, speech_max_request_body_bytes=4_096)
    async for client in _api_client(
        tmp_path,
        settings=settings,
        storage=FakeStorage(),
        transcription=provider,
    ):
        unauthorized_stream = ExplodingRequestStream()
        unauthorized = await client.post(
            "/internal/v1/transcriptions",
            content=unauthorized_stream,
            headers={"Content-Type": "application/json"},
        )

        declared_oversize_stream = ExplodingRequestStream()
        declared_oversize = await client.post(
            "/internal/v1/transcriptions",
            content=declared_oversize_stream,
            headers={
                "Authorization": f"Bearer {TOKEN}",
                "Content-Length": "4097",
                "Content-Type": "application/json",
            },
        )

        chunked_stream = ChunkedRequestStream((b"x" * 2_048, b"x" * 2_048, b"x"))
        chunked_oversize = await client.post(
            "/internal/v1/transcriptions",
            content=chunked_stream,
            headers={
                "Authorization": f"Bearer {TOKEN}",
                "Content-Type": "application/json",
            },
        )

    assert unauthorized.status_code == 401
    assert unauthorized.json()["error"]["code"] == "AUTHENTICATION_REQUIRED"
    assert not unauthorized_stream.iterated
    assert declared_oversize.status_code == 413
    assert not declared_oversize_stream.iterated
    assert chunked_oversize.status_code == 413
    assert chunked_oversize.json()["error"]["code"] == "SPEECH_REQUEST_TOO_LARGE"
    assert chunked_stream.emitted == 3
    assert provider.calls == 0


@pytest.mark.anyio
async def test_authenticated_capability_handshake_reports_the_serving_model(
    tmp_path: Path,
) -> None:
    settings = _settings(
        tmp_path,
        speech_vocal_separation_enabled=False,
        speech_transcription_enabled=True,
        speech_diarization_enabled=False,
    )
    async for client in _api_client(
        tmp_path,
        settings=settings,
        storage=FakeStorage(),
        transcription=FakeTranscriptionProvider(),
    ):
        unauthorized = await client.get("/internal/v1/speech-capabilities/TRANSCRIPTION")
        available = await client.get(
            "/internal/v1/speech-capabilities/TRANSCRIPTION",
            headers={"Authorization": f"Bearer {TOKEN}"},
        )
        disabled = await client.get(
            "/internal/v1/speech-capabilities/SPEAKER_DIARIZATION",
            headers={"Authorization": f"Bearer {TOKEN}"},
        )

    assert unauthorized.status_code == 401
    assert available.status_code == 200
    assert available.json() == {
        "schemaVersion": "voiceverse.speech-capability.v1",
        "capability": "TRANSCRIPTION",
        "enabled": True,
        "ready": True,
        "model": {
            "provider": "test-provider",
            "modelId": "test/model",
            "modelRevision": "0123456789abcdef",
            "runtimeVersion": "1.0.0",
        },
    }
    assert disabled.status_code == 503
    assert disabled.json()["error"]["code"] == "SPEECH_CAPABILITY_DISABLED"


@pytest.mark.anyio
async def test_all_three_endpoint_contracts_and_validation_are_versioned(tmp_path: Path) -> None:
    async for client in _api_client(
        tmp_path,
        settings=_settings(tmp_path),
        storage=FakeStorage(),
        separation=FakeSeparationProvider(),
        transcription=FakeTranscriptionProvider(),
        diarization=FakeDiarizationProvider(),
    ):
        headers = {"Authorization": f"Bearer {TOKEN}"}
        separation = await client.post(
            "/internal/v1/vocal-separations",
            json=_payload(_separation_request()),
            headers=headers,
        )
        diarization = await client.post(
            "/internal/v1/speaker-diarizations",
            json=_payload(_diarization_request()),
            headers=headers,
        )
        invalid = _payload(_transcription_request())
        invalid["inputArtifact"]["kind"] = "ANALYSIS_AUDIO"
        validation = await client.post(
            "/internal/v1/transcriptions",
            json=invalid,
            headers=headers,
        )

    assert separation.status_code == 200
    assert separation.json()["schemaVersion"] == "voiceverse.separation.v1"
    assert diarization.status_code == 200
    assert diarization.json()["schemaVersion"] == "voiceverse.diarization.v1"
    assert validation.status_code == 422
    assert validation.json()["error"]["code"] == "INVALID_REQUEST"


@pytest.mark.anyio
async def test_disabled_or_missing_capability_fails_closed_and_readiness_is_unready(
    tmp_path: Path,
) -> None:
    disabled_settings = _settings(tmp_path, speech_transcription_enabled=False)
    async for client in _api_client(
        tmp_path,
        settings=disabled_settings,
        storage=FakeStorage(),
        transcription=FakeTranscriptionProvider(),
    ):
        disabled = await client.post(
            "/internal/v1/transcriptions",
            json=_payload(_transcription_request()),
            headers={"Authorization": f"Bearer {TOKEN}"},
        )
    assert disabled.status_code == 503
    assert disabled.json()["error"]["code"] == "SPEECH_CAPABILITY_DISABLED"

    only_transcription = _settings(
        tmp_path,
        speech_vocal_separation_enabled=False,
        speech_transcription_enabled=True,
        speech_diarization_enabled=False,
    )
    async for client in _api_client(
        tmp_path,
        settings=only_transcription,
        storage=FakeStorage(),
    ):
        readiness = await client.get("/health/ready")
        unavailable = await client.post(
            "/internal/v1/transcriptions",
            json=_payload(_transcription_request()),
            headers={"Authorization": f"Bearer {TOKEN}"},
        )

    assert readiness.status_code == 503
    assert readiness.json()["error"]["code"] == "SPEECH_PROVIDER_NOT_READY"
    assert unavailable.status_code == 503
    assert unavailable.json()["error"]["code"] == "SPEECH_PROVIDER_NOT_CONFIGURED"
