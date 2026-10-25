import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { Sandbox } from "@vercel/sandbox";
import { VercelPythonSandboxSdk } from "../../../src/server/execution/python/vercel-sdk";
import { PYTHON_SANDBOX_IMAGE } from "../../../src/server/execution/python/profile";

function createInput() {
  return {
    name: "unfurl-py-00000000000040008000000000000001",
    image: PYTHON_SANDBOX_IMAGE,
    resources: { vcpus: 1 as const },
    timeout: 60_000 as const,
    persistent: false as const,
    networkPolicy: "deny-all" as const,
    ports: [] as const,
    env: {} as const,
    tags: { purpose: "unfurl-python-execution" },
    token: "host-only-token",
    teamId: "team_1",
    projectId: "project_1",
    signal: new AbortController().signal,
  };
}

describe("Vercel Sandbox SDK boundary", () => {
  it("captures only the existing current session and passes a credential-free VM environment", async () => {
    const session = {
      sessionId: "session_1", status: "running", timeout: 60_000, networkPolicy: "deny-all",
      sourceSnapshotId: null, memory: 2_048, vcpus: 1, region: "iad1",
      writeFiles: vi.fn(async () => undefined), runCommand: vi.fn(),
      stop: vi.fn(async () => ({ session: { status: "stopped", stoppedAt: Date.now() } })),
    };
    const provider = {
      name: createInput().name, image: PYTHON_SANDBOX_IMAGE, persistent: false, routes: [],
      currentSession: vi.fn(() => session), delete: vi.fn(async () => undefined),
    };
    const create = vi.spyOn(Sandbox, "create").mockResolvedValueOnce(
      provider as unknown as Awaited<ReturnType<typeof Sandbox.create>>,
    );
    const sdk = new VercelPythonSandboxSdk();
    const sandbox = await sdk.create(createInput());
    const first = sandbox.currentSession();
    const second = sandbox.currentSession();
    expect(first).toBe(second);
    expect(provider.currentSession).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      name: createInput().name,
      token: "host-only-token",
      teamId: "team_1",
      projectId: "project_1",
      image: PYTHON_SANDBOX_IMAGE,
      networkPolicy: "deny-all",
      ports: [],
      env: {},
      persistent: false,
    }));
    const providerInput = create.mock.calls[0]?.[0];
    expect(providerInput).toBeDefined();
    if (providerInput === undefined) throw new Error("Sandbox.create was not called");
    expect(JSON.stringify(providerInput.env)).not.toContain("host-only-token");
    expect(Object.keys(providerInput.env ?? {})).toEqual([]);
    create.mockRestore();
  });

  it("reconciles an ambiguous create with one exact-name DELETE and no SDK lookup", async () => {
    const calls: Array<{ url: URL; init: RequestInit }> = [];
    const fetcher = (async (url: URL | RequestInfo, init?: RequestInit) => {
      calls.push({ url: new URL(url.toString()), init: init ?? {} });
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const sdk = new VercelPythonSandboxSdk(fetcher);
    const controller = new AbortController();
    await expect(sdk.deleteExact({
      name: createInput().name, token: "host-only-token", teamId: "team_1", projectId: "project_1", signal: controller.signal,
    })).resolves.toBe("deleted");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.origin + calls[0]!.url.pathname).toBe(`https://api.vercel.com/v2/sandboxes/${createInput().name}`);
    expect(calls[0]!.url.searchParams.get("teamId")).toBe("team_1");
    expect(calls[0]!.url.searchParams.get("projectId")).toBe("project_1");
    expect(calls[0]!.url.searchParams.get("deleteOrphanSnapshots")).toBe("true");
    expect(calls[0]!.init).toMatchObject({ method: "DELETE", headers: { authorization: "Bearer host-only-token" }, signal: controller.signal });
  });

  it("treats exact-name 404 as confirmed absence and fails closed on other errors", async () => {
    const notFound = new VercelPythonSandboxSdk((async () => new Response(null, { status: 404 })) as typeof fetch);
    await expect(notFound.deleteExact({
      name: createInput().name, token: "token", teamId: "team", projectId: "project", signal: new AbortController().signal,
    })).resolves.toBe("not_found");
    const failure = new VercelPythonSandboxSdk((async () => new Response(null, { status: 503 })) as typeof fetch);
    await expect(failure.deleteExact({
      name: createInput().name, token: "token", teamId: "team", projectId: "project", signal: new AbortController().signal,
    })).rejects.toThrow(/503/);
  });
});
