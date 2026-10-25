import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ConfusableDiscriminationRenderer, CounterexampleConstructionRenderer, ExampleConstructionRenderer,
  ProcedureReconstructionRenderer, RecallReconstructionRenderer, RelationalMappingRenderer,
  RepresentationTranslationRenderer, RuleInductionRenderer, mechanics,
} from "@/features/learning/mechanics/foundations";
import { construction, counterexample, distinction, induction, mapping, procedure, recall, task, translation, validEdges, validOrder } from "./fixtures";

const base = { disabled: false, status: "editing" as const, evaluation: null, onChange: () => {} };
describe("foundations renderer semantics without a provider", () => {
  it("registers distinct text, number, evidence, order, and relation workspaces", () => {
    expect(new Set(mechanics.map((mechanic) => mechanic.Renderer)).size).toBe(8);
    expect(mechanics.every((mechanic) => mechanic.descriptor.version === 2)).toBe(true);
  });
  it("keeps a recalled answer controlled and visible after an assessment error", () => {
    const response = { kind: "recall_reconstruction" as const, action: "recall" as const, text: "One minus classification error rate." };
    const html = renderToStaticMarkup(<RecallReconstructionRenderer {...base} status="error" task={task(recall)} response={response} />);
    expect(html).toContain(response.text);
    expect(html).toContain("Your answer");
    expect(html).not.toContain("readonly");
  });
  it("offers passage selection and a whole-case keyboard alternative without relying on drag", () => {
    const html = renderToStaticMarkup(<ConfusableDiscriminationRenderer {...base} task={task(distinction)} response={{ kind: "confusable_discrimination", action: "distinguish", caseId: "fit", evidenceSpans: [], distinction: "" }} />);
    expect(html).toContain("Use selected passage");
    expect(html).toContain("Use entire case");
    expect(html).toContain("Shift");
    expect(html).toContain("scaler.fit(X_all)");
  });
  it("uses numeric inputs for the rule, probes, and all four constructed cells", () => {
    const inductionHtml = renderToStaticMarkup(<RuleInductionRenderer {...base} task={task(induction)} response={{ kind: "rule_induction", action: "infer_rule", rule: { form: "coefficients", slope: null, intercept: null }, probeValues: [null] }} />);
    expect(inductionHtml.match(/type="number"/g)).toHaveLength(3);
    expect(inductionHtml).toContain("Output when x = 3");
    const matrixHtml = renderToStaticMarkup(<ExampleConstructionRenderer {...base} task={task(construction)} response={{ kind: "example_construction", action: "construct_example", matrix: { tp: null, fp: null, tn: null, fn: null } }} />);
    expect(matrixHtml.match(/type="number"/g)).toHaveLength(4);
    expect(matrixHtml).toContain("Predicted positive");
    expect(matrixHtml).toContain("False negatives");
  });
  it("keeps the predictor and both data tables explicit, with separate row controls", () => {
    const html = renderToStaticMarkup(<CounterexampleConstructionRenderer {...base} task={task(counterexample)} response={{ kind: "counterexample_construction", action: "refute", model: { constant: 0 }, train: [{ x: 0, y: 0 }], validation: [] }} />);
    expect(html).toContain("Constant prediction for every input");
    expect(html).toContain("Training data");
    expect(html).toContain("Validation data");
    expect(html).toContain("Add training row");
    expect(html).toContain("Add validation row");
  });
  it("provides named reorder controls and disables impossible moves", () => {
    const html = renderToStaticMarkup(<ProcedureReconstructionRenderer {...base} task={task(procedure)} response={{ kind: "procedure_reconstruction", action: "order_steps", stepIds: validOrder }} />);
    expect(html).toContain('aria-label="Move step 1 earlier"');
    expect(html).toContain('aria-label="Move step 7 later"');
    expect(html.match(/disabled=""/g)).toHaveLength(2);
    expect(html).toContain("Split training and validation data");
    expect(html).toContain('role="status"');
  });
  it("pairs the real graph with three labelled select controls per relation", () => {
    const html = renderToStaticMarkup(<RelationalMappingRenderer {...base} task={task(mapping)} response={{ kind: "relational_mapping", action: "map_relations", edges: validEdges }} />);
    expect(html).toContain("4 concepts and 3 directed relations");
    expect(html.match(/<select/g)).toHaveLength(9);
    expect(html).toContain("weights (alias of Parameters)");
    expect(html).toContain('aria-label="Remove relation 1"');
  });
  it("keeps matrix source data and compatible units available in a disabled pending state", () => {
    const html = renderToStaticMarkup(<RepresentationTranslationRenderer {...base} disabled status="submitting" task={task(translation)} response={{ kind: "representation_translation", action: "translate_representation", quantity: { value: 66.66666667, unit: "percent" } }} />);
    expect(html).toContain("Confusion matrix");
    expect(html).toContain("Express the precision");
    expect(html).toContain('value="66.66666667"');
    expect(html).toContain("Percent (%)");
    expect(html).toContain("disabled");
    expect(html).not.toContain("byte");
  });
});
