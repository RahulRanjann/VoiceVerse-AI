# ADR 0005: Browser authentication and session rotation

- Status: Superseded by ADR 0008
- Date: 2026-07-16

## Context

VoiceVerse needs Google sign-in, tenant-aware API authorization, rapid revocation, and
safe browser behavior. Long-lived JWTs stored in browser storage make revocation and
token theft response weak. A fully stateful session on every API request would make
horizontal API scaling less efficient.

## Decision

Use Google OpenID Connect authorization code flow with PKCE, nonce, and single-use
server-side authorization transactions. The identity provider is behind an application
port so another enterprise IdP can be added without changing domain services.

Issue a short-lived EdDSA access JWT containing the user, active organization, role,
and session identifiers. Keep the token in application memory. Issue a high-entropy,
opaque refresh credential in an HttpOnly, SameSite cookie. Store only its SHA-256 hash.
Every successful refresh rotates the session record; reuse of a rotated credential
revokes the whole session family.

Organization context is selected by the server from an active membership and signed
into the access token. Controllers never trust organization identifiers supplied only
by the client.

## Consequences

- API reads remain locally verifiable and horizontally scalable.
- Session revocation and refresh-token reuse detection require PostgreSQL.
- An access token can remain valid until its short expiry after revocation.
- Production must supply Ed25519 keys and OAuth transaction-encryption material through
  a secrets manager. Development may use ephemeral signing keys only.
