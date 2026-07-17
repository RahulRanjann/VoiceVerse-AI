import re
from enum import StrEnum
from typing import Annotated, Self
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator
from pydantic.alias_generators import to_camel

Sha256 = Annotated[str, StringConstraints(pattern=r"^[a-f0-9]{64}$")]
BucketName = Annotated[
    str,
    StringConstraints(min_length=3, max_length=63, pattern=r"^[a-z0-9][a-z0-9.-]*[a-z0-9]$"),
]
ObjectKey = Annotated[str, StringConstraints(min_length=1, max_length=1024)]
LanguageTag = Annotated[
    str,
    StringConstraints(
        min_length=2,
        max_length=64,
        pattern=r"^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$",
    ),
]

_FORBIDDEN_KEY_SEGMENT = re.compile(r"(^|/)\.\.?(?:/|$)")


class ApiModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        validate_by_alias=True,
        validate_by_name=True,
        serialize_by_alias=True,
        extra="forbid",
    )


class MediaPreparationRequest(ApiModel):
    execution_id: UUID
    attempt_id: UUID
    bucket: BucketName
    configuration_hash: Sha256
    source_key: ObjectKey
    canonical_audio_key: ObjectKey
    analysis_audio_key: ObjectKey
    probe_manifest_key: ObjectKey
    expected_source_size_bytes: int = Field(ge=1)
    expected_source_sha256: Sha256
    preferred_audio_language_tag: LanguageTag | None = None

    @model_validator(mode="after")
    def validate_object_keys(self) -> Self:
        keys = (
            self.source_key,
            self.canonical_audio_key,
            self.analysis_audio_key,
            self.probe_manifest_key,
        )
        if len(set(keys)) != len(keys):
            raise ValueError("storage object keys must be distinct")
        for key in keys:
            if (
                key.startswith("/")
                or "\\" in key
                or any(ord(character) < 32 for character in key)
                or _FORBIDDEN_KEY_SEGMENT.search(key)
            ):
                raise ValueError("storage object key is not an opaque relative key")
        return self


class Rational(ApiModel):
    numerator: int
    denominator: int = Field(gt=0)


class AudioStreamMetadata(ApiModel):
    stream_index: int = Field(ge=0)
    codec_name: str
    profile: str | None = None
    channels: int = Field(ge=1)
    channel_layout: str | None = None
    sample_rate_hz: int = Field(ge=1)
    bit_rate: int | None = Field(default=None, ge=0)
    start_time_ms: int | None = None
    time_base: Rational | None = None
    duration_ms: int | None = Field(default=None, ge=0)
    language_tag: str | None = None
    is_default: bool


class VideoStreamMetadata(ApiModel):
    stream_index: int = Field(ge=0)
    codec_name: str
    profile: str | None = None
    width: int = Field(ge=1)
    height: int = Field(ge=1)
    frame_rate: Rational | None = None
    bit_rate: int | None = Field(default=None, ge=0)
    start_time_ms: int | None = None
    time_base: Rational | None = None
    duration_ms: int | None = Field(default=None, ge=0)
    language_tag: str | None = None
    is_default: bool


class SourceMediaMetadata(ApiModel):
    size_bytes: int = Field(ge=1)
    sha256: Sha256
    container_formats: list[str] = Field(min_length=1)
    duration_ms: int = Field(ge=0)
    bit_rate: int | None = Field(default=None, ge=0)
    audio_streams: list[AudioStreamMetadata] = Field(min_length=1)
    selected_audio: AudioStreamMetadata
    audio_selection_method: str
    audio_selection_reason: str
    preferred_audio_language_tag: str | None = None
    video_streams: list[VideoStreamMetadata] = Field(min_length=1)


class ArtifactKind(StrEnum):
    CANONICAL_AUDIO = "CANONICAL_AUDIO"
    ANALYSIS_AUDIO = "ANALYSIS_AUDIO"
    PROBE_MANIFEST = "PROBE_MANIFEST"


class ArtifactMetadata(ApiModel):
    kind: ArtifactKind
    media_type: str
    size_bytes: int = Field(ge=1)
    sha256: Sha256
    codec_name: str | None = None
    sample_rate_hz: int | None = Field(default=None, ge=1)
    channels: int | None = Field(default=None, ge=1)
    duration_ms: int | None = Field(default=None, ge=0)


class ToolVersions(ApiModel):
    ffmpeg: str
    ffprobe: str


class ProbeManifest(ApiModel):
    schema_version: str = "voiceverse.media-probe.v1"
    producer_version: str
    execution_id: UUID
    attempt_id: UUID
    source: SourceMediaMetadata
    artifacts: list[ArtifactMetadata]
    tools: ToolVersions


class MediaPreparationResponse(ProbeManifest):
    artifacts: list[ArtifactMetadata]


class ErrorBody(ApiModel):
    code: str
    message: str


class ErrorResponse(ApiModel):
    error: ErrorBody
