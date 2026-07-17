# Milestone 3: Supabase authentication

Status: **Repository complete; cloud activation pending — July 16, 2026**

## 1. Goal

Replace the custom browser token issuer with Supabase Auth while preserving NestJS as
the only business API, tenant authorization boundary, and audit authority.

## 2. Folder structure

```text
apps/web/src/lib/supabase                 browser/server Supabase clients
apps/web/src/proxy.ts                     bounded session refresh proxy
apps/web/src/app/auth/callback            OAuth code exchange
apps/api/src/modules/identity             verified-token and principal adapters
packages/database/prisma/migrations       Supabase identity-provider expansion
docs/architecture/adr/0008-*              identity ownership and failure modes
```

## 3. Database changes

Add `SUPABASE` as an external identity provider. Retain legacy OAuth and refresh-session
records for a rollback window; no destructive cleanup is part of this milestone.

## 4. APIs

Keep `GET /v1/auth/me` as the canonical internal principal endpoint. Protected APIs
accept only verified Supabase bearer access tokens. Retire custom Google start/callback,
refresh, and logout endpoints.

## 5. Frontend pages

Update the login page to start Supabase Google OAuth, add a server-side callback route,
refresh sessions through the Next.js proxy, and preserve the existing authenticated
dashboard experience.

## 6. Backend implementation

Isolate `@supabase/server` behind an identity verifier, validate issuer/audience and
claims, map the external subject to an internal user, provision a first organization
transactionally, and resolve every requested organization from active memberships.

## 7. AI service

No changes. AI services continue to receive internal job context, never browser identity
tokens.

## 8. Tests

Cover environment validation, valid and malformed JWT outcomes, inactive accounts,
tenant selection, first-login idempotency, callback failures, refresh behavior, logout,
and browser-to-API bearer propagation.

## 9. Docker updates

Pass only the Supabase URL, publishable key where needed, and JWKS URL to API/web
containers. Do not provide a Supabase secret key to normal runtime containers.

## 10. Deployment

Configure Google OAuth and redirect allowlists in Supabase. Deploy API acceptance before
the web cutover, then invalidate legacy sessions. Set environment-specific Supabase
values in the API runtime and Vercel; never commit real credentials.

## 11. Risks

- `@supabase/server` and `@supabase/ssr` are beta dependencies and require pinned versions,
  adapter tests, and upgrade review.
- Incorrect identity linking could cross accounts; only verified Supabase identities may
  be linked and authorization never comes from user-editable metadata.
- Multi-organization selection must fail closed when the requested membership is absent.
- Preview and production callback URLs must be allowlisted separately.

## 12. Improvements

- Add enterprise SSO and SCIM behind the same external-identity mapping.
- Add step-up authentication for voice cloning, billing, API-key creation, and exports.
- Add session-revocation webhooks or online checks for high-risk operations.
- Remove legacy OAuth/session tables after the rollback and retention window.

## Acceptance record

- The API, database, and web lint, type-check, unit-test, and build gates pass.
- Browser acceptance covers authenticated, anonymous, control-plane outage, and
  account-review states without depending on a developer's local Supabase project.
- The migration chain applies successfully to PostgreSQL and the configured Supabase
  project exposes an asymmetric public signing key.
- Cloud activation remains an operator task: enable the Google provider and redirect
  allowlist in Supabase, link the Vercel project, configure environment-scoped public
  values, and run the staging sign-in smoke test.
