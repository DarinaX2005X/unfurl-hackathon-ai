import "server-only";
import { getVercelOidcToken, verifyVercelOidcToken } from "@vercel/oidc";
import {
  PYTHON_IMAGE_SHA256,
  PYTHON_RUNNER_SHA256,
  PYTHON_RUNTIME_DIGEST,
  PYTHON_RUNTIME_PROFILE,
  PYTHON_SANDBOX_IMAGE,
} from "./profile";
import type { PythonSandboxCapabilityEvidence, PythonSandboxCapabilityGate } from "./sdk";

export interface PythonOidcTokenProvider {
  get(input: { projectId: string }): Promise<string>;
}

interface PythonOidcPayload {
  readonly owner_id?: unknown;
  readonly project_id?: unknown;
  readonly environment?: unknown;
  readonly iss?: unknown;
  readonly sub?: unknown;
  readonly iat?: unknown;
  readonly exp?: unknown;
  /** Signed and observed in current Vercel tokens, but not a documented OIDC compatibility guarantee. */
  readonly plan?: unknown;
}

export interface PythonOidcVerifier {
  verify(token: string, input: {
    projectId: string;
    environment: Array<"production" | "preview" | "development">;
  }): Promise<{ payload: PythonOidcPayload }>;
}

const runtimeTokenProvider: PythonOidcTokenProvider = {
  get: ({ projectId }) => getVercelOidcToken({
    project: projectId,
    expirationBufferMs: 60_000,
  }),
};

const runtimeVerifier: PythonOidcVerifier = {
  verify: (token, input) => verifyVercelOidcToken<PythonOidcPayload>(token, input),
};

function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
}

function oidcTime(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) return null;
  const date = new Date(value * 1_000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function boundedString(value: unknown, maximum: number): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= maximum ? value : null;
}

function evidenceFrom(
  payload: PythonOidcPayload,
  expectedProjectId: string,
): PythonSandboxCapabilityEvidence | "plan" | null {
  if (payload.plan !== "hobby") return "plan";
  const teamId = boundedString(payload.owner_id, 128);
  const projectId = boundedString(payload.project_id, 128);
  const environment = payload.environment;
  const issuer = boundedString(payload.iss, 512);
  const subject = boundedString(payload.sub, 512);
  const issuedAt = oidcTime(payload.iat);
  const expiresAt = oidcTime(payload.exp);
  if (teamId === null || !/^team_[A-Za-z0-9]+$/.test(teamId) || projectId !== expectedProjectId ||
      environment !== "production" && environment !== "preview" && environment !== "development" ||
      issuer === null || subject === null ||
      issuedAt === null || expiresAt === null || Date.parse(expiresAt) <= Date.parse(issuedAt)) return null;
  return {
    source: "vercel_oidc_signed_claim_v1",
    teamId,
    projectId,
    environment,
    issuer,
    subject,
    issuedAt,
    expiresAt,
    plan: "hobby",
    runtimeProfile: PYTHON_RUNTIME_PROFILE,
    image: PYTHON_SANDBOX_IMAGE,
    imageDigest: PYTHON_IMAGE_SHA256,
    runnerDigest: PYTHON_RUNNER_SHA256,
    runtimeDigest: PYTHON_RUNTIME_DIGEST,
  };
}

/**
 * Vercel's signed OIDC identity is the runtime authority. The signed `plan`
 * claim is deliberately treated as a fail-closed compatibility contract: it
 * must be exactly `hobby`, and its absence disables Sandbox dispatch.
 */
export class VercelOidcPythonCapabilityGate implements PythonSandboxCapabilityGate {
  constructor(
    private readonly expectedProjectId: string,
    private readonly tokens: PythonOidcTokenProvider = runtimeTokenProvider,
    private readonly verifier: PythonOidcVerifier = runtimeVerifier,
  ) {
    if (!/^prj_[A-Za-z0-9]+$/.test(expectedProjectId) || expectedProjectId.length > 128) {
      throw new Error("Invalid Vercel project identity");
    }
  }

  async inspect(signal: AbortSignal) {
    try {
      const token = await withAbort(this.tokens.get({ projectId: this.expectedProjectId }), signal);
      const verified = await withAbort(this.verifier.verify(token, {
        projectId: this.expectedProjectId,
        environment: ["production", "preview", "development"],
      }), signal);
      const evidence = evidenceFrom(verified.payload, this.expectedProjectId);
      if (evidence === "plan") return { status: "unavailable", reason: "plan" } as const;
      if (evidence === null) return { status: "unavailable", reason: "auth" } as const;
      return {
        status: "available",
        credentials: { token, teamId: evidence.teamId, projectId: evidence.projectId },
        evidence,
      } as const;
    } catch {
      if (signal.aborted) throw signal.reason;
      return { status: "unavailable", reason: "auth" } as const;
    }
  }
}
