---
doc: prd
status: draft
---
# Unfurl Product Requirements

Unfurl helps a self-directed learner create a substantial course with an agent, then study through varied practice shaped around their knowledge and progress.

Source: `scope.md > The Unique Kernel`, `scope.md > Who It's For`, and `scope.md > The Core Loop`.

## Planning Status and Authorized Foundation

This is a draft of the complete product. The product owner has authorized starting the application foundation and interface design while model access is pending. That authorization covers connected navigation, the visual system, local request drafts, an isolated working learning activity, and interfaces prepared for the contracts in `spec.md`.

It does not record approval of an unseen complete plan, selection of paid services, or authorization to publish a production deployment. Live research, generation, shared accounts, durable storage, and production execution require the integration decisions listed under **Open Questions**. A working interface alone does not satisfy the complete product requirements.

The requested scope is a complete service. The sections retaining the term POC describe delivery boundaries without reducing the requested depth to a short quiz or a single generated lesson.

## The Core Journey

1. A visitor understands that Unfurl turns a learning goal into a substantial course and offers varied practice. They can create a course, explore available courses, or try an explicitly isolated learning activity.
2. The creator opens a familiar English-language chat interface and describes the subject, desired outcome, and relevant background. They can save the request on their current device before sending it. The requested course language is independent of the interface language.
3. With live services configured, the agent clarifies consequential gaps and researches the subject. The conversation streams real replies and understandable records of actual search, reading, and comparison actions.
4. The creator receives a curriculum with learning outcomes, prerequisites, ordered modules, and an estimated study commitment. They can revise it and explicitly approve its current version. Detailed exercises and their answers are not exposed during this review.
5. The agent researches the approved modules, selects appropriate activity families, constructs lessons and tasks, and checks the resulting course. The creator can leave and return without losing accepted work. Failure or cancellation preserves the work that actually completed.
6. A validated course appears in the creator's library. Its detail page explains the intended audience, prerequisites, outcomes, modules, and estimated commitment before study begins.
7. A learner studies an explanation or example, performs a meaningful task, receives feedback about their answer, and takes the next appropriate action. The system distinguishes independent work, help used, uncertainty, and a confirmed result.
8. Subsequent support and practice can differ between learners of the same course. A local mistake may need only a short explanation. Additional practice or prerequisite work needs relevant evidence and a clear connection back to the shared curriculum.
9. The learner leaves and returns to their own saved place. Progress, evidence, and route belong to that learner and the chosen course version.
10. A creator can share a version by link. A recipient starts their own learning record. A creator who meets the publication requirement can explicitly publish a validated course in the public catalog.

Source: `scope.md > The Core Loop`, `scope.md > What "Working" Looks Like`, and `scope.md > The POC Boundary`.

## Screens and Layout

| Surface | Main job | Essential content and next action |
| --- | --- | --- |
| Landing | Explain the experience and offer an immediate entry | A clear headline, short description, expressive course illustration, create-course action, catalog link, and separate playable trial |
| Explore | Find genuinely available public courses | Search, relevant filters, course covers, titles, outcomes or summaries, language and depth, and honest empty or no-match states |
| Course detail | Decide whether to begin a course | Audience, prerequisites, outcomes, module outline, estimated commitment, available version, access terms, and begin or continue action |
| Library | Resume study or creation | Real enrollments and owned courses, with device-only request drafts in a separately labelled group |
| Creator | Develop and approve a course request | Conversation history, central chat, composer, real work events, and a curriculum panel only when a curriculum exists |
| Learning player | Concentrate on a learning activity | Goal and material, a dominant activity surface, nearby answer controls and feedback, contextual help, sources, and unobtrusive progress |
| Trial | Try a genuine bounded activity before creating a course | The same activity renderer and interaction principles as the player, clearly isolated from accounts, catalog, and account XP |
| Shared course | Open a specific accessible course version | Course information and a route into the recipient's own enrollment; no creator or other learner progress |
| Account | Manage the actual signed-in identity | A real identity lifecycle and access information after authentication is connected |
| About, help, and privacy information | Answer practical questions | Factual product explanations, storage and access boundaries, and working navigation |

Desktop work surfaces use one compact navigation area and a generous central workspace. The creator can show conversation history on the left and the curriculum on the right when relevant. On narrow screens, conversation and curriculum use accessible views that preserve the current draft and selection. The player opens the course contents on demand rather than permanently sacrificing the task's working area.

## Look and Feel

Unfurl uses warm paper surfaces, dark readable text, and a restrained vermilion action color. An unfolding study volume is the central visual object: its cover and pages become different activities while retaining a common physical base. This expresses a coherent course with varied practice. It is an explanatory illustration, not a prerecorded generation result.

The landing separates the headline and primary action from a substantial lower illustration. At a laptop size, navigation, readable copy, the main action, and the complete base of the scene fit together. On mobile, one meaningful activity fragment replaces a miniature collage. Subsequent sections vary their composition according to the idea they explain.

The application continues the same material language in course covers and task surfaces, with calmer reading areas. Essential actions and course information remain visible without hover. The proposed type family is Manrope with a system sans-serif fallback. Course content needs appropriate glyph coverage for its own language. Functional text stays comfortably readable, including secondary labels and long task instructions.

Motion follows an action or material change. A cover opens before its page unfolds; a task object retains its identity as it changes state; feedback appears near the relevant result. Hover, pressed, focus, selected, pending, and disabled states are distinct. Reduced motion preserves all actions and clear final states. There is no perpetual decorative movement competing with reading.

The brand slogan is "Learn what you've always wanted to". The hero pairs "Learn" with an automatically cycling, noninteractive topic pill; "everything" is one entry among many diverse subjects. It is not a button or a selectable control. Reduced motion shows the static phrase "Learn everything". The animation never shifts the primary action, restarts the book scene, or repeatedly announces changing words to screen readers. Interface copy describes the learner's action and result without invented statistics, testimonials, exaggerated claims, or development commentary. The interface is English only. The visual system still requires review of the actual rendered result.

Source: `scope.md > Inspiration & Identity`.

## Features and Behavior

### Understand the Product and Try a Real Activity

The first screen should make the product's purpose and next action apparent. The trial provides a genuine activity with input, evaluation, and explanation. It does not automatically create a course, enroll the visitor, or award account XP.

The first trial explores model capacity using explicitly synthetic data. The learner predicts an effect, adjusts polynomial degree and regularization, compares actual training and validation errors, and explains why a perfect training fit does not guarantee reliable results elsewhere. It accepts multiple configurations that meet the stated criterion. A validation set used to choose a configuration is not presented as independent proof of future performance.

Acceptance criteria:

- The create-course action opens the creator, and the trial action opens a usable activity.
- Every displayed navigation or footer link reaches meaningful content.
- A changed trial answer changes the evaluated result; a valid alternative is accepted when the task allows one.
- The trial's purpose and isolation are visible. It never appears as a generated deep course or as another learner's work.
- Keyboard and touch users can complete the activity and reach its feedback.
- A reset clears only the trial's own state, and repeating submission does not duplicate an award or outcome.

Source: `scope.md > Inspiration & Identity` and `scope.md > Explicitly Cut`.

### Develop a Course Request in Chat

The composer supports ordinary writing, multiline input, clear submission feedback, and recovery of unsent work. Enter sends and Shift+Enter inserts a line break when an input method composition is not active. The course request can describe a general subject or a concrete ability; the service is not restricted to AI courses.

Local drafts can be created, reopened, renamed, and deleted. Their device-only scope is explicit. A local save is acknowledged only after it succeeds. When live generation is unavailable, the request remains editable and recoverable, and the interface explains that the request could not be started. It does not play a recorded assistant response.

Quick actions for starting knowledge, desired outcome, and time commitment append editable text while preserving the existing request and composer focus. The complete chat supports saved conversations, a real streaming reply, stop, retry, and editing an earlier request as a separate continuation. Editing does not allow an older response to overwrite the newer direction. Attachments become available only when the service really accepts, extracts, and uses supported content.

Acceptance criteria:

- A meaningful request survives route changes and reload after successful local saving.
- Deleting one draft leaves other drafts untouched; cancelling deletion changes nothing.
- Pending submission is visible, and repeated submission does not create duplicate messages or runs.
- Failure preserves the request and offers an appropriate retry or correction.
- Changing the requested course language is explicit and does not silently translate or discard the request text.
- An old conversation branch cannot replace the active branch's answer or curriculum.

Source: `scope.md > The Core Loop` and `scope.md > The POC Boundary`.

### Research and Approve the Curriculum

The agent identifies useful subject foundations, dependencies, version-sensitive material, and sources appropriate to the learning goal. It reports actual work in understandable language. Source quality is judged by relevance and support for the material, not by a decorative link count.

The curriculum describes observable learning outcomes, assumed knowledge, modules, their dependencies, and an honest estimate of study commitment. Consequential open questions are visible. The creator can change supported fields or ask for a meaningful revision. Approval is an explicit action attached to the exact displayed revision.

Acceptance criteria:

- Work events correspond to operations that actually ran. The UI does not invent progress percentages or completion times.
- The creator can inspect the curriculum before authorizing detailed course construction.
- Changing an outcome or module invalidates approval of the previous curriculum revision.
- Approving an out-of-date revision does not start generation and presents the current version for review.
- Blocking questions or invalid module dependencies prevent approval with an explanation.
- Sources are inspectable; generated exercises, grading references, and solutions remain hidden at this point.

Source: `scope.md > The Core Loop` and `scope.md > What "Working" Looks Like`.

### Generate a Substantial Course

After approval, the system researches individual modules, develops explanations and examples, selects activity families for the intended learning action, and validates tasks before making a course ready. The learning sequence includes independent application and appropriate prerequisite support. Depth comes from the approved outcomes and meaningful practice, not padding or artificial delays.

A long-running course may take longer than the initial interaction. The useful early result is the curriculum and its resolved questions. A full-course completion time will be stated only after measurement with the connected services.

Acceptance criteria:

- The generated course refers to the approved curriculum revision and retains every required outcome.
- Each released task uses a supported activity and a suitable evaluation method.
- A failed task validation leads to repair or a visible unresolved failure, not silent publication.
- Leaving the page does not discard accepted work or automatically cancel generation.
- Returning restores the real run state; retry reuses completed work without duplicate courses.
- A course becomes available for study and sharing only when its version is ready.
- Later edits produce a new course version and do not silently rewrite an existing learner's course.

Source: `scope.md > The Unique Kernel` and `scope.md > The POC Boundary`.

### Learn Through Varied Practice

An activity asks the learner to do something meaningful with the material and provides feedback tied to that work. The complete service needs a broad collection of activity families. A different color, timer, card layout, or drag interaction is not a new learning family.

The proposed breadth includes the following distinct learning actions. This is a coverage plan, not a claim that these activities already exist or work equally well for every subject.

| Group | Proposed activity families |
| --- | --- |
| Recall and discrimination | Recall without cues; distinguish similar cases; infer a rule from examples; construct a valid example; construct a counterexample |
| Processes and investigation | Reconstruct a procedure; trace intermediate states; predict a result; diagnose a cause; select a discriminating experiment; intervene in a validated causal model |
| Models and planning | Connect concepts; map an analogy and its limits; translate between representations; estimate magnitude; choose a strategy; construct a feasible plan |
| Construction and testing | Produce a working artifact; find and repair a defect; design a revealing test; optimize while preserving correctness |
| Explanation and evidence | Explain why a step is justified; develop an argument and objection; investigate conflicting sources; critique and improve an artifact against criteria |
| Communication and transfer | Teach a character with a defined misconception; ask questions to obtain missing information; act in a goal-driven scenario with changing constraints; adapt a message to a new audience without losing its meaning |

Every activated family needs a content contract, an accessible interaction, an evaluation method, accepted alternative answers where appropriate, and an explicit uncertainty or unsupported state. Some activities can be checked deterministically; execution and open-response judgments have different limits. The product must not turn a subjective judgment into a falsely exact score.

Acceptance criteria:

- The instruction, necessary material, answer action, and feedback form one coherent task.
- A learner can request help; the record distinguishes helped work from independent work.
- Feedback names the relevant issue and a useful next action rather than only marking an answer wrong.
- Uncertain or unavailable evaluation is visibly different from an incorrect answer.
- The learner can continue after sufficient evidence, revise an answer, or receive a concise explanation as appropriate.
- No unsupported generated interaction or answer format is released as confidently evaluable.
- Sources and permitted explanations are available in context without leaking hidden answer material before the appropriate step.

Source: `scope.md > The Unique Kernel`, `scope.md > The POC Boundary`, and `scope.md > Explicitly Cut`.

### Adapt Support Within a Shared Course

Two learners can study the same course version while receiving different next tasks or support. Adaptation uses actual attempts, assistance, and explicit self-report with their different evidential limits. It does not treat a pause, a slow answer, or one incorrect response as proof of inability.

The common curriculum remains visible. Required outcomes are preserved. The learner can understand why support was offered and return to the shared sequence. Additional practice does not erase completed progress or impose unrelated work as punishment.

Acceptance criteria:

- Two enrollments in one course can hold independent routes and progress without changing the shared content.
- A simple local error can be addressed with an explanation and continuation.
- Additional or prerequisite practice has a recorded basis in relevant learner evidence.
- Self-reported familiarity is distinguishable from demonstrated independent success.
- A changed route preserves required outcomes and offers a clear next action.
- The interface explains a meaningful route change in ordinary language.

Source: `scope.md > The Unique Kernel` and `scope.md > The Core Loop`.

### Save Progress and Earn XP

Study position, attempts, help used, feedback, and route changes are saved for the current enrollment. XP and levels reward qualifying work under one consistent policy. They are distinct from evidence of mastery and from the quality of a course.

Acceptance criteria:

- A returning learner resumes their own enrollment and course version.
- Repeating the same accepted attempt or replaying a request cannot award XP twice.
- The interface displays the authoritative level and publication eligibility rather than calculating an independent rule.
- A trial activity and author editing do not provide a shortcut to publication eligibility.
- A failed save never displays confirmed cloud persistence.
- Progress and other private learner information never appear in a shared course response.

Source: `scope.md > The Core Loop` and `scope.md > What "Working" Looks Like`.

### Browse, Share, and Publish

The public catalog contains only genuinely public, ready course versions. The library groups created courses, enrollments, and device-only request drafts clearly. Empty and no-match states explain what the learner can do next.

Creators choose private, link-accessible, or public access deliberately. A link grants access to a specific version, can be revoked, and never transfers the creator's learning record. Public publication requires the specified level and a validated ready version; reaching a level does not itself prove course quality.

Acceptance criteria:

- Search and filters affect actual records, and visible counts come from those records.
- A recipient of a valid link sees the intended course version and starts a separate enrollment.
- A revoked link stops granting access.
- A non-owner cannot edit, share, or publish another creator's course.
- A learner below the publication threshold receives the true eligibility reason; changing a client-side value cannot bypass it.
- A visibility control explains access before confirmation and does not publish merely because it was opened.
- A ready course stays tied to its version when the creator later revises the curriculum.

Source: `scope.md > Who It's For`, `scope.md > The Core Loop`, and `scope.md > The POC Boundary`.

### Provide an Accessible English Interface

The interface is English only. Course language follows the course request and supported generation capability. Writing in another language does not alter navigation labels or silently translate the user's material. There is no language switch advertising an unimplemented interface locale.

Acceptance criteria:

- Important actions work with keyboard and touch and do not depend on hover or dragging alone.
- Focus is visible; dialogs and menus manage and restore it predictably.
- Long labels, error messages, and course titles in the requested content language reflow without clipping essential actions.
- Reduced-motion preferences leave all information and actions available.
- Status, success, error, and selection are not conveyed only by color.
- Pending and error messages are readable and appropriately announced without repeatedly reading streaming text.

Source: `scope.md > Inspiration & Identity`.

## States and Boundaries

| State or boundary | Required behavior |
| --- | --- |
| First visit | Explain the product and offer creation, exploration, or the isolated trial; do not manufacture an identity or past activity |
| Empty public catalog | Show the real absence of public courses and useful creation or trial actions |
| Cloud account or library unavailable | Distinguish unavailable cloud capability from a genuinely empty signed-in library; local drafts remain usable |
| No search matches | Preserve the query and filters and offer a clear reset |
| Device storage unavailable | Keep the current text in view, explain the failed save, and allow another save attempt |
| Model or research capability unavailable | Do not accept a generation run; preserve the request and return a truthful recoverable failure |
| Queued or running generation | Display actual state and received material; never fabricate work events or percentages |
| Waiting for curriculum approval | Keep the current revision inspectable and editable; do not generate detailed tasks until explicit approval |
| Stale approval or concurrent edit | Reject the stale change, retain useful local input, and show the latest revision |
| Interrupted stream | Retain received text and reconnect or restore from the saved run; a closed tab is not a cancellation |
| Cancelled run | Preserve completed material and clearly indicate that unfinished work stopped |
| Invalid generated task | Repair or withhold the affected release; do not quietly substitute a fake success |
| Pending or uncertain evaluation | Distinguish waiting or uncertainty from incorrect work and avoid unsupported XP awards |
| Signed out or expired session | Protect private records, retain a recoverable request as appropriate, and resume only through actual identity recovery |
| Account change | Do not restore another account's private conversation or learning state |
| Unavailable course or revoked link | Explain that access is unavailable without exposing private content |
| Narrow viewport or reduced motion | Preserve primary actions, reading order, feedback, and meaningful final states |

Local request drafts and isolated trial state may persist on the current device. Production conversations, approvals, ready course versions, enrollments, attempts, XP awards, and share grants require durable server storage. The product must accurately label which kind of persistence an action has achieved.

## Product Decisions

| Decision | Origin and reason |
| --- | --- |
| A substantial general course service with many meaningful activity families | Product-owner direction; the product must support actual continued study rather than a brief quiz |
| Research, curriculum review, detailed construction, and validation as separate parts of creation | Product-owner direction; the creator controls the learning plan before the hidden exercises are built |
| Individual learning experience within one common course | Product-owner direction; support can vary while shared depth remains intact |
| A deep AI course beginning with fundamentals and continuing into both model creation and AI systems | Product-owner-selected first validation course; it exercises the engine without limiting the service to AI |
| Several authored courses produced by the same engine after it exists | Product-owner direction; catalog examples must demonstrate the real creation system |
| Start foundation and design before model access is supplied | Explicit current authorization; useful local behavior and interaction quality can be developed without simulated AI |
| Vercel as the hosting target | Product-owner direction; deployment details and production services still need resolution |
| English-only interface, retained brand slogan, and Learn with cycling topic pills in the hero | Product-owner direction; "everything" is one of the cycling entries and course language remains independent |
| Unfurl identity, paper material, and vermilion accent | Working design choices within the assignment; final visual review is still required |
| Immutable released course versions and enrollment-specific routes | Technical proposal supporting stable shared content and independent learning records |

## What We're Building

The complete scope includes the landing and support pages; public catalog and course detail; personal library; creation chat with live research and streaming; editable and explicitly approved curricula; substantial validated course generation; a broad supported activity library; a learning player with useful evaluation; enrollment-specific adaptation; durable progress, XP, and levels; versioned sharing and level-gated publication; complete English interface states; a reproducible application; and the agreed hosting arrangement.

The first authorized delivery establishes the foundation and coherent interface experience. It contains genuine local draft operations and a bounded playable activity. Live-service requirements remain part of the complete scope and must pass their own acceptance checks before the product is called complete.

## Deferred From the POC

These items are deferred from the foundation delivery, not removed from the requested product:

- Real model and research integration, pending access and capability verification.
- Authentication, shared production storage, and durable execution, pending provider and deployment decisions.
- Live generation, multi-learner adaptation, account XP, sharing, and public publication, pending their authoritative services.
- Authored deep courses, which must be produced and reviewed through the completed engine.
- Production publication, pending the agreed deployment arrangement and a verified release.

Presentation and demonstration-video production are a separate subsequent assignment. The application handoff must provide a working product, an accurate README, and a reproducible path through real functionality for that work.

## Possible Later Enhancements

An explicit course-version migration could let an enrolled learner move to a revised course while preserving compatible evidence. It requires a verified mapping between outcomes and is outside the first complete release unless added deliberately.

Unsupported forms of practice may be added as their content contracts, interactions, and evaluation methods become defensible. They must not appear as supported merely because a model can produce text for them.

## Non-Goals

- A single text response presented as a generated course.
- A hard-coded flagship course standing in for a general course engine.
- Simulated research, invented activity, fabricated learner evidence, or claims of measured learning gains.
- Additional exercises imposed to make a trivial error look like a deeper problem.
- A fixed minimum course length achieved through padding.
- Hidden simplification that removes required topics from a learner's route.
- Account success, cloud saving, sharing, or publication simulated only in the interface.
- A promise to grade every possible skill reliably or to certify mastery from XP.
- A generic page builder that executes model-generated interface code.

## Open Questions

| Question | Boundary for resolution |
| --- | --- |
| Which model and research providers are available, and what are their structured-output, streaming, tool-use, budget, and rate-limit constraints? | Before any real research, generation, or model-backed evaluation is enabled |
| Which production database, identity provider, and durable execution service will be used with Vercel? | Before authoritative accounts, shared records, or resumable background jobs are implemented |
| What initial capability set and validation evidence are required for each activity family? | Before that family is eligible for generated courses |
| What evidence permits additional practice or a prerequisite detour, and how can the learner inspect or leave that detour? | Before adaptive routing affects a real enrollment |
| What are the XP policy, level thresholds, publication requirement, and abuse checks? | Before account awards or public publication are enabled |
| What supported attachment formats, extraction limits, and retention rules are needed? | Before attachment controls are made functional |
| Which additional authored course subjects will demonstrate the engine's generality? | After the engine is working and before the authored collection is accepted |
| What operational budget, environment, and publication arrangement are approved? | Before paid resources or a production deployment |

These unresolved decisions do not block the explicitly authorized foundation and design work. They do block claims that the complete service is integrated or ready for production use.
