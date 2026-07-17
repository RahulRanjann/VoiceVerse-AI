import copy
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any, cast
from uuid import UUID

import pytest
from asgi_lifespan import LifespanManager
from httpx import ASGITransport, AsyncByteStream, AsyncClient
from pydantic import ValidationError

from voiceverse_ai.core.config import Settings
from voiceverse_ai.main import create_app
from voiceverse_ai.media.errors import MediaExecutionError
from voiceverse_ai.speech.models import ModelDescriptor
from voiceverse_ai.translation.models import (
    MAX_DIALOGUE_ITEMS,
    MAX_GLOSSARY_REVISIONS,
    MAX_SOURCE_TEXT_CHARACTERS,
    DialogueCharacter,
    GlossaryRevision,
    SceneContext,
    TranslationDialogue,
    TranslationProviderResult,
    TranslationRequest,
)
from voiceverse_ai.translation.providers import (
    DETERMINISTIC_PROVIDER_NAME,
    DeterministicTranslationProvider,
    TranslationProvider,
)
from voiceverse_ai.translation.service import TranslationExecutionService

TOKEN = "test-internal-translation-token-with-32-characters"
GENERATION_ID = UUID("018f0000-0000-7000-8000-000000000201")
EXECUTION_ID = UUID("018f0000-0000-7000-8000-000000000202")
SCENE_REVISION_ID = UUID("018f0000-0000-7000-8000-000000000203")
GLOSSARY_REVISION_ID = UUID("018f0000-0000-7000-8000-000000000204")
DIALOGUE_ID = UUID("018f0000-0000-7000-8000-000000000205")
SOURCE_REVISION_ID = UUID("018f0000-0000-7000-8000-000000000206")
CHARACTER_ID = UUID("018f0000-0000-7000-8000-000000000207")
SOURCE_TEXT = "Private source sentence alpha."
NARRATIVE = "Private scene narrative beta."
CULTURAL_NOTES = "Private cultural note gamma."
GLOSSARY_NOTES = "Private glossary note delta."
TEST_MODEL = ModelDescriptor(
    provider=DETERMINISTIC_PROVIDER_NAME,
    model_id="voiceverse/deterministic-translation",
    model_revision="test-v1",
    runtime_version="1.0.0",
)


def _settings(**values: object) -> Settings:
    values.setdefault("_env_file", None)
    values.setdefault("environment", "test")
    values.setdefault("app_version", "2026.07.17-test")
    values.setdefault("internal_api_token", TOKEN)
    values.setdefault("translation_enabled", True)
    values.setdefault("translation_provider", "deterministic")
    return Settings(**cast("Any", values))


def _request(*, expected_model: ModelDescriptor = TEST_MODEL) -> TranslationRequest:
    return TranslationRequest(
        schema_version="voiceverse.translation-command.v1",
        generation_id=GENERATION_ID,
        execution_id=EXECUTION_ID,
        source_language_tag="en-US",
        target_language_tag="es-MX",
        expected_model=expected_model,
        prompt_version="scene-translation.v1",
        scene_context=SceneContext(
            scene_revision_id=SCENE_REVISION_ID,
            title="The first scene",
            narrative=NARRATIVE,
            cultural_notes=CULTURAL_NOTES,
        ),
        glossary_revisions=[
            GlossaryRevision(
                glossary_revision_id=GLOSSARY_REVISION_ID,
                source_term="VoiceVerse",
                target_term=None,
                notes=GLOSSARY_NOTES,
                case_sensitive=True,
                do_not_translate=True,
            )
        ],
        dialogues=[
            TranslationDialogue(
                ordinal=0,
                dialogue_id=DIALOGUE_ID,
                source_revision_id=SOURCE_REVISION_ID,
                source_text=SOURCE_TEXT,
                character=DialogueCharacter(
                    character_id=CHARACTER_ID,
                    name="Narrator",
                ),
                start_us=100_000,
                end_us=900_000,
            )
        ],
    )


def _wire_payload() -> dict[str, Any]:
    return _request().model_dump(mode="json", by_alias=True)


@asynccontextmanager
async def _api_client(
    settings: Settings,
    *,
    provider: TranslationProvider | None = None,
) -> AsyncIterator[AsyncClient]:
    app = create_app(settings, translation_provider=provider)
    async with (
        LifespanManager(app) as manager,
        AsyncClient(
            transport=ASGITransport(app=manager.app),
            base_url="http://testserver",
        ) as client,
    ):
        yield client


class CountingDeterministicProvider(DeterministicTranslationProvider):
    def __init__(self, *, ready: bool = True) -> None:
        super().__init__()
        self.ready = ready
        self.calls = 0

    def is_ready(self) -> bool:
        return self.ready

    async def translate(self, request: TranslationRequest) -> TranslationProviderResult:
        self.calls += 1
        return await super().translate(request)


class FailingProvider(CountingDeterministicProvider):
    async def translate(self, request: TranslationRequest) -> TranslationProviderResult:
        self.calls += 1
        raise RuntimeError("provider leaked private source sentence alpha")


class ExplodingRequestStream(AsyncByteStream):
    def __init__(self) -> None:
        self.iterated = False

    def __aiter__(self) -> AsyncIterator[bytes]:
        return self

    async def __anext__(self) -> bytes:
        self.iterated = True
        raise AssertionError("the guarded body must not be read")


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


def test_translation_is_disabled_by_default_and_deterministic_is_test_only() -> None:
    defaults = Settings(environment="test", _env_file=None)

    assert not defaults.translation_enabled
    assert defaults.translation_provider == "none"
    assert defaults.translation_max_request_body_bytes == 1_048_576
    assert defaults.translation_provider_timeout_seconds == 120
    assert defaults.translation_max_concurrency == 4

    with pytest.raises(ValidationError, match="allowed only in tests"):
        Settings(
            environment="development",
            translation_provider="deterministic",
            _env_file=None,
        )

    with pytest.raises(ValueError, match="allowed only in tests"):
        create_app(
            Settings(environment="development", _env_file=None),
            translation_provider=DeterministicTranslationProvider(),
        )


@pytest.mark.anyio
async def test_capability_is_authenticated_disabled_by_default_and_exact_when_enabled() -> None:
    disabled_settings = _settings(
        translation_enabled=False,
        translation_provider="none",
    )
    async with _api_client(disabled_settings) as client:
        unauthorized = await client.get("/internal/v1/translation-capability")
        disabled = await client.get(
            "/internal/v1/translation-capability",
            headers={"Authorization": f"Bearer {TOKEN}"},
        )
        disabled_execution = await client.post(
            "/internal/v1/translations",
            json=_wire_payload(),
            headers={"Authorization": f"Bearer {TOKEN}"},
        )

    assert unauthorized.status_code == 401
    assert unauthorized.json()["error"]["code"] == "AUTHENTICATION_REQUIRED"
    assert disabled.status_code == 503
    assert disabled.json()["error"]["code"] == "TRANSLATION_CAPABILITY_DISABLED"
    assert disabled_execution.status_code == 503
    assert disabled_execution.json()["error"]["code"] == "TRANSLATION_CAPABILITY_DISABLED"

    async with _api_client(_settings()) as client:
        available = await client.get(
            "/internal/v1/translation-capability",
            headers={"Authorization": f"Bearer {TOKEN}"},
        )

    assert available.status_code == 200
    assert available.json() == {
        "schemaVersion": "voiceverse.translation-capability.v1",
        "capability": "SCENE_TRANSLATION",
        "enabled": True,
        "ready": True,
        "model": {
            "provider": "deterministic-test",
            "modelId": "voiceverse/deterministic-translation",
            "modelRevision": "test-v1",
            "runtimeVersion": "1.0.0",
        },
    }


@pytest.mark.anyio
async def test_missing_or_unready_provider_fails_closed() -> None:
    no_provider = _settings(translation_provider="none")
    async with _api_client(no_provider) as client:
        readiness = await client.get(
            "/internal/v1/translation-capability",
            headers={"Authorization": f"Bearer {TOKEN}"},
        )
        execution = await client.post(
            "/internal/v1/translations",
            json=_wire_payload(),
            headers={"Authorization": f"Bearer {TOKEN}"},
        )

    assert readiness.status_code == 503
    assert readiness.json()["error"]["code"] == "TRANSLATION_PROVIDER_NOT_READY"
    assert execution.status_code == 503
    assert execution.json()["error"]["code"] == "TRANSLATION_PROVIDER_NOT_CONFIGURED"

    provider = CountingDeterministicProvider(ready=False)
    async with _api_client(no_provider, provider=provider) as client:
        unready = await client.get(
            "/internal/v1/translation-capability",
            headers={"Authorization": f"Bearer {TOKEN}"},
        )
    assert unready.status_code == 503
    assert provider.calls == 0


@pytest.mark.anyio
async def test_valid_deterministic_translation_is_versioned_complete_and_idempotent() -> None:
    async with _api_client(_settings()) as client:
        first = await client.post(
            "/internal/v1/translations",
            json=_wire_payload(),
            headers={"Authorization": f"Bearer {TOKEN}"},
        )
        second = await client.post(
            "/internal/v1/translations",
            json=_wire_payload(),
            headers={"Authorization": f"Bearer {TOKEN}"},
        )

    assert first.status_code == 200
    assert first.json() == second.json()
    assert first.json() == {
        "schemaVersion": "voiceverse.translation.v1",
        "producerVersion": "2026.07.17-test",
        "generationId": str(GENERATION_ID),
        "executionId": str(EXECUTION_ID),
        "sourceLanguageTag": "en-US",
        "targetLanguageTag": "es-MX",
        "model": {
            "provider": "deterministic-test",
            "modelId": "voiceverse/deterministic-translation",
            "modelRevision": "test-v1",
            "runtimeVersion": "1.0.0",
        },
        "promptVersion": "scene-translation.v1",
        "translations": [
            {
                "dialogueId": str(DIALOGUE_ID),
                "sourceRevisionId": str(SOURCE_REVISION_ID),
                "targetText": f"[es-MX] {SOURCE_TEXT}",
            }
        ],
    }


@pytest.mark.anyio
async def test_model_mismatch_is_rejected_before_provider_execution() -> None:
    provider = CountingDeterministicProvider()
    mismatched = _request(
        expected_model=ModelDescriptor(
            provider=DETERMINISTIC_PROVIDER_NAME,
            model_id="voiceverse/another-model",
            model_revision="test-v1",
            runtime_version="1.0.0",
        )
    )
    async with _api_client(
        _settings(translation_provider="none"),
        provider=provider,
    ) as client:
        response = await client.post(
            "/internal/v1/translations",
            json=mismatched.model_dump(mode="json", by_alias=True),
            headers={"Authorization": f"Bearer {TOKEN}"},
        )

    assert response.status_code == 409
    assert response.json()["error"]["code"] == "TRANSLATION_PROVIDER_MODEL_MISMATCH"
    assert provider.calls == 0


def test_contract_rejects_unknown_fields_duplicates_language_timing_and_order() -> None:
    unknown = _wire_payload()
    unknown["sceneContext"]["unknown"] = True
    with pytest.raises(ValidationError, match="Extra inputs are not permitted"):
        TranslationRequest.model_validate(unknown)

    same_language = _wire_payload()
    same_language["targetLanguageTag"] = "EN-us"
    with pytest.raises(ValidationError, match="language tags must differ"):
        TranslationRequest.model_validate(same_language)

    invalid_timing = _wire_payload()
    invalid_timing["dialogues"][0]["endUs"] = 100_000
    with pytest.raises(ValidationError, match="non-empty half-open interval"):
        TranslationRequest.model_validate(invalid_timing)

    duplicate = _wire_payload()
    duplicate_dialogue = copy.deepcopy(duplicate["dialogues"][0])
    duplicate_dialogue["ordinal"] = 1
    duplicate_dialogue["startUs"] = 1_000_000
    duplicate_dialogue["endUs"] = 1_500_000
    duplicate["dialogues"].append(duplicate_dialogue)
    with pytest.raises(ValidationError, match="dialogue identifiers must be distinct"):
        TranslationRequest.model_validate(duplicate)

    out_of_order = _wire_payload()
    out_of_order["dialogues"][0]["startUs"] = 200_000
    out_of_order["dialogues"][0]["endUs"] = 300_000
    second = copy.deepcopy(out_of_order["dialogues"][0])
    second.update(
        {
            "ordinal": 1,
            "dialogueId": str(UUID(int=301)),
            "sourceRevisionId": str(UUID(int=302)),
            "startUs": 100_000,
            "endUs": 150_000,
        }
    )
    out_of_order["dialogues"].append(second)
    with pytest.raises(ValidationError, match="ordered by start time"):
        TranslationRequest.model_validate(out_of_order)

    duplicate_glossary = _wire_payload()
    duplicate_glossary["glossaryRevisions"].append(
        copy.deepcopy(duplicate_glossary["glossaryRevisions"][0])
    )
    with pytest.raises(ValidationError, match="glossary revision identifiers must be distinct"):
        TranslationRequest.model_validate(duplicate_glossary)

    missing_target = _wire_payload()
    missing_target["glossaryRevisions"][0]["doNotTranslate"] = False
    with pytest.raises(ValidationError, match="target term may be null"):
        TranslationRequest.model_validate(missing_target)

    contradictory_target = _wire_payload()
    contradictory_target["glossaryRevisions"][0]["targetTerm"] = "VoiceVerse translated"
    with pytest.raises(ValidationError, match="must not include a target term"):
        TranslationRequest.model_validate(contradictory_target)


def test_contract_rejects_oversize_counts_and_text() -> None:
    oversize_text = _wire_payload()
    oversize_text["dialogues"][0]["sourceText"] = "x" * (MAX_SOURCE_TEXT_CHARACTERS + 1)
    with pytest.raises(ValidationError, match="at most 20000 characters"):
        TranslationRequest.model_validate(oversize_text)

    oversize_utf8 = _wire_payload()
    oversize_utf8["dialogues"][0]["sourceText"] = "🙂" * 16_385
    with pytest.raises(ValidationError, match="UTF-8 byte limit"):
        TranslationRequest.model_validate(oversize_utf8)

    oversize_dialogues = _wire_payload()
    base_dialogue = oversize_dialogues["dialogues"][0]
    oversize_dialogues["dialogues"] = [
        {
            **base_dialogue,
            "ordinal": index,
            "dialogueId": str(UUID(int=1_000 + index)),
            "sourceRevisionId": str(UUID(int=2_000 + index)),
            "startUs": index * 10,
            "endUs": index * 10 + 5,
        }
        for index in range(MAX_DIALOGUE_ITEMS + 1)
    ]
    with pytest.raises(ValidationError, match="at most 200 items"):
        TranslationRequest.model_validate(oversize_dialogues)

    oversize_glossary = _wire_payload()
    base_glossary = oversize_glossary["glossaryRevisions"][0]
    oversize_glossary["glossaryRevisions"] = [
        {
            **base_glossary,
            "glossaryRevisionId": str(UUID(int=3_000 + index)),
            "sourceTerm": f"term-{index}",
        }
        for index in range(MAX_GLOSSARY_REVISIONS + 1)
    ]
    with pytest.raises(ValidationError, match="at most 200 items"):
        TranslationRequest.model_validate(oversize_glossary)


@pytest.mark.anyio
async def test_guard_authenticates_before_reading_and_bounds_translation_bodies() -> None:
    settings = _settings(translation_max_request_body_bytes=65_536)
    async with _api_client(settings) as client:
        unauthorized_stream = ExplodingRequestStream()
        unauthorized = await client.post(
            "/internal/v1/translations",
            content=unauthorized_stream,
            headers={"Content-Type": "application/json"},
        )

        oversize_stream = ExplodingRequestStream()
        oversize = await client.post(
            "/internal/v1/translations",
            content=oversize_stream,
            headers={
                "Authorization": f"Bearer {TOKEN}",
                "Content-Length": "65537",
                "Content-Type": "application/json",
            },
        )

    assert unauthorized.status_code == 401
    assert unauthorized.json()["error"]["code"] == "AUTHENTICATION_REQUIRED"
    assert not unauthorized_stream.iterated
    assert oversize.status_code == 413
    assert oversize.json()["error"]["code"] == "TRANSLATION_REQUEST_TOO_LARGE"
    assert not oversize_stream.iterated


@pytest.mark.anyio
async def test_source_context_and_provider_details_never_enter_logs(
    caplog: pytest.LogCaptureFixture,
) -> None:
    provider = FailingProvider()
    service = TranslationExecutionService(
        settings=_settings(translation_provider="none"),
        provider=provider,
    )

    with (
        caplog.at_level(logging.INFO),
        pytest.raises(MediaExecutionError, match="TRANSLATION_PROVIDER_FAILED"),
    ):
        await service.translate(_request())

    assert provider.calls == 1
    assert SOURCE_TEXT not in caplog.text
    assert NARRATIVE not in caplog.text
    assert CULTURAL_NOTES not in caplog.text
    assert GLOSSARY_NOTES not in caplog.text
    assert "provider leaked" not in caplog.text
