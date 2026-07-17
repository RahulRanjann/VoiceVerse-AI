from functools import lru_cache
from pathlib import Path
from typing import Literal, Self

from pydantic import AnyHttpUrl, Field, SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Validated process configuration.

    Local defaults only point to loopback services. Production refuses to start
    until its externally meaningful values are supplied.
    """

    model_config = SettingsConfigDict(
        env_file=("../../.env", ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
        populate_by_name=True,
    )

    environment: Literal["development", "test", "production"] = Field(
        default="development", validation_alias="NODE_ENV"
    )
    host: str = Field(default="0.0.0.0", validation_alias="AI_HOST")
    port: int = Field(default=8000, ge=1, le=65_535, validation_alias="AI_PORT")
    app_version: str = Field(
        default="development",
        min_length=1,
        max_length=100,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9._:/+-]*$",
        validation_alias="APP_VERSION",
    )
    log_level: Literal["critical", "error", "warning", "info", "debug"] = Field(
        default="info", validation_alias="LOG_LEVEL"
    )
    otel_traces_exporter: Literal["none", "otlp"] = Field(
        default="none", validation_alias="OTEL_TRACES_EXPORTER"
    )
    otel_exporter_otlp_endpoint: AnyHttpUrl = Field(
        default=AnyHttpUrl("http://localhost:4318"),
        validation_alias="OTEL_EXPORTER_OTLP_ENDPOINT",
    )
    otel_service_namespace: str = Field(
        default="voiceverse", min_length=1, validation_alias="OTEL_SERVICE_NAMESPACE"
    )
    internal_api_token: SecretStr | None = Field(
        default=None,
        validation_alias="AI_INTERNAL_BEARER_TOKEN",
    )
    s3_endpoint: AnyHttpUrl | None = Field(
        default=AnyHttpUrl("http://localhost:9000"),
        validation_alias="S3_ENDPOINT",
    )
    s3_region: str = Field(default="us-east-1", min_length=1, validation_alias="S3_REGION")
    s3_bucket: str | None = Field(
        default=None,
        min_length=3,
        max_length=63,
        pattern=r"^[a-z0-9][a-z0-9.-]*[a-z0-9]$",
        validation_alias="S3_BUCKET",
    )
    s3_access_key: SecretStr | None = Field(default=None, validation_alias="S3_ACCESS_KEY")
    s3_secret_key: SecretStr | None = Field(default=None, validation_alias="S3_SECRET_KEY")
    s3_force_path_style: bool = Field(default=True, validation_alias="S3_FORCE_PATH_STYLE")
    s3_sse_algorithm: Literal["none", "AES256", "aws:kms"] = Field(
        default="none", validation_alias="S3_SSE_ALGORITHM"
    )
    s3_kms_key_id: str | None = Field(default=None, validation_alias="S3_KMS_KEY_ID")
    media_scratch_root: Path = Field(default=Path("/tmp"), validation_alias="AI_MEDIA_SCRATCH_ROOT")
    media_max_input_bytes: int = Field(
        default=107_374_182_400,
        ge=1_048_576,
        le=1_099_511_627_776,
        validation_alias="AI_MEDIA_MAX_INPUT_BYTES",
    )
    media_max_output_bytes: int = Field(
        default=107_374_182_400,
        ge=1_048_576,
        le=1_099_511_627_776,
        validation_alias="AI_MEDIA_MAX_OUTPUT_BYTES",
    )
    media_max_duration_seconds: int = Field(
        default=21_600,
        ge=1,
        le=86_400,
        validation_alias="AI_MEDIA_MAX_DURATION_SECONDS",
    )
    media_probe_timeout_seconds: int = Field(
        default=60,
        ge=1,
        le=600,
        validation_alias="AI_MEDIA_PROBE_TIMEOUT_SECONDS",
    )
    media_transcode_timeout_seconds: int = Field(
        default=7_200,
        ge=10,
        le=86_400,
        validation_alias="AI_MEDIA_TRANSCODE_TIMEOUT_SECONDS",
    )
    media_subprocess_output_limit_bytes: int = Field(
        default=131_072,
        ge=4_096,
        le=4_194_304,
        validation_alias="AI_MEDIA_SUBPROCESS_OUTPUT_LIMIT_BYTES",
    )
    media_ffmpeg_threads: int = Field(
        default=4,
        ge=1,
        le=64,
        validation_alias="AI_MEDIA_FFMPEG_THREADS",
    )
    speech_vocal_separation_enabled: bool = Field(
        default=False,
        validation_alias="AI_SPEECH_VOCAL_SEPARATION_ENABLED",
    )
    speech_transcription_enabled: bool = Field(
        default=False,
        validation_alias="AI_SPEECH_TRANSCRIPTION_ENABLED",
    )
    speech_diarization_enabled: bool = Field(
        default=False,
        validation_alias="AI_SPEECH_DIARIZATION_ENABLED",
    )
    speech_scratch_root: Path = Field(
        default=Path("/tmp"),
        validation_alias="AI_SPEECH_SCRATCH_ROOT",
    )
    speech_max_input_bytes: int = Field(
        default=21_474_836_480,
        ge=1_048_576,
        le=1_099_511_627_776,
        validation_alias="AI_SPEECH_MAX_INPUT_BYTES",
    )
    speech_max_output_bytes: int = Field(
        default=21_474_836_480,
        ge=1_048_576,
        le=1_099_511_627_776,
        validation_alias="AI_SPEECH_MAX_OUTPUT_BYTES",
    )
    speech_max_manifest_bytes: int = Field(
        default=67_108_864,
        ge=1_048_576,
        le=67_108_864,
        validation_alias="AI_SPEECH_MAX_MANIFEST_BYTES",
    )
    speech_max_request_body_bytes: int = Field(
        default=65_536,
        ge=4_096,
        le=1_048_576,
        validation_alias="AI_SPEECH_MAX_REQUEST_BODY_BYTES",
    )
    speech_max_duration_seconds: int = Field(
        default=21_600,
        ge=1,
        le=86_400,
        validation_alias="AI_SPEECH_MAX_DURATION_SECONDS",
    )
    speech_max_concurrency: int = Field(
        default=1,
        ge=1,
        le=16,
        validation_alias="AI_SPEECH_MAX_CONCURRENCY",
    )
    speech_vocal_separation_timeout_seconds: int = Field(
        default=21_000,
        ge=1,
        le=86_400,
        validation_alias="AI_SPEECH_VOCAL_SEPARATION_TIMEOUT_SECONDS",
    )
    speech_transcription_timeout_seconds: int = Field(
        default=21_000,
        ge=1,
        le=86_400,
        validation_alias="AI_SPEECH_TRANSCRIPTION_TIMEOUT_SECONDS",
    )
    speech_diarization_timeout_seconds: int = Field(
        default=21_000,
        ge=1,
        le=86_400,
        validation_alias="AI_SPEECH_DIARIZATION_TIMEOUT_SECONDS",
    )
    speech_timeline_tolerance_us: int = Field(
        default=50_000,
        ge=0,
        le=5_000_000,
        validation_alias="AI_SPEECH_TIMELINE_TOLERANCE_US",
    )
    translation_enabled: bool = Field(
        default=False,
        validation_alias="AI_TRANSLATION_ENABLED",
    )
    translation_provider: Literal["none", "deterministic"] = Field(
        default="none",
        validation_alias="AI_TRANSLATION_PROVIDER",
    )
    translation_model_id: str = Field(
        default="voiceverse/deterministic-translation",
        min_length=1,
        max_length=128,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9._:/+-]*$",
        validation_alias="AI_TRANSLATION_MODEL_ID",
    )
    translation_model_revision: str = Field(
        default="test-v1",
        min_length=1,
        max_length=128,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9._:/+-]*$",
        validation_alias="AI_TRANSLATION_MODEL_REVISION",
    )
    translation_runtime_version: str = Field(
        default="1.0.0",
        min_length=1,
        max_length=128,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9._:/+-]*$",
        validation_alias="AI_TRANSLATION_RUNTIME_VERSION",
    )
    translation_max_request_body_bytes: int = Field(
        default=1_048_576,
        ge=65_536,
        le=8_388_608,
        validation_alias="AI_TRANSLATION_MAX_REQUEST_BODY_BYTES",
    )
    translation_provider_timeout_seconds: int = Field(
        default=120,
        ge=1,
        le=3_600,
        validation_alias="AI_TRANSLATION_PROVIDER_TIMEOUT_SECONDS",
    )
    translation_max_concurrency: int = Field(
        default=4,
        ge=1,
        le=64,
        validation_alias="AI_TRANSLATION_MAX_CONCURRENCY",
    )
    ffmpeg_binary: str = Field(default="ffmpeg", min_length=1, validation_alias="FFMPEG_BINARY")
    ffprobe_binary: str = Field(default="ffprobe", min_length=1, validation_alias="FFPROBE_BINARY")

    @model_validator(mode="after")
    def validate_production_configuration(self) -> Self:
        if self.translation_provider == "deterministic" and self.environment != "test":
            raise ValueError("AI_TRANSLATION_PROVIDER=deterministic is allowed only in tests")
        if self.environment == "production" and self.app_version == "development":
            raise ValueError("APP_VERSION must be supplied in production")
        if self.environment == "production" and self.internal_api_token is None:
            raise ValueError("AI_INTERNAL_BEARER_TOKEN must be supplied in production")
        if self.environment == "production" and self.s3_bucket is None:
            raise ValueError("S3_BUCKET must be supplied in production")
        if self.environment == "production" and (
            self.s3_endpoint is None or self.s3_endpoint.scheme != "https"
        ):
            raise ValueError("S3_ENDPOINT must use HTTPS in production")
        if self.environment == "production" and self.s3_sse_algorithm == "none":
            raise ValueError("S3_SSE_ALGORITHM must enable encryption in production")
        if (
            self.internal_api_token is not None
            and len(self.internal_api_token.get_secret_value()) < 32
        ):
            raise ValueError("AI_INTERNAL_BEARER_TOKEN must contain at least 32 characters")
        if (self.s3_access_key is None) != (self.s3_secret_key is None):
            raise ValueError("S3_ACCESS_KEY and S3_SECRET_KEY must be supplied together")
        if self.s3_sse_algorithm == "aws:kms" and not self.s3_kms_key_id:
            raise ValueError("S3_KMS_KEY_ID is required when S3_SSE_ALGORITHM is aws:kms")
        return self


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
