from typing import Annotated, Literal, Self
from uuid import UUID

from pydantic import Field, StringConstraints, field_validator, model_validator

from voiceverse_ai.media.models import ApiModel, LanguageTag
from voiceverse_ai.speech.models import ModelDescriptor, ProducerVersion

MAX_DIALOGUE_ITEMS = 200
MAX_GLOSSARY_REVISIONS = 200
MAX_SOURCE_TEXT_CHARACTERS = 20_000
MAX_TARGET_TEXT_CHARACTERS = 10_000
MAX_TIMELINE_POSITION_US = 86_400_000_000

PromptVersion = Annotated[
    str,
    StringConstraints(
        min_length=1,
        max_length=100,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9._:/+-]*$",
    ),
]
SceneTitle = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
SceneNarrative = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=4_000),
]
CulturalNotes = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=8_000),
]
GlossaryTerm = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=500),
]
GlossaryNotes = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=2_000),
]
CharacterName = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=160),
]
SourceText = Annotated[
    str,
    StringConstraints(min_length=1, max_length=MAX_SOURCE_TEXT_CHARACTERS),
]
TargetText = Annotated[
    str,
    StringConstraints(min_length=1, max_length=MAX_TARGET_TEXT_CHARACTERS),
]


class SceneContext(ApiModel):
    scene_revision_id: UUID
    title: SceneTitle | None
    narrative: SceneNarrative | None
    cultural_notes: CulturalNotes | None


class GlossaryRevision(ApiModel):
    glossary_revision_id: UUID
    source_term: GlossaryTerm
    target_term: GlossaryTerm | None
    notes: GlossaryNotes | None = None
    case_sensitive: bool
    do_not_translate: bool

    @model_validator(mode="after")
    def validate_target_term(self) -> Self:
        if self.target_term is None and not self.do_not_translate:
            raise ValueError("target term may be null only for do-not-translate entries")
        if self.target_term is not None and self.do_not_translate:
            raise ValueError("do-not-translate entries must not include a target term")
        return self


class DialogueCharacter(ApiModel):
    character_id: UUID
    name: CharacterName


class TranslationDialogue(ApiModel):
    ordinal: int = Field(ge=0, lt=MAX_DIALOGUE_ITEMS)
    dialogue_id: UUID
    source_revision_id: UUID
    source_text: SourceText
    character: DialogueCharacter | None
    start_us: int = Field(ge=0, le=MAX_TIMELINE_POSITION_US)
    end_us: int = Field(gt=0, le=MAX_TIMELINE_POSITION_US)

    @model_validator(mode="after")
    def validate_interval(self) -> Self:
        if self.end_us <= self.start_us:
            raise ValueError("dialogue timing must be a non-empty half-open interval")
        if not self.source_text.strip():
            raise ValueError("dialogue source text must not be blank")
        if len(self.source_text.encode("utf-8")) > 65_536:
            raise ValueError("dialogue source text exceeds the UTF-8 byte limit")
        return self


class TranslationRequest(ApiModel):
    schema_version: Literal["voiceverse.translation-command.v1"]
    generation_id: UUID
    execution_id: UUID
    source_language_tag: LanguageTag
    target_language_tag: LanguageTag
    expected_model: ModelDescriptor
    prompt_version: PromptVersion
    scene_context: SceneContext
    glossary_revisions: list[GlossaryRevision] = Field(max_length=MAX_GLOSSARY_REVISIONS)
    dialogues: list[TranslationDialogue] = Field(min_length=1, max_length=MAX_DIALOGUE_ITEMS)

    @model_validator(mode="after")
    def validate_contract(self) -> Self:
        if self.source_language_tag.casefold() == self.target_language_tag.casefold():
            raise ValueError("source and target language tags must differ")

        glossary_ids = [entry.glossary_revision_id for entry in self.glossary_revisions]
        if len(glossary_ids) != len(set(glossary_ids)):
            raise ValueError("glossary revision identifiers must be distinct")
        glossary_terms = [
            (
                entry.source_term if entry.case_sensitive else entry.source_term.lower(),
                entry.case_sensitive,
            )
            for entry in self.glossary_revisions
        ]
        if len(glossary_terms) != len(set(glossary_terms)):
            raise ValueError("glossary source terms must be distinct")

        dialogue_ids = [dialogue.dialogue_id for dialogue in self.dialogues]
        if len(dialogue_ids) != len(set(dialogue_ids)):
            raise ValueError("dialogue identifiers must be distinct")
        source_revision_ids = [dialogue.source_revision_id for dialogue in self.dialogues]
        if len(source_revision_ids) != len(set(source_revision_ids)):
            raise ValueError("source revision identifiers must be distinct")

        previous_start_us = -1
        for expected_ordinal, dialogue in enumerate(self.dialogues):
            if dialogue.ordinal != expected_ordinal:
                raise ValueError("dialogue ordinals must be contiguous and start at zero")
            if dialogue.start_us < previous_start_us:
                raise ValueError("dialogues must be ordered by start time")
            previous_start_us = dialogue.start_us
        return self


class ProviderTranslation(ApiModel):
    dialogue_id: UUID
    source_revision_id: UUID
    target_text: TargetText

    @field_validator("target_text")
    @classmethod
    def validate_target_text(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("translation target text must not be blank")
        return value


class TranslationProviderResult(ApiModel):
    translations: list[ProviderTranslation] = Field(min_length=1, max_length=MAX_DIALOGUE_ITEMS)

    @model_validator(mode="after")
    def validate_identifiers(self) -> Self:
        dialogue_ids = [translation.dialogue_id for translation in self.translations]
        source_revision_ids = [translation.source_revision_id for translation in self.translations]
        if len(dialogue_ids) != len(set(dialogue_ids)):
            raise ValueError("provider dialogue identifiers must be distinct")
        if len(source_revision_ids) != len(set(source_revision_ids)):
            raise ValueError("provider source revision identifiers must be distinct")
        return self


class TranslationResponse(ApiModel):
    schema_version: Literal["voiceverse.translation.v1"] = "voiceverse.translation.v1"
    producer_version: ProducerVersion
    generation_id: UUID
    execution_id: UUID
    source_language_tag: LanguageTag
    target_language_tag: LanguageTag
    model: ModelDescriptor
    prompt_version: PromptVersion
    translations: list[ProviderTranslation] = Field(min_length=1, max_length=MAX_DIALOGUE_ITEMS)


class TranslationCapabilityReadinessResponse(ApiModel):
    schema_version: Literal["voiceverse.translation-capability.v1"] = (
        "voiceverse.translation-capability.v1"
    )
    capability: Literal["SCENE_TRANSLATION"] = "SCENE_TRANSLATION"
    enabled: Literal[True] = True
    ready: Literal[True] = True
    model: ModelDescriptor
