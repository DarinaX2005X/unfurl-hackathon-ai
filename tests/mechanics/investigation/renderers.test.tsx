import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { JsonValue } from "@/domain/common";
import type { ProductionMechanic, TaskRendererProps } from "@/features/learning/player/contracts";
import * as ui from "@/features/learning/mechanics/investigation";
import { ObservationPlot } from "@/features/learning/mechanics/investigation/common";
import { tracing, prediction, diagnosis, experiment, intervention, estimation, strategy, source, task, experimentCase } from "./fixtures";

function render<C extends JsonValue & { kind: import("@/domain/mechanics").MechanicId }, R extends JsonValue>(mechanic: ProductionMechanic<C, R>, config: C, extra: Partial<TaskRendererProps<C, R>> = {}) {
  return renderToStaticMarkup(createElement(mechanic.Renderer, { task: task(config), response: mechanic.createInitialResponse(config), onChange: () => {}, disabled: false, status: "editing", evaluation: null, ...extra }));
}
describe("investigation work surfaces", () => {
  it("renders eight distinct editable actions without manufacturing observations", () => {
    expect(render(ui.stateTracingMechanic, tracing)).toContain("w after step 2 (unitless)");
    const predictionHtml = render(ui.outcomePredictionMechanic, prediction);
    expect(predictionHtml).toContain("Commit prediction");
    expect(predictionHtml).toContain("Run model");
    expect(predictionHtml).not.toContain("Saved observation");
    expect(render(ui.causeDiagnosisMechanic, diagnosis)).toContain("Evidence that would distinguish the causes");
    const experimentHtml = render(ui.experimentalInvestigationMechanic, experiment);
    expect(experimentHtml).toContain("Measure output");
    expect(experimentHtml).not.toContain("Recorded measurements");
    expect(render(ui.causalInterventionMechanic, intervention)).toContain("Input intervention");
    expect(render(ui.estimationMechanic, estimation)).toContain("Calculation and assumptions");
    expect(render(ui.strategySelectionMechanic, strategy)).toContain("Add assumption");
    expect(render(ui.sourceInvestigationMechanic, source)).toContain("Cite this passage");
  });
  it("renders real receipt values with labelled axes and an always-readable numeric table", async () => {
    const recorded = await experimentCase(2);
    const html = render(ui.experimentalInvestigationMechanic, experiment, { task: recorded.task, response: recorded.response, activity: { session: recorded.activity.session, pending: false, error: null, dispatch: vi.fn(), retryAction: vi.fn() } });
    expect(html).toContain("Output (unitless)");
    expect(html).toContain("x (unitless)");
    expect(html).toContain("Recorded measurements");
    expect(html).toContain("<td>2</td><td>4</td>");
    expect(html).not.toContain("Correct answer");
  });
  it("offers a way to restore recorded measurements without spending another query", async () => {
    const recorded = await experimentCase();
    const html = render(ui.experimentalInvestigationMechanic, experiment, { task: recorded.task, response: { ...recorded.response, observationReceiptIds: [] }, activity: { session: recorded.activity.session, pending: false, error: null, dispatch: vi.fn(), retryAction: vi.fn() } });
    expect(html).toContain("Use recorded measurements");
    expect(html).toContain("<td>1</td><td>2</td>");
  });
  it("retains source content and source-specific citations as data", () => {
    const html = render(ui.sourceInvestigationMechanic, source);
    expect(html).toContain("https://example.invalid/synthetic-preprocessing");
    expect(html).toContain("Synthetic fixture: fitting preprocessing");
    expect(html).toContain("Explain the support and its limits");
    expect(html).not.toContain(source.sources[0]!.contentDigest);
  });
  it("keeps the finite numerical range finite when plotting opposite extreme values", () => {
    const html = renderToStaticMarkup(<ObservationPlot inputVariable="x" points={[{ id: "negative", x: -1e308, y: -1e308 }, { id: "positive", x: 1e308, y: 1e308 }]} />);
    expect(html).not.toMatch(/NaN|Infinity/);
    expect(html).toContain("1E308");
    expect(html).toContain("left:95%;top:5%");
  });
});
