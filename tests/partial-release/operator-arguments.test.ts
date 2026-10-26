import { describe, expect, it } from "vitest";
// @ts-expect-error Operational CLI is JavaScript and intentionally runs without a TS loader.
import { releaseOptions, releaseEnvironment, runOfficialRelease } from "../../scripts/release-official-course.mjs";
const ref = "abcdefghijklmnopqrst", id = "30000000-0000-4000-8000-000000000001";
const env = { SUPABASE_PROJECT_REF: ref, NEXT_PUBLIC_SUPABASE_URL: `https://${ref}.supabase.co`, DIRECT_DATABASE_URL: `postgres://postgres.${ref}:secret@pooler.supabase.com:5432/postgres` };
const args = ["--project-ref", ref, "--run-id", id, "--owner-id", id, "--completed-step-id", id];
describe("official release CLI", () => {
  it("previews by default and requires a reviewed digest to apply", () => {
    expect(releaseOptions(args, env).applyDigest).toBeUndefined();
    expect(releaseOptions([...args, "--apply", "a".repeat(64)], env).applyDigest).toBe("a".repeat(64));
    expect(() => releaseOptions([...args, "--apply"], env)).toThrow();
    expect(() => releaseOptions([...args, "--apply", "yes"], env)).toThrow();
  });
  it("rejects a different project and transaction pooler before spawning", () => {
    expect(() => releaseOptions(args, { ...env, SUPABASE_PROJECT_REF: "different" })).toThrow();
    expect(() => releaseOptions(args, { ...env, DIRECT_DATABASE_URL: env.DIRECT_DATABASE_URL.replace(":5432", ":6543") })).toThrow();
  });
  it("does not forward unrelated paid or operator switches", () => {
    const child = releaseEnvironment({ ...env, RUN_PAID_PROBE: "1", SOME_OPERATOR: "1", OFFICIAL_COURSE_RELEASE_INPUT: "untrusted" }, releaseOptions(args, env));
    expect(child.RUN_PAID_PROBE).toBeUndefined();
    expect(child.SOME_OPERATOR).toBeUndefined();
    expect(JSON.parse(child.OFFICIAL_COURSE_RELEASE_INPUT)).toEqual({ runId: id, ownerId: id, completedStepId: id });
    expect(child.VERCEL).toBe("1");
  });
  it("suppresses raw errors and accepts only the matching zero-inference report", () => {
    expect(() => runOfficialRelease(args, env, () => ({ status: 1, stdout: "secret", stderr: "secret" }))).toThrow("release_rejected");
    const result = runOfficialRelease(args, env, () => ({ status: 0, stdout: JSON.stringify({ kind: "official-course-release", runId: id, applied: false, inferenceCalls: 0 }) }));
    expect(result.ok).toBe(true);
  });
});
