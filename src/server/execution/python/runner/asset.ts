import "server-only";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PYTHON_RUNNER_SHA256 } from "../profile";

const RUNNER_PATH = join(
  process.cwd(),
  "src",
  "server",
  "execution",
  "python",
  "runner",
  "guest_runner.py",
);

let verifiedRunner: Promise<Uint8Array> | undefined;

/** Read once, return a copy, and fail closed if packaging or bytes drift. */
export function loadVerifiedPythonRunner(): Promise<Uint8Array> {
  verifiedRunner ??= readFile(RUNNER_PATH).then((bytes) => {
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== PYTHON_RUNNER_SHA256) throw new Error("Python runner digest mismatch");
    return new Uint8Array(bytes);
  });
  return verifiedRunner.then((bytes) => bytes.slice());
}

