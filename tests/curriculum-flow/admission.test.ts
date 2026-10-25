import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createCurriculumService } from "../../src/server/curricula/service";
import { ids } from "./fixtures";

describe("authoring admission", () => {
  it("writes no approval or job when the actual runtime is unavailable", async () => {
    const transaction = vi.fn();
    const service = createCurriculumService({ transaction });
    const actor = { id: ids.actor, sessionId: ids.request, email: null };
    await expect(service.approve(actor, ids.draft, { expectedRevision: 1, contentDigest: "a".repeat(64) }, ids.request)).rejects.toMatchObject({ status: 503 });
    expect(transaction).not.toHaveBeenCalled();
  });

  it("does not accept language regeneration or unverified answers without their capabilities", async () => {
    const transaction = vi.fn();
    const service = createCurriculumService({ transaction });
    const actor = { id: ids.actor, sessionId: ids.request, email: null };
    await expect(service.language(actor, ids.course, { expectedRevision: 1, expectedDraftRevision: 1, contentLanguage: "ru" }, ids.request)).rejects.toMatchObject({ status: 503 });
    await expect(service.patch(actor, ids.draft, { expectedRevision: 1, changes: [{ op: "answer_question", id: ids.question, answer: "Python" }] }, ids.request)).rejects.toMatchObject({ status: 503 });
    expect(transaction).not.toHaveBeenCalled();
  });
});
