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

    Creator --> Web[Next.js web application]
    Partner --> API[NestJS control plane]
    Web --> API
    Web --> IdP
    API --> DB[(PostgreSQL)]
    API --> Queue[(Redis and BullMQ)]
    API --> S3
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
        Web[Next.js]
        API[NestJS modular monolith]
        Worker[Node workflow workers]
    end

    subgraph State[Authoritative state and transport]
        Postgres[(PostgreSQL)]
        Redis[(Redis)]
        Objects[(S3 object storage)]
    end

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
    Redis --> CPU
    Redis --> GPU
    CPU --> Objects
    GPU --> Objects
    Gateway --> CPU
    Gateway --> GPU
```

NestJS owns tenant-aware business state, permissions, workflow policy, billing, audit, and public APIs. Python owns model execution and media/ML runtime concerns. Model providers never write business state directly.

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
