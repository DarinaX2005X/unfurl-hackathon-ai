import "server-only";

/**
 * Deliberately narrower than @vercel/sandbox. The adapter cannot reach any
 * auto-resuming Sandbox method after creation.
 */
export interface PythonSandboxCommand {
  readonly cmdId: string;
  readonly exitCode: number;
  readonly durationMs?: number;
  stdout(options?: { signal?: AbortSignal }): Promise<string>;
  stderr(options?: { signal?: AbortSignal }): Promise<string>;
}

export interface PythonSandboxStartedCommand {
  readonly cmdId: string;
}

export interface PythonSandboxSession {
  readonly sessionId: string;
  readonly status: string;
  readonly timeout: number;
  readonly networkPolicy: unknown;
  readonly sourceSnapshotId: string | null;
  readonly memory: number;
  readonly vcpus: number;
  readonly region: string;
  writeFiles(
    files: readonly { path: string; content: string | Uint8Array; mode?: number }[],
    options?: { signal?: AbortSignal },
  ): Promise<void>;
  runCommand(input: {
    cmd: string;
    args: string[];
    sudo: true;
    timeoutMs: number;
    signal?: AbortSignal;
    detached?: false;
    onStart(command: PythonSandboxStartedCommand): void | Promise<void>;
  }): Promise<PythonSandboxCommand>;
  stop(options?: { signal?: AbortSignal }): Promise<{
    session: {
      status: string;
      stoppedAt: number | null;
    };
  }>;
}

export interface PythonSandbox {
  readonly name: string;
  readonly image: string;
  readonly persistent: boolean;
  readonly routes: readonly unknown[];
  currentSession(): PythonSandboxSession;
  delete(options?: { deleteOrphanSnapshots?: boolean; signal?: AbortSignal }): Promise<void>;
}

export interface PythonSandboxCredentials {
  readonly token: string;
  readonly teamId: string;
  readonly projectId: string;
}

export interface PythonSandboxCapabilityEvidence {
  readonly source: "vercel_oidc_signed_claim_v1";
  readonly teamId: string;
  readonly projectId: string;
  readonly environment: "production" | "preview" | "development";
  readonly issuer: string;
  readonly subject: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly plan: "hobby";
  readonly runtimeProfile: string;
  readonly image: string;
  readonly imageDigest: string;
  readonly runnerDigest: string;
  readonly runtimeDigest: string;
}

export interface PythonSandboxCreateInput extends PythonSandboxCredentials {
  readonly name: string;
  readonly image: string;
  readonly resources: { readonly vcpus: 1 };
  readonly timeout: 60_000;
  readonly persistent: false;
  readonly networkPolicy: "deny-all";
  readonly ports: readonly [];
  readonly env: Readonly<Record<string, never>>;
  readonly tags: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}

export interface PythonSandboxSdk {
  create(input: PythonSandboxCreateInput): Promise<PythonSandbox>;
  /** Exact-name lookup/delete through the provider API; it must never resume. */
  deleteExact(
    input: PythonSandboxCredentials & { readonly name: string; readonly signal: AbortSignal },
  ): Promise<"deleted" | "not_found">;
}

export type PythonCapabilityDecision =
  | {
      readonly status: "available";
      readonly credentials: PythonSandboxCredentials;
      readonly evidence: PythonSandboxCapabilityEvidence;
    }
  | {
      readonly status: "unavailable";
      readonly reason: "disabled" | "auth" | "plan" | "quota" | "provider";
    };

/** Must prove Hobby/no-overage and the configured owner/project before returning credentials. */
export interface PythonSandboxCapabilityGate {
  inspect(signal: AbortSignal): Promise<PythonCapabilityDecision>;
}


