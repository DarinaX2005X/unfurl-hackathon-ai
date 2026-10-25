import "server-only";
import { VercelOidcPythonCapabilityGate } from "./capability";
import type { PythonExecutionPersistence, PythonExecutionPort } from "./contracts";
import { VercelPythonExecutionPort } from "./vercel";
import { VercelPythonSandboxSdk } from "./vercel-sdk";

/**
 * Builds a job-scoped runtime from its two durable authorities. Callers bind
 * the returned port to one immutable job/input; no process-global executor is
 * retained and no SDK object crosses this boundary.
 */
export function createPythonExecutionPort(input: {
  readonly persistence: PythonExecutionPersistence;
  /** Exact linked project ID, normally VERCEL_PROJECT_ID. This is not a secret. */
  readonly projectId: string;
}): PythonExecutionPort {
  return new VercelPythonExecutionPort(
    input.persistence,
    new VercelOidcPythonCapabilityGate(input.projectId),
    new VercelPythonSandboxSdk(),
  );
}

export {
  buildPythonExecutionRequest,
  pythonExecutionRequestDigest,
  pythonSourceDigest,
  validatePythonExecutionRequest,
} from "./contracts";
export type {
  ExecutionResult,
  PythonEvaluationPort,
  PythonExecutionPersistence,
  PythonExecutionPort,
  PythonExecutionRequest,
  PythonExecutionRequestDraft,
} from "./contracts";
