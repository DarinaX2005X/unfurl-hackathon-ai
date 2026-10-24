import { describe, expect, it } from "vitest";
import { languageName, readCourseQuery, readLibraryView, studyTime, updateCollectionQuery } from "../../src/features/catalog/query";

describe("collection URL state", () => {
  it("restores title/summary query and content language independently of the interface", () => {
    const params = new URLSearchParams("q=++model+validation++&contentLanguage=ja&view=drafts");
    expect(readCourseQuery(params)).toEqual({ q: "model validation", contentLanguage: "ja" });
    expect(readLibraryView(params)).toBe("drafts");
  });
  it("ignores malformed language and empty searches, and bounds a long query", () => {
    expect(readCourseQuery(new URLSearchParams("q=+++&contentLanguage=not_a_language"))).toEqual({});
    expect(readCourseQuery(new URLSearchParams({ q: "a".repeat(240) })).q).toHaveLength(200);
  });
  it("resets only query/filter/pagination while preserving the selected view and unrelated state", () => {
    const reset = updateCollectionQuery("q=algebra&contentLanguage=fr&cursor=next&view=drafts&context=shared", { q: "", contentLanguage: "" });
    expect(new URLSearchParams(reset)).toEqual(new URLSearchParams("view=drafts&context=shared"));
  });
  it("round-trips supported views and gives an unknown view the safe all default", () => {
    for (const view of ["drafts", "courses", "in_progress"] as const) {
      expect(readLibraryView(new URLSearchParams(updateCollectionQuery("q=models", { view })))).toBe(view);
    }
    expect(readLibraryView(new URLSearchParams("view=unknown"))).toBe("all");
    expect(updateCollectionQuery("view=drafts", { view: "all" })).toBe("");
  });
  it("formats actual study durations and language names without fabricated depth labels", () => {
    expect(studyTime(45)).toBe("45 min");
    expect(studyTime(120)).toBe("2 hr");
    expect(studyTime(75)).toBe("1 hr 15 min");
    expect(languageName("ja")).toBe("Japanese");
    expect(languageName("not_a_language")).toBe("not_a_language");
  });
});
