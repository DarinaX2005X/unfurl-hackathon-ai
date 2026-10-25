import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { SafeSourceReader } from "../../src/server/research/reader";
import { PostgresResearchRepository } from "../../src/server/research/repository";
import { withSystemTransaction } from "../../src/server/db";

it.skipIf(process.env.RUN_LIVE_RESEARCH !== "1")("reads actual primary-source bytes over pinned TLS and stores exact passages in migrated tables (rollback)", async () => {
  const result = await new SafeSourceReader().read({ url: "https://nodejs.org/api/globals.html" }, new AbortController().signal);
  expect(result.status).toBe("success");
  if (result.status !== "success") throw new Error("Primary-source read did not complete");
  expect(result.document.finalUrl).toBe("https://nodejs.org/api/globals.html");
  const block = result.document.blocks.find((item) => item.text.includes("AbortController"));
  expect(block).toBeDefined();
  if (!block) throw new Error("Actual source did not contain required evidence");
  const start = block.text.indexOf("AbortController");
  const passage = { id: randomUUID(), sourceId: result.document.id, blockId: block.id, start, end: start + "AbortController".length, quote: "AbortController" };
  const repository = new PostgresResearchRepository();
  const rollback = new Error("intentional_rollback");
  await expect(withSystemTransaction("run_execution", async (tx) => {
    expect(await repository.saveSource(tx, result.document)).toEqual(result.document);
    expect(await repository.saveSource(tx, result.document)).toEqual(result.document);
    expect(await repository.savePassage(tx, passage)).toEqual(passage);
    expect(await repository.getPassage(tx, passage.id)).toEqual(passage);
    throw rollback;
  })).rejects.toBe(rollback);
  expect(await withSystemTransaction("run_execution", (tx) => repository.getSource(tx, result.document.id))).toBeNull();
}, 30_000);
