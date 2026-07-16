import pytest
from pydantic import ValidationError

from voiceverse_ai.core.config import Settings


def test_production_requires_a_build_version() -> None:
    with pytest.raises(ValidationError, match="APP_VERSION must be supplied"):
        Settings(environment="production")


def test_explicit_production_version_is_valid() -> None:
    settings = Settings(environment="production", app_version="2026.07.16")

    assert settings.app_version == "2026.07.16"
