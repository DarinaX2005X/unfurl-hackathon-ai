import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { compactArtifactMemory, ArtifactMemorySchema, ARTIFACT_MEMORY_BYTES } from "../../src/server/agent-turns/artifact-memory";
import { captureContext, ContextSnapshotSchema } from "../../src/server/agent-turns/repository";
import { buildAgentDecisionRequest } from "../../src/server/agent-turns/handler";
import { legacyReaderCapabilities } from "./fixtures";
import * as curricula from "../../src/server/curricula/repository";
import { curriculumDigest, type CurriculumDraft } from "../../src/domain/course";
import type { DbTransaction } from "../../src/server/db";
import type { ToolObservation } from "../../src/server/agent-tools/contracts";
import { curriculum, ids, timestamp } from "../domain/fixtures";

afterEach(() => vi.restoreAllMocks());
const uuid = (n: number) => `30000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function programme(count = 21): CurriculumDraft {
  const draft = curriculum();
  draft.sourceIds = [];
  draft.outcomes = Array.from({ length: count }, (_, n) => ({ id: uuid(n + 1), title: `Saved outcome ${n + 1}`,
    demonstration: `Demonstrate the saved ability ${n + 1}.`, requirement: "core" as const,
    prerequisiteOutcomeIds: n ? [uuid(n)] : [] }));
  draft.modules = Array.from({ length: count }, (_, n) => ({ id: uuid(n + 1001), title: `Saved module ${n + 1}`,
    summary: `Study the saved topic ${n + 1}.`, outcomeIds: [uuid(n + 1)],
    prerequisiteModuleIds: n ? [uuid(n + 1000)] : [], estimatedStudyMinutes: 45 }));
  return draft;
}

describe("saved artifact memory", () => {
  it("retains every saved outline record after both pages and an unrelated tool, then replaces it on revision", async () => {
    let draft = programme();
    const original = structuredClone(draft);
    const readDraft = vi.spyOn(curricula, "requireCourseDraft").mockImplementation(async () => ({
      draft, course: { revision: draft.revision, currentReadyVersionId: null },
    } as Awaited<ReturnType<typeof curricula.requireCourseDraft>>));
    const observations: ToolObservation[] = [];
    const tx = { query: async (sql: string) => ({ rows:
      sql.startsWith("SELECT parts FROM unfurl.messages") ? [{ parts: [{ type: "text", text: "Review the saved curriculum." }] }]
        : sql.startsWith("SELECT ref.course_id") ? [{ course_id: draft.courseId, document: draft }]
          : sql.includes("SELECT result_reference FROM visible_research_steps ORDER BY") ? observations.slice(-8).reverse().map(result_reference => ({ result_reference })) : [],
      rowCount: 0 }) } as unknown as DbTransaction;
    const capture = () => captureContext(tx, { kind: "agent_turn", runId: ids.request, ownerId: ids.actor,
      conversationId: ids.conversation, branchId: ids.sample, inputMessageId: ids.missing }, ids.task, observations.length, timestamp);
    for (const kind of ["outcomes", "modules"] as const) {
      for (const offset of [0, 12]) {
        observations.push({ tool: "read_artifact", ok: true, summary: "Read the saved page.", sourceIds: [], artifactIds: [draft.courseId],
          data: { courseId: draft.courseId, page: { kind, offset, items: draft[kind].slice(offset, offset + 12) } } });
        const snapshot = await capture();
        expect(snapshot.artifactMemory?.artifacts[0]?.modules.items.map(item => item.title)).toEqual(original.modules.map(item => item.title));
        expect(snapshot.artifactMemory?.artifacts[0]?.outcomes.items.map(item => item.id)).toEqual(original.outcomes.map(item => item.id));
      }
    }
    observations.push({ tool: "read_source", ok: false, summary: "Unavailable source.", sourceIds: [], artifactIds: [], data: { status: "unavailable" } });
    const final = await capture(), saved = final.artifactMemory!.artifacts[0]!;
    expect(final.recentTools.slice(0, -1).every(tool => tool.data === null)).toBe(true);
    expect(saved.contentDigest).toBe(await curriculumDigest(original));
    expect(saved.modules.items[20]).toMatchObject({ id: original.modules[20]!.id, title: original.modules[20]!.title,
      summary: original.modules[20]!.summary, prerequisiteModuleIds: original.modules[20]!.prerequisiteModuleIds });
    expect(saved.modules.omittedCount).toBe(0);
    expect(readDraft).toHaveBeenLastCalledWith(tx, ids.actor, draft.courseId);
    draft = { ...draft, revision: 2, modules: draft.modules.map((item, n) => n === 0 ? { ...item, title: "Revised saved module" } : item) };
    const revised = (await capture()).artifactMemory!.artifacts[0]!;
    expect(revised).toMatchObject({ draftRevision: 2, courseRevision: 2 });
    expect(revised.contentDigest).not.toBe(saved.contentDigest);
    expect(revised.modules.items[0]!.title).toBe("Revised saved module");
    expect(saved.modules.items[0]!.title).toBe(original.modules[0]!.title);
  });

  it("bounds complete records and descriptions, explicitly reports omissions, and remains deterministic", async () => {
    const draft = programme(120);
    for (const item of draft.modules) item.summary = "Saved detail. ".repeat(250);
    for (const item of draft.outcomes) item.demonstration = "Demonstration. ".repeat(250);
    const bounded = await compactArtifactMemory([{ draft, courseRevision: 1 }], 3200);
    expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThanOrEqual(3200);
    const saved = bounded.artifacts[0]!;
    for (const kind of ["modules", "outcomes"] as const) {
      const page = saved[kind];
      expect(page.omittedCount).toBeGreaterThan(0);
      expect(page.omittedCount + page.items.length).toBe(draft[kind].length);
      expect(page.nextOffset).toBe(page.items.length);
      expect(page.items.map(item => item.id)).toEqual(draft[kind].slice(0, page.items.length).map(item => item.id));
    }
    expect(saved.modules.items.every(item => item.summary === null)).toBe(true);
    expect(await compactArtifactMemory([{ draft, courseRevision: 1 }], 3200)).toEqual(bounded);
    const full = await compactArtifactMemory([{ draft, courseRevision: 1 }]);
    expect(Buffer.byteLength(JSON.stringify(full))).toBeLessThanOrEqual(ARTIFACT_MEMORY_BYTES);
    expect(full.artifacts[0]!.modules.items).toHaveLength(120);
    expect(full.artifacts[0]!.modules.items.every((item, n) => item.summary === null || item.summary === draft.modules[n]!.summary)).toBe(true);
    const records = Array.from({ length: 20 }, (_, n) => ({ draft: { ...programme(), courseId: uuid(n + 2001) }, courseRevision: 1 }));
    const many = await compactArtifactMemory(records, 3200);
    expect(many.omittedArtifactCount).toBeGreaterThan(0);
    expect(many.artifacts.length + many.omittedArtifactCount).toBe(records.length);
    expect(many.retrieval).toContain("omitted courses remain listed in artifacts");
    expect(await compactArtifactMemory([...records].reverse(), 3200)).toEqual(many);
    expect(ArtifactMemorySchema.safeParse({ ...many, version: "future" }).success).toBe(false);
  });

  it("adds grounding instructions only to marked captures without changing the decision schema or mutating legacy input", async () => {
    const old = ContextSnapshotSchema.parse({ kind: "context", index: 0, now: timestamp, currentMessage: "Review the course.",
      recentMessages: [], artifacts: [], sources: [], recentTools: [], agentProtocol: "conversational-v3",
      readerCapabilities: legacyReaderCapabilities(), languageIntent: null });
    const before = JSON.stringify(old);
    const budget = { reservationId: ids.request, logicalOperationId: ids.request, attempt: 1, runStepId: ids.task, probe: false };
    const legacy = buildAgentDecisionRequest(old, budget, 1234);
    const marked = ContextSnapshotSchema.parse({ ...old, artifactMemory: await compactArtifactMemory([{ draft: programme(), courseRevision: 1 }]) });
    const fresh = buildAgentDecisionRequest(marked, budget, 1234);
    expect(legacy.instructionVersion).toBe("adaptive-course-agent-v3:text-sources-v1");
    expect(legacy.trustedInstructions).not.toContain("artifactMemory");
    expect(fresh.instructionVersion).toBe(`${legacy.instructionVersion}:saved-artifact-v1`);
    expect(fresh.trustedInstructions.startsWith(`${legacy.trustedInstructions}\n`)).toBe(true);
    expect(fresh.trustedInstructions).toContain("Preserve exact saved module/outcome titles and order");
    expect(fresh.trustedInstructions).toContain("intentions, not proof");
    expect(fresh.schema).toBe(legacy.schema);
    expect(fresh.schemaVersion).toBe(legacy.schemaVersion);
    expect(JSON.stringify(old)).toBe(before);
    expect(old).not.toHaveProperty("artifactMemory");
  });
});
