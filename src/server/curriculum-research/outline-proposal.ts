import "server-only";
import { z } from "zod";
import { IdSchema } from "../../domain/common";
import { ModuleOutlineSchema, OutcomeSchema } from "../../domain/course";
import { ProviderFailure } from "../ai/failure";
import { stableExecutionId } from "../runs/identity";
import { ContentPageSchema, LocalSectionKey } from "./part-contracts";

const ReferenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("local"), key: LocalSectionKey }).strict(),
  z.object({ kind: z.literal("existing"), id: IdSchema }).strict(),
]);
export const OutlineProposalSchema = z.object({
  outcomes: z.array(OutcomeSchema.omit({ id: true, prerequisiteOutcomeIds: true }).extend({
    key: LocalSectionKey, prerequisiteOutcomeRefs: z.array(ReferenceSchema),
  }).strict()),
  modules: z.array(ModuleOutlineSchema.omit({ id: true, outcomeIds: true, prerequisiteModuleIds: true }).extend({
    key: LocalSectionKey, outcomeRefs: z.array(ReferenceSchema).min(1), prerequisiteModuleRefs: z.array(ReferenceSchema),
  }).strict()),
  complete: z.boolean(), nextFocus: z.string().trim().min(1).max(4000).nullable(),
}).strict().refine(page => page.complete === (page.nextFocus === null) && page.outcomes.length + page.modules.length > 0);
export type OutlineProposal = z.infer<typeof OutlineProposalSchema>;

export const OUTLINE_PROPOSAL_INSTRUCTIONS = `Develop the full scope of this section into concrete outcomes and prerequisite-first modules. Return only the next bounded portion. Give every new outcome and module a distinct semantic local key, unique across both arrays on this page; the server assigns permanent IDs. Reference a node declared on this page with {kind:"local",key}, or a supplied saved node with {kind:"existing",id}, copying its exact ID. Outcome references must target outcomes; module prerequisite references must target modules already saved or earlier on this page. Never invent existing IDs. Keep each field within its schema. Preserve depth, prerequisite practice and every requested capability; do not compress the scope into a survey because this response is finite. If more modules or outcomes are needed for this section, return complete=false and describe the remaining work in nextFocus using subject names rather than local keys. Local keys belong only to this page; the next page receives permanent saved IDs. Continue only with new items. Complete the section only when its entire scope is represented. Each outcome must be taught in a module. Use the prerequisite section frontier in the module dependency graph. Lessons themselves are built only after the user's later approval.`;

/** This is a creation-only graph mapping, never a repair of existing domain IDs. */
export function materializeOutlineProposal(input: {
  invocationId: string; sectionKey: string; pageIndex: number; proposal: OutlineProposal;
  existingOutcomeIds: readonly string[]; existingModuleIds: readonly string[]; occupiedIds: readonly string[];
}): z.infer<typeof ContentPageSchema> {
  IdSchema.parse(input.invocationId); LocalSectionKey.parse(input.sectionKey);
  if (!Number.isSafeInteger(input.pageIndex) || input.pageIndex < 0) throw new ProviderFailure("invalid_output");
  const proposal = OutlineProposalSchema.parse(input.proposal);
  const invalid = (): never => { throw new ProviderFailure("invalid_output"); };
  const declaredKeys = new Set<string>(), occupied = new Set(input.occupiedIds.map(id => IdSchema.parse(id)));
  const existingOutcomes = new Set(input.existingOutcomeIds.map(id => IdSchema.parse(id)));
  const existingModules = new Set(input.existingModuleIds.map(id => IdSchema.parse(id)));
  if ([...existingOutcomes].some(id => existingModules.has(id))) invalid();
  const declare = (kind: "outcome" | "module", keys: string[]) => new Map(keys.map(key => {
    if (declaredKeys.has(key)) invalid();
    declaredKeys.add(key);
    const id = stableExecutionId(input.invocationId, `outline-identity-v1:${JSON.stringify([input.sectionKey, input.pageIndex, kind, key])}`);
    if (occupied.has(id) || existingOutcomes.has(id) || existingModules.has(id)) invalid();
    occupied.add(id);
    return [key, id];
  }));
  const outcomeIds = declare("outcome", proposal.outcomes.map(item => item.key));
  const moduleIds = declare("module", proposal.modules.map(item => item.key));
  const resolve = (refs: z.infer<typeof ReferenceSchema>[], local: ReadonlyMap<string, string>, existing: ReadonlySet<string>) => {
    const ids = refs.map(ref => ref.kind === "local" ? local.get(ref.key) ?? invalid() : existing.has(ref.id) ? ref.id : invalid());
    if (new Set(ids).size !== ids.length) invalid();
    return ids;
  };
  const outcomes = proposal.outcomes.map(({ key, prerequisiteOutcomeRefs, ...fields }) => ({ ...fields, id: outcomeIds.get(key)!,
    prerequisiteOutcomeIds: resolve(prerequisiteOutcomeRefs, outcomeIds, existingOutcomes) }));
  const priorModuleIds = new Map<string, string>();
  const modules = proposal.modules.map(({ key, outcomeRefs, prerequisiteModuleRefs, ...fields }) => {
    const outline = { ...fields, id: moduleIds.get(key)!, outcomeIds: resolve(outcomeRefs, outcomeIds, existingOutcomes),
      prerequisiteModuleIds: resolve(prerequisiteModuleRefs, priorModuleIds, existingModules) };
    priorModuleIds.set(key, outline.id);
    return outline;
  });
  return ContentPageSchema.parse({ outcomes, modules, complete: proposal.complete, nextFocus: proposal.nextFocus });
}
