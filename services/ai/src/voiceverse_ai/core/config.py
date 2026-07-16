from functools import lru_cache
from typing import Literal, Self

from pydantic import AnyHttpUrl, Field, model_validator
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
    app_version: str = Field(default="development", validation_alias="APP_VERSION")
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

    @model_validator(mode="after")
    def validate_production_configuration(self) -> Self:
        if self.environment == "production" and self.app_version == "development":
            raise ValueError("APP_VERSION must be supplied in production")
        return self


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
