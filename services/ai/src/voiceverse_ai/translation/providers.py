from typing import Protocol

from voiceverse_ai.speech.models import ModelDescriptor
from voiceverse_ai.translation.models import (
    MAX_TARGET_TEXT_CHARACTERS,
    ProviderTranslation,
    TranslationProviderResult,
    TranslationRequest,
)

DETERMINISTIC_PROVIDER_NAME = "deterministic-test"


class TranslationProvider(Protocol):
    @property
    def descriptor(self) -> ModelDescriptor: ...

    def is_ready(self) -> bool: ...

    async def translate(self, request: TranslationRequest) -> TranslationProviderResult: ...


class DeterministicTranslationProvider:
    """Test-only provider with stable output and no external model dependency."""

    def __init__(
        self,
        *,
        model_id: str = "voiceverse/deterministic-translation",
        model_revision: str = "test-v1",
        runtime_version: str = "1.0.0",
    ) -> None:
        self._descriptor = ModelDescriptor(
            provider=DETERMINISTIC_PROVIDER_NAME,
            model_id=model_id,
            model_revision=model_revision,
            runtime_version=runtime_version,
        )

    @property
    def descriptor(self) -> ModelDescriptor:
        return self._descriptor

    def is_ready(self) -> bool:
        return True

    async def translate(self, request: TranslationRequest) -> TranslationProviderResult:
        prefix = f"[{request.target_language_tag}] "
        maximum_source_characters = MAX_TARGET_TEXT_CHARACTERS - len(prefix)
        return TranslationProviderResult(
            translations=[
                ProviderTranslation(
                    dialogue_id=dialogue.dialogue_id,
                    source_revision_id=dialogue.source_revision_id,
                    target_text=f"{prefix}{dialogue.source_text[:maximum_source_characters]}",
                )
                for dialogue in request.dialogues
            ]
        )
