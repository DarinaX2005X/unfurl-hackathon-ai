import { describe, expect, it } from "vitest";
import type { GenerationRun } from "../../src/domain/generation";
import type { GenerationEvent, GenerationSnapshot } from "../../src/domain/generation-observer";
import {
  createGenerationStreamState,
  generationStreamReducer,
  type GenerationStreamState,
} from "../../src/features/creator/generation-stream";
import { ids, timestamp } from "../domain/fixtures";

const runId = "50000000-0000-4000-8000-000000000001";
const branchId = "50000000-0000-4000-8000-000000000002";
const messageId = "50000000-0000-4000-8000-000000000003";
const versionId = "50000000-0000-4000-8000-000000000004";
const digest = "a".repeat(64);

function run(overrides: Partial<GenerationRun> = {}): GenerationRun {
  return {
    id: runId,
    ownerId: ids.actor,
    courseId: ids.course,
    conversationId: ids.conversation,
    branchId,
    inputMessageId: messageId,
    sourceDraftRevision: 1,
    approvalId: ids.approval,
    phase: "module_research",
    status: "running",
    lastSeq: 1,
    outputVersionId: null,
    error: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

function snapshot(overrides: Partial<GenerationSnapshot> = {}): GenerationSnapshot {
  return {
    run: run(),
    approvedDraftRevision: 1,
    approvalDigest: digest,
    modules: [
      { moduleId: ids.moduleA, title: "Foundations", status: "researching", completedTasks: 0 },
      { moduleId: ids.moduleB, title: "Systems", status: "pending", completedTasks: 0 },
    ],
    work: { completed: 0, total: null },
    validation: null,
    readyVersionId: null,
    lastSeq: 1,
    ...overrides,
  };
}

type EventDetail = GenerationEvent extends infer Event ? Event extends GenerationEvent
  ? Omit<Event, "id" | "runId" | "courseId" | "branchId" | "seq" | "at"> : never : never;

function event(seq: number, detail: EventDetail): GenerationEvent {
  return {
    id: `60000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    runId,
    courseId: ids.course,
    branchId,
    seq,
    at: timestamp,
    ...detail,
  };
}

function apply(state: GenerationStreamState, ...events: GenerationEvent[]): GenerationStreamState {
  return events.reduce((current, next) => generationStreamReducer(current, { type: "event", event: next }), state);
}

describe("independent course generation observation", () => {
  it("buffers gaps, ignores duplicates, and drains only contiguous events", () => {
    const initial = createGenerationStreamState(snapshot());
    const third = event(3, { type: "generation.validation.summary", summary: { checked: 2, passed: 2, failed: 0, categories: ["structure"] } });
    const waiting = apply(initial, third, third);
    expect(waiting.lastAppliedSeq).toBe(1);
    expect(waiting.bufferedEvents).toEqual([third]);
    expect(waiting.replayAfterSeq).toBe(1);
    const restored = apply(waiting, event(2, { type: "generation.phase.changed", phase: "validating" }));
    expect(restored.lastAppliedSeq).toBe(3);
    expect(restored.run.phase).toBe("validating");
    expect(restored.validation?.checked).toBe(2);
    expect(restored.replayAfterSeq).toBeNull();
  });

  it("filters another run, course, or branch before it can mutate the selected course", () => {
    const initial = createGenerationStreamState(snapshot());
    const next = event(2, { type: "generation.phase.changed", phase: "building_tasks" });
    for (const foreign of [
      { ...next, runId: ids.missing },
      { ...next, courseId: ids.sample },
      { ...next, branchId: ids.missing },
    ]) expect(generationStreamReducer(initial, { type: "event", event: foreign })).toBe(initial);
  });

  it("applies saved module and validation facts without inventing a percentage", () => {
    const initial = createGenerationStreamState(snapshot());
    const state = apply(initial,
      event(2, { type: "generation.module.completed", moduleId: ids.moduleA, completedTasks: 4 }),
      event(3, { type: "generation.validation.summary", summary: { checked: 4, passed: 3, failed: 1, categories: ["sources", "coverage"] } }),
    );
    expect(state.modules[0]).toMatchObject({ status: "complete", completedTasks: 4 });
    expect(state.work).toEqual({ completed: 0, total: null });
    expect(state.needsSnapshot).toBe(true);
    expect(state.validation).toMatchObject({ checked: 4, failed: 1 });
  });

  it("uses only a persisted success event to expose the ready version", () => {
    const initial = createGenerationStreamState(snapshot());
    const ready = apply(initial, event(2, { type: "generation.succeeded", courseVersionId: versionId }));
    expect(ready.run).toMatchObject({ status: "succeeded", outputVersionId: versionId });
    expect(ready.readyVersionId).toBe(versionId);
    expect(ready.pending).toBe(false);
    expect(apply(ready, event(3, { type: "generation.cancelled", reason: "user" }))).toBe(ready);
  });

  it("preserves useful module state on failure and never lets a late event claim readiness", () => {
    const initial = createGenerationStreamState(snapshot());
    const failed = apply(initial,
      event(2, { type: "generation.module.completed", moduleId: ids.moduleA, completedTasks: 2 }),
      event(3, { type: "generation.failed", error: { code: "generation_failed", messageKey: "generation.failed", retryable: true, requestId: ids.request } }),
    );
    expect(failed.modules[0]).toMatchObject({ status: "complete", completedTasks: 2 });
    expect(failed.run.status).toBe("failed");
    expect(failed.readyVersionId).toBeNull();
    expect(apply(failed, event(4, { type: "generation.succeeded", courseVersionId: versionId }))).toBe(failed);
  });

  it("repairs a gap from an authoritative snapshot and keeps future buffered work", () => {
    const initial = createGenerationStreamState(snapshot());
    const waiting = apply(initial, event(4, { type: "generation.validation.summary", summary: { checked: 1, passed: 1, failed: 0, categories: ["coverage"] } }));
    const authoritative = snapshot({ run: run({ lastSeq: 3, phase: "validating" }), lastSeq: 3,
      work: { completed: 2, total: 5 }, modules: snapshot().modules.map((module) => module.moduleId === ids.moduleA
        ? { ...module, status: "complete", completedTasks: 3 } : module) });
    const restored = generationStreamReducer(waiting, { type: "snapshot", snapshot: authoritative });
    expect(restored.lastAppliedSeq).toBe(4);
    expect(restored.work).toEqual({ completed: 2, total: 5 });
    expect(restored.validation?.checked).toBe(1);
    expect(restored.bufferedEvents).toEqual([]);
  });

  it("rejects stale or foreign snapshots and cannot reopen a terminal build", () => {
    const readySnapshot = snapshot({ run: run({ status: "succeeded", outputVersionId: versionId, lastSeq: 2 }),
      readyVersionId: versionId, lastSeq: 2 });
    const ready = createGenerationStreamState(readySnapshot);
    for (const foreign of [
      snapshot({ run: run({ id: ids.missing }) }),
      snapshot({ run: run({ courseId: ids.sample }) }),
      snapshot({ run: run({ branchId: ids.missing }) }),
      snapshot({ run: run({ lastSeq: 1 }), lastSeq: 1 }),
      snapshot({ run: run({ status: "running", lastSeq: 3 }), lastSeq: 3 }),
    ]) expect(generationStreamReducer(ready, { type: "snapshot", snapshot: foreign })).toBe(ready);
  });
});
