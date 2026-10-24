import { describe, expect, it } from "vitest";
import { SampleAttemptSchema, type SampleAttempt } from "@/domain";
import { CapacityResponseSchema, createInitialResponse, SAMPLE_HINT_ID, sampleTask } from "@/features/learning/sample/content";
import { evaluateSampleAttempt, SampleConflictError } from "@/features/learning/sample/evaluator";
import { SAMPLE_STORAGE_KEY, sampleReceiptsKey, SampleController, type SampleStorage } from "@/features/learning/sample/session";

class MemoryStorage implements SampleStorage {
  values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

function attempt(overrides: Partial<SampleAttempt> = {}): SampleAttempt {
  return SampleAttemptSchema.parse({
    id: crypto.randomUUID(), sampleSessionId: crypto.randomUUID(), taskId: sampleTask.id,
    taskVersion: 1, idempotencyKey: crypto.randomUUID(),
    response: { ...createInitialResponse(), degree: 3, explanation: "noise" },
    assistance: "independent", hintIdsUsed: [], submittedAt: new Date().toISOString(), ...overrides,
  });
}

describe("sample evaluation", () => {
  it.each([[3, 0], [3, 0.1], [7, 0.1]])("accepts alternative degree %s, lambda %s and awards no account XP", (degree, lambda) => {
    const receipt = evaluateSampleAttempt(attempt({ response: { ...createInitialResponse(), degree, lambda, explanation: "noise" } }), []);
    expect(receipt.evaluation.outcome).toBe("correct");
    expect(receipt.evaluation.awardedXp).toBe(0);
    expect(receipt.evaluation.feedback.explanation).toContain("fresh test set");
    expect(receipt.attempt).not.toHaveProperty("enrollmentId");
  });

  it("rejects a blanket future guarantee even with a good fit", () => {
    const result = evaluateSampleAttempt(attempt({ response: { ...createInitialResponse(), degree: 3, explanation: "guarantee" } }), []);
    expect(result.evaluation.outcome).toBe("partial");
    expect(result.evaluation.feedback.nextAction).toBe("revise");
    expect(result.evaluation.feedback.explanation).toContain("cannot guarantee");
  });

  it("does not accept zero training error as a successful model", () => {
    const result = evaluateSampleAttempt(attempt({ response: { ...createInitialResponse(), explanation: "noise" } }), []);
    expect(result.evaluation.outcome).toBe("partial");
    expect(result.evaluation.dimensions[0]?.status).toBe("not_met");
  });

  it("reuses the exact receipt for an identical submission and rejects changed bodies", () => {
    const first = attempt();
    const receipt = evaluateSampleAttempt(first, []);
    expect(evaluateSampleAttempt(structuredClone(first), [receipt])).toBe(receipt);
    expect(() => evaluateSampleAttempt({ ...first, response: { ...createInitialResponse(), degree: 1 } }, [receipt])).toThrow(SampleConflictError);
    expect(() => evaluateSampleAttempt({ ...first, assistance: "hinted", hintIdsUsed: [SAMPLE_HINT_ID] }, [receipt])).toThrow(SampleConflictError);
  });

  it("validates concrete responses and keeps the evaluator limited to this sample", () => {
    expect(() => evaluateSampleAttempt(attempt({ response: { degree: 99 } }), [])).toThrow();
    expect(() => evaluateSampleAttempt(attempt({ taskId: crypto.randomUUID() }), [])).toThrow("not supported");
    expect(CapacityResponseSchema.safeParse({ ...createInitialResponse(), executable: "alert(1)" }).success).toBe(false);
  });

  it("saves reflection without evaluating its wording", () => {
    const a = evaluateSampleAttempt(attempt(), []).evaluation;
    const b = evaluateSampleAttempt(attempt({ response: { ...createInitialResponse(), degree: 3, explanation: "noise", reflection: "I want to think more about this." } }), []).evaluation;
    expect(b.outcome).toBe(a.outcome);
    expect(b.dimensions).toEqual(a.dimensions);
  });
});

describe("isolated sample lifecycle", () => {
  it("does not persist from viewing alone, then saves the first meaningful action", () => {
    const storage = new MemoryStorage();
    const controller = new SampleController();
    controller.attachStorage(storage);
    expect(storage.values.size).toBe(0);
    controller.edit({ ...createInitialResponse(), prediction: "lower" });
    expect(storage.values.size).toBe(1);
    expect(controller.getSnapshot().started).toBe(true);
    expect(JSON.parse(storage.getItem(SAMPLE_STORAGE_KEY)!).response.prediction).toBe("lower");
  });

  it("resumes settings, notes, assistance and the same receipt after reload", () => {
    const storage = new MemoryStorage();
    const before = new SampleController();
    before.attachStorage(storage);
    before.edit({ ...createInitialResponse(), degree: 3, explanation: "noise", reflection: "Less bending helped." });
    before.useHint();
    const receipt = before.submit();
    const resumed = new SampleController();
    resumed.attachStorage(storage);
    expect(resumed.getSnapshot().resumed).toBe(true);
    expect(resumed.getSnapshot().session.response.reflection).toBe("Less bending helped.");
    expect(resumed.getSnapshot().session.hintIdsUsed).toEqual([SAMPLE_HINT_ID]);
    expect(resumed.submit()).toEqual(receipt);
    expect(resumed.getSnapshot().session.lastAttempt?.assistance).toBe("hinted");
  });

  it("double submit is idempotent, and any edit creates a new submission key", () => {
    const controller = new SampleController();
    controller.attachStorage(new MemoryStorage());
    const first = controller.submit();
    expect(controller.submit()).toBe(first);
    controller.edit({ ...createInitialResponse(), degree: 3 });
    controller.edit(createInitialResponse());
    expect(controller.submit()?.attempt.idempotencyKey).not.toBe(first?.attempt.idempotencyKey);
  });

  it("records a hint as assistance and starts a new attempt if a hint follows an answer", () => {
    const controller = new SampleController();
    controller.attachStorage(new MemoryStorage());
    const independent = controller.submit();
    controller.useHint();
    const helped = controller.submit();
    expect(independent?.attempt.assistance).toBe("independent");
    expect(helped?.attempt.assistance).toBe("hinted");
    expect(helped?.attempt.hintIdsUsed).toEqual([SAMPLE_HINT_ID]);
    expect(helped?.attempt.idempotencyKey).not.toBe(independent?.attempt.idempotencyKey);
  });

  it("reset removes only the sample session and receipts, clears hints, and changes session identity", () => {
    const storage = new MemoryStorage();
    storage.setItem("unfurl.drafts", "existing course draft");
    storage.setItem("unfurl.preferences", "existing preferences");
    const controller = new SampleController();
    controller.attachStorage(storage);
    controller.useHint();
    controller.submit();
    const previousId = controller.getSnapshot().session.id;
    expect(storage.getItem(sampleReceiptsKey(previousId))).not.toBeNull();
    controller.reset();
    const reset = controller.getSnapshot();
    expect(reset.session.id).not.toBe(previousId);
    expect(reset.session.response).toEqual(createInitialResponse());
    expect(reset.session.hintIdsUsed).toEqual([]);
    expect(reset.session.lastAttempt).toBeNull();
    expect(reset.session.evaluation).toBeNull();
    expect(reset.started).toBe(false);
    expect(storage.getItem(SAMPLE_STORAGE_KEY)).toBeNull();
    expect(storage.getItem(sampleReceiptsKey(previousId))).toBeNull();
    expect([...storage.values.entries()]).toEqual([["unfurl.drafts", "existing course draft"], ["unfurl.preferences", "existing preferences"]]);
  });

  it("preserves usable input and grading when storage cannot save", () => {
    const storage: SampleStorage = { getItem: () => null, setItem: () => { throw new Error("Quota exceeded"); }, removeItem: () => undefined };
    const controller = new SampleController();
    controller.attachStorage(storage);
    controller.edit({ ...createInitialResponse(), degree: 3, explanation: "noise" });
    expect(controller.getSnapshot().session.response.degree).toBe(3);
    expect(controller.getSnapshot().storageMessage).toContain("could not be saved");
    expect(controller.submit()?.evaluation.outcome).toBe("correct");
    expect(controller.getSnapshot().session.response.degree).toBe(3);
  });

  it("handles unavailable or corrupt browser storage without inventing saved success", () => {
    const controller = new SampleController();
    controller.attachStorage(null);
    expect(controller.getSnapshot().storageMessage).toContain("cannot save");
    const storage = new MemoryStorage();
    storage.setItem(SAMPLE_STORAGE_KEY, "not json");
    const corrupt = new SampleController();
    corrupt.attachStorage(storage);
    expect(corrupt.getSnapshot().started).toBe(false);
    expect(corrupt.getSnapshot().storageMessage).toContain("could not be opened");
  });
});
