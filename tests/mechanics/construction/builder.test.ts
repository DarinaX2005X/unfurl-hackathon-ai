import { describe, expect, it } from "vitest";
import { canonicalResponseJson, responseDigest, type ActionReceipt, type ActivitySessionPublic } from "../../../src/domain/activity";
import { evaluateExpression, type Expr } from "../../../src/domain/mechanic-families/v2/shared";
import { changeOperation, expressionText, replaceExpressionPart, selectedExpressionPart } from "../../../src/features/learning/mechanics/construction/expression";
import { observationState, reconcileCapturedRun, runArtifactKey } from "../../../src/features/learning/mechanics/construction/run-state";

describe("keyboard expression builder operations", () => {
  const variable: Expr = { op: "variable", name: "x" };
  it("builds a calculation by wrapping and selecting operands without code execution", () => {
    const addition = changeOperation(variable, "add");
    const withNumber = replaceExpressionPart(addition, "/right", { op: "constant", value: 3 });
    expect(evaluateExpression(withNumber, { x: 2 })).toBe(5);
    expect(expressionText(withNumber)).toBe("(x + 3)");
    expect(evaluateExpression(changeOperation(withNumber, "multiply"), { x: 2 })).toBe(6);
  });
  it("edits a nested part without replacing an unrelated operand", () => {
    const expression: Expr = { op: "multiply", left: { op: "abs", value: variable }, right: { op: "constant", value: 2 } };
    const edited = replaceExpressionPart(expression, "/left/value", { op: "constant", value: -4 });
    expect(evaluateExpression(edited, { x: 9 })).toBe(8);
    expect(expression.right).toEqual({ op: "constant", value: 2 });
    expect(() => replaceExpressionPart(expression, "/right/left", variable)).toThrow();
  });
  it("recovers selection when the parent changes the controlled expression", () => {
    expect(selectedExpressionPart(variable, "/left/value")).toEqual({ path: "", expression: variable });
    expect(changeOperation(variable, "variable")).toEqual(variable);
    expect(changeOperation({ op: "constant", value: 2 }, "variable")).toEqual({ op: "constant", value: 0 });
  });
});

describe("Run result identity shown by the renderer", () => {
  const sessionId = "11111111-1111-4111-8111-111111111111";
  const receiptId = "22222222-2222-4222-8222-222222222222";
  const session: ActivitySessionPublic = { id: sessionId, enrollmentId: "33333333-3333-4333-8333-333333333333", taskId: "44444444-4444-4444-8444-444444444444", taskVersion: 1,
    revision: 1, inputRevision: 1, status: "active", remainingActions: 5, events: [] };
  const response = { kind: "constrained_optimization", action: "optimize", configuration: { x: 2 }, observationReceiptId: null };
  async function receipt(): Promise<ActionReceipt> {
    return { id: receiptId, clientActionId: "55555555-5555-4555-8555-555555555555", input: { activitySessionId: sessionId, inputRevision: 1, responseDigest: await responseDigest(response) },
      sessionRevision: 1, status: "completed", observation: { kind: "values", values: [{ id: "result", quantity: { value: 4, unit: "unitless" } }] } };
  }
  it("shows only a matching session, revision and digest as current", async () => {
    const result = await receipt();
    const input = { receipt: result, captured: null, response, digest: result.input.responseDigest, session };
    expect(observationState(input)).toBe("current");
    expect(observationState({ ...input, digest: await responseDigest({ ...response, configuration: { x: 3 } }) })).toBe("historical");
    expect(observationState({ ...input, session: { ...session, inputRevision: 2 } })).toBe("historical");
    expect(observationState({ ...input, session: { ...session, id: crypto.randomUUID() } })).toBe("historical");
  });
  it("recognizes receipt attachment only for a captured verified unchanged configuration", async () => {
    const result = await receipt();
    const withReceipt = { ...response, observationReceiptId: result.id };
    const captured = { receipt: result, responseKey: canonicalResponseJson(response), artifactKey: runArtifactKey(response), verified: true };
    const input = { receipt: result, captured, response: withReceipt, digest: await responseDigest(withReceipt), session: { ...session, inputRevision: 2 }, selectedReceiptId: result.id };
    expect(observationState(input)).toBe("current");
    expect(observationState({ ...input, captured: { ...captured, verified: false } })).toBe("saved");
    expect(observationState({ ...input, response: { ...withReceipt, configuration: { x: 3 } }, selectedReceiptId: null })).toBe("historical");
    expect(observationState({ ...input, captured: null })).toBe("saved");
  });
  it("never labels unavailable or future receipts as current", async () => {
    const result = await receipt();
    const input = { receipt: result, captured: null, response, digest: result.input.responseDigest, session };
    expect(observationState({ ...input, receipt: { ...result, status: "unavailable", observation: null } })).toBe("historical");
    expect(observationState({ ...input, receipt: { ...result, sessionRevision: 2 } })).toBe("historical");
  });
  it("replaces a pending receipt with its completed authoritative event without changing the input identity", async () => {
    const result = await receipt();
    const captured = { receipt: { ...result, status: "pending" as const, observation: null }, responseKey: canonicalResponseJson(response), artifactKey: runArtifactKey(response), verified: true };
    const completedSession: ActivitySessionPublic = { ...session, events: [{ id: crypto.randomUUID(), seq: 1, at: "2026-10-25T08:00:00.000Z", action: { kind: "run" }, receipt: result }] };
    expect(reconcileCapturedRun(captured, completedSession)?.receipt.status).toBe("completed");
    completedSession.events[0]!.receipt = { ...result, input: { ...result.input, responseDigest: "a".repeat(64) } };
    expect(reconcileCapturedRun(captured, completedSession)?.receipt.status).toBe("pending");
    expect(reconcileCapturedRun(captured, { ...completedSession, id: crypto.randomUUID() })).toBeNull();
  });
});
