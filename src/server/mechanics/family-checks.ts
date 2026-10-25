import "server-only";
import type { JsonObject } from "@/domain/common";
import type { TaskPublic } from "@/domain/mechanics";
import {
  ConfusableDiscriminationConfigSchema, CounterexampleConstructionConfigSchema,
  ProcedureReconstructionConfigSchema, RelationalMappingConfigSchema,
} from "@/domain/mechanic-families/v2/foundations";
import {
  StateTracingConfigSchema, OutcomePredictionConfigSchema, CauseDiagnosisConfigSchema,
  ExperimentalInvestigationConfigSchema, CausalInterventionConfigSchema, EstimationConfigSchema,
  StrategySelectionConfigSchema, SourceInvestigationConfigSchema,
  traceState, predictOutcome, experimentOutput, evaluateCausalModel,
} from "@/domain/mechanic-families/v2/investigation";
import {
  PlanConstructionConfigSchema, ArtifactConstructionConfigSchema, DiagnosisRepairConfigSchema,
  AdversarialTestingConfigSchema, ConstrainedOptimizationConfigSchema, resolveExpressionPointer,
  expressionNodeCount, type PlanConstructionConfig,
} from "@/domain/mechanic-families/v2/construction";
import { InformationGapConfigSchema, RoleSimulationConfigSchema } from "@/domain/mechanic-families/v2/communication";
import {
  convertQuantity, evaluateBoundedModel, evaluateExpression, validateExpression, withinTolerance,
  type BoundedVariable, type Expr,
} from "@/domain/mechanic-families/v2/shared";
import {
  validateConfusableDiscriminationPrivate, validateCounterexampleConstructionPrivate,
  validateProcedureReconstructionPrivate, validateRelationalMappingPrivate,
} from "@/server/evaluation/foundations";
import {
  CauseDiagnosisPrivateSchema, ExperimentalInvestigationPrivateSchema, CausalInterventionPrivateSchema,
  EstimationPrivateSchema, StrategySelectionPrivateSchema, SourceInvestigationPrivateSchema,
  hasDistinguishableHypotheses, hasSourceProvenance,
} from "@/server/evaluation/investigation";
import {
  PlanConstructionPrivateSchema, ArtifactConstructionPrivateSchema, DiagnosisRepairPrivateSchema,
  AdversarialTestingPrivateSchema, ConstrainedOptimizationPrivateSchema,
  type ArtifactConstructionPrivate, type PlanConstructionPrivate,
} from "@/server/evaluation/construction";
import { InformationGapPrivateSchema, RoleSimulationPrivateSchema } from "@/server/evaluation/communication";
import { RubricRequestSchema } from "@/server/evaluation/contracts";
import type { ValidationCheckId } from "./contracts";

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
const SEARCH_LIMIT = 10_000;
/** A complete bounded search can prove absence. A truncated search cannot. */
function gridWitness(variables: readonly BoundedVariable[], accepts: (input: Record<string, number>) => boolean): boolean | null {
  const counts = variables.map((variable) => Math.floor((variable.max - variable.min) / variable.step + 1e-9) + 1);
  const size = counts.reduce((product, count) => product * count, 1);
  if (!Number.isSafeInteger(size) || size > SEARCH_LIMIT) return null;
  const input: Record<string, number> = {};
  const search = (index: number): boolean => {
    if (index === variables.length) return accepts(input);
    const variable = variables[index]!;
    for (let step = 0; step < counts[index]!; step++) {
      input[variable.id] = variable.min + step * variable.step;
      if (search(index + 1)) return true;
    }
    return false;
  };
  return search(0);
}

function planWitness(config: PlanConstructionConfig, data: PlanConstructionPrivate): boolean | null {
  const vocabulary = new Set([...config.initialFacts, ...config.operators.flatMap((operator) => operator.adds)]);
  requireCondition([...data.requiredFinalFacts, ...data.invariants.flatMap((item) => item.forbidAll)].every((fact) => vocabulary.has(fact)), "Private plan criteria reference an undeclared fact");
  const violates = (facts: Set<string>) => data.invariants.some((invariant) => invariant.forbidAll.every((fact) => facts.has(fact)));
  requireCondition(!violates(new Set(config.initialFacts)), "The plan's starting state violates an invariant");
  let frontier = [{ facts: new Set(config.initialFacts), cost: 0 }], visits = 0;
  const seen = new Map<string, number>();
  for (let depth = 0; depth < config.budgetSteps; depth++) {
    const next: typeof frontier = [];
    for (const state of frontier) for (const operator of config.operators) {
      if (++visits > SEARCH_LIMIT) return null;
      if (operator.requires.some((fact) => !state.facts.has(fact))) continue;
      const cost = state.cost + operator.cost;
      if (!Number.isFinite(cost) || cost > config.budgetCost) continue;
      const facts = new Set(state.facts);
      operator.removes.forEach((fact) => facts.delete(fact));
      operator.adds.forEach((fact) => facts.add(fact));
      if (violates(facts)) continue;
      if (data.requiredFinalFacts.every((fact) => facts.has(fact))) return true;
      const key = [...facts].sort().join("\u0000");
      if ((seen.get(key) ?? Infinity) <= cost) continue;
      seen.set(key, cost); next.push({ facts, cost });
    }
    frontier = next;
    if (!frontier.length) return false;
  }
  return false;
}

function numericReference(data: ArtifactConstructionPrivate, names: string[]): void {
  requireCondition(validateExpression(data.reference, names).length === 0, "The reference expression uses undeclared variables");
  const value = (input: Record<string, number>) => {
    requireCondition(Object.keys(input).length === names.length && names.every((name) => Object.hasOwn(input, name)), "Reference cases must supply exactly the declared variables");
    return evaluateExpression(data.reference, input, names);
  };
  data.cases.forEach((item) => value(item.input));
  data.properties.forEach((property) => {
    const actual = value(property.input);
    requireCondition(property.kind === "nonnegative" ? actual >= 0 || withinTolerance(actual, 0, data.tolerance) :
      withinTolerance(actual, value(property.otherInput), data.tolerance), "The reference contradicts a required numeric property");
  });
}
function numericPasses(expression: Expr, data: ArtifactConstructionPrivate, names: string[]): boolean {
  try {
    return data.cases.every((item) => withinTolerance(evaluateExpression(expression, item.input, names), evaluateExpression(data.reference, item.input, names), data.tolerance)) &&
      data.properties.every((property) => {
        const value = evaluateExpression(expression, property.input, names);
        return property.kind === "nonnegative" ? value >= 0 || withinTolerance(value, 0, data.tolerance) :
          withinTolerance(value, evaluateExpression(expression, property.otherInput, names), data.tolerance);
      });
  } catch { return false; }
}

function experimentWithinBudget(config: ReturnType<typeof ExperimentalInvestigationConfigSchema.parse>, data: ReturnType<typeof ExperimentalInvestigationPrivateSchema.parse>): boolean | null {
  const alternatives = config.hypotheses.filter((hypothesis) => hypothesis.id !== data.hiddenHypothesisId);
  const target = (1 << alternatives.length) - 1;
  const masks = [...new Set(config.allowedInputs.map((input) => alternatives.reduce((mask, hypothesis, index) =>
    mask | (!withinTolerance(experimentOutput(config, hypothesis.id, input), experimentOutput(config, data.hiddenHypothesisId, input), data.tolerance) ? (1 << index) : 0), 0)))];
  let states = new Set([0]);
  for (let turn = 0; turn < config.queryBudget; turn++) {
    const next = new Set(states);
    for (const state of states) for (const mask of masks) {
      if ((state | mask) === target) return true;
      next.add(state | mask);
      if (next.size > SEARCH_LIMIT) return null;
    }
    if (next.size === states.size) return false;
    states = next;
  }
  return false;
}

/** Pure cross-schema checks; prose interpretation is explicitly left to external receipts. */
export function inspectFamilyCandidate(task: TaskPublic, data: JsonObject): ValidationCheckId[] {
  const external = new Set<ValidationCheckId>();
  const reachable = (result: boolean | null) => {
    requireCondition(result !== false, "The authored goal has no reachable witness within its declared bounds");
    if (result === null) external.add("reachability");
  };
  for (const key of ["rubric", "basisRubric", "explanationRubric"]) {
    if (data[key] !== undefined && data[key] !== null) {
      const rubric = RubricRequestSchema.shape.rubric.parse(data[key]);
      requireCondition(new Set(rubric.dimensions.map((dimension) => dimension.id)).size === rubric.dimensions.length, "Rubric dimensions must be unique");
    }
  }
  switch (task.mechanicId) {
    case "confusable_discrimination": validateConfusableDiscriminationPrivate(ConfusableDiscriminationConfigSchema.parse(task.config), data); break;
    case "counterexample_construction":
      validateCounterexampleConstructionPrivate(CounterexampleConstructionConfigSchema.parse(task.config), data);
      external.add("counterexample_claim"); break;
    case "procedure_reconstruction": validateProcedureReconstructionPrivate(ProcedureReconstructionConfigSchema.parse(task.config), data); break;
    case "relational_mapping": validateRelationalMappingPrivate(RelationalMappingConfigSchema.parse(task.config), data); break;
    case "state_tracing": traceState(StateTracingConfigSchema.parse(task.config)); break;
    case "outcome_prediction": predictOutcome(OutcomePredictionConfigSchema.parse(task.config)); break;
    case "cause_diagnosis": {
      const config = CauseDiagnosisConfigSchema.parse(task.config), privateData = CauseDiagnosisPrivateSchema.parse(data);
      requireCondition(privateData.consistentCauseIds.every((id) => config.candidateCauses.some((cause) => cause.id === id)), "Private causes must reference displayed candidates"); break;
    }
    case "experimental_investigation": {
      const config = ExperimentalInvestigationConfigSchema.parse(task.config), privateData = ExperimentalInvestigationPrivateSchema.parse(data);
      requireCondition(config.hypotheses.some((item) => item.id === privateData.hiddenHypothesisId), "The hidden hypothesis is not declared");
      requireCondition(hasDistinguishableHypotheses(config, privateData.tolerance), "Hypotheses are indistinguishable within the authored tolerance");
      reachable(experimentWithinBudget(config, privateData)); break;
    }
    case "causal_intervention": {
      const config = CausalInterventionConfigSchema.parse(task.config), privateData = CausalInterventionPrivateSchema.parse(data);
      reachable(gridWitness(config.variables, (input) => {
        try { return withinTolerance(evaluateCausalModel(config, input).find((output) => output.id === config.target.variableId)!.quantity.value, config.target.quantity.value, privateData.tolerance); }
        catch { return false; }
      })); break;
    }
    case "estimation": {
      const config = EstimationConfigSchema.parse(task.config), privateData = EstimationPrivateSchema.parse(data);
      config.allowedUnits.forEach((unit) => convertQuantity(privateData.referenceQuantity, unit));
      requireCondition(Number.isFinite(Math.abs(privateData.referenceQuantity.value) * config.maxRelativeIntervalWidth), "The estimate's interval width is nonfinite"); break;
    }
    case "strategy_selection": {
      const config = StrategySelectionConfigSchema.parse(task.config), privateData = StrategySelectionPrivateSchema.parse(data);
      requireCondition(privateData.targetSpecified, "The intended decision target remains unspecified");
      requireCondition(privateData.admissibleStrategyIds.every((id) => config.strategies.some((strategy) => strategy.id === id)), "An admissible strategy is absent from the task"); break;
    }
    case "source_investigation": {
      const config = SourceInvestigationConfigSchema.parse(task.config), privateData = SourceInvestigationPrivateSchema.parse(data);
      requireCondition(hasSourceProvenance(config, privateData), "Public source passages differ from the private snapshot");
      external.add("source_grounding"); break;
    }
    case "plan_construction": reachable(planWitness(PlanConstructionConfigSchema.parse(task.config), PlanConstructionPrivateSchema.parse(data))); break;
    case "artifact_construction": {
      const config = ArtifactConstructionConfigSchema.parse(task.config), privateData = ArtifactConstructionPrivateSchema.parse(data);
      numericReference(privateData, config.variables.map((variable) => variable.id));
      if (expressionNodeCount(privateData.reference) > config.maxNodes) external.add("reachability"); break;
    }
    case "diagnosis_repair": {
      const config = DiagnosisRepairConfigSchema.parse(task.config), privateData = DiagnosisRepairPrivateSchema.parse(data);
      const names = config.variables.map((variable) => variable.id);
      numericReference(privateData, names);
      requireCondition(privateData.acceptedLocationSets.every((locations) => locations.every((path) => resolveExpressionPointer(config.initialExpression, path).found)), "An accepted defect location is absent from the original expression");
      requireCondition(!numericPasses(config.initialExpression, privateData, names), "The original expression already passes every required numeric check"); break;
    }
    case "adversarial_testing": {
      const config = AdversarialTestingConfigSchema.parse(task.config), privateData = AdversarialTestingPrivateSchema.parse(data);
      const names = config.variables.map((variable) => variable.id);
      requireCondition(validateExpression(privateData.oracle, names).length === 0, "The oracle uses undeclared variables");
      reachable(gridWitness(config.variables, (input) => {
        let expected: number;
        try { expected = evaluateExpression(privateData.oracle, input, names); } catch { return false; }
        try { return !withinTolerance(evaluateExpression(config.candidate, input, names), expected, privateData.tolerance); } catch { return true; }
      })); break;
    }
    case "constrained_optimization": {
      const config = ConstrainedOptimizationConfigSchema.parse(task.config), privateData = ConstrainedOptimizationPrivateSchema.parse(data);
      const baseline = evaluateBoundedModel(config.model, config.baseline).find((output) => output.id === config.objective.outputId)!.quantity.value;
      reachable(gridWitness(config.model.inputs, (input) => {
        try {
          const outputs = new Map(evaluateBoundedModel(config.model, input).map((output) => [output.id, output.quantity.value]));
          if (!config.constraints.every((constraint) => constraint.operator === "lte" ? outputs.get(constraint.outputId)! <= constraint.value : outputs.get(constraint.outputId)! >= constraint.value)) return false;
          const value = outputs.get(config.objective.outputId)!;
          const improvement = config.objective.direction === "maximize" ? value - baseline : baseline - value;
          return Number.isFinite(improvement) && (improvement >= config.objective.minimumImprovement || withinTolerance(improvement, config.objective.minimumImprovement, privateData.tolerance));
        } catch { return false; }
      })); break;
    }
    case "information_gap": {
      const config = InformationGapConfigSchema.parse(task.config), privateData = InformationGapPrivateSchema.parse(data);
      requireCondition(privateData.hiddenFacts.every((fact) => !config.knownFacts.some((known) => known.id === fact.id)), "A hidden fact is already declared as known");
      external.add("dialogue_compatibility"); external.add("reachability"); break;
    }
    case "role_simulation": {
      const config = RoleSimulationConfigSchema.parse(task.config), privateData = RoleSimulationPrivateSchema.parse(data);
      for (const fact of privateData.scenarioConstraints) {
        const publicFact = [...config.constraints, ...config.knownFacts].find((item) => item.id === fact.id);
        requireCondition(!publicFact || publicFact.text === fact.text, "A private scenario fact contradicts the public fact with the same identifier");
      }
      external.add("dialogue_compatibility"); external.add("reachability"); break;
    }
    case "misconception_tutoring": external.add("dialogue_compatibility"); external.add("reachability"); break;
  }
  return [...external];
}
