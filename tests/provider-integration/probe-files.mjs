import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export async function probeSourceDigest(root) {
  const files = [
    "src/server/runs/identity.ts", "src/server/evaluation/contracts.ts", "src/domain/common.ts",
  ];
  async function collect(relative) {
    for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
      const path = relative + "/" + entry.name;
      if (entry.isDirectory()) await collect(path);
      else if (/\.(ts|mjs)$/.test(entry.name)) files.push(path);
    }
  }
  for (const directory of ["src/server/ai", "src/server/budget", "src/server/research", "tests/budget", "tests/provider-integration"]) await collect(directory);
  const hash = createHash("sha256");
  for (const file of files.sort()) hash.update(file).update("\0").update(await readFile(join(root, file))).update("\0");
  return hash.digest("hex");
}
