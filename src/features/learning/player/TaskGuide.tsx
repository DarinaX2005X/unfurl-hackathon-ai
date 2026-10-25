"use client";

import { useState } from "react";
import { Button } from "@/components/ui";
import type { TaskPublic } from "@/domain";
import styles from "./player.module.css";

type GuideKind = "text" | "choice" | "sequence" | "relation" | "interval" | "table" | "experiment" | "code" | "dialogue" | "source";
type Guide = { kind: GuideKind; title: string; action: string; check: string };
export const taskGuides: Readonly<Record<string, Guide>> = {
  recall_reconstruction: { kind: "text", title: "Reconstruct the idea", action: "Read the cue, then write the idea in your own words in the response field.", check: "Include the relationships the prompt asks for. Submit when your explanation is complete." },
  confusable_discrimination: { kind: "choice", title: "Make the distinction", action: "Compare the alternatives, choose one, and select a passage from that case as evidence.", check: "Explain the feature that separates it from the others. Your selection, passage and reason are submitted together." },
  rule_induction: { kind: "table", title: "Find a rule in the examples", action: "Compare the provided cases. Enter a rule that explains their shared pattern, then apply it to the requested case.", check: "Use the editable rule controls; the example cases remain available for comparison." },
  example_construction: { kind: "table", title: "Build an example", action: "Enter the requested values so your example satisfies every stated condition.", check: "Check the full set of conditions before submitting your constructed example." },
  counterexample_construction: { kind: "table", title: "Test the claim with a counterexample", action: "Construct values that meet the claim’s assumptions but break its conclusion.", check: "Your example must satisfy the assumptions as well as demonstrate the failure." },
  procedure_reconstruction: { kind: "sequence", title: "Put the procedure in order", action: "Use each step’s move controls to arrange the procedure from first to last.", check: "Read your completed sequence from top to bottom before submitting." },
  relational_mapping: { kind: "relation", title: "Connect the concepts", action: "Choose a starting concept, a relationship, and a destination. Add a connection for each relationship you need.", check: "Direction matters: ‘from’ and ‘to’ define different roles. Review the connection list before submitting." },
  representation_translation: { kind: "table", title: "Translate the representation", action: "Read the given matrix, calculate the requested measure, and enter its value with a compatible unit.", check: "Check whether your answer is a ratio or a percentage." },
  state_tracing: { kind: "table", title: "Trace one state at a time", action: "Fill one row for each input step. Every update in a row uses the values from the previous state.", check: "Complete all intermediate values, not just the final state." },
  outcome_prediction: { kind: "interval", title: "Predict before observing", action: "Enter your lower and upper prediction bounds and unit, then commit the prediction. Run the model after committing.", check: "The observation is attached to your saved prediction. A later edit needs its own commitment and run." },
  cause_diagnosis: { kind: "choice", title: "Separate possible causes", action: "Read the observations and retain the causes that remain consistent with them. State whether they identify one cause.", check: "Explain what further evidence would distinguish the remaining possibilities." },
  experimental_investigation: { kind: "experiment", title: "Choose a useful measurement", action: "Set a query input and make a measurement. Compare the saved observation with the competing hypotheses.", check: "Queries are limited. Select a conclusion, or keep it inconclusive, and explain what your measurements establish." },
  causal_intervention: { kind: "experiment", title: "Change an input and inspect the result", action: "Set the available input variables, then apply the intervention to record the model’s output.", check: "Derived variables are calculated by the model. Submit the configuration whose observation you want assessed." },
  estimation: { kind: "interval", title: "Give a defensible range", action: "Use the supplied facts to enter lower and upper bounds, then choose the unit.", check: "Explain the quantities and assumptions behind your estimate in the reasoning field." },
  strategy_selection: { kind: "choice", title: "Choose for this situation", action: "Compare the strategies against the stated constraints. Select one and add the assumptions it depends on.", check: "Explain how your choice fits this situation in the justification field." },
  source_investigation: { kind: "source", title: "Connect a claim to its evidence", action: "Read the source passages, choose a verdict about the claim, and add the specific passages that support it.", check: "Explain how the cited passages support or limit the claim. A source title alone is not a citation." },
  plan_construction: { kind: "sequence", title: "Construct an executable plan", action: "Add steps using the available actions and arrange them in the order they should happen.", check: "Check the goal, dependencies and constraints against the entire plan." },
  artifact_construction: { kind: "code", title: "Build, run, then submit", action: "Construct the requested artifact with the editor. Run it to inspect its result before deciding what to change.", check: "Run records an observation. Submit sends the current answer for assessment." },
  diagnosis_repair: { kind: "code", title: "Locate and repair the fault", action: "Identify the faulty part of the original, edit the repaired artifact, and explain why the change fixes its behavior.", check: "Run checks the repaired artifact. Submit includes the fault location, repair and explanation." },
  adversarial_testing: { kind: "experiment", title: "Design a test that exposes a failure", action: "Add inputs and expected results that challenge the supplied implementation, then run the tests.", check: "Use the observed results to choose a useful test set before submitting." },
  constrained_optimization: { kind: "experiment", title: "Improve the result within the limits", action: "Adjust the available controls and run the configuration to inspect its measured result.", check: "Compare the objective with the stated limits. Submit the configuration you choose." },
  analogy_transfer: { kind: "relation", title: "Transfer relationships", action: "Pair parts of the source situation with parts of the target and choose the relationship each pair preserves.", check: "Explain where the analogy stops working in the limit field." },
  self_explanation: { kind: "text", title: "Explain why the step works", action: "Name the principle that justifies the displayed step and explain how it applies here.", check: "Add the condition or limit beyond which this explanation would stop applying." },
  argument_rebuttal: { kind: "source", title: "Support a claim and answer an objection", action: "State your claim, select supporting evidence, and explain why that evidence supports it.", check: "Address the objection in the counterargument and response fields before submitting." },
  critique_revision: { kind: "source", title: "Make a critique useful", action: "Choose a criterion, identify the relevant part of the draft, and explain the problem. Then write your revision.", check: "Submit both your findings and the revised text so the changes can be assessed together." },
  misconception_tutoring: { kind: "dialogue", title: "Diagnose before correcting", action: "Ask the simulated learner a focused question. Read its reply, then explain the correction and propose a check of understanding.", check: "Dialogue turns are limited. Complete the final teaching response before submitting." },
  information_gap: { kind: "dialogue", title: "Ask for the missing information", action: "Use the conversation to obtain facts you need for the stated goal. Select the obtained facts that inform your decision.", check: "Write the decision and its basis before submitting; sending a turn alone does not submit the activity." },
  role_simulation: { kind: "dialogue", title: "Act within your role", action: "Read the goal and constraints, then send a response to the simulated counterpart. Use its reply to refine your decision.", check: "Complete the agreement’s commitments, conditions and rationale. Check them against the role’s constraints before submitting." },
  audience_mediation: { kind: "text", title: "Adapt the explanation to the audience", action: "Read the source and audience needs. Write a version that preserves the meaning in language the audience can use.", check: "Select the source facts you preserved and check the word limit before submitting." },
};

function GuideScene({ kind }: { kind: GuideKind }) {
  return <div className={styles.guideScene} aria-hidden="true" data-kind={kind}>
    {kind === "sequence" ? <><span className={styles.sceneStep}>First step</span><span className={styles.sceneStep}>Next step <b>↕</b></span><span className={styles.sceneStep}>Final step</span></> :
      kind === "relation" ? <><span className={styles.sceneNode}>From</span><span className={styles.sceneRelation}>relationship →</span><span className={styles.sceneNode}>To</span></> :
        kind === "interval" ? <><div className={styles.sceneBounds}><span>Lower</span><span>Upper</span></div><div className={styles.sceneRange}><i /><i /></div><small>Your estimate</small></> :
          kind === "table" ? <><div className={styles.sceneGrid}><span>Given</span><span>Your value</span><span>…</span><span className={styles.sceneBlank} /><span>…</span><span className={styles.sceneBlank} /></div></> :
            kind === "choice" ? <><span className={styles.sceneChoice}>○ Compare</span><span className={styles.sceneChoice}>◉ Choose</span><span className={styles.sceneLine}>Explain the distinction</span></> :
              kind === "experiment" ? <><div className={styles.sceneControls}><i /><i /><i /></div><span className={styles.sceneRun}>Run</span><span className={styles.sceneLine}>Inspect the observation</span></> :
                kind === "code" ? <><div className={styles.sceneCode}><span>Read the original</span><b>⌁ Edit your version</b><span>Run → inspect</span></div></> :
                  kind === "dialogue" ? <><span className={styles.sceneBubble}>Your question</span><span className={styles.sceneReply}>Simulated reply</span><span className={styles.sceneLine}>Your final response</span></> :
                    kind === "source" ? <><div className={styles.scenePaper}><i /><mark>Relevant passage</mark><i /></div><span className={styles.sceneLine}>Cite and explain</span></> :
                      <><div className={styles.scenePaper}><span>Your explanation</span><i /><i /><i className={styles.sceneShort} /></div></>}
  </div>;
}

export function TaskGuide({ task }: { task: TaskPublic }) {
  const [open, setOpen] = useState(true);
  const guide = taskGuides[task.mechanicId];
  if (!guide) return null;
  const python = task.mechanicVersion === 3 && ["artifact_construction", "diagnosis_repair"].includes(task.mechanicId);
  return <div className={styles.guide}>{open ? <><GuideScene kind={guide.kind} /><div className={styles.guideCopy}><h2>{guide.title}</h2>
    <p>{python ? task.mechanicId === "diagnosis_repair" ? "Select the faulty lines in the original source. Repair solve(payload) in the Python editor, then explain the change." : "Implement solve(payload) in the Python editor. Run public cases to inspect returned values, printed output or errors." : guide.action}</p>
    <p>{guide.check}</p><Button variant="quiet" size="compact" onClick={() => setOpen(false)}>Skip guide</Button></div></> :
      <Button variant="quiet" size="compact" onClick={() => setOpen(true)}>Show task guide</Button>}</div>;
}
