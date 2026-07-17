# Milestone 6: Scene-aware contextual translation

Milestone 6 turns the committed Milestone 5 dialogue timeline into an editable,
versioned localization workspace. It adds deterministic scene bootstrap, one track per
configured target language, source and target revision history, project terminology and
cultural context, and provider-neutral asynchronous translation generation.

The bounded delivery stops at reviewed text. It does not synthesize speech or produce
localized media.

## Architecture decisions before implementation

- [ADR-0001](../architecture/adr/0001-control-and-compute-planes.md) keeps business
  policy in NestJS and model/runtime concerns in Python.
- [ADR-0002](../architecture/adr/0002-postgres-workflow-authority.md) keeps PostgreSQL
  authoritative for asynchronous state and leases.
- [ADR-0010](../architecture/adr/0010-speech-analysis-gpu-execution-and-character-memory.md)
  defines the immutable M5 dialogue evidence consumed here.
- [ADR-0011](../architecture/adr/0011-nest-owned-localization-and-provider-neutral-translation.md)
  fixes the localization-state, prompt/context, and LLM-provider boundary.

## 1. Goal and scope

An authorized editor can bootstrap a project exactly once from its selected M5 speech
analysis, open a target-language track, edit scene context and dialogue text without
destroying history, maintain target-specific terminology, request an asynchronous
translation for a scene, review the result, undo by selecting an older revision, and
approve individual translated lines.

The durable aggregate is:

```text
Project + committed SpeechAnalysis
└── LocalizationWorkspace
    ├── LocalizationScene -> append-only SceneRevision + current selection
    ├── LocalizedDialogue -> immutable M5 DialogueSegment
    │   └── append-only SourceDialogueRevision + current selection
    └── LocalizationTrack (one target language)
        ├── DialogueTranslation
        │   └── append-only TranslationRevision + current selection/editor state
        ├── GlossaryEntry -> append-only GlossaryRevision + current selection
        └── TranslationGeneration (queued/running/succeeded/failed)
```

All time values are integer microseconds on the unchanged source clock and use half-open
`[startUs, endUs)` intervals. UUIDs are public stable identities; revision numbers and
selection counters are positive integers.

### Explicit exclusions

This milestone does not add source-video replacement, scene detection from image/video
models, subtitle layout or export, on-screen-text translation, TTS, voice cloning,
emotion synthesis, lip sync, soundtrack mixing, final rendering, billing, or dubbed
delivery. It does not change `WorkflowJobKind` or reuse M5 workflow stages. It does not
enable a real LLM provider in the default repository configuration.

## 2. Deterministic bootstrap

`scene-bootstrap.v1` is a server-owned algorithm over the currently selected,
successfully committed M5 `SpeechAnalysis`:

1. In one serializable transaction, read the project speech-analysis selection and bind
   the workspace to that exact composite selection key; the unique project/workspace key
   closes concurrent bootstrap races.
2. Read `DialogueSegment` rows in `(sequenceNumber, id)` order. Reject bootstrap with a
   stable validation error if the selected analysis has no dialogue.
3. Start a scene at the first line. Start another before a line when the gap from the
   previous line is at least `2_000_000` microseconds, when adding the line would make
   the scene span exceed `60_000_000` microseconds, or when the current scene already
   contains 200 dialogue lines.
4. Number scenes from one. Revision 1 spans the first line start through the last line
   end. Create one stable `LocalizedDialogue` per M5 line, copying its sequence and exact
   timing and creating source revision 1 from its immutable text.
5. Create the initial scene/source selection rows at optimistic revision 1. Create only
   the requested target track after proving it is a configured `ProjectTargetLanguage`.
   Later target requests reuse the project workspace and idempotently open another track.
6. Commit workspace, scenes, anchors, initial revisions, selections, tracks, and one
   identifier-only `AuditLog` entry atomically.

The workspace foreign key points at the exact `ProjectSpeechAnalysisSelection` tuple.
After bootstrap, that committed M5 selection cannot be changed in place. A future source
or analysis replacement requires an explicit localization-rebase design; it must not
silently repoint existing dialogue.

The unique project/workspace key closes concurrent bootstrap races. A retry returns the
existing workspace only when its committed analysis matches. The algorithm never updates
or deletes M5 rows, and running it for the same ordered M5 input and configuration must
produce the same scene boundaries, ordinals, dialogue membership, source text, and
timing.

## 3. Persistence contract

The Prisma model is split across stable identities, append-only content, and mutable
selection rows:

- `LocalizationWorkspace` binds organization, project, initiating membership, and the
  committed speech analysis. Only one workspace exists per project.
- `LocalizationTrack` is unique by workspace and configured target language.
- `LocalizationScene`, `LocalizedDialogue`, `DialogueTranslation`, and `GlossaryEntry`
  are stable identities. A localized dialogue also carries a composite foreign key to
  the immutable M5 dialogue segment and committed analysis.
- `LocalizationSceneRevision`, `SourceDialogueRevision`, `TranslationRevision`, and
  `GlossaryRevision` use unique `(parentId, revisionNumber)` keys. PostgreSQL triggers
  reject both `UPDATE` and `DELETE`; corrections append a new row.
- `LocalizationSceneSelection`, `SourceDialogueSelection`, `TranslationSelection`, and
  `GlossarySelection` point at a revision of their own parent. Their `revision` value is
  the compare-and-swap token for edits and undo/redo.
- A glossary revision stores a normalized source term, optional target, notes, case
  mode, and `doNotTranslate`. A target is required unless `doNotTranslate` is true. The
  case-insensitive key uses PostgreSQL's locale-neutral `und-x-icu` root collation so
  Unicode lowercase matches the Node and Python contract. The selection projection is
  trigger-checked against its revision and uniquely indexes the active normalized
  term/case mode per track; historical revisions do not block reuse.
- `TranslationGeneration` is the queueable unit. It owns a per-track idempotency key,
  status, attempt budget, lease token/deadline/heartbeat, execution ID, timestamps,
  sanitized failure fields, and immutable provider/model/runtime/prompt/config/input/
  context provenance. A generated translation revision may reference it; a manual edit
  leaves `generationId` null.

Every new table carries `organizationId` and `projectId`. Composite foreign keys prove
workspace, track, scene, dialogue, revision, generation, and actor-membership lineage,
so a globally valid UUID from another tenant or project cannot be attached. PostgreSQL
checks enforce positive revisions, valid microsecond ranges, nonblank text, bounded
content, hash form, JSON-object snapshots, attempt bounds, valid terminal timestamps,
and coherent lease/status tuples.

Indexes follow access paths rather than isolated columns: tenant/project scene timeline,
scene dialogue timeline, parent revision history, track/editor queues, track generation
history, status/lease claims, all foreign keys, and stable cursor tie breakers. Scene and
revision-history APIs use keyset cursors such as `(ordinal,id)` and
`(revisionNumber,id)` and never deep `OFFSET` pagination. Track count is bounded by
configured project languages, and the active glossary is capped at 200 entries and
returned as one bounded collection.

## 4. Editorial and generation behavior

### Append-only edits, history, and undo

An edit transaction locks the selection row, requires the caller's `expectedRevision`,
inserts `revisionNumber = previous maximum + 1`, and changes the selection pointer while
incrementing its counter. A stale counter returns HTTP 409 and does not create a revision.
Undo and redo perform the same compare-and-swap pointer update to an existing revision;
they never copy, update, or delete historical text.

`AuditLog` remains the audit mechanism. Audit action/metadata may contain tenant,
project, stable entity ID, old/new selected revision IDs, optimistic counters, state, and
request/trace identifiers. It must not contain source text, translated text, scene
summary/cultural context, glossary terms/notes, prompts, context snapshots, or provider
payloads.

### Editor states

The line state shown in the editor is:

| State        | Durable representation and allowed transition                                        |
| ------------ | ------------------------------------------------------------------------------------ |
| Untranslated | Derived from no `DialogueTranslation`; first manual/generated revision creates draft |
| Draft        | `TranslationSelection.editorState = draft`; may move to in-review                    |
| In review    | May return to draft or move to approved                                              |
| Approved     | Read-only until an editor explicitly reopens it or selects/creates another revision  |

Selecting or creating another target revision resets that line to draft. Selecting a new
source revision resets every existing target translation for that dialogue to draft in
the same transaction, and the editor visibly marks a stale source selection. Scene and
glossary changes do not rewrite translations. Immutable generation snapshots and hashes
retain the exact prior context so a later drift surface can compare it with current
selections without altering approved work.

### Bounded context snapshot

A scene generation snapshots only:

- the selected scene revision and its cultural context;
- selected source revision IDs, counters, text, speaker/character IDs when present, and
  exact timing for that scene;
- at most 200 selected glossary entries for the target track, sorted by normalized term
  and stable ID; and
- target language, contract/configuration versions, prompt version, and the selected
  revision/counter identities needed to reproduce the request.

The application rejects an oversized request rather than silently dropping context.
Per-field database bounds include 8,000 characters of scene cultural context, 500
characters per glossary term, 2,000 characters of glossary notes, and 65,536 UTF-8 bytes
per dialogue revision. The executor contract additionally caps a selected source line at
20,000 Unicode code points and 65,536 UTF-8 bytes, and a generated target line at 10,000
code points and 65,536 bytes. Generation JSON has database limits of 64 KiB for the
configuration snapshot, 1 MiB for input, and 256 KiB for context; Nest applies stable
serialized-JSON preflight limits of 60,000, 1,000,000, and 250,000 bytes respectively to
leave storage overhead. Canonical SHA-256 hashes cover each immutable snapshot and
configuration so provider output can be traced to exact inputs.

### Asynchronous control/compute boundary

1. Nest authorizes the tenant/project/track/scene, resolves all selected revisions,
   builds and hashes the bounded snapshots, and inserts a `QUEUED`
   `TranslationGeneration`. `(trackId,idempotencyKey)` returns the existing request on a
   duplicate.
2. A Nest worker atomically claims eligible rows using `FOR UPDATE SKIP LOCKED`, changes
   status to `RUNNING`, increments `attemptCount`, creates `executionId`/`leaseToken`, and
   heartbeats with compare-and-swap. PostgreSQL, not Redis or Python, owns the queue state.
3. The worker invokes a private authenticated, versioned Python translation port. Python
   validates the bounded contract and calls an injected provider adapter. The provider
   receives no database credential, tenant authority, arbitrary URL, or write callback.
4. Python returns a bounded typed result or sanitized stable error. Nest verifies request
   identity, execution identity, model/runtime/prompt identity, line coverage, and output
   limits.
5. One lease-guarded transaction rechecks that the snapshotted scene, source, glossary,
   and pre-existing target selections are still current. If any changed, it rejects the
   stale result without overwriting editorial work. Otherwise it appends target
   revisions, creates/updates draft selections, marks the generation `SUCCEEDED`, and
   writes identifier-only audit data. Failure clears the lease and stores only bounded
   sanitized `errorCode/errorDetail`.

BullMQ provides best-effort wake-ups, but no new workflow enum is needed. Correctness
comes from the generation row, uniqueness, leases, idempotency, and transactional
commits rather than queue delivery.

## 5. API and authorization contract

All routes derive `organizationId`, `projectId`, and actor identity from the authenticated
Nest context. Client-supplied tenant IDs are never trusted as authority. Viewer members
may read; editor, admin, and owner members may mutate; approval policy may be narrowed by
future organization settings. A missing or mismatched membership is indistinguishable
from an inaccessible project.

Mutating selection/editor-state endpoints require `expectedRevision` (or an equivalent
strong `If-Match` token). They update with a predicate on organization, project, stable
entity, and revision counter. Zero affected rows returns 409. A generation client sends
only `sceneId`; Nest resolves and snapshots the exact scene, source, glossary, and current
target-selection anti-overwrite identities inside a serializable transaction. A
concurrent edit is therefore reflected in the committed snapshot or causes the
serializable transaction to retry/fail—it is never trusted from client-supplied counters.

Persistence and the Nest-to-Python contract retain exact integer microseconds. Public
JSON responses expose rounded integer `startMs`/`endMs` fields (`Math.round(us / 1000)`),
matching the existing M5 presentation convention. Histories and scene timelines use
opaque keyset cursors, bounded page sizes, and stable next cursors; glossary and track
collections are hard-bounded by their domain limits.

## 6. Testable acceptance criteria

1. **Bootstrap lineage:** Given a selected committed M5 analysis, bootstrap creates one
   tenant/project workspace, stable scenes/dialogues, revision-1 content and selections,
   and configured tracks in one transaction. Repeating or racing it cannot duplicate
   rows. M5 tables are byte/row unchanged, and a cross-project analysis or dialogue FK
   fails in PostgreSQL.
2. **Deterministic scenes:** Golden dialogue timelines prove the exact 2-second-gap and
   60-second-span, 200-line-cap boundaries, one-based ordinal order, membership, and
   microsecond ranges, including stable tie handling and empty-analysis rejection.
3. **History and undo:** Scene, source, target, and glossary edits append monotonically
   numbered revisions. Direct SQL `UPDATE` or `DELETE` of any of the four revision tables
   fails. Undo/redo changes only the selection pointer/counter and preserves all history.
4. **Optimistic concurrency:** Two edits with the same expected counter produce exactly
   one commit and one HTTP 409. No orphan revision remains from the loser. Cross-tenant
   reads and writes return no content.
5. **Glossary semantics:** Blank terms, invalid normalized values, target-less translating
   entries, target-bearing `doNotTranslate` entries, mismatched selection projections,
   and duplicate active normalized terms/case modes are rejected. Historical unselected
   terms do not block a new active entry.
6. **Bounded context:** A golden snapshot proves deterministic ordering and canonical
   hashes. More than 200 glossary entries or any byte/database bound returns a stable
   validation error before provider invocation. Only the selected scene/dialogue/
   glossary revisions appear.
7. **Generation authority:** Duplicate per-track idempotency keys return one generation.
   Parallel workers claim different queued rows with `SKIP LOCKED`; stale lease tokens
   cannot heartbeat or commit. Attempt/status/timestamp constraints reject impossible
   states. A successful commit appends all outputs and changes terminal state atomically.
8. **Provider isolation:** Contract tests run against an injected deterministic Python
   provider. The provider has no database credentials and cannot write business state.
   Missing real-provider configuration keeps readiness/activation disabled.
9. **Editor state:** Generated/manual output starts draft; allowed review transitions are
   enforced with compare-and-swap; target or source selection changes reset the required
   lines to draft; source-revision drift is visible without rewriting an approved
   revision, while scene/glossary provenance remains available for a later drift surface.
10. **Content privacy:** Automated log/trace/audit capture tests use sentinel source,
    target, glossary, cultural, prompt, and provider strings and prove none appears in
    logs, metric labels, traces, queue payload diagnostics, or `AuditLog.metadata`.
11. **Pagination and query shape:** Scene timelines and revision histories return stable
    non-overlapping keyset pages under concurrent inserts. Track and glossary collections
    remain within their configured 200-entry/domain bounds, and claim/editor/history
    queries use their composite access-path indexes at feature-length scale.
12. **Migration:** A fresh database applies all migrations, an M5-shaped upgrade applies
    the hand-written M6 migration, Prisma validates/generates, and invalid cross-tenant,
    append-only, glossary, snapshot, and lease fixtures fail with named constraints.

## 7. Rollout and activation gates

Deploy the migration before code that writes M6 rows. Rehearse both a fresh install and
an M5 production-sized clone, record lock duration and index build/storage growth, verify
all Supabase Data API roles remain denied, then deploy Nest/Python contracts with the
generation consumer and real provider disabled. Enable deterministic/test providers in
non-production first; rollback application code only while retaining the additive schema
and immutable history.

A real provider remains disabled until all of the following are approved and measured:

- private authenticated executor routing, egress allow-list, managed secret rotation,
  provider data-retention/training controls, regional processing, DPA and legal review;
- pinned provider, model ID/revision, runtime and prompt versions with rollback versions;
- representative multilingual quality, cultural-safety/harm review, glossary adherence,
  hallucination/omission checks, line/timing limits, latency, rate limits, and cost caps;
- tenant quotas, attempt/lease recovery drills, circuit breaking, sanitized errors,
  dashboards and alerts for queue age, claim/lease loss, retries, failures, tokens/cost,
  and context-size rejection; and
- sentinel tests proving source/target/context/prompt/provider content does not reach
  logs, traces, metric labels, queue diagnostics, or audit metadata.

## 8. Risks and later improvements

| Risk                                                          | Mitigation                                                                                                                                                                                  |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A fluent translation changes meaning or invents detail        | Keep exact source revisions and provenance, default to draft, require editorial review, and benchmark omissions/additions by language.                                                      |
| A stale glossary or scene edit silently changes approved work | Never rewrite output; retain immutable generation hashes so a later editor surface can compare them with current selections.                                                                |
| Long films create expensive prompts or database pages         | Generate one bounded scene at a time, reject oversize context, use composite indexes and cursor pagination, and measure feature-length plans.                                               |
| At-least-once delivery duplicates spend or output             | Use per-track idempotency, database leases, execution IDs, provider request identity where available, and one transactional output commit.                                                  |
| Cultural context or dialogue leaks through telemetry          | Treat all text/snapshots as confidential, send only to the approved provider, and enforce sentinel redaction tests.                                                                         |
| Append-only history complicates tenant erasure                | Design a separate authorized tenant-erasure procedure that deliberately disables/handles immutability triggers under an audited operator path; ordinary product code cannot delete history. |

Later milestones may add visual scene evidence, relationship/profile context, batch
translation, subtitle constraints, organization-specific approval policy, quality scoring,
and translation memory. Each must preserve immutable input/output provenance and bounded
provider disclosure before it is added to the snapshot contract.
