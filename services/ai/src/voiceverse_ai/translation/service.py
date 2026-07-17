import asyncio
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import structlog
from pydantic import ValidationError

from voiceverse_ai.core.config import Settings
from voiceverse_ai.media.errors import MediaExecutionError
from voiceverse_ai.speech.models import ModelDescriptor
from voiceverse_ai.translation.errors import translation_error
from voiceverse_ai.translation.models import (
    TranslationProviderResult,
    TranslationRequest,
    TranslationResponse,
)
from voiceverse_ai.translation.providers import TranslationProvider


class TranslationExecutionLimiter:
    """Reject excess in-process translation work instead of building a hidden queue."""

    def __init__(self, capacity: int) -> None:
        self._capacity = capacity
        self._active = 0
        self._lock = asyncio.Lock()

    @asynccontextmanager
    async def slot(self) -> AsyncIterator[None]:
        async with self._lock:
            if self._active >= self._capacity:
                raise translation_error(
                    "TRANSLATION_EXECUTOR_SATURATED",
                    "The translation executor is at its configured concurrency limit.",
                    429,
                )
            self._active += 1
        try:
            yield
        finally:
            async with self._lock:
                self._active -= 1


class TranslationExecutionService:
    """Validates immutable identities and isolates bounded provider execution."""

    def __init__(
        self,
        *,
        settings: Settings,
        provider: TranslationProvider | None = None,
        limiter: TranslationExecutionLimiter | None = None,
    ) -> None:
        self._settings = settings
        self._provider = provider
        self._limiter = limiter or TranslationExecutionLimiter(settings.translation_max_concurrency)
        self._logger = structlog.get_logger("voiceverse_ai.translation")

    def is_ready(self) -> bool:
        if self._provider is None:
            return False
        try:
            return self._provider.is_ready()
        except Exception:
            return False

    def capability_descriptor(self) -> ModelDescriptor:
        if not self.is_ready() or self._provider is None:
            raise translation_error(
                "TRANSLATION_PROVIDER_NOT_READY",
                "The translation provider is not ready.",
                503,
            )
        return self._provider.descriptor

    async def translate(self, request: TranslationRequest) -> TranslationResponse:
        provider = self._ready_provider()
        self._assert_expected_model(provider.descriptor, request.expected_model)
        started_at = time.perf_counter()
        self._log_started(request)
        try:
            async with self._limiter.slot():
                result = await self._call_provider(provider, request)
                self._validate_result(request, result)
            response = TranslationResponse(
                producer_version=self._settings.app_version,
                generation_id=request.generation_id,
                execution_id=request.execution_id,
                source_language_tag=request.source_language_tag,
                target_language_tag=request.target_language_tag,
                model=provider.descriptor,
                prompt_version=request.prompt_version,
                translations=result.translations,
            )
            self._log_completed(request, started_at)
            return response
        except MediaExecutionError:
            self._log_failed(request, started_at)
            raise

    def _ready_provider(self) -> TranslationProvider:
        provider = self._provider
        if provider is None:
            raise translation_error(
                "TRANSLATION_PROVIDER_NOT_CONFIGURED",
                "No translation provider is configured.",
                503,
            )
        try:
            ready = provider.is_ready()
        except Exception:
            ready = False
        if not ready:
            raise translation_error(
                "TRANSLATION_PROVIDER_NOT_READY",
                "The translation provider is not ready.",
                503,
            )
        return provider

    @staticmethod
    def _assert_expected_model(serving: ModelDescriptor, expected: ModelDescriptor) -> None:
        if serving != expected:
            raise translation_error(
                "TRANSLATION_PROVIDER_MODEL_MISMATCH",
                "The serving translation model does not match the requested immutable identity.",
                409,
            )

    async def _call_provider(
        self,
        provider: TranslationProvider,
        request: TranslationRequest,
    ) -> TranslationProviderResult:
        try:
            async with asyncio.timeout(self._settings.translation_provider_timeout_seconds):
                result = await provider.translate(request)
            return TranslationProviderResult.model_validate(result)
        except TimeoutError as error:
            raise translation_error(
                "TRANSLATION_PROVIDER_TIMEOUT",
                "The translation provider exceeded its execution deadline.",
                504,
            ) from error
        except ValidationError as error:
            raise translation_error(
                "TRANSLATION_PROVIDER_INVALID_RESPONSE",
                "The translation provider returned an invalid response.",
                502,
            ) from error
        except MediaExecutionError:
            raise
        except Exception as error:
            raise translation_error(
                "TRANSLATION_PROVIDER_FAILED",
                "The translation provider failed.",
                502,
            ) from error

    @staticmethod
    def _validate_result(
        request: TranslationRequest,
        result: TranslationProviderResult,
    ) -> None:
        expected = [
            (dialogue.dialogue_id, dialogue.source_revision_id) for dialogue in request.dialogues
        ]
        actual = [
            (translation.dialogue_id, translation.source_revision_id)
            for translation in result.translations
        ]
        if actual != expected:
            raise translation_error(
                "TRANSLATION_PROVIDER_INVALID_RESPONSE",
                "The translation provider response does not match the requested dialogue order.",
                502,
            )

    def _log_started(self, request: TranslationRequest) -> None:
        self._logger.info(
            "translation_execution_started",
            generation_id=str(request.generation_id),
            execution_id=str(request.execution_id),
            dialogue_count=len(request.dialogues),
            glossary_revision_count=len(request.glossary_revisions),
        )

    def _log_completed(self, request: TranslationRequest, started_at: float) -> None:
        self._logger.info(
            "translation_execution_completed",
            generation_id=str(request.generation_id),
            execution_id=str(request.execution_id),
            duration_ms=round((time.perf_counter() - started_at) * 1_000, 2),
            translation_count=len(request.dialogues),
        )

    def _log_failed(self, request: TranslationRequest, started_at: float) -> None:
        self._logger.warning(
            "translation_execution_failed",
            generation_id=str(request.generation_id),
            execution_id=str(request.execution_id),
            duration_ms=round((time.perf_counter() - started_at) * 1_000, 2),
        )
