import type { JsonValue } from "@/domain/common";
import type { TaskPublic } from "@/domain/mechanics";
import type {
  ConfusableDiscriminationConfig, CounterexampleConstructionConfig, ExampleConstructionConfig, ProcedureReconstructionConfig,
  RecallReconstructionConfig, RelationalMappingConfig, RepresentationTranslationConfig, RuleInductionConfig,
} from "@/domain/mechanic-families/v2/foundations";
import type { RubricRequest } from "@/server/evaluation/contracts";

// Test fixtures only. These are never authored courses or public catalog records.
export const tolerance = { absTol: 1e-8, relTol: 1e-8 };
export const rubric = (id: string, criterion: string): RubricRequest["rubric"] => ({
  id: "7c570da8-812e-4083-8c01-d7f281d5f786", dimensions: [{ id, criterion,
    met: "The response accurately states the essential relationship, including equivalent wording.",
    partial: "The response contains the relationship but leaves its scope unclear.", notMet: "The response states a different or false relationship." }],
});
export function task<C extends JsonValue & { kind: TaskPublic["mechanicId"] }>(config: C): TaskPublic<C> {
  return { id: "e245817a-58f1-49b6-93b1-706f24911558", taskVersion: 1, mechanicId: config.kind,
    mechanicVersion: 2, responseSchemaVersion: 2, instruction: "Complete this learning task.", outcomeIds: ["d752ac4b-058d-42e9-9727-fb2b5d929e66"],
    contentLanguage: "en", config, availableHints: 1 };
}
export const recall: RecallReconstructionConfig = { kind: "recall_reconstruction", cue: "What does classification accuracy measure?", maxChars: 1000 };
export const distinction: ConfusableDiscriminationConfig = { kind: "confusable_discrimination",
  knownFacts: [{ id: "data", text: "X_all includes training and validation rows. The scaler has not been fitted yet." }],
  cases: [{ id: "fit", text: "scaler.fit(X_all)" }, { id: "transform", text: "scaler.transform(X_validation)" }],
  requestedDistinction: "Which call learns statistics from held-out validation data, and why?" };
export const distinctionPrivate = { acceptedEvidence: [{ caseId: "fit", requiredSpans: [{ blockId: "fit", start: 11, end: 16 }] }],
  rubric: rubric("essential_distinction", "Fitting computes statistics using held-out rows because X_all includes validation. Transforming validation using already fitted training statistics does not itself fit on validation.") };
export const induction: RuleInductionConfig = { kind: "rule_induction", pairs: [[0, 1], [1, 3], [2, 5]], hypothesisClass: "affine", probeXs: [3] };
export const construction: ExampleConstructionConfig = { kind: "example_construction", objectType: "confusion_matrix",
  constraints: { total: 10, falsePositive: 0, minTruePositive: 1, minFalseNegative: 1 } };
export const counterexample: CounterexampleConstructionConfig = { kind: "counterexample_construction",
  claim: "A model with zero training error must also have zero validation error.", modelGrammar: "constant", maxTrainRows: 4, maxValidationRows: 4 };
export const counterexamplePrivate = { predicate: "zero_training_error_implies_zero_validation_error" as const,
  reviewedClaim: counterexample.claim, tolerance };
export const procedure: ProcedureReconstructionConfig = { kind: "procedure_reconstruction", steps: [
  { id: "score", text: "Score the validation predictions" }, { id: "fit_model", text: "Fit the model on transformed training data" },
  { id: "split", text: "Split training and validation data" }, { id: "transform_validation", text: "Transform validation data with the fitted scaler" },
  { id: "fit_scaler", text: "Fit the scaler on training data" }, { id: "predict", text: "Predict the transformed validation data" },
  { id: "transform_train", text: "Transform training data with the fitted scaler" },
] };
export const procedurePrivate = { prerequisites: [
  { before: "split", after: "fit_scaler" }, { before: "fit_scaler", after: "transform_train" },
  { before: "fit_scaler", after: "transform_validation" }, { before: "transform_train", after: "fit_model" },
  { before: "fit_model", after: "predict" }, { before: "transform_validation", after: "predict" }, { before: "predict", after: "score" },
] };
export const validOrder = ["split", "fit_scaler", "transform_train", "fit_model", "transform_validation", "predict", "score"];
export const mapping: RelationalMappingConfig = { kind: "relational_mapping", nodes: [
  { id: "gradient", text: "Gradient" }, { id: "loss", text: "Loss" }, { id: "parameters", text: "Parameters" }, { id: "optimizer", text: "Optimizer" },
], aliases: { weights: "parameters" }, relationTypes: ["gradient_of", "with_respect_to", "updates"] };
export const validEdges = [
  { from: "gradient", relation: "gradient_of", to: "loss" },
  { from: "gradient", relation: "with_respect_to", to: "parameters" },
  { from: "optimizer", relation: "updates", to: "parameters" },
];
export const translation: RepresentationTranslationConfig = { kind: "representation_translation",
  from: { type: "confusion_matrix", tp: 2, fp: 1, fn: 1, tn: 4 }, to: "precision", allowedUnits: ["ratio", "percent"] };
