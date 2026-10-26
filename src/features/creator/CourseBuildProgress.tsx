import type { ReactNode } from "react";
import { Check, CircleAlert, Pause, WifiOff } from "lucide-react";
import type { GenerationRun } from "@/domain/generation";
import type { GenerationProgress } from "@/domain/generation-observer";
import type { GenerationStreamState } from "./generation-stream";

const stageLabels: Record<GenerationProgress["stage"], string> = {
  preparing: "Preparing the next step…",
  researching: "Finding sources…",
  reading_sources: "Reading sources…",
  planning_lessons: "Planning the lessons…",
  writing_lessons: "Writing the lessons…",
  creating_practice: "Creating practice questions…",
  validating_practice: "Checking practice questions…",
  reviewing_section: "Reviewing the section…",
  saving_section: "Saving the section…",
  finalizing_course: "Finishing your course…",
};

export function CourseBuildProgress({ run, generation, connectionError = false, action }: {
  run: GenerationRun;
  generation?: GenerationStreamState;
  connectionError?: boolean;
  action?: ReactNode;
}) {
  const active = run.status === "queued" || run.status === "running";
  const reconnecting = active && connectionError;
  const progress = active ? generation?.progress : undefined;
  const waiting = active && (run.status === "queued" || progress?.activity === "waiting");
  const moduleIndex = generation?.modules.findIndex((module) => module.moduleId === progress?.moduleId) ?? -1;
  const currentModule = moduleIndex >= 0 ? generation?.modules[moduleIndex] : undefined;
  const complete = generation?.modules.filter((module) => module.status === "complete") ?? [];
  const stage = run.status === "queued" ? generationStatus(run)
    : progress?.activity === "waiting" ? "Preparing the next step…"
      : progress ? stageLabels[progress.stage] : generationStatus(run);
  const title = reconnecting ? "Reconnecting to build updates…" : active ? stage
    : run.status === "succeeded" ? "Build complete" : run.status === "cancelled" ? "Build cancelled" : run.status === "failed" ? "Build stopped" : stage;
  const detail = reconnecting ? `Last confirmed: ${stage.replace(/…$/, ".")}`
    : !active ? generationStatus(run)
      : currentModule ? `Section ${moduleIndex + 1} of ${generation!.modules.length} · ${currentModule.title}`
        : run.status === "queued" ? "Your approved program is saved. Waiting for the build to start."
          : waiting ? "Your saved work is kept while the next step is prepared."
            : "Your approved program is saved. Build updates appear here.";
  const state = reconnecting ? "reconnecting" : active ? waiting ? "waiting" : "running" : run.status;
  return <section className={`creator-build creator-build--${state}`} aria-label="Course build">
    <div className="creator-build__heading">
      <span className="creator-build__icon" aria-hidden="true">
        {reconnecting ? <WifiOff size={20} /> : active ? <span className="creator-build__activity" />
          : run.status === "succeeded" ? <Check size={20} /> : run.status === "failed" ? <CircleAlert size={20} /> : <Pause size={20} />}
      </span>
      <div className="creator-build__copy" role="status" aria-live="polite" aria-atomic="true">
        <p className="creator-build__title">{title}</p>
        <p className="creator-build__detail">{detail}</p>
      </div>
    </div>
    {(action || generation?.modules.length || generation?.validation || progress?.completedSources) ? <div className="creator-build__footer">
      <div className="creator-build__facts" aria-live="polite" aria-atomic="true">
        {generation && generation.modules.length > 0 && <p>{complete.length} of {generation.modules.length} sections saved</p>}
        {progress?.completedSources !== undefined && progress.completedSources > 0 && <p>{progress.completedSources} {progress.completedSources === 1 ? "source" : "sources"} read</p>}
        {generation?.validation && <p>Validation checked {generation.validation.checked} items: {generation.validation.passed} passed, {generation.validation.failed} need attention.</p>}
      </div>
      {action && <div className="creator-build__action">{action}</div>}
    </div> : null}
  </section>;
}

function generationStatus(run: GenerationRun): string {
  if (run.status === "queued") return "Preparing to build your course…";
  if (run.status === "succeeded") return "Course build complete. The ready course link will appear here shortly.";
  if (run.status === "failed") {
    const reasons: Record<string, string> = {
      "generation.timeout": "The course build stopped because a generation request timed out.",
      "generation.unavailable": "The course build stopped because the generation service was unavailable.",
      "generation.rateLimited": "The course build stopped because the generation service was busy.",
      "generation.budgetExhausted": "The course build stopped because the available generation budget was exhausted.",
      "generation.invalidResponse": "The course build stopped because a generated response could not be validated.",
    };
    return `${reasons[run.error?.messageKey ?? ""] ?? "The course build stopped before completion."} Your approved program is still saved.`;
  }
  if (run.status === "cancelled") return "The course build was cancelled. Your approved program is still saved.";
  const phases: Record<GenerationRun["phase"], string> = {
    briefing: "Preparing the course build…", researching: "Researching the course…", outlining: "Checking the course outline…",
    awaiting_approval: "Waiting for program approval…", module_research: "Researching each section…",
    building_tasks: "Building lessons and practice…", validating: "Validating the course before release…",
  };
  return phases[run.phase];
}
