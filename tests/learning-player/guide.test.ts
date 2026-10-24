import { describe, expect, it } from "vitest";
import { GUIDE_STORAGE_KEY, PracticeGuide, type GuideStorage } from "@/features/learning/sample/guide";
import { createInitialResponse } from "@/features/learning/sample/content";
import { SampleController, type SampleStorage } from "@/features/learning/sample/session";

class MemoryStorage implements SampleStorage {
  values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

describe("practice orientation", () => {
  it("asks for a real adjustment before continuing from the action card", () => {
    const guide = new PracticeGuide();
    guide.recordAdjustment(); // An earlier change is not this step's action.
    guide.next();
    guide.next();
    expect(guide.getSnapshot().step).toBe("adjust");
    guide.recordAdjustment();
    guide.next();
    expect(guide.getSnapshot().step).toBe("compare");
    guide.next();
    expect(guide.getSnapshot().step).toBeNull();
  });

  it("does not write on arrival and remembers an explicit skip on the next visit", () => {
    const storage = new MemoryStorage();
    const guide = new PracticeGuide();
    guide.attachStorage(storage);
    expect(storage.values.size).toBe(0);
    guide.dismiss();
    expect([...storage.values.keys()]).toEqual([GUIDE_STORAGE_KEY]);
    const nextVisit = new PracticeGuide();
    nextVisit.attachStorage(storage);
    expect(nextVisit.getSnapshot().step).toBeNull();
    nextVisit.replay();
    expect(nextVisit.getSnapshot()).toEqual({ step: "observe", adjusted: false });
  });

  it("skip, replay and completing orientation preserve the real answer and hint accounting", () => {
    const storage = new MemoryStorage();
    const sample = new SampleController();
    sample.attachStorage(storage);
    sample.edit({ ...createInitialResponse(), degree: 3, explanation: "noise", reflection: "The diamond gaps got smaller." });
    sample.submit();
    const before = structuredClone(sample.getSnapshot());
    const guide = new PracticeGuide();
    guide.attachStorage(storage);
    guide.dismiss();
    guide.replay();
    guide.next();
    guide.recordAdjustment();
    guide.next();
    guide.next();
    expect(sample.getSnapshot()).toEqual(before);
    const resumed = new SampleController();
    resumed.attachStorage(storage);
    expect(resumed.getSnapshot().session).toEqual(before.session);
    expect(resumed.getSnapshot().session.lastAttempt?.assistance).toBe("independent");
    expect(resumed.getSnapshot().session.evaluation?.awardedXp).toBe(0);
  });

  it("keeps all orientation actions usable when preferences cannot be stored", () => {
    const storage: GuideStorage = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
    const guide = new PracticeGuide();
    guide.attachStorage(storage);
    expect(guide.getSnapshot().step).toBe("observe");
    expect(() => guide.dismiss()).not.toThrow();
    expect(guide.getSnapshot().step).toBeNull();
    guide.replay();
    guide.next();
    expect(guide.getSnapshot().step).toBe("adjust");
  });
});
