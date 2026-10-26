// @vitest-environment happy-dom
import { act, StrictMode, type ButtonHTMLAttributes, type PropsWithChildren } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogPort } from "../../src/application/catalog-port";
import type { AccountSnapshot } from "../../src/features/account/account-session";
import { accountScope } from "../../src/features/account/account-scope";
import { StartCourseContinuation } from "../../src/features/catalog/StartCourseContinuation";

let account: AccountSnapshot;
vi.mock("../../src/features/account/account-session", () => ({ useAccountSession: () => account, refreshAccount: vi.fn() }));
vi.mock("../../src/components/shell", () => ({ AppShell: ({ children }: PropsWithChildren) => <main>{children}</main> }));
vi.mock("../../src/components/ui", () => ({
  Button: (props: ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props} />,
  LinkButton: ({ children, href }: PropsWithChildren<{ href: string }>) => <a href={href}>{children}</a>,
  Notice: ({ children }: PropsWithChildren) => <div>{children}</div>,
}));

const actorId = "10000000-0000-4000-8000-000000000001";
const courseId = "10000000-0000-4000-8000-000000000002";
const versionId = "10000000-0000-4000-8000-000000000003";
const nextVersionId = "10000000-0000-4000-8000-000000000004";
type EnrollmentResult = Awaited<ReturnType<CatalogPort["createEnrollment"]>>;
function readyAccount(id = actorId): AccountSnapshot {
  return { status: "ready", capabilities: { generation: true, cloudIdentity: true, cloudPersistence: true }, session: {
    identity: { id, email: null, emailConfirmed: true },
    profile: { id, displayName: "Learner", defaultContentLanguage: null, revision: 1,
      createdAt: "2026-10-25T00:00:00.000Z", updatedAt: "2026-10-25T00:00:00.000Z" },
  } };
}
function enrolled(version = versionId): EnrollmentResult {
  const id = crypto.randomUUID();
  return { ok: true, data: { enrollment: { id, learnerId: actorId, courseId, courseVersionId: version,
    status: "active", routeRevision: 1, currentLessonId: null, currentTaskId: null,
    createdAt: "2026-10-25T00:00:00.000Z", lastStudiedAt: null }, redirectTo: `/learn/${id}` } };
}
function delayedPort() {
  const finish: Array<(result: EnrollmentResult) => void> = [];
  const createEnrollment = vi.fn<CatalogPort["createEnrollment"]>(() => new Promise((resolve) => { finish.push(resolve); }));
  const unused = async () => { throw new Error("Unexpected catalog operation"); };
  const services: CatalogPort = { createEnrollment, listPublic: unused, getBySlug: unused, getCourse: unused,
    resolveShare: unused, listLibrary: unused, listShares: unused, createShare: unused, revokeShare: unused };
  return { services, createEnrollment, finish };
}
let root: Root | null;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  account = readyAccount(); accountScope.replaceActor(actorId);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null; container.remove(); accountScope.replaceActor(null);
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe("mounted course-start continuation", () => {
  it("keeps delayed enrollment alive through joining and refreshed-account rerenders", async () => {
    const port = delayedPort(); const replace = vi.spyOn(window.location, "replace").mockImplementation(() => {});
    await act(async () => { root!.render(<StartCourseContinuation courseId={courseId} versionId={versionId} services={port.services} />); });
    expect(container.textContent).toContain("Adding this course");
    expect(port.createEnrollment).toHaveBeenCalledOnce();
    expect(port.createEnrollment.mock.calls[0]![3]!.aborted).toBe(false);
    account = readyAccount();
    await act(async () => { root!.render(<StartCourseContinuation courseId={courseId} versionId={versionId} services={port.services} />); });
    expect(port.createEnrollment).toHaveBeenCalledOnce();
    expect(port.createEnrollment.mock.calls[0]![3]!.aborted).toBe(false);
    const result = enrolled();
    await act(async () => { port.finish[0]!(result); });
    expect(replace).toHaveBeenCalledExactlyOnceWith(result.ok && result.data.redirectTo);
  });

  it("retries an uncertain delivery with the same idempotency key", async () => {
    const port = delayedPort(); const replace = vi.spyOn(window.location, "replace").mockImplementation(() => {});
    await act(async () => { root!.render(<StartCourseContinuation courseId={courseId} versionId={versionId} services={port.services} />); });
    await act(async () => { port.finish[0]!({ ok: false, error: { error: { code: "service_unavailable", messageKey: "catalog.unavailable", retryable: true, requestId: crypto.randomUUID() } } }); });
    expect(container.querySelector("button")?.textContent).toBe("Try again");
    await act(async () => { container.querySelector("button")!.click(); });
    expect(port.createEnrollment).toHaveBeenCalledTimes(2);
    expect(port.createEnrollment.mock.calls[1]![2]).toBe(port.createEnrollment.mock.calls[0]![2]);
    expect(port.createEnrollment.mock.calls[1]![3]!.aborted).toBe(false);
    const result = enrolled();
    await act(async () => { port.finish[1]!(result); });
    expect(replace).toHaveBeenCalledExactlyOnceWith(result.ok && result.data.redirectTo);
  });

  it("aborts a replaced course target and ignores its late result", async () => {
    const port = delayedPort(); const replace = vi.spyOn(window.location, "replace").mockImplementation(() => {});
    await act(async () => { root!.render(<StartCourseContinuation courseId={courseId} versionId={versionId} services={port.services} />); });
    await act(async () => { root!.render(<StartCourseContinuation courseId={courseId} versionId={nextVersionId} shareToken="new-share" services={port.services} />); });
    expect(port.createEnrollment).toHaveBeenCalledTimes(2);
    expect(port.createEnrollment.mock.calls[0]![3]!.aborted).toBe(true);
    expect(port.createEnrollment.mock.calls[1]![3]!.aborted).toBe(false);
    expect(port.createEnrollment.mock.calls[1]![2]).not.toBe(port.createEnrollment.mock.calls[0]![2]);
    expect(port.createEnrollment.mock.calls[1]![1]).toEqual({ courseVersionId: nextVersionId, shareToken: "new-share" });
    await act(async () => { port.finish[0]!(enrolled()); });
    expect(replace).not.toHaveBeenCalled();
    const result = enrolled(nextVersionId);
    await act(async () => { port.finish[1]!(result); });
    expect(replace).toHaveBeenCalledExactlyOnceWith(result.ok && result.data.redirectTo);
  });

  it("aborts on unmount and cannot redirect from a late completion", async () => {
    const port = delayedPort(); const replace = vi.spyOn(window.location, "replace").mockImplementation(() => {});
    await act(async () => { root!.render(<StartCourseContinuation courseId={courseId} versionId={versionId} services={port.services} />); });
    await act(async () => { root!.unmount(); root = null; });
    expect(port.createEnrollment.mock.calls[0]![3]!.aborted).toBe(true);
    await act(async () => { port.finish[0]!(enrolled()); });
    expect(replace).not.toHaveBeenCalled();
  });

  it("starts after sign-in and replaces the command when the actor changes", async () => {
    const port = delayedPort(); const replace = vi.spyOn(window.location, "replace").mockImplementation(() => {});
    account = { status: "loading", session: null }; accountScope.replaceActor(null);
    await act(async () => { root!.render(<StartCourseContinuation courseId={courseId} versionId={versionId} services={port.services} />); });
    expect(port.createEnrollment).not.toHaveBeenCalled();
    account = readyAccount(); accountScope.replaceActor(actorId);
    await act(async () => { root!.render(<StartCourseContinuation courseId={courseId} versionId={versionId} services={port.services} />); });
    expect(port.createEnrollment).toHaveBeenCalledOnce();
    const nextActor = crypto.randomUUID(); account = readyAccount(nextActor); accountScope.replaceActor(nextActor);
    await act(async () => { root!.render(<StartCourseContinuation courseId={courseId} versionId={versionId} services={port.services} />); });
    expect(port.createEnrollment).toHaveBeenCalledTimes(2);
    expect(port.createEnrollment.mock.calls[0]![3]!.aborted).toBe(true);
    expect(port.createEnrollment.mock.calls[1]![3]!.aborted).toBe(false);
    expect(port.createEnrollment.mock.calls[1]![2]).not.toBe(port.createEnrollment.mock.calls[0]![2]);
    await act(async () => { port.finish[0]!(enrolled()); });
    expect(replace).not.toHaveBeenCalled();
  });

  it("replays StrictMode setup safely with one logical enrollment identity", async () => {
    const port = delayedPort(); const replace = vi.spyOn(window.location, "replace").mockImplementation(() => {});
    await act(async () => { root!.render(<StrictMode><StartCourseContinuation courseId={courseId} versionId={versionId} services={port.services} /></StrictMode>); });
    expect(port.createEnrollment).toHaveBeenCalledTimes(2);
    expect(port.createEnrollment.mock.calls[0]![3]!.aborted).toBe(true);
    expect(port.createEnrollment.mock.calls[1]![3]!.aborted).toBe(false);
    expect(port.createEnrollment.mock.calls[1]![2]).toBe(port.createEnrollment.mock.calls[0]![2]);
    const result = enrolled();
    await act(async () => { port.finish[0]!(result); port.finish[1]!(result); });
    expect(replace).toHaveBeenCalledExactlyOnceWith(result.ok && result.data.redirectTo);
  });
});
