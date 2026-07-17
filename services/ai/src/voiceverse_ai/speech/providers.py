from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from voiceverse_ai.speech.models import (
    DiarizationProviderResult,
    ModelDescriptor,
    SeparationProviderResult,
    TranscriptionProviderResult,
)


@dataclass(frozen=True, slots=True)
class SeparationOutputPaths:
    vocal_stem: Path
    accompaniment_stem: Path
    isolated_speech: Path


class VocalSeparationProvider(Protocol):
    @property
    def descriptor(self) -> ModelDescriptor: ...

    def is_ready(self) -> bool: ...

    async def separate(
        self,
        source: Path,
        outputs: SeparationOutputPaths,
        *,
        duration_us: int,
        sample_rate_hz: int,
        channels: int,
    ) -> SeparationProviderResult: ...


class TranscriptionProvider(Protocol):
    @property
    def descriptor(self) -> ModelDescriptor: ...

    def is_ready(self) -> bool: ...

    async def transcribe(
        self,
        source: Path,
        *,
        duration_us: int,
        source_language_tag: str,
    ) -> TranscriptionProviderResult: ...


class SpeakerDiarizationProvider(Protocol):
    @property
    def descriptor(self) -> ModelDescriptor: ...

    def is_ready(self) -> bool: ...

    async def diarize(
        self,
        source: Path,
        *,
        duration_us: int,
    ) -> DiarizationProviderResult: ...
