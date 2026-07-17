# VoiceVerse AI execution plane

This service owns AI and media execution concerns. It does not own users, billing, project authorization, or authoritative workflow state.

```bash
uv sync --all-groups
uv run uvicorn voiceverse_ai.main:app --reload --port 8000
```

Model dependencies are added only with the pipeline stage that consumes them. This keeps the base service fast to build and avoids locking incompatible GPU stacks prematurely.

## Speech execution contracts

The base image also exposes authenticated, versioned execution boundaries for vocal
separation, transcription, and speaker diarization. All three capabilities are disabled
by default and remain readiness-unavailable until both their feature flag and an
explicit provider implementation are configured:

```text
GET  /internal/v1/speech-capabilities/{capability}
POST /internal/v1/vocal-separations
POST /internal/v1/transcriptions
POST /internal/v1/speaker-diarizations
```

The authenticated GET is the worker readiness handshake and returns the provider, model
ID, model revision, and runtime version actually being served. Every POST carries the
same four-field `expectedModel` snapshot from its immutable workflow-stage configuration;
the service rejects a mismatch instead of letting a caller select another model.
Nest requires all three exact handshakes before it creates speech consumers and repeats
the relevant capability handshake before claiming each remote delivery.

Provider interfaces live in `voiceverse_ai.speech.providers`. They receive only a
checksum-verified local FLAC and server-owned typed options; storage, tenant identity,
object keys, authentication, immutable manifests, limits, and cleanup remain execution
service responsibilities. Concrete providers must isolate blocking inference from the
ASGI event loop and must never download a model while handling a request or readiness
probe.

An ASGI guard validates the internal bearer token before reading any speech request body,
then buffers at most `AI_SPEECH_MAX_REQUEST_BODY_BYTES` (including chunked requests).
Each provider call has an independent server-side deadline. Deadline cancellation is
allowed to finish provider cleanup before the secure workspace is removed.

The in-process concurrency limiter returns HTTP 429 before it creates a workspace,
downloads input, or invokes a provider. That is the only response the Nest coordinator
treats as safe same-attempt capacity deferral; its deferral count and backoff are bounded.
Other retryable responses may represent executed work and therefore use a new semantic
attempt/output namespace.

Provider-reported stem metadata is never trusted as proof of output validity. The service
rejects links and non-regular files, independently probes each generated FLAC with the
media toolchain, compares measured codec, stream count, sample rate, channels, and duration
to the declared contract and source timeline, then hashes a no-follow file descriptor. A
stem that changes at any point during validation is never uploaded.

Every immutable upload carries `contract-version` and authoritative `input-sha256`
metadata alongside attempt, execution, configuration, producer, provider, model, runtime,
and artifact identity. Nest independently checks that metadata and requires the vocal and
accompaniment stems to preserve the canonical sample rate/channels while isolated speech
is 16 kHz mono.

Transcript and diarization detail stays in private JSON manifests. HTTP responses contain
only model identity, artifact integrity metadata, and bounded counts. Every timeline uses
integer microseconds and half-open `[startUs, endUs)` intervals on the unchanged source
clock.

Feature flags and limits:

```text
AI_SPEECH_VOCAL_SEPARATION_ENABLED=false
AI_SPEECH_TRANSCRIPTION_ENABLED=false
AI_SPEECH_DIARIZATION_ENABLED=false
AI_SPEECH_SCRATCH_ROOT=/var/lib/voiceverse-speech
AI_SPEECH_MAX_INPUT_BYTES=21474836480
AI_SPEECH_MAX_OUTPUT_BYTES=21474836480
AI_SPEECH_MAX_MANIFEST_BYTES=67108864
AI_SPEECH_MAX_REQUEST_BODY_BYTES=65536
AI_SPEECH_MAX_DURATION_SECONDS=21600
AI_SPEECH_MAX_CONCURRENCY=1
AI_SPEECH_VOCAL_SEPARATION_TIMEOUT_SECONDS=21000
AI_SPEECH_TRANSCRIPTION_TIMEOUT_SECONDS=21000
AI_SPEECH_DIARIZATION_TIMEOUT_SECONDS=21000
AI_SPEECH_TIMELINE_TOLERANCE_US=50000
```

These application limits and workspace cleanup are defense in depth, not a filesystem
quota. Production pods must add quota-bounded ephemeral scratch (`emptyDir.sizeLimit`,
ephemeral-storage requests/limits, and namespace quota) and pass disk-pressure, eviction,
timeout, and cleanup tests.

No Whisper, Pyannote, separation, Torch, CUDA, or model-weight dependency is included in
the base lock or image. Stock Compose does not inject providers, and deterministic
providers are confined to tests. Production GPU adapters and exact model revisions are
added as separate capability images after their runtime and license gates are approved.

## Scene translation contract

The service also exposes a provider-neutral boundary for bounded, scene-aware dialogue
translation. It is disabled by default and requires the same internal bearer token as the
speech routes:

```text
GET  /internal/v1/translation-capability
POST /internal/v1/translations
```

The readiness handshake advertises only the exact provider, model ID, model revision, and
runtime version currently ready to serve. Each `voiceverse.translation-command.v1`
request pins that same descriptor plus its prompt version, immutable generation/execution
IDs, source and target BCP 47 tags, a scene revision, glossary revisions, and ordered
source-dialogue revisions. Unknown fields, duplicate identities, non-contiguous ordinals,
invalid or out-of-order half-open microsecond intervals, equal source/target languages,
model drift, and bounded-count/text violations are rejected before provider execution.
Successful responses use `voiceverse.translation.v1`, echo the immutable identities and
provenance, and contain exactly one ordered target text for every requested dialogue.

The ASGI request guard authenticates before reading JSON and enforces the dedicated body
limit for both declared and chunked bodies. Execution has a bounded in-process concurrency
limit and provider deadline. Logs contain identifiers, counts, timings, and status only;
source dialogue, target dialogue, prompts, glossary terms, narrative/cultural context, and
raw provider errors must never be logged.

```text
AI_TRANSLATION_ENABLED=false
AI_TRANSLATION_PROVIDER=none
AI_TRANSLATION_MODEL_ID=voiceverse/deterministic-translation
AI_TRANSLATION_MODEL_REVISION=test-v1
AI_TRANSLATION_RUNTIME_VERSION=1.0.0
AI_TRANSLATION_MAX_REQUEST_BODY_BYTES=1048576
AI_TRANSLATION_PROVIDER_TIMEOUT_SECONDS=120
AI_TRANSLATION_MAX_CONCURRENCY=4
```

The base service has no external translation client or model dependency. The only bundled
implementation is `deterministic-test`, which is stable for contract tests and is rejected
unless `ENVIRONMENT=test`, including when directly injected into the application factory.
Production provider adapters must be separately reviewed, pinned, and provisioned before
the capability is enabled.
