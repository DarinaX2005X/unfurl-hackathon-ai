import type { LearningPort, LearningContext, ActivityState, AttemptReceipt, AssessmentReviewInput, SupportRequest } from "@/application/learning-port";
import type { ServiceResult } from "@/application/ports";
import {
  canonicalResponseJson, sameInputIdentity, validateInputSnapshot,
  type ActionReceipt, type ActivityAction, type InputSnapshot,
} from "@/domain/activity";
import type { JsonValue } from "@/domain/common";
import type { ApiError } from "@/domain/errors";
import { LearningSessionSchema, type EvaluationReceipt, type LearningSession } from "@/domain/learning";
import type { SubmissionIssue } from "@/domain/mechanic-families/v2/shared";
import type { ProductionMechanicHandle } from "@/features/learning/registry";
import { cloneResponse, readRecovery, recoveryKey, type RecoveryCommand, type RecoveryRecord, type RecoveryStorage } from "./recovery";

type Scope = "load" | "start" | "save" | "action" | "submit" | "evaluation" | "advance" | "assistance" | "navigation" | "support" | "review" | "fresh";
export type LearningFailure = { scope: Scope; error: ApiError };
export interface LearningPlayerState {
  phase: "loading" | "ready" | "error";
  session: LearningSession | null;
  response: JsonValue | null;
  busy: Scope | null;
  saving: boolean;
  dirty: boolean;
  conflict: boolean;
  failure: LearningFailure | null;
  issues: SubmissionIssue[];
  online: boolean;
  recoveryAvailable: boolean;
  submissionUnconfirmed: boolean;
  actionUnconfirmed: boolean;
  context: LearningContext | null;
  contextLoading: boolean;
  contextError: boolean;
  commandUnconfirmed: boolean;
  routeMoved: boolean;
  transitionFeedback: EvaluationReceipt | null;
}

export type LearningControllerPort = Pick<LearningPort,
  "loadSession" | "startActivity" | "getActivity" | "saveInput" | "dispatchAction" | "retryAction" |
  "submitAttempt" | "getEvaluation" | "retryEvaluation" | "acknowledgeFeedback" | "advance" | "loadContext" |
  "requestHint" | "revealAnswer" | "revisit" | "requestSupport" | "respondToSupport" | "returnFromSupport" | "requestReview" | "retryReview" | "requestFreshAssessment">;
type MechanicResolver = (id: string, version: number) => ProductionMechanicHandle | null;

const initialState: LearningPlayerState = {
  phase: "loading", session: null, response: null, busy: null, saving: false,
  dirty: false, conflict: false, failure: null, issues: [], online: true,
  recoveryAvailable: true, submissionUnconfirmed: false, actionUnconfirmed: false,
  context: null, contextLoading: false, contextError: false, commandUnconfirmed: false,
  routeMoved: false, transitionFeedback: null,
};
const sameResponse = (a: JsonValue | null, b: JsonValue | null) => canonicalResponseJson(a) === canonicalResponseJson(b);
const positionKey = (session: LearningSession | null) => session ?
  `${session.enrollment.courseVersionId}:${session.lesson?.id ?? "end"}:${session.task?.id ?? "reading"}:${session.task?.taskVersion ?? 0}` : "";

function localError(code: ApiError["error"]["code"], key: string, retryable = false): ApiError {
  return { error: { code, messageKey: key, retryable, requestId: crypto.randomUUID() } };
}
function unavailable(): ApiError { return localError("service_unavailable", "learning.unavailable", true); }

/**
 * Serializes mutations against immutable input snapshots. Editing is independent of
 * requests: a late save/action/evaluation may update history but never replace a draft.
 */
export class LearningSessionController {
  private state: LearningPlayerState = initialState;
  private listeners = new Set<() => void>();
  private abort = new AbortController();
  private epoch = 0;
  private loadEpoch = 0;
  private contextEpoch = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private record: RecoveryRecord | null = null;
  private recordKey: string | null = null;
  private submissionLock = false;
  private navigationLock = false;
  private actionLock = false;
  private polling = false;
  private freshAssessmentLock = false;
  private disposed = false;
  private leases = 0;

  constructor(
    readonly actorId: string,
    readonly enrollmentId: string,
    private port: LearningControllerPort,
    private resolveMechanic: MechanicResolver,
    private storage: RecoveryStorage | null = null,
    private createId: () => string = () => crypto.randomUUID(),
  ) {}

  getSnapshot = (): LearningPlayerState => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  /** React's development effect replay must not destroy an otherwise live session. */
  retain(): () => void {
    this.leases += 1;
    return () => { this.leases -= 1; queueMicrotask(() => { if (this.leases === 0) this.dispose(); }); };
  }
  private update(patch: Partial<LearningPlayerState>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  private fail(scope: Scope, error: ApiError) {
    this.update({ failure: { scope, error }, ...(scope === "load" && !this.state.session ? { phase: "error" as const } : {}) });
  }
  private current(epoch: number, position?: string): boolean {
    return !this.disposed && epoch === this.epoch && (position === undefined || position === positionKey(this.state.session));
  }
  private async call<T>(operation: () => Promise<ServiceResult<T>>): Promise<ServiceResult<T>> {
    if (!this.state.online || this.disposed) return { ok: false, error: unavailable() };
    try { return await operation(); }
    catch { return { ok: false, error: unavailable() }; }
  }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.queue.then(operation, operation);
    this.queue = task.catch(() => {});
    return task;
  }
  private persist() {
    if (!this.record || !this.recordKey) return;
    this.record.response = this.state.response === null ? null : cloneResponse(this.state.response);
    if (!this.storage) { this.update({ recoveryAvailable: false }); return; }
    try { this.storage.setItem(this.recordKey, JSON.stringify(this.record)); this.update({ recoveryAvailable: true }); }
    catch { this.update({ recoveryAvailable: false }); }
  }
  private mechanic() {
    const task = this.state.session?.task;
    return task ? this.resolveMechanic(task.mechanicId, task.mechanicVersion) : null;
  }
  private async validActivity(state: ActivityState): Promise<boolean> {
    const session = this.state.session;
    if (!session?.task || state.activity.enrollmentId !== this.enrollmentId ||
      state.activity.taskId !== session.task.id || state.activity.taskVersion !== session.task.taskVersion) return false;
    if (state.savedInput) {
      try { await validateInputSnapshot(state.savedInput); }
      catch { return false; }
    }
    return true;
  }
  private applyActivity(incoming: ActivityState) {
    const session = this.state.session;
    if (!session || incoming.activity.taskId !== session.task?.id || incoming.activity.enrollmentId !== this.enrollmentId) return;
    const previous = session.activity;
    const newerInput = incoming.activity.inputRevision >= (previous?.inputRevision ?? 0);
    const newerActivity = incoming.activity.revision >= (previous?.revision ?? 0);
    if (!newerInput && !newerActivity) return;
    let activity = newerActivity ? incoming.activity : previous!;
    // A completed observation cannot regress when a slower poll returns pending.
    if (previous && newerActivity) activity = { ...activity, events: activity.events.map((event) => {
      const old = previous.events.find((item) => item.id === event.id);
      return old?.receipt.status === "completed" && event.receipt.status !== "completed" ? old : event;
    }) };
    const savedInput = newerInput ? incoming.savedInput : session.savedInput;
    activity = { ...activity, inputRevision: Math.max(activity.inputRevision, previous?.inputRevision ?? 0) };
    const dirty = this.state.response !== null && !sameResponse(this.state.response, savedInput?.response ?? null);
    this.update({ session: { ...session, activity, savedInput }, dirty });
  }

  async load(): Promise<void> {
    const request = ++this.loadEpoch;
    const epoch = this.epoch;
    if (!this.state.session) this.update({ phase: "loading", failure: null });
    const result = await this.call(() => this.port.loadSession(this.enrollmentId, this.abort.signal));
    if (!this.current(epoch) || request !== this.loadEpoch) return;
    if (!result.ok) { this.fail("load", result.error); return; }
    if (result.data.enrollment.id !== this.enrollmentId || result.data.enrollment.learnerId !== this.actorId) {
      this.update({ phase: "error", session: null, response: null });
      this.fail("load", localError("forbidden", "learning.accessDenied")); return;
    }
    await this.acceptSession(result.data);
  }

  private async acceptSession(session: LearningSession): Promise<void> {
    if (session.enrollment.id !== this.enrollmentId || session.enrollment.learnerId !== this.actorId) {
      this.update({ phase: "error", session: null, response: null }); this.fail("load", localError("forbidden", "learning.accessDenied")); return;
    }
    if (session.savedInput) {
      try { await validateInputSnapshot(session.savedInput); }
      catch { this.fail("load", unavailable()); return; }
    }
    if (this.disposed) return;
    const samePosition = positionKey(this.state.session) === positionKey(session);
    if (this.state.session && session.route.revision < this.state.session.route.revision) return;
    if (!samePosition) {
      this.epoch += 1;
      this.recordKey = recoveryKey(this.actorId, this.enrollmentId, session.lesson?.id ?? "end", session.task?.id ?? null);
      const recovered = this.recordKey ? readRecovery(this.storage, this.recordKey) : null;
      this.record = recovered?.actorId === this.actorId && recovered.enrollmentId === this.enrollmentId &&
        recovered.taskVersion === (session.task?.taskVersion ?? null) ? recovered : {
          version: 1, actorId: this.actorId, enrollmentId: this.enrollmentId, lessonId: session.lesson?.id ?? null,
          taskId: session.task?.id ?? null, taskVersion: session.task?.taskVersion ?? null,
          response: null, baseInputRevision: session.activity?.inputRevision ?? 0, startKey: this.createId(),
          save: null, action: null, attempt: null, acknowledgement: null, advance: null, command: null,
        };
    }
    const task = session.task;
    const handle = task ? this.resolveMechanic(task.mechanicId, task.mechanicVersion) : null;
    let response: JsonValue | null = null;
    let conflict = false;
    if (task && handle) {
      try {
        handle.parseTask(task);
        response = handle.parseResponse(session.savedInput?.response ?? handle.createInitialResponse(task.config));
        const draft = samePosition ? this.state.response : this.record?.response;
        if (draft !== null && draft !== undefined) {
          response = handle.parseResponse(draft);
          conflict = !sameResponse(response, session.savedInput?.response ?? null) &&
            (this.record?.baseInputRevision ?? 0) !== (session.activity?.inputRevision ?? 0) && !this.record?.save;
        }
      } catch { response = null; }
    }
    const previous = this.state.session;
    const transitionFeedback = !samePosition && previous?.support?.status === "accepted" && previous.evaluation && ["evaluated", "uncertain"].includes(previous.evaluation.evaluation.status) ? previous.evaluation : null;
    this.update({ phase: "ready", session, response, busy: null, saving: false, conflict, routeMoved: false,
      transitionFeedback: transitionFeedback ?? this.state.transitionFeedback,
      dirty: response !== null && !sameResponse(response, session.savedInput?.response ?? null),
      failure: conflict ? { scope: "save", error: localError("revision_conflict", "learning.inputChanged") } : null,
      issues: [], submissionUnconfirmed: Boolean(this.record?.attempt && !this.record.attempt.accepted),
      actionUnconfirmed: Boolean(this.record?.action),
      commandUnconfirmed: Boolean(this.record?.command),
      ...(!samePosition || this.state.context?.routeRevision !== session.route.revision ? { context: null } : {}),
    });
    if (this.record && !this.state.dirty) this.record.baseInputRevision = session.activity?.inputRevision ?? 0;
    this.persist();
    this.schedulePoll();
    void this.loadContext();
  }

  async loadContext(more = false): Promise<void> {
    const session = this.state.session;
    if (!session || this.disposed) return;
    const cursor = more ? this.state.context?.outlineNextCursor : undefined;
    if (more && !cursor) return;
    const request = ++this.contextEpoch, epoch = this.epoch;
    this.update({ contextLoading: true, contextError: false });
    const result = await this.call(() => this.port.loadContext(this.enrollmentId, cursor ? { cursor } : {}, this.abort.signal));
    if (!this.current(epoch) || request !== this.contextEpoch) return;
    this.update({ contextLoading: false });
    if (!result.ok || result.data.enrollmentId !== this.enrollmentId || result.data.routeRevision !== this.state.session?.route.revision || result.data.course.versionId !== this.state.session.enrollment.courseVersionId) {
      this.update({ contextError: true }); return;
    }
    const previous = this.state.context;
    if (more && previous?.routeRevision !== result.data.routeRevision) { this.update({ contextError: true }); return; }
    this.update({ context: { ...result.data, outline: more && previous ? [...previous.outline, ...result.data.outline.filter((item) => !previous.outline.some((old) => old.lessonId === item.lessonId))] : result.data.outline } });
  }

  private async command(command: RecoveryCommand, scope: Scope): Promise<void> {
    await this.serialize(async () => {
      const record = this.record;
      if (!record || this.state.busy || this.state.conflict || this.state.submissionUnconfirmed || this.state.actionUnconfirmed) return;
      if (record.command && record.command.key !== command.key) return;
      const epoch = this.epoch;
      if (["revisit", "support_response", "support_return"].includes(command.kind) && this.state.dirty && this.state.response !== null && this.state.session?.activity) {
        if (!await this.ensureSaved(cloneResponse(this.state.response))) return;
      }
      record.command = command; this.update({ busy: scope, failure: null, commandUnconfirmed: true }); this.persist();
      const options = { idempotencyKey: command.key, signal: this.abort.signal };
      const result = await this.call<unknown>(() => {
        switch (command.kind) {
          case "hint": return this.port.requestHint(this.enrollmentId, command.body, options);
          case "reveal": return this.port.revealAnswer(this.enrollmentId, command.body, options);
          case "revisit": return this.port.revisit(this.enrollmentId, command.body, options);
          case "fresh_assessment": return this.port.requestFreshAssessment(this.enrollmentId, command.body, options);
          case "support": return this.port.requestSupport(this.enrollmentId, command.body, options);
          case "support_response": return this.port.respondToSupport(this.enrollmentId, command.target, command.body, options);
          case "support_return": return this.port.returnFromSupport(this.enrollmentId, command.target, command.body, options);
          case "review": return this.port.requestReview(command.target, command.body, options);
          case "review_retry": return this.port.retryReview(command.target, command.reviewId, command.body, options);
          case "evaluation_retry": return this.port.retryEvaluation(command.target, command.body, options);
          case "action_retry": return this.port.retryAction(command.target, command.receiptId, command.body, options);
        }
      });
      if (!this.current(epoch)) return;
      this.update({ busy: null });
      if (!result.ok) {
        if (!result.error.error.retryable || ["invalid_input", "revision_conflict", "forbidden", "not_found"].includes(result.error.error.code)) { record.command = null; this.update({ commandUnconfirmed: false }); this.persist(); }
        this.fail(scope, result.error);
        if (command.kind === "fresh_assessment" && !this.state.commandUnconfirmed) void this.loadContext();
        return;
      }
      const freshSession = command.kind === "fresh_assessment" ? LearningSessionSchema.safeParse(result.data) : null;
      if (freshSession && !freshSession.success) { this.fail(scope, unavailable()); return; }
      record.command = null; this.update({ commandUnconfirmed: false }); this.persist();
      if (freshSession?.success) await this.acceptSession(freshSession.data);
      else await this.load();
    });
  }

  async retryCommand(): Promise<void> {
    const command = this.record?.command;
    if (command) await this.command(command, command.kind === "hint" || command.kind === "reveal" ? "assistance" :
      command.kind === "review" || command.kind === "review_retry" ? "review" : command.kind === "evaluation_retry" ? "evaluation" :
        command.kind === "action_retry" ? "action" : command.kind === "revisit" ? "navigation" : command.kind === "fresh_assessment" ? "fresh" : "support");
  }
  async requestFreshAssessment(): Promise<void> {
    if (this.freshAssessmentLock) return;
    this.freshAssessmentLock = true;
    try {
      if (this.record?.command?.kind === "fresh_assessment") { await this.retryCommand(); return; }
      const session = this.state.session, context = this.state.context;
      if (!session || !context || context.routeRevision !== session.route.revision || context.freshAssessment.availability !== "available" ||
        this.state.contextLoading || this.state.commandUnconfirmed || this.state.routeMoved) return;
      await this.command({ kind: "fresh_assessment", key: this.createId(), body: { expectedRouteRevision: session.route.revision } }, "fresh");
    } finally { this.freshAssessmentLock = false; }
  }
  async hint(): Promise<void> {
    const task = this.state.session?.task, assistance = this.state.context?.assistance;
    if (!task || this.state.commandUnconfirmed) return;
    const hintIndex = assistance?.hints.length ?? 0;
    if (hintIndex >= task.availableHints) return;
    await this.command({ kind: "hint", key: this.createId(), body: { taskId: task.id, taskVersion: task.taskVersion, hintIndex } }, "assistance");
  }
  async reveal(): Promise<void> {
    const task = this.state.session?.task;
    if (task) await this.command({ kind: "reveal", key: this.createId(), body: { taskId: task.id, taskVersion: task.taskVersion } }, "assistance");
  }
  async revisit(lessonId: string, taskId: string | null): Promise<void> {
    const context = this.state.context, session = this.state.session;
    if (!session || !context || context.revisitBlockedReason || !context.outline.some((lesson) => lesson.lessonId === lessonId && lesson.positions.some((position) => position.taskId === taskId && position.revisitable))) return;
    await this.command({ kind: "revisit", key: this.createId(), body: { lessonId, taskId, expectedRouteRevision: session.route.revision } }, "navigation");
  }
  async requestSupport(targetOutcomeId: string, kind: SupportRequest["kind"]): Promise<void> {
    const session = this.state.session;
    if (session?.route.next[0]?.reasonCode === "course_sequence") await this.command({ kind: "support", key: this.createId(), body: { targetOutcomeId, kind, expectedRouteRevision: session.route.revision } }, "support");
  }
  async respondSupport(response: "accept" | "decline"): Promise<void> {
    const session = this.state.session;
    if (session?.support) await this.command({ kind: "support_response", key: this.createId(), target: session.support.id, body: { response, expectedRouteRevision: session.route.revision } }, "support");
  }
  async returnSupport(): Promise<void> {
    const session = this.state.session;
    if (session?.support) await this.command({ kind: "support_return", key: this.createId(), target: session.support.id, body: { expectedRouteRevision: session.route.revision } }, "support");
  }
  async review(reason: AssessmentReviewInput["reason"], comment: string): Promise<void> {
    const receipt = this.state.session?.evaluation;
    if (receipt) await this.command({ kind: "review", key: this.createId(), target: receipt.evaluation.attemptId, body: { reason, comment, expectedEvaluationRevision: receipt.revision } }, "review");
  }
  async retryReview(): Promise<void> {
    const receipt = this.state.session?.evaluation;
    if (receipt?.review) await this.command({ kind: "review_retry", key: this.createId(), target: receipt.evaluation.attemptId, reviewId: receipt.review.id, body: { expectedEvaluationRevision: receipt.revision } }, "review");
  }

  setResponse = (value: JsonValue): void => {
    if (this.disposed || this.state.phase !== "ready" || !this.state.session?.activity || this.state.routeMoved) return;
    let response: JsonValue;
    try { response = cloneResponse(this.mechanic()!.parseResponse(value)); }
    catch { this.fail("save", localError("invalid_input", "learning.invalidResponse")); return; }
    if (sameResponse(response, this.state.response)) return;
    const dirty = !sameResponse(response, this.state.session.savedInput?.response ?? null);
    this.update({ response, dirty, issues: [] });
    this.persist();
    this.scheduleSave();
  };

  setOnline(online: boolean) {
    this.update({ online });
    if (online) { this.schedulePoll(); this.scheduleSave(); }
  }

  private scheduleSave() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    if (!this.state.dirty || this.state.conflict || this.state.failure || !this.state.online || this.state.routeMoved || this.state.actionUnconfirmed || this.state.submissionUnconfirmed || this.state.commandUnconfirmed) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; void this.save(); }, 600);
  }

  async start(): Promise<boolean> {
    return this.serialize(async () => {
      const session = this.state.session, record = this.record;
      if (!session?.task || !record || this.state.busy || this.state.commandUnconfirmed || this.disposed) return false;
      if (session.activity) return true;
      const epoch = this.epoch;
      this.update({ busy: "start", failure: null }); this.persist();
      const result = await this.call(() => this.port.startActivity(this.enrollmentId,
        { taskId: session.task!.id, taskVersion: session.task!.taskVersion },
        { idempotencyKey: record.startKey, signal: this.abort.signal }));
      if (!this.current(epoch)) return false;
      this.update({ busy: null });
      if (!result.ok) { this.fail("start", result.error); return false; }
      if (!await this.validActivity(result.data)) { this.fail("start", unavailable()); return false; }
      this.applyActivity(result.data);
      if (result.data.savedInput) {
        this.update({ response: this.mechanic()!.parseResponse(result.data.savedInput.response), dirty: false });
      }
      record.baseInputRevision = result.data.activity.inputRevision;
      this.persist(); this.scheduleSave(); return true;
    });
  }

  async save(): Promise<boolean> {
    return this.serialize(async () => {
      const response = this.state.response;
      if (response === null || this.state.conflict || this.state.actionUnconfirmed || this.state.submissionUnconfirmed || this.state.commandUnconfirmed) return false;
      return (await this.ensureSaved(cloneResponse(response))) !== null;
    });
  }

  private async ensureSaved(response: JsonValue): Promise<InputSnapshot | null> {
    const session = this.state.session, record = this.record;
    if (!session?.activity || !record || this.state.conflict) return null;
    const epoch = this.epoch;
    if (!record.save && session.savedInput && sameResponse(response, session.savedInput.response)) return session.savedInput;
    // Replay an uncertain save before issuing a newer CAS, using precisely its original body.
    const pending = record.save ?? { key: this.createId(), activityId: session.activity.id,
      body: { expectedInputRevision: session.activity.inputRevision, response: cloneResponse(response) } };
    record.save = pending;
    this.update({ saving: true, failure: null }); this.persist();
    const result = await this.call(() => this.port.saveInput(pending.activityId, pending.body,
      { idempotencyKey: pending.key, signal: this.abort.signal }));
    if (!this.current(epoch)) return null;
    this.update({ saving: false });
    if (!result.ok) {
      if (result.error.error.code === "revision_conflict") this.update({ conflict: true });
      if (result.error.error.code === "invalid_input") { record.save = null; this.persist(); }
      this.fail("save", result.error); return null;
    }
    if (!await this.validActivity(result.data)) { this.fail("save", unavailable()); return null; }
    this.applyActivity(result.data);
    const saved = result.data.savedInput;
    record.save = null;
    if (!saved || !sameResponse(saved.response, pending.body.response)) {
      this.update({ conflict: true }); this.fail("save", localError("revision_conflict", "learning.inputChanged")); this.persist(); return null;
    }
    record.baseInputRevision = saved.inputRevision;
    this.persist();
    if (!sameResponse(saved.response, response)) return this.ensureSaved(response);
    this.scheduleSave();
    return saved;
  }

  /** A conflict always requires a visible choice before overwriting the server copy. */
  async resolveConflict(choice: "saved" | "mine"): Promise<void> {
    await this.serialize(async () => {
      const activityId = this.state.session?.activity?.id;
      if (!activityId || !this.record) return;
      const epoch = this.epoch;
      const result = await this.call(() => this.port.getActivity(activityId, this.abort.signal));
      if (!this.current(epoch)) return;
      if (!result.ok) { this.fail("save", result.error); return; }
      if (!await this.validActivity(result.data)) { this.fail("save", unavailable()); return; }
      this.applyActivity(result.data);
      this.record.save = null;
      this.record.baseInputRevision = result.data.activity.inputRevision;
      if (choice === "saved") this.update({ response: result.data.savedInput?.response ??
        this.mechanic()?.createInitialResponse(this.state.session!.task!.config) ?? null, dirty: false });
      this.update({ conflict: false, failure: null }); this.persist();
      if (choice === "mine" && this.state.response !== null) await this.ensureSaved(cloneResponse(this.state.response));
    });
  }

  async dispatch(action: ActivityAction): Promise<ServiceResult<ActionReceipt>> {
    if (this.actionLock) return { ok: false, error: localError("revision_conflict", "learning.actionPending", true) };
    this.actionLock = true;
    const captured = this.state.response === null ? null : cloneResponse(this.state.response);
    try {
      return await this.serialize(async () => {
        const record = this.record, session = this.state.session;
        if (!record || !session?.activity || captured === null || this.state.conflict || this.state.submissionUnconfirmed || this.state.commandUnconfirmed) return { ok: false, error: unavailable() };
        const epoch = this.epoch;
        this.update({ busy: "action", failure: null });
        let pending = record.action;
        if (pending && canonicalResponseJson(pending.body.action) !== canonicalResponseJson(action)) {
          this.update({ busy: null }); const error = localError("revision_conflict", "learning.actionUnconfirmed", true); this.fail("action", error); return { ok: false, error };
        }
        if (!pending) {
          const saved = await this.ensureSaved(captured);
          if (!saved || !this.current(epoch)) { this.update({ busy: null }); return { ok: false, error: this.state.failure?.error ?? unavailable() }; }
          pending = { key: this.createId(), activityId: saved.activitySessionId,
            body: { expectedRevision: this.state.session!.activity!.revision, clientActionId: this.createId(),
              inputRevision: saved.inputRevision, responseDigest: saved.responseDigest, action } };
          record.action = pending;
        }
        this.update({ actionUnconfirmed: true }); this.persist();
        const request = pending;
        const result = await this.call(() => this.port.dispatchAction(request.activityId, request.body,
          { idempotencyKey: request.key, signal: this.abort.signal }));
        if (!this.current(epoch)) return { ok: false, error: unavailable() };
        this.update({ busy: null });
        if (!result.ok) {
          if (["invalid_input", "revision_conflict"].includes(result.error.error.code)) {
            record.action = null; this.update({ actionUnconfirmed: false }); this.persist();
          }
          this.fail("action", result.error); return result;
        }
        if (!await this.validActivity(result.data) || result.data.receipt.clientActionId !== request.body.clientActionId) {
          const error = unavailable(); this.fail("action", error); return { ok: false, error };
        }
        this.applyActivity(result.data);
        record.action = null; this.update({ actionUnconfirmed: false }); this.persist(); this.scheduleSave(); this.schedulePoll();
        return { ok: true, data: result.data.receipt };
      });
    } finally { this.actionLock = false; }
  }

  async retryAction(receiptId: string): Promise<ServiceResult<ActionReceipt>> {
    return this.serialize(async () => {
      const activity = this.state.session?.activity;
      const receipt = activity?.events.find((event) => event.receipt.id === receiptId)?.receipt;
      if (!activity || !receipt || this.state.busy) return { ok: false, error: unavailable() };
      if (receipt.status === "completed") return { ok: true, data: receipt };
      const record = this.record;
      if (!record || (record.command && (record.command.kind !== "action_retry" || record.command.receiptId !== receiptId))) return { ok: false, error: unavailable() };
      const command = record.command ?? { kind: "action_retry" as const, key: this.createId(), target: activity.id, receiptId, body: { expectedRevision: activity.revision } };
      record.command = command; this.update({ commandUnconfirmed: true }); this.persist();
      const epoch = this.epoch;
      this.update({ busy: "action", failure: null });
      const result = await this.call(() => this.port.retryAction(command.target, command.receiptId, command.body,
        { idempotencyKey: command.key, signal: this.abort.signal }));
      if (!this.current(epoch)) return { ok: false, error: unavailable() };
      this.update({ busy: null });
      if (!result.ok) { this.fail("action", result.error); return result; }
      if (!await this.validActivity(result.data)) return { ok: false, error: unavailable() };
      record.command = null; this.update({ commandUnconfirmed: false }); this.persist();
      this.applyActivity(result.data); this.schedulePoll();
      return { ok: true, data: result.data.receipt };
    });
  }

  async retryUnconfirmedAction(): Promise<void> {
    if (this.record?.action) await this.dispatch(this.record.action.body.action);
  }

  async submit(): Promise<void> {
    if (this.submissionLock) return;
    this.submissionLock = true;
    const captured = this.state.response === null ? null : cloneResponse(this.state.response);
    try {
      await this.serialize(async () => {
        const session = this.state.session, record = this.record, handle = this.mechanic();
        if (!session?.task || !session.activity || !record || !handle || captured === null || this.state.conflict || this.state.actionUnconfirmed || this.state.commandUnconfirmed) return;
        const epoch = this.epoch;
        let pending = record.attempt && !record.attempt.accepted ? record.attempt : null;
        if (!pending) {
          const issues = handle.validateSubmission(session.task.config, captured);
          if (issues.length) { this.update({ issues }); return; }
        }
        this.update({ busy: "submit", failure: null, issues: [] });
        if (!pending) {
          const saved = await this.ensureSaved(captured);
          if (!saved || !this.current(epoch)) { this.update({ busy: null }); return; }
          if (session.evaluation && sameInputIdentity(session.evaluation.submittedInput, saved)) { this.update({ busy: null }); return; }
          pending = record.attempt && sameInputIdentity(record.attempt.body, saved) ? record.attempt : {
            key: this.createId(), body: { ...saved, taskId: session.task.id, taskVersion: session.task.taskVersion, clientAttemptId: this.createId() }, accepted: false,
          };
          record.attempt = pending;
        }
        this.update({ submissionUnconfirmed: true }); this.persist();
        const request = pending;
        const result = await this.call(() => this.port.submitAttempt(this.enrollmentId, request.body,
          { idempotencyKey: request.key, signal: this.abort.signal }));
        if (!this.current(epoch)) return;
        this.update({ busy: null });
        if (!result.ok) {
          if (["invalid_input", "revision_conflict"].includes(result.error.error.code)) {
            record.attempt = null; this.update({ submissionUnconfirmed: false }); this.persist();
            if (result.error.error.code === "revision_conflict") this.update({ conflict: true });
          }
          this.fail("submit", result.error); return;
        }
        if (!sameInputIdentity(result.data.evaluation.submittedInput, request.body)) { this.fail("submit", unavailable()); return; }
        request.accepted = true;
        this.applyAttempt(result.data);
        this.update({ submissionUnconfirmed: false }); this.persist(); this.scheduleSave(); this.schedulePoll();
      });
    } finally { this.submissionLock = false; }
  }

  private applyAttempt(receipt: AttemptReceipt) {
    const session = this.state.session;
    if (!session || receipt.route.enrollmentId !== this.enrollmentId) return;
    const first = receipt.route.next[0];
    const routeMoved = receipt.route.revision >= session.route.revision && (first?.lessonId !== session.lesson?.id || (first?.taskId ?? null) !== (session.task?.id ?? null));
    this.update({ routeMoved, session: { ...session, evaluation: receipt.evaluation,
      ...(receipt.route.revision >= session.route.revision ? { route: receipt.route,
        enrollment: { ...session.enrollment, routeRevision: receipt.route.revision }, progress: receipt.progress, support: receipt.support } : {}),
    } });
    if (receipt.route.revision !== this.state.context?.routeRevision) this.update({ context: null });
    if (!routeMoved) void this.loadContext();
  }

  async retryEvaluation(): Promise<void> {
    const receipt = this.state.session?.evaluation;
    if (this.record?.command?.kind === "evaluation_retry") { await this.retryCommand(); return; }
    if (receipt) await this.command({ kind: "evaluation_retry", key: this.createId(), target: receipt.evaluation.attemptId, body: { expectedEvaluationRevision: receipt.revision } }, "evaluation");
  }

  private applyEvaluation(receipt: EvaluationReceipt) {
    const session = this.state.session;
    if (!session?.evaluation || session.evaluation.evaluation.attemptId !== receipt.evaluation.attemptId ||
      receipt.revision < session.evaluation.revision) return;
    this.update({ session: { ...session, evaluation: receipt } });
  }

  hasCurrentEvaluation(): boolean {
    const session = this.state.session;
    return Boolean(session?.evaluation && session.savedInput && !this.state.dirty &&
      sameInputIdentity(session.evaluation.submittedInput, session.savedInput));
  }

  async advance(): Promise<void> {
    if (this.navigationLock) return;
    this.navigationLock = true;
    try {
      await this.serialize(async () => {
        const session = this.state.session, record = this.record;
        if (!session || !record || this.state.conflict || this.state.submissionUnconfirmed || this.state.actionUnconfirmed || this.state.commandUnconfirmed) return;
        if (session.task && !this.state.routeMoved && (!this.hasCurrentEvaluation() || !session.evaluation || !["evaluated", "uncertain"].includes(session.evaluation.evaluation.status))) return;
        const epoch = this.epoch;
        this.update({ busy: "advance", failure: null });
        if (session.evaluation && !record.advance) {
          const receipt = session.evaluation;
          const acknowledgement = record.acknowledgement?.attemptId === receipt.evaluation.attemptId && record.acknowledgement.revision === receipt.revision ?
            record.acknowledgement : { key: this.createId(), attemptId: receipt.evaluation.attemptId, revision: receipt.revision };
          record.acknowledgement = acknowledgement; this.persist();
          const result = await this.call(() => this.port.acknowledgeFeedback(acknowledgement.attemptId,
            { expectedEvaluationRevision: acknowledgement.revision }, { idempotencyKey: acknowledgement.key, signal: this.abort.signal }));
          if (!this.current(epoch)) return;
          if (!result.ok) { this.update({ busy: null }); this.fail("advance", result.error); return; }
        }
        if (this.state.routeMoved) { await this.load(); return; }
        record.advance ??= { key: this.createId(), revision: this.state.session!.route.revision };
        const request = record.advance; this.persist();
        const result = await this.call(() => this.port.advance(this.enrollmentId, { expectedRouteRevision: request.revision },
          { idempotencyKey: request.key, signal: this.abort.signal }));
        if (!this.current(epoch)) return;
        this.update({ busy: null });
        if (!result.ok) { this.fail("advance", result.error); return; }
        record.advance = null; this.persist();
        await this.acceptSession(result.data);
      });
    } finally { this.navigationLock = false; }
  }

  async poll(): Promise<void> {
    if (this.polling || this.disposed || !this.state.online || this.state.busy || this.state.saving) return;
    this.polling = true;
    const session = this.state.session, epoch = this.epoch;
    try {
      if (session?.activity?.events.some((event) => event.receipt.status === "pending")) {
        const result = await this.call(() => this.port.getActivity(session.activity!.id, this.abort.signal));
        if (!this.current(epoch)) return;
        if (result.ok && await this.validActivity(result.data)) this.applyActivity(result.data);
        else if (!result.ok) this.fail("action", result.error);
      }
      if (session?.evaluation?.evaluation.status === "pending" || session?.evaluation?.review?.status === "running" || session?.evaluation?.review?.status === "queued") {
        const result = await this.call(() => this.port.getEvaluation(session!.evaluation!.evaluation.attemptId, this.abort.signal));
        if (!this.current(epoch)) return;
        if (result.ok) {
          this.applyEvaluation(result.data);
          if (result.data.evaluation.status !== "pending" && !["queued", "running"].includes(result.data.review?.status ?? "")) await this.load();
        } else this.fail("evaluation", result.error);
      }
    } finally { this.polling = false; this.schedulePoll(); }
  }

  private schedulePoll() {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.disposed || !this.state.online || this.state.failure) return;
    const session = this.state.session;
    const pending = session?.activity?.events.some((event) => event.receipt.status === "pending") ||
      session?.evaluation?.evaluation.status === "pending" || ["queued", "running"].includes(session?.evaluation?.review?.status ?? "");
    if (pending) this.pollTimer = setTimeout(() => { this.pollTimer = null; void this.poll(); }, 1800);
  }

  async refreshStatus(): Promise<void> { this.update({ failure: null }); await this.poll(); }
  dismissTransitionFeedback(): void { this.update({ transitionFeedback: null }); }

  dispose(): void {
    if (this.disposed) return;
    this.persist(); this.disposed = true; this.abort.abort(); this.epoch += 1;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.listeners.clear();
  }
}
