---
doc: spec
status: draft
---
# Unfurl Technical Spec

## How This Works, In Plain Language

Unfurl joins an agent conversation to a learning workspace. The agent researches a goal and creates a course artifact with its own metadata and curriculum. The creator can edit that program and approve one saved revision. Durable work then researches the sections, plans lessons, creates reading and activities, and validates the complete course before making a version available for study.

The application supplies a defined activity system. Models produce structured content for registered capabilities; they do not create arbitrary executable interface code. Evaluation can use a deterministic rule, a bounded Python execution, or a rubric with an explicit uncertain result. These methods have different capabilities and failure conditions.

Released content remains stable. Each enrollment has separate attempts, evidence, assistance, progress, and support routes. Closing the browser does not discard accepted server work. Reopening the conversation or learning session restores server-confirmed state.

Product behavior and acceptance criteria are in the [requirements](prd.md). Operational prerequisites are in the [setup guide](../docs/setup.md).

## Implementation Status and Integration Gates

The repository contains the account, storage, research, generation, learning, progression, sharing, and publication integrations described here. Runtime availability depends on configuration, authenticated access, capability evidence, provider availability, and configured service limits. Empty or incompatible configuration produces an explicit unavailable result.

An installed integration, a passing isolated test, a live provider receipt, and a completed course journey establish different facts. The [verification checklist](checklist.md) keeps release acceptance separate from implementation. This specification does not claim that a fresh installation or every live journey has already passed.

## The Core Journey Through the System

1. The landing presents creation, exploration, and the featured course. Try resolves an exact configured public version and continues through the course-start route. Authentication preserves a safe intended destination.
2. The creator writes a goal in chat. The first unsent message remains provisional. Sending creates the conversation and message through the authenticated server boundary; delivery state distinguishes local intent from accepted work.
3. An agent turn researches the goal and can create or edit several course artifacts. Messages, actions, sources, and artifact revisions are saved. The client reads ordered events and can recover from a snapshot.
4. Approval atomically binds the selected course to its current curriculum revision and digest. A stale revision or active authoring operation cannot be approved.
5. A generation run performs research, approved-scope coverage checking, lesson planning, task construction, and validation. Failed work remains inspectable and retryable. Finishing an agent reply is separate from releasing a course version.
6. Only a ready version enters normal study and sharing. Enrollment creates or reuses the learner's record for that version; the player receives public content, the current route, and authoritative progress.
7. The server validates an answer or recorded activity, evaluates it, saves evidence, and applies progression. Hidden answers and evaluator references do not enter public task projections.
8. Library and session reads restore the learner's work. A share recipient receives their own enrollment. Publication checks both version readiness and the creator's progression eligibility.

## Stack

Exact package versions are pinned in [package.json](../package.json) and [package-lock.json](../package-lock.json).

| Layer | Implementation |
| --- | --- |
| Runtime | Node.js 22.x; Next.js 16.4.3 App Router; React 19.3.1 |
| Types and validation | TypeScript 6.0.3, Zod schemas, server validators, typed application ports |
| Interface | Authored CSS and SVG, Manrope Variable, Lucide icons, Radix interaction primitives |
| Identity and storage | Supabase Auth, PostgreSQL through pg, ordered checksummed SQL migrations |
| Durable execution | Vercel Workflow, database leases and step records, recovery dispatch |
| Models and research | OpenRouter adapters, saved operation policies, bounded web search, server source reader |
| Python | Vercel Sandbox with isolated guest execution and explicit capability evidence |
| Checks | Next route type generation, TypeScript, ESLint, Vitest, production build |

## Where It Runs and How Someone Tries It

The public application is [Unfurl](https://unfurl-inky.vercel.app). Local development and production-mode startup use the same repository and Node major:

```sh
npm ci
npm run dev
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000). Environment, migrations, accounting, secrets, and runtime capability requirements are documented in [setup](../docs/setup.md). Dependency installation does not provision those services.

Main routes are `/`, `/explore`, `/library`, `/chat`, `/chat/[id]`, `/courses/[slug]`, `/start/[courseId]`, `/learn/[enrollmentId]`, `/try`, `/login`, and `/signup`. `/create` is a compatibility entry. The interface is English with no locale prefix; course content language is separate.

Try uses a real published course through the common player. If the configured course and version are absent or inaccessible, it shows an unavailable state with working alternatives.

## Look and Feel

The slogan is “Learn what you've always wanted to”. The visual system uses warm paper surfaces, dark ink, vermilion actions, restrained borders, and readable Manrope typography. Main colors in [tokens.css](../src/styles/tokens.css) are canvas `#F5F3ED`, surface `#FFFEFA`, ink `#25272B`, action `#BA432D`, and focus `#2D5B91`.

The landing combines a noninteractive rotating topic with an authored unfolding course illustration. Reduced motion retains understandable static content. Internal screens prioritize the current conversation, selected course program, or learning action. Focus, keyboard behavior, clear pending feedback, and narrow layouts are product requirements; a successful build does not establish visual quality.

## Components

### Domain Schemas and Application Ports

`src/domain/` defines runtime schemas for accounts, conversations, curricula, course versions, learning, activities, progress, and errors. `src/application/` defines ports and authenticated HTTP adapters. `HttpApplication` is the normal application boundary; the local adapter supports isolated development and tests and is not cloud persistence.

Schemas reject malformed input. Domain and server validation additionally check ownership, revision, approved scope, references, graph relationships, registered mechanics, and permitted state transitions. A schema-valid object alone is not enough to release content.

### Shared Interface and Navigation

`src/components/`, `src/styles/`, and `src/content/` provide controls, shell, tokens, and shared copy. `src/lib/routes.ts` is the route vocabulary. Safe authentication return paths preserve an intended course or workspace destination; ordinary direct sign-in returns home.

### Landing and Product Information

The landing explains creation and learning and routes to real product actions. Help and privacy pages describe actual storage and account behavior. Illustrations are authored visual material, not fabricated screenshots or evidence of a finished course.

### Catalog and Library

The catalog projects public ready versions. Course detail resolves access before exposing a version. Library separates created courses from enrolled courses and uses real server records; conversation history remains in the creator. The featured resolver validates both configured IDs and public access.

### Course Creator

The creator coordinates conversation history, composer recovery, agent messages and actions, selected artifacts, curriculum editing, approval, and generation presentation. Server revisions prevent stale saves and approvals. Stop and retry operate on the identified run.

Build progress appears within the conversation as model messages and real actions. Task names, estimated times, ready status, and completion feedback come from accepted data. The client must not invent percentages or imply success from a closed stream.

### Learning Player and Activity Registry

The shared player renders reading and the 29 registered activity families. Family schemas define the learner's action, public input, private evaluation, and supported observations. Foundations, investigation, construction, communication, and Python modules provide distinct behavior.

Interactive investigation and dialogue use saved activity sessions, actions, and receipts. An answer that cites an observation must refer to the learner's actual recorded evidence. Unsupported mechanics fail explicitly.

### Identity, Repositories, and Access

Supabase verifies identity; repositories use PostgreSQL transactions with actor and ownership checks. Private reads are not publicly cached. Account changes clear scoped client state. Idempotency, expected revisions, and transaction-level checks protect mutations from duplicate requests and stale writes.

Current signup creates a confirmed email/password account through a server-only admin credential and signs in normally. The build does not send confirmation or password-recovery email. A signed-in verified session can change its password. Existing email templates do not establish a configured mail service.

### Research, Generation, and Durable Execution

Research combines bounded provider search with direct server reads of supported web text. Search snippets are discovery evidence, not proof that a source was read. Source material is normalized and stored with provenance. Grounded quotes must match the recorded text projection and offsets.

Generation follows the approved curriculum: section knowledge, coverage validation, targeted repair where needed, lesson planning, reading, activity construction, and review. Work is paged into saved steps with continuation; a per-step batch is not a whole-course size limit. Required reading, practice, and independent demonstration cover the approved outcomes. Optional support cannot substitute for required coverage.

Task validation exercises valid, alternative-valid, and meaningfully wrong cases against the actual evaluator. Source grounding and content review inspect substance. A failed or missing check prevents atomic release of the complete course version.

Each external model operation captures its policy and request identity. Admission reserves budget before transport. Saved responses support recovery without silently repeating a paid effect. New policy selection does not reinterpret historical operations or receipts.

### Evaluation, Evidence, and Personal Routing

The evaluation boundary distinguishes correct, partial, incorrect, uncertain, pending, and unavailable outcomes. Deterministic evaluators, rubric grading, and sandbox execution preserve their evidence and limits. Uncertain grading is not treated as learner failure.

Assistance is separate from independent evidence. Hints and worked examples affect XP eligibility. Feedback review, support requests, offers, fresh assessment, and return-to-course actions use server records. Personal support preserves the shared outcomes and a path back to the required program.

## Data Model

### Common Types and Errors

Typed identifiers, timestamps, revisions, digests, and discriminated results connect public contracts to server records. Unavailable, unauthorized, not-found, revision-conflict, invalid-content, cancelled, and failed states are distinct. Public errors do not expose credentials or private evaluation data.

### Course, Curriculum, and Released Version

A course owns title, summary, language, creator, and visibility. Curriculum revisions contain audience, prerequisites, outcomes, modules, and estimates. Approval records the exact revision and digest. A generation run is bound to that approval. A ready course version contains validated immutable learning content; later authoring does not rewrite existing enrollments.

### Conversation, Run, and Typed Events

A conversation owns messages and references to separate course artifacts. Agent-turn and generation runs have distinct purposes and states. Events carry sequence and run identity; durable snapshots allow recovery after interruption. A saved composer is separate from an accepted message.

### Lesson, Task, Attempt, and Evaluation

Lessons contain reading and ordered tasks tied to outcomes. Public task projections contain instructions and controls. Private references, cases, and answer material remain server-side. Attempts record the enrolled version, task, response, and assistance context. Evaluations and activity receipts supply durable evidence for feedback and progression.

### Enrollment, Evidence, Route, and Progress

An enrollment binds one learner to one course version. Its route, activity sessions, attempts, evidence, support, and current location are personal. An eligible independent correct task awards 25 XP; a hinted correct task awards 10 XP; revealed worked answers award none. A task cannot receive repeated awards through retries or later policy changes. Every 250 XP advances a level; public publication requires level 3, or 500 XP, and a ready version.

### Browser Recovery and Persistence Boundaries

PostgreSQL is authoritative for account conversations, saved composer content, artifacts, curricula, generation, learning, and progress. Limited browser recovery protects a provisional first message or unsaved edit until server acknowledgement. Clearing it does not delete already saved account work.

Earlier local-only chats remain in IndexedDB until explicit import. Import preserves the original browser data and does not send messages automatically. Private data must not cross account boundaries. Deleting a chat does not implicitly delete its course artifacts.

### Capability and Budget Records

Capability receipts bind evidence to the runtime world, configuration, model policy, and relevant provider or execution identity. Missing, rejected, stale, or incompatible evidence disables the associated operation. Installing a package or setting a key does not create a successful receipt.

The database records provider requests, reservations, settled costs, and unresolved outcomes against their configured accounting ledger. Retries retain the original operation identity and accounting association. Settlement and recovery preserve unresolved costs until provider evidence supports reconciliation.

### Python Execution Boundary

Supported Python tasks run in temporary Vercel sandboxes. Guest execution has no network access, receives no host secrets, and has explicit CPU, memory, source, output, and wall-time bounds. Authentication and capability checks are separate from a learner's assessment result. Substantial external projects can need the learner's own tools and compute.

## File Structure

| Location | Responsibility |
| --- | --- |
| `src/app/` | Pages, layouts, HTTP handlers, metadata |
| `src/features/creator/` | Chat, course program, approval, build feedback |
| `src/features/learning/` | Common player and activity interfaces |
| `src/features/catalog/`, `src/features/library/` | Discovery, access, stored courses |
| `src/domain/`, `src/application/` | Schemas, contracts, ports, HTTP adapters |
| `src/server/auth/`, `src/server/db/` | Identity, transactions, access context |
| `src/server/agent-turns/`, `src/server/curricula/` | Agent operations and approval |
| `src/server/research/`, `src/server/course-validation/` | Sources, coverage, task and content validation |
| `src/server/runs/`, `src/server/ai/`, `src/server/budget/` | Durable work, provider policy, accounting |
| `src/server/evaluation/`, `src/server/learning/`, `src/server/adaptation/` | Grading, actions, personal support |
| `src/server/execution/python/` | Isolated Python execution |
| `supabase/` | Migrations and explicit configuration operators |
| `tests/`, `scripts/` | Automated checks and operational verification |

## External Services and Dependencies

### HTTP Rules

Authenticated routes derive the actor from the verified session. Mutations validate origin, payload, ownership, revision, and idempotency as appropriate. Internal dispatch requires its own server bearer secret. Private responses use no-store behavior. Public projection is an explicit server operation.

### Endpoint Groups

Routes live under `/api/auth/`, `/api/v1/`, and `/api/internal/dispatch`. Route files and schemas are authoritative for methods and payloads.

| Group | Responsibility |
| --- | --- |
| Auth; me, profile, progress | Session, signup/sign-in, profile, progression |
| Conversations; composer, messages, actions, import | Saved authoring and explicit legacy import |
| Runs and generation runs; events, retry, cancel | Observe and control durable work |
| Curricula and approval | Revision-checked editing and approval |
| Catalog, courses, course by slug, library | Discovery, detail, personal collection |
| Course enrollments, shares, visibility; share token | Start learning, version-bound access, publication |
| Enrollment session, attempts, advance, revisit | Learning state and progression |
| Activity sessions, input, actions | Recorded investigation, dialogue, execution |
| Attempt evaluation, review requests, acknowledgements | Feedback and its review |
| Hints, reveal, support requests/offers, fresh assessment | Assistance and evidence-based support |

### Research and Model Ports

OpenRouter supplies configured inference and search. Implemented policies include Gemini Flash structured authoring and Kimi K2.6 search/rubric routes. Selection requires compatible capability evidence; the adapter preserves the captured model and provider for prior operations. Model metadata, request policy, response, and accounting remain connected.

The source reader accepts supported HTML, plain text, Markdown, and JSON with size and request constraints. It rejects unsupported documents, unsafe destinations, and invalid evidence. PDF extraction is outside the reader. Provider availability and privacy-route compatibility remain runtime conditions.

### Durable Execution and Streaming on Vercel

Vercel Workflow drives resumable work. Database leases, execution records, attempt identities, and saved provider effects protect retries. Accepted work triggers dispatch after the response; the configured daily cron provides another recovery entry. A single HTTP request need not remain open for an entire course.

Local Workflow uses `.cache/workflow-data`. Hosted and local worlds have separate capability requirements. Independent workers must not accidentally process the same active development jobs. Deployment verification must exercise the hosted world.

## Important Failure Modes

| Failure | Required behavior |
| --- | --- |
| Unsaved or rejected send | Preserve writing and distinguish it from accepted work |
| Interrupted event stream | Restore server state without invented completion or duplicate effects |
| Stale edit or approval | Reject the stale revision and retain the current saved program |
| Provider timeout or unknown charge | Preserve identity and unresolved exposure; recover before a new effect |
| Missing source, coverage, or validation | Keep the course unready and identify affected work |
| Unavailable evaluation | Keep the attempt recoverable without XP or an incorrect judgment |
| Invalid or revoked share | Deny new token access; preserve existing legitimate enrollment access |
| Account switch or logout | Clear scoped client state and prevent response leakage |
| Missing featured course | Show a useful unavailable state |

## What Was Simplified and Why

The interface is English; course language is independent. One substantial AI course is the authored demonstration target. It does not need every activity family. Email confirmation/recovery delivery, PDF extraction, a persistent notebook, and large hosted AI-training workloads are outside the current implementation. Automated checks do not establish measured learning gains.

## Verification Approach

Use `npm run check` for route types, TypeScript, ESLint, Vitest, and a production build. Live provider and database operators require explicit opt-in. Relevant tests cover state transitions, access, idempotency, sources, accounting, recovery, mechanics, grading, and progression.

Functional acceptance additionally requires an actual generated course, independent learner records, meaningful attempts and assistance, publication eligibility, the featured route, and fresh setup. Visual review judges pixels at representative states and viewports; observations are recorded separately from API evidence. A screenshot establishes the visible state only. Agent inspection does not establish user approval or measured comprehension.

## Decisions and Open Issues

Supabase Auth/PostgreSQL, Vercel Workflow/Sandbox, OpenRouter, the typed activity registry, and server-side provider accounting are implemented architectural choices. Final live acceptance and reproducible capability setup must be reconciled with the [checklist](checklist.md). The project is released under the MIT License.
