import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("../../src/server/sharing/repository", () => ({
  revokeActiveShareGrants: vi.fn(),
}));
import type { Actor } from "../../src/server/auth/actor";
import { ServiceFault } from "../../src/server/auth/errors";
import type { DbTransaction } from "../../src/server/db";
import { createPublicationService } from "../../src/server/publication";

const id = (suffix: string) => `00000000-0000-4000-8000-${suffix.padStart(12, "0")}`;
const actor: Actor = { id: id("1"), sessionId: id("2"), email: "owner@example.test" };
const courseId = id("3");
const versionOne = id("4");
const versionTwo = id("5");
const key = id("6");

function setup(options: {
  visibility?: "private" | "unlisted" | "public";
  revision?: number;
  publishedVersionId?: string | null;
  eligible?: boolean;
  ready?: boolean;
  replay?: boolean;
} = {}) {
  const order: string[] = [];
  const lockOwnedCourse = vi.fn(async () => {
    order.push("course-lock");
    return {
      id: courseId,
      owner_id: actor.id,
      visibility: options.visibility ?? "private",
      revision: options.revision ?? 7,
      current_ready_version_id: versionTwo,
      published_version_id: options.publishedVersionId ?? null,
    } as const;
  });
  const revokeActiveShareGrants = vi.fn(async () => { order.push("grant-lock-revoke"); return 2; });
  const readAccountProgress = vi.fn(async () => ({
    xpTotal: options.eligible === false ? 499 : 500,
    level: options.eligible === false ? 2 : 3,
    xpToNextLevel: options.eligible === false ? 1 : 250,
    publication: { eligible: options.eligible !== false, requiredLevel: 3, reasons: options.eligible === false ? ["Reach level 3"] : [] },
  }));
  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
    if (sql.startsWith("INSERT INTO unfurl.idempotency")) {
      order.push("idempotency");
      return { rows: options.replay ? [] : [{ key }], rowCount: options.replay ? 0 : 1 };
    }
    if (sql.includes("SELECT request_digest, response_status")) {
      const { requestDigest } = await import("../../src/server/idempotency");
      return { rows: [{
        request_digest: requestDigest({ courseId, expectedRevision: 7, visibility: "public", courseVersionId: versionOne }),
        response_status: 200,
        response_data: { courseId, visibility: "public", publishedVersionId: versionOne, revision: 8 },
      }], rowCount: 1 };
    }
    if (sql.includes("FROM unfurl.course_versions version")) {
      order.push("ready-check");
      return { rows: options.ready === false ? [] : [{ id: versionOne }], rowCount: options.ready === false ? 0 : 1 };
    }
    if (sql.includes("UPDATE unfurl.courses")) {
      order.push("course-update");
      const visibility = values[1] as "private" | "unlisted" | "public";
      const published = values[2] as string | null;
      return { rows: [{ id: courseId, visibility, published_version_id: published, revision: 8 }], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  });
  const tx = { query } as unknown as DbTransaction;
  const service = createPublicationService({
    transactions: { run: async (work) => work(tx) },
    lockOwnedCourse,
    revokeActiveShareGrants,
    readAccountProgress,
  });
  return { service, query, order, lockOwnedCourse, revokeActiveShareGrants, readAccountProgress };
}

describe("publication service", () => {
  it("publishes only the explicit passed ready version from a completed generation run", async () => {
    const state = setup();
    const receipt = await state.service.setVisibility(actor, courseId, {
      expectedRevision: 7, visibility: "public", courseVersionId: versionOne,
    }, key);
    expect(receipt.data).toEqual({ courseId, visibility: "public", publishedVersionId: versionOne, revision: 8 });
    const readinessSql = state.query.mock.calls.find(([sql]) => String(sql).includes("FROM unfurl.course_versions version"))?.[0];
    expect(readinessSql).toContain("version_validation_receipts");
    expect(readinessSql).toContain("generation_runs source_run");
    expect(readinessSql).toContain("source_run.output_version_id = version.id");
    expect(readinessSql).not.toContain("agent_turn_runs");
    expect(state.readAccountProgress).toHaveBeenCalledWith(expect.anything(), actor.id);
  });

  it("returns a reason-specific 403 below the level gate without checking or mutating the version", async () => {
    const state = setup({ eligible: false });
    await expect(state.service.setVisibility(actor, courseId, {
      expectedRevision: 7, visibility: "public", courseVersionId: versionOne,
    }, key)).rejects.toMatchObject({ status: 403, messageKey: "publication.levelRequired" });
    expect(state.order).not.toContain("ready-check");
    expect(state.order).not.toContain("course-update");
  });

  it("rejects a non-ready, failed-validation, or non-generation version with a safe eligibility reason", async () => {
    const state = setup({ ready: false });
    await expect(state.service.setVisibility(actor, courseId, {
      expectedRevision: 7, visibility: "public", courseVersionId: versionOne,
    }, key)).rejects.toMatchObject({ status: 403, messageKey: "publication.versionNotEligible" });
  });

  it("returns the locked current revision on a stale aggregate course CAS", async () => {
    const state = setup({ revision: 9 });
    await expect(state.service.setVisibility(actor, courseId, {
      expectedRevision: 7, visibility: "public", courseVersionId: versionOne,
    }, key)).rejects.toMatchObject({ status: 409, details: { currentRevision: 9 } });
    expect(state.readAccountProgress).not.toHaveBeenCalled();
  });

  it("clears the pointer and revokes grants under the course lock when becoming private", async () => {
    const state = setup({ visibility: "public", publishedVersionId: versionOne });
    const receipt = await state.service.setVisibility(actor, courseId, {
      expectedRevision: 7, visibility: "private", courseVersionId: versionOne,
    }, key);
    expect(receipt.data).toMatchObject({ visibility: "private", publishedVersionId: null, revision: 8 });
    expect(state.revokeActiveShareGrants).toHaveBeenCalledWith(expect.anything(), courseId);
    expect(state.order.indexOf("course-lock")).toBeLessThan(state.order.indexOf("grant-lock-revoke"));
    expect(state.order.indexOf("grant-lock-revoke")).toBeLessThan(state.order.indexOf("course-update"));
    expect(state.query.mock.calls.some(([sql]) => String(sql).includes("enrollments"))).toBe(false);
  });

  it("still revokes active grants and bumps the aggregate revision when already private", async () => {
    const state = setup({ visibility: "private", publishedVersionId: null });
    const receipt = await state.service.setVisibility(actor, courseId, {
      expectedRevision: 7, visibility: "private", courseVersionId: versionOne,
    }, key);
    expect(receipt.data).toMatchObject({ visibility: "private", publishedVersionId: null, revision: 8 });
    expect(state.revokeActiveShareGrants).toHaveBeenCalledOnce();
    expect(state.order).toContain("course-update");
  });

  it("clears the public pointer without revoking links when becoming unlisted", async () => {
    const state = setup({ visibility: "public", publishedVersionId: versionOne });
    const receipt = await state.service.setVisibility(actor, courseId, {
      expectedRevision: 7, visibility: "unlisted", courseVersionId: versionOne,
    }, key);
    expect(receipt.data).toMatchObject({ visibility: "unlisted", publishedVersionId: null });
    expect(state.revokeActiveShareGrants).not.toHaveBeenCalled();
  });

  it("reauthorizes the owner before returning a stable idempotent receipt", async () => {
    const state = setup({ replay: true });
    const receipt = await state.service.setVisibility(actor, courseId, {
      expectedRevision: 7, visibility: "public", courseVersionId: versionOne,
    }, key);
    expect(state.order[0]).toBe("course-lock");
    expect(receipt).toMatchObject({ replayed: true, data: { courseId, publishedVersionId: versionOne } });
    expect(state.readAccountProgress).not.toHaveBeenCalled();
    expect(state.order).not.toContain("course-update");
  });

  it("does not expose whether a foreign course exists", async () => {
    const state = setup();
    state.lockOwnedCourse.mockRejectedValueOnce(new ServiceFault(404, "not_found", "catalog.notFound"));
    await expect(state.service.setVisibility(actor, courseId, {
      expectedRevision: 7, visibility: "private", courseVersionId: versionOne,
    }, key)).rejects.toMatchObject({ status: 404, messageKey: "catalog.notFound" });
    expect(state.order).toEqual([]);
  });
});
