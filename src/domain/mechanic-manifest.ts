import { z } from "zod";
import { MechanicIdSchema } from "./mechanics";
import { descriptors as foundations } from "./mechanic-families/v2/foundations";
import { descriptors as investigation } from "./mechanic-families/v2/investigation";
import { descriptors as construction } from "./mechanic-families/v2/construction";
import { descriptors as communication } from "./mechanic-families/v2/communication";

export const MechanicManifestEntrySchema = z.object({
  id: MechanicIdSchema, version: z.literal(2), responseSchemaVersion: z.literal(2),
  rendererKey: z.string().min(1), requiredAffordances: z.array(z.string()),
  supportedEvaluators: z.array(z.enum(["deterministic", "rubric", "execution"])),
  actions: z.array(z.enum(["run", "prediction.commit", "experiment.query", "intervention.apply", "dialogue.turn"])),
  requirements: z.array(z.enum(["model", "activity", "sandbox"])), limitations: z.array(z.string()),
  accessibility: z.object({ keyboardEquivalent: z.boolean(), nonVisualSummary: z.boolean() }).strict(),
}).strict();
export type MechanicManifestEntry = z.infer<typeof MechanicManifestEntrySchema>;

/** Public metadata only. No evaluator, private schema, source claims or authored task data. */
export const productionMechanicManifest: readonly MechanicManifestEntry[] = Object.freeze(
  [...foundations, ...investigation, ...construction, ...communication].map((descriptor) =>
    Object.freeze(MechanicManifestEntrySchema.parse({
      id: descriptor.id, version: descriptor.version, responseSchemaVersion: descriptor.responseSchemaVersion,
      rendererKey: descriptor.rendererKey, requiredAffordances: descriptor.requiredAffordances,
      supportedEvaluators: descriptor.supportedEvaluators, actions: descriptor.actions,
      requirements: descriptor.requirements, limitations: descriptor.limitations, accessibility: descriptor.accessibility,
    }))),
);
export function getMechanicManifest(id: string, version: number): MechanicManifestEntry | null {
  return productionMechanicManifest.find((entry) => entry.id === id && entry.version === version) ?? null;
}
