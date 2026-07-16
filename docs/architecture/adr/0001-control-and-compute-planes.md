# ADR-0001: Separate the control plane from the AI compute plane

- Status: Accepted
- Date: 2026-07-16

## Context

Business APIs require predictable CPU scaling, low startup latency, strict tenant authorization, and transactional database access. AI workloads require native Python libraries, large model images, GPU scheduling, long execution times, and independent concurrency limits.

## Decision

Implement the business platform as a NestJS modular monolith and deploy the Python AI execution plane separately. Communication is through versioned internal contracts and durable workflow commands. AI workers receive opaque artifact references and scoped execution context; they do not own user, billing, or project state.

## Consequences

- Domain changes remain cheap inside one business deployable.
- GPU capacity can scale independently from API traffic.
- Cross-boundary contracts require compatibility tests and versioning.
- A second runtime increases build and observability work, but that cost is justified by materially different runtime requirements.

## Rejected alternatives

- All Python: rejected because the selected business stack is NestJS and its modular/application ecosystem fits the control plane.
- All Node.js: rejected because the ML ecosystem and GPU toolchain are Python-first.
- One microservice per model: rejected until ownership, scaling data, or isolation requirements justify additional network boundaries.
