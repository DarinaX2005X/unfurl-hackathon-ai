import "server-only";
import { Sandbox } from "@vercel/sandbox";
import type {
  PythonSandbox,
  PythonSandboxCommand,
  PythonSandboxCreateInput,
  PythonSandboxSdk,
  PythonSandboxSession,
} from "./sdk";

function wrapSession(session: ReturnType<Sandbox["currentSession"]>): PythonSandboxSession {
  return {
    get sessionId() { return session.sessionId; },
    get status() { return session.status; },
    get timeout() { return session.timeout; },
    get networkPolicy() { return session.networkPolicy; },
    get sourceSnapshotId() { return session.sourceSnapshotId ?? null; },
    get memory() { return session.memory; },
    get vcpus() { return session.vcpus; },
    get region() { return session.region; },
    writeFiles(files, options) {
      return session.writeFiles(files.map((file) => ({ ...file })), options);
    },
    async runCommand(input): Promise<PythonSandboxCommand> {
      return session.runCommand({
        cmd: input.cmd,
        args: [...input.args],
        sudo: input.sudo,
        timeoutMs: input.timeoutMs,
        detached: false,
        onStart: input.onStart,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
    },
    async stop(options) {
      const stopped = await session.stop(options);
      return { session: {
        status: stopped.session.status,
        stoppedAt: stopped.session.stoppedAt ?? null,
      } };
    },
  };
}

function wrapSandbox(sandbox: Sandbox): PythonSandbox {
  const session = wrapSession(sandbox.currentSession());
  return {
    get name() { return sandbox.name; },
    get image() { return sandbox.image ?? ""; },
    get persistent() { return sandbox.persistent; },
    get routes() { return sandbox.routes; },
    currentSession() { return session; },
    delete(options) { return sandbox.delete(options); },
  };
}

/** Concrete SDK boundary. Returned objects expose no auto-resuming Sandbox methods. */
export class VercelPythonSandboxSdk implements PythonSandboxSdk {
  constructor(private readonly fetcher: typeof fetch = fetch) {}

  async create(input: PythonSandboxCreateInput): Promise<PythonSandbox> {
    const sandbox = await Sandbox.create({
      name: input.name,
      image: input.image,
      resources: { vcpus: input.resources.vcpus },
      timeout: input.timeout,
      persistent: input.persistent,
      networkPolicy: input.networkPolicy,
      ports: [],
      env: {},
      tags: { ...input.tags },
      token: input.token,
      teamId: input.teamId,
      projectId: input.projectId,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    return wrapSandbox(sandbox);
  }

  async deleteExact(input: Parameters<PythonSandboxSdk["deleteExact"]>[0]): Promise<"deleted" | "not_found"> {
    const url = new URL(`https://api.vercel.com/v2/sandboxes/${encodeURIComponent(input.name)}`);
    url.searchParams.set("teamId", input.teamId);
    url.searchParams.set("projectId", input.projectId);
    url.searchParams.set("deleteOrphanSnapshots", "true");
    const response = await this.fetcher(url, {
      method: "DELETE",
      headers: { authorization: `Bearer ${input.token}` },
      signal: input.signal,
    });
    if (response.status === 404) return "not_found";
    if (!response.ok) throw new Error(`Exact sandbox delete failed (${response.status})`);
    return "deleted";
  }
}

