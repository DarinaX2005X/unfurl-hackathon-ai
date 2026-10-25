import "server-only";
import { createHash } from "node:crypto";
import { PYTHON_RUNTIME_PROFILE } from "../../../domain/mechanic-families/v3/python";

/** The only runtime profile established by the bounded live proof. */
export { PYTHON_RUNTIME_PROFILE };
export const PYTHON_SANDBOX_IMAGE =
  "vercel/sandbox/python@sha256:3bc79de820271c18e2506c132ce20cc15c6215c0ae5725575b1d8e37ecca0218" as const;
export const PYTHON_SANDBOX_SDK_VERSION = "3.9.0" as const;
export const PYTHON_IMAGE_SHA256 =
  "3bc79de820271c18e2506c132ce20cc15c6215c0ae5725575b1d8e37ecca0218" as const;
export const PYTHON_RUNNER_SHA256 =
  "9702abefd2e0d2ff2da4f7dd16aa845d9d27f346cd4028f407cac647cc464565" as const;

export const PYTHON_PROFILE_LIMITS = Object.freeze({
  sandboxVcpus: 1,
  sandboxMemoryMiB: 2_048,
  sandboxTimeoutMs: 60_000,
  createTimeoutMs: 15_000,
  capabilityTimeoutMs: 5_000,
  commandTimeoutMs: 5_000,
  cleanupTimeoutMs: 15_000,
  uploadTimeoutMs: 8_000,
  outputReadTimeoutMs: 2_000,
  learnerCpuSeconds: 2,
  learnerWallMs: 3_000,
  learnerMemoryBytes: 256 * 1_024 * 1_024,
  scratchBytes: 1_024 * 1_024,
  combinedOutputBytes: 64 * 1_024,
  resultBytes: 16 * 1_024,
  envelopeBytes: 96 * 1_024,
  valueDepth: 12,
  valueNodes: 2_048,
  publicCases: 4,
  hiddenCases: 8,
  /** Authoring validation executes public cases followed by hidden cases once. */
  authoringCases: 12,
  sourceBytes: 12_000,
  sourceLines: 300,
  learnerUid: 60_001,
  learnerGid: 60_001,
});

/** Versioned policy evidence stored beside every durable execution identity. */
export const PYTHON_RUNTIME_POLICY = Object.freeze({
  profile: PYTHON_RUNTIME_PROFILE,
  sdkVersion: PYTHON_SANDBOX_SDK_VERSION,
  image: PYTHON_SANDBOX_IMAGE,
  runnerSha256: PYTHON_RUNNER_SHA256,
  limits: PYTHON_PROFILE_LIMITS,
  sandbox: Object.freeze({ persistent: false, networkPolicy: "deny-all", ports: [] as const, env: {} }),
  isolation: Object.freeze({
    mountNamespace: true,
    chroot: true,
    readOnlyUsr: true,
    seccomp: "x86_64-v1",
    noNewPrivileges: true,
    cgroupLimits: false,
    landlock: false,
  }),
});
export const PYTHON_RUNTIME_DIGEST = createHash("sha256")
  .update(JSON.stringify(PYTHON_RUNTIME_POLICY))
  .digest("hex");

