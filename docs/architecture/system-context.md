# VoiceVerse AI system architecture

## System context

```mermaid
flowchart LR
    Creator[Creator or studio operator]
    Partner[Platform API client]
    IdP[Google identity provider]
    TTS[Voice and TTS providers]
    LLM[Translation and reasoning providers]
    Lip[Lip-sync providers]
    S3[Managed S3]
    Scanner[Malware scanner]

    Creator --> Web[Next.js web application on Vercel]
    Partner --> API[NestJS control plane]
    Web --> API
    API --> IdP
    API --> DB[(Supabase PostgreSQL)]
    API --> Queue[(Redis and BullMQ)]
    API --> S3
    Web -->|Short-lived signed multipart URLs| S3
    Queue --> Worker[Node media-security worker]
    Worker --> S3
    Worker --> Scanner
    Queue --> AI[Python AI execution plane]
    AI --> S3
    AI --> TTS
    AI --> LLM
    AI --> Lip
```

## Deployment boundary

The initial system is a modular monolith with one justified service boundary:

```mermaid
flowchart TB
    subgraph ControlPlane[CPU control plane]
        Web[Next.js on Vercel]
        API[NestJS modular monolith]
        Worker[Node workflow workers]
    end

    subgraph State[Authoritative state and transport]
        Postgres[(Supabase PostgreSQL)]
        Redis[(Redis)]
        Objects[(S3 object storage)]
    end

    Scanner[ClamAV scanner]

    subgraph ComputePlane[Elastic AI compute plane]
        Gateway[FastAPI internal API]
        CPU[CPU media workers]
        GPU[GPU inference workers]
    end

    Web --> API
    API --> Postgres
    API --> Redis
    Worker --> Postgres
    Worker --> Redis
    Worker --> Objects
    Worker --> Scanner
    Redis --> CPU
    Redis --> GPU
    CPU --> Objects
    GPU --> Objects
    Gateway --> CPU
    Gateway --> GPU
```

NestJS owns tenant-aware business state, permissions, workflow policy, billing, audit, and public APIs. Python owns model execution and media/ML runtime concerns. Model providers never write business state directly.

## Secure ingest sequence

```mermaid
sequenceDiagram
    participant Browser
    participant API as NestJS API
    participant DB as PostgreSQL
    participant S3 as Private S3 bucket
    participant Relay as Outbox relay
    participant Queue as BullMQ
    participant Worker as Security worker
    participant Scanner as ClamAV

    Browser->>API: Create tenant-owned project and multipart upload
    API->>DB: Transaction: project, video, upload, audit state
    API->>S3: CreateMultipartUpload using immutable object key
    API-->>Browser: Upload ID, part size, short-lived signing contract
    loop Bounded signing batches
        Browser->>API: Request signed part URLs
        API-->>Browser: Exact part URLs and content lengths
        Browser->>S3: PUT file parts directly
    end
    Browser->>API: Submit ordered ETag and size manifest
    API->>DB: Persist completion intent and immutable manifest
    API->>S3: CompleteMultipartUpload
    opt Provider response is ambiguous
        API->>S3: HEAD immutable object and reconcile size
    end
    API->>DB: Transaction: uploaded state and deduplicated outbox event
    Relay->>Queue: Publish scan command with idempotency key
    Queue->>Worker: At-least-once scan delivery
    Worker->>S3: Stream quarantined object
    Worker->>Scanner: clamd INSTREAM frames
    Scanner-->>Worker: Clean, infected, or stable error verdict
    Worker->>DB: Persist scan attempt and terminal security state
```

Uploaded objects are never eligible for AI processing until the authoritative video
security state is `clean`. Browser checkpoints contain identifiers and completed-part
metadata only; credentials and file bytes are not persisted in web storage.

## Initial bounded contexts

| Context                | Responsibilities                                                 | Initial implementation               |
| ---------------------- | ---------------------------------------------------------------- | ------------------------------------ |
| Identity and access    | Users, organizations, memberships, sessions, API keys            | NestJS module + PostgreSQL           |
| Project catalog        | Projects, source videos, language variants, metadata             | NestJS module + PostgreSQL           |
| Media ingest           | Multipart uploads, validation, quarantine, artifact registration | NestJS module + S3                   |
| Workflow               | Durable job/stage state, retries, cancellation, progress         | NestJS module + PostgreSQL + BullMQ  |
| Character memory       | Identity evidence, profile versions, relationships, assignments  | NestJS module + PostgreSQL           |
| Localization           | Scenes, segments, translation versions, subtitles                | NestJS module with AI provider ports |
| Voice production       | Voice profiles, consent, assignments, synthesis runs             | NestJS module with AI/TTS adapters   |
| Rendering and delivery | Mixes, lip sync, exports, signed delivery                        | NestJS module with worker adapters   |
| Metering and billing   | Usage ledger, entitlements, invoices                             | NestJS module + PostgreSQL           |
| AI execution           | ASR, diarization, emotion, translation, TTS, lip sync            | Python service and CPU/GPU workers   |

## Workflow reliability contract

```mermaid
sequenceDiagram
    participant API as NestJS API
    participant DB as PostgreSQL
    participant Relay as Outbox relay
    participant Q as BullMQ
    participant W as AI worker
    participant S3 as Object storage

    API->>DB: Transaction: create job, stage, and outbox event
    DB-->>API: Commit authoritative state
    Relay->>DB: Lease unpublished outbox events
    Relay->>Q: Publish command with idempotency key
    Q->>W: Deliver stage attempt
    W->>DB: Claim attempt using compare-and-set
    W->>S3: Write immutable result artifact
    W->>DB: Transaction: register artifact, finish attempt, add next event
    W->>Q: Acknowledge only after commit
```

Delivery is at least once. Correctness therefore comes from idempotency keys, database uniqueness constraints, immutable outputs, attempt leases, and transactional state transitions—not from assuming a queue message runs once.

## Data classification baseline

| Class        | Examples                                                    | Baseline controls                                                         |
| ------------ | ----------------------------------------------------------- | ------------------------------------------------------------------------- |
| Restricted   | Source media, cloned voice material, access/refresh tokens  | Encryption, least privilege, short-lived URLs, no application-log content |
| Confidential | Transcripts, translations, character profiles, billing data | Tenant authorization, encryption, audit access, retention policy          |
| Internal     | Job metadata, provider timings, trace data                  | Authenticated access and retention limits                                 |
| Public       | Product documentation and intentionally published exports   | Integrity controls and explicit publication state                         |

Production credentials are supplied through a managed secret store. Kubernetes Secrets alone are not treated as the system of record for secrets.
