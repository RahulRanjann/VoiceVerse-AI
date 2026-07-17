# ADR-0010: Isolate speech capabilities on GPU executors and persist evidence-backed character memory

- Status: Accepted
- Date: 2026-07-17

## Context

Milestone 4 produces an immutable channel-preserving `CANONICAL_AUDIO` master and a
16 kHz mono `ANALYSIS_AUDIO` derivative. Milestone 5 must use those inputs to separate
vocals, transcribe dialogue, diarize speakers, and map temporary speaker clusters to
movie characters.

These workloads have materially different dependencies and scaling profiles:

- source separation, ASR, and diarization use different model stacks, CUDA libraries,
  model licenses, memory profiles, batch behavior, and quality metrics;
- a feature-film request can run for minutes or hours and cannot share the request,
  memory, or timeout envelope of a public web function;
- separation can alter or erase quiet dialogue, so its output is useful for ASR but is
  not a safe universal input for diarization or a delivery-quality soundtrack;
- ASR segments and diarization clusters are model-run evidence, not stable character
  identity; and
- voice embeddings, inferred demographics, and raw dialogue are sensitive data with
  different privacy and legal implications from ordinary workflow metadata.

The current cloud boundary is already fixed by ADR-0007 and ADR-0008: Vercel hosts the
Next.js web application, Supabase provides Auth and private PostgreSQL, and browsers do
not read VoiceVerse business tables through the Supabase Data API. ADR-0001 and
ADR-0002 require the NestJS control plane and PostgreSQL to retain business-state and
workflow authority.

## Decision

### Deployment boundary

Vercel remains the web tier only. Supabase remains the identity provider and private
managed PostgreSQL system of record. Neither Vercel functions nor Supabase Edge
Functions execute feature-length speech models.

The NestJS API, outbox relay, Redis/BullMQ transport, and workflow workers run as private
container workloads. Production separation, ASR, and diarization run as three
independently deployable capability executors on Kubernetes GPU node pools. Character
identification is a deterministic, bounded CPU worker because it joins verified
timelines and does not run a heavyweight model in this milestone.

The initial transport from the Nest worker to each FastAPI capability is private and
authenticated behind a Nest `SpeechExecutorPort`. Local Compose uses HTTP inside its
development network; production worker configuration rejects non-HTTPS media executor
URLs and, when speech analysis is enabled, non-HTTPS speech executor URLs. The transport
is an adapter, not a workflow-domain dependency. A later adapter may create and watch
Kubernetes Jobs or consume an executor-specific queue without changing job, stage,
attempt, artifact, or manifest contracts.

### Durable DAG and inputs

Source preparation is not extended in place. A new immutable `SPEECH_ANALYSIS` job with
pipeline version `speech-analysis.v1` snapshots the exact M4 artifacts it consumes and
persists this dependency graph:

```text
audio.vocals.separate ──> speech.transcribe ──┐
                                             ├─> characters.resolve
speech.diarize ───────────────────────────────┘
```

- `audio.vocals.separate` reads `CANONICAL_AUDIO` and emits analysis-only vocal and
  accompaniment stems, a mono isolated-speech FLAC, and an immutable manifest.
- `speech.diarize` starts in parallel and reads unchanged `ANALYSIS_AUDIO`, avoiding
  dependence on separation artifacts that can damage quiet or overlapping speech.
- `speech.transcribe` remains `BLOCKED` until separation succeeds, then reads the
  isolated-speech derivative.
- `characters.resolve` remains `BLOCKED` until both transcription and diarization have
  committed verified, normalized results.

PostgreSQL is authoritative for dependency readiness, state, retries, leases, progress,
and completion. BullMQ carries only attempt-ID wake-ups. Stage configuration and its
hash are immutable for all attempts in that stage. Fan-in readiness is checked in a
transaction while the job is locked, and uniqueness constraints make duplicate unlocks
and duplicate attempts harmless.

An attempt ID also owns its immutable output prefix. A running attempt whose lease expires
is atomically marked `TIMED_OUT`; a retry receives a new attempt ID, idempotency key,
outbox event, and output prefix. The worker never reclaims possibly executed work under
the expired namespace. Heartbeats use lease-token compare-and-set, and proven ownership
loss aborts the in-flight executor HTTP request before lease-guarded completion can run.

### Capability queues and scaling

Use separate delivery queues and concurrency budgets:

- `speech-vocal-separation` for GPU separation;
- `speech-transcription` for GPU ASR;
- `speech-diarization` for GPU diarization; and
- `speech-character-identification` for CPU timeline resolution.

The separation of queues is intentional even if one worker deployment consumes several
of them in an early environment. Production deployments scale each capability from its
own queue age, oldest-job wait, active attempt count, observed execution duration, and
GPU utilization/memory. A single global speech queue would allow a long or saturated
model to starve unrelated work and would prevent safe per-capability rollout.

Each GPU executor starts with one bounded inference slot per GPU. Higher concurrency or
batching is allowed only after representative VRAM, latency, fairness, and quality
measurements. Saturation returns a stable retryable response rather than accepting
unbounded work into process memory. Tenant quotas and admission policy remain control-
plane concerns; the executor cannot authorize extra work.

When speech analysis is enabled, the worker creates none of the speech consumers until
all three authenticated capability readiness responses exactly match the configured
capability, provider, model ID, model revision, and runtime version. Each remote delivery
repeats its own readiness handshake before acquiring a PostgreSQL lease. This deliberate
preflight cost keeps executor unavailability or rollout drift from spending a semantic
attempt; the immutable `expectedModel` command remains the execution-time race guard.

The Python concurrency limiter returns HTTP 429 before workspace creation, input download,
or provider execution. Nest alone treats that status as safe capacity deferral: it returns
the same attempt and published outbox identity to delayed delivery without incrementing
`attemptNumber`. Deferral count and exponential delay are bounded—12 deferrals at 15 to
240 seconds—after which ordinary retry/terminal policy applies. A provider error, timeout,
HTTP 5xx, or expired lease is not eligible for same-attempt reuse because execution may
already have started.

### Provider and artifact contracts

Nest depends on an application port for `separate`, `transcribe`, and `diarize`. Python
depends on a narrower provider protocol for the actual model invocation. The Python
service, not a provider adapter, owns:

- constant-time internal authentication and configured bucket enforcement;
- exact server-generated source and output keys;
- checksum verification before inference;
- bounded input, output, duration, concurrency, and scratch space;
- immutable conditional writes and cleanup;
- compact versioned HTTP responses; and
- stable sanitized errors.

A provider receives a checksum-verified local audio path and server-owned typed options.
It cannot choose a tenant, object key, arbitrary URL, model ID, device, command-line
argument, or workflow transition.

Feature-length transcript and diarization detail is written to immutable private JSON
manifests. HTTP responses contain only bounded counts, model identity, artifact sizes,
checksums, and producer/schema versions. The Nest worker independently verifies the
exact object envelope and digest, including `contract-version` and authoritative
`input-sha256` object metadata. Separation results must also prove that vocal and
accompaniment stems preserve the canonical sample rate/channels and isolated speech is
16 kHz mono. Nest streams manifests from S3 through the configured and declared-size byte
ceilings while hashing, then materializes the verified bounded body for strict schema and
timeline validation and commits artifact lineage plus normalized relational projections
in one transaction. Python never writes the VoiceVerse database.

All time boundaries use integer microseconds on the unchanged source clock and the
half-open convention `[startUs, endUs)`. Model-native floating-point seconds are rounded
and validated once at the provider boundary. Adjacent intervals can therefore meet at a
boundary without an artificial overlap.

Separation stems are classified as analysis artifacts. The canonical master is never
overwritten, and no M5 stem is eligible to become a delivery soundtrack without a later
mixing and human-QC contract.

### Character-memory boundary

`SpeakerCluster` and provider speaker labels are scoped to one diarization run. They are
not public identity and cannot be reused as character IDs.

`Character` is project-scoped and supplies the stable ID used across the movie.
`SpeakerCharacterAssignment` records which run-local cluster mapped to that character,
including method, confidence, first appearance, speaking duration, segment count, and
word count. `CharacterIdentificationRun` binds the exact transcript and diarization
runs that supplied the evidence. `ProjectSpeechAnalysisSelection` chooses the analysis
revision presented by product queries without deleting older evidence.

The initial resolver is deterministic. It maps words to maximum-overlap exclusive
speaker turns, applies a small bounded nearest-turn fallback, and leaves uncertain words
unassigned. Movie-local character ordering is based on first appearance with stable
tie-breaking, not on an opaque provider label. Ordering statistics require one linear pass
over selected evidence turns followed by an `O(s log s)` sort of the `s` speaker clusters;
the ordering pass does not rescan all turns per character.

M5 does not infer or persist age, gender, accent, personality, appearance, relationship
graphs, or voice identity. It does not persist voice embeddings. Adding those attributes
requires an evidence-versioned profile with provenance, confidence, user correction,
and retention policy. Any future embedding is treated as biometric-like restricted data
and requires explicit purpose, consent/licensing, encryption, least-privilege access,
audit, deletion, and regional legal review.

## Model supply chain and licensing

The base FastAPI lock and image contain no production separation, Whisper, Pyannote,
Torch, CUDA, or model-weight dependency. Provider protocols are tested with injected
deterministic providers. Enabling a flag without a configured provider fails closed and
keeps readiness unavailable. Stock Compose does not inject those test providers; a real
capability requires a separately built image or adapter containing an approved provider.

Every production capability requires an approved manifest containing:

- source repository and package lock;
- exact runtime, CUDA, cuDNN and driver compatibility;
- model repository, revision and cryptographic digest;
- code, model, training-data, redistribution and commercial-use license review;
- controlled offline acquisition record and malware/vulnerability scan;
- signed image plus software and model bill of materials;
- representative quality, latency, throughput, VRAM and cost results; and
- named rollback model/image and change owner.

Models are fetched only by a controlled build or provisioning job and mounted read-only
at runtime. Executors and readiness probes do not contact model registries or hold a
Hugging Face access token. Optional model-library telemetry is disabled unless an
explicit privacy review approves it.

[Faster-Whisper](https://github.com/SYSTRAN/faster-whisper) with the
[OpenAI Whisper](https://github.com/openai/whisper) model family,
[pyannote.audio](https://github.com/pyannote/pyannote-audio) with the gated
[`community-1` model](https://huggingface.co/pyannote/speaker-diarization-community-1),
and a vocal-separation model are candidates, not automatic defaults. Pyannote model
conditions must be accepted by an authorized company account, and the selected
separation weights require their own license review. The archived
[Meta Demucs repository](https://github.com/facebookresearch/demucs) is not adopted
merely because its interface is familiar.

## Security

- Capability endpoints are not internet-routable. Network policy permits ingress only
  from the workflow identity and egress only to the approved private object endpoint and
  telemetry collector.
- The current high-entropy bearer is mounted only in workflow and executor containers,
  compared in constant time, and rotated through the managed secret store. Workload
  identity or mTLS replaces it before any cross-cluster trust boundary is introduced.
- Executor workload identity is limited to the configured bucket and required input/
  attempt prefixes. Requests contain no signed URLs or end-user access tokens.
- Containers run non-root with a read-only root filesystem, dropped capabilities,
  resource limits, bounded process count, and private scratch that is erased after every
  outcome. Application byte/duration ceilings are not a filesystem quota: production
  pods additionally require `emptyDir.sizeLimit`, ephemeral-storage requests/limits,
  namespace quota, node headroom, and tested disk-pressure/eviction behavior.
- Supabase `anon`, `authenticated`, and `service_role` Data API roles remain denied on
  VoiceVerse business tables. Tenant authorization is enforced in Nest queries and
  repeated in composite database relationships.
- Source media and manifests are restricted; transcripts and character profiles are
  confidential. Object keys, transcripts, model inputs, user filenames, tokens, and raw
  provider errors are excluded from application logs and metric labels.

## Observability and operations

The repository foundation exposes structured logs, stage counters and duration
histograms. Production activation additionally requires trace-context propagation from
outbox relay through worker, executor, and object storage. Structured events may include
organization, project, job, stage, attempt, execution, model revision, stable error code,
and retry classification, but never source content.

The activation dashboards and alerts require metrics including:

- queue depth, oldest queued age, publish delay, claim delay, active and recovered
  attempts by capability;
- readiness-gated consumer pauses, per-delivery preflight failures, bounded capacity
  deferrals, semantic retries, lease timeouts, heartbeat ownership loss and HTTP aborts;
- executor request, inference, artifact-upload and end-to-end duration histograms;
- success, retryable failure, terminal failure, timeout, saturation, manifest-validation
  failure, and no-speech counts;
- input/output audio duration and bytes using bounded numeric histograms, not media IDs
  or filenames as labels;
- GPU allocation, utilization, memory, temperature, throttling and OOM signals; and
- model/provider/runtime revision exposed as controlled build information.

Liveness reports process health without loading or downloading a model. AI readiness
requires configured storage, toolchain, scratch space, and every enabled provider. The
authenticated worker handshake also compares the exact configured provider, model ID,
model revision, and runtime version with the descriptor served by each capability. The
approved model digest is enforced through the signed release/model BOM rather than the
current readiness payload. Alerts cover queue-age SLOs, lease recovery, retry storms, GPU
saturation/OOM, error-rate changes, manifest-integrity failures, storage growth, and cost
anomalies.

The active job polling path derives pending/unavailable result summaries from authoritative
job status and does not scan transcript or character aggregates until the job succeeds.
This keeps five-second UI polling proportional to workflow metadata rather than movie
dialogue volume.

## Production activation boundary

Repository completion does not approve production inference. Before activation:

- representative feature-film manifests must prove the configured stream cap, worker RSS,
  bounded JSON materialization, strict parse time, batched insert volume, and atomic
  completion timeout; incremental JSON parsing and staged/bulk publication are required if
  the measured envelope is unsafe;
- GPU pods must enforce quota-bounded ephemeral scratch and pass disk pressure, eviction,
  cleanup, worker-kill, timeout, and network-partition tests;
- each pinned real provider/image/model must pass signed-image/model-BOM, CUDA/driver,
  security, commercial-license, throughput, VRAM, cost, and rollback gates;
- licensed cross-language and code-switching golden contracts must approve WER, DER,
  separation damage, timestamps, no-speech/overlap behavior, normalized manifests, and
  human quality thresholds; and
- private HTTPS deployment, managed migration/rollback rehearsal, trace propagation,
  dashboards, alerts, SLOs, autoscaling, quotas, cost controls, and on-call runbooks must
  be verified in isolated staging and production canaries.

## Consequences

- Web, API, and Supabase availability are isolated from feature-length GPU inference.
- Each model can scale, deploy, benchmark, and roll back independently.
- The database and manifest contracts preserve reproducibility when a provider changes.
- Parallel separation and diarization shorten the critical path and protect diarization
  from separator damage, at the cost of reading two prepared artifacts and operating
  two root stages.
- Separate images, queues, node pools, model provisioning and dashboards increase
  platform complexity and baseline cost.
- Startup-wide readiness prevents a partially configured speech fleet from consuming any
  queue, while per-delivery preflight protects long-lived consumers from later drift. It
  adds one short authenticated request before each remote lease claim.
- Bounded 429 deferral preserves semantic attempt budget during known pre-provider
  saturation, but cannot substitute for queue-based autoscaling or tenant admission.
- New namespaces after lease expiry prevent ambiguous overwrite/reconciliation at the cost
  of potentially orphaned immutable objects that require lifecycle cleanup.
- Immutable manifests plus normalized projections consume more storage, but give both
  forensic evidence and efficient tenant-scoped product queries.
- Project characters remain stable across the current movie while uncertain identity is
  explicit. Cross-project/person identity and demographic inference are unavailable by
  design.
- Default-disabled capabilities mean repository completion is not production model
  activation. Operations must deliberately pass every gate.

## Rejected alternatives

- **Run models in Vercel or Supabase Edge Functions:** rejected because feature-length
  GPU workloads, native dependencies, scratch space, and durable execution do not fit
  the web/identity boundary.
- **Bundle all models into the base FastAPI image:** rejected because incompatible
  runtime stacks, image size, licenses, rollout cadence, and resource profiles would
  create one large failure domain.
- **Use one shared speech queue:** rejected because one saturated capability can starve
  the others and queue depth cannot drive capability-specific autoscaling.
- **Chain queue jobs without persisted dependencies:** rejected because duplicate or
  lost delivery would make readiness and fan-in ambiguous.
- **Reclaim an expired running attempt under the same output prefix:** rejected because
  the previous worker or provider may have executed or written immutable outputs; timeout
  plus a new attempt namespace gives unambiguous ownership.
- **Treat every retryable executor error as a capacity deferral:** rejected because only
  the limiter's pre-provider HTTP 429 proves inference did not start. Timeouts, HTTP 5xx,
  provider failures, and lease expiry use ordinary new-attempt retry policy.
- **Diarize only the separated vocal stem:** rejected because separation may erase quiet
  or overlapping speech and thereby corrupt speaker evidence.
- **Transcribe the unseparated analysis track only:** rejected as the v1 ASR path because
  isolated speech can improve dialogue focus; the provider port permits future
  ensemble/fallback experiments without changing the DAG contract.
- **Treat provider speaker labels as character IDs:** rejected because labels are local
  to a run and can reorder when a model or input changes.
- **Persist voice embeddings now:** rejected because the MVP resolver does not need them
  and their privacy, consent, retention, access, and regional legal controls are not yet
  implemented.
- **Adopt archived Demucs directly:** rejected pending selection of a maintained runtime,
  exact weights, measurable quality, and complete license review.
