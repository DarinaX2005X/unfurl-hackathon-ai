import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
vi.mock("server-only", () => ({}));
vi.mock("../../src/server/auth/session", () => ({ requireActor: vi.fn() }));
vi.mock("../../src/server/auth/config", () => ({ requireAuthConfiguration: () => ({ origin: "http://127.0.0.1:3000" }) }));
vi.mock("../../src/server/publication", () => ({ publicationService: { setVisibility: vi.fn() } }));
vi.mock("../../src/server/progression", () => ({ readAccountProgress: vi.fn() }));
import { PATCH as patchVisibility } from "../../src/app/api/v1/courses/[id]/visibility/route";
import { GET as getProgress } from "../../src/app/api/v1/me/progress/route";
import { requireActor } from "../../src/server/auth/session";
import { publicationService } from "../../src/server/publication";
import { readAccountProgress } from "../../src/server/progression";

const id = (suffix: string) => `00000000-0000-4000-8000-${suffix.padStart(12, "0")}`;
const actor = { id: id("1"), sessionId: id("2"), email: null };
const courseId = id("3");
const versionId = id("4");
const key = id("5");
const body = { expectedRevision: 2, visibility: "public", courseVersionId: versionId } as const;

function visibilityRequest(value: unknown = body, origin = "http://127.0.0.1:3000", idempotencyKey: string | null = key) {
  const headers: Record<string, string> = { Origin: origin, "Content-Type": "application/json" };
  if (idempotencyKey !== null) headers["Idempotency-Key"] = idempotencyKey;
  return new NextRequest(`http://127.0.0.1:3000/api/v1/courses/${courseId}/visibility`, {
    method: "PATCH", headers, body: JSON.stringify(value),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireActor).mockResolvedValue(actor);
});

describe("progression and publication API boundaries", () => {
  it("passes only strict same-origin visibility input and a stable idempotency identity", async () => {
    vi.mocked(publicationService.setVisibility).mockResolvedValueOnce({
      status: 200,
      data: { courseId, visibility: "public", publishedVersionId: versionId, revision: 3 },
      replayed: false,
    });
    const response = await patchVisibility(visibilityRequest(), { params: Promise.resolve({ id: courseId }) });
    expect(response.status).toBe(200);
    expect(publicationService.setVisibility).toHaveBeenCalledWith(actor, courseId, body, key);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
  });

  it("rejects cross-origin, missing-key and browser authority fields before publication", async () => {
    expect((await patchVisibility(visibilityRequest(body, "https://other.example"), { params: Promise.resolve({ id: courseId }) })).status).toBe(403);
    expect((await patchVisibility(visibilityRequest(body, undefined, null), { params: Promise.resolve({ id: courseId }) })).status).toBe(400);
    expect((await patchVisibility(visibilityRequest({ ...body, learnerId: actor.id, level: 9 }), { params: Promise.resolve({ id: courseId }) })).status).toBe(400);
    expect(publicationService.setVisibility).not.toHaveBeenCalled();
  });

  it("returns only the freshly authenticated actor's account progress", async () => {
    const progress = {
      xpTotal: 500, level: 3, xpToNextLevel: 250,
      publication: { eligible: true, requiredLevel: 3, reasons: [] },
    };
    vi.mocked(readAccountProgress).mockResolvedValueOnce(progress);
    const response = await getProgress(new NextRequest("http://127.0.0.1:3000/api/v1/me/progress"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: progress });
    expect(readAccountProgress).toHaveBeenCalledWith(actor.id);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
  });
});
