from typing import Any, cast

import pytest
from pydantic import ValidationError

from voiceverse_ai.core.config import Settings


def build_settings(**values: object) -> Settings:
    values.setdefault("_env_file", None)
    # BaseSettings accepts runtime source-control kwargs that are intentionally
    # absent from the generated model constructor signature used by mypy.
    return Settings(**cast("Any", values))


def test_production_requires_a_build_version() -> None:
    with pytest.raises(ValidationError, match="APP_VERSION must be supplied"):
        build_settings(environment="production")


def test_explicit_production_version_is_valid() -> None:
    settings = build_settings(
        environment="production",
        app_version="2026.07.16",
        internal_api_token="a-production-token-with-32-characters",
        s3_bucket="voiceverse-production",
        s3_endpoint="https://s3.example.com",
        s3_sse_algorithm="AES256",
    )

    assert settings.app_version == "2026.07.16"


def test_production_requires_internal_authentication() -> None:
    with pytest.raises(ValidationError, match="AI_INTERNAL_BEARER_TOKEN must be supplied"):
        build_settings(environment="production", app_version="2026.07.16")


def test_production_requires_an_explicit_storage_scope() -> None:
    with pytest.raises(ValidationError, match="S3_BUCKET must be supplied"):
        build_settings(
            environment="production",
            app_version="2026.07.16",
            internal_api_token="a-production-token-with-32-characters",
        )


def test_rejects_short_token_partial_credentials_and_incomplete_kms() -> None:
    with pytest.raises(ValidationError, match="at least 32"):
        build_settings(environment="test", internal_api_token="short")
    with pytest.raises(ValidationError, match="must be supplied together"):
        build_settings(environment="test", s3_access_key="only-one")
    with pytest.raises(ValidationError, match="S3_KMS_KEY_ID"):
        build_settings(environment="test", s3_sse_algorithm="aws:kms")


def test_speech_capabilities_are_disabled_and_bounded_by_default() -> None:
    settings = build_settings(environment="test")

    assert not settings.speech_vocal_separation_enabled
    assert not settings.speech_transcription_enabled
    assert not settings.speech_diarization_enabled
    assert settings.speech_max_concurrency == 1
    assert settings.speech_max_duration_seconds == 21_600
    assert settings.speech_max_manifest_bytes == 67_108_864
    assert settings.speech_max_request_body_bytes == 65_536
    assert settings.speech_vocal_separation_timeout_seconds == 21_000
    assert settings.speech_transcription_timeout_seconds == 21_000
    assert settings.speech_diarization_timeout_seconds == 21_000

    with pytest.raises(ValidationError, match="greater than or equal to 1"):
        build_settings(environment="test", speech_max_concurrency=0)
    with pytest.raises(ValidationError, match="less than or equal to 67108864"):
        build_settings(environment="test", speech_max_manifest_bytes=67_108_865)
    with pytest.raises(ValidationError, match="at most 100 characters"):
        build_settings(environment="test", app_version="v" * 101)


def test_production_requires_tls_and_server_side_storage_encryption() -> None:
    production: dict[str, Any] = {
        "environment": "production",
        "app_version": "2026.07.16",
        "internal_api_token": "a-production-token-with-32-characters",
        "s3_bucket": "voiceverse-production",
        "_env_file": None,
    }
    with pytest.raises(ValidationError, match="S3_ENDPOINT must use HTTPS"):
        build_settings(
            **production, s3_endpoint="http://s3.example.com", s3_sse_algorithm="AES256"
        )
    with pytest.raises(ValidationError, match="S3_SSE_ALGORITHM"):
        build_settings(
            **production, s3_endpoint="https://s3.example.com", s3_sse_algorithm="none"
        )
