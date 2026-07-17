import asyncio
import hashlib
import json
import math
import shutil
import tempfile
import time
from collections.abc import Mapping
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from pathlib import Path
from typing import Any, Protocol, cast

import structlog

from voiceverse_ai.core.config import Settings
from voiceverse_ai.media.errors import MediaExecutionError, media_error
from voiceverse_ai.media.models import (
    ArtifactKind,
    ArtifactMetadata,
    AudioStreamMetadata,
    MediaPreparationRequest,
    MediaPreparationResponse,
    ProbeManifest,
    Rational,
    SourceMediaMetadata,
    ToolVersions,
    VideoStreamMetadata,
)
from voiceverse_ai.media.storage import ObjectStore
from voiceverse_ai.media.tools import MediaToolchain

_HASH_CHUNK_SIZE = 1024 * 1024
_SCRATCH_RESERVE_BYTES = 64 * 1024 * 1024


class MediaPreparationExecutor(Protocol):
    async def prepare(self, request: MediaPreparationRequest) -> MediaPreparationResponse: ...


class MediaPreparationService:
    """Creates immutable, deterministic derivatives from a verified source object."""

    def __init__(
        self,
        *,
        settings: Settings,
        storage: ObjectStore,
        toolchain: MediaToolchain,
    ) -> None:
        self._settings = settings
        self._storage = storage
        self._toolchain = toolchain
        self._logger = structlog.get_logger("voiceverse_ai.media")

    async def prepare(self, request: MediaPreparationRequest) -> MediaPreparationResponse:
        started_at = time.perf_counter()
        self._logger.info(
            "media_preparation_started",
            execution_id=str(request.execution_id),
            attempt_id=str(request.attempt_id),
        )
        workspace = self._create_workspace()
        source = workspace / "source.media"
        canonical = workspace / "canonical.flac"
        analysis = workspace / "analysis.flac"
        manifest_file = workspace / "probe-manifest.json"

        try:
            await self._storage.download_verified(
                bucket=request.bucket,
                key=request.source_key,
                destination=source,
                expected_size=request.expected_source_size_bytes,
                expected_sha256=request.expected_source_sha256,
                max_size=self._settings.media_max_input_bytes,
            )
            probe_document, versions = await asyncio.gather(
                self._toolchain.probe(source),
                self._toolchain.versions(),
            )
            source_metadata = self._normalize_source_probe(
                probe_document,
                size_bytes=request.expected_source_size_bytes,
                sha256=request.expected_source_sha256,
                preferred_language_tag=request.preferred_audio_language_tag,
            )
            self._validate_duration(source_metadata.duration_ms)
            self._validate_scratch_capacity(workspace, source_metadata)

            await self._toolchain.transcode_audio(
                source=source,
                stream_index=source_metadata.selected_audio.stream_index,
                canonical_output=canonical,
                analysis_output=analysis,
            )
            self._validate_output_size(canonical)
            self._validate_output_size(analysis)

            canonical_probe, analysis_probe, canonical_hash, analysis_hash = await asyncio.gather(
                self._toolchain.probe(canonical),
                self._toolchain.probe(analysis),
                asyncio.to_thread(_sha256_file, canonical),
                asyncio.to_thread(_sha256_file, analysis),
            )
            canonical_artifact = self._normalize_audio_artifact(
                ArtifactKind.CANONICAL_AUDIO,
                canonical,
                canonical_hash,
                canonical_probe,
                expected_sample_rate=48_000,
                expected_channels=source_metadata.selected_audio.channels,
            )
            analysis_artifact = self._normalize_audio_artifact(
                ArtifactKind.ANALYSIS_AUDIO,
                analysis,
                analysis_hash,
                analysis_probe,
                expected_sample_rate=16_000,
                expected_channels=1,
            )
            tool_versions = ToolVersions(ffmpeg=versions[0], ffprobe=versions[1])
            manifest = ProbeManifest(
                execution_id=request.execution_id,
                attempt_id=request.attempt_id,
                producer_version=self._settings.app_version,
                source=source_metadata,
                artifacts=[canonical_artifact, analysis_artifact],
                tools=tool_versions,
            )
            await asyncio.to_thread(_write_manifest, manifest_file, manifest)
            manifest_hash = await asyncio.to_thread(_sha256_file, manifest_file)
            manifest_artifact = ArtifactMetadata(
                kind=ArtifactKind.PROBE_MANIFEST,
                media_type="application/json",
                size_bytes=manifest_file.stat().st_size,
                sha256=manifest_hash,
            )

            await asyncio.gather(
                self._upload_artifact(
                    request,
                    key=request.canonical_audio_key,
                    path=canonical,
                    artifact=canonical_artifact,
                    ffmpeg_version=tool_versions.ffmpeg,
                ),
                self._upload_artifact(
                    request,
                    key=request.analysis_audio_key,
                    path=analysis,
                    artifact=analysis_artifact,
                    ffmpeg_version=tool_versions.ffmpeg,
                ),
            )
            # The manifest is uploaded last and therefore acts as the immutable
            # completeness marker for the two audio derivatives.
            await self._upload_artifact(
                request,
                key=request.probe_manifest_key,
                path=manifest_file,
                artifact=manifest_artifact,
                ffmpeg_version=tool_versions.ffmpeg,
            )

            response = MediaPreparationResponse(
                execution_id=request.execution_id,
                attempt_id=request.attempt_id,
                producer_version=self._settings.app_version,
                source=source_metadata,
                artifacts=[canonical_artifact, analysis_artifact, manifest_artifact],
                tools=tool_versions,
            )
            self._logger.info(
                "media_preparation_completed",
                execution_id=str(request.execution_id),
                attempt_id=str(request.attempt_id),
                duration_ms=round((time.perf_counter() - started_at) * 1_000, 2),
                artifact_count=3,
            )
            return response
        except MediaExecutionError as error:
            self._logger.warning(
                "media_preparation_failed",
                execution_id=str(request.execution_id),
                attempt_id=str(request.attempt_id),
                error_code=error.code,
                duration_ms=round((time.perf_counter() - started_at) * 1_000, 2),
            )
            raise
        finally:
            await asyncio.to_thread(shutil.rmtree, workspace, True)

    def _create_workspace(self) -> Path:
        try:
            path = Path(
                tempfile.mkdtemp(prefix="voiceverse-media-", dir=self._settings.media_scratch_root)
            )
            path.chmod(0o700)
            return path
        except OSError as error:
            raise media_error(
                "MEDIA_SCRATCH_UNAVAILABLE", "Secure media scratch space is unavailable.", 507
            ) from error

    def _normalize_source_probe(
        self,
        document: Mapping[str, Any],
        *,
        size_bytes: int,
        sha256: str,
        preferred_language_tag: str | None,
    ) -> SourceMediaMetadata:
        streams = document.get("streams")
        media_format = document.get("format")
        if not isinstance(streams, list) or not isinstance(media_format, dict):
            raise media_error("MEDIA_PROBE_FAILED", "Media structure could not be validated.", 422)

        audio_streams: list[AudioStreamMetadata] = []
        video_streams: list[VideoStreamMetadata] = []
        for raw_stream in streams:
            if not isinstance(raw_stream, dict):
                continue
            if raw_stream.get("codec_type") == "audio":
                audio_streams.append(self._normalize_audio_stream(raw_stream))
            elif raw_stream.get("codec_type") == "video":
                normalized_video = self._normalize_video_stream(raw_stream)
                if normalized_video is not None:
                    video_streams.append(normalized_video)

        raw_formats = str(media_format.get("format_name", ""))
        container_formats = sorted(
            {item.strip() for item in raw_formats.split(",") if item.strip()}
        )
        if not container_formats:
            raise media_error("MEDIA_PROBE_FAILED", "Media container could not be identified.", 422)
        if "mp4" not in container_formats:
            raise media_error(
                "MEDIA_CONTAINER_UNSUPPORTED",
                "Source media must use a supported MP4-family container.",
                422,
            )
        if not video_streams:
            raise media_error(
                "MEDIA_VIDEO_STREAM_MISSING", "Source media has no usable video stream.", 422
            )
        if not audio_streams:
            raise media_error(
                "MEDIA_NO_AUDIO_STREAM", "Source media has no usable audio stream.", 422
            )
        selected_audio, selection_reason = _select_audio_stream(
            audio_streams,
            preferred_language_tag,
        )
        duration_ms = _milliseconds(media_format.get("duration"))
        if duration_ms is None:
            duration_ms = selected_audio.duration_ms
        if duration_ms is None:
            raise media_error(
                "MEDIA_DURATION_UNKNOWN", "Source media duration is unavailable.", 422
            )

        return SourceMediaMetadata(
            size_bytes=size_bytes,
            sha256=sha256,
            container_formats=container_formats,
            duration_ms=duration_ms,
            bit_rate=_non_negative_int(media_format.get("bit_rate")),
            audio_streams=sorted(audio_streams, key=lambda stream: stream.stream_index),
            selected_audio=selected_audio,
            audio_selection_method="DEFAULT_THEN_LANGUAGE_THEN_LOWEST_INDEX",
            audio_selection_reason=selection_reason,
            preferred_audio_language_tag=(
                _normalize_language_tag(preferred_language_tag) if preferred_language_tag else None
            ),
            video_streams=sorted(video_streams, key=lambda stream: stream.stream_index),
        )

    @staticmethod
    def _normalize_audio_stream(raw: Mapping[str, Any]) -> AudioStreamMetadata:
        stream_index = _required_positive_int(raw.get("index"), allow_zero=True)
        channels = _required_positive_int(raw.get("channels"))
        sample_rate = _required_positive_int(raw.get("sample_rate"))
        codec_name = _required_string(raw.get("codec_name"))
        disposition = raw.get("disposition")
        is_default = isinstance(disposition, dict) and disposition.get("default") == 1
        channel_layout = raw.get("channel_layout")
        return AudioStreamMetadata(
            stream_index=stream_index,
            codec_name=codec_name,
            profile=_optional_string(raw.get("profile")),
            channels=channels,
            channel_layout=(str(channel_layout) if channel_layout else None),
            sample_rate_hz=sample_rate,
            bit_rate=_non_negative_int(raw.get("bit_rate")),
            start_time_ms=_signed_milliseconds(raw.get("start_time")),
            time_base=_rational(raw.get("time_base")),
            duration_ms=_milliseconds(raw.get("duration")),
            language_tag=_language_tag(raw),
            is_default=is_default,
        )

    @staticmethod
    def _normalize_video_stream(raw: Mapping[str, Any]) -> VideoStreamMetadata | None:
        width = _non_negative_int(raw.get("width"))
        height = _non_negative_int(raw.get("height"))
        if not width or not height:
            return None
        disposition = raw.get("disposition")
        frame_rate = _rational(raw.get("avg_frame_rate")) or _rational(raw.get("r_frame_rate"))
        return VideoStreamMetadata(
            stream_index=_required_positive_int(raw.get("index"), allow_zero=True),
            codec_name=_required_string(raw.get("codec_name")),
            profile=_optional_string(raw.get("profile")),
            width=width,
            height=height,
            frame_rate=frame_rate,
            bit_rate=_non_negative_int(raw.get("bit_rate")),
            start_time_ms=_signed_milliseconds(raw.get("start_time")),
            time_base=_rational(raw.get("time_base")),
            duration_ms=_milliseconds(raw.get("duration")),
            language_tag=_language_tag(raw),
            is_default=isinstance(disposition, dict) and disposition.get("default") == 1,
        )

    def _normalize_audio_artifact(
        self,
        kind: ArtifactKind,
        path: Path,
        sha256: str,
        document: Mapping[str, Any],
        *,
        expected_sample_rate: int,
        expected_channels: int,
    ) -> ArtifactMetadata:
        streams = document.get("streams")
        media_format = document.get("format")
        if not isinstance(streams, list) or not isinstance(media_format, dict):
            raise media_error("MEDIA_OUTPUT_INVALID", "Generated audio failed validation.", 500)
        audio = next(
            (
                stream
                for stream in streams
                if isinstance(stream, dict) and stream.get("codec_type") == "audio"
            ),
            None,
        )
        if audio is None:
            raise media_error("MEDIA_OUTPUT_INVALID", "Generated audio failed validation.", 500)
        try:
            codec = _required_string(audio.get("codec_name"))
            sample_rate = _required_positive_int(audio.get("sample_rate"))
            channels = _required_positive_int(audio.get("channels"))
        except MediaExecutionError as error:
            raise media_error(
                "MEDIA_OUTPUT_INVALID", "Generated audio failed validation.", 500
            ) from error
        if codec != "flac" or sample_rate != expected_sample_rate or channels != expected_channels:
            raise media_error("MEDIA_OUTPUT_INVALID", "Generated audio failed validation.", 500)
        duration = _milliseconds(media_format.get("duration")) or _milliseconds(
            audio.get("duration")
        )
        return ArtifactMetadata(
            kind=kind,
            media_type="audio/flac",
            size_bytes=path.stat().st_size,
            sha256=sha256,
            codec_name=codec,
            sample_rate_hz=sample_rate,
            channels=channels,
            duration_ms=duration,
        )

    def _validate_duration(self, duration_ms: int) -> None:
        if duration_ms <= 0:
            raise media_error("MEDIA_DURATION_INVALID", "Source media duration is invalid.", 422)
        if duration_ms > self._settings.media_max_duration_seconds * 1_000:
            raise media_error(
                "MEDIA_DURATION_TOO_LONG", "Source media exceeds the duration limit.", 413
            )

    def _validate_scratch_capacity(
        self, workspace: Path, source_metadata: SourceMediaMetadata
    ) -> None:
        duration_seconds = source_metadata.duration_ms / 1_000
        channels = source_metadata.selected_audio.channels
        uncompressed_estimate = math.ceil(
            duration_seconds * ((48_000 * channels * 4) + (16_000 * 4))
        )
        required = min(uncompressed_estimate, self._settings.media_max_output_bytes * 2)
        if shutil.disk_usage(workspace).free < required + _SCRATCH_RESERVE_BYTES:
            raise media_error(
                "MEDIA_SCRATCH_CAPACITY_EXCEEDED",
                "Insufficient secure scratch capacity for media processing.",
                507,
            )

    def _validate_output_size(self, output: Path) -> None:
        try:
            size = output.stat().st_size
        except FileNotFoundError as error:
            raise media_error(
                "MEDIA_OUTPUT_INVALID", "Generated audio failed validation.", 500
            ) from error
        if size <= 0:
            raise media_error("MEDIA_OUTPUT_INVALID", "Generated audio failed validation.", 500)
        if size > self._settings.media_max_output_bytes:
            raise media_error(
                "MEDIA_OUTPUT_TOO_LARGE", "Generated audio exceeds the size limit.", 413
            )

    async def _upload_artifact(
        self,
        request: MediaPreparationRequest,
        *,
        key: str,
        path: Path,
        artifact: ArtifactMetadata,
        ffmpeg_version: str,
    ) -> None:
        metadata = {
            "artifact-kind": artifact.kind.value.lower(),
            "execution-id": str(request.execution_id),
            "attempt-id": str(request.attempt_id),
            "configuration-hash": request.configuration_hash,
            "producer": "voiceverse-media-executor",
            "producer-version": self._settings.app_version,
            "ffmpeg-version": ffmpeg_version,
        }
        await self._storage.upload_immutable(
            bucket=request.bucket,
            key=key,
            source=path,
            media_type=artifact.media_type,
            sha256=artifact.sha256,
            metadata=metadata,
        )


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(_HASH_CHUNK_SIZE):
            digest.update(chunk)
    return digest.hexdigest()


def _write_manifest(path: Path, manifest: ProbeManifest) -> None:
    payload = (
        json.dumps(
            manifest.model_dump(mode="json", by_alias=True),
            ensure_ascii=True,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
        + b"\n"
    )
    path.write_bytes(payload)
    path.chmod(0o600)


def _required_string(value: object) -> str:
    if not isinstance(value, str) or not value or len(value) > 128:
        raise media_error("MEDIA_PROBE_FAILED", "Media structure could not be validated.", 422)
    return value


def _optional_string(value: object) -> str | None:
    if not isinstance(value, str) or not value or len(value) > 128:
        return None
    return value


def _language_tag(stream: Mapping[str, Any]) -> str | None:
    tags = stream.get("tags")
    if not isinstance(tags, dict):
        return None
    value = _optional_string(tags.get("language"))
    return _normalize_language_tag(value) if value else None


def _non_negative_int(value: object) -> int | None:
    if value is None or value == "N/A":
        return None
    try:
        parsed = int(cast("Any", value))
    except (TypeError, ValueError):
        return None
    return parsed if parsed >= 0 else None


def _required_positive_int(value: object, *, allow_zero: bool = False) -> int:
    parsed = _non_negative_int(value)
    if parsed is None or (parsed == 0 and not allow_zero):
        raise media_error("MEDIA_PROBE_FAILED", "Media structure could not be validated.", 422)
    return parsed


def _milliseconds(value: object) -> int | None:
    if value is None or value == "N/A":
        return None
    try:
        seconds = Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None
    if not seconds.is_finite() or seconds < 0:
        return None
    return int((seconds * 1_000).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def _signed_milliseconds(value: object) -> int | None:
    if value is None or value == "N/A":
        return None
    try:
        seconds = Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None
    if not seconds.is_finite():
        return None
    return int((seconds * 1_000).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def _rational(value: object) -> Rational | None:
    if not isinstance(value, str) or "/" not in value:
        return None
    numerator_text, denominator_text = value.split("/", maxsplit=1)
    try:
        numerator = int(numerator_text)
        denominator = int(denominator_text)
    except ValueError:
        return None
    if numerator < 0 or denominator <= 0:
        return None
    return Rational(numerator=numerator, denominator=denominator)


_ISO_639_2_TO_1 = {
    "ara": "ar",
    "ben": "bn",
    "chi": "zh",
    "deu": "de",
    "dut": "nl",
    "eng": "en",
    "fre": "fr",
    "fra": "fr",
    "ger": "de",
    "guj": "gu",
    "hin": "hi",
    "ind": "id",
    "ita": "it",
    "jpn": "ja",
    "kan": "kn",
    "kor": "ko",
    "mal": "ml",
    "mar": "mr",
    "nld": "nl",
    "pan": "pa",
    "pol": "pl",
    "por": "pt",
    "pun": "pa",
    "rus": "ru",
    "spa": "es",
    "swa": "sw",
    "tam": "ta",
    "tel": "te",
    "tha": "th",
    "tur": "tr",
    "urd": "ur",
    "vie": "vi",
    "zho": "zh",
}


def _normalize_language_tag(value: str) -> str:
    normalized = value.strip().replace("_", "-").lower()
    base, separator, remainder = normalized.partition("-")
    canonical_base = _ISO_639_2_TO_1.get(base, base)
    return f"{canonical_base}-{remainder}" if separator else canonical_base


def _language_match_rank(candidate: str | None, preferred: str | None) -> int:
    if not candidate or not preferred:
        return 2
    normalized_candidate = _normalize_language_tag(candidate)
    normalized_preferred = _normalize_language_tag(preferred)
    if normalized_candidate == normalized_preferred:
        return 0
    if (
        normalized_candidate.split("-", maxsplit=1)[0]
        == normalized_preferred.split("-", maxsplit=1)[0]
    ):
        return 1
    return 2


def _select_audio_stream(
    streams: list[AudioStreamMetadata], preferred_language_tag: str | None
) -> tuple[AudioStreamMetadata, str]:
    selected = min(
        streams,
        key=lambda stream: (
            not stream.is_default,
            _language_match_rank(stream.language_tag, preferred_language_tag),
            stream.stream_index,
        ),
    )
    default_streams = [stream for stream in streams if stream.is_default]
    language_rank = _language_match_rank(selected.language_tag, preferred_language_tag)
    if default_streams:
        if len(default_streams) > 1 and language_rank < 2:
            reason = (
                "DEFAULT_DISPOSITION_AND_PREFERRED_LANGUAGE_EXACT"
                if language_rank == 0
                else "DEFAULT_DISPOSITION_AND_PREFERRED_LANGUAGE_BASE"
            )
        else:
            reason = "DEFAULT_DISPOSITION"
    elif language_rank == 0:
        reason = "PREFERRED_LANGUAGE_EXACT"
    elif language_rank == 1:
        reason = "PREFERRED_LANGUAGE_BASE"
    else:
        reason = "LOWEST_STREAM_INDEX"
    return selected, reason
