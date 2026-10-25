import { readFile, mkdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { probeSourceDigest } from "./probe-files.mjs";

const root = process.cwd();
const mode = process.argv[2];
if (!["--prepare", "--execute-approved-three-probes", "--prepare-diagnostic", "--execute-approved-diagnostic", "--replay-saved-diagnostic", "--prepare-search", "--execute-approved-search", "--replay-saved-search"].includes(mode)) {
  throw new Error("Choose --prepare (no inference) or the explicitly approved three-probe execution");
}
if (JSON.parse(await readFile(resolve(root, "package.json"), "utf8")).name !== "unfurl") throw new Error("Wrong workspace");
const proofPath = resolve(root, ".cache/provider-probe-preparation.json");
const reportPath = resolve(root, ".cache/provider-probe-checks.json");
await mkdir(resolve(root, ".cache"), { recursive: true });

function run(args, env) {
  const result = spawnSync(process.execPath, ["--env-file=.env", "--env-file=.env.local",
    "node_modules/vitest/vitest.mjs", "run", ...args], {
    cwd: root, env: { ...process.env, ...env }, stdio: "inherit", windowsHide: true,
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
if (mode === "--prepare-diagnostic") {
  const before = await probeSourceDigest(root);
  run(["tests/provider-integration/error-receipt.test.ts", "tests/provider-integration/openrouter.test.ts", "tests/provider-integration/diagnostic-preparation.test.ts","tests/budget/post-terminal.live.test.ts","tests/budget/admission.test.ts",
    "--reporter=json", "--outputFile=" + reportPath], { RUN_DIAGNOSTIC_PREPARE: "1", RUN_LIVE_TERMINAL_LEDGER:"1", WRITE_SCHEMA_DIAGNOSTIC: "1", RUN_PAID_DIAGNOSTIC: "", RUN_PAID_PROVIDER_PROBE: "" });
  const report = JSON.parse(await readFile(reportPath,"utf8"));
  if (report.numFailedTests !== 0 || report.numPassedTests !== 32 || report.success !== true) throw new Error("Diagnostic preparation failed");
  const digest = await probeSourceDigest(root); if (digest !== before) throw new Error("Source changed during preparation");
  await writeFile(resolve(root,".cache/provider-diagnostic-preparation.json"),JSON.stringify({version:4,kind:"single-diagnostic",sourceDigest:digest,
    observedAt:new Date().toISOString(),passedTests:32,maxPaidCalls:1,maxProbeMicroUsd:"162612"},null,2));
  console.log(JSON.stringify({prepared:true,inferenceCalls:0,passedTests:32,maxApprovedMicroUsd:"162612"}));
} else if(mode === "--prepare-search"){
  const before=await probeSourceDigest(root);
  run(["tests/provider-integration/accounting.test.ts","tests/provider-integration/search-preparation.test.ts","--reporter=json","--outputFile="+reportPath],{RUN_SEARCH_PREPARE:"1",RUN_PAID_SEARCH:"",RUN_PAID_DIAGNOSTIC:"",RUN_PAID_PROVIDER_PROBE:""});
  const report=JSON.parse(await readFile(reportPath,"utf8"));if(report.numFailedTests!==0||report.numPassedTests!==5||report.success!==true)throw new Error("Search preparation failed");
  const sourceDigest=await probeSourceDigest(root);if(sourceDigest!==before)throw new Error("Source changed during preparation");
  await writeFile(resolve(root,".cache/provider-search-preparation.json"),JSON.stringify({version:1,kind:"single-search",sourceDigest,observedAt:new Date().toISOString(),passedTests:5,maxPaidCalls:1,maxProbeMicroUsd:"330224"},null,2));
  console.log(JSON.stringify({prepared:true,inferenceCalls:0,passedTests:5,reusedPriorBudgetChecks:32,maxApprovedMicroUsd:"330224"}));
} else if(mode === "--execute-approved-search"){
  const path=resolve(root,".cache/provider-search-preparation.json"),proof=JSON.parse(await readFile(path,"utf8"));
  if(proof.version!==1||proof.kind!=="single-search"||proof.passedTests!==5||proof.maxPaidCalls!==1||proof.maxProbeMicroUsd!=="330224"||Date.now()-Date.parse(proof.observedAt)>1800000||await probeSourceDigest(root)!==proof.sourceDigest)throw new Error("Fresh unchanged search proof required");
  run(["tests/provider-integration/search.live.test.ts"],{RUN_PAID_SEARCH:"approved-one-search-v1",SEARCH_PREPARATION_PATH:path,RUN_PAID_DIAGNOSTIC:"",RUN_PAID_PROVIDER_PROBE:""});
} else if(mode === "--replay-saved-search"){
  run(["tests/provider-integration/search.live.test.ts"],{RUN_PAID_SEARCH:"approved-one-search-v1",REPLAY_SEARCH_ONLY:"1",SEARCH_PREPARATION_PATH:resolve(root,".cache/provider-search-preparation.json"),RUN_PAID_DIAGNOSTIC:"",RUN_PAID_PROVIDER_PROBE:""});
} else if (mode === "--execute-approved-diagnostic") {
  const path = resolve(root,".cache/provider-diagnostic-preparation.json"); const proof = JSON.parse(await readFile(path,"utf8"));
  if(proof.version!==4||proof.kind!=="single-diagnostic"||proof.passedTests!==32||proof.maxPaidCalls!==1||proof.maxProbeMicroUsd!=="162612"||
    Date.now()-Date.parse(proof.observedAt)>30*60*1000||await probeSourceDigest(root)!==proof.sourceDigest)throw new Error("Fresh unchanged diagnostic proof required");
  run(["tests/provider-integration/diagnostic.live.test.ts"],{RUN_PAID_DIAGNOSTIC:"approved-one-diagnostic-v4",DIAGNOSTIC_PREPARATION_PATH:path,RUN_PAID_PROVIDER_PROBE:""});
} else if(mode === "--replay-saved-diagnostic"){
  run(["tests/provider-integration/diagnostic.live.test.ts"],{RUN_PAID_DIAGNOSTIC:"approved-one-diagnostic-v4",REPLAY_DIAGNOSTIC_ONLY:"1",DIAGNOSTIC_PREPARATION_PATH:resolve(root,".cache/provider-diagnostic-preparation.json"),RUN_PAID_PROVIDER_PROBE:""});
} else if (mode === "--prepare") {
  const before = await probeSourceDigest(root);
  run(["tests/budget/postgres.live.test.ts", "tests/provider-integration/research.live.test.ts",
    "--reporter=json", "--outputFile=" + reportPath],
  { RUN_LIVE_LEDGER: "1", RUN_LIVE_RESEARCH: "1", RUN_PAID_PROVIDER_PROBE: "" });
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  if (report.numFailedTests !== 0 || report.numPassedTests !== 6 || report.success !== true) throw new Error("Preparation checks did not all pass");
  const digest = await probeSourceDigest(root);
  if (digest !== before) throw new Error("Source changed during preparation; rerun the preparation against a stable slice");
  await writeFile(proofPath, JSON.stringify({ version: 1, sourceDigest: digest, observedAt: new Date().toISOString(),
    passedTests: 6, checks: ["real_ledger_idempotency", "unknown_holds_slots", "campaign_probe_caps", "truthful_overrun_halt",
      "real_competing_connection_lock", "pinned_primary_source_and_passage_storage"], maxPaidCalls: 3, maxProbeMicroUsd: "655448" }, null, 2));
  console.log(JSON.stringify({ prepared: true, inferenceCalls: 0, passedTests: 6, maxApprovedMicroUsd: "655448" }));
} else {
  const proof = JSON.parse(await readFile(proofPath, "utf8"));
  if (proof.version !== 1 || proof.passedTests !== 6 || proof.maxPaidCalls !== 3 || proof.maxProbeMicroUsd !== "655448" ||
    Date.now() - Date.parse(proof.observedAt) > 30 * 60 * 1000 || await probeSourceDigest(root) !== proof.sourceDigest) {
    throw new Error("Fresh unchanged preparation proof required");
  }
  run(["tests/provider-integration/probe.live.test.ts"], {
    RUN_PAID_PROVIDER_PROBE: "approved-three-probes-v1", PROBE_PREPARATION_PATH: proofPath,
  });
}
