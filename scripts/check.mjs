import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const bins = {
  next: require.resolve("next/dist/bin/next"),
  typescript: require.resolve("typescript/bin/tsc"),
  eslint: resolve(dirname(require.resolve("eslint/package.json")), "bin/eslint.js"),
  vitest: resolve(dirname(require.resolve("vitest/package.json")), "vitest.mjs"),
};
const checks = {
  typecheck: [[bins.next, "typegen"], [bins.typescript, "--noEmit"]],
  lint: [[bins.eslint, "."]],
  test: [[bins.vitest, "run"]],
  build: [[bins.next, "build"]],
};
const requested = process.argv.slice(2);
const selected = requested.length ? requested : Object.keys(checks);

for (const name of selected) {
  if (!Object.hasOwn(checks, name)) {
    process.stderr.write(`Unknown check: ${name}\n`);
    process.exit(2);
  }
  process.stdout.write(`\nRunning ${name}\n`);
  for (const args of checks[name]) {
    const result = spawnSync(process.execPath, args, {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
    });
    if (result.error) {
      process.stderr.write(`${result.error.message}\n`);
      process.exit(1);
    }
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}
