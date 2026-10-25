import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { ActivityContextSessionSchema } from "@/server/evaluation/contracts";
import { ActivitySessionPublicSchema } from "@/domain/activity";
import { predictionCase } from "../mechanics/investigation/fixtures";

describe("bounded server evaluator session view", () => {
  it("accepts stored validation activity without inventing an enrollment while the learner DTO still requires it", async () => {
    const { activity } = await predictionCase();
    const publicSession = ActivitySessionPublicSchema.parse(activity.session);
    const { enrollmentId: _enrollmentId, ...view } = publicSession;
    void _enrollmentId;
    expect(ActivityContextSessionSchema.parse(view)).toEqual(view);
    expect(ActivityContextSessionSchema.safeParse(publicSession).success).toBe(false);
    expect(ActivitySessionPublicSchema.safeParse(view).success).toBe(false);
  });
  it("preserves exhaustion, ordered event and exact input-session invariants", async () => {
    const { activity } = await predictionCase();
    const { enrollmentId: _enrollmentId, ...base } = ActivitySessionPublicSchema.parse(activity.session);
    void _enrollmentId;
    const invalid = [
      { ...base, status: "budget_exhausted", remainingActions: 1 },
      { ...base, events: [...base.events].reverse() },
      { ...base, events: [base.events[0], base.events[0]] },
      { ...base, inputRevision: 0 },
      { ...base, id: crypto.randomUUID() },
      { ...base, revision: 1 },
    ];
    for (const view of invalid) {
      expect(ActivityContextSessionSchema.safeParse(view).success).toBe(false);
      expect(ActivitySessionPublicSchema.safeParse({ ...view, enrollmentId: crypto.randomUUID() }).success).toBe(false);
    }
  });
});
