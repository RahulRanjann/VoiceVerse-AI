# ADR-0002: PostgreSQL is authoritative for workflow state

- Status: Accepted
- Date: 2026-07-16

## Context

Media jobs can run for hours, cross deployments, retry individual stages, and fan out into many language variants. Redis-backed queues provide efficient delivery but are not sufficient as the only durable business record.

## Decision

Persist jobs, stages, attempts, state transitions, and the transactional outbox in PostgreSQL. BullMQ transports commands and wake-ups. Workers claim attempts using leases and idempotency keys, write immutable artifacts, and commit results before acknowledging queue messages.

Queue adapters are hidden behind application ports so a future workflow engine can be adopted without rewriting domain modules.

## Consequences

- Queue loss or replay cannot silently change the authoritative job state.
- Every handler must be idempotent and transaction-aware.
- Progress queries use normalized operational tables rather than inspecting Redis internals.
- The database receives additional writes; partitioning and archival will be introduced from measured load, not guessed prematurely.
