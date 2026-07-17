import re
from enum import StrEnum
from typing import Annotated, Literal, Self
from uuid import UUID

from pydantic import Field, StringConstraints, field_validator, model_validator

from voiceverse_ai.media.models import ApiModel, BucketName, LanguageTag, ObjectKey, Sha256

TimestampUs = Annotated[int, Field(ge=0)]
PositiveDurationUs = Annotated[int, Field(gt=0)]
Probability = Annotated[float, Field(ge=0.0, le=1.0)]
SafeName = Annotated[
    str,
    StringConstraints(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9][A-Za-z0-9._:/+-]*$"),
]
ProviderName = Annotated[
    str,
    StringConstraints(min_length=1, max_length=100, pattern=r"^[A-Za-z0-9][A-Za-z0-9._:/+-]*$"),
]
ProducerVersion = Annotated[
    str,
    StringConstraints(min_length=1, max_length=100, pattern=r"^[A-Za-z0-9][A-Za-z0-9._:/+-]*$"),
]
SpeakerLabel = Annotated[
    str,
    StringConstraints(min_length=1, max_length=100, pattern=r"^[A-Za-z0-9][A-Za-z0-9._:-]*$"),
]
DetectedLanguage = Annotated[
    str,
    StringConstraints(
        min_length=2,
        max_length=35,
        pattern=r"^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$",
    ),
]

_FORBIDDEN_KEY_SEGMENT = re.compile(r"(^|/)\.\.?(?:/|$)")


class SpeechCapability(StrEnum):
    VOCAL_SEPARATION = "VOCAL_SEPARATION"
    TRANSCRIPTION = "TRANSCRIPTION"
    SPEAKER_DIARIZATION = "SPEAKER_DIARIZATION"


class SpeechInputArtifactKind(StrEnum):
    CANONICAL_AUDIO = "CANONICAL_AUDIO"
    ANALYSIS_AUDIO = "ANALYSIS_AUDIO"
    ISOLATED_SPEECH_AUDIO = "ISOLATED_SPEECH_AUDIO"


class SpeechArtifactKind(StrEnum):
    ANALYSIS_VOCAL_STEM = "ANALYSIS_VOCAL_STEM"
    ANALYSIS_ACCOMPANIMENT_STEM = "ANALYSIS_ACCOMPANIMENT_STEM"
    ISOLATED_SPEECH_AUDIO = "ISOLATED_SPEECH_AUDIO"
    SEPARATION_MANIFEST = "SEPARATION_MANIFEST"
    TRANSCRIPT_MANIFEST = "TRANSCRIPT_MANIFEST"
    DIARIZATION_MANIFEST = "DIARIZATION_MANIFEST"


class ModelDescriptor(ApiModel):
    provider: ProviderName
    model_id: SafeName
    model_revision: SafeName
    runtime_version: SafeName


class SpeechCapabilityReadinessResponse(ApiModel):
    schema_version: Literal["voiceverse.speech-capability.v1"] = "voiceverse.speech-capability.v1"
    capability: SpeechCapability
    enabled: Literal[True] = True
    ready: Literal[True] = True
    model: ModelDescriptor


class SpeechArtifactReference(ApiModel):
    artifact_id: UUID
    kind: SpeechInputArtifactKind
    storage_key: ObjectKey
    byte_size: int = Field(gt=0)
    sha256: Sha256
    media_type: Literal["audio/flac"]
    duration_us: PositiveDurationUs
    sample_rate_hz: int = Field(gt=0, le=384_000)
    channels: int = Field(gt=0, le=32)

    @field_validator("storage_key")
    @classmethod
    def validate_storage_key(cls, value: str) -> str:
        return _validate_object_key(value)


class SpeechExecutionRequest(ApiModel):
    execution_id: UUID
    attempt_id: UUID
    bucket: BucketName
    configuration_hash: Sha256
    expected_model: ModelDescriptor
    input_artifact: SpeechArtifactReference


class VocalSeparationRequest(SpeechExecutionRequest):
    vocal_stem_key: ObjectKey
    accompaniment_stem_key: ObjectKey
    isolated_speech_key: ObjectKey
    manifest_key: ObjectKey

    @model_validator(mode="after")
    def validate_contract(self) -> Self:
        if self.input_artifact.kind is not SpeechInputArtifactKind.CANONICAL_AUDIO:
            raise ValueError("vocal separation requires canonical audio")
        output_keys = (
            self.vocal_stem_key,
            self.accompaniment_stem_key,
            self.isolated_speech_key,
            self.manifest_key,
        )
        _validate_output_keys(self.input_artifact.storage_key, output_keys)
        return self


class TranscriptionRequest(SpeechExecutionRequest):
    source_language_tag: LanguageTag
    manifest_key: ObjectKey

    @model_validator(mode="after")
    def validate_contract(self) -> Self:
        if self.input_artifact.kind is not SpeechInputArtifactKind.ISOLATED_SPEECH_AUDIO:
            raise ValueError("transcription requires isolated speech audio")
        if self.input_artifact.sample_rate_hz != 16_000 or self.input_artifact.channels != 1:
            raise ValueError("transcription input must be 16 kHz mono")
        _validate_output_keys(self.input_artifact.storage_key, (self.manifest_key,))
        return self


class SpeakerDiarizationRequest(SpeechExecutionRequest):
    manifest_key: ObjectKey

    @model_validator(mode="after")
    def validate_contract(self) -> Self:
        if self.input_artifact.kind is not SpeechInputArtifactKind.ANALYSIS_AUDIO:
            raise ValueError("speaker diarization requires analysis audio")
        if self.input_artifact.sample_rate_hz != 16_000 or self.input_artifact.channels != 1:
            raise ValueError("speaker diarization input must be 16 kHz mono")
        _validate_output_keys(self.input_artifact.storage_key, (self.manifest_key,))
        return self


class GeneratedArtifact(ApiModel):
    kind: SpeechArtifactKind
    media_type: Literal["audio/flac", "application/json"]
    size_bytes: int = Field(gt=0)
    sha256: Sha256
    codec_name: str | None = Field(default=None, min_length=1, max_length=40)
    sample_rate_hz: int | None = Field(default=None, gt=0, le=384_000)
    channels: int | None = Field(default=None, gt=0, le=32)
    duration_us: PositiveDurationUs | None = None


class AudioOutputMetadata(ApiModel):
    codec_name: Literal["flac"] = "flac"
    media_type: Literal["audio/flac"] = "audio/flac"
    sample_rate_hz: int = Field(gt=0, le=384_000)
    channels: int = Field(gt=0, le=32)
    duration_us: PositiveDurationUs


class SeparationProviderResult(ApiModel):
    vocal_stem: AudioOutputMetadata
    accompaniment_stem: AudioOutputMetadata
    isolated_speech: AudioOutputMetadata


class Timeline(ApiModel):
    origin_us: Literal[0] = 0
    duration_us: PositiveDurationUs
    interval_convention: Literal["HALF_OPEN"] = "HALF_OPEN"


class TranscriptWord(ApiModel):
    ordinal: int = Field(ge=0)
    start_us: TimestampUs
    end_us: PositiveDurationUs
    text: str = Field(min_length=1, max_length=512)
    probability: Probability | None = None

    @model_validator(mode="after")
    def validate_interval(self) -> Self:
        if self.end_us <= self.start_us:
            raise ValueError("word interval must be half-open and non-empty")
        return self


class TranscriptSegment(ApiModel):
    ordinal: int = Field(ge=0)
    start_us: TimestampUs
    end_us: PositiveDurationUs
    text: str = Field(min_length=1, max_length=20_000)
    average_log_probability: float | None = Field(default=None, ge=-100, le=0)
    no_speech_probability: Probability | None = None
    words: list[TranscriptWord] = Field(default_factory=list, max_length=50_000)

    @model_validator(mode="after")
    def validate_timeline(self) -> Self:
        if self.end_us <= self.start_us:
            raise ValueError("segment interval must be half-open and non-empty")
        previous: tuple[int, int] | None = None
        for expected_ordinal, word in enumerate(self.words):
            if word.ordinal != expected_ordinal:
                raise ValueError("word ordinals must be contiguous")
            if word.start_us < self.start_us or word.end_us > self.end_us:
                raise ValueError("word interval must be contained by its segment")
            current = (word.start_us, word.end_us)
            if previous is not None and word.start_us < previous[1]:
                raise ValueError("words must not overlap")
            previous = current
        return self


class TranscriptionProviderResult(ApiModel):
    detected_language: DetectedLanguage
    language_probability: Probability | None = None
    segments: list[TranscriptSegment] = Field(default_factory=list, max_length=250_000)


class TranscriptLanguage(ApiModel):
    requested_bcp47: LanguageTag
    detected_language: DetectedLanguage
    probability: Probability | None = None


class TranscriptManifest(ApiModel):
    schema_version: Literal["voiceverse.transcript.v1"] = "voiceverse.transcript.v1"
    producer_version: ProducerVersion
    execution_id: UUID
    attempt_id: UUID
    configuration_hash: Sha256
    model: ModelDescriptor
    input_artifact_id: UUID
    input_sha256: Sha256
    timeline: Timeline
    language: TranscriptLanguage
    segments: list[TranscriptSegment]


class ProviderSpeakerTurn(ApiModel):
    start_us: TimestampUs
    end_us: PositiveDurationUs
    provider_speaker_label: SpeakerLabel

    @model_validator(mode="after")
    def validate_interval(self) -> Self:
        if self.end_us <= self.start_us:
            raise ValueError("speaker turn must be half-open and non-empty")
        return self


class DiarizationProviderResult(ApiModel):
    turns: list[ProviderSpeakerTurn] = Field(default_factory=list, max_length=500_000)
    exclusive_turns: list[ProviderSpeakerTurn] = Field(default_factory=list, max_length=500_000)


class DiarizationSpeaker(ApiModel):
    local_speaker_key: str = Field(pattern=r"^speaker-[0-9]{4,}$")
    provider_label: SpeakerLabel
    first_turn_us: TimestampUs
    total_speech_us: PositiveDurationUs


class DiarizationTurn(ApiModel):
    ordinal: int = Field(ge=0)
    start_us: TimestampUs
    end_us: PositiveDurationUs
    speaker_key: str = Field(pattern=r"^speaker-[0-9]{4,}$")


class DiarizationManifest(ApiModel):
    schema_version: Literal["voiceverse.diarization.v1"] = "voiceverse.diarization.v1"
    producer_version: ProducerVersion
    execution_id: UUID
    attempt_id: UUID
    configuration_hash: Sha256
    model: ModelDescriptor
    input_artifact_id: UUID
    input_sha256: Sha256
    timeline: Timeline
    speakers: list[DiarizationSpeaker]
    turns: list[DiarizationTurn]
    exclusive_turns: list[DiarizationTurn]


class SeparationManifest(ApiModel):
    schema_version: Literal["voiceverse.separation.v1"] = "voiceverse.separation.v1"
    producer_version: ProducerVersion
    execution_id: UUID
    attempt_id: UUID
    configuration_hash: Sha256
    model: ModelDescriptor
    input_artifact_id: UUID
    input_sha256: Sha256
    timeline: Timeline
    artifacts: list[GeneratedArtifact] = Field(min_length=3, max_length=3)


class SpeechExecutionResponse(ApiModel):
    schema_version: str = Field(min_length=1, max_length=100)
    producer_version: ProducerVersion
    execution_id: UUID
    attempt_id: UUID
    model: ModelDescriptor
    artifacts: list[GeneratedArtifact] = Field(min_length=1, max_length=4)


class VocalSeparationResponse(SpeechExecutionResponse):
    schema_version: Literal["voiceverse.separation.v1"] = "voiceverse.separation.v1"


class TranscriptionSummary(ApiModel):
    detected_language: DetectedLanguage
    language_probability: Probability | None = None
    segment_count: int = Field(ge=0)
    word_count: int = Field(ge=0)


class TranscriptionResponse(SpeechExecutionResponse):
    schema_version: Literal["voiceverse.transcript.v1"] = "voiceverse.transcript.v1"
    summary: TranscriptionSummary


class DiarizationSummary(ApiModel):
    speaker_count: int = Field(ge=0)
    turn_count: int = Field(ge=0)
    exclusive_turn_count: int = Field(ge=0)


class SpeakerDiarizationResponse(SpeechExecutionResponse):
    schema_version: Literal["voiceverse.diarization.v1"] = "voiceverse.diarization.v1"
    summary: DiarizationSummary


def _validate_object_key(value: str) -> str:
    if (
        value.startswith("/")
        or "\\" in value
        or any(ord(character) < 32 for character in value)
        or _FORBIDDEN_KEY_SEGMENT.search(value)
    ):
        raise ValueError("storage object key is not an opaque relative key")
    return value


def _validate_output_keys(input_key: str, output_keys: tuple[str, ...]) -> None:
    validated = tuple(_validate_object_key(key) for key in output_keys)
    if len(set(validated)) != len(validated):
        raise ValueError("storage output keys must be distinct")
    if input_key in validated:
        raise ValueError("storage output key must differ from its input")
