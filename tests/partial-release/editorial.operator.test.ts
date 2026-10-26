import { readFile } from "node:fs/promises";
import { it, vi } from "vitest";
import { Client } from "pg";
vi.mock("server-only", () => ({}));
import { EditorialReleaseInputSchema, releaseEditorialFirstSection } from "../../src/server/course-materialization/editorial";
import { getMechanicRuntimeCapabilities } from "../../src/server/runs/composition";

it.skipIf(process.env.EDITORIAL_COURSE_RELEASE_OPERATOR !== "1")("previews or releases curated section using real deterministic evaluation and saved source evidence", async () => {
  let stage = "input", client: Client | undefined;
  try {
    const input = EditorialReleaseInputSchema.parse(JSON.parse(process.env.EDITORIAL_COURSE_RELEASE_INPUT ?? ""));
    const content = JSON.parse(await readFile(process.env.EDITORIAL_COURSE_RELEASE_CONTENT!, "utf8"));
    const runtime = await getMechanicRuntimeCapabilities();
    const url = new URL(process.env.DIRECT_DATABASE_URL!);
    for (const name of ["sslmode", "sslrootcert", "sslcert", "sslkey"]) url.searchParams.delete(name);
    client = new Client({ connectionString: url.toString(), connectionTimeoutMillis: 10_000,
      ssl: { rejectUnauthorized: true, ...(process.env.DATABASE_SSL_CA ? { ca: process.env.DATABASE_SSL_CA.replace(/\\n/g, "\n") } : {}) },
      application_name: "unfurl-editorial-section-release" });
    stage = "connect"; await client.connect();
    await client.query(input.applyDigest ? "BEGIN" : "BEGIN READ ONLY");
    await client.query("SET LOCAL statement_timeout='30s'; SET LOCAL lock_timeout='10s'");
    stage = "validate_editorial_section";
    const report = await releaseEditorialFirstSection(client, input, content, runtime);
    stage = input.applyDigest ? "commit" : "finish_preview";
    await client.query(input.applyDigest ? "COMMIT" : "ROLLBACK");
    console.log(JSON.stringify(report));
  } catch (error) {
    await client?.query("ROLLBACK").catch(() => undefined);
    const reason = error instanceof Error && error.message.startsWith("Editorial release rejected:") ? error.message : undefined;
    console.log(JSON.stringify({ kind: "editorial-course-release-error", stage, inferenceCalls: 0, ...(reason ? { reason } : {}) }));
    throw new Error(`Editorial release rejected at ${stage}.`);
  } finally { await client?.end(); }
}, 580_000);
