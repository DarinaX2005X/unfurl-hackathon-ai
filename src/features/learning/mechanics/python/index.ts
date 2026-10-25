"use client";

import { pythonArtifactDescriptor, pythonRepairDescriptor, type PythonArtifactConfig, type PythonArtifactResponse, type PythonRepairConfig, type PythonRepairResponse } from "@/domain/mechanic-families/v3/python";
import type { ProductionMechanic } from "@/features/learning/player/contracts";
import { PythonArtifactRenderer, PythonRepairRenderer } from "./renderers";

export const pythonArtifactMechanic: ProductionMechanic<PythonArtifactConfig, PythonArtifactResponse, 3> = {
  descriptor: pythonArtifactDescriptor, configSchema: pythonArtifactDescriptor.configSchema, responseSchema: pythonArtifactDescriptor.responseSchema,
  createInitialResponse: pythonArtifactDescriptor.createInitialResponse, Renderer: PythonArtifactRenderer, summarizeResponse: (response) => `Python function, ${response.source.split("\n").length} lines`,
};
export const pythonRepairMechanic: ProductionMechanic<PythonRepairConfig, PythonRepairResponse, 3> = {
  descriptor: pythonRepairDescriptor, configSchema: pythonRepairDescriptor.configSchema, responseSchema: pythonRepairDescriptor.responseSchema,
  createInitialResponse: pythonRepairDescriptor.createInitialResponse, Renderer: PythonRepairRenderer, summarizeResponse: (response) => `Python repair, ${response.locations.length} identified regions`,
};
export const mechanics = [pythonArtifactMechanic, pythonRepairMechanic] as const;
