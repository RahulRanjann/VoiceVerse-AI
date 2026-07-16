# VoiceVerse AI engineering rules

These rules apply to the entire repository.

## Architecture

- Preserve the control-plane/compute-plane boundary: business workflows belong in NestJS; AI model execution belongs in the Python service.
- PostgreSQL is the source of truth. Redis and BullMQ are delivery mechanisms only.
- New external providers must implement a port in the domain/application layer and an adapter in infrastructure.
- Pipeline handlers must be idempotent and persist attempt state before acknowledging queue work.
- Media artifacts are immutable. Create a new artifact version and lineage edge instead of overwriting an object.
- Multi-tenant records must carry an organization boundary and be authorized at the application layer.

## Quality

- Validate all untrusted input at system boundaries.
- Add structured logs without secrets, access tokens, media URLs, or transcript content.
- Propagate request, trace, job, project, and organization identifiers when available.
- Add tests for success, validation failure, authorization failure, retry behavior, and idempotency as applicable.
- Do not introduce a new infrastructure dependency without an ADR explaining ownership and failure modes.
- Keep generated code out of manual edits. Regenerate it from the authoritative schema.

## Delivery

- Work one milestone or vertical slice at a time.
- Update the applicable milestone document and ADRs when behavior or boundaries change.
- Run formatting, linting, type checks, tests, and builds before handoff.
