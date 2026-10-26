import "server-only";
import { z } from "zod";
import { DigestSchema, IdSchema, RevisionSchema } from "../../domain/common";
import { curriculumDigest, type CurriculumDraft } from "../../domain/course";
import { ProviderFailure } from "../ai/failure";

const moduleItem = z.object({ id: IdSchema, title: z.string(), outcomeIds: z.array(IdSchema),
  prerequisiteModuleIds: z.array(IdSchema), summary: z.string().nullable() }).strict();
const outcomeItem = z.object({ id: IdSchema, title: z.string(), prerequisiteOutcomeIds: z.array(IdSchema),
  requirement: z.enum(["core", "specialization"]), demonstration: z.string().nullable() }).strict();
const page = <T extends z.ZodType>(item: T) => z.object({ items: z.array(item), total: z.number().int().nonnegative(),
  omittedCount: z.number().int().nonnegative(), nextOffset: z.number().int().nonnegative().nullable() }).strict();
export const ArtifactMemorySchema = z.object({
  version: z.literal("saved-artifact-v1"), totalArtifacts: z.number().int().nonnegative(),
  omittedArtifactCount: z.number().int().nonnegative(),
  retrieval: z.literal("read_artifact; omitted courses remain listed in artifacts"),
  artifacts: z.array(z.object({ courseId: IdSchema, draftId: IdSchema, courseRevision: RevisionSchema,
    draftRevision: RevisionSchema, contentDigest: DigestSchema, title: z.string(),
    modules: page(moduleItem), outcomes: page(outcomeItem) }).strict()),
}).strict();
export type ArtifactMemory = z.infer<typeof ArtifactMemorySchema>;
export const ARTIFACT_MEMORY_BYTES = 48 * 1024;
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

/** Rebuilt from owned persisted drafts, never from assistant claims or previous tool pages.
 * Keep exact outline records first, then add complete descriptions when space permits.
 * Omitted records are a contiguous suffix; nextOffset is usable with read_artifact.
 */
export async function compactArtifactMemory(records: readonly { draft: CurriculumDraft; courseRevision: number }[], maximumBytes = ARTIFACT_MEMORY_BYTES): Promise<ArtifactMemory> {
  const result: ArtifactMemory = { version: "saved-artifact-v1", totalArtifacts: records.length,
    omittedArtifactCount: records.length, retrieval: "read_artifact; omitted courses remain listed in artifacts", artifacts: [] };
  if (bytes(result) > maximumBytes) throw new ProviderFailure("invalid_output");
  const ordered = [...records].sort((a, b) => a.draft.courseId.localeCompare(b.draft.courseId));
  const included: typeof ordered = [];
  for (const record of ordered) {
    const { draft, courseRevision } = record;
    const emptyPage = (total: number) => ({ items: [], total, omittedCount: total, nextOffset: total ? 0 : null });
    result.artifacts.push({ courseId: draft.courseId, draftId: draft.id, courseRevision, draftRevision: draft.revision,
      contentDigest: await curriculumDigest(draft), title: draft.title,
      modules: emptyPage(draft.modules.length), outcomes: emptyPage(draft.outcomes.length) });
    result.omittedArtifactCount--;
    if (bytes(result) > maximumBytes) { result.artifacts.pop(); result.omittedArtifactCount++; continue; }
    included.push(record);
  }
  // Round-robin allocation prevents one large course from consuming every outline slot.
  for (let offset = 0; ; offset++) {
    let advanced = false;
    for (const [index, { draft }] of included.entries()) {
      const target = result.artifacts[index]!;
      for (const kind of ["modules", "outcomes"] as const) {
        const current = target[kind];
        if (current.items.length !== offset || offset >= current.total) continue;
        const item = kind === "modules" ? (() => { const m = draft.modules[offset]!; return {
          id: m.id, title: m.title, outcomeIds: [...m.outcomeIds], prerequisiteModuleIds: [...m.prerequisiteModuleIds], summary: null }; })()
          : (() => { const o = draft.outcomes[offset]!; return { id: o.id, title: o.title,
            prerequisiteOutcomeIds: [...o.prerequisiteOutcomeIds], requirement: o.requirement, demonstration: null }; })();
        // Both collections are validated independently by ArtifactMemorySchema below.
        (current.items as Array<typeof item>).push(item);
        current.omittedCount--; current.nextOffset = current.omittedCount ? offset + 1 : null;
        if (bytes(result) > maximumBytes) {
          current.items.pop(); current.omittedCount++; current.nextOffset = offset;
        } else advanced = true;
      }
    }
    if (!advanced) break;
  }
  for (const [index, { draft }] of included.entries()) {
    const target = result.artifacts[index]!;
    for (const [offset, item] of target.modules.items.entries()) {
      item.summary = draft.modules[offset]!.summary;
      if (bytes(result) > maximumBytes) item.summary = null;
    }
    for (const [offset, item] of target.outcomes.items.entries()) {
      item.demonstration = draft.outcomes[offset]!.demonstration;
      if (bytes(result) > maximumBytes) item.demonstration = null;
    }
  }
  return ArtifactMemorySchema.parse(result);
}

export const ARTIFACT_MEMORY_INSTRUCTIONS = `artifactMemory is a bounded projection of the actual owned saved drafts at the stated revisions and content digests. It survives tool rotation; earlier recentTools data=null does not erase these saved records. User requests, required capabilities, your plans and currentTurnCommentary describe intentions, not proof that those features were saved. Ground descriptions of the saved course in artifactMemory and actual read_artifact results. Preserve exact saved module/outcome titles and order in a detailed recap; never replace them with a more desirable syllabus. Do not claim mathematics coverage, independent projects, milestones or prerequisite relationships absent from the saved content. If the saved scope falls short of the request, state the gap and use the authorized edit workflow instead of claiming it is complete. Module summaries or outcome demonstrations set to null are omitted, not empty; titles alone do not establish detailed coverage. Read the relevant read_artifact page before making claims that require omitted detail. omittedCount/nextOffset identify missing suffix records; omittedArtifactCount identifies courses whose headers remain in artifacts. Retrieve them with read_artifact using the recorded courseId and page kind/offset/limit. Do not present a partial memory as the entire curriculum. Keep natural, useful commentary, distinguish proposed changes from completed saves, and give concise final guidance grounded in the saved revision.`;
