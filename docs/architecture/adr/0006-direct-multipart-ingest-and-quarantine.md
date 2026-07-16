# ADR 0006: Direct multipart ingest and quarantine

- Status: Accepted
- Date: 2026-07-16

## Context

Source movies are large restricted assets. Proxying bytes through NestJS doubles
bandwidth, holds request workers open, and prevents independent upload scaling. An S3
upload completing successfully does not prove the object is safe for media workers.

## Decision

The control plane creates an immutable object key and an S3 multipart upload. The web
client requests short-lived signed `UploadPart` URLs in bounded batches and sends bytes
directly to object storage. PostgreSQL records the upload intent, expected size, part
manifest, completion state, and idempotency key.

Completion moves the video to `uploaded` plus `pending` security state in one database
transaction and emits an outbox event. An outbox relay publishes an idempotent BullMQ
command. A separate worker streams the object to a scanner provider and records every
attempt before acknowledging the queue message. Only a `clean` result promotes the
video to pipeline eligibility; infected or scanner-error objects remain quarantined.

ClamAV over `INSTREAM` is the local/default adapter. Its unauthenticated TCP port stays
on the private service network. The scanner port permits a managed object-storage
malware scanner in production without changing ingest or project modules.

## Consequences

- API bandwidth and memory are independent of movie size.
- The browser needs bucket CORS and a public signing endpoint for local S3-compatible
  storage.
- Multipart uploads require expiry cleanup and abort handling.
- Queue delivery is at least once; database uniqueness, attempt state, and idempotent
  handlers provide correctness.
- Large-file scan limits and throughput must be capacity-tested before production.
