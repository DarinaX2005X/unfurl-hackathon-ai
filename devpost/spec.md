---
doc: spec
status: draft
---
# Unfurl Technical Spec

## How This Works, In Plain Language

Unfurl has a familiar agent conversation and a learning workspace. A conversation is independent of its messages and course artifacts: one chat can create or edit several courses. A course exists only after a real agent operation creates that artifact with its initial title, summary, and content language. The creator can inspect and edit each course and approve its own curriculum. After approval, the service researches its modules, creates supported activities, checks their content and answers, and releases a course version. The learning workspace displays that version while keeping each learner's attempts, help, progress, and next steps separate.

The application renders a defined set of activities. The model supplies validated learning content for them; it does not invent executable interface code. A task can be checked by a specific rule, by running a bounded artifact in an isolated environment, or by a rubric that can report uncertainty. Those methods have different limits.

Released course content stays stable. A learner's route can change without rewriting the course or another learner's progress. Research and construction are saved as durable steps, so closing a browser does not erase accepted work. The chat reads those saved events and can reconnect to them.

The currently authorized foundation runs without a model key. It can provide connected screens, genuine local conversations and unfinished writing, and an isolated activity with real local evaluation. It cannot claim that an AI-generated course, shared account, or cloud save exists before the corresponding service is connected.

Implements `prd.md > Planning Status and Authorized Foundation`, `prd.md > The Core Journey`, and `prd.md > Generate a Substantial Course`.

## Planning Status and Integration Gates

This specification remains a draft. Foundation and UI work are authorized. The complete technical package has not been recorded as approved, and paid resources or production publication are not implied by the hosting target.

The browser contracts below are the proposed integration boundary. Concrete database, identity, model, research, execution, and durable-job providers remain unresolved. Their credentials, exact SDK versions, upstream endpoints, rate limits, costs, and deployment configuration must be verified before enabling the associated capability. An empty configuration must produce an explicit unavailable result, never a silent switch to fake data or process-memory persistence.

## The Core Journey Through the System

1. The landing routes to creation, exploration, or the isolated trial. It performs no hidden account, course, or enrollment creation.
2. The creator writes in a standalone chat. `ChatStore` automatically retains conversation history and unfinished writing in browser storage, using ordered writes and acknowledging only actual persistence. The empty view creates no record. The composer has no language selector or manual save control.
3. Sending records a local user message whose delivery status is separate from server acceptance. With services configured, `sendMessage` validates input, revision, and capability before accepting an `AgentTurnRun` under stable request and message identities. An agent turn may finish with zero, one, or several course artifacts. If service capability is unavailable, the local message remains not sent or failed with retry; no assistant, run, or course is created.
4. A durable worker researches the goal and creates a course artifact and its curriculum through real operations. It supplies initial metadata from the conversation. Saved events describe actual actions and identify the relevant artifact. The chat applies them in sequence and can select among several course artifacts and their curriculum revisions.
5. An explicit approval records the selected course's current curriculum revision and content digest atomically. A stale approval fails; it cannot start another revision or another course's generation.
6. A separate `GenerationRun` performs durable module research, task construction, and validation to produce a course version tied to that approval. A failed validation prevents release. Only a ready version enters the study and sharing paths. Finishing an agent reply does not imply a ready course.
7. Enrollment creates or reuses the learner's record for that version. A session response returns public lesson and task data, the learner's route, and authoritative progress.
8. An attempt is validated and evaluated on the server. Its saved evidence can change the learner's next action and create at most one qualifying XP award. Evaluation references and hidden answers stay on the server.
9. Library and session reads restore the learner's own saved state. Sharing exposes a permitted course version and creates separate learning records for recipients.

PRD ref: `prd.md > The Core Journey`.

## Stack

| Dependency | Planned role and version | Rationale and documentation |
| --- | --- | --- |
| Node.js | Major `22.x` for local and hosted execution | One supported runtime major; Vercel manages minor and patch updates. [Node.js](https://nodejs.org/en/docs), [Vercel Node versions](https://vercel.com/docs/functions/runtimes/node-js/node-js-versions) |
| Next.js | App Router `16.4.3` | Routing, server boundaries, React rendering, and Vercel deployment in one application. [App Router documentation](https://nextjs.org/docs/app), [version metadata](https://registry.npmjs.org/next/16.4.3) |
| React and React DOM | `19.3.1` | Interactive tasks, creator state, and reusable application surfaces. [React documentation](https://react.dev/learn), [version metadata](https://registry.npmjs.org/react/19.3.1) |
| TypeScript | Strict checking; exact release pinned in the foundation lockfile | Shared typed boundaries and controlled domain changes. [TypeScript documentation](https://www.typescriptlang.org/docs/) |
| Zod | Runtime schema validation; exact release pinned in the foundation lockfile | Parse untrusted content and API payloads before use, deriving TypeScript types from the same schemas. [Zod documentation](https://zod.dev/) |
| CSS and native SVG | Semantic tokens, responsive layouts, and authored scene geometry | A coherent visual system without a second UI framework; transform and opacity animation where appropriate |
| Lucide React | One icon set; exact release pinned in the lockfile | Consistent stroke and optical sizing. [Lucide React guide](https://lucide.dev/guide/packages/lucide-react) |
| Radix Dialog and Dropdown Menu | Accessible interaction primitives; exact releases pinned in the lockfile | Use established focus, keyboard, dismissal, and menu behavior beneath the authored visual system. [Dialog](https://www.radix-ui.com/primitives/docs/components/dialog), [Dropdown Menu](https://www.radix-ui.com/primitives/docs/components/dropdown-menu) |
| `@fontsource-variable/manrope` | Reproducible font dependency | Supply the selected family through the package installation, with a system sans fallback. Font binaries and font directories are not committed. [Manrope distribution](https://fontsource.org/fonts/manrope) |
| Browser storage | IndexedDB for local conversations and legacy request import; isolated trial state uses a separate namespace | Local behavior with explicit scope, independent of the future cloud account. [IndexedDB documentation](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API) |
| Vercel | Target hosting platform | Next.js hosting with separately configured durable storage and execution. A production deployment is a separate release action. [Deployment documentation](https://vercel.com/docs/deployments) |

Next.js and React version metadata were read during planning. This is not evidence that the project has installed, built, or deployed those versions. The foundation must produce the manifest, reproducible lockfile, and actual passing checks. Exact remaining dependency versions belong in that lockfile before feature handoff.

## Where It Runs and How Someone Tries It

The application runs in a modern browser with Node.js 22 for development and the Next.js server. The repository is the complete application root. All necessary source, assets, configuration, schemas, and reproducible installation instructions must be available there.

The foundation delivery must implement these commands:

```sh
npm ci
npm run dev
```

Open `http://127.0.0.1:3000/`. Routes are unprefixed: `/`, `/explore`, `/library`, `/chat`, and `/try`. `/create` remains a compatibility entry for existing links. The document uses `lang="en"`; there is no `/en` redirect, locale segment, or interface-language switch. Course language remains independent of the English interface and is set on an actual course artifact.

The planned production-build check is:

```sh
npm run check
npm run build
npm run start
```

`check` must run real type, lint, and relevant automated checks and return a nonzero exit code on failure. Scripts and startup paths are requirements for the foundation, not commands reported as tested by this draft.

Without external services, the representative journey is landing, write in a new chat, leave and reopen it from chat history, and complete the guided isolated trial. Sending must retain the user's actual message with truthful delivery feedback and retry. It must not emit an accepted run, assistant reply, course, or fabricated research event.

For the integrated journey, configure the chosen identity, storage, model, research, and durable-execution services using a secret-free `.env.example` and the eventual README. Record exact names and required scopes there after provider selection. Real secret values remain server-side and outside committed files. No client environment variable may expose an API key.

Vercel is the deployment target, using Node `22.x` and the Next.js build. Select the project, environment, persistence, job execution, budgets, and release arrangement before publication. A hosted smoke check must cover the actual streaming and resumability behavior; a local development stream does not prove hosted behavior.

The eventual demonstration needs the real creation and learning journey, including a meaningful input change and two separate learner records. No live URL or successful deployment is claimed in this draft.

## Look and Feel

Implements `prd.md > Look and Feel` and `prd.md > Provide an Accessible English Interface`.

The brand slogan is "Learn what you've always wanted to". The hero presents a fixed "Learn" alongside an automatically cycling topic pill, with "everything" as one entry among many diverse subjects. The pill has no click handler, button role, tab stop, or user controls. It reserves a stable layout area and does not move the primary action. Reduced motion uses static "everything". A stable accessible "Learn everything" replaces the visual topic sequence for screen readers; changing topics are hidden from assistive announcement. Topic cycling pauses offscreen and never restarts the unfolding book.

The hero's lower scene is an original unfolding course volume, built from authored SVG/CSS/React geometry. Its cover, page, receiving surface, and practice object move in a causal sequence. A readable still state remains after the transition. It is labelled or composed as illustration, without pretend generation controls or fabricated learner output.

| Token | Value | Role |
| --- | --- | --- |
| canvas | `#F5F3ED` | Warm page background |
| surface | `#FFFEFA` | Reading, composer, and open curriculum surfaces |
| surface-inset | `#ECEAE3` | Inset area or inner page |
| ink | `#25272B` | Main text |
| muted | `#62656B` | Secondary functional text |
| action | `#BA432D` | Primary action |
| action-hover | `#A73523` | Primary hover |
| selected | `#F6E2D8` | Selected background with explicit text or shape |
| border | `#8B8E87` | Important control boundary |
| line-soft | `#DDDCD4` | Quiet grouping divider |
| focus | `#2D5B91` | Visible keyboard focus |
| success | `#247356` | Confirmed successful result |
| danger | `#B32636` | Error or destructive action |
| warning | `#875D20` | Warning with explanatory text |

Body text starts at 16px with a 26px line height; long reading uses about 18px/29px. Functional secondary labels stay at least 14px/20px. Headings use heavier Manrope weights; code alone uses a monospace stack. Content-language glyphs must render correctly with an appropriate fallback.

Spacing follows 4, 8, 12, 16, 24, 32, 48, and 72px. Controls use roughly 12px radii, fields 16px, reading surfaces 24px, and the focal scene 32px. Hit targets are at least 44px, with primary actions around 52px tall. Reading lines are limited to about 68 characters and chat to about 720px. Layout responds around 640, 960, and 1280px while respecting the actual container's minimum useful width.

The main laptop review sizes are 1366×768 and the more constrained 1264×712; a representative narrow review uses 390px width. These are inspection targets, not a claim that the UI has passed them. The whole hero must retain its base and readable action. At narrow widths, reduce scene complexity rather than shrink essential text.

Motion uses approximately 100ms press, 160ms hover, 240ms state, and 320ms layout transitions with `cubic-bezier(.22,1,.36,1)`. The illustration can use its own deliberate sequence. Offscreen work pauses. Repeated input retargets the current state rather than restarting a long ritual. Reduced motion removes travel, parallax, automatic cycling, and stagger while preserving state and affordances. Avoid `transition: all`, global shaking, decorative loops during reading, and moving hit targets.

Every interaction needs visible rest, hover where supported, immediate pressed response, focus-visible, and relevant selected, open, pending, disabled, and error states. Menus and dialogs support keyboard operation, dismissal, and focus restoration. Color is never the only status cue. All actual color combinations, including opacity and disabled states, need contrast checks during implementation.

## Components

### Domain Schemas and Application Ports

`src/domain/` owns canonical runtime schemas and their derived types. It validates IDs, revisions, course graph references, activity configurations, public projections, and the legal state transitions. Local conversations and messages are distinct from authenticated server records. `src/application/ports.ts` defines operation-level boundaries for browser conversations, course access, learning, runs, and provider adapters. Features consume these exports and do not redefine competing Course or ChatEvent models.

Implements `prd.md > Generate a Substantial Course`, `prd.md > Adapt Support Within a Shared Course`, and `prd.md > States and Boundaries`.

### Shared Interface and Navigation

`src/components/ui/`, `src/components/shell/`, `src/styles/`, and `src/content/common.ts` own common controls, shell, tokens, and English messages. Feature copy lives beside its feature. `src/lib/routes.ts` preserves the selected record and query. `routes.chat(id?)` uses `/chat?conversation=<UUID>` for an existing conversation, and `routes.create()` remains a compatibility alias. Older `/create?draft=<UUID>` links restore the imported conversation. `routes.course(slug)` and `routes.learn(enrollmentId)` produce unprefixed course and enrollment routes. Course language remains a field of the course artifact, not the composer.

Shared UI exports are `Button`, `LinkButton`, `IconButton`, `TextField`, `Textarea`, `Select`, `Tabs`, `Dialog`, `Drawer`, `Menu`, `Notice`, `EmptyState`, and `Progress`. Shell exports are `Brand`, `PublicHeader`, and `AppShell`. Buttons preserve their content and width while pending and block repeat activation. Fields require IDs and labels, with described hint/error text. Controlled tabs retain hidden-panel state. Dialogs and drawers trap and return focus, and menus handle keyboard navigation and collision. A progress value is used only for measured progress. The shell uses one navigation area, with creator history nested within it rather than a second rail.

Implements `prd.md > Screens and Layout` and `prd.md > Provide an Accessible English Interface`.

### Landing and Product Information

`src/features/landing/` and the landing, about, help, and privacy routes explain the product and provide working destinations. The authored hero scene is independent of requests and account state. It can demonstrate the relationship between a course and varied activities without claiming generated output.

Implements `prd.md > Understand the Product and Try a Real Activity` and `prd.md > Look and Feel`.

### Catalog and Library

`src/features/catalog/` consumes `CourseSummary` and `CourseDetailPublic`. `src/features/library/` consumes only authorized course and enrollment items. Neither surface provides conversation or request-draft CRUD. Catalog queries return only public ready versions; content-language filtering is a search concern. An unavailable cloud capability differs from an empty signed-in collection. The current course or study filter remains in the URL. Query/filter reset does not delete records. Failed next-page loads retain existing rows; retry uses the same cursor, and stale search results are ignored or aborted.

Implements `prd.md > Browse, Share, and Publish` and `prd.md > Save Progress and Earn XP`.

### Course Creator

`src/features/creator/` owns chat history, the composer, conversation view, course-artifact selection, curriculum view, event reducer, and transport client. It accepts only validated application events. The reducer isolates active run and branch, deduplicates replay, detects missing sequence ranges, and restores from a snapshot before applying later dependent events. Conversation switching and delayed writes cannot replace newer unfinished writing. Retry preserves message and request identity; an edit creates a new identity. Curriculum approval belongs to the selected artifact and is never inferred from free-form conversation text.

Scenario cards insert complete editable intentions without automatically sending them or silently replacing nonempty writing. Course metadata controls appear only for a real artifact and use an actual mutation callback or API. The local foundation must not synthesize a course to demonstrate those controls. Test fixtures may exercise several artifacts without claiming live creation.

Implements `prd.md > Develop a Course Request in Chat` and `prd.md > Research and Approve the Curriculum`.

### Learning Player and Activity Registry

`src/features/learning/player/` displays public lesson and task data and submits typed responses. `src/features/learning/mechanics/` contains the registered activity families. `src/features/learning/registry.ts` resolves a validated mechanic ID and version to `configSchema`, `responseSchema`, `createInitialResponse`, `Renderer`, and `summarizeResponse`. Unsupported configurations fail explicitly; they do not render arbitrary JSON or generated HTML.

`src/features/learning/sample/` supplies isolated trial content and a bounded deterministic evaluator. Its short visual guide makes the goal, controls, and result interpretation explicit beside the activity. The trial uses the same interaction contract, but its state and local answers are not authoritative account evidence or XP.

Implements `prd.md > Learn Through Varied Practice` and `prd.md > Understand the Product and Try a Real Activity`.

### Identity, Repositories, and Access

Server modules in `src/server/` resolve the actor from the real session, enforce access on every private read and mutation, and persist accepted operations transactionally. Explicit public schemas prevent accidental serialization of answer keys, research packs, private messages, or identity details. Identity provider and repository implementation are integration choices still to be made.

Implements `prd.md > Save Progress and Earn XP`, `prd.md > Browse, Share, and Publish`, and `prd.md > States and Boundaries`.

### Research, Generation, and Durable Execution

Server orchestration separates goal clarification, source research, curriculum drafting, approval, module research, task building, and validation. It records completed results before reporting completion. Provider adapters expose application operations rather than SDK-specific event types. Durable execution must outlive a browser stream and recover from worker loss without duplicate effects.

Implements `prd.md > Research and Approve the Curriculum` and `prd.md > Generate a Substantial Course`.

### Evaluation, Evidence, and Personal Routing

Server evaluation validates a task version and response, records help used, and returns a structured result. Deterministic checks, isolated execution, and rubric evaluation have separate implementations and failure semantics. Evidence feeds a versioned routing policy that preserves required outcomes. XP is a separate idempotent award policy, not a measure inferred by the browser.

Implements `prd.md > Learn Through Varied Practice`, `prd.md > Adapt Support Within a Shared Course`, and `prd.md > Save Progress and Earn XP`.

## Data Model

### Common Types and Errors

The snippets below define the intended application boundary. They are not a claim that source files or endpoints already implement it. Runtime schemas are authoritative once implemented; `unknown` is permitted only before parsing an external payload.

```ts
type Id = string; // Validated UUID
type IsoDateTime = string; // UTC ISO 8601
type UiLocale = 'en';
type ContentLanguage = string; // Validated BCP 47 language tag
type Revision = number; // Integer >= 1
type Visibility = 'private' | 'unlisted' | 'public';
type ApiErrorCode =
  | 'invalid_input' | 'unauthenticated' | 'forbidden' | 'not_found'
  | 'revision_conflict' | 'idempotency_conflict' | 'rate_limited'
  | 'service_unavailable' | 'generation_failed' | 'evaluation_unavailable';
interface ApiError {
  error: {
    code: ApiErrorCode;
    messageKey: string;
    params?: Record<string, string | number>;
    fieldErrors?: Record<string, string>;
    retryable: boolean;
    requestId: Id;
  };
  currentRevision?: Revision;
}
interface Page<T> { items: T[]; nextCursor: string | null }
```

### Course, Curriculum, and Released Version

```ts
interface Course {
  id: Id; ownerId: Id; slug: string; title: string; summary: string;
  contentLanguage: ContentLanguage; visibility: Visibility;
  currentReadyVersionId: Id | null;
  createdAt: IsoDateTime; updatedAt: IsoDateTime; revision: Revision;
}
interface Outcome {
  id: Id; title: string; demonstration: string;
  prerequisiteOutcomeIds: Id[];
  requirement: 'core' | 'specialization';
}
interface ModuleOutline {
  id: Id; title: string; summary: string; outcomeIds: Id[];
  prerequisiteModuleIds: Id[]; estimatedStudyMinutes: number;
}
interface CurriculumDraft {
  id: Id; courseId: Id; conversationId: Id; revision: Revision;
  title: string; contentLanguage: ContentLanguage;
  goal: string; audience: string; assumedKnowledge: string[];
  outcomes: Outcome[]; modules: ModuleOutline[];
  unresolvedQuestions: { id: Id; text: string; blocking: boolean }[];
  sourceIds: Id[]; updatedAt: IsoDateTime;
}
interface CurriculumApproval {
  id: Id; draftId: Id; draftRevision: Revision; contentDigest: string;
  approvedBy: Id; approvedAt: IsoDateTime;
}
interface CourseVersion {
  id: Id; courseId: Id; number: number; approvalId: Id; sourceRunId: Id;
  contentDigest: string;
  state: 'building' | 'validating' | 'ready' | 'failed';
  outcomes: Outcome[]; modules: ModuleOutline[]; lessonIds: Id[];
  createdAt: IsoDateTime; readyAt: IsoDateTime | null;
}
interface CourseCover { motifId: string; alt: string }
interface CourseSummary {
  id: Id; slug: string; title: string; summary: string;
  contentLanguage: ContentLanguage; moduleCount: number; lessonCount: number;
  estimatedStudyMinutes: number; cover: CourseCover; visibility: Visibility;
}
type CourseDetailPublic = CourseSummary & {
  outcomes: Outcome[]; modules: ModuleOutline[]; assumedKnowledge: string[];
};
```

Curriculum IDs must be unique, referenced outcomes and modules must exist, and dependency graphs must be acyclic. Required outcomes need planned demonstrations. Study time is a positive estimate, not measured completion evidence. `validateCurriculum(draft)` returns typed validation issues. `curriculumDigest(draft)` computes SHA-256 over canonical JSON containing `title`, `contentLanguage`, `goal`, `audience`, `assumedKnowledge`, `outcomes`, `modules`, `unresolvedQuestions`, and `sourceIds`; object keys sort recursively, array order remains significant, and top-level identity/revision/timestamps are excluded. `assertCurrentApproval(draft, approval)` checks draft ID, revision, digest, and blocking questions. Foundation failures are typed domain errors; HTTP mapping belongs to integration. Once ready, version content is immutable. Existing enrollments remain on their selected version.

Course summary counts come from the ready version's records. Cover motif IDs come from an allowed artwork registry. Public projections exclude owner contact details, unreleased tasks, private source packs, and evaluation secrets.

Conversation creation, writing, and sending never create a `Course`. The agent supplies title, summary, and content language through an actual course-creation operation. Later metadata changes target that existing course with revision checks and a real persistence acknowledgement. A language or curriculum-affecting change invalidates any affected approval; released versions remain immutable. One conversation can refer to several courses, and deleting it does not delete those course records.

### Conversation, Run, and Typed Events

`AgentTurnRun` represents an ordinary accepted turn in the conversation. It may succeed with zero, one, or several referenced course artifacts and has no `courseId` or `outputVersionId`. `GenerationRun` represents a separate course-building job; its successful result requires an actual course and ready version. The chat stream and snapshot follow the agent turn. Authoritative artifact state, especially `readyVersionId`, determines course readiness.

```ts
interface Conversation {
  id: Id; ownerId: Id; title: string; activeBranchId: Id;
  revision: Revision; createdAt: IsoDateTime; updatedAt: IsoDateTime;
}
interface ChatMessage {
  id: Id; conversationId: Id; branchId: Id; parentMessageId: Id | null;
  role: 'user' | 'assistant';
  status: 'complete' | 'streaming' | 'interrupted' | 'failed';
  parts: Array<{ type: 'text'; text: string } |
    { type: 'attachment'; attachmentId: Id }>;
  clientRequestId: Id | null; createdAt: IsoDateTime;
}
type RunPhase = 'briefing' | 'researching' | 'outlining' |
  'awaiting_approval' | 'module_research' | 'building_tasks' | 'validating';
type RunStatus = 'queued' | 'running' | 'awaiting_user' |
  'succeeded' | 'failed' | 'cancelled';
interface AgentTurnRun {
  id: Id; ownerId: Id; conversationId: Id; branchId: Id;
  inputMessageId: Id; status: RunStatus; lastSeq: number;
  error: ApiError['error'] | null;
  createdAt: IsoDateTime; updatedAt: IsoDateTime;
}
interface GenerationRun {
  id: Id; ownerId: Id; courseId: Id | null; conversationId: Id; branchId: Id;
  inputMessageId: Id; sourceDraftRevision: Revision | null;
  approvalId: Id | null; phase: RunPhase; status: RunStatus;
  lastSeq: number; outputVersionId: Id | null;
  error: ApiError['error'] | null;
  createdAt: IsoDateTime; updatedAt: IsoDateTime;
}
interface EventBase {
  id: Id; runId: Id; branchId: Id; seq: number; at: IsoDateTime;
}
type ResearchAction = 'search' | 'read_source' | 'compare_sources' |
  'build_outline' | 'research_module' | 'construct_tasks' | 'validate_tasks';
type ChatEvent = EventBase & (
  | { type: 'run.accepted'; status: 'queued' }
  | { type: 'message.started'; messageId: Id }
  | { type: 'message.delta'; messageId: Id; text: string }
  | { type: 'message.completed'; messageId: Id }
  | { type: 'action.started'; invocationId: Id; action: ResearchAction;
      labelKey: string; params?: Record<string, string> }
  | { type: 'action.completed'; invocationId: Id;
      resultSummary: string; sourceIds: Id[] }
  | { type: 'action.failed'; invocationId: Id; error: ApiError['error'] }
  | { type: 'artifact.updated'; courseId: Id; revision: Revision }
  | { type: 'outline.updated'; courseId: Id; draftId: Id; revision: Revision }
  | { type: 'approval.required'; courseId: Id; draftId: Id; revision: Revision }
  | { type: 'run.awaiting_user' }
  | { type: 'run.completed' }
  | { type: 'run.failed'; error: ApiError['error'] }
  | { type: 'run.cancelled'; reason: 'user' | 'superseded' }
);
interface RunSnapshot {
  run: AgentTurnRun; messages: ChatMessage[];
  artifacts: CourseArtifactRef[]; lastSeq: number;
  retainedActionEvents: ChatEvent[];
}
```

The live transport exposes `loadRunSnapshot({runId,signal}): Promise<RunSnapshot>` and `subscribeRun({runId,branchId,after,signal}): AsyncIterable<ChatEvent>`. `RunSnapshot.retainedActionEvents` restores the action state alongside saved messages and the artifact collection. Each `CourseArtifactRef` contains its own course metadata, curriculum, approval, and ready-version reference. `artifact.updated`, `outline.updated`, and `approval.required` identify their course and trigger a snapshot read because those events contain no updated artifact body. Message-start metadata derives from the run's conversation ID and the event's ID, branch, and timestamp.

An action event exists only when the corresponding operation actually ran. `invocationId` distinguishes concurrent calls and retries. Visible events contain user-relevant actions and outcomes, never hidden reasoning, system instructions, or future task answers.

Server-sent events use `event: <type>`, `id: <runId>:<seq>`, and `data: <ChatEvent JSON>`. Persist logical events and grouped text deltas before sending them. Sequence numbers increase within a run. The client ignores duplicates at or below its applied sequence, detects gaps, and requests replay or a fresh snapshot rather than silently dropping missing text. It applies events only to the active run and branch.

Reconnection uses `Last-Event-ID`; a fetch stream may start with `?after=<seq>`. A cursor for another run is invalid. Reading an event stream observes a job and must not start it. Capability, authentication, input, and revision checks occur before headers. A later failure becomes a terminal `run.failed` event and clears pending state. Closing a stream is not cancellation. Explicit cancellation preserves received text as interrupted. Editing an earlier message creates a new branch linked by `parentMessageId`; late old-branch results cannot overwrite it.

When a course's outline reaches the approval boundary, `approval.required` moves the agent turn to `status: 'awaiting_user'` and releases the UI's pending state. `run.awaiting_user` also represents waiting for ordinary conversational input without requiring a course. The saved snapshot confirms that state and any identified artifact's current curriculum revision. Chat `run.completed` means that the agent turn has ended; it carries no course-version ID and can occur without any created course. Course readiness comes from an authoritative artifact's `readyVersionId`. The separate course-building `GenerationRun` may have a null `courseId` before creation, but success requires both a real `courseId` and `outputVersionId`. Waiting for approval does not fabricate either identity. Selecting or approving one artifact cannot change another artifact's curriculum or approval.

### Lesson, Task, Attempt, and Evaluation

```ts
interface Lesson {
  id: Id; courseVersionId: Id; moduleId: Id; title: string;
  outcomeIds: Id[]; blocks: LessonBlock[]; taskIds: Id[];
}
type LessonBlock =
  | { id: Id; kind: 'explanation'; markdown: string; sourceIds: Id[] }
  | { id: Id; kind: 'example'; title: string; content: string; sourceIds: Id[] }
  | { id: Id; kind: 'task'; taskId: Id };
interface TaskPublic<TConfig> {
  id: Id; taskVersion: number; mechanicId: string; mechanicVersion: number;
  outcomeIds: Id[]; instruction: string; contentLanguage: ContentLanguage;
  config: TConfig; availableHints: number; responseSchemaVersion: number;
}
type EvaluationSpec =
  | { kind: 'deterministic'; evaluatorId: string; evaluatorVersion: number;
      secretConfig: unknown }
  | { kind: 'execution'; executorId: string; dialect: string; testSetId: Id;
      resourceLimits: { timeoutMs: number; memoryMb: number } }
  | { kind: 'rubric'; rubricId: Id; requiredDimensions: string[];
      calibrationSetId: Id | null };
interface TaskPrivate {
  taskId: Id; evaluationSpec: EvaluationSpec;
  sourceClaimIds: Id[]; validationReceiptId: Id;
}
interface MechanicDefinition<TConfig, TResponse> {
  id: string; version: number;
  configSchema: RuntimeSchema<TConfig>;
  responseSchema: RuntimeSchema<TResponse>;
  requiredAffordances: string[];
  supportedEvaluators: EvaluationSpec['kind'][];
  rendererKey: string;
  accessibility: { keyboardEquivalent: boolean; nonVisualSummary: boolean };
}
interface AttemptPayload {
  id: Id; taskId: Id; taskVersion: number;
  idempotencyKey: Id; response: unknown;
  assistance: 'independent' | 'hinted' | 'worked_example';
  hintIdsUsed: Id[]; submittedAt: IsoDateTime;
}
type Attempt = AttemptPayload & { enrollmentId: Id };
type SampleAttempt = AttemptPayload & { sampleSessionId: Id };
interface Evaluation {
  id: Id; attemptId: Id;
  status: 'evaluated' | 'uncertain' | 'pending' | 'unavailable';
  outcome: 'correct' | 'partial' | 'incorrect' | null;
  dimensions: Array<{
    id: string; status: 'met' | 'partial' | 'not_met' | 'uncertain';
    explanation: string;
  }>;
  feedback: {
    explanation: string; nextAction: 'continue' | 'revise' | 'clarify' | 'wait';
  };
  awardedXp: number;
}
```

`RuntimeSchema` denotes the Zod-based validation boundary, not a handwritten second validator. Each mechanic adds a concrete configuration and response variant to a discriminated registry. Its contract defines the learning action, required material, accepted alternatives, evaluator limits, feedback evidence, and rejection criteria. A renderer never receives arbitrary model-generated component code.

Production hints and grading are server operations. Public tasks exclude grading references and expected answers. Client-reported success cannot create XP. An uncertain result is not an incorrect result. Source text and rich content are escaped or sanitized, and links use safe schemes. Execution tasks use an isolated executor with resource limits, not host evaluation of submitted code. The isolated trial may contain local reference answers because it grants neither real account evidence nor publication rights.

### Enrollment, Evidence, Route, and Progress

```ts
interface Enrollment {
  id: Id; learnerId: Id; courseId: Id; courseVersionId: Id;
  status: 'active' | 'completed' | 'archived';
  routeRevision: Revision;
  currentLessonId: Id | null; currentTaskId: Id | null;
  createdAt: IsoDateTime; lastStudiedAt: IsoDateTime | null;
}
interface LearnerEvidence {
  id: Id; enrollmentId: Id; outcomeId: Id;
  source: { kind: 'attempt'; attemptId: Id } |
    { kind: 'self_report'; messageId: Id };
  observation: 'independent_success' | 'assisted_success' | 'incorrect' |
    'partial' | 'uncertain' | 'self_reported';
  dimensionIds: string[]; recordedAt: IsoDateTime;
}
type RouteReason = 'course_sequence' | 'explanation' |
  'diagnostic_clarification' | 'additional_practice' |
  'prerequisite_support' | 'challenge' | 'scheduled_review';
interface PersonalRoute {
  enrollmentId: Id; revision: Revision; policyVersion: string;
  targetOutcomeIds: Id[];
  next: Array<{
    lessonId: Id; taskId: Id | null; reasonCode: RouteReason;
    basisEvidenceIds: Id[];
  }>;
  coveredOutcomeIds: Id[]; pendingOutcomeIds: Id[];
}
interface Progress {
  xpTotal: number; level: number; xpToNextLevel: number;
  completedRequiredOutcomes: number; totalRequiredOutcomes: number;
  publication: { eligible: boolean; requiredLevel: number; reasons: string[] };
}
```

`LearningSession` returns `{enrollment, route, lesson, task, progress}` using explicit public projections. Routes and practice belong to the enrollment, not the shared course version. Required outcomes remain present after adaptation. A single error permits an explanation or diagnostic clarification; a substantial detour requires the agreed evidence policy. Response latency and absence are not evidence of inability. Self-report does not equal independent success.

A versioned domain policy owns XP and level thresholds. The server returns its authoritative result. A unique qualifying-evidence award key prevents duplication. Editing a course or repeating an isolated trial cannot bypass publication eligibility. Exact thresholds and anti-abuse behavior remain decisions for live learning integration.

### Local Conversations and Persistence Boundaries

The local model separates `LocalConversation`, `LocalMessage`, and `CourseArtifactRef`. A local conversation has no fabricated owner or account. It contains its identity, title, unfinished writing, actual messages with delivery state, references to existing course artifacts, timestamps, and a schema version. A course reference is not a generated course body and is added only after actual creation or verified access. The authenticated production `Conversation` remains a separate server record.

```ts
interface CourseArtifactRef {
  courseId: Id; title: string; summary: string;
  contentLanguage: ContentLanguage; revision: Revision;
  curriculum: CurriculumDraft | null; approval: CurriculumApproval | null;
  approvalRequestedRevision: Revision | null;
  readyVersionId: Id | null; updatedAt: IsoDateTime;
}
interface LocalMessage {
  id: Id; conversationId: Id; role: 'user' | 'assistant'; text: string;
  delivery: 'not_sent' | 'sending' | 'accepted' | 'failed';
  status: 'complete' | 'streaming' | 'interrupted' | 'failed';
  requestId: Id | null; runId: Id | null; branchId: Id | null;
  userLocale: ContentLanguage | null;
  createdAt: IsoDateTime; updatedAt: IsoDateTime;
  error: ApiError['error'] | null;
}
interface LocalConversation {
  id: Id; schemaVersion: 1; title: string;
  titleSource: 'initial_text' | 'user' | 'legacy'; composerText: string;
  messages: LocalMessage[]; artifacts: CourseArtifactRef[];
  selectedCourseId: Id | null; revision: Revision;
  createdAt: IsoDateTime; updatedAt: IsoDateTime;
  legacySource: {
    draftId: Id; contentLanguage: ContentLanguage;
    updatedAt: IsoDateTime; intendedConversationId: Id | null;
  } | null;
}
interface ChatStore {
  list(): Promise<LocalConversation[]>;
  get(id: Id): Promise<LocalConversation | null>;
  put(conversation: LocalConversation): Promise<void>;
  remove(id: Id): Promise<void>;
  wasDeleted(id: Id): Promise<boolean>;
  migrateLegacy(): Promise<LegacyImportResult>;
}
interface LegacyImportResult {
  importedIds: Id[];
  issues: Array<{draftId?: Id; code: 'corrupt_record' | 'version_unsupported'}>;
}
```

Messages must belong to their conversation and have unique identities. User messages require a request ID; assistant messages must come from accepted responses. Course references are unique by course ID, selected IDs must name an existing reference, and each referenced curriculum must match its course and conversation. `approvalRequestedRevision` identifies the selected course's curriculum revision awaiting explicit approval; a pending snapshot must resolve before approval is offered for that revision. `EditCourseMetadata` accepts course ID, expected revision, title, summary, and content language and returns the actually updated `CourseArtifactRef`; an unavailable mutation cannot acknowledge success. Metadata and approval controls require their actual mutation callbacks.

`ChatStore` owns local conversation list, read, write, and deletion. IndexedDB stores these records independently of the future cloud account. Trial state uses its own browser namespace. Session secrets never belong in either store. Moving local history into an account must be explicit, authenticated, and idempotent. Account changes cannot restore another account's private text.

Typing and history changes persist automatically. Opening an untouched empty view creates no record. Writes are serialized per conversation so an older operation cannot replace newer text, and navigation or rapid conversation switching flushes the correct record. A save indicator acknowledges completion only after persistence resolves; failure keeps visible input and supports recovery. Storage errors distinguish unavailable storage, quota, corrupt records, and unsupported versions. Corrupt or newer-version data must not be silently deleted. There is no manual save action.

The legacy `LocalDraft` IndexedDB format remains an import source. Migration preserves its ID, title, text, and timestamps; retains earlier language metadata as provenance; and confirms the new conversation before retiring any original data. Migration is idempotent and records imported or deleted identities so reopening a legacy link cannot resurrect a deliberately deleted imported chat. An older `/create?draft=<UUID>` URL resolves to the corresponding conversation. Language provenance never becomes a composer selection requirement.

Local message persistence and server acceptance are different events. An unavailable send retains the actual user message with not-sent or failed delivery state and retry, with no assistant, run, or course. Retrying uses the same request and message IDs; editing creates a new identity. A late result cannot erase new composer input. Test stores and injected persistence failures must exercise these ordering and recovery guarantees.

### Foundation Application Boundary

```ts
type CapabilitySet = {
  generation: boolean; cloudIdentity: boolean; cloudPersistence: boolean;
};
type CourseQuery = {
  q?: string; contentLanguage?: string; cursor?: string; limit?: number;
};
type ServiceResult<T> = {ok: true; data: T} | {ok: false; error: ApiError};
type SendMessageInput = {
  requestId: Id; conversationId: Id; messageId: Id; text: string;
  userLocale?: ContentLanguage;
};
type SendMessageResult = {message: ChatMessage; run: AgentTurnRun};
type LibraryItem =
  | {kind: 'owned'; course: CourseSummary}
  | {kind: 'enrolled'; course: CourseSummary; enrollmentId: Id;
     lastStudiedAt: IsoDateTime | null};
interface ApplicationPort {
  capabilities(): Promise<CapabilitySet>;
  listPublic(query: CourseQuery, signal?: AbortSignal): Promise<ServiceResult<Page<CourseSummary>>>;
  getPublicCourse(slug: string, signal?: AbortSignal): Promise<ServiceResult<CourseDetailPublic>>;
  listLibrary(signal?: AbortSignal): Promise<ServiceResult<Page<LibraryItem>>>;
  sendMessage(input: SendMessageInput, signal?: AbortSignal): Promise<ServiceResult<SendMessageResult>>;
}
```

`src/application/local-adapter.ts` exports `localApplication`. All capabilities are false. Collection reads return genuinely empty pages, course lookup returns `not_found`, and `sendMessage` returns `service_unavailable` with message key `generation.unavailable`, retryable true, and the same request ID before accepting any server work. The creator retains its own actual local user message with failed delivery; the adapter creates no assistant, run, or artifact. There are no simulated delays or events. Feature services are injectable and default to this adapter, avoiding fetches to nonexistent APIs. `ChatStore` remains a separate real local capability. The library uses the capability result to describe cloud unavailability accurately.

### Real Numerical Trial

The isolated `model-capacity-v1` task uses explicitly synthetic data. Training x values are `[-1,-.7,-.4,-.1,.2,.5,.8,1]`; training y is `sin(pi*x)` plus `[.16,-.12,.14,-.15,.12,-.14,.12,-.16]`. Validation x values are `[-.9,-.6,-.3,0,.3,.6,.9]`, with y equal to `sin(pi*x)`.

Controls offer polynomial degree `1`, `3`, or `7` and lambda `0`, `.1`, or `1`. Fit the polynomial by minimizing squared training error plus lambda times the squared non-intercept coefficients. Use a stable numerical solution and recompute coefficients, fitted line, training RMSE, and validation RMSE from the chosen configuration. Failure preserves the controls and displays a useful error instead of NaN.

The task begins from degree 7 and lambda 0. Card-based guidance explains the learning goal, names the controls where they appear, and demonstrates how to interpret the two errors. The learner can make an optional prediction, changes capacity or regularization, and compares both errors. Shape labels Straight, Curved, and Flexible correspond to degrees 1, 3, and 7; bending limits None, Gentle, and Strong correspond to lambda 0, .1, and 1. Success requires validation RMSE below `.21` and the explanation that zero training error alone does not guarantee performance beyond the training data. Accepted configurations include degree 3/lambda 0, degree 3/lambda .1, and degree 7/lambda .1. Because validation is used for selection, it is not independent proof of future generalization. Free reflection may be saved but is not falsely reported as AI-graded. Orientation is UI state: replaying or dismissing the guide changes neither responses nor hints, receipts, or XP. Actual hints remain recorded as assistance.

Reference numerical targets for implementation checks, with tolerance `1e-6`, are training/validation RMSE: degree 1/lambda 0 `.5681228750/.4976179728`; degree 3/lambda 0 `.1106225068/.0532156483`; degree 7/lambda 0 approximately `0/.3719332272`; degree 7/lambda .1 `.1851313263/.1999833033`. These are supplied check targets, not test results produced by this document.

The plot distinguishes training dots from validation marks with labels and shapes, fixes x to `[-1,1]`, and uses an honest stable y scale. A table/text equivalent supports the same comparison. The player owns submit, hint, reset, and navigation; a renderer changes only its typed response through `TaskRendererProps<C,R> = {task, response, onChange, disabled, status, evaluation}`, where status is `editing | submitting | evaluated | error`.

`SampleSession` holds schema version 1, session ID, task ID/version, response, last attempt, evaluation, used hint IDs, and update time in a separate namespace after the first action. It uses `SampleAttempt`, not a fabricated enrollment, and always awards zero account XP. Same-key/same-body submission reuses the receipt; a changed body with that key conflicts. Editing and resubmitting uses a new key. Reset starts a new sample session and clears only sample state and hints, leaving conversations and legacy data untouched.

| Record | Origin and update | Durable location and return behavior |
| --- | --- | --- |
| Local conversation and unfinished writing | Actual typing, message, rename, and delete operations | IndexedDB on that device; automatic ordered writes restore confirmed local state |
| Legacy request draft | Idempotent import into a local conversation | Original retained until confirmed import; migration history prevents resurrection after deletion |
| Trial state | Isolated task actions and reset | Separate browser namespace; never merged into account XP |
| Conversation and messages | Authorized message and edit operations | Production database; authenticated return restores the saved branch |
| Curriculum and approval | Research output, typed edit, explicit approval | Production database with revisions and digest-bound approval |
| Source documents and claims | Real research operations | Server storage with provenance and safe public citations |
| Course version, lessons, tasks | Approved generation and validation | Production storage; ready content is immutable |
| Task evaluation material | Generated and checked evaluation configuration | Server-only storage; excluded from public projections |
| Enrollment and route | Enrollment and evidence-driven policy | Production database, isolated by learner and version |
| Attempts, hints, evidence, awards | Authorized learning operations | Transactional production records with deduplication |
| Run steps and events | Durable worker execution | Persisted before delivery; replay supports reconnect and recovery |
| Share grants | Explicit owner action | Hashed random bearer token scoped to a version; server-enforced revocation |

Production cannot use process memory, a JSON file, or temporary function storage as its shared database. A transactional external database is required. PostgreSQL is a candidate, not a selected provider. Required uniqueness includes course slug, version number per course, draft revision and digest approval, active enrollment policy, run event sequence, client attempt ID per learner, qualifying XP evidence and policy, and actor-operation-idempotency key.

## File Structure

The tree describes planned source ownership and public application files. A path in this tree is not evidence that it exists or has been tested. Generated dependencies and build output are omitted.

```text
project/
  package.json                 commands and pinned direct dependencies
  package-lock.json            reproducible dependency graph
  tsconfig.json                strict TypeScript configuration
  next.config.ts               application configuration
  next-env.d.ts                Next.js type entry
  eslint.config.mjs            source checks
  .env.example                 documented variable names without secrets
  README.md                    product, real capabilities, setup, and evidence
  devpost/
    scope.md                   product direction and boundaries
    prd.md                     user-visible requirements
    spec.md                    technical contracts
    checklist.md               build verification and review record
    app-map.html               generated later from finished source
  public/
    brand/                     original mark and wordmark assets
    art/landing/               original explanatory artwork
  src/
    app/
      layout.tsx               root document
      page.tsx                 English landing at /
      about/                   product information
      help/                    useful operating guidance
      privacy/                 actual data and access explanation
      explore/                 public catalog
      courses/[slug]/          accessible ready-course detail
      library/                 actual owned courses and enrollments
      chat/                    conversation, including ?conversation=<UUID>
      create/                  compatibility entry and legacy ?draft=<UUID>
      try/                     isolated playable activity
      learn/[enrollmentId]/    learner's own session
      s/[token]/               version-scoped shared course
      account/                 real identity lifecycle after integration
      sign-in/                 actual sign-in flow
      sign-up/                 actual account creation flow
      auth/                    identity callback handling
      api/v1/                  server route handlers for the HTTP contract
    domain/
      common.ts                IDs, revisions, language, and pagination
      course.ts                curriculum, approval, and course versions
      chat.ts                  local conversations, messages, artifact references
      generation.ts            conversations, agent turns, course jobs, typed events
      learning.ts              attempts, evidence, routes, and progress
      mechanics.ts             registered task contracts
      errors.ts                safe application errors
      index.ts                 canonical exports
    application/
      ports.ts                 operation-level interfaces
      local-adapter.ts         honest unavailable-service boundary
    lib/chats.ts               local chat persistence and legacy migration
    lib/drafts.ts              legacy request format retained for migration
    lib/routes.ts              unprefixed record-safe links
    components/
      ui/                      shared controls and feedback
      shell/                   navigation and common application structure
    styles/                    tokens, global rules, and motion primitives
    content/common.ts          shared English messages
    features/
      landing/                 hero, explanation sections, and messages
      catalog/                 collection and detail UI
      library/                 actual course and enrollment UI
      creator/                 chat history, composer, artifacts, reducer, transport
      learning/
        player/                session and feedback surfaces
        sample/                isolated trial content and local evaluation
        registry.ts            central React activity registry
        mechanics/             family schemas, renderers, and evaluators
    server/
      auth/                    chosen session integration
      db/                      chosen database connection and transaction boundary
      idempotency/             retry-safe mutation records
      storage/                 persistent record adapters
      catalog/                 public and library record queries
      enrollments/             version-scoped enrollment operations
      ai/                      chosen model adapter
      research/                real search, source reading, and provenance
      runs/                    durable execution and event recovery
      conversations/           saved chat mutations
      curricula/               typed curriculum edits and approval
      curriculum-research/     researched curriculum construction
      course-generation/       module and activity construction
      course-validation/       release validation
      course-materialization/  ready version persistence
      evaluation/              grading, evidence, and XP operations
      sharing/                 grants, visibility, and publication policy
      progression/             authoritative XP and levels
      publication/             catalog eligibility policy
      learning/                session and attempt operations
      adaptation/              evidence-grounded personal routes
      execution/               isolated execution boundary when configured
  migrations/                  production schema changes after provider selection
  scripts/check.mjs            consistent nonzero-on-failure checks
  tests/
    domain/                    invariants, projections, and revisions
    ui-contracts/              common interactions and routing
    catalog-ui/                actual course and enrollment collection states
    creator-ui/                chat persistence, migration, artifacts, event reducer
    learning-player/           submission, help, and isolated trial
    integration/               actual services, HTTP, access, and recovery
```

No source, build step, font, or runtime dependency may require undocumented files outside the repository. Fonts are installed from declared dependencies and are not copied into a committed font directory.

## External Services and Dependencies

### HTTP Rules

The API base is `/api/v1`. Successful JSON responses use `{data: ...}` except `204` responses; SSE uses its event framing. Private operations resolve an actor from the server session. A caller-supplied owner ID is never authority.

Non-idempotent mutations require a UUID `Idempotency-Key`. The same actor, operation, key, and body digest returns the original result; a different body with the same key returns `409`. Existing-object mutations use `expectedRevision`, checked inside the conditional update or transaction. Do not perform a separate read followed by an unconditional write.

Errors map to `400` invalid input, `401` unauthenticated, `403` forbidden, `404` not found, `409` revision or idempotency conflict, `429` rate limiting, `503` unavailable capability, and `502` generation or evaluation upstream failure. The browser receives a safe request ID and message key; provider diagnostics stay in protected server logs.

Lists use opaque cursors, deterministic secondary ID ordering, a default limit of 24, and a maximum of 60. The interface must not infer total counts from one page. Cancellation, sign-out, and deletion are mutations rather than GET operations.

### Planned Endpoints

| Operation | Payload | Success result |
| --- | --- | --- |
| `GET /courses?q=&cursor=&limit=` | Query parameters | `200 Page<CourseSummary>` for public ready versions |
| `GET /courses/:id` | None | `200 CourseDetailPublic` after access check |
| `GET /me/library?cursor=` | None | `200 Page<LibraryItem>` for the actor's owned courses and enrollments |
| `POST /conversations` | `{title?}` | `201 Conversation`; no course is created |
| `PATCH /conversations/:id` | `{expectedRevision,title?,activeBranchId?}` | `200 Conversation` |
| `DELETE /conversations/:id` | `{expectedRevision}` | `204`; active related runs cancel, courses are not implicitly deleted |
| `POST /conversations/:id/messages` | Stable request and message IDs, expected revision, branch/parent, text, supported attachments, optional user locale | `202 {message,run: AgentTurnRun}` only after capability validation; local delivery remains distinct |
| `GET /conversations/:id` | None | Conversation, messages, current runs, and referenced course artifacts with their own curricula |
| `GET /runs/:id` | None | `200 RunSnapshot`, including `retainedActionEvents` |
| `GET /runs/:id/events?after=` | SSE cursor | `200` persisted event stream for an authorized run and branch |
| `POST /runs/:id/cancel` | `{reason:'user'}` | `202 {run}`; idempotent |
| `POST /runs/:id/retry` | `{failedInvocationId?,expectedDraftRevision?}` | `202 {run}` reusing completed effects |
| `PATCH /curricula/:id` | `{expectedRevision,changes}` | `200 CurriculumDraft` with incremented revision and stale prior approval |
| `POST /curricula/:id/approve` | `{expectedRevision,contentDigest}` | `202 {approval,run: GenerationRun}` for the selected course's current revision only |
| `PATCH /courses/:id` | `{expectedRevision,title?,summary?,contentLanguage?}` | `200 Course` after an authorized metadata mutation; invalidates affected curriculum approval |
| `POST /courses/:id/enrollments` | `{courseVersionId}` | `201 Enrollment` or the existing active enrollment |
| `GET /enrollments/:id/session` | None | `200 {enrollment,route,lesson,task,progress}` in public projection |
| `POST /enrollments/:id/attempts` | `{taskId,taskVersion,response,clientAttemptId}` | `201 {attemptId,evaluation,route,progress}` or `202` for pending evaluation |
| `GET /attempts/:id/evaluation` | None | `200 Evaluation` for the attempt owner |
| `POST /enrollments/:id/hints` | `{taskId,taskVersion,hintIndex}` | `200 {hintId,content,assistance}` with persisted hint use |
| `PATCH /enrollments/:id` | `{expectedRouteRevision,currentLessonId?,status?}` | `200 Enrollment`, limited to accessible lesson IDs |
| `POST /courses/:id/shares` | `{courseVersionId}` | `201 {shareUrl,shareId}` for the owner |
| `DELETE /courses/:id/shares/:shareId` | None | `204` idempotent revocation |
| `PATCH /courses/:id/visibility` | `{expectedRevision,visibility,courseVersionId}` | `200 Course`; public access requires server eligibility and ready validation |
| `GET /shares/:token` | None | `200` version-scoped course detail without learner data |

Curriculum `changes` is a typed patch, not arbitrary JSON Patch:

```ts
{
  title?: string;
  goal?: string;
  audience?: string;
  assumedKnowledge?: string[];
  moduleOrder?: Id[];
  modules?: { id: Id; title?: string; summary?: string; outcomeIds?: Id[] }[];
  outcomes?: {
    id: Id; title?: string; demonstration?: string;
    prerequisiteOutcomeIds?: Id[];
  }[];
}
```

The `title` patch edits the current CurriculumDraft and participates in its approval digest. The course metadata operation and curriculum projection must remain consistent: a relevant title or language change produces a new unapproved curriculum revision rather than silently preserving stale approval. Summary edits target the actual course metadata. Deletion/addition and specialization edits need explicit typed operations before those controls are exposed. Natural-language curriculum edits use the same mutation service, bind to the selected course, draft ID, and revision, and produce a new unapproved revision. Approval is never hidden inside a normal chat response. These are planned HTTP operations; their live adapter and exact payload mapping require integration verification.

The foundation `LibraryItem` projection and `getPublicCourse(slug)` operation are defined above. Live HTTP integration must give that slug lookup a matching endpoint or explicit server lookup; `GET /courses/:id` must not silently treat a slug as a UUID. Course access also needs an authoritative projection `{canView,canEnroll,canEdit,canShare,canPublish,reason}` before owner controls are enabled.

Attachments require a real metadata, validated upload, finalization, and text-extraction path with purpose `course_context`, explicit formats, size limits, and retention behavior. Until this exists, there is no functional attachment control that merely displays a filename without using its content.

### Research and Model Ports

```ts
interface ModelPort {
  generateStructured<T>(request: StructuredRequest<T>, signal: AbortSignal): Promise<T>;
  streamText(request: TextRequest, signal: AbortSignal): AsyncIterable<{text: string}>;
}
interface ResearchPort {
  search(input: {
    query: string; language: ContentLanguage;
    domainHints?: string[]; freshness?: string;
  }, signal: AbortSignal): Promise<SearchHit[]>;
  read(input: {url: string}, signal: AbortSignal): Promise<SourceDocument>;
}
interface SourceDocument {
  id: Id; url: string; title: string; retrievedAt: IsoDateTime;
  publishedAt: IsoDateTime | null; excerpt: string; contentDigest: string;
}
interface SourceClaim {
  id: Id; sourceId: Id; claim: string; supportExcerpt: string;
  scope: string; outcomeIds: Id[];
}
```

`StructuredRequest`, `TextRequest`, and `SearchHit` are provider-neutral application schemas to finalize with the chosen integration, including output validation and resource limits. The public UI does not depend on provider names or SDK events.

Search and reading perform real requests. Source claims retain supporting passages and subject/version scope. Subject-appropriate primary material is preferred; recency alone is not evidence quality. Retrieved material is untrusted content and cannot change system permissions or tool authority. URL fetching must block private-network targets, recheck redirects, and bound bytes and time.

| Service | Current decision | Required integration record |
| --- | --- | --- |
| Model generation and evaluation | Provider and access pending | Exact endpoint/SDK, request and response schemas, authentication, structured-output behavior, streaming semantics, token limits, rate limits, and cost budget |
| Search and source retrieval | Provider and access pending | Search/read calls, returned provenance, fetch limits, authorized domains or source policies where relevant, rate limits, and costs |
| Production database | Transactional external store required; provider pending | Connection method, migrations, transaction behavior, indexes, backups/retention, limits, and cost |
| Identity | Provider pending | Session creation, verification, expiration, sign-out, account isolation, environment configuration, and costs |
| Durable execution | Runner pending | Dispatch, leases or equivalent ownership, retries, cancellation, recovery, concurrency, idempotency, and cost |
| Isolated code execution | Required only for activated execution tasks; service pending | Language/dialect, sandbox boundary, time/memory/network limits, request/result schema, authentication, and cost |
| Hosting | Vercel target | Environment, runtime major, function limits, durable-service connections, release checks, and publication arrangement |

Unselected providers have no fabricated endpoint, price, throughput, or successful-call claim. Provider-specific official documentation must be added when each selection is made.

### Durable Execution and Streaming on Vercel

Course generation is not held inside one unbounded HTTP request. Each completed step and its result reference are persisted. Job ownership must include `runId`, `stepId`, `attemptCount`, `leaseOwner`, `leaseExpiresAt`, and `fencingToken`, or an equivalent guarantee supplied by the chosen durable runner. An expired worker must not overwrite the result of a new owner.

Dispatch follows the database commit through a transactional outbox or an equivalent durable workflow handshake. A detached promise is not sufficient. A retry reuses idempotent completed effects. Cancellation prevents new work and invalidates inappropriate late results while preserving completed material.

Vercel's documented Fluid compute Hobby maximum is 300 seconds per function invocation. Stream waiting is still part of invocation duration. The architecture therefore decouples the event reader from long-running work instead of assuming that a stream or a background callback makes a durable job. The exact plan and configured limits must be rechecked before deployment. [Vercel duration limits](https://vercel.com/docs/functions/configuring-functions/duration), [function limits](https://vercel.com/docs/functions/limitations), [Next.js after](https://nextjs.org/docs/app/api-reference/functions/after).

## Important Failure Modes

| Failure | Required recovery and visible result |
| --- | --- |
| Provider absent, rate-limited, or unavailable before acceptance | Preserve the actual user message with failed or not-sent delivery, return the safe error, and retry with the same identity without a fabricated assistant, run, or course |
| Connection fails after partial output | Keep received text, end pending state on a terminal failure, and restore by snapshot/replay; no duplicate message or course |
| Worker stops or ownership expires | Recover persisted work through the durable runner; reject stale-worker writes and duplicate effects |
| Creator approves an old revision | Return `409` with the current revision; show the changed curriculum and start no generation |
| Generated task is ambiguous, unsupported, or invalid | Repair or withhold the version; do not turn a guessed answer into a validated course |
| Evaluation is slow or uncertain | Return pending/uncertain/unavailable distinctly, retain the attempt, and avoid unsupported XP or route changes |
| Browser storage fails | Preserve visible input and show failed local save rather than confirmed persistence |
| An older write completes during rapid chat switching | Keep writes bound to their conversation and ordered; never replace newer writing or another chat's visible input |
| A legacy import is retried or a deleted imported link is reopened | Reuse confirmed import state and respect deletion; never duplicate or resurrect the conversation |
| Course selection changes while a curriculum update arrives | Apply the revision to its own artifact; do not approve or overwrite another selected course |
| Access is absent or a share is revoked | Return the safe access result without private content; no client-only bypass |
| A repeated request arrives | Reuse the prior result for the same idempotency key and body, or reject a changed body with `409` |

These are implementation and integration requirements, not results already verified.

## What Was Simplified and Why

- One Next.js/React application contains the interface and server boundaries. A second frontend framework or generic interface generator would not add the intended learning capability.
- Foundation behavior uses local conversations and an isolated trial while service access is pending. This provides real behavior without pretending to implement shared accounts or course generation; the complete-service scope remains intact.
- The interface is English only following the product owner's clarification. Course content language remains independent, preserving the general learning use case.
- A registry of supported activities constrains generation. It allows each family to have a defensible interaction and evaluator instead of treating arbitrary generated code as safe learning content.
- Released content is immutable and learner adaptation is separate. This avoids silently changing the course while different people are studying it.
- Provider-specific services are not selected through placeholders. The relevant capability remains unavailable until its real adapter and operational constraints are established.

## Verification Approach

Mechanical checks establish behavior at the correct boundary. Domain checks cover graph validity, public projections, artifact-specific revision-bound approval, evidence isolation, route coverage, and idempotent awards. Chat-store checks cover automatic persistence, rapid switching and write ordering, reload, rename/delete, neighboring-record safety, failed writes, schema compatibility, preserved legacy metadata, repeat migration, and prevention of deleted-chat resurrection. Unavailable-send checks prove that an actual user message remains recoverable while no assistant, run, or course is created. Retry retains identity and edit creates a new identity. Fixtures exercise successful agent turns with zero, one, and several course artifacts; they verify that finishing a reply does not mark a course ready. Separate course-generation checks preserve the strong requirement for an actual course and saved version on success. Reducer checks cover delayed first output, duplicate events, gaps and replay, partial failure, cancellation, and late old-branch output. None of these fixtures establishes live creation.

Learning checks exercise valid alternatives, plausible wrong responses, unsupported configurations, help tracking, repeated submission, and uncertainty. For each activated mechanic, evaluation needs positive and negative cases appropriate to that learning action; merely checking the component renders is insufficient.

Live HTTP and service checks must use actual configured providers. They cover two actors, private read/write denial, real source retrieval, current-revision approval, validated generation, hosted event reconnection, worker recovery, one-time awards, separate routes for the same course, and revoked shares. Before keys and services are connected, local fixtures prove only the specific local contracts they exercise.

Visual review occurs at meaningful composed-interface and integration boundaries. Inspect representative landing, creator, collection, and player states at useful desktop and narrow sizes, plus motion playback and reduced motion. Record concrete observations about hierarchy, typography, spacing, clipping, contrast, focus, feedback, and the apparent next action separately from build results. Recheck the affected behavior after repair. User observations remain distinct from agent checks; neither an agent walkthrough nor a screenshot proves measured human comprehension or learning effectiveness.

The first deep course for integrated verification begins with AI foundations and continues into both model creation and AI-system development. It must be built through the engine, retain the approved depth, and expose real exercises. Additional authored courses then test the same engine beyond that single subject. No measured learning-gain claim is made by this specification.

## Decisions and Open Issues

The product owner selected the broad course service, individual experiences within a common course, deep AI with both continuation branches as the first course, Vercel as the hosting target, and an English-only interface. Foundation and design can proceed before model access. The retained slogan, cycling-topic hero, standalone chat with multiple course artifacts, automatic course metadata, and guidance at the trial controls follow the latest product direction.

The implementation proposes Next.js 16.4.3, React 19.3.1, Node 22, the Unfurl visual system, a typed activity registry, immutable released content, and enrollment-specific evidence. These choices organize the requested behavior; this draft does not attribute every implementation detail to the product owner.

The major engineering uncertainty is whether the eventual provider and execution stack can produce substantial, source-grounded, varied activities with useful evaluation and reliable continuation at an acceptable cost and latency. The required evidence is a real end-to-end course run, meaningful revisions, validated tasks, two learner routes, and deployed recovery checks. A local trial and typed event tests cannot resolve that uncertainty. No separate personal learning uncertainty has been established in this document.

Before real integration, resolve the service selections and upstream contracts in **Research and Model Ports**; activity-family schemas and evaluator criteria; evidence thresholds for adaptation; XP and publication policy; attachment scope; live slug lookup and access projection; typed curriculum addition/deletion and specialization operations; and production budget and release arrangement. The latter contract details must be resolved before exposing affected controls or live endpoints, rather than guessed independently by each feature.
