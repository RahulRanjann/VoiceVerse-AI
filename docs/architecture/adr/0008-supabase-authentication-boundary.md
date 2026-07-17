# ADR 0008: Supabase authentication boundary

- Status: Accepted
- Date: 2026-07-16
- Supersedes: ADR 0005

## Context

VoiceVerse needs Google sign-in, secure browser session renewal, signing-key rotation,
and an identity system that can later support enterprise providers. The existing NestJS
implementation owns OAuth transactions, refresh-token rotation, and access-token
signing. Supabase Auth can own those identity concerns while Supabase PostgreSQL remains
the application system of record.

`@supabase/server` provides JWT verification and a NestJS adapter, but it is a young
public-beta dependency. Supabase-issued subjects also cannot replace VoiceVerse user or
organization identifiers: authorization, tenancy, billing, and audit ownership remain
application concepts.

## Decision

Use Supabase Auth as the sole browser identity and session issuer. The Next.js web app
uses `@supabase/ssr` for cookie-backed sessions and sends the current short-lived access
token to NestJS as a bearer token. Google OAuth is configured in Supabase, not in the
VoiceVerse API.

NestJS verifies Supabase access tokens through an infrastructure adapter isolated behind
the VoiceVerse identity boundary. The adapter uses `@supabase/server` with the project's
HTTPS JWKS endpoint. The package version is pinned and no Supabase types cross into
business modules. If the beta adapter becomes unsuitable, it can be replaced with direct
`jose` verification without changing controllers or domain services.

After cryptographic verification, NestJS maps the Supabase `sub` claim to an
`ExternalIdentity` and then resolves an active VoiceVerse organization membership. A
Supabase subject is never accepted as an internal user, organization, role, or billing
identifier. User metadata may populate display fields but never authorization fields.

The Supabase secret key is not required for JWT verification and is not present in the
web app or normal API request path. It may be introduced later only for a documented
administrative use case with a dedicated key and secrets-manager ownership.

The Supabase Data API remains disabled. Prisma continues to access PostgreSQL through
least-privilege server credentials, so all business writes, tenant checks, audit logs,
and workflow transitions remain inside NestJS.

## Consequences

- Supabase owns OAuth hardening, session renewal, passwordless/enterprise expansion, and
  signing-key rotation; VoiceVerse owns tenant authorization and account lifecycle.
- The custom OAuth callback, signing key, and refresh-session endpoints are retired as a
  coordinated web/API change. Existing session tables are retained for a rollback window
  and removed only in a later destructive migration.
- A Supabase Auth outage prevents new login and refresh operations. Already-issued JWTs
  remain locally verifiable until expiry when the JWKS is cached.
- Access-token revocation is bounded by the configured short token lifetime. Sensitive
  future operations may require an online session check in addition to signature
  verification.
- JWKS rotation requires cache-aware rollout and monitoring. The API fails closed when
  claims, issuer, audience, session identifier, user email, or tenant membership are
  invalid.
- No browser receives database, migration, secret, service-role, S3, Redis, or model
  provider credentials.
