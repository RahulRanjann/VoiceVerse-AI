# ADR-0003: Media artifacts are immutable and lineage-tracked

- Status: Accepted
- Date: 2026-07-16

## Context

Users can rewrite translations, change one character's voice, regenerate a segment, undo edits, and reproduce an export. Overwriting intermediate files makes partial regeneration, audit, rollback, and cache correctness unreliable.

## Decision

Every source or generated media object is an immutable artifact with a stable identifier, content checksum, media metadata, producer version, and lineage edges to its inputs. Logical selections such as the active translation or current export point to an artifact/version; they do not mutate the artifact.

Object keys are server-generated and never derived directly from user filenames. Downloads use short-lived, authorization-checked signed URLs.

## Consequences

- Regeneration and undo/redo become version-pointer changes.
- Stage caching can key off canonical inputs and provider/model configuration.
- Storage use grows, requiring explicit retention, legal hold, and garbage-collection policies.
- An artifact cannot be deleted solely because it is no longer active; reachability and retention must be evaluated first.
