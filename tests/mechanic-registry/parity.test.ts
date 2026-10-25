import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { MECHANIC_IDS } from "@/domain/mechanics";
import { productionMechanicManifest, MechanicManifestEntrySchema } from "@/domain/mechanic-manifest";
import { getMechanic, getProductionMechanic, productionMechanics } from "@/features/learning/registry";
import { productionDescriptors, productionEvaluators, getServerMechanic } from "@/server/mechanics/registry";
import { getGenerationMechanicCatalog, getMechanicAuthoringContract } from "@/server/mechanics/catalog";
import type { MechanicRuntimeCapabilities } from "@/server/mechanics/contracts";
import { mechanics as foundations } from "@/features/learning/mechanics/foundations";
import { mechanics as investigation } from "@/features/learning/mechanics/investigation";
import { mechanics as construction } from "@/features/learning/mechanics/construction";
import { mechanics as communication } from "@/features/learning/mechanics/communication";
import { induction, task } from "../mechanics/foundations/fixtures";

const runtime: MechanicRuntimeCapabilities = { model: null, activity: { durable: false, supportedActions: [], dialogue: false },
  sandbox: { available: false, profiles: [] }, budget: { available: false } };
describe("production family joins", () => {
  it("joins exactly all 29 actual domain, client, server and metadata registrations", () => {
    const clients = [...foundations, ...investigation, ...construction, ...communication];
    for (const entries of [productionDescriptors, clients.map((item) => item.descriptor), productionEvaluators,
      productionMechanicManifest, productionMechanics]) {
      expect(entries).toHaveLength(29);
      expect(entries.map((entry) => entry.id).sort()).toEqual([...MECHANIC_IDS].sort());
      expect(entries.every((entry) => entry.version === 2)).toBe(true);
    }
    for (const descriptor of productionDescriptors) {
      const client = clients.find((item) => item.descriptor.id === descriptor.id)!;
      expect(client.descriptor).toBe(descriptor);
      expect(client.configSchema).toBe(descriptor.configSchema);
      expect(client.responseSchema).toBe(descriptor.responseSchema);
      expect(client.Renderer).toBeTypeOf("function");
      expect(descriptor.responseSchemaVersion).toBe(2);
      const metadata = productionMechanicManifest.find((item) => item.id === descriptor.id)!;
      expect(metadata.rendererKey).toBe(descriptor.rendererKey);
      expect(MechanicManifestEntrySchema.safeParse(metadata).success).toBe(true);
      expect(getServerMechanic(descriptor.id, 2)?.privateSchema).toBe(productionEvaluators.find((item) => item.id === descriptor.id)!.privateSchema);
    }
  });
  it("keeps v1 sample lookup separate and rejects unknown IDs/versions", () => {
    expect(getMechanic("constrained_optimization", 1)).not.toBeNull();
    expect(getMechanic("constrained_optimization", 2)).toBeNull();
    expect(getProductionMechanic("constrained_optimization", 1)).toBeNull();
    expect(getProductionMechanic("python", 2)).toBeNull();
    expect(getServerMechanic("artifact_construction", 3)).toBeNull();
  });
  it("validates both task and response before invoking a renderer", () => {
    const handle = getProductionMechanic("rule_induction", 2)!;
    const initial = handle.createInitialResponse(induction);
    expect(handle.parseResponse(initial)).toEqual(initial);
    expect(() => handle.parseResponse({ kind: "recall_reconstruction", action: "reconstruct", text: "x" })).toThrow();
    expect(() => handle.parseTask({ ...task(induction), responseSchemaVersion: 1 })).toThrow();
    expect(() => handle.Renderer({ task: task(induction), response: {}, onChange() {}, disabled: false, status: "editing", evaluation: null })).toThrow();
    expect(handle.validateSubmission(induction, initial).length).toBeGreaterThan(0);
  });
  it("exports actual JSON schemas for every family with runtime refinements still mandatory", () => {
    for (const id of MECHANIC_IDS) {
      const contract = getMechanicAuthoringContract(id, 2);
      for (const schema of [contract.publicTaskSchema, contract.configSchema, contract.responseSchema, contract.evaluatorDataSchema]) {
        expect(schema.type).toBe("object");
        expect(Object.keys(schema.properties ?? {}).length).toBeGreaterThan(0);
        expect(schema.additionalProperties).toBe(false);
      }
      expect(contract.runtimeRefinementsRequired).toBe(true);
    }
    expect(() => getMechanicAuthoringContract("python", 3)).toThrow();
  });
  it("keeps all implementation members while reporting unavailable runtime dependencies", () => {
    const catalog = getGenerationMechanicCatalog(runtime);
    expect(catalog.entries).toHaveLength(29);
    expect(catalog.capabilityCatalogDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(catalog.entries.find((entry) => entry.id === "rule_induction")?.status).toBe("available");
    expect(catalog.entries.find((entry) => entry.id === "information_gap")?.reasons).toEqual(expect.arrayContaining(["model_unavailable", "durable_activity_unavailable", "dialogue_unavailable"]));
    expect(JSON.stringify(productionMechanicManifest)).not.toMatch(/evaluatorData|privateSchema|answerKey|rubricId/);
  });
});
