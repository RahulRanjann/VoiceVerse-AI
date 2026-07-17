import asyncio
import hashlib
import json
import os
import shutil
import stat
import tempfile
import time
from collections import defaultdict
from collections.abc import AsyncIterator, Awaitable, Mapping
from contextlib import asynccontextmanager
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from itertools import chain, pairwise
from pathlib import Path
from typing import Any, Protocol, TypeVar

import structlog
from pydantic import BaseModel

from voiceverse_ai.core.config import Settings
from voiceverse_ai.media.errors import MediaExecutionError
from voiceverse_ai.media.storage import ObjectStore
from voiceverse_ai.speech.errors import speech_error
from voiceverse_ai.speech.models import (
    DiarizationManifest,
    DiarizationProviderResult,
    DiarizationSpeaker,
    DiarizationSummary,
    DiarizationTurn,
    GeneratedArtifact,
    ModelDescriptor,
    ProviderSpeakerTurn,
    SeparationManifest,
    SeparationProviderResult,
    SpeakerDiarizationRequest,
    SpeakerDiarizationResponse,
    SpeechArtifactKind,
    SpeechCapability,
    Timeline,
    TranscriptionProviderResult,
    TranscriptionRequest,
    TranscriptionResponse,
    TranscriptionSummary,
    TranscriptLanguage,
    TranscriptManifest,
    VocalSeparationRequest,
    VocalSeparationResponse,
)
from voiceverse_ai.speech.providers import (
    SeparationOutputPaths,
    SpeakerDiarizationProvider,
    TranscriptionProvider,
    VocalSeparationProvider,
)

_HASH_CHUNK_SIZE = 1024 * 1024
_MAX_PROBED_DURATION_SECONDS = Decimal(86_400)
ManifestModel = TypeVar("ManifestModel", bound=BaseModel)


class ProviderReadiness(Protocol):
    @property
    def descriptor(self) -> ModelDescriptor: ...

    def is_ready(self) -> bool: ...


class SpeechAudioProbe(Protocol):
    async def probe(self, source: Path) -> Mapping[str, Any]: ...


ProviderT = TypeVar("ProviderT", bound=ProviderReadiness)


def enabled_speech_capabilities(settings: Settings) -> tuple[SpeechCapability, ...]:
    enabled: list[SpeechCapability] = []
    if settings.speech_vocal_separation_enabled:
        enabled.append(SpeechCapability.VOCAL_SEPARATION)
    if settings.speech_transcription_enabled:
        enabled.append(SpeechCapability.TRANSCRIPTION)
    if settings.speech_diarization_enabled:
        enabled.append(SpeechCapability.SPEAKER_DIARIZATION)
    return tuple(enabled)


class SpeechExecutionLimiter:
    """Rejects excess in-process work instead of creating an unbounded GPU queue."""

    def __init__(self, capacity: int) -> None:
        self._capacity = capacity
        self._active = 0
        self._lock = asyncio.Lock()

    @asynccontextmanager
    async def slot(self) -> AsyncIterator[None]:
        async with self._lock:
            if self._active >= self._capacity:
                raise speech_error(
                    "SPEECH_EXECUTOR_SATURATED",
                    "The speech executor is at its configured concurrency limit.",
                    429,
                )
            self._active += 1
        try:
            yield
        finally:
            async with self._lock:
                self._active -= 1


class SpeechExecutionService:
    """Owns verified inputs, provider isolation, and immutable speech artifacts."""

    def __init__(
        self,
        *,
        settings: Settings,
        storage: ObjectStore,
        audio_probe: SpeechAudioProbe,
        vocal_separation_provider: VocalSeparationProvider | None = None,
        transcription_provider: TranscriptionProvider | None = None,
        diarization_provider: SpeakerDiarizationProvider | None = None,
        limiter: SpeechExecutionLimiter | None = None,
    ) -> None:
        self._settings = settings
        self._storage = storage
        self._audio_probe = audio_probe
        self._vocal_separation_provider = vocal_separation_provider
        self._transcription_provider = transcription_provider
        self._diarization_provider = diarization_provider
        self._limiter = limiter or SpeechExecutionLimiter(settings.speech_max_concurrency)
        self._logger = structlog.get_logger("voiceverse_ai.speech")

    def is_ready(self, capability: SpeechCapability) -> bool:
        scratch = self._settings.speech_scratch_root
        if not scratch.is_dir() or not os.access(scratch, os.W_OK | os.X_OK):
            return False
        provider = self._provider(capability)
        if provider is None:
            return False
        try:
            return provider.is_ready()
        except Exception:  # Providers must not make readiness itself fatal.
            return False

    def capability_descriptor(self, capability: SpeechCapability) -> ModelDescriptor:
        """Return the serving identity only after a real readiness check."""
        if not self.is_ready(capability):
            raise speech_error(
                "SPEECH_PROVIDER_NOT_READY",
                "The requested speech capability provider is not ready.",
                503,
            )
        provider = self._provider(capability)
        if provider is None:  # Kept explicit for type narrowing and fail-closed behavior.
            raise speech_error(
                "SPEECH_PROVIDER_NOT_READY",
                "The requested speech capability provider is not ready.",
                503,
            )
        return provider.descriptor

    async def separate(self, request: VocalSeparationRequest) -> VocalSeparationResponse:
        provider = self._ready_provider(
            SpeechCapability.VOCAL_SEPARATION,
            self._vocal_separation_provider,
        )
        self._assert_expected_model(provider.descriptor, request.expected_model)
        self._validate_input_limits(
            request.input_artifact.byte_size,
            request.input_artifact.duration_us,
        )
        async with self._limiter.slot():
            workspace = self._create_workspace("separation")
            started_at = time.perf_counter()
            self._log_started(SpeechCapability.VOCAL_SEPARATION, request)
            try:
                source = workspace / "input.flac"
                outputs = SeparationOutputPaths(
                    vocal_stem=workspace / "vocals.flac",
                    accompaniment_stem=workspace / "accompaniment.flac",
                    isolated_speech=workspace / "isolated-speech.flac",
                )
                await self._download_input(request, source)
                result = await self._call_separation_provider(provider, source, outputs, request)
                self._validate_separation_result(request, result)
                artifacts = await _gather_all(
                    self._audio_artifact(
                        outputs.vocal_stem,
                        SpeechArtifactKind.ANALYSIS_VOCAL_STEM,
                        result.vocal_stem.sample_rate_hz,
                        result.vocal_stem.channels,
                        result.vocal_stem.duration_us,
                        request.input_artifact.duration_us,
                    ),
                    self._audio_artifact(
                        outputs.accompaniment_stem,
                        SpeechArtifactKind.ANALYSIS_ACCOMPANIMENT_STEM,
                        result.accompaniment_stem.sample_rate_hz,
                        result.accompaniment_stem.channels,
                        result.accompaniment_stem.duration_us,
                        request.input_artifact.duration_us,
                    ),
                    self._audio_artifact(
                        outputs.isolated_speech,
                        SpeechArtifactKind.ISOLATED_SPEECH_AUDIO,
                        result.isolated_speech.sample_rate_hz,
                        result.isolated_speech.channels,
                        result.isolated_speech.duration_us,
                        request.input_artifact.duration_us,
                    ),
                )
                manifest = SeparationManifest(
                    producer_version=self._settings.app_version,
                    execution_id=request.execution_id,
                    attempt_id=request.attempt_id,
                    configuration_hash=request.configuration_hash,
                    model=provider.descriptor,
                    input_artifact_id=request.input_artifact.artifact_id,
                    input_sha256=request.input_artifact.sha256,
                    timeline=Timeline(duration_us=request.input_artifact.duration_us),
                    artifacts=list(artifacts),
                )
                manifest_path = workspace / "separation-manifest.json"
                manifest_artifact = await self._manifest_artifact(
                    manifest_path,
                    manifest,
                    SpeechArtifactKind.SEPARATION_MANIFEST,
                )
                keys_and_paths = (
                    (request.vocal_stem_key, outputs.vocal_stem, artifacts[0]),
                    (request.accompaniment_stem_key, outputs.accompaniment_stem, artifacts[1]),
                    (request.isolated_speech_key, outputs.isolated_speech, artifacts[2]),
                )
                await _gather_all(
                    *(
                        self._upload(request, provider.descriptor, key, path, artifact)
                        for key, path, artifact in keys_and_paths
                    )
                )
                # The immutable manifest is the completion marker for all stems.
                await self._upload(
                    request,
                    provider.descriptor,
                    request.manifest_key,
                    manifest_path,
                    manifest_artifact,
                )
                response = VocalSeparationResponse(
                    producer_version=self._settings.app_version,
                    execution_id=request.execution_id,
                    attempt_id=request.attempt_id,
                    model=provider.descriptor,
                    artifacts=[*artifacts, manifest_artifact],
                )
                self._log_completed(
                    SpeechCapability.VOCAL_SEPARATION,
                    request,
                    started_at,
                    artifact_count=4,
                )
                return response
            except MediaExecutionError:
                self._log_failed(SpeechCapability.VOCAL_SEPARATION, request, started_at)
                raise
            finally:
                await asyncio.to_thread(shutil.rmtree, workspace, True)

    async def transcribe(self, request: TranscriptionRequest) -> TranscriptionResponse:
        provider = self._ready_provider(
            SpeechCapability.TRANSCRIPTION,
            self._transcription_provider,
        )
        self._assert_expected_model(provider.descriptor, request.expected_model)
        self._validate_input_limits(
            request.input_artifact.byte_size,
            request.input_artifact.duration_us,
        )
        async with self._limiter.slot():
            workspace = self._create_workspace("transcription")
            started_at = time.perf_counter()
            self._log_started(SpeechCapability.TRANSCRIPTION, request)
            try:
                source = workspace / "input.flac"
                await self._download_input(request, source)
                result = await self._call_transcription_provider(provider, source, request)
                self._validate_transcription_result(result, request.input_artifact.duration_us)
                manifest = TranscriptManifest(
                    producer_version=self._settings.app_version,
                    execution_id=request.execution_id,
                    attempt_id=request.attempt_id,
                    configuration_hash=request.configuration_hash,
                    model=provider.descriptor,
                    input_artifact_id=request.input_artifact.artifact_id,
                    input_sha256=request.input_artifact.sha256,
                    timeline=Timeline(duration_us=request.input_artifact.duration_us),
                    language=TranscriptLanguage(
                        requested_bcp47=request.source_language_tag,
                        detected_language=result.detected_language,
                        probability=result.language_probability,
                    ),
                    segments=result.segments,
                )
                manifest_path = workspace / "transcript-manifest.json"
                artifact = await self._manifest_artifact(
                    manifest_path,
                    manifest,
                    SpeechArtifactKind.TRANSCRIPT_MANIFEST,
                )
                await self._upload(
                    request,
                    provider.descriptor,
                    request.manifest_key,
                    manifest_path,
                    artifact,
                )
                response = TranscriptionResponse(
                    producer_version=self._settings.app_version,
                    execution_id=request.execution_id,
                    attempt_id=request.attempt_id,
                    model=provider.descriptor,
                    artifacts=[artifact],
                    summary=TranscriptionSummary(
                        detected_language=result.detected_language,
                        language_probability=result.language_probability,
                        segment_count=len(result.segments),
                        word_count=sum(len(segment.words) for segment in result.segments),
                    ),
                )
                self._log_completed(
                    SpeechCapability.TRANSCRIPTION,
                    request,
                    started_at,
                    artifact_count=1,
                )
                return response
            except MediaExecutionError:
                self._log_failed(SpeechCapability.TRANSCRIPTION, request, started_at)
                raise
            finally:
                await asyncio.to_thread(shutil.rmtree, workspace, True)

    async def diarize(self, request: SpeakerDiarizationRequest) -> SpeakerDiarizationResponse:
        provider = self._ready_provider(
            SpeechCapability.SPEAKER_DIARIZATION,
            self._diarization_provider,
        )
        self._assert_expected_model(provider.descriptor, request.expected_model)
        self._validate_input_limits(
            request.input_artifact.byte_size,
            request.input_artifact.duration_us,
        )
        async with self._limiter.slot():
            workspace = self._create_workspace("diarization")
            started_at = time.perf_counter()
            self._log_started(SpeechCapability.SPEAKER_DIARIZATION, request)
            try:
                source = workspace / "input.flac"
                await self._download_input(request, source)
                result = await self._call_diarization_provider(provider, source, request)
                speakers, turns, exclusive_turns = self._normalize_diarization(
                    result,
                    request.input_artifact.duration_us,
                )
                manifest = DiarizationManifest(
                    producer_version=self._settings.app_version,
                    execution_id=request.execution_id,
                    attempt_id=request.attempt_id,
                    configuration_hash=request.configuration_hash,
                    model=provider.descriptor,
                    input_artifact_id=request.input_artifact.artifact_id,
                    input_sha256=request.input_artifact.sha256,
                    timeline=Timeline(duration_us=request.input_artifact.duration_us),
                    speakers=speakers,
                    turns=turns,
                    exclusive_turns=exclusive_turns,
                )
                manifest_path = workspace / "diarization-manifest.json"
                artifact = await self._manifest_artifact(
                    manifest_path,
                    manifest,
                    SpeechArtifactKind.DIARIZATION_MANIFEST,
                )
                await self._upload(
                    request,
                    provider.descriptor,
                    request.manifest_key,
                    manifest_path,
                    artifact,
                )
                response = SpeakerDiarizationResponse(
                    producer_version=self._settings.app_version,
                    execution_id=request.execution_id,
                    attempt_id=request.attempt_id,
                    model=provider.descriptor,
                    artifacts=[artifact],
                    summary=DiarizationSummary(
                        speaker_count=len(speakers),
                        turn_count=len(turns),
                        exclusive_turn_count=len(exclusive_turns),
                    ),
                )
                self._log_completed(
                    SpeechCapability.SPEAKER_DIARIZATION,
                    request,
                    started_at,
                    artifact_count=1,
                )
                return response
            except MediaExecutionError:
                self._log_failed(SpeechCapability.SPEAKER_DIARIZATION, request, started_at)
                raise
            finally:
                await asyncio.to_thread(shutil.rmtree, workspace, True)

    def _provider(self, capability: SpeechCapability) -> ProviderReadiness | None:
        return {
            SpeechCapability.VOCAL_SEPARATION: self._vocal_separation_provider,
            SpeechCapability.TRANSCRIPTION: self._transcription_provider,
            SpeechCapability.SPEAKER_DIARIZATION: self._diarization_provider,
        }[capability]

    @staticmethod
    def _ready_provider(
        capability: SpeechCapability,
        provider: ProviderT | None,
    ) -> ProviderT:
        if provider is None:
            raise speech_error(
                "SPEECH_PROVIDER_NOT_CONFIGURED",
                "The requested speech capability has no configured provider.",
                503,
            )
        try:
            ready = provider.is_ready()
        except Exception:
            ready = False
        if not ready:
            raise speech_error(
                "SPEECH_PROVIDER_NOT_READY",
                "The requested speech capability provider is not ready.",
                503,
            )
        return provider

    @staticmethod
    def _assert_expected_model(
        serving: ModelDescriptor,
        expected: ModelDescriptor,
    ) -> None:
        if serving != expected:
            raise speech_error(
                "SPEECH_PROVIDER_MODEL_MISMATCH",
                "The serving speech model does not match the requested immutable identity.",
                409,
            )

    def _create_workspace(self, capability: str) -> Path:
        try:
            path = Path(
                tempfile.mkdtemp(
                    prefix=f"voiceverse-{capability}-",
                    dir=self._settings.speech_scratch_root,
                )
            )
            path.chmod(0o700)
            return path
        except OSError as error:
            raise speech_error(
                "SPEECH_SCRATCH_UNAVAILABLE",
                "Secure speech scratch space is unavailable.",
                507,
            ) from error

    def _validate_input_limits(self, byte_size: int, duration_us: int) -> None:
        if byte_size > self._settings.speech_max_input_bytes:
            raise speech_error(
                "SPEECH_INPUT_TOO_LARGE",
                "The speech input exceeds the configured size limit.",
                413,
            )
        if duration_us > self._settings.speech_max_duration_seconds * 1_000_000:
            raise speech_error(
                "SPEECH_INPUT_TOO_LONG",
                "The speech input exceeds the configured duration limit.",
                413,
            )

    async def _download_input(
        self,
        request: VocalSeparationRequest | TranscriptionRequest | SpeakerDiarizationRequest,
        destination: Path,
    ) -> None:
        artifact = request.input_artifact
        await self._storage.download_verified(
            bucket=request.bucket,
            key=artifact.storage_key,
            destination=destination,
            expected_size=artifact.byte_size,
            expected_sha256=artifact.sha256,
            max_size=self._settings.speech_max_input_bytes,
        )

    async def _call_separation_provider(
        self,
        provider: VocalSeparationProvider,
        source: Path,
        outputs: SeparationOutputPaths,
        request: VocalSeparationRequest,
    ) -> SeparationProviderResult:
        try:
            async with asyncio.timeout(self._settings.speech_vocal_separation_timeout_seconds):
                return await provider.separate(
                    source,
                    outputs,
                    duration_us=request.input_artifact.duration_us,
                    sample_rate_hz=request.input_artifact.sample_rate_hz,
                    channels=request.input_artifact.channels,
                )
        except TimeoutError as error:
            raise speech_error(
                "VOCAL_SEPARATION_PROVIDER_TIMEOUT",
                "The vocal-separation provider exceeded its execution deadline.",
                504,
            ) from error
        except MediaExecutionError:
            raise
        except Exception as error:
            raise speech_error(
                "VOCAL_SEPARATION_PROVIDER_FAILED",
                "The vocal-separation provider failed.",
                502,
            ) from error

    async def _call_transcription_provider(
        self,
        provider: TranscriptionProvider,
        source: Path,
        request: TranscriptionRequest,
    ) -> TranscriptionProviderResult:
        try:
            async with asyncio.timeout(self._settings.speech_transcription_timeout_seconds):
                return await provider.transcribe(
                    source,
                    duration_us=request.input_artifact.duration_us,
                    source_language_tag=request.source_language_tag,
                )
        except TimeoutError as error:
            raise speech_error(
                "TRANSCRIPTION_PROVIDER_TIMEOUT",
                "The transcription provider exceeded its execution deadline.",
                504,
            ) from error
        except MediaExecutionError:
            raise
        except Exception as error:
            raise speech_error(
                "TRANSCRIPTION_PROVIDER_FAILED",
                "The transcription provider failed.",
                502,
            ) from error

    async def _call_diarization_provider(
        self,
        provider: SpeakerDiarizationProvider,
        source: Path,
        request: SpeakerDiarizationRequest,
    ) -> DiarizationProviderResult:
        try:
            async with asyncio.timeout(self._settings.speech_diarization_timeout_seconds):
                return await provider.diarize(
                    source,
                    duration_us=request.input_artifact.duration_us,
                )
        except TimeoutError as error:
            raise speech_error(
                "DIARIZATION_PROVIDER_TIMEOUT",
                "The speaker-diarization provider exceeded its execution deadline.",
                504,
            ) from error
        except MediaExecutionError:
            raise
        except Exception as error:
            raise speech_error(
                "DIARIZATION_PROVIDER_FAILED",
                "The speaker-diarization provider failed.",
                502,
            ) from error

    def _validate_separation_result(
        self,
        request: VocalSeparationRequest,
        result: SeparationProviderResult,
    ) -> None:
        expected_duration = request.input_artifact.duration_us
        for metadata in (
            result.vocal_stem,
            result.accompaniment_stem,
            result.isolated_speech,
        ):
            if (
                abs(metadata.duration_us - expected_duration)
                > self._settings.speech_timeline_tolerance_us
            ):
                raise speech_error(
                    "SPEECH_OUTPUT_TIMELINE_INVALID",
                    "A generated speech artifact does not preserve the source timeline.",
                    500,
                )
        for metadata in (result.vocal_stem, result.accompaniment_stem):
            if (
                metadata.sample_rate_hz != request.input_artifact.sample_rate_hz
                or metadata.channels != request.input_artifact.channels
            ):
                raise speech_error(
                    "SPEECH_OUTPUT_FORMAT_INVALID",
                    "A generated speech artifact has an invalid audio format.",
                    500,
                )
        if result.isolated_speech.sample_rate_hz != 16_000 or result.isolated_speech.channels != 1:
            raise speech_error(
                "SPEECH_OUTPUT_FORMAT_INVALID",
                "Isolated speech must be generated as 16 kHz mono audio.",
                500,
            )

    @staticmethod
    def _validate_transcription_result(
        result: TranscriptionProviderResult,
        duration_us: int,
    ) -> None:
        previous: tuple[int, int] | None = None
        for expected_ordinal, segment in enumerate(result.segments):
            if segment.ordinal != expected_ordinal:
                raise speech_error(
                    "TRANSCRIPT_TIMELINE_INVALID",
                    "The transcription provider returned invalid segment ordinals.",
                    500,
                )
            if segment.end_us > duration_us:
                raise speech_error(
                    "TRANSCRIPT_TIMELINE_INVALID",
                    "The transcription provider returned an out-of-range timestamp.",
                    500,
                )
            current = (segment.start_us, segment.end_us)
            if previous is not None and segment.start_us < previous[1]:
                raise speech_error(
                    "TRANSCRIPT_TIMELINE_INVALID",
                    "The transcription provider returned overlapping timestamps.",
                    500,
                )
            previous_word_end: int | None = None
            for expected_word_ordinal, word in enumerate(segment.words):
                if (
                    word.ordinal != expected_word_ordinal
                    or word.start_us < segment.start_us
                    or word.end_us > segment.end_us
                    or (previous_word_end is not None and word.start_us < previous_word_end)
                ):
                    raise speech_error(
                        "TRANSCRIPT_TIMELINE_INVALID",
                        "The transcription provider returned overlapping word timestamps.",
                        500,
                    )
                previous_word_end = word.end_us
            previous = current

    @staticmethod
    def _normalize_diarization(
        result: DiarizationProviderResult,
        duration_us: int,
    ) -> tuple[list[DiarizationSpeaker], list[DiarizationTurn], list[DiarizationTurn]]:
        regular = sorted(
            result.turns,
            key=lambda turn: (turn.start_us, turn.end_us, turn.provider_speaker_label),
        )
        exclusive = sorted(
            result.exclusive_turns,
            key=lambda turn: (turn.start_us, turn.end_us, turn.provider_speaker_label),
        )
        for turn in chain(regular, exclusive):
            if turn.end_us > duration_us:
                raise speech_error(
                    "DIARIZATION_TIMELINE_INVALID",
                    "The diarization provider returned an out-of-range timestamp.",
                    500,
                )
        for previous, current in pairwise(exclusive):
            if current.start_us < previous.end_us:
                raise speech_error(
                    "DIARIZATION_EXCLUSIVE_TIMELINE_INVALID",
                    "Exclusive diarization turns must not overlap.",
                    500,
                )

        first_turn: dict[str, int] = {}
        total_speech: defaultdict[str, int] = defaultdict(int)
        source_for_statistics = regular if regular else exclusive
        for turn in source_for_statistics:
            label = turn.provider_speaker_label
            first_turn[label] = min(first_turn.get(label, turn.start_us), turn.start_us)
            total_speech[label] += turn.end_us - turn.start_us
        # Include a label that exists only in the exclusive representation.
        regular_labels = set(total_speech)
        for turn in exclusive:
            label = turn.provider_speaker_label
            first_turn[label] = min(first_turn.get(label, turn.start_us), turn.start_us)
            if label not in regular_labels:
                total_speech[label] += turn.end_us - turn.start_us

        ordered_labels = sorted(
            first_turn,
            key=lambda label: (first_turn[label], -total_speech[label], label),
        )
        keys = {label: f"speaker-{index:04d}" for index, label in enumerate(ordered_labels, 1)}
        speakers = [
            DiarizationSpeaker(
                local_speaker_key=keys[label],
                provider_label=label,
                first_turn_us=first_turn[label],
                total_speech_us=total_speech[label],
            )
            for label in ordered_labels
        ]

        def normalized_turns(source: list[ProviderSpeakerTurn]) -> list[DiarizationTurn]:
            return [
                DiarizationTurn(
                    ordinal=ordinal,
                    start_us=turn.start_us,
                    end_us=turn.end_us,
                    speaker_key=keys[turn.provider_speaker_label],
                )
                for ordinal, turn in enumerate(source)
            ]

        return speakers, normalized_turns(regular), normalized_turns(exclusive)

    async def _audio_artifact(
        self,
        path: Path,
        kind: SpeechArtifactKind,
        sample_rate_hz: int,
        channels: int,
        declared_duration_us: int,
        expected_timeline_duration_us: int,
    ) -> GeneratedArtifact:
        try:
            before = self._validated_regular_file(path, self._settings.speech_max_output_bytes)
            try:
                document = await self._audio_probe.probe(path)
            except Exception as error:
                raise speech_error(
                    "SPEECH_OUTPUT_INVALID",
                    "A generated speech artifact failed independent decoding validation.",
                    500,
                ) from error
            measured_sample_rate, measured_channels, measured_duration = (
                self._validate_measured_audio(document)
            )
            if (
                measured_sample_rate != sample_rate_hz
                or measured_channels != channels
                or abs(measured_duration - declared_duration_us)
                > self._settings.speech_timeline_tolerance_us
                or abs(measured_duration - expected_timeline_duration_us)
                > self._settings.speech_timeline_tolerance_us
            ):
                raise speech_error(
                    "SPEECH_OUTPUT_INVALID",
                    "A generated speech artifact does not match its measured audio metadata.",
                    500,
                )
            after_probe = self._validated_regular_file(path, self._settings.speech_max_output_bytes)
            self._assert_unchanged_output(before, after_probe)
            sha256, after_hash = await asyncio.to_thread(
                self._hash_verified_output,
                path,
                after_probe,
                self._settings.speech_max_output_bytes,
            )
        except MediaExecutionError:
            raise
        except OSError as error:
            raise speech_error(
                "SPEECH_OUTPUT_INVALID",
                "A generated speech artifact could not be validated.",
                500,
            ) from error
        return GeneratedArtifact(
            kind=kind,
            media_type="audio/flac",
            size_bytes=after_hash.st_size,
            sha256=sha256,
            codec_name="flac",
            sample_rate_hz=measured_sample_rate,
            channels=measured_channels,
            duration_us=measured_duration,
        )

    async def _manifest_artifact(
        self,
        path: Path,
        manifest: ManifestModel,
        kind: SpeechArtifactKind,
    ) -> GeneratedArtifact:
        try:
            await asyncio.to_thread(
                _write_manifest,
                path,
                manifest,
                self._settings.speech_max_manifest_bytes,
            )
            size = self._validated_output_size(path, self._settings.speech_max_manifest_bytes)
            sha256 = await asyncio.to_thread(_sha256_file, path)
        except MediaExecutionError:
            raise
        except OSError as error:
            raise speech_error(
                "SPEECH_MANIFEST_WRITE_FAILED",
                "A speech manifest could not be written to secure scratch space.",
                507,
            ) from error
        return GeneratedArtifact(
            kind=kind,
            media_type="application/json",
            size_bytes=size,
            sha256=sha256,
        )

    @staticmethod
    def _validated_output_size(path: Path, maximum: int) -> int:
        return SpeechExecutionService._validated_regular_file(path, maximum).st_size

    @staticmethod
    def _validated_regular_file(path: Path, maximum: int) -> os.stat_result:
        try:
            information = path.lstat()
        except OSError as error:
            raise speech_error(
                "SPEECH_OUTPUT_INVALID",
                "A speech provider did not generate a valid output artifact.",
                500,
            ) from error
        return SpeechExecutionService._validate_regular_stat(information, maximum)

    @staticmethod
    def _validate_regular_stat(information: os.stat_result, maximum: int) -> os.stat_result:
        if not stat.S_ISREG(information.st_mode) or information.st_size <= 0:
            raise speech_error(
                "SPEECH_OUTPUT_INVALID",
                "A speech provider did not generate a non-empty regular output artifact.",
                500,
            )
        if information.st_size > maximum:
            raise speech_error(
                "SPEECH_OUTPUT_TOO_LARGE",
                "A speech output exceeds the configured size limit.",
                413,
            )
        return information

    @staticmethod
    def _hash_verified_output(
        path: Path,
        expected: os.stat_result,
        maximum: int,
    ) -> tuple[str, os.stat_result]:
        flags = os.O_RDONLY
        flags |= getattr(os, "O_CLOEXEC", 0)
        flags |= getattr(os, "O_NOFOLLOW", 0)
        flags |= getattr(os, "O_NONBLOCK", 0)
        descriptor = os.open(path, flags)
        try:
            opened = SpeechExecutionService._validate_regular_stat(os.fstat(descriptor), maximum)
            SpeechExecutionService._assert_unchanged_output(expected, opened)
            os.fchmod(descriptor, 0o600)
            secured = SpeechExecutionService._validate_regular_stat(os.fstat(descriptor), maximum)
            digest = hashlib.sha256()
            while chunk := os.read(descriptor, _HASH_CHUNK_SIZE):
                digest.update(chunk)
            after_hash = SpeechExecutionService._validate_regular_stat(
                os.fstat(descriptor), maximum
            )
            SpeechExecutionService._assert_unchanged_output(secured, after_hash)
        finally:
            os.close(descriptor)

        path_after_hash = SpeechExecutionService._validated_regular_file(path, maximum)
        SpeechExecutionService._assert_unchanged_output(after_hash, path_after_hash)
        return digest.hexdigest(), after_hash

    @staticmethod
    def _assert_unchanged_output(before: os.stat_result, after: os.stat_result) -> None:
        if (
            before.st_dev,
            before.st_ino,
            before.st_size,
            before.st_mode,
            before.st_mtime_ns,
            before.st_ctime_ns,
        ) != (
            after.st_dev,
            after.st_ino,
            after.st_size,
            after.st_mode,
            after.st_mtime_ns,
            after.st_ctime_ns,
        ):
            raise speech_error(
                "SPEECH_OUTPUT_CHANGED_DURING_VALIDATION",
                "A generated speech artifact changed while it was being validated.",
                500,
            )

    def _validate_measured_audio(self, document: object) -> tuple[int, int, int]:
        if not isinstance(document, Mapping):
            raise speech_error(
                "SPEECH_OUTPUT_INVALID",
                "A generated speech artifact has no decodable audio metadata.",
                500,
            )
        streams = document.get("streams")
        media_format = document.get("format")
        if not isinstance(streams, list) or not isinstance(media_format, Mapping):
            raise speech_error(
                "SPEECH_OUTPUT_INVALID",
                "A generated speech artifact has no decodable audio metadata.",
                500,
            )
        audio_streams = [
            stream
            for stream in streams
            if isinstance(stream, Mapping) and stream.get("codec_type") == "audio"
        ]
        format_name = media_format.get("format_name")
        formats = (
            {part.strip() for part in format_name.split(",")}
            if isinstance(format_name, str)
            else set()
        )
        if len(streams) != 1 or len(audio_streams) != 1 or "flac" not in formats:
            raise speech_error(
                "SPEECH_OUTPUT_INVALID",
                "A generated speech artifact is not a single-stream FLAC file.",
                500,
            )
        audio = audio_streams[0]
        sample_rate = _positive_integer(audio.get("sample_rate"))
        channels = _positive_integer(audio.get("channels"))
        if sample_rate is None or channels is None:
            raise speech_error(
                "SPEECH_OUTPUT_INVALID",
                "A generated speech artifact has invalid audio metadata.",
                500,
            )
        format_duration_us = _microseconds(media_format.get("duration"))
        stream_duration_us = _microseconds(audio.get("duration"))
        duration_us = format_duration_us or stream_duration_us
        if audio.get("codec_name") != "flac" or duration_us is None:
            raise speech_error(
                "SPEECH_OUTPUT_INVALID",
                "A generated speech artifact has invalid audio metadata.",
                500,
            )
        if (
            format_duration_us is not None
            and stream_duration_us is not None
            and abs(format_duration_us - stream_duration_us)
            > self._settings.speech_timeline_tolerance_us
        ):
            raise speech_error(
                "SPEECH_OUTPUT_INVALID",
                "A generated speech artifact has inconsistent duration metadata.",
                500,
            )
        return sample_rate, channels, duration_us

    async def _upload(
        self,
        request: VocalSeparationRequest | TranscriptionRequest | SpeakerDiarizationRequest,
        descriptor: ModelDescriptor,
        key: str,
        path: Path,
        artifact: GeneratedArtifact,
    ) -> None:
        metadata = {
            "artifact-kind": artifact.kind.value.lower(),
            "execution-id": str(request.execution_id),
            "attempt-id": str(request.attempt_id),
            "configuration-hash": request.configuration_hash,
            "producer": "voiceverse-speech-executor",
            "producer-version": self._settings.app_version,
            "provider": descriptor.provider,
            "model-id": descriptor.model_id,
            "model-revision": descriptor.model_revision,
            "runtime-version": descriptor.runtime_version,
            "contract-version": _contract_version(artifact.kind),
            "input-sha256": request.input_artifact.sha256,
        }
        await self._storage.upload_immutable(
            bucket=request.bucket,
            key=key,
            source=path,
            media_type=artifact.media_type,
            sha256=artifact.sha256,
            metadata=metadata,
        )

    def _log_started(
        self,
        capability: SpeechCapability,
        request: VocalSeparationRequest | TranscriptionRequest | SpeakerDiarizationRequest,
    ) -> None:
        self._logger.info(
            "speech_execution_started",
            capability=capability.value,
            execution_id=str(request.execution_id),
            attempt_id=str(request.attempt_id),
            input_duration_us=request.input_artifact.duration_us,
        )

    def _log_completed(
        self,
        capability: SpeechCapability,
        request: VocalSeparationRequest | TranscriptionRequest | SpeakerDiarizationRequest,
        started_at: float,
        *,
        artifact_count: int,
    ) -> None:
        self._logger.info(
            "speech_execution_completed",
            capability=capability.value,
            execution_id=str(request.execution_id),
            attempt_id=str(request.attempt_id),
            duration_ms=round((time.perf_counter() - started_at) * 1_000, 2),
            artifact_count=artifact_count,
        )

    def _log_failed(
        self,
        capability: SpeechCapability,
        request: VocalSeparationRequest | TranscriptionRequest | SpeakerDiarizationRequest,
        started_at: float,
    ) -> None:
        self._logger.warning(
            "speech_execution_failed",
            capability=capability.value,
            execution_id=str(request.execution_id),
            attempt_id=str(request.attempt_id),
            duration_ms=round((time.perf_counter() - started_at) * 1_000, 2),
        )


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(_HASH_CHUNK_SIZE):
            digest.update(chunk)
    return digest.hexdigest()


async def _gather_all[ResultT](*operations: Awaitable[ResultT]) -> list[ResultT]:
    """Drain sibling I/O before surfacing the first deterministic failure."""
    results = await asyncio.gather(*operations, return_exceptions=True)
    completed: list[ResultT] = []
    for result in results:
        if isinstance(result, BaseException):
            raise result
        completed.append(result)
    return completed


def _microseconds(value: object) -> int | None:
    try:
        seconds = Decimal(str(value))
        if not seconds.is_finite() or seconds <= 0 or seconds > _MAX_PROBED_DURATION_SECONDS:
            return None
        microseconds = (seconds * Decimal(1_000_000)).quantize(Decimal(1), rounding=ROUND_HALF_UP)
        return int(microseconds)
    except (InvalidOperation, OverflowError, ValueError):
        return None


def _positive_integer(value: object) -> int | None:
    if isinstance(value, bool):
        return None
    try:
        parsed = int(str(value))
    except ValueError:
        return None
    return parsed if parsed > 0 else None


def _write_manifest(path: Path, manifest: BaseModel, maximum_bytes: int) -> None:
    encoder = json.JSONEncoder(
        ensure_ascii=True,
        separators=(",", ":"),
        sort_keys=True,
    )
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "wb") as output:
        written = 0
        for text_chunk in encoder.iterencode(manifest.model_dump(mode="json", by_alias=True)):
            chunk = text_chunk.encode("utf-8")
            written += len(chunk)
            if written + 1 > maximum_bytes:
                raise speech_error(
                    "SPEECH_OUTPUT_TOO_LARGE",
                    "A speech output exceeds the configured size limit.",
                    413,
                )
            output.write(chunk)
        output.write(b"\n")
        output.flush()
        os.fsync(output.fileno())


def _contract_version(kind: SpeechArtifactKind) -> str:
    if kind in {
        SpeechArtifactKind.ANALYSIS_VOCAL_STEM,
        SpeechArtifactKind.ANALYSIS_ACCOMPANIMENT_STEM,
        SpeechArtifactKind.ISOLATED_SPEECH_AUDIO,
        SpeechArtifactKind.SEPARATION_MANIFEST,
    }:
        return "voiceverse.separation.v1"
    if kind is SpeechArtifactKind.TRANSCRIPT_MANIFEST:
        return "voiceverse.transcript.v1"
    return "voiceverse.diarization.v1"
