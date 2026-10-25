import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import {
  VercelOidcPythonCapabilityGate,
  type PythonOidcTokenProvider,
  type PythonOidcVerifier,
} from "../../../src/server/execution/python/capability";
import {
  PYTHON_IMAGE_SHA256,
  PYTHON_RUNNER_SHA256,
  PYTHON_RUNTIME_DIGEST,
  PYTHON_RUNTIME_PROFILE,
  PYTHON_SANDBOX_IMAGE,
} from "../../../src/server/execution/python/profile";

const projectId = "prj_gyuE8ImEMJDPOXQ6hDrWLbrDahtN";
const teamId = "team_XPsY81jSuTAb46ATvV7pMNAr";
const issuedAt = Date.parse("2026-10-25T00:00:00.000Z") / 1_000;
const expiresAt = Date.parse("2026-10-25T01:00:00.000Z") / 1_000;

function payload(overrides: Record<string, unknown> = {}) {
  return {
    owner_id: teamId,
    project_id: projectId,
    environment: "production",
    iss: "https://oidc.vercel.com/team",
    sub: "owner:team:project:unfurl:environment:production",
    iat: issuedAt,
    exp: expiresAt,
    plan: "hobby",
    ...overrides,
  };
}

function harness(overrides: Record<string, unknown> = {}) {
  const get = vi.fn(async () => "signed-oidc-token");
  const verify = vi.fn(async () => ({ payload: payload(overrides) }));
  const gate = new VercelOidcPythonCapabilityGate(
    projectId,
    { get } satisfies PythonOidcTokenProvider,
    { verify } satisfies PythonOidcVerifier,
  );
  return { gate, get, verify };
}

describe("Python sandbox capability gate", () => {
  it("rejects a missing or malformed linked project identity at composition", () => {
    expect(() => new VercelOidcPythonCapabilityGate("")).toThrow(/project identity/i);
    expect(() => new VercelOidcPythonCapabilityGate("team_wrong_kind")).toThrow(/project identity/i);
  });

  it("derives credentials and durable sanitized evidence only from a verified exact-project Hobby token", async () => {
    const h = harness();
    const decision = await h.gate.inspect(new AbortController().signal);
    expect(decision).toEqual({
      status: "available",
      credentials: { token: "signed-oidc-token", teamId, projectId },
      evidence: {
        source: "vercel_oidc_signed_claim_v1",
        teamId,
        projectId,
        environment: "production",
        issuer: "https://oidc.vercel.com/team",
        subject: "owner:team:project:unfurl:environment:production",
        issuedAt: "2026-10-25T00:00:00.000Z",
        expiresAt: "2026-10-25T01:00:00.000Z",
        plan: "hobby",
        runtimeProfile: PYTHON_RUNTIME_PROFILE,
        image: PYTHON_SANDBOX_IMAGE,
        imageDigest: PYTHON_IMAGE_SHA256,
        runnerDigest: PYTHON_RUNNER_SHA256,
        runtimeDigest: PYTHON_RUNTIME_DIGEST,
      },
    });
    expect(h.get).toHaveBeenCalledWith({ projectId });
    expect(h.verify).toHaveBeenCalledWith("signed-oidc-token", {
      projectId, environment: ["production", "preview", "development"],
    });
    if (decision.status !== "available") throw new Error("Capability unexpectedly unavailable");
    expect(JSON.stringify(decision.evidence)).not.toContain("signed-oidc-token");
  });

  it("fails closed when the signed compatibility plan claim is missing or is not Hobby", async () => {
    await expect(harness({ plan: undefined }).gate.inspect(new AbortController().signal))
      .resolves.toEqual({ status: "unavailable", reason: "plan" });
    await expect(harness({ plan: "pro" }).gate.inspect(new AbortController().signal))
      .resolves.toEqual({ status: "unavailable", reason: "plan" });
  });

  it("rejects malformed or mismatched verified identity evidence", async () => {
    await expect(harness({ project_id: "prj_other" }).gate.inspect(new AbortController().signal))
      .resolves.toEqual({ status: "unavailable", reason: "auth" });
    await expect(harness({ environment: "other" }).gate.inspect(new AbortController().signal))
      .resolves.toEqual({ status: "unavailable", reason: "auth" });
    await expect(harness({ exp: issuedAt }).gate.inspect(new AbortController().signal))
      .resolves.toEqual({ status: "unavailable", reason: "auth" });
  });

  it("maps token or signature failure to auth without exposing provider details", async () => {
    const h = harness();
    h.verify.mockRejectedValueOnce(new Error("signature internals"));
    await expect(h.gate.inspect(new AbortController().signal)).resolves.toEqual({ status: "unavailable", reason: "auth" });
  });

  it("propagates caller cancellation instead of relabeling it as authentication failure", async () => {
    const h = harness();
    h.get.mockImplementationOnce(() => new Promise<string>(() => undefined));
    const controller = new AbortController();
    const pending = h.gate.inspect(controller.signal);
    const reason = new DOMException("cancelled", "AbortError");
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
  });
});
