import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runRuntimeOperator } from "../../scripts/runtime-capabilities.mjs";
import { runPortabilityOperator } from "../../scripts/provider-proof-portability.mjs";

const folders = [];
const receiptId = "11111111-1111-4111-8111-111111111111";
const derivedId = "22222222-2222-4222-8222-222222222222";
const ref = "abcdefghijklmnopqrst";
const secret = "private-dispatch-secret-which-must-never-be-printed";
const environment = {
  APP_ORIGIN: "https://example.vercel.app", INTERNAL_DISPATCH_SECRET: secret, VERCEL_PROJECT_ID: "prj_Example123",
  SUPABASE_PROJECT_REF: ref, NEXT_PUBLIC_SUPABASE_URL: `https://${ref}.supabase.co`,
  DATABASE_URL: `postgresql://postgres.${ref}:private-password@aws-0-eu-central-1.pooler.supabase.com:6543/postgres`,
  AI_BUDGET_ID: receiptId, OPENROUTER_API_KEY: "private-openrouter-key",
};
const liveTarget = ["--world", "vercel", "--origin", environment.APP_ORIGIN];
const json = value => new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });
const spawnReport = value => ({ status: 0, stdout: `runner preface\n${JSON.stringify(value)}\nrunner footer\n`, stderr: "" });
async function temporaryFolder() {
  const folder = await mkdtemp(join(tmpdir(), "unfurl-operators-"));
  folders.push(folder);
  return folder;
}
afterEach(async () => { await Promise.all(folders.splice(0).map(folder => rm(folder, { recursive: true, force: true }))); });

describe("offline operator planning", () => {
  it.each([[], ["--status"], ["--plan"]].map(args => ({ args })))("does not touch transport or child processes in $args", async ({ args }) => {
    const fetcher = vi.fn(() => { throw new Error("Unexpected network access"); });
    const spawn = vi.fn(() => { throw new Error("Unexpected child process"); });
    const runtime = await runRuntimeOperator(args, { environment: {}, fetcher });
    const provider = await runPortabilityOperator(args, { environment: {}, spawn });
    for (const result of [runtime, provider]) expect(result).toMatchObject({ ok: true, inspection: "configuration-only", networkCalls: 0,
      databaseConnected: false, inferenceCalls: 0, completeFreshBootstrap: false });
    expect(fetcher).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("accepts one explicit env file without requiring private .env files and omits its secrets", async () => {
    const folder = await temporaryFolder();
    const file = join(folder, "settings.env");
    await writeFile(file, `APP_ORIGIN=http://127.0.0.1:3000\nINTERNAL_DISPATCH_SECRET=${secret}\n`);
    const result = await runRuntimeOperator(["--env-file", file], { environment: {} });
    expect(result).toMatchObject({ origin: "http://127.0.0.1:3000", configured: { INTERNAL_DISPATCH_SECRET: true } });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it.each([["--world", "invalid"], ["--world", "local", "--world", "vercel"], ["--plan", "--status"], ["--dispatch"], ["--env-file"], ["--report", "package.json", "--unknown"]].map(args => ({ args })))(
    "rejects invalid options before effects: $args", async ({ args }) => {
      const fetcher = vi.fn();
      await expect(runRuntimeOperator(args, { environment: {}, fetcher })).rejects.toThrow();
      expect(fetcher).not.toHaveBeenCalled();
    });
});

describe("runtime actions", () => {
  it("starts only the dedicated recovery action, sends credentials to the pinned origin, and returns safe identifiers", async () => {
    const fetcher = vi.fn(async () => json({ probeId: receiptId, workflowRunId: "wrun_example", token: secret }));
    const result = await runRuntimeOperator(["--recovery-start", ...liveTarget], { environment, fetcher });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe(`${environment.APP_ORIGIN}/api/internal/dispatch`);
    expect(init).toMatchObject({ method: "POST", redirect: "error", headers: { Authorization: `Bearer ${secret}` } });
    expect(JSON.parse(init.body)).toEqual({ action: "start_recovery_proof" });
    expect(result).toMatchObject({ status: "started", probeId: receiptId, workflowRunId: "wrun_example", inferenceCalls: 0 });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it.each([
    [[], environment],
    [["--world", "vercel", "--origin", "https://other.example"], environment],
    [["--world", "vercel"], { ...environment, APP_ORIGIN: "http://example.vercel.app" }],
    [["--world", "vercel"], { ...environment, APP_ORIGIN: "https://user:password@example.vercel.app" }],
    [["--world", "local"], environment],
    [["--world", "vercel"], { ...environment, INTERNAL_DISPATCH_SECRET: "short" }],
    [["--world", "vercel"], { ...environment, VERCEL_PROJECT_ID: "wrong" }],
  ])("refuses an unbound runtime target before sending a secret", async (args, env) => {
    const fetcher = vi.fn();
    await expect(runRuntimeOperator(["--recovery-start", ...args], { environment: env, fetcher })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("checks only the supplied recovery run and does not certify a different or unreplayed result", async () => {
    const proof = { probeId: receiptId, workflowRunId: "wrun_saved", stepId: "step_1", firstAttempt: 1, attempt: 2, replayed: true, secret };
    const fetcher = vi.fn(async () => json({ status: "completed", proof }));
    const result = await runRuntimeOperator(["--recovery-inspect", "wrun_saved", ...liveTarget], { environment, fetcher });
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ action: "inspect_recovery_proof", workflowRunId: "wrun_saved" });
    expect(result).toMatchObject({ recoveryVerified: true, status: "completed" });
    expect(JSON.stringify(result)).not.toContain(secret);
    for (const patch of [{ workflowRunId: "wrun_other" }, { attempt: 1 }, { replayed: false }]) {
      await expect(runRuntimeOperator(["--recovery-inspect", "wrun_saved", ...liveTarget], { environment,
        fetcher: async () => json({ status: "completed", proof: { ...proof, ...patch } }) })).rejects.toThrow("invalid recovery proof");
    }
  });

  it("reports running and failed workflows honestly without polling or retrying", async () => {
    for (const status of ["running", "failed"]) {
      const fetcher = vi.fn(async () => json({ status }));
      const result = await runRuntimeOperator(["--recovery-inspect", "wrun_saved", ...liveTarget], { environment, fetcher });
      expect(result).toMatchObject({ status, recoveryVerified: false, ok: status === "running" });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });

  it("binds Python evidence to the intended project and freshness without claiming execution", async () => {
    const evidence = { source: "vercel_oidc_signed_claim_v1", projectId: environment.VERCEL_PROJECT_ID, environment: "production", plan: "hobby",
      runtimeProfile: "python-3.14-v1", imageDigest: "a".repeat(64), runnerDigest: "b".repeat(64), runtimeDigest: "c".repeat(64),
      issuedAt: new Date(Date.now() - 60_000).toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), token: secret };
    const fetcher = vi.fn(async () => json({ status: "available", evidence }));
    const result = await runRuntimeOperator(["--python-inspect", ...liveTarget], { environment, fetcher });
    expect(result).toMatchObject({ status: "available", executionVerified: false, sandboxCreated: false });
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ action: "inspect_python_capability" });
    expect(JSON.stringify(result)).not.toContain(secret);
    for (const patch of [{ projectId: "prj_Other" }, { expiresAt: "2020-01-01T00:00:00.000Z" }, { environment: "development" }]) {
      await expect(runRuntimeOperator(["--python-inspect", ...liveTarget], { environment,
        fetcher: async () => json({ status: "available", evidence: { ...evidence, ...patch } }) })).rejects.toThrow("does not match");
    }
  });

  it("refuses to overwrite a report before dispatch and stores only safe completed output", async () => {
    const folder = await temporaryFolder();
    const report = join(folder, "recovery.json");
    const fetcher = vi.fn(async () => json({ probeId: receiptId, workflowRunId: "wrun_saved", secret }));
    await runRuntimeOperator(["--recovery-start", ...liveTarget, "--report", report], { environment, fetcher });
    expect(JSON.parse(await readFile(report, "utf8"))).toMatchObject({ status: "started", workflowRunId: "wrun_saved" });
    expect(await readFile(report, "utf8")).not.toContain(secret);
    await expect(runRuntimeOperator(["--recovery-start", ...liveTarget, "--report", report], { environment, fetcher })).rejects.toThrow("No operation was attempted");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("existing provider proof portability", () => {
  const inventory = { inferenceCalls: 0, sources: [{ id: receiptId, capability: "rubric", model_policy: "kimi-digitalocean-v1",
    observed_at: "2026-10-26T00:00:00.000Z", passed: true, operation_state: "settled", privateValue: secret }] };
  const verified = { applied: false, receiptId: null, capability: "rubric", modelPolicy: "kimi-digitalocean-v1", sourceReceiptId: receiptId,
    sourceWorld: "local", targetWorld: "vercel", sourceObservedAt: "2026-10-26T00:00:00.000Z", checkedAt: "2026-10-26T01:00:00.000Z", inferenceCalls: 0, secret };

  it("lists through only the audited operator and disables inherited paid switches", async () => {
    const spawn = vi.fn(() => spawnReport(inventory));
    const result = await runPortabilityOperator(["--list", ...liveTarget], { environment: { ...environment,
      RUN_PAID_PROVIDER_PROBE: "approved-three-probes-v1", RUN_PAID_COVERAGE_JSON_PROBE: "approved-one", COVERAGE_JSON_OPERATOR: "execute",
      MODEL_POLICY_MAINTENANCE: "execute-approved-one-probe", BUDGET_LEDGER_OPERATOR_MODE: "apply" }, spawn });
    expect(spawn).toHaveBeenCalledTimes(1);
    const [, args, options] = spawn.mock.calls[0];
    expect(args.slice(1)).toEqual(["run", "tests/provider-integration/provider-portability.operator.test.ts", "--disableConsoleIntercept"]);
    expect(options).toMatchObject({ windowsHide: true, timeout: 90_000, env: { PROVIDER_PORTABILITY_OPERATOR: "list" } });
    expect(Object.keys(options.env).some(key => /^(RUN_|COVERAGE_|MODEL_POLICY_|BUDGET_LEDGER_)/.test(key))).toBe(false);
    expect(result.sources).toEqual([{ receiptId, capability: "rubric", modelPolicy: "kimi-digitalocean-v1", observedAt: "2026-10-26T00:00:00.000Z", passed: true, operationState: "settled" }]);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("can inspect local source proofs without treating their loopback app origin as a hosted destination", async () => {
    const spawn = vi.fn(() => spawnReport(inventory));
    const result = await runPortabilityOperator(["--list", "--world", "vercel"], {
      environment: { ...environment, APP_ORIGIN: "http://127.0.0.1:3000" }, spawn,
    });
    expect(result).toMatchObject({ ok: true, origin: null, world: "vercel" });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it.each([["--verify", false], ["--apply-approved", true]])("preserves explicit %s semantics and receipt identity", async (mode, applied) => {
    const spawn = vi.fn(() => spawnReport({ ...verified, applied, receiptId: applied ? derivedId : null }));
    const result = await runPortabilityOperator([mode, receiptId, ...liveTarget], { environment, spawn });
    expect(result).toMatchObject({ applied, requestedReceiptId: receiptId, sourceReceiptId: receiptId, inferenceCalls: 0 });
    expect(spawn.mock.calls[0][2].env).toMatchObject({ PROVIDER_PORTABILITY_OPERATOR: applied ? "apply" : "verify", PROVIDER_PORTABILITY_SOURCE_ID: receiptId });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it.each([
    [["--list"], environment],
    [["--list", "--world", "local"], { ...environment, APP_ORIGIN: "http://localhost:3000" }],
    [["--list", "--world", "vercel"], { ...environment, DATABASE_URL: "postgresql://postgres:secret@unrelated.example:5432/postgres" }],
    [["--list", "--world", "vercel"], { ...environment, NEXT_PUBLIC_SUPABASE_URL: "https://different.supabase.co" }],
    [["--verify", receiptId, "--world", "vercel"], { ...environment, OPENROUTER_API_KEY: "" }],
    [["--apply-approved", "not-a-uuid", "--world", "vercel"], environment],
  ])("refuses an unbound proof target before running source code", async (args, env) => {
    const spawn = vi.fn();
    await expect(runPortabilityOperator(args, { environment: env, spawn })).rejects.toThrow();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("does not expose failed runner output or accept a mismatched operation result", async () => {
    await expect(runPortabilityOperator(["--verify", receiptId, ...liveTarget], { environment,
      spawn: () => ({ status: 1, stdout: secret, stderr: environment.DATABASE_URL }) })).rejects.toThrow("raw output suppressed");
    await expect(runPortabilityOperator(["--verify", receiptId, ...liveTarget], { environment,
      spawn: () => spawnReport({ ...verified, applied: true, receiptId: derivedId }) })).rejects.toThrow("does not match");
  });
});
