#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const reportPath = path.join(root, ".cache", "budget-ledger-state-relative-proof.json");
const [command = "--dry-run", approval, ...extra] = process.argv.slice(2);

if (extra.length > 0 || !["--dry-run", "--prove", "--apply-approved"].includes(command) ||
    (command === "--apply-approved" && !/^[a-f0-9]{64}$/.test(approval ?? "")) ||
    (command !== "--apply-approved" && approval !== undefined)) {
  console.error("Usage: node scripts/budget-ledger-proof.mjs [--dry-run | --prove | --apply-approved <report-sha256>]");
  process.exitCode = 2;
} else if (command === "--dry-run") {
  console.log(JSON.stringify({
    mode: "dry-run",
    databaseConnected: false,
    durableWrites: false,
    reportPath,
    proof: "Five state-relative PostgresBudget scenarios run under BEGIN/ROLLBACK with per-operation SAVEPOINTs.",
    apply: "A separate --apply-approved command must carry the exact reviewed report SHA-256; it re-proves unchanged state before two vercel budget_accounting receipts are written.",
  }, null, 2));
} else {
  const environment = { ...process.env,
    BUDGET_LEDGER_OPERATOR_MODE: command === "--prove" ? "prove" : "apply",
    BUDGET_LEDGER_REPORT_PATH: reportPath,
    ...(command === "--apply-approved" ? { BUDGET_LEDGER_APPROVED_SHA256: approval } : {}),
  };
  // This operator has no provider transport path. Do not forward credentials anyway.
  for (const key of ["OPENROUTER_API_KEY", "DIGITALOCEAN_API_TOKEN", "GOOGLE_API_KEY", "GEMINI_API_KEY"]) delete environment[key];
  const vitest = path.join(root, "node_modules", "vitest", "vitest.mjs");
  const child = spawn(process.execPath, [vitest, "run", "tests/budget/ledger-proof.operator.test.ts", "--reporter=verbose"], {
    cwd: root,
    env: environment,
    stdio: "inherit",
    windowsHide: true,
  });
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => signal ? reject(new Error(`Ledger proof terminated by ${signal}`)) : resolve(code ?? 1));
  });
  if (exitCode !== 0) process.exitCode = exitCode;
  else if (command === "--prove") {
    const report = await readFile(reportPath);
    console.log(JSON.stringify({ reportPath, reportSha256: createHash("sha256").update(report).digest("hex"), nextStep: "Review the report, then pass this exact hash to --apply-approved." }));
  }
}
