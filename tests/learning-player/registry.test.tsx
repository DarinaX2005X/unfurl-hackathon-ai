import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { serializePublicTask } from "@/domain";
import { getMechanic } from "@/features/learning/registry";
import { UnsupportedTask } from "@/features/learning/player/UnsupportedTask";
import { CapacityConfigSchema, createInitialResponse, sampleTask } from "@/features/learning/sample/content";

describe("learning renderer boundary", () => {
  it("resolves the canonical mechanic/version and gives unsupported formats a useful fallback", () => {
    const mechanic = getMechanic("constrained_optimization", 1);
    expect(mechanic).not.toBeNull();
    expect(mechanic?.configSchema.parse(sampleTask.config)).toEqual(sampleTask.config);
    expect(mechanic?.responseSchema.parse(mechanic.createInitialResponse(sampleTask.config))).toEqual(createInitialResponse());
    expect(getMechanic("model-capacity-v1", 1)).toBeNull();
    expect(getMechanic("constrained_optimization", 2)).toBeNull();
    expect(getMechanic("arbitrary_script", 1)).toBeNull();
    const fallback = renderToStaticMarkup(<UnsupportedTask />);
    expect(fallback).toContain("This activity cannot be opened here");
    expect(fallback).toContain('href="/library"');
  });

  it("uses the public task projection and rejects a foreign dataset", () => {
    const publicTask = serializePublicTask({ ...sampleTask, evaluationSpec: { secret: true }, expectedAnswer: "private" }, CapacityConfigSchema);
    expect(publicTask).not.toHaveProperty("evaluationSpec");
    expect(publicTask).not.toHaveProperty("expectedAnswer");
    expect(CapacityConfigSchema.safeParse({ ...sampleTask.config, dataset: "untrusted-code" }).success).toBe(false);
  });

  it("provides text and data equivalents without exposing submission controls inside the renderer", () => {
    const mechanic = getMechanic(sampleTask.mechanicId, sampleTask.mechanicVersion)!;
    const Renderer = mechanic.Renderer;
    const html = renderToStaticMarkup(<Renderer task={sampleTask} response={createInitialResponse()} onChange={() => undefined} disabled={false} status="editing" evaluation={null} />);
    expect(html).toContain("Training points are circles; validation points are diamonds");
    expect(html).toContain("Observed y");
    expect(html).toContain("Model y");
    expect(html).toContain("0.372");
    expect(html).not.toContain("Check my model");
    expect(html).not.toContain("Get a hint");
    expect(html).not.toContain("Reset practice");
  });
});
