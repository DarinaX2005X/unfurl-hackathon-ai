import type { AccountProgress } from "../../domain/learning";

export const XP_POLICY_VERSION = "xp-v1" as const;
export const XP_PER_LEVEL = 250;
export const PUBLICATION_MIN_LEVEL = 3;

export type ProgressEvaluation = {
  status: "evaluated" | "uncertain" | "pending" | "unavailable";
  outcome: "correct" | "partial" | "incorrect" | null;
  assistance: "independent" | "hinted" | "worked_example";
  sample?: boolean;
};

export function initialAwardAmount(value: ProgressEvaluation): 10 | 25 | 0 {
  if (value.sample || value.status !== "evaluated" || value.outcome !== "correct") return 0;
  if (value.assistance === "independent") return 25;
  if (value.assistance === "hinted") return 10;
  return 0;
}

/** A semantic uncertainty is not a definite decision about an existing award. */
export function correctedContribution(
  value: Pick<ProgressEvaluation, "status" | "outcome">,
  originalAmount: 10 | 25,
): 0 | 10 | 25 | null {
  if (value.status !== "evaluated") return null;
  return value.outcome === "correct" ? originalAmount : 0;
}

export function accountProgressForXp(xpTotal: number): AccountProgress {
  if (!Number.isSafeInteger(xpTotal) || xpTotal < 0) throw new RangeError("XP total must be a non-negative safe integer");
  const level = 1 + Math.floor(xpTotal / XP_PER_LEVEL);
  const eligible = level >= PUBLICATION_MIN_LEVEL;
  return {
    xpTotal,
    level,
    xpToNextLevel: level * XP_PER_LEVEL - xpTotal,
    publication: {
      eligible,
      requiredLevel: PUBLICATION_MIN_LEVEL,
      reasons: eligible ? [] : [`Reach level ${PUBLICATION_MIN_LEVEL}`],
    },
  };
}
