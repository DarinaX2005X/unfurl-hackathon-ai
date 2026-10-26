import type { ConversationPort } from "@/application/conversation-port";
import type { ConversationBuild, ConversationDetail } from "@/domain/conversations";
import { GenerationHistoryPageSchema, type GenerationEvent, type GenerationHistoryPage, type GenerationSnapshot, type GenerationTimelineEvent } from "@/domain/generation-observer";
import { IdSchema } from "@/domain/common";
import { createGenerationStreamState, generationStreamReducer, type GenerationStreamState } from "./generation-stream";
import { cancelGenerationRun, getGenerationSnapshot, readGenerationEvents, retryGenerationRun, type GenerationEventHandlers } from "./generation-observer-client";

export interface BuildRunView {
  retryOfRunId: string | null;
  stream: GenerationStreamState;
  events: GenerationTimelineEvent[];
  beforeSeq: number | null;
  historyLoaded: boolean;
  historyPending: boolean;
  historyError: boolean;
  connectionError: boolean;
  commandPending: boolean;
  commandError: boolean;
  readyCourse: GenerationSnapshot["readyCourse"];
}
export interface ConversationBuildView extends Omit<ConversationBuild, "runs"> { runs: BuildRunView[] }
export interface ConversationBuildState { builds: ConversationBuildView[]; loading: boolean; error: boolean }
export type ConversationBuildSeed = Pick<ConversationDetail, "conversation" | "builds">;
export interface BuildTransport {
  detail(id: string, signal: AbortSignal): ReturnType<ConversationPort["get"]>;
  snapshot: typeof getGenerationSnapshot;
  events(runId: string, after: number, signal: AbortSignal, handlers: GenerationEventHandlers): Promise<number>;
  cancel: typeof cancelGenerationRun;
  retry: typeof retryGenerationRun;
  history(runId: string, before: number, signal: AbortSignal): Promise<GenerationHistoryPage>;
}

export async function getBuildHistory(runId: string, before: number, signal: AbortSignal): Promise<GenerationHistoryPage> {
  IdSchema.parse(runId);
  if (!Number.isSafeInteger(before) || before < 1) throw new Error("build_history_cursor");
  const response = await fetch(`/api/v1/generation-runs/${encodeURIComponent(runId)}/history?before=${before}&limit=50`, {
    credentials: "same-origin", cache: "no-store", signal,
  });
  if (!response.ok) throw new Error("build_history_unavailable");
  const body = await response.json();
  return GenerationHistoryPageSchema.parse(body.data);
}
export function buildTransport(conversations: ConversationPort): BuildTransport {
  return { detail: (id, signal) => conversations.get(id, signal), snapshot: getGenerationSnapshot,
    events: readGenerationEvents, cancel: cancelGenerationRun, retry: retryGenerationRun, history: getBuildHistory };
}
const timelineEvent = (event: GenerationEvent): event is GenerationTimelineEvent =>
  event.type === "generation.commentary" || event.type === "generation.action.started" || event.type === "generation.action.completed";

export function mergeBuildEvents(run: GenerationStreamState["run"], ...groups: GenerationTimelineEvent[][]): GenerationTimelineEvent[] {
  const events = new Map<string, GenerationTimelineEvent>();
  const sequences = new Set<number>();
  for (const event of groups.flat()) {
    if (event.runId !== run.id || event.courseId !== run.courseId || event.branchId !== run.branchId
      || events.has(event.id) || sequences.has(event.seq)) continue;
    events.set(event.id, event); sequences.add(event.seq);
  }
  return [...events.values()].sort((a, b) => a.seq - b.seq);
}
function runView(snapshot: GenerationSnapshot, retryOfRunId: string | null): BuildRunView {
  return { retryOfRunId, stream: createGenerationStreamState(snapshot), events: snapshot.retainedTimelineEvents ?? [],
    beforeSeq: snapshot.timelineBeforeSeq ?? null, historyLoaded: false, historyPending: false, historyError: false,
    connectionError: false, commandPending: false, commandError: false, readyCourse: snapshot.readyCourse };
}
function mergeSnapshot(current: BuildRunView, snapshot: GenerationSnapshot): BuildRunView {
  const stream = generationStreamReducer(current.stream, { type: "snapshot", snapshot });
  // A rejected snapshot must not smuggle stale metadata or history back into the run.
  if (stream === current.stream) return current;
  const missedWindow = snapshot.timelineBeforeSeq != null && snapshot.timelineBeforeSeq > current.stream.lastAppliedSeq + 1;
  return { ...current, stream, events: mergeBuildEvents(stream.run, current.events, snapshot.retainedTimelineEvents ?? []),
    // A long disconnect can leave a gap between already loaded history and the new recent window.
    // Start paging from that newer edge; preserving an old exhausted cursor would hide the gap forever.
    beforeSeq: missedWindow ? snapshot.timelineBeforeSeq! : current.historyLoaded ? current.beforeSeq : snapshot.timelineBeforeSeq ?? null,
    readyCourse: snapshot.readyCourse ?? current.readyCourse, connectionError: false };
}
function pause(signal: AbortSignal, ms: number): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(done, ms);
    function done() { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); }
    signal.addEventListener("abort", done, { once: true });
    if (signal.aborted) done();
  });
}

/** One owner/branch lifetime, with independent observers for every approval in the chat. */
export class ConversationBuilds {
  private state: ConversationBuildState = { builds: [], loading: true, error: false };
  private readonly listeners = new Set<() => void>();
  private lifetime = new AbortController();
  private observers = new Map<string, AbortController>();
  private snapshotRequests = new Map<string, Promise<GenerationSnapshot>>();
  private retryKeys = new Map<string, string>();
  private refreshing: Promise<void> | null = null;
  private mutationEpoch = 0;
  constructor(readonly identity: { actorId: string; conversationId: string; branchId: string }, private transport: BuildTransport,
    private onDetail?: (detail: ConversationDetail) => void, seed?: ConversationBuildSeed | null) {
    if (seed) this.state = { ...this.state, builds: this.mergeDetail(seed) ?? [] };
  }
  getSnapshot = () => this.state;
  setDetailHandler(handler: (detail: ConversationDetail) => void) { this.onDetail = handler; }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(change: Partial<ConversationBuildState>) {
    if (this.lifetime.signal.aborted) return;
    this.state = { ...this.state, ...change }; this.listeners.forEach(listener => listener());
  }
  start() {
    if (this.lifetime.signal.aborted) { this.lifetime = new AbortController(); this.refreshing = null; this.snapshotRequests.clear(); }
    // Saved activity is immediately available; observe it while the cached chat refreshes.
    this.observeCurrent();
    return this.refresh();
  }
  stop() { this.lifetime.abort(); this.observers.forEach(observer => observer.abort()); this.observers.clear(); }
  private matches(snapshot: GenerationSnapshot, build: ConversationBuildView | ConversationBuild) {
    const { run } = snapshot;
    return run.ownerId === this.identity.actorId && run.conversationId === this.identity.conversationId
      && run.branchId === this.identity.branchId && run.courseId === build.courseId && run.approvalId === build.approvalId
      && snapshot.approvalDigest === build.approvalDigest && snapshot.approvedDraftRevision === build.draftRevision;
  }
  private mergeDetail(detail: ConversationBuildSeed): ConversationBuildView[] | null {
    if (detail.conversation.id !== this.identity.conversationId || detail.conversation.ownerId !== this.identity.actorId
      || detail.conversation.activeBranchId !== this.identity.branchId) return null;
    const builds = [...this.state.builds];
    for (const incoming of detail.builds ?? []) {
      if (incoming.branchId !== this.identity.branchId || incoming.runs.some(run => !this.matches(run.snapshot, incoming))) continue;
      const index = builds.findIndex(build => build.approvalId === incoming.approvalId);
      const previous = builds[index];
      if (previous && (previous.approvalDigest !== incoming.approvalDigest || previous.courseId !== incoming.courseId)) continue;
      const runs = previous ? [...previous.runs] : [];
      for (const item of incoming.runs) {
        const oldIndex = runs.findIndex(run => run.stream.run.id === item.snapshot.run.id);
        if (oldIndex >= 0) runs[oldIndex] = mergeSnapshot(runs[oldIndex]!, item.snapshot);
        else if (runs.length === 0 ? item.retryOfRunId === null : item.retryOfRunId === runs.at(-1)!.stream.run.id)
          runs.push(runView(item.snapshot, item.retryOfRunId));
      }
      if (!runs.length) continue;
      const next = { ...incoming, runs };
      if (index < 0) builds.push(next); else builds[index] = next;
    }
    return builds.sort((a, b) => a.approvedAt.localeCompare(b.approvedAt));
  }
  refresh = (): Promise<void> => {
    if (this.refreshing) return this.refreshing;
    const signal = this.lifetime.signal;
    const mutationEpoch = this.mutationEpoch;
    const refreshing = (async () => {
      try {
        const result = await this.transport.detail(this.identity.conversationId, signal);
        if (signal.aborted) return;
        const builds = result.ok ? this.mergeDetail(result.data) : null;
        if (!result.ok || !builds) throw new Error("build_scope");
        this.publish({ builds, loading: false, error: false });
        if (mutationEpoch === this.mutationEpoch) this.onDetail?.(result.data);
        this.observeCurrent();
      } catch { if (!signal.aborted) this.publish({ loading: false, error: true }); }
    })().finally(() => { if (this.refreshing === refreshing) this.refreshing = null; });
    this.refreshing = refreshing;
    return refreshing;
  };
  /** A successful command must be followed by a read started after its commit. */
  refreshAfterMutation = async (): Promise<void> => {
    this.mutationEpoch++;
    const signal = this.lifetime.signal;
    if (this.refreshing) await this.refreshing;
    if (!signal.aborted) await this.refresh();
  };
  private find(runId: string) {
    const build = this.state.builds.find(item => item.runs.some(run => run.stream.run.id === runId));
    const run = build?.runs.find(item => item.stream.run.id === runId);
    return build && run ? { build, run } : null;
  }
  private update(runId: string, change: (run: BuildRunView) => BuildRunView) {
    this.publish({ builds: this.state.builds.map(build => ({ ...build,
      runs: build.runs.map(run => run.stream.run.id === runId ? change(run) : run) })) });
  }
  private isCurrent(runId: string) { return this.find(runId)?.build.runs.at(-1)?.stream.run.id === runId; }
  private async snapshot(runId: string, signal: AbortSignal) {
    let pending = this.snapshotRequests.get(runId);
    if (!pending) {
      pending = this.transport.snapshot(runId, signal).finally(() => { if (this.snapshotRequests.get(runId) === pending) this.snapshotRequests.delete(runId); });
      this.snapshotRequests.set(runId, pending);
    }
    const snapshot = await pending;
    const entry = this.find(runId);
    if (signal.aborted || !entry || !this.isCurrent(runId)) return;
    if (!this.matches(snapshot, entry.build)) throw new Error("build_snapshot_scope");
    this.update(runId, run => mergeSnapshot(run, snapshot));
  }
  private observeCurrent() {
    for (const build of this.state.builds) {
      const current = build.runs.at(-1)!;
      for (const older of build.runs.slice(0, -1)) this.observers.get(older.stream.run.id)?.abort();
      if (!current.stream.pending || this.observers.has(current.stream.run.id)) continue;
      const runId = current.stream.run.id;
      const observer = new AbortController(); this.observers.set(runId, observer);
      const lifetimeSignal = this.lifetime.signal;
      const abort = () => observer.abort(); lifetimeSignal.addEventListener("abort", abort, { once: true });
      const alive = () => !observer.signal.aborted && this.isCurrent(runId);
      const poll = async () => {
        while (alive() && this.find(runId)?.run.stream.pending) {
          await pause(observer.signal, 8000);
          if (!alive() || !this.find(runId)?.run.stream.pending) return;
          try {
            await this.snapshot(runId, observer.signal);
            if (alive() && !this.find(runId)?.run.stream.pending) { observer.abort(); void this.refresh(); }
          }
          catch { if (alive()) this.update(runId, run => ({ ...run, connectionError: true })); }
        }
      };
      const events = async () => {
        let repair = false, delay = 750;
        while (alive() && this.find(runId)?.run.stream.pending) {
          try {
            if (repair) { await this.snapshot(runId, observer.signal); repair = false; }
            const current = this.find(runId)?.run;
            if (!alive() || !current?.stream.pending) return;
            await this.transport.events(runId, current.stream.lastAppliedSeq, observer.signal, {
              onEvent: event => {
                if (!alive()) return;
                this.update(runId, run => {
                  const stream = generationStreamReducer(run.stream, { type: "event", event });
                  return { ...run, stream, events: timelineEvent(event) ? mergeBuildEvents(stream.run, run.events, [event]) : run.events, connectionError: false };
                });
                if (!this.find(runId)?.run.stream.pending) { observer.abort(); void this.refresh(); }
              }, onSnapshotRequired: () => { repair = true; },
            });
            if (!alive()) return;
            const latest = this.find(runId)?.run.stream;
            repair ||= Boolean(latest?.needsSnapshot || latest?.replayAfterSeq !== null);
            delay = 750;
            // A normally closed bounded SSE connection reconnects without a busy loop.
            if (latest?.pending) await pause(observer.signal, 250);
          } catch {
            if (!alive()) return;
            this.update(runId, run => ({ ...run, connectionError: true }));
            await pause(observer.signal, delay); delay = Math.min(delay * 2, 12000); repair = true;
          }
        }
      };
      void (async () => {
        void poll();
        await events();
        if (alive()) { await this.snapshot(runId, observer.signal); void this.refresh(); }
      })().catch(() => { if (alive()) this.update(runId, run => ({ ...run, connectionError: true })); })
        .finally(() => { observer.abort(); lifetimeSignal.removeEventListener("abort", abort); if (this.observers.get(runId) === observer) this.observers.delete(runId); });
    }
  }
  async command(approvalId: string, kind: "cancel" | "retry") {
    const build = this.state.builds.find(item => item.approvalId === approvalId), current = build?.runs.at(-1);
    if (!build || !current || current.commandPending || (kind === "cancel" ? !current.stream.pending : !["failed", "cancelled"].includes(current.stream.run.status))) return;
    const runId = current.stream.run.id, signal = this.lifetime.signal;
    this.update(runId, run => ({ ...run, commandPending: true, commandError: false }));
    try {
      const key = this.retryKeys.get(runId) ?? crypto.randomUUID();
      if (kind === "retry") this.retryKeys.set(runId, key);
      const snapshot = kind === "cancel" ? await this.transport.cancel(runId, signal) : await this.transport.retry(runId, key, signal);
      if (signal.aborted || !this.isCurrent(runId)) return;
      if (!this.matches(snapshot, build) || (kind === "cancel" ? snapshot.run.id !== runId : snapshot.run.id === runId)) throw new Error("build_command_scope");
      if (kind === "cancel") {
        this.update(runId, run => mergeSnapshot(run, snapshot));
        if (!this.find(runId)?.run.stream.pending) this.observers.get(runId)?.abort();
      }
      else {
        this.publish({ builds: this.state.builds.map(item => item.approvalId === approvalId
          ? { ...item, runs: [...item.runs, runView(snapshot, runId)] } : item) });
        this.retryKeys.delete(runId); this.observeCurrent();
      }
      void this.refreshAfterMutation();
    } catch { if (!signal.aborted && this.isCurrent(runId)) this.update(runId, run => ({ ...run, commandError: true })); }
    finally { if (!signal.aborted) this.update(runId, run => ({ ...run, commandPending: false })); }
  }
  async earlier(runId: string) {
    const entry = this.find(runId);
    if (!entry?.run.beforeSeq || entry.run.historyPending) return;
    const signal = this.lifetime.signal, before = entry.run.beforeSeq;
    this.update(runId, run => ({ ...run, historyPending: true, historyError: false }));
    try {
      const page = await this.transport.history(runId, before, signal);
      if (signal.aborted) return;
      if (page.runId !== runId || page.courseId !== entry.build.courseId || page.branchId !== this.identity.branchId
        || page.items.some(event => event.seq >= before)) throw new Error("build_history_scope");
      this.update(runId, run => ({ ...run, events: mergeBuildEvents(run.stream.run, run.events, page.items),
        beforeSeq: run.beforeSeq === before ? page.beforeSeq : run.beforeSeq, historyLoaded: true }));
    } catch { if (!signal.aborted) this.update(runId, run => ({ ...run, historyError: true })); }
    finally { if (!signal.aborted) this.update(runId, run => ({ ...run, historyPending: false })); }
  }
}
