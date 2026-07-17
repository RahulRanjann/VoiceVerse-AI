# ADR-0009: Use an authenticated Python executor for CPU media preparation

- Status: Accepted
- Date: 2026-07-17

## Context

The first post-ingest workload must inspect an untrusted, feature-length MP4 and
produce deterministic audio derivatives with FFprobe and FFmpeg. This work is CPU,
memory, network, and scratch-disk intensive. It has different scaling and failure
characteristics from public NestJS requests, but it is not model inference and does
not yet justify a new business microservice.

PostgreSQL must remain authoritative for jobs, stages, attempts, progress, retries,
and artifact registration under ADR-0002. The executor must not gain ownership of
tenant authorization, project state, audit records, or workflow transitions. At the
same time, media-native dependencies belong in the Python execution plane established
by ADR-0001, rather than in the public API image.

The initial platform needs a development-friendly transport now. Feature-length and
GPU workloads will later benefit from independently scheduled Kubernetes Jobs, so the
transport must not leak into the workflow domain.

## Decision

NestJS owns the `SOURCE_MEDIA_PREPARATION` job and its single ordered execution stage.
A BullMQ delivery wakes the Nest workflow worker, which claims an authoritative stage
attempt in PostgreSQL. The worker invokes a `MediaPreparationExecutor` application
port. Its first adapter calls a versioned, private FastAPI endpoint over authenticated
HTTP.

Nest maps pipeline version `source-preparation-v1` to the versioned executor adapter.
The HTTP request contains only:

- the execution ID and authoritative workflow attempt ID;
- the persisted SHA-256 configuration hash for the server-owned transformation
  profile;
- the configured private bucket and exact server-generated source/output object keys;
- the authoritative source size and SHA-256; and
- an optional preferred audio language tag used only by the deterministic selection
  policy.

The attempt ID and exact attempt-scoped keys form the idempotency identity. The Nest
adapter owns its HTTP timeout, while the executor owns configured input/output/duration,
scratch, subprocess-output, FFprobe, FFmpeg, and thread limits. The deterministic
transformation profile is server-owned; its hash is created with the attempt, sent to
the trusted executor, and stamped onto every output object. It is evidence, not a
client-selectable profile. The endpoint path and result schema are versioned
independently from the public API, and unknown request fields are rejected.

The endpoint never accepts raw FFmpeg arguments, arbitrary filesystem paths, tenant
credentials, browser access tokens, or business-state mutations.

The Python executor downloads the clean source once, runs a bounded FFprobe operation,
and requires the actual source to be an MP4-family container with at least one usable
video stream and one audio stream. It then emits:

- a sanitized immutable `PROBE_MANIFEST`;
- a 48 kHz lossless FLAC `CANONICAL_AUDIO` artifact that preserves the supported source
  channel count and layout; and
- a 16 kHz mono lossless FLAC `ANALYSIS_AUDIO` artifact for later ASR and diarization.

The executor calculates each output's SHA-256 and byte size before upload, uses
conditional immutable writes, and accepts a pre-existing destination only after a HEAD
confirms matching size and SHA-256 metadata. Every object carries artifact kind,
execution/attempt identity, configuration hash, producer name/version, FFmpeg version,
and SHA-256 metadata. The executor uploads the two audio files first and the sanitized
manifest last as a completeness marker, then returns its producer version plus a
versioned result with normalized media metadata, byte counts, checksums, tool versions,
and stable error codes.

Nest validates the authenticated result schema, execution/attempt identity,
authoritative source size/checksum, MP4-family format, required video stream, producer
version, and complete artifact-kind set. It then independently HEADs all three exact
keys and compares byte size, media type, checksum metadata, kind, execution/attempt IDs,
configuration hash, producer name/version, and FFmpeg version. Only after those checks
does a lease-token guarded transaction commit artifacts, lineage, the returned executor
version, its known pipeline/configuration versions, and terminal transitions. Python
never writes the VoiceVerse database.

The HTTP details stay inside the adapter. A later adapter may create a Kubernetes Job,
watch its execution, and reconcile its manifest without changing workflow application
services or persisted contracts.

The scan that establishes the clean precondition is also PostgreSQL-authoritative. A
delivery compare-and-set claims the pre-created scan attempt with a lease, heartbeats
while streaming and hashing the source through ClamAV, and uses the lease token to guard
the verdict transaction. Stale published `media.scan.requested` commands use the same
cooldown/republication policy as workflow commands. One expired scan lease may reclaim
the same attempt; a second expiry closes the attempt/video in error state. Permanent
source-checksum and ClamAV stream-limit failures are persisted and acknowledged without
another BullMQ download, while transient failures retain bounded transport retries.

The clean-verdict transaction normally creates the job, stage, first queued attempt,
initial transitions, and `workflow.stage.execute` outbox command together. A bounded
worker-side reconciler repairs that invariant for checksum-backed `CLEAN`/`UPLOADED`
videos that predate the workflow or missed initialization: it selects candidates in a
stable order, rechecks eligibility inside the write transaction, invokes the same
unique-keyed initializer, and records an audit event.

The MVP allows one immutable active/source `Video` per `Project`. The API rejects a
second source before object-storage allocation, and `UNIQUE (videos.project_id)` closes the
concurrent-request race. This generation fence prevents a late scan or workflow for an
older source from regressing project status. The migration refuses to install that
index when historical duplicates exist and instructs operators to split each source
into its own project. Existing `RUNNING` scan rows are backfilled as immediately expired
recoverable leases before the new lease-state constraint is installed, preserving their
attempt identity without inventing a verdict.

The durable outbox is also the recovery source after publication. If a
`workflow.stage.execute` event remains `PUBLISHED` beyond a cooldown of at least 60
seconds and twice the outbox lease while its eligible attempt is still queued or has an
expired lease, the worker resets that event to `PENDING` for deterministic BullMQ
republication. The first expired-lease recovery compare-and-set re-leases the same
attempt and output namespace and increments `recovery_count`. If that recovered attempt
expires again, it transitions to `TIMED_OUT`; the ordinary retry budget creates the next
numbered attempt and new namespace. A concurrent heartbeat renewal defeats the recovery
compare-and-set.

## Authentication and security

- The internal endpoint is not internet-routable. Network policy permits ingress only
  from the workflow worker identity and egress only to approved object storage and
  telemetry endpoints.
- The initial private HTTP adapter authenticates with a high-entropy bearer credential,
  compares it in constant time, and rotates it through the managed secret store. This
  static credential is an interim single-cluster deployment control, not an end-user
  token and not a long-term multi-cluster identity design. Workload identity or mTLS
  must replace it before cross-cluster exposure, behind the same authentication port.
  Production refuses to enable the endpoint without the credential; missing or invalid
  request authentication fails before object access. The v1 adapter returns stable
  `INTERNAL_AUTH_NOT_CONFIGURED` (503) and `AUTHENTICATION_REQUIRED` (401) errors for
  those cases without revealing configuration or credential details.
- The bearer credential is mounted only in the Nest worker and Python executor. The
  public API uses a role-specific configuration validator that substitutes a non-secret
  sentinel instead of exposing any supplied executor secret through `ConfigService`,
  receives no executor environment variables in Compose, and does not import the
  worker's executor adapter.
- The executor's object-store identity is restricted to the configured private bucket
  and the source-read/artifact-write prefixes it needs. Requests contain exact
  server-generated keys, never URLs. Bucket and key validation prevents path or
  cross-bucket expansion; conditional writes enforce immutability.
- FFmpeg and FFprobe are launched without a shell, with fixed argument arrays,
  protocol restrictions, timeouts, bounded output capture, process-group termination,
  and no interactive input.
- The container runs as a non-root user with a read-only root filesystem, dropped
  capabilities, a private disk-backed scratch volume, and a process-count bound.
  Production activation adds CPU, memory, ephemeral-storage, and scratch-quota limits
  to the pod specification. Scratch files are removed after every outcome.
- Logs and traces use request, execution, attempt, and error identifiers. They never
  contain signed URLs, object keys, source media, raw probe payloads, user filenames,
  or secrets.

## Failure modes and recovery

| Failure                                                                  | Required behavior                                                                                                                                                                             |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Missing workflow for an eligible legacy clean video                      | Bounded reconciler rechecks the row transactionally and invokes the idempotent initializer with an audit event.                                                                               |
| Missing BullMQ wake-up for a queued or expired malware scan              | After the cooldown, reset the matching `media.scan.requested` event to `PENDING` and republish its deterministic job ID.                                                                      |
| Malware scan worker dies                                                 | Heartbeat expiry permits one same-attempt lease reclaim; another expiry closes scan and video in authoritative error state.                                                                   |
| Permanent checksum or scanner policy failure                             | Persist the stable terminal error and acknowledge the BullMQ delivery without downloading the feature-length object again.                                                                    |
| Published outbox command but missing BullMQ wake-up                      | After the cooldown, reset the matching durable event to `PENDING` and republish the same deterministic transport job ID.                                                                      |
| Invalid, audio-only, audio-less, non-MP4, or otherwise unsupported media | Return a deterministic non-retryable error; Nest records a sanitized failure.                                                                                                                 |
| Executor unavailable, overloaded, or explicitly timed out                | Record a stable attempt error, retry with bounded exponential backoff, and respect the job retry budget.                                                                                      |
| Worker dies while HTTP execution continues                               | Heartbeats stop; the first expired lease reclaims the same attempt/keys once so conditional writes and Nest HEAD verification can reconcile outputs.                                          |
| Recovered attempt's lease expires again                                  | Lease-token/cutoff CAS marks it `TIMED_OUT`; the ordinary retry budget creates the next numbered attempt and output namespace.                                                                |
| HTTP result is returned after matching outputs already exist             | Python accepts only matching immutable size/SHA metadata; Nest independently verifies all identity/configuration/producer/tool metadata, then a lease-token guarded transaction commits once. |
| Only some outputs are written                                            | Nest registers none because all three HEAD checks must pass. Same-attempt recovery may complete the set; later-attempt retry and lifecycle cleanup handle exhaustion.                         |
| Result or stored-object contract differs                                 | Fail closed with a stable error and never attach the output to the project.                                                                                                                   |
| Scratch disk, memory, or execution limit is exceeded                     | Terminate the process tree, clean scratch space, and return a stable resource-limit error.                                                                                                    |
| Media-tool timeout occurs                                                | Executor terminates the subprocess tree and cleans scratch; Nest records the stable failure/retry. Public cancellation remains deferred.                                                      |

All deliveries remain at least once. Uniqueness constraints, stale-publication cooldown,
compare-and-set claims/recovery, bounded recovery count, lease-token guarded commits,
attempt-scoped output keys, conditional immutable writes, independent object HEAD
verification, and authenticated result validation provide correctness; HTTP or BullMQ
delivery is not assumed to be exactly once.

## Consequences

- The public API remains lightweight and cannot be starved by FFmpeg processes.
- CPU media execution can scale independently from web/API traffic and later GPU
  workers.
- One source download produces both audio derivatives, avoiding repeated transfer and
  decode work for feature-length media.
- Versioned request/result schemas, service authentication, timeout policy, and
  compatibility tests add implementation cost.
- A long-lived HTTP request can end ambiguously and consumes a worker connection. One
  same-attempt recovery plus independent HEAD verification can commit a matching result
  without fabricating a new attempt. Exhaustion advances to a new namespace and can
  leave unreachable outputs for lifecycle cleanup. Kubernetes Jobs are the preferred
  adapter once workload duration or scale justifies their scheduling cost.
- Durable replay deliberately permits duplicate transport delivery after the cooldown;
  authoritative database claims and terminal no-ops absorb it. The liveness gain is
  worth the additional recovery query, index, and state-machine complexity.
- One immutable source per project prevents stale-generation status regressions, but it
  also makes source replacement intentionally unavailable in the MVP. Removing the
  unique index requires an explicit revision/generation model with an active-source
  pointer, guarded status updates, and supersession of older scan/workflow attempts.
- The two lossless audio artifacts increase storage use. Their distinct purposes avoid
  irreversible downmixing of the production master while giving speech models a stable
  analysis input.

## Rejected alternatives

- **Run FFmpeg in the NestJS API process:** rejected because untrusted native parsing,
  long execution, and scratch-disk pressure would couple API availability to media
  workloads.
- **Run FFmpeg directly in the Node workflow worker:** rejected because it would put a
  second native media runtime in the control-plane image and weaken the control/compute
  boundary. Nest should orchestrate execution, not own codec tooling.
- **Let Python consume BullMQ and update workflow tables:** rejected because it gives the
  compute plane business-state ownership and couples Python to Redis and Prisma schema
  details.
- **Create one Kubernetes Job per attempt immediately:** rejected for this milestone
  because it adds scheduler, watcher, local-development, and cleanup complexity before
  measured workload data justifies it. The execution port preserves this migration.
- **Process media synchronously from a public API request:** rejected because browser,
  proxy, and deployment timeouts cannot provide durable feature-film execution.
- **Use a third-party media-transcoding API as the only implementation:** rejected
  because it adds restricted-media egress, provider lock-in, and cost before a provider
  abstraction or compliance review is required.
