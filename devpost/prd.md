---
doc: prd
status: draft
---
# Unfurl Product Requirements

Unfurl helps a learner create a substantial course with an agent and study through meaningful, varied practice. This document states the product behavior and acceptance criteria; it does not convert an implemented feature or passing unit test into a completed live journey.

Source: [scope](scope.md).

## Product Status and Delivery Boundary

The application connects accounts, server storage, research, durable generation, activity evaluation, progression, sharing, and publication. The authored-content requirement is one full English AI course covering foundations, model construction, and AI-system engineering. It must be produced through the normal service.

A ready generated course, actual learning and XP, publication, featured entry, and a fresh reproducible setup remain separate acceptance outcomes. The [checklist](checklist.md) records those distinctions. Provider and hosting requirements are described in [setup](../docs/setup.md).

## The Core Journey

1. A visitor understands the purpose, opens creation or the catalog, or selects the featured course through Try.
2. A required sign-in preserves a safe intended destination; direct sign-in returns home.
3. A creator writes a goal, desired ability, background, and constraints. A first draft remains provisional until Send.
4. The agent replies, searches, reads sources, and creates a saved course program with outcomes, prerequisites, modules, and estimated study time.
5. The creator reviews or edits the selected artifact, then approves the current saved revision after authoring has finished.
6. Plan approved appears in the conversation. The agent's build continues there with messages, actual actions, and a final ready-course card when release succeeds.
7. A learner starts a ready version, reads, performs activities, examines feedback, and continues from server-confirmed progress.
8. Additional practice and support respond to evidence without silently removing required goals.
9. The creator shares a version or publishes an eligible ready course; each recipient receives a separate enrollment.

## Screens and Layout

| Surface | Primary action and content |
| --- | --- |
| Landing | Understand the service; create, explore, or enter the featured course |
| Creator | Conversation history, agent replies and actions, composer, selected curriculum, approval and build result |
| Explore | Search actual public ready courses; distinguish empty collection and no match |
| Course detail | Inspect audience, prerequisites, outcomes, modules, version, and access before beginning |
| Library | Open created courses and continue enrolled courses; never use chats as course records |
| Learning workspace | Reading or activity, answer controls, feedback, support, sources, and course navigation |
| Shared course | Resolve one accessible version and begin the recipient's own enrollment |
| Account | Manage the signed-in profile and password, inspect progress, and sign out |
| Help and privacy | Explain actual behavior, saved work, failure recovery, and access |

Desktop gives the current conversation or activity enough working space. Narrow layouts preserve writing, selected artifacts, and usable controls. Essential actions must not depend on hover.

## Look and Feel

Use the established warm-paper palette, dark typography, vermilion actions, Manrope, and original course illustration. The landing explains the mechanism; internal screens keep the same care in spacing, hierarchy, and feedback.

Motion follows interaction and state. Loading indicates real pending work, reduced motion retains clear states, and animation must not delay an ordinary action. Labels describe the user's task rather than implementation details. Do not invent statistics, testimonials, or course completion claims.

## Features and Behavior

### Understand the Product and Try a Real Course

Try resolves a configured public ready course and exact version. It uses the common study workspace, not an isolated numerical sample. Unavailable configuration has a useful explanation and working alternatives.

Acceptance: login/signup preserves the intended course; direct login goes home; the start action creates or reuses the correct enrollment; no course or XP is invented when no featured version is available.

### Develop a Course Request in Chat

The chat supports multiline writing, editable scenario cards, actual agent replies and actions, saved history, rename/delete, cancellation, and retry. One conversation can reference several real course artifacts. Title and conversation creation follow the first send, not typing.

Acceptance: rapid switching and stale responses cannot overwrite newer writing; failed sends retain their intent; duplicate retries do not duplicate accepted messages; saving and sending have distinct confirmations; legacy browser import is explicit and does not send imported content. Deleted imported chats do not reappear automatically.

### Research and Approve the Curriculum

Research identifies appropriate foundations, dependencies, source evidence, and consequential unknowns. The curriculum exposes observable outcomes, audience, assumed knowledge, ordered modules, prerequisites, and a study estimate. Detailed answer keys remain private.

Acceptance: sources correspond to actual reads; snippets alone are not read evidence; edits retain revision checks; an outdated or still-authoring program cannot be approved; approval binds course, revision, and digest. Editing the program cannot silently reuse an incompatible approval.

### Generate a Substantial Course

After approval, durable work builds the course in saved portions. Section knowledge is checked against the full approved demonstration before planning. Missing material can trigger targeted research. Lesson and task portions continue without a fixed whole-course task count.

Acceptance: normal reading, required practice, and independent demonstration cover the canonical criteria; optional practice, diagnostics, and challenges do not substitute for required coverage. Tasks use available registered capabilities. Valid and invalid cases exercise actual evaluators. Independent review checks substance. Only a fully validated compatible set of modules is released as ready.

The conversation presents the actual stage and section without raw operation IDs or invented percentages. A retry refers to the appropriate build; late results cannot revive a cancelled or superseded run. Paid retries are not described as free.

### Learn Through Varied Practice

The 29 activity families support reconstruction, discrimination, investigation, construction, optimization, explanation, source analysis, and communication. Selection follows the learner action needed by the outcome.

Acceptance: controls match the task schema; answers and actions survive confirmed saves; the server grades the submitted saved input; investigations cite real observations; Python executes in the supported isolated runtime; alternate valid answers are handled where the task permits them. Hidden evaluator data never appears in the public task payload.

### Adapt Support Within a Shared Course

A local mistake may warrant explanation or revision. Stronger route changes need relevant evidence. Support has a stated target and a way back. Independent evidence, assisted work, uncertainty, and self-report are not interchangeable.

Acceptance: mandatory outcomes remain; two learners do not share progress; support can be accepted, declined, and returned from; repeated evidence from the same task does not masquerade as independent confirmation. A fresh-assessment request uses unseen validated material when available and reports exhaustion honestly.

### Save Progress and Earn XP

Enrollment fixes the course version. Server-owned route changes, attempts, evaluations, feedback acknowledgements, and awards survive reconnection. The client cannot set completion or XP.

Acceptance: an independently correct eligible task awards 25 XP, a hinted correct task 10 XP, and worked-example reproduction 0 XP. One task cannot repeatedly award points. Uncertain, pending, and unavailable evaluations create no new award. Definite corrections use an auditable adjustment. Levels advance every 250 XP; publication eligibility begins at level 3, or 500 XP.

### Browse, Share, and Publish

Private courses remain owner-only. Sharing grants access to an exact version through a revocable token. Public discovery exposes published ready versions. A later generated version does not automatically replace the published one or an existing enrollment.

Acceptance: known IDs do not grant access; a revoked link cannot enroll a new recipient; publication checks actual eligibility and current revision; no creator or other learner responses leak through public or shared routes.

### Provide an Accessible English Interface

The app interface is English while content language belongs to a course. Controls expose meaningful names, focus, selection, disabled, pending, and failure states. Keyboard equivalents and readable descriptions accompany relevant visual activity controls.

Acceptance: long text and narrow screens remain usable; reduced motion preserves function; errors appear near the affected action; screenshots establish visible composition only, not measured comprehension or learning efficacy.

## States and Boundaries

- Queued and waiting work must not claim an active provider call.
- A finished agent reply is different from a ready course.
- Saving an input is different from submitting and evaluating it.
- An unavailable evaluator is different from a wrong answer.
- A successful build is different from an eligible public publication.
- Browser recovery is different from confirmed account persistence.
- Repeated requests retain stable identities; revised intent receives a new identity.

## Product Decisions

Email/password signup immediately authenticates without confirmation mail; email recovery is unavailable. Conversations and learning are account-backed; the browser holds limited recovery and optional legacy imports. Source reading supports web text, not PDF extraction. External capability and financial limits remain visible operational conditions.

## What We're Building

The complete connected service and one substantive AI course, with actual learning and publication verified through normal operations. See the [technical specification](spec.md) and [checklist](checklist.md).

## Deferred From the POC

The name POC does not reduce this delivery to a demo. The separately assigned presentation and video, and additional authored history/statistics courses, are outside this implementation's current content scope.

## Possible Later Enhancements

Additional source formats, languages for the interface, and further activity capabilities can be considered after the current journey is verified. They are not required to describe existing capabilities truthfully.

## Non-Goals

Fake courses or awards, a static question bank replacing the generator, arbitrary punishment, a promise of measured learning gains, and publishing without creator intent.

## Open Questions

Learning efficacy requires study with real learners. The public repository's license terms have not been selected. Final release evidence must establish the generated course, learning/publication path, and clean setup rather than infer them from the implementation.
