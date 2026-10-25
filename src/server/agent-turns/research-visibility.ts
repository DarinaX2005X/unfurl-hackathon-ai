import "server-only";

/** $1 is the current, already-authorized execution job, never a model-supplied job ID.
 * This matches the public exact-active-branch message projection. Prior receipts must
 * have committed before this turn was accepted; the current job may add new receipts. */
export const visibleResearchStepsCte = `WITH research_scope AS (
  SELECT current_job.id AS job_id,current_run.id AS run_id,current_run.owner_id,current_run.conversation_id,current_run.branch_id,
    current_input.id AS input_id,current_input.created_at AS input_at,current_run.created_at AS accepted_at
  FROM unfurl.execution_jobs current_job
  JOIN unfurl.agent_turn_runs current_run ON current_run.id=current_job.agent_turn_run_id
  JOIN unfurl.conversations conversation ON conversation.id=current_run.conversation_id AND conversation.owner_id=current_run.owner_id
    AND conversation.active_branch_id=current_run.branch_id AND conversation.deleted_at IS NULL
  JOIN unfurl.messages current_input ON current_input.id=current_run.input_message_id AND current_input.conversation_id=current_run.conversation_id
    AND current_input.branch_id=current_run.branch_id AND current_input.role='user' AND current_input.status='complete'
  WHERE current_job.id=$1
), visible_research_steps AS (
  SELECT step.*,prior_input.created_at AS input_created_at,prior_input.id AS input_message_id,
    prior_run.created_at AS run_created_at,prior_run.id AS run_id
  FROM research_scope scope
  JOIN unfurl.agent_turn_runs prior_run ON prior_run.owner_id=scope.owner_id AND prior_run.conversation_id=scope.conversation_id
    AND prior_run.branch_id=scope.branch_id
  JOIN unfurl.messages prior_input ON prior_input.id=prior_run.input_message_id AND prior_input.conversation_id=scope.conversation_id
    AND prior_input.branch_id=scope.branch_id AND prior_input.role='user' AND prior_input.status='complete'
  JOIN unfurl.execution_jobs prior_job ON prior_job.agent_turn_run_id=prior_run.id
  JOIN unfurl.run_steps step ON step.job_id=prior_job.id AND step.status='succeeded' AND step.step_key LIKE 'agent.v1:%:tool'
  WHERE prior_job.id=scope.job_id OR (
    (prior_input.created_at,prior_input.id)<=(scope.input_at,scope.input_id)
    AND (prior_run.created_at,prior_run.id)<(scope.accepted_at,scope.run_id)
    AND step.updated_at<=scope.accepted_at)
)`;

export function researchHistoryOrder(direction: "ASC" | "DESC" = "ASC"): string {
  return ["input_created_at", "input_message_id", "run_created_at", "run_id", "step_key"].map((column) => `${column} ${direction}`).join(",");
}
