import { describe, expect, it } from "vitest";
import { accountProgressForXp, correctedContribution, initialAwardAmount } from "../../src/server/progression/policy";

describe("xp-v1 policy", () => {
  it.each([
    [249, 1, 1, false],
    [250, 2, 250, false],
    [499, 2, 1, false],
    [500, 3, 250, true],
  ])("derives the boundary at %i XP", (xp, level, remaining, eligible) => {
    expect(accountProgressForXp(xp)).toMatchObject({
      xpTotal: xp,
      level,
      xpToNextLevel: remaining,
      publication: { eligible, requiredLevel: 3 },
    });
  });

  it("awards only the first qualifying server evaluation amount", () => {
    expect(initialAwardAmount({ status: "evaluated", outcome: "correct", assistance: "independent" })).toBe(25);
    expect(initialAwardAmount({ status: "evaluated", outcome: "correct", assistance: "hinted" })).toBe(10);
    expect(initialAwardAmount({ status: "evaluated", outcome: "correct", assistance: "worked_example" })).toBe(0);
    expect(initialAwardAmount({ status: "evaluated", outcome: "partial", assistance: "independent" })).toBe(0);
    expect(initialAwardAmount({ status: "uncertain", outcome: null, assistance: "independent" })).toBe(0);
    expect(initialAwardAmount({ status: "evaluated", outcome: "correct", assistance: "independent", sample: true })).toBe(0);
  });

  it("keeps uncertainty neutral and bounds a correction to the original amount", () => {
    expect(correctedContribution({ status: "uncertain", outcome: null }, 25)).toBeNull();
    expect(correctedContribution({ status: "evaluated", outcome: "incorrect" }, 25)).toBe(0);
    expect(correctedContribution({ status: "evaluated", outcome: "correct" }, 10)).toBe(10);
  });
});
