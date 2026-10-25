import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));

import type { JsonValue } from "../../../src/domain/common";
import type { Evaluation } from "../../../src/domain/learning";
import type { ActivityController, ProductionMechanic } from "../../../src/features/learning/player/contracts";
import {
  mechanics, analogyTransferMechanic, selfExplanationMechanic, argumentRebuttalMechanic, critiqueRevisionMechanic,
  misconceptionTutoringMechanic, informationGapMechanic, roleSimulationMechanic, audienceMediationMechanic,
} from "../../../src/features/learning/mechanics/communication";
import { canSendDialogue } from "../../../src/features/learning/mechanics/communication/Workspace";
import { analogy, explanation, argument, critique, tutoring, information, role, mediation, ids, taskFor, type FamilyFixture } from "./fixtures";

function markup<C extends JsonValue, R extends JsonValue, P>(mechanic: ProductionMechanic<C, R>, fixture: FamilyFixture<C, R, P>,
  options: { response?: R; disabled?: boolean; evaluation?: Evaluation; activity?: ActivityController } = {}) {
  return renderToStaticMarkup(createElement(mechanic.Renderer, {
    task: taskFor(fixture), response: options.response ?? mechanic.createInitialResponse(fixture.config), onChange: () => {},
    disabled: options.disabled ?? false, status: "editing", evaluation: options.evaluation ?? null,
    ...(options.activity ? { activity: options.activity } : {}),
  }));
}
function controller(status: "active" | "budget_exhausted" | "completed" = "active"): ActivityController {
  return {
    session: { id: ids.session, enrollmentId: ids.enrollment, taskId: ids.task, taskVersion: 1, revision: 1, inputRevision: 1,
      status, remainingActions: status === "budget_exhausted" ? 0 : 2, events: [] },
    pending: false, error: null, dispatch: vi.fn(async () => { throw new Error("No provider is connected in a renderer test"); }),
    retryAction: vi.fn(async () => { throw new Error("No provider is connected in a renderer test"); }),
  };
}

describe("production communication registrations", () => {
  it("registers eight distinct v2 actions using each descriptor's actual schemas and initial response", () => {
    expect(mechanics.map((mechanic) => mechanic.descriptor.id)).toEqual([
      "analogy_transfer", "self_explanation", "argument_rebuttal", "critique_revision", "misconception_tutoring",
      "information_gap", "role_simulation", "audience_mediation",
    ]);
    for (const mechanic of mechanics) {
      expect(mechanic.configSchema).toBe(mechanic.descriptor.configSchema);
      expect(mechanic.responseSchema).toBe(mechanic.descriptor.responseSchema);
      expect(mechanic.createInitialResponse).toBe(mechanic.descriptor.createInitialResponse);
    }
  });
  it("exposes the distinct working action and response parts for each family", () => {
    const rendered = [
      [markup(analogyTransferMechanic, analogy), ["Source setting", "New setting", "Add a relationship", "Where does the analogy stop working?"]],
      [markup(selfExplanationMechanic, explanation), ["The step to explain", "Why does this step work?", "When does this reasoning stop applying?"]],
      [markup(argumentRebuttalMechanic, argument), ["Your claim", "Select the material supporting your claim", "The strongest case for the objection", "Your response to the objection"]],
      [markup(critiqueRevisionMechanic, critique), ["Original draft", "Your revision", "Add a finding"]],
      [markup(misconceptionTutoringMechanic, tutoring), ["The simulated learner", "The question that reveals the misunderstanding", "A fresh question to check understanding"]],
      [markup(informationGapMechanic, information), ["What is already known", "Your decision and the facts that support it"]],
      [markup(roleSimulationMechanic, role), ["Your role", "Constraints to respect", "Add commitment", "Add condition"]],
      [markup(audienceMediationMechanic, mediation), ["Your audience", "Source facts to preserve", "Your message"]],
    ] as const;
    for (const [html, labels] of rendered) {
      for (const label of labels) expect(html).toContain(label);
      expect(html).not.toContain("Check answer");
      expect(html).not.toContain("Award XP");
    }
  });
});

describe("writing and assessment states", () => {
  it("renders controlled multiline text literally and escapes injected markup", () => {
    const response = { ...explanation.cases[0]!.response, principle: 'First line\n<script>alert("x")</script>\nThird line' };
    const html = markup(selfExplanationMechanic, explanation, { response });
    expect(html).toContain("First line\n&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;\nThird line");
    expect(html).not.toContain('<script>alert("x")</script>');
    expect(response.principle).toContain("\nThird line");
  });
  it("retains both original material and the current revision during an unresolved assessment", () => {
    const evaluation: Evaluation = {
      id: ids.rubric, attemptId: ids.outcome, status: "uncertain", outcome: null, awardedXp: 0,
      dimensions: [{ id: "revision", status: "uncertain", explanation: "The substantive scope needs another review." }],
      feedback: { explanation: "Your revision remains available while this assessment is clarified.", nextAction: "clarify" },
    };
    const html = markup(critiqueRevisionMechanic, critique, { response: critique.cases[2]!.response, evaluation });
    expect(html).toContain(critique.config.draft);
    expect(html).toContain(critique.cases[2]!.response.revision);
    expect(html).toContain("Assessment needs review");
    expect(html).toContain("Substantive revision");
    expect(html).toContain("The substantive scope needs another review.");
    expect(html).not.toContain("Correct answer");
  });
  it("shows selected spans as actual text and exposes citation without requiring drag", () => {
    const html = markup(critiqueRevisionMechanic, critique, { response: critique.cases[0]!.response });
    expect(html).toContain("Cite selected passage");
    expect(html).toContain("Use whole draft");
    expect(html).toContain(critique.config.draft.slice(critique.cases[0]!.response.findings[0]!.span!.start));
    expect(html.toLowerCase()).toContain("readonly");
  });
  it("uses disabled controls from the player without creating a second submission state", () => {
    const html = markup(selfExplanationMechanic, explanation, { response: explanation.cases[0]!.response, disabled: true });
    expect((html.match(/disabled=""/g) ?? []).length).toBe(2);
    expect(html).toContain(explanation.cases[0]!.response.principle);
    expect(html).not.toContain('type="submit"');
  });
});

describe("dialogue states", () => {
  it("never invents a partner reply when the activity service is unavailable", () => {
    const html = markup(misconceptionTutoringMechanic, tutoring);
    expect(html).toContain("The conversation is unavailable. You can keep editing your final response.");
    expect(html).not.toContain("Scenario response");
    expect(html).not.toContain("I now understand");
  });
  it("shows only actual stored turns and revealed fact choices", () => {
    const activity = controller();
    activity.session!.events = [{ id: ids.unknown, seq: 1, at: "2026-10-25T00:00:00.000Z", action: { kind: "dialogue.turn", text: "What target will deployment serve?" },
      receipt: { id: ids.turn, clientActionId: ids.secondTurn, input: { activitySessionId: ids.session, inputRevision: 1, responseDigest: "a".repeat(64) },
        sessionRevision: 1, status: "completed", observation: { kind: "dialogue", text: "The target is future new organizations.",
          revealedFacts: [{ id: "future_new_organizations", text: "Future cases from unseen organizations." }] } } }];
    const html = markup(informationGapMechanic, information, { activity, response: information.cases[0]!.response });
    expect(html).toContain("What target will deployment serve?");
    expect(html).toContain("The target is future new organizations.");
    expect(html).toContain("Future cases from unseen organizations.");
    expect(html).toContain("Use this exchange in my response");
    expect(html).not.toContain("hiddenFacts");
    expect(activity.dispatch).not.toHaveBeenCalled();
  });
  it("blocks exploratory sends when exhausted while leaving the final response enabled", () => {
    const activity = controller("budget_exhausted");
    expect(canSendDialogue(activity, "A further question", false)).toBe(false);
    const html = markup(informationGapMechanic, information, { activity, response: information.cases[3]!.response });
    expect(html).toContain("No turns remain. You can submit your final response.");
    const finalTextarea = html.match(/<textarea[^>]*>[^<]*Use future-period cases[^<]*<\/textarea>/)?.[0];
    expect(finalTextarea).toBeDefined();
    expect(finalTextarea).not.toContain("disabled");
  });
  it("respects pending, blank, overlong, completed, and missing activity boundaries", () => {
    const activity = controller();
    expect(canSendDialogue(activity, "A targeted question", false)).toBe(true);
    expect(canSendDialogue({ ...activity, pending: true }, "A targeted question", false)).toBe(false);
    expect(canSendDialogue(activity, "   ", false)).toBe(false);
    expect(canSendDialogue(activity, "x".repeat(4001), false)).toBe(false);
    expect(canSendDialogue(activity, "A targeted question", true)).toBe(false);
    expect(canSendDialogue(controller("completed"), "A targeted question", false)).toBe(false);
    expect(canSendDialogue(undefined, "A targeted question", false)).toBe(false);
  });
  it("renders the controlled turn draft after remount and exposes retry for an exhausted known receipt", () => {
    const activity = controller("budget_exhausted");
    const draft = "Which deployment organizations are new?\nKeep the time period explicit.";
    activity.session!.events = [{ id: ids.unknown, seq: 1, at: "2026-10-25T00:00:00.000Z", action: { kind: "dialogue.turn", text: draft },
      receipt: { id: ids.turn, clientActionId: ids.secondTurn, input: { activitySessionId: ids.session, inputRevision: 1, responseDigest: "a".repeat(64) },
        sessionRevision: 1, status: "unavailable", observation: null } }];
    const response = { ...information.cases[0]!.response, dialogueDraft: draft };
    const html = markup(informationGapMechanic, information, { activity, response });
    expect(html).toContain(draft);
    expect(html).toContain("Clear turn draft");
    expect(html).toMatch(/<button(?![^>]*disabled)[^>]*>.*?Retry turn/s);
    expect(canSendDialogue(activity, draft, false)).toBe(false);
    expect(activity.retryAction).not.toHaveBeenCalled();
  });
});
