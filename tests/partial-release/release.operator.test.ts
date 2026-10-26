import { it, vi } from "vitest";
import { Client } from "pg";
vi.mock("server-only", () => ({}));
import { OfficialPreviewInputSchema, releaseOfficialFirstSection } from "../../src/server/course-materialization/official-preview";
import { getMechanicRuntimeCapabilities } from "../../src/server/runs/composition";

it.skipIf(process.env.OFFICIAL_COURSE_RELEASE_OPERATOR !== "1")("explicitly previews or releases the saved first section without generation", async () => {
  let stage = "input";
  let client: Client | undefined;
  try {
    const input = OfficialPreviewInputSchema.parse(JSON.parse(process.env.OFFICIAL_COURSE_RELEASE_INPUT ?? ""));
    stage = "runtime_capabilities";
    const runtime = await getMechanicRuntimeCapabilities();
    const url = new URL(process.env.DIRECT_DATABASE_URL!);
    for (const name of ["sslmode", "sslrootcert", "sslcert", "sslkey"]) url.searchParams.delete(name);
    client = new Client({ connectionString: url.toString(), connectionTimeoutMillis: 10_000,
      ssl: { rejectUnauthorized: true, ...(process.env.DATABASE_SSL_CA ? { ca: process.env.DATABASE_SSL_CA.replace(/\\n/g, "\n") } : {}) },
      application_name: "unfurl-official-section-release" });
    stage = "connect";
    await client.connect();
    await client.query(input.applyDigest ? "BEGIN" : "BEGIN READ ONLY");
    await client.query("SET LOCAL statement_timeout='30s'; SET LOCAL lock_timeout='10s'");
    stage = "validate_saved_section";
    const report = await releaseOfficialFirstSection(client, input, runtime);
    stage = input.applyDigest ? "commit" : "finish_preview";
    await client.query(input.applyDigest ? "COMMIT" : "ROLLBACK");
    console.log(JSON.stringify(report));
  } catch {
    await client?.query("ROLLBACK").catch(() => undefined);
    console.log(JSON.stringify({ kind: "official-course-release-error", stage, inferenceCalls: 0 }));
    throw new Error(`Official release rejected at ${stage}; no inference was attempted.`);
  } finally { await client?.end(); }
}, 580_000);
