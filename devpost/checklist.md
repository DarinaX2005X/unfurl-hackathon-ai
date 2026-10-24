---
doc: checklist
status: draft
---
# Unfurl Build Checklist

Build mode: fast for the authorized foundation and UI work, with mechanical verification and meaningful hands-on review. The complete remaining build order is a draft for the product package. No checked box below represents planned work as completed.

## Authorization and Completion Boundary

Foundation and design work may proceed now. This includes a runnable English interface, connected pages, local conversation history and unfinished writing, and the isolated numerical activity. The product owner has not been recorded as approving an unseen complete technical plan, paid services, or production publication. Model access, provider choices, durable storage, identity, and execution remain explicit integration gates.

The complete product remains the target in `scope.md > The POC Boundary`. Local behavior and fixtures do not count as real research, generated deep courses, cloud accounts, or hosted recovery. Later integration is not silently removed from scope because the foundation can run without it.

The slices below are acceptance outcomes. Related implementation packages can run in parallel after their shared contracts exist. The coverage mapping preserves the delivery structure while respecting the dependency between activity families and complete course generation:

| Slice | Delivery packages covered |
| --- | --- |
| 1 | 01.1.1, 01.1.2, 01.2.1, 01.2.2, 01.2.3, 01.2.4 |
| 2 | 02.1.1, 02.1.2, 02.2.1, 02.2.2 |
| 3 | 03.1.1, 03.1.2, 03.2.2 |
| 4 | 04.1.1, 04.1.2, 04.1.3, 04.1.4, 03.2.1, 04.2.1 |
| 5 | 05.1.1, 05.2.1, 05.2.2 |
| 6 | 06.1.1, 06.2.1 |
| 7 | 07.1.1, 07.1.2, 07.2.1 |

## Slices

- [ ] **1. A visitor can discuss a learning goal and complete a guided activity**
  Becomes usable: A coherent Unfurl landing, catalog, library, chat, and isolated trial. A visitor can develop a goal in a standalone conversation, reopen it from chat history, and perform a numerical activity whose answer and feedback change with their actions. Several actual course artifacts can belong to one conversation; the library contains only real courses and enrollments.
  Why now: It establishes the actual product experience and shared contracts while model access is pending. The numerical trial demonstrates meaningful practice early; it does not stand in for the full course engine.
  PRD ref: `prd.md > Planning Status and Authorized Foundation`, `prd.md > Understand the Product and Try a Real Activity`, `prd.md > Develop a Course Request in Chat`, `prd.md > Look and Feel`, `prd.md > Provide an Accessible English Interface`.
  Spec ref: `spec.md > Stack`, `spec.md > Shared Interface and Navigation`, `spec.md > Foundation Application Boundary`, `spec.md > Local Conversations and Persistence Boundaries`, `spec.md > Real Numerical Trial`, `spec.md > File Structure`.
  Build: Include the Next.js/React/Node foundation, manifest and lockfile, canonical domain schemas, Zod validation, local ChatStore, honest application adapter, English common copy, shared controls, and original brand assets. Connect `/`, `/explore`, `/library`, `/chat`, `/try`, the `/create` compatibility entry, and useful about/help/privacy pages. The hero keeps the brand slogan and uses fixed Learn with automatic noninteractive rotating topics above the unfolding book. Implement chat history, new/rename/delete, ordered automatic persistence, failed-message retry, safe scenario insertion, and idempotent legacy import. Keep course metadata and curriculum actions bound to real selected artifacts. Implement the typed player and `model-capacity-v1` trial with visual guidance, actual fitting, plotting, error calculation, explanation, persistence, and reset. Principal files are `src/domain/`, `src/application/ports.ts`, `src/application/local-adapter.ts`, `src/lib/chats.ts`, legacy import sources, `src/lib/routes.ts`, `src/components/`, `src/styles/`, `src/content/`, and `src/features/`.
  Verify (mechanical): Run the implemented type/lint/domain checks and production build. Exercise ordered writes, rapid chat switching, reload, rename/delete, neighboring-record safety, storage failures, empty-view behavior, repeat migration, metadata preservation, and prevention of deleted-chat resurrection. Verify unavailable sends preserve an actual local user message while creating no assistant, run, or artifact; retry keeps its identity and editing starts a new identity. Use fixtures to check multiple course artifacts, independent curriculum approvals, and real metadata callbacks without claiming live creation. Validate graph invariants and public-task projection. Check numerical reference values, accepted alternatives, repeated submission, assistance tracking, unknown mechanics, and sample-only reset. Check actual routes and links. Review representative composed landing, chat, collection, and player pixels and motion at useful desktop/narrow widths, including keyboard, text enlargement, and reduced motion; record visual evidence separately.
  Learner check: Open the landing, write a meaningful learning goal, leave and return through chat history, then use the guided model-capacity activity. Observe the topic pill, unfolding scene, readability, feedback, and whether the activity's goal, controls, and result are understandable. This is the early foundation review; do not describe agent inspection as user approval.
  Commit: `Add connected course-creation foundation and interactive learning trial`, split into verified coherent packages when necessary rather than waiting for the entire slice.

- [ ] **2. A learner can use a real account and return to their own stored work**
  Becomes usable: Actual identity and a durable personal space with authorized library records, version-scoped enrollment and share operations, and one authoritative progression/publication policy. Device-local conversations remain visibly separate and can be transferred deliberately without duplicates.
  Why now: Real course creation and learning require persistence and access boundaries before live generation can safely produce shared records. This slice depends on selected and configured services, not an in-memory substitute.
  PRD ref: `prd.md > Save Progress and Earn XP`, `prd.md > Browse, Share, and Publish`, `prd.md > States and Boundaries`.
  Spec ref: `spec.md > Identity, Repositories, and Access`, `spec.md > Enrollment, Evidence, Route, and Progress`, `spec.md > Local Conversations and Persistence Boundaries`, `spec.md > HTTP Rules`, `spec.md > Planned Endpoints`.
  Build: Select the actual database and identity integrations, document their operational constraints, implement migrations and transactional idempotency, and connect the real account lifecycle. Implement authorized catalog/library, enrollment, share grants/revocation, progress, and publication eligibility without bypassing the policy for authored courses. Principal files are `src/server/db/`, `src/server/auth/`, `src/server/idempotency/`, `src/server/storage/`, `src/server/catalog/`, `src/server/enrollments/`, `src/server/sharing/`, `src/server/progression/`, `src/server/publication/`, the corresponding `src/app/api/` routes, and `src/features/account/`.
  Verify (mechanical): Use a safe integration dataset and two real actors to check private read/write denial, session expiration/sign-out, account switching, restart persistence, idempotency conflicts, share-version scope and revocation, and duplicate-award prevention. Confirm failed persistence never produces saved status. Confirm the public catalog excludes private or unready versions. Integration test records are not advertised as authored deep courses. Check account routing and focus recovery separately from API authorization.
  Learner check: Sign in, deliberately move a chosen local conversation into the account, leave, and return to the same stored work. Inspect which records are on the device and which belong to the account. Actual course-sharing review follows once a real generated course exists.
  Commit: `Connect durable accounts and versioned course access`, with separate verified account and access/progression packages as needed.

- [ ] **3. A creator can research a goal and approve the exact curriculum they reviewed**
  Becomes usable: A real conversation performs source research, streams truthful work events, creates course artifacts with editable metadata and curricula, and requires explicit approval of each selected curriculum revision. The creator can work on several courses in one chat, stop, retry, reconnect, or continue a different branch without losing or mixing accepted work.
  Why now: The curriculum and approval boundary are useful before the entire course is generated and expose the core provider, provenance, streaming, and durable-execution risks early. Activity-family implementation can proceed in parallel after the player and schemas are stable.
  PRD ref: `prd.md > Develop a Course Request in Chat`, `prd.md > Research and Approve the Curriculum`.
  Spec ref: `spec.md > Research, Generation, and Durable Execution`, `spec.md > Conversation, Run, and Typed Events`, `spec.md > Research and Model Ports`, `spec.md > Durable Execution and Streaming on Vercel`, `spec.md > Course, Curriculum, and Released Version`.
  Build: Connect the chosen model and research adapters, persisted run steps/events, cancellation and recovery. Implement real course-artifact creation with automatic metadata, actual metadata editing, source-grounded curriculum construction and typed edits, artifact-specific digest-bound approval including curriculum title and content language, conversation storage, and the live creator transport. Separate ordinary agent turns, which may finish with zero, one, or several artifacts, from course-building jobs that require an actual course ID and saved version for success. Restore action state and all relevant artifacts from the snapshot and release pending state when approval is required; read course readiness from authoritative artifact state, never reply completion. Principal files are `src/server/ai/`, `src/server/research/`, `src/server/runs/`, `src/server/conversations/`, `src/server/curricula/`, `src/server/curriculum-research/`, the course/run/conversation/curriculum API routes, and `src/features/creator/`.
  Verify (mechanical): Make real search/read/model calls and inspect useful source support and returned structure. Check stale-revision approval returns conflict without starting work; changed-body reuse of an idempotency key conflicts. Exercise delayed first output, duplicates, sequence gaps/replay, failure after partial output, cancellation, reconnect, worker ownership loss, and late old-branch results. Confirm emitted actions correspond to real operations and hidden task/evaluation content is absent. Check actual hosted streaming when the hosting test environment is authorized; local transport evidence alone is insufficient.
  Learner check: Request a deep AI course starting with fundamentals and continuing into both model creation and AI systems. Inspect the research and curriculum, change a meaningful requirement, and approve the exact revised program. Close and return to the conversation and assess whether its state and next action remain clear.
  Commit: `Connect researched curricula and revision-bound approval`, preserving separate verified provider/run and creator-flow packages.

- [ ] **4. A generated course offers varied evaluated practice and separate learner routes**
  Becomes usable: An approved curriculum becomes a validated ready course with substantive lessons and many supported learning actions. Learners receive useful evaluation, saved progress, and evidence-based support while retaining the common course's required outcomes.
  Why now: This integrates the actual distinguishing capability. Course construction depends on a real registry and evaluation boundaries, so the activity families and generation work meet here before a complete course is claimed.
  PRD ref: `prd.md > Generate a Substantial Course`, `prd.md > Learn Through Varied Practice`, `prd.md > Adapt Support Within a Shared Course`, `prd.md > Save Progress and Earn XP`.
  Spec ref: `spec.md > Learning Player and Activity Registry`, `spec.md > Lesson, Task, Attempt, and Evaluation`, `spec.md > Evaluation, Evidence, and Personal Routing`, `spec.md > Enrollment, Evidence, Route, and Progress`, `spec.md > Verification Approach`.
  Build: Develop foundation, investigation, construction, and communication activity packages with concrete schemas, accessible renderers, and appropriate evaluators. Integrate them through the single activity registry. Implement module research, task construction/validation, immutable version materialization, attempts/hints, evidence, personal routes, and authoritative awards. Principal files are `src/features/learning/mechanics/`, `src/features/learning/registry.ts`, `src/features/learning/player/`, `src/features/learning/session/`, `src/server/evaluation/`, `src/server/execution/`, `src/server/course-generation/`, `src/server/course-validation/`, `src/server/course-materialization/`, `src/server/learning/`, and `src/server/adaptation/`.
  Verify (mechanical): For activated families, test valid alternatives, plausible incorrect answers, uncertainty, unsupported input, accessibility equivalents, and appropriate feedback. Confirm generated tasks pass content and evaluation validation before release. Execute two enrollments in one immutable version and show separate evidence and routes without loss of required outcomes. A local mistake must not force unrelated remediation; a disputed correct answer must not silently diagnose a learner deficit. Verify pending evaluation, hint-assisted work, repeat attempts, one-time XP, and return after restart. Use the configured execution/model services for their applicable checks rather than local fixtures as a substitute.
  Learner check: Study several different activity families, inspect feedback and sources, leave and return, and compare two learners' next steps in the same course. Check that the route responds usefully without making simple mistakes unnecessarily complicated or cutting the intended depth.
  Commit: `Generate validated courses with varied practice and personal routes`, in coherent tested activity and integration packages.

- [ ] **5. Authored courses and shared journeys work through the same product**
  Becomes usable: Several substantial authored courses exist as real engine-produced records. A creator, learner, and link recipient can use the same service from entry through study, return, sharing, and eligible publication.
  Why now: This verifies depth and generality through actual course creation rather than seeding a polished catalog before the engine exists. It also tests whether the public promise matches the complete experience.
  PRD ref: `prd.md > The Core Journey`, `prd.md > Browse, Share, and Publish`, `prd.md > Understand the Product and Try a Real Activity`, `prd.md > What We're Building`.
  Spec ref: `spec.md > The Core Journey Through the System`, `spec.md > Catalog and Library`, `spec.md > Planned Endpoints`, `spec.md > Look and Feel`, `spec.md > Verification Approach`.
  Build: Create and validate the deep AI course through normal product operations, retaining fundamentals and both continuation branches. Select additional subjects that exercise materially different content and activities, then generate them through the same research/approval/validation path. Connect detail, continue, share, revoke, publish, account return, and first-session flows using actual records. Principal code areas are `src/features/course-detail/`, `src/features/sharing/`, `src/features/catalog/`, `src/features/library/`, `src/features/account/`, `src/features/creator/`, `src/features/learning/session/`, `src/features/onboarding/`, and their existing routes. Course authoring itself is a product data operation, not a fabricated source-code fixture.
  Verify (mechanical): Retain real course/version/source IDs and reproduce representative introductory, intermediate, and transfer tasks. Different goals must materially affect curriculum and practice. Check the full two-actor private/share/revoke/enroll/continue/publication path, cursor and back-navigation context, clipboard success/failure, and duplicate handling. Inspect the integrated first session, actual motion, keyboard/touch operation, and representative desktop/narrow pixels. Record timings only as observed execution, not measured human comprehension or learning gains.
  Learner check: Open the public entry without a guided click sequence, try a useful activity or start a personal course, and continue into a real authored course. Open a shared version as another learner and verify that progress is separate and the next action remains clear.
  Commit: `Connect authored course journeys and sharing`, only for actual code changes; real authoring operations use their durable course/version records.

- [ ] **6. Independent review findings are resolved on a stable product**
  Becomes usable: The complete implementation has been assessed against its intended behavior, and confirmed defects have reproduction and closure evidence. Known missing integrations cannot be marked passed because a build succeeded.
  Why now: Independent inspection can find gaps hidden by knowledge of the implementation before the product is documented as complete and handed over.
  PRD ref: `prd.md > What We're Building`, `prd.md > States and Boundaries`, `prd.md > Non-Goals`.
  Spec ref: `spec.md > Important Failure Modes`, `spec.md > Verification Approach`, `spec.md > Decisions and Open Issues`.
  Build: Review a stable revision through a neutral entry, then inspect the relevant contracts, code, HTTP behavior, and persistence. Assign confirmed repairs to the affected existing source owners. Preserve the expected behavior rather than weakening a criterion to make a failure disappear. Avoid unrelated rewrites and redundant reviews of unchanged evidence.
  Verify (mechanical): Record the smallest reproduction, expected/observed result, affected requirement, and evidence for each confirmed finding. Separate functional, visual, and journey observations. Repair the cause, rerun the failed case and relevant boundary checks, and recheck changed visual behavior from pixels. Preserve unverified dimensions explicitly and reconcile user findings separately from agent observations. A review with no necessary repairs is valid and does not require invented edits.
  Learner check: Revisit affected behavior after repairs when user feedback or a previously reported issue requires confirmation. Review the finished core journey and unresolved limitations without treating an agent verdict as the learner's own approval.
  Commit: No commit for read-only review. Use a specific corrective commit for each coherent verified repair when a source change is needed.

- [ ] **7. The public project installs independently and is ready for the agreed handoff**
  Becomes usable: The repository has an accurate English README, coherent planning documents, real desktop screenshots, a source-grounded app map, reproducible setup, and verified delivery. An authorized deployment, if included, is checked separately from local build and source publication.
  Why now: Documentation must describe the final verified behavior, and a clean setup establishes that the product does not depend on hidden preparation. Presentation and video work can then use a real reproducible product.
  PRD ref: `prd.md > What We're Building`, `prd.md > Deferred From the POC`, `prd.md > Open Questions`.
  Spec ref: `spec.md > Where It Runs and How Someone Tries It`, `spec.md > File Structure`, `spec.md > External Services and Dependencies`, `spec.md > Verification Approach`.
  Build: Complete README branding, product purpose, working examples, real links, desktop screenshots, architecture/data flow, exact environment names, installation, migrations, launch/check commands, and material limitations. Reconcile scope/PRD/spec with the delivered product and produce the app map from actual source. Verify an isolated clean checkout. Complete the authorized source delivery and, only within the agreed hosting scope, the Vercel release. Prepare factual handoff details including revision, startup, genuine capabilities, assets, and remaining limitations. Principal files are `README.md`, `devpost/`, and `docs/assets/`; no font binaries are committed.
  Verify (mechanical): Use only public repository files and explicitly documented prerequisites in a clean isolated installation. Run the documented install, migrations, checks, and production start without altering the user's data. Perform a real useful action and verify return after restart. Check public links/assets and absence of secrets. Confirm local, remote, and deployed revisions separately. If deployment is authorized, verify the public entry, auth callback, durable execution, stream reconnect, access rules, and persistence on that environment. Report an unavailable external requirement honestly rather than a successful live release.
  Learner check: Follow the README from the public project, locate the real course-creation and learning path, and review the remaining limitations and handoff. The subsequent presentation and video assignment is not executed by this build checklist.
  Commit: `Document and deliver the verified Unfurl product`, with a confirmed push for completed source/documentation packages and separate deployment evidence where authorized.

## Hands-on Checkpoints

- [ ] Early usable foundation explored after slice 1, including standalone chat history, truthful unavailable delivery, visual identity, and guided numerical activity; feedback recorded and addressed
- [ ] Connected creation and learning explored after the live curriculum and course slices, including meaningful curriculum revision and independent learner state
- [ ] Final core journey explored after integrated authored courses and required repairs, with actual learner feedback distinguished from agent observations

These are meaningful review boundaries. They do not require repeated screenshot tours or a new approval ritual after each small code change. Reuse applicable evidence while its revision, state, and viewport remain valid.

## Final Review

- [ ] Full intended behavior checked with real integrations and documented limits
- [ ] Confirmed functional, access, persistence, learning, launch, and visual defects resolved with appropriate evidence
- [ ] Relevant user findings preserved and rechecked after repairs
- [ ] Final review complete, feedback resolved, and learner readiness recorded without inventing approval

No completed final review or readiness confirmation is recorded by this draft. Add concrete revision tasks here when findings exist, then close them only after verification of the affected behavior.

## Code Tour and App Map

- [ ] A brief useful activity connects a real project decision or action to its evidence and a practice that can be reused
- [ ] Optional edit and transfer reflection addressed as offered, declined, already covered, or not applicable
- [ ] `devpost/app-map.html` generated from finished code, checked against actual paths and symbols, and shown

Activity and evidence: Not performed. Use an actual requirement, implementation, test, or observed result after the finished code is available.

Route and stops: No completed route. Select two or three meaningful source locations for one real user action; label a route as reference-only if it was not toured interactively.

Edit outcome: No optional edit has been performed as part of this record.

Reflection: Not yet offered in this record. A personal response does not belong in the public map or checklist.

Activity mode: To be recorded from what actually occurs, such as a live app/editor walkthrough, an explicit static fallback, a focused investigation, prior practice, or a brief recap. No mastery or observed execution is inferred from an explanation alone.

The map must be a compact standalone offline document with the app's main pieces, one real action and its source route, practical change pointers, a project-grounded reusable practice, run instructions, and the source revision when available. It must remain useful with scripts disabled and contain no secrets or private sample data.

## Revisions
