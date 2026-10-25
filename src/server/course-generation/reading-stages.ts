import "server-only";
import { z } from "zod";
import { IdSchema, JsonValueSchema } from "@/domain/common";
import type { DbTransaction } from "@/server/db";
import type { ModelPort } from "@/server/ai/ports";
import { ProviderFailure } from "@/server/ai/failure";
import { jsonDigest } from "@/server/ai/json";
import type { ApprovedBuildBinding } from "@/server/curricula/build-binding";
import type { CurriculumEvidenceFacts } from "@/server/curriculum-research/validation";
import type { RunContext } from "@/server/runs/ports";
import { taskDigest } from "@/server/mechanics/digest";
import type { ModuleKnowledge } from "./contracts";
import { LessonReadingSchema, type LessonReading, type ModulePlan } from "./planning";
import { loadGenerationStep, verifyStoredModelData } from "./repository";
import { loadStage, modelStage, ModelStageSchema, pureStage, type StageIndex } from "./stages";

export const ReadingPieceSchema = z.object({ lessonId: IdSchema, blockId: IdSchema, part: z.number().int().nonnegative(),
  text: z.string().trim().min(1), complete: z.boolean() }).strict();
export type ReadingPiece = z.infer<typeof ReadingPieceSchema>;
export const LessonReadingCheckpointSchema = z.object({ kind: z.literal("course.lesson.reading"), planStepId: IdSchema,
  reading: LessonReadingSchema, pieceStepIds: z.array(IdSchema) }).strict();
const invalid = (): never => { throw new ProviderFailure("invalid_output"); };
type PlannedLesson = ModulePlan["lessons"][number];
function readingPieceMaterial(lesson: PlannedLesson, block: Exclude<PlannedLesson["blocks"][number], { kind: "task" }>, part: number,
  previous: readonly ReadingPiece[], knowledge: ModuleKnowledge, facts: Pick<CurriculumEvidenceFacts, "claims" | "passages">, contentLanguage: string) {
  return JsonValueSchema.parse({ lesson: { id: lesson.id, title: lesson.title, outcomeIds: lesson.outcomeIds }, block, part,
    continuation: { previousParts: previous.length, previousPartTail: previous.at(-1)?.text.slice(-8000) ?? null }, contentLanguage,
    knowledge, claims: facts.claims, passages: facts.passages });
}

/** The model writes bounded text pieces; exact citations and the complete lesson are derived from the saved plan and evidence. */
export function assembleLessonReading(lesson: PlannedLesson, pieces: readonly ReadingPiece[], facts: Pick<CurriculumEvidenceFacts, "claims" | "passages">): LessonReading {
  const blocks: LessonReading["blocks"] = [], readingEvidence: LessonReading["readingEvidence"] = [];
  const plans = lesson.blocks.filter((block) => block.kind !== "task");
  if (pieces.some((piece) => piece.lessonId !== lesson.id || !plans.some((block) => block.id === piece.blockId))) return invalid();
  for (const block of plans) {
    const parts = pieces.filter((piece) => piece.blockId === block.id).sort((left, right) => left.part - right.part);
    if (!parts.length || parts.some((piece, index) => piece.part !== index || piece.complete !== (index === parts.length - 1)) || new Set(parts.map((part) => part.text)).size !== parts.length) return invalid();
    const sourceIds = new Set<string>();
    for (const id of block.claimIds) {
      const claim = facts.claims.find((entry) => entry.id === id);
      if (!claim) return invalid();
      for (const passageId of claim.passageIds) { const passage = facts.passages.find((entry) => entry.id === passageId); if (!passage) return invalid(); sourceIds.add(passage.sourceId); }
    }
    const text = parts.map((part) => part.text).join("\n\n");
    blocks.push(block.kind === "explanation" ? { id: block.id, kind: "explanation", markdown: text, sourceIds: [...sourceIds] }
      : { id: block.id, kind: "example", title: block.title ?? lesson.title, content: text, sourceIds: [...sourceIds] });
    readingEvidence.push({ lessonId: lesson.id, blockId: block.id, outcomeIds: block.outcomeIds, claimIds: block.claimIds });
  }
  return LessonReadingSchema.parse({ lessonId: lesson.id, blocks, readingEvidence });
}

export async function loadVerifiedLessonReading(tx: DbTransaction, binding: ApprovedBuildBinding, stepId: string,
  planStepId: string, lesson: PlannedLesson, facts: Pick<CurriculumEvidenceFacts, "claims" | "passages">, knowledge: ModuleKnowledge): Promise<LessonReading> {
  const saved = await loadGenerationStep(tx, binding, stepId, LessonReadingCheckpointSchema);
  if (saved.result.planStepId !== planStepId || saved.result.reading.lessonId !== lesson.id || new Set(saved.result.pieceStepIds).size !== saved.result.pieceStepIds.length) return invalid();
  const pieces: ReadingPiece[] = [];
  for (const id of saved.result.pieceStepIds) {
    const part = await loadGenerationStep(tx, binding, id, ModelStageSchema), content = ReadingPieceSchema.parse(part.result.data);
    const block = lesson.blocks.find((entry) => entry.id === content.blockId), previous = pieces.filter((piece) => piece.blockId === content.blockId);
    if (!block || block.kind === "task" || content.lessonId !== lesson.id || content.part !== previous.length ||
        part.inputDigest !== jsonDigest(readingPieceMaterial(lesson, block, content.part, previous, knowledge, facts, binding.draft.contentLanguage))) return invalid();
    await verifyStoredModelData(tx, part, part.result.operationId, ReadingPieceSchema, content);
    pieces.push(content);
  }
  const reading = assembleLessonReading(lesson, pieces, facts);
  if (taskDigest(reading) !== taskDigest(saved.result.reading)) return invalid();
  return reading;
}

export async function advanceLessonReading(input: { context: RunContext; binding: ApprovedBuildBinding; index: StageIndex; key: string;
  planStepId: string; lesson: PlannedLesson; knowledge: ModuleKnowledge; facts: CurriculumEvidenceFacts; model: ModelPort;
}): Promise<{ stepId: string; reading: LessonReading } | null> {
  const { context, binding, index, lesson } = input;
  const saved = await loadStage(context, binding, index, input.key, LessonReadingCheckpointSchema);
  if (saved) return { stepId: saved.id, reading: await context.read((tx) => loadVerifiedLessonReading(tx, binding, saved.id, input.planStepId, lesson, input.facts, input.knowledge)) };
  const pieces: ReadingPiece[] = [], pieceStepIds: string[] = [];
  for (const block of lesson.blocks.filter((entry) => entry.kind !== "task")) {
    let part = 0, complete = false;
    while (!complete) {
      const key = `${input.key}/${block.id}/${part}`, savedPart = await loadStage(context, binding, index, key, ModelStageSchema);
      if (!savedPart) {
        const previous = pieces.filter((piece) => piece.blockId === block.id);
        await modelStage({ context, binding, model: input.model, key, purpose: "task_authoring", schema: ReadingPieceSchema,
          material: readingPieceMaterial(lesson, block, part, previous, input.knowledge, input.facts, binding.draft.contentLanguage),
          instructions: "Write the next substantive piece of this one planned reading block. Return the exact lessonId, blockId and part number. Teach the requested reasoning, prerequisites and examples deeply enough for the approved outcomes. Each piece ends at a paragraph boundary. Set complete=true only when the block's teaching purpose is fully covered; otherwise set complete=false and the server will request another saved piece. There is no total lesson or course length cap: do not compress or omit content to fit this one response. Continue after the supplied previous-part tail without repeating it. The server assembles every piece and attaches the plan's exact source citations. Do not invent source facts or expose later assessment answers." });
        return null;
      }
      const content = ReadingPieceSchema.parse(savedPart.result.data);
      if (content.lessonId !== lesson.id || content.blockId !== block.id || content.part !== part || pieces.some((piece) => piece.blockId === block.id && piece.text === content.text)) return invalid();
      pieces.push(content); pieceStepIds.push(savedPart.id); complete = content.complete; part++;
    }
  }
  const reading = assembleLessonReading(lesson, pieces, input.facts);
  await pureStage({ context, binding, key: input.key, material: { planStepId: input.planStepId, pieceStepIds }, schema: LessonReadingCheckpointSchema,
    async commit(tx) {
      for (let i = 0; i < pieceStepIds.length; i++) {
        const step = await loadGenerationStep(tx, binding, pieceStepIds[i]!, ModelStageSchema);
        const piece = pieces[i]!, block = lesson.blocks.find((entry) => entry.id === piece.blockId);
        if (!block || block.kind === "task" || step.inputDigest !== jsonDigest(readingPieceMaterial(lesson, block, piece.part,
          pieces.slice(0, i).filter((entry) => entry.blockId === piece.blockId), input.knowledge, input.facts, binding.draft.contentLanguage))) return invalid();
        await verifyStoredModelData(tx, step, step.result.operationId, ReadingPieceSchema, pieces[i]!);
      }
      return { kind: "course.lesson.reading" as const, planStepId: input.planStepId, reading, pieceStepIds };
    } });
  return null;
}
