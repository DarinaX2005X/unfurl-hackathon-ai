---
doc: checklist
status: draft
---
# Unfurl Build Checklist

This checklist records acceptance outcomes. Implemented components, automated checks, live service evidence, visual observations, and user acceptance are separate. An unchecked outcome may have substantial implementation behind it; it remains open until the complete stated journey is verified.

## Delivery and Completion Boundary

The target is the complete account-backed product and one substantial English AI course created through the ordinary authoring service. The course covers foundations, model construction, and AI-system engineering. Other demonstration courses are outside this delivery.

The repository includes the application, integration boundaries, migrations, and checks. Release acceptance also requires a ready course, real learning, progression and publication, the featured route, independent review, and a reproducible fresh setup. A draft curriculum or an isolated activity does not satisfy those outcomes.

## Slices

- [ ] **1. A visitor understands the service and can develop a course request.**
  The landing, creator, catalog, library, account, and product-information routes are connected. A first unsent draft creates no conversation. Sending records real intent and truthful delivery status. Saved history, writing, rename/delete, cancellation, retry, and explicit legacy import preserve identity and account boundaries. Review the composed interface at representative desktop and narrow widths, including focus, keyboard access, text enlargement, and reduced motion.
  References: [core journey](prd.md#the-core-journey), [course creator](spec.md#course-creator), [browser recovery](spec.md#browser-recovery-and-persistence-boundaries).

- [ ] **2. A learner can return to their own stored work.**
  Configure Supabase Auth and PostgreSQL, apply the ordered migrations, and verify actual account creation/sign-in, sign-out, session restoration, and account switching. Confirm server ownership, private access denial, revision conflicts, and duplicate mutation behavior. Verify account work survives a new session and private cached state does not cross accounts.
  References: [storage and access](spec.md#identity-repositories-and-access), [setup](../docs/setup.md).

- [ ] **3. Real research produces an editable and approvable curriculum.**
  A meaningful goal triggers actual research and source reading, then a saved artifact with audience, prerequisites, outcomes, modules, language, and estimates. Source citations match read evidence. Editing or a material change keeps revision checks. Approval binds the selected saved revision and waits for active authoring to finish.
  References: [curriculum requirements](prd.md#research-and-approve-the-curriculum), [research and generation](spec.md#research-generation-and-durable-execution).

- [ ] **4. Approved work becomes a valid, substantial course.**
  Research covers the approved outcomes and both AI branches. Required reading, practice, and independent demonstration are present. Registered activity capabilities match the work. Alternative-valid and invalid cases exercise actual evaluators; source grounding and independent content review pass. Saved steps recover after interruption without duplicate provider effects. A failed validation prevents release, and retry retains completed compatible work.
  References: [generation requirements](prd.md#generate-a-substantial-course), [data model](spec.md#course-curriculum-and-released-version).

- [ ] **5. Learners complete meaningful work and retain separate progress.**
  Two accounts enroll in the same immutable ready version and keep distinct attempts, feedback, assistance, routes, and XP. Verify independent correctness, an accepted alternative, meaningful error feedback, uncertain/unavailable grading, hints, worked answers, review, support, and return to the required program. Exercise supported Python work against real capability evidence. Continue in a new session and confirm actual state.
  References: [practice](prd.md#learn-through-varied-practice), [personal support](prd.md#adapt-support-within-a-shared-course), [progress](spec.md#enrollment-evidence-route-and-progress).

- [ ] **6. The real AI course is published and reachable through Try.**
  Earn publication eligibility through normal learning: 500 XP and level 3. Publish a ready course through the server policy. Verify catalog/detail visibility, version-bound share access and revocation, and separate recipient enrollment. Configure the exact public course/version pair. Try must preserve that destination through authentication and open the common player; direct login returns home.
  References: [sharing and publication](prd.md#browse-share-and-publish), [Try](prd.md#understand-the-product-and-try-a-real-course).

- [ ] **7. The delivered repository and deployment are independently usable.**
  Reconcile public documentation with the finished behavior, inspect actual screenshots, run applicable checks, and follow only public setup instructions from a clean checkout. Verify ordinary production-mode startup, explicit service prerequisites, capability initialization, and recovery. Separately verify the pushed revision and deployed revision. Record actual limitations without treating them as completed work.
  References: [README](../README.md), [setup](../docs/setup.md), [verification approach](spec.md#verification-approach).

## Hands-on Checkpoints

Use the smallest representative journey that answers an open question. Do not repeat unchanged browser inspections after every edit. Judge appearance from pixels and inspect hierarchy, spacing, typography, contrast, clipping, overlays, feedback, and the apparent next action.

| Checkpoint | Evidence required |
| --- | --- |
| First use | Actual landing and first-send behavior; clear creation, exploration, and Try actions |
| Authoring | Real source actions, editable program, revision-safe approval, build messages and result |
| Learning | Real reading/activity and feedback; independent and assisted evidence; saved continuation |
| Access | Two distinct learners, private denial, shared version, revocation, eligible publication |
| Featured entry | Exact public version, authentication continuation, common learning workspace |
| Recovery | Interrupted or failed work resumes from authoritative records without duplicate effects |
| Fresh setup | Public instructions work without hidden local files or preseeded capability receipts |

The authoring image in [README](../README.md) is an actual saved curriculum and conversation before detailed course construction. It establishes the pictured authoring state. Learning, feedback, publication, and fresh setup require their own evidence. A visual inspection is not a measured comprehension test or user approval.

## Final Review

- [ ] Run the relevant automated checks and record their scope, including live suites that were intentionally not run.
- [ ] Verify the complete real course and learner journeys above; retain concrete failures until repaired and rechecked.
- [ ] Review representative final pixels and interaction states after material repairs.
- [ ] Confirm empty, loading, failed, unavailable, stale, cancelled, and permission-denied states remain useful.
- [ ] Confirm secrets, hidden answers, private source data, and private operational files are absent from public artifacts.
- [ ] Check README commands, links, assets, environment names, account behavior, storage boundaries, and credits.
- [ ] Verify a clean installation and production start using only public files and stated prerequisites.
- [ ] Reconcile source, remote, and deployed revisions separately.
- [ ] Resolve the project license without inventing one.
- [ ] Record remaining limitations plainly and distinguish agent evidence from user acceptance.

## Code Tour and App Map

A useful code tour follows one real action from interface to contract, server effect, and evidence. It should explain a project decision that the reader can apply to a later change. Suggested routes include curriculum approval into generation, an attempt into evaluation and XP, or Try into an exact enrollment.

- [ ] Choose and verify two or three relevant source locations for a real action.
- [ ] Record whether the activity was an interactive walkthrough, focused investigation, or static reference.
- [ ] If a standalone app map is delivered, keep it useful offline and with scripts disabled; use actual paths and a verified source revision.
- [ ] Record any optional edit or reflection only if it actually occurred.

No completed tour, learner mastery, or optional edit is inferred from this document.

## Revisions

This draft replaces the earlier local-only foundation description with the implemented account-backed architecture and current one-course delivery boundary. Completion boxes remain acceptance gates and are not historical claims about unverified live outcomes.
