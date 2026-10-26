# Configuration and Deployment

This guide covers the repository's existing setup commands and service requirements. Use Node.js 22.x and npm. Run commands from the repository root.

Account-backed features need Supabase Auth and PostgreSQL. Research, generation, and rubric grading also need OpenRouter, configured provider accounting, and valid capability evidence. Python activities need Vercel Sandbox access. Installing dependencies alone does not enable those services.

## Install and Create Local Configuration

```sh
npm ci
```

Copy [.env.example](../.env.example) to `.env.local` with your editor or shell. For example, in PowerShell:

```powershell
Copy-Item .env.example .env.local
```

Use a separate development Supabase project. Keep real credentials in local or deployment environment configuration, outside committed files. Only variables prefixed `NEXT_PUBLIC_` are intended for browser configuration.

| Variable | Required value and purpose |
| --- | --- |
| `APP_ORIGIN` | Exact origin used by the app, initially `http://127.0.0.1:3000`; redirects and same-origin mutation checks depend on it |
| `NEXT_PUBLIC_SUPABASE_URL` | Selected Supabase project's API URL |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Its browser-safe publishable key |
| `DATABASE_URL` | Server-only Supavisor transaction-pool connection, port 6543 |
| `DATABASE_SSL_CA` | Optional trusted PEM root certificate for the selected database; literal backslash-n sequences are supported |
| `DIRECT_DATABASE_URL` | Local operator/CI session or direct PostgreSQL connection, port 5432; do not use transaction pooling for migrations |
| `SUPABASE_PROJECT_REF` | Explicit project reference matched by migration and provisioning tools |
| `SUPABASE_DB_PASSWORD`, `SUPABASE_ACCESS_TOKEN` | Local Supabase administration/CLI values when that workflow requires them |
| `SUPABASE_SECRET_KEY` | Server-only admin credential used by the current signup route |
| `OPENROUTER_API_KEY` | Server-only model/search provider credential |
| `AI_BUDGET_ID` | Configured ledger identifier used by server-side provider accounting |
| `INTERNAL_DISPATCH_SECRET` | At least 32 random characters for authenticated internal dispatch |
| `CRON_SECRET` | A separate random secret for Vercel's scheduled GET dispatch |
| `SHARE_TOKEN_ACTIVE_KEY_VERSION` | Current version in the share-token key ring |
| `SHARE_TOKEN_KEYS_JSON` | Server-only JSON object mapping versions to base64url-encoded keys of at least 32 bytes |
| `FEATURED_AI_COURSE_ID`, `FEATURED_AI_COURSE_VERSION_ID` | Optional exact public ready course/version used by Try; configure only after publication |
| `WORKFLOW_TARGET_WORLD` | `local` for local development |
| `WORKFLOW_LOCAL_DATA_DIR` | `.cache/workflow-data`, outside the build output |
| `WORKFLOW_LOCAL_BASE_URL` | The actual local origin, initially `http://127.0.0.1:3000` |
| `VERCEL_PROJECT_ID` | Linked Vercel project ID; deployed Functions expose it as a system variable |
| `VERCEL_OIDC_TOKEN` | Local Sandbox authentication when obtained through the linked Vercel environment; deployed Functions use rotating request-context OIDC |

Get database URLs and keys from the selected project's settings. TLS verification remains enabled; use the appropriate trusted certificate when required. Do not disable verification to work around a certificate problem.

## Apply the Database Migrations

Replace `<selected-project-ref>` with the same project reference used in the Supabase URL and configuration. First inspect the target and pending migration list:

```sh
node --env-file=.env.local supabase/apply-migrations.mjs --project-ref <selected-project-ref>
```

Then apply that list:

```sh
node --env-file=.env.local supabase/apply-migrations.mjs --project-ref <selected-project-ref> --apply
```

The runner verifies the project and direct/session connection, records checksummed migration history, and refuses an existing untracked application schema or altered migration history. Apply the complete checked-in sequence. Do not reset a hosted database that contains user work.

## Configure Sharing and Dispatch

For a new local configuration, remove the two unused `SHARE_TOKEN_ACTIVE_KEY_VERSION` and `SHARE_TOKEN_KEYS_JSON` placeholder lines from `.env.local` before initializing them. The initializer expects either no key configuration or a complete valid pair; the template's partial pair is not a usable key ring.

```sh
node supabase/initialize-share-token-keys.mjs
```

It writes the generated pair into `.env.local` without printing key material. Keep one assignment for each variable. If you already have a valid key ring, preserve it. When rotating keys, retain old versions while their grants must remain usable.

Set `INTERNAL_DISPATCH_SECRET` and `CRON_SECRET` to separate cryptographically random values of at least 32 characters. They authorize server operations and must not appear in browser configuration, screenshots, or repository files.

## Configure AI Accounting

After the migrations are applied, initialize the accounting ledger for a new installation:

```sh
node --env-file=.env.local supabase/provision-ai-budget.mjs --project-ref <selected-project-ref>
```

The command writes the created row ID to `.env.local` and makes no model calls. It refuses an existing ledger or an already populated `AI_BUDGET_ID`. For an existing installation, retain its configured ID and accounting history.

External requests retain their settled costs, reservations, and unresolved outcomes across retries. Provider credits, quotas, and actual provider/sandbox charges depend on the deployment's service configuration.

Execution accounting is configured in the database. Apply migration `202610250029_execution_funding.sql` and deploy the compatible runtime **before activation**. Choose one new UUID for the site ledger and identify the existing `auth.users` UUID of the designated service account. Keep these selected IDs for subsequent checks; exact repeated configuration is a no-op, while a conflicting configuration is refused.

Preview the proposed configuration first:

```sh
node --env-file=.env.local supabase/configure-ai-funding.mjs --project-ref <selected-project-ref> --verification-budget-id <existing-ledger-id> --site-budget-id <new-site-ledger-uuid> --verification-actor-id <service-account-user-uuid>
```

This default preview **connects to the selected database** over verified TLS, reads in a read-only transaction, then rolls back. It performs no writes or provider calls. It requires `DIRECT_DATABASE_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_PROJECT_REF`, and `AI_BUDGET_ID`; `DATABASE_SSL_CA` is optional. The direct/session database target and supplied project must match.

After reviewing the preview and confirming that the new runtime is deployed, activate the exact same configuration:

```sh
node --env-file=.env.local supabase/configure-ai-funding.mjs --project-ref <selected-project-ref> --verification-budget-id <existing-ledger-id> --site-budget-id <new-site-ledger-uuid> --verification-actor-id <service-account-user-uuid> --apply
```

Activation atomically creates the site ledger and stores the execution-accounting configuration. New ordinary jobs use that ledger; the designated service account and capability checks use the original configured ledger. Older jobs and retries retain their original accounting association. Historical costs, reservations, and unresolved outcomes are preserved.

## Runtime Capability Evidence

The application requires evidence that its configured model, search, accounting, Workflow, and Python boundaries work in the relevant runtime world. Evidence is bound to configuration and policy; copying arbitrary receipts or setting a key is not a valid initialization method. Local and hosted availability are evaluated separately.

**Fresh-project provider initialization is still incomplete.** The commands below inspect configuration, verify Workflow recovery, inspect Python admission, or revalidate existing provider proofs. They do not create missing model/search/rubric proofs on a new database. Installing the application, schema, keys, and accounting configuration alone does not make live generation and grading available.

### Inspect the Configuration Without Connecting

The public operators default to `--plan`; `--status` also inspects configuration only. Neither mode connects to the database, sends network requests, or establishes live readiness. An env file is optional and must be named explicitly; neither command implicitly reads private `.env` files. Existing process variables take precedence over values in `--env-file`.

```sh
node scripts/runtime-capabilities.mjs --plan
node scripts/provider-proof-portability.mjs --plan
node scripts/runtime-capabilities.mjs --status --env-file .env.local --world local --origin http://127.0.0.1:3000
```

Use `--world vercel` and the exact HTTPS origin for a hosted runtime. Runtime actions require `APP_ORIGIN` and a dispatch secret of at least 32 characters. An explicit `--origin` must match `APP_ORIGIN`; local origins must be loopback addresses. Hosted actions and Python inspection also require the intended `VERCEL_PROJECT_ID`. Do not send a production dispatch secret to an unrelated origin.

Every mode accepts `--report <new-file.json>` for a sanitized result. Reports are created exclusively before an operation: an existing path is refused rather than overwritten. An interrupted report stays `pending`; inspect the saved runtime state before starting another probe. Reports contain no credentials or raw service responses.

### Verify Workflow Recovery and Inspect Python Admission

Start the configured local server first, or target an existing deployment. These explicit actions contact only `/api/internal/dispatch` with its configured authentication secret. They never call the ordinary `dispatch` action or start a provider request.

```sh
node scripts/runtime-capabilities.mjs --recovery-start --env-file .env.local --world local --origin http://127.0.0.1:3000 --report .cache/recovery-start.json
node scripts/runtime-capabilities.mjs --recovery-inspect <returned-workflowRunId> --env-file .env.local --world local --origin http://127.0.0.1:3000 --report .cache/recovery-inspection.json
```

The first action starts one real Workflow proof and saves its marker. The second checks that exact run and appends a capability receipt only after the server verifies committed state across a real retry. A pending/running response is not a successful recovery proof; inspect the same run again with a new report filename. Do not repeat the start action to poll. Recovery evidence belongs to the runtime where the workflow ran.

```sh
node scripts/runtime-capabilities.mjs --python-inspect --env-file .env.local --world vercel --origin https://your-app.example
```

For this hosted example, the supplied configuration must contain that deployment's `APP_ORIGIN`, dispatch secret, and project ID. Python inspection verifies current signed OIDC capability and checks the returned project and validity window. It creates no sandbox and does not prove a Python exercise executed. Actual sandbox execution remains a separate live check; credentials stay on the server.

### Revalidate Existing Provider Proofs for Vercel

This operator delegates to the repository's existing provider-proof verifier. It needs `SUPABASE_PROJECT_REF`, matching `NEXT_PUBLIC_SUPABASE_URL` and `DATABASE_URL`, and an existing `AI_BUDGET_ID`. Verification and application also need the provider credential bound to the original proof. It supports local source proofs targeting `vercel` only; the database and credential must be the intended deployment's configuration. It does not upload environment variables or verify their hosted values. It makes no app-origin request, so the source environment may retain its local `APP_ORIGIN`. An optional explicit `--origin` is validated against that configuration but does not establish deployment readiness.

```sh
node scripts/provider-proof-portability.mjs --list --env-file .env.local --world vercel
node scripts/provider-proof-portability.mjs --verify <source-receipt-uuid> --env-file .env.local --world vercel --report .cache/provider-verification.json
node scripts/provider-proof-portability.mjs --apply-approved <source-receipt-uuid> --env-file .env.local --world vercel --report .cache/provider-application.json
```

`--list` reads existing receipts from the selected database. `--verify` reads the original saved proof and performs allowlisted authenticated provider metadata GETs, without inference. Review that result before `--apply-approved`, which repeats the verifier and appends a derived receipt. The verifier checks settled accounting, exact request/response identity, semantic evidence, credential and endpoint continuity, and newer failures. Missing or incompatible proofs remain unavailable; no placeholder receipt is inserted. Derived provider evidence does not substitute for Workflow recovery in the target runtime.

The existing [budget ledger operator](../scripts/budget-ledger-proof.mjs) has a no-connection inspection mode:

```sh
node scripts/budget-ledger-proof.mjs --dry-run
```

Its live proof and apply modes operate on a configured database and reviewed evidence; this dry run is not a substitute for capability initialization. Use only its supported runtime and policy scope. Ordinary `npm test` does not make live provider calls.

The remaining fresh-provider gap is a reusable initialization procedure that creates current model, search, and rubric evidence from standalone inputs on an empty project, including the selected structured-model policy. Existing saved-decision/coverage recovery probes require prior real job/step records, while diagnostic preparation suites require existing execution records. They are not a fresh-install recipe. A clean end-to-end installation cannot be called verified until that procedure exists and its actual live results pass.

## Start and Check the Application

```sh
npm run dev
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000). Stop with `Ctrl+C`. The development script binds to `127.0.0.1`. Keep `APP_ORIGIN` and the local Workflow base URL consistent with the origin actually used.

For production-mode local startup:

```sh
npm run build
npm run start
```

The start script also binds to `127.0.0.1`. Rebuilding does not erase `.cache/workflow-data`. Preserve that journal when recovering local work. Use separate development storage so local and hosted workers do not accidentally process the same active jobs.

```sh
npm run check
```

The combined check runs Next route type generation, TypeScript, ESLint, Vitest, and a production build. Individual commands are `npm run typecheck`, `npm run lint`, `npm test`, and `npm run build`. Live provider and database operator suites have explicit opt-in gates; passing the default checks does not prove a configured live service or complete course journey.

## Account Behavior

Enable email/password authentication in the selected Supabase project. Set its site and permitted redirect configuration for the actual app origin and the `/auth/callback` route used by the application.

Current signup uses the server-only admin credential to create an email-confirmed account, then signs in with the supplied password. This build does not send a confirmation email and does not provide email password recovery. A verified signed-in session can change its password. The repository's email templates do not enable delivery by themselves.

Authentication preserves a safe internal intended destination. A direct login returns home. An attempted featured-course start returns to that same course and version after login/signup.

## Deploy on Vercel

1. Import the repository as a Next.js project and select Node.js 22.x. The checked-in configuration uses the Frankfurt region and a daily recovery dispatch at `/api/internal/dispatch`.
2. Configure `APP_ORIGIN` for the deployed origin and supply the required public Supabase configuration and server-only runtime secrets. Deployment Functions need the runtime database URL, Supabase admin key, provider key, configured ledger ID, share key ring, and dispatch secrets.
3. Keep local administration values and local Workflow overrides out of the hosted runtime. Use the deployed Workflow world and request-context OIDC. Do not persist a static production `VERCEL_OIDC_TOKEN`.
4. Apply the checked-in migrations to the intended database through the explicit migration command. Preserve the existing accounting records and share keys for an existing installation.
5. Establish valid capability evidence for the hosted configuration. An existing local receipt is not automatically valid for a deployment.
6. Build and deploy, then verify authentication, private access, accepted work, reconnect/recovery, and saved learning against that deployment. Check its actual revision separately from the local or pushed source revision.

The Next configuration already wraps the app with Vercel Workflow. Normal accepted work triggers dispatch after the response; the daily cron provides another recovery entry. Long course construction continues through saved steps instead of one indefinitely open request.

Sandbox authentication, project eligibility, and resource availability are separate runtime prerequisites. The guest has no network access and does not inherit host environment variables.

## Configure the Featured Course

Create the course through ordinary chat, approve its saved program, and let generation reach a valid ready version. Earn publication eligibility through normal learning and publish through the application. Set both featured variables to that exact course and version.

Try checks that the pair still resolves to a public ready course. It then uses the normal authenticated course-start and learning routes. Missing, malformed, private, stale, or unavailable configuration produces an unavailable state.

## Troubleshooting Boundaries

| Symptom | Check |
| --- | --- |
| Account or storage unavailable | Supabase URL/key, admin key, runtime database URL, applied migrations, TLS configuration |
| Mutation rejected for origin | Exact scheme, host, and port in `APP_ORIGIN` |
| Migration target mismatch | Project reference, API hostname, direct/session endpoint and username |
| Share initialization fails | Complete existing pair or removed unused placeholders; no duplicate assignments |
| AI operation unavailable | Provider credential, compatible capability evidence, model/provider route, configured accounting, provider credits and quotas |
| Build paused or failed | Saved run state and failed operation; retry through the application after the cause is resolved |
| Python unavailable | Sandbox/OIDC/project configuration and current execution capability evidence |
| Try unavailable | Exact featured IDs and actual public ready access |

A saved curriculum does not imply a ready course, and a ready course does not establish a completed learner journey. Use the [verification checklist](../devpost/checklist.md) for release acceptance.

