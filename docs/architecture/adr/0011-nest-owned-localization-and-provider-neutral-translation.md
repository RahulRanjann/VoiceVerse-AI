# ADR-0011: Keep localization state in NestJS and execute translation through a provider-neutral Python boundary

- Status: Accepted
- Date: 2026-07-17

## Context

Milestone 5 produces immutable, tenant-scoped dialogue evidence with exact timing and a
project selection pointer. Milestone 6 must turn one committed analysis into editable
scenes, source corrections, target-language translations, terminology, cultural context,
review state, and reproducible asynchronous LLM requests.

Translation combines two concerns that must not share authority:

- localization is business state: tenant authorization, project lineage, editorial
  history, approval, optimistic concurrency, idempotency, leases, audit, and retention;
- LLM execution is compute: provider SDKs, model/runtime dependencies, request limits,
  rate limits, prompt rendering, output parsing, and provider replacement.

Sending a whole project or mutable live rows to a provider would make a result
irreproducible, expand confidential-data disclosure, and race editorial changes. Letting
Python or a model provider write PostgreSQL would bypass Nest authorization, transaction,
audit, and optimistic-concurrency policy. Treating BullMQ or a provider request as the
source of truth would violate ADR-0002's PostgreSQL authority.

## Decision

### NestJS owns localization state

NestJS is the only application boundary allowed to create or mutate localization
business rows. It authorizes organization membership and project access, commits the
selected M5 analysis, bootstraps deterministic scenes, appends revisions, changes
selection pointers with compare-and-swap, enforces editor-state transitions, creates
generation requests, validates results, and writes identifier-only `AuditLog` events.

PostgreSQL is authoritative for every stable identity, append-only revision, current
selection, editor state, generation status, attempt budget, idempotency key, lease,
heartbeat, execution ID, failure code, and terminal transaction. BullMQ may wake a Nest
worker, but it does not own generation state and this milestone does not add a
`WorkflowJobKind`.

The workspace references the exact selected M5 analysis through tenant/project composite
keys. Scene, source-dialogue, translation, and glossary content are append-only. Mutable
selection rows contain the active pointer and optimistic counter; undo/redo selects an
existing revision rather than modifying history. Direct database triggers reject update
and delete on revision content. Case-insensitive glossary identity uses NFC input and the
locale-neutral PostgreSQL `und-x-icu` root collation, matching the Node/Python Unicode
lowercase contract instead of inheriting a deployment's default database locale.

### Snapshot only bounded selected context

Nest resolves current scene, source-dialogue, and target-track glossary selections before
queueing. It creates canonical, immutable configuration, input, and context snapshots
with SHA-256 hashes. The context includes only the selected scene's cultural context and
a deterministic bounded set of selected glossary entries; it is not a project dump.

Database and application limits bound dialogue text, terminology, cultural context,
number of glossary entries, and serialized JSON bytes. Overflow fails before provider
invocation rather than truncating silently. A generation permanently records provider,
model ID/revision, Python runtime, prompt version, configuration hash/snapshot, selected
input revision hash/snapshot, and context hash/snapshot.

### Python executes an authenticated provider-neutral contract

A Nest translation worker claims a queued generation in PostgreSQL using a short
transaction and `FOR UPDATE SKIP LOCKED`, then calls a private authenticated versioned
Python endpoint through an application port. The request carries the execution identity,
pinned model/runtime/prompt descriptor, and bounded server-created snapshots. It never
carries a database credential, arbitrary URL, browser token, or authorization decision.

Python validates the contract, applies execution/concurrency limits, renders the pinned
prompt, invokes an injected `TranslationProvider` adapter, validates bounded structured
output, and returns a typed response or sanitized stable error. Provider-specific SDKs,
retry hints, token accounting, and model response parsing remain behind that adapter.
Replacing a provider must not change Nest domain models or public APIs.

The model provider never writes PostgreSQL, object storage, audit records, or queue state.
Python also never writes VoiceVerse business state. Nest verifies generation/execution
identity, model/runtime/prompt identity, expected line coverage, and output bounds, then
uses the live lease token to atomically append target revisions, update draft selections,
write content-free audit metadata, and mark the generation succeeded. A stale worker or
late provider response cannot commit after lease loss.

### Real-provider activation is fail-closed

The repository default uses deterministic injected test providers only. A real provider
is disabled and readiness remains unavailable unless an explicit server-side activation
flag and complete provider configuration are present. Enabling it in production requires
pinned model/runtime/prompt versions, managed credentials, private routing and restricted
egress, retention/training and regional-processing review, DPA/legal approval,
representative multilingual quality/safety tests, tenant quotas and cost limits,
lease/retry drills, dashboards/alerts, and a named rollback.

The provider contract must prohibit training on submitted content and require approved
retention/deletion behavior. A provider change or prompt change creates new immutable
generation provenance; it never rewrites an older result.

## Security and privacy

- Supabase remains private PostgreSQL. `anon`, `authenticated`, and `service_role` Data
  API roles receive no privileges on localization tables; browsers use Nest APIs.
- Source dialogue, translated dialogue, glossary terms, cultural context, prompts, and
  generation snapshots are confidential. Provider disclosure is limited to the approved
  bounded request needed for one target scene.
- Logs, traces, metric labels, BullMQ diagnostics, and `AuditLog.metadata` may contain
  stable tenant/project/entity/generation/execution IDs, counters, durations, sizes,
  model versions, status, and sanitized error codes. They must not contain any source or
  generated text, terminology, cultural context, prompt, snapshot, or raw provider error.
- The Python endpoint is not public. Authentication is checked before parsing content or
  invoking a provider. Workload identity or mTLS is preferred across a production trust
  boundary; managed secrets are an interim private-cluster mechanism.
- Provider credentials exist only in the Python execution deployment. The browser,
  public API image, database, queue payload, and persisted snapshots never contain them.

## Failure and concurrency behavior

| Failure or race                                                | Required outcome                                                                                                                                                                                          |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Duplicate generation request                                   | Per-track idempotency returns the existing row and does not spend twice.                                                                                                                                  |
| Two workers claim work                                         | Row locking with `SKIP LOCKED` and status compare-and-swap gives each row one live lease.                                                                                                                 |
| Editor changes source/context while request runs               | The generation retains its exact snapshot; output provenance remains reproducible, and the current UI identifies source-revision drift. Scene/glossary hashes remain available for a later drift surface. |
| Worker or Python dies                                          | Lease expiry permits a bounded new attempt; terminal commit still requires current lease ownership.                                                                                                       |
| Provider returns late                                          | Execution/lease mismatch rejects the response without writing revisions.                                                                                                                                  |
| Provider returns malformed, missing, extra, or oversized lines | Python/Nest fail closed with a sanitized stable error; no partial target revisions commit.                                                                                                                |
| Target/source edit races another edit                          | Selection-counter compare-and-swap yields one commit and one conflict; append and selection update share a transaction.                                                                                   |
| Provider is unconfigured or disabled                           | Readiness is unavailable and queued production consumption does not start.                                                                                                                                |

## Consequences

Benefits:

- editorial history, undo/redo, approval, authorization, and asynchronous correctness are
  enforceable independently of any LLM vendor;
- exact bounded snapshots make generated revisions reproducible, expose source-revision
  drift, and retain scene/glossary evidence for later drift comparison without mutating
  old work;
- a provider has the minimum compute role and cannot bypass tenant or audit policy; and
- generation can later use BullMQ wake-ups or another delivery adapter without changing
  PostgreSQL authority.

Costs:

- selected context is deliberately duplicated in immutable snapshots and requires
  retention/capacity planning;
- Nest must validate a provider result and own an additional lease worker rather than
  delegating a whole workflow to Python;
- append-only history needs an explicit audited tenant-erasure procedure; and
- changing model, prompt, terminology, or scene context does not silently refresh old
  translations—immutable provenance lets later tooling surface that drift for deliberate
  regeneration or editing.

## Rejected alternatives

### Let Python or the provider write localization tables

Rejected because it bypasses tenant authorization, optimistic concurrency, audit policy,
lease ownership, and the Nest transaction that selects visible revisions.

### Store only the final translated text

Rejected because it destroys source/model/prompt/context provenance, history, undo,
human edits, and reliable comparison after a provider change.

### Send the complete project context on every request

Rejected because it is unbounded, expensive, difficult to reproduce, and exposes more
confidential content than one scene requires.

### Model translation as a new generic workflow job

Rejected for this milestone. A generation already has the idempotency, queue state,
attempt budget, lease, provenance, and terminal transaction it needs. Adding workflow
enums/stages would couple interactive editorial requests to M4/M5 media DAG semantics
without improving authority.

### Enable a convenient real provider by default

Rejected because provider retention/training policy, regional processing, legal terms,
quality, cultural safety, cost, rate limits, and production observability require explicit
approval and environment-specific controls.
