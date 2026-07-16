# ADR-0004: Character Memory stores versioned evidence and resolved profiles

- Status: Accepted
- Date: 2026-07-16

## Context

Age, gender presentation, accent, emotion, identity, and relationships can be uncertain, context-dependent, or sensitive. A single mutable profile loses provenance and makes corrections impossible to audit.

## Decision

Character Memory will separate:

1. observations from audio, video, scripts, or user input;
2. normalized claims with source, model/provider version, confidence, and time range;
3. versioned resolved profiles used by downstream generation;
4. user overrides, which outrank inferred claims but remain auditable.

Voice assignment is its own versioned entity with licensing and consent references. Relationship edges are normalized records rather than an embedded graph document.

## Consequences

- Downstream stages can explain why a trait was selected.
- Corrections do not destroy previous state.
- Profiles require a resolver policy and confidence calibration.
- The schema is more involved than a JSON profile, but it prevents identity drift and supports enterprise audit requirements.
