# Vercel and Supabase deployment guide

## Approved topology

```mermaid
flowchart LR
    Browser --> Web[Next.js on Vercel]
    Web --> API[NestJS API on container runtime]
    API --> DB[(Supabase PostgreSQL)]
    API --> Redis[(Managed Redis)]
    API --> S3[Private S3]
    Redis --> Worker[Node security and workflow worker]
    Worker --> DB
    Worker --> S3
    Worker --> Scanner[ClamAV or managed scanner]
    Redis --> AI[Python CPU and GPU workers]
```

Vercel hosts only the web tier. Supabase supplies PostgreSQL only. Do not add a Supabase
publishable, secret, or service-role key to the browser project.

## 1. Create the Supabase environments

Create separate Supabase projects for staging and production in a region close to the API
and worker runtime. Record the project reference, region, direct connection, Supavisor
session connection, and database certificate in the secrets manager.

Mandatory project settings:

1. Disable the Data API under **Project Settings → Data API**.
2. Keep automatic table exposure disabled.
3. Enable point-in-time recovery for production and verify restore procedures.
4. Enable network restrictions when the selected plan and API egress design permit it.
5. Configure database alerts for connection saturation, CPU, disk, and replication lag.

VoiceVerse accesses Supabase over PostgreSQL from trusted services. Supabase explicitly
recommends disabling its Data API when an application only uses direct database
connections. See [Securing your API](https://supabase.com/docs/guides/api/securing-your-api).

## 2. Separate migration and runtime identities

Use two generated passwords stored only in the secrets manager:

- `voiceverse_migrator`: schema owner used by protected migration jobs. It may create
  schema objects but is never available to running applications.
- `voiceverse_app`: login role for API and worker traffic. It receives DML and schema
  usage only; it must not receive `CREATEDB`, `CREATEROLE`, `SUPERUSER`, or `BYPASSRLS`.

Create a no-login privilege group after the initial migration, then grant it to the
runtime login. Run the default-privilege statements as the same owner that will execute
future Prisma migrations:

```sql
create role voiceverse_runtime nologin
  nosuperuser nocreatedb nocreaterole noinherit;

grant usage on schema public to voiceverse_runtime;
grant select, insert, update, delete on all tables in schema public to voiceverse_runtime;
grant usage, select, update on all sequences in schema public to voiceverse_runtime;

alter default privileges in schema public
  grant select, insert, update, delete on tables to voiceverse_runtime;
alter default privileges in schema public
  grant usage, select, update on sequences to voiceverse_runtime;

grant voiceverse_runtime to voiceverse_app;
```

Create the login roles and passwords through an audited administrator session. Never put
role passwords in a migration or SQL file. The runtime and migration connection strings
must use TLS with `sslmode=require`.

## 3. Configure connection URLs

Persistent API and worker containers should use a direct endpoint when their network
supports IPv6. Otherwise use Supavisor session mode on port 5432. Do not use transaction
mode for the current Prisma runtime because session behavior is the safer contract for
prepared statements and interactive transactions.

```dotenv
# API and worker only: least-privilege runtime role
DATABASE_URL=postgresql://voiceverse_app.PROJECT_REF:PASSWORD@REGION.pooler.supabase.com:5432/postgres?sslmode=require&application_name=voiceverse-api
DATABASE_POOL_MAX=5
DATABASE_CONNECTION_TIMEOUT_MS=5000
DATABASE_IDLE_TIMEOUT_MS=30000
DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS=30000
DATABASE_STATEMENT_TIMEOUT_MS=30000

# Protected migration job only: migration role
DIRECT_URL=postgresql://voiceverse_migrator.PROJECT_REF:PASSWORD@REGION.pooler.supabase.com:5432/postgres?sslmode=require&application_name=voiceverse-migrate
```

Budget connections across processes:

```text
(API replicas × API pool max) + (worker replicas × worker pool max) + admin reserve
```

Start with five connections per process and adjust only from Supabase connection and query
metrics. Supabase documents direct, session-pooler, and transaction-pooler selection in
[Connect to your database](https://supabase.com/docs/guides/database/connecting-to-postgres).

## 4. Deploy and verify migrations

Create protected GitHub environments named `staging` and `production`. Add the secret
`SUPABASE_MIGRATION_URL` to each environment and require approval for production. Run
the **Deploy database migrations** workflow manually.

After migration, execute:

```bash
psql "$DIRECT_URL" --set ON_ERROR_STOP=1 \
  --file infrastructure/supabase/verify-data-api-isolation.sql
```

The query must return zero rows. Also confirm the Data API remains disabled in the
Supabase dashboard. A SQL grant check cannot verify the dashboard switch.

## 5. Create the Vercel project

Import the repository into Vercel and configure:

- Framework: Next.js
- Root Directory: `apps/web`
- Include source files outside the root directory: enabled
- Install command: automatic pnpm workspace install
- Build command: `pnpm build`
- Production branch: `main`

Vercel's monorepo deployment model expects a project root for each deployed application;
see [Using Monorepos](https://vercel.com/docs/monorepos).

Set this non-secret variable separately for preview and production:

```dotenv
NEXT_PUBLIC_API_BASE_URL=https://api.voiceverse.ai/v1
```

`NEXT_PUBLIC_*` values are embedded at build time. Changing them requires a new Vercel
deployment. Never configure `DATABASE_URL`, `DIRECT_URL`, S3 credentials, JWT private
keys, Google client secrets, or Redis credentials in the web project.

## 6. Domains and authentication

Production should use same-site domains:

```text
app.voiceverse.ai  → Vercel
api.voiceverse.ai  → container-hosted NestJS API
```

Configure the API environment with:

```dotenv
WEB_ORIGIN=https://app.voiceverse.ai
WEB_AUTH_SUCCESS_URL=https://app.voiceverse.ai
GOOGLE_REDIRECT_URI=https://api.voiceverse.ai/v1/auth/google/callback
AUTH_COOKIE_SECURE=true
```

Register the exact callback URI in Google Cloud. Each preview environment needs an exact,
isolated API origin and callback configuration; do not allow wildcard origins on
credentialed cookie endpoints.

## 7. Release and rollback gates

Before production promotion:

1. Run repository verification and Playwright acceptance tests.
2. Deploy backward-compatible database migrations.
3. Deploy API and worker containers; verify readiness and scan-queue health.
4. Promote the tested Vercel deployment.
5. Run sign-in, project creation, direct upload, quarantine, and clean-verdict smoke tests.

Use expand/contract database migrations. A Vercel instant rollback only rolls back the
web artifact; database and API compatibility must span at least one web release in each
direction.
