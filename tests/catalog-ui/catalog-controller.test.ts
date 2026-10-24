import { describe, expect, it, vi } from "vitest";
import type { CourseQuery, ServiceResult } from "../../src/application/ports";
import type { CourseSummary, Page } from "../../src/domain";
import { CatalogController } from "../../src/features/catalog/catalog-controller";
import { localApplication } from "../../src/application/local-adapter";
import { ids } from "../domain/fixtures";
import { course, deferred, failure, page, service } from "./fixtures";

describe("catalog request lifecycle", () => {
  it("uses the actual empty local catalog without inventing records", async () => {
    const controller = new CatalogController(localApplication);
    await controller.search({});
    expect(controller.getSnapshot()).toMatchObject({ status: "ready", items: [], nextCursor: null, error: null });
  });

  it("aborts the previous search and ignores its result even if the service does not honor abort", async () => {
    const oldResponse = deferred<ServiceResult<Page<CourseSummary>>>();
    const latestResponse = deferred<ServiceResult<Page<CourseSummary>>>();
    const requests: Array<{ query: CourseQuery; signal?: AbortSignal }> = [];
    const controller = new CatalogController(service((query, signal) => {
      requests.push({ query, ...(signal ? { signal } : {}) });
      return query.q === "old" ? oldResponse.promise : latestResponse.promise;
    }));
    const oldLoad = controller.search({ q: "old", contentLanguage: "en" });
    const latestLoad = controller.search({ q: "latest", contentLanguage: "fr" });
    expect(requests[0]!.signal!.aborted).toBe(true);
    expect(requests[1]!.signal!.aborted).toBe(false);
    const latest = course({ title: "Latest result", contentLanguage: "fr" });
    latestResponse.resolve(page([latest]));
    await latestLoad;
    oldResponse.resolve(page([course({ title: "Old result" })]));
    await oldLoad;
    expect(controller.getSnapshot().items).toEqual([latest]);
    expect(controller.getSnapshot().status).toBe("ready");
  });

  it("retains query and language when retrying a failed first page", async () => {
    const listPublic = vi.fn().mockResolvedValueOnce(failure()).mockResolvedValueOnce(page([]));
    const controller = new CatalogController(service(listPublic));
    const query = Object.freeze({ q: "generalization", contentLanguage: "fr", cursor: "obsolete", limit: 6 });
    await controller.search(query);
    expect(controller.getSnapshot().status).toBe("error");
    expect(controller.getSnapshot().error).toBeTruthy();
    await controller.retry();
    expect(listPublic.mock.calls.map((call) => call[0])).toEqual([
      { q: "generalization", contentLanguage: "fr", limit: 6 },
      { q: "generalization", contentLanguage: "fr", limit: 6 },
    ]);
    expect(query.cursor).toBe("obsolete");
    expect(controller.getSnapshot()).toMatchObject({ status: "ready", error: null });
  });

  it("keeps existing rows on a next-page failure and retries the same cursor", async () => {
    const first = course();
    const second = course({ id: ids.missing, slug: "causal-reasoning", title: "Causal reasoning" });
    const listPublic = vi.fn().mockResolvedValueOnce(page([first], "page-two")).mockResolvedValueOnce(failure()).mockResolvedValueOnce(page([second]));
    const controller = new CatalogController(service(listPublic));
    await controller.search({ q: "evidence", contentLanguage: "en" });
    await controller.loadMore();
    expect(controller.getSnapshot()).toMatchObject({ status: "ready", items: [first], nextCursor: "page-two", loadingMore: false });
    expect(controller.getSnapshot().pageError).toBeTruthy();
    await controller.retry();
    expect(listPublic.mock.calls[1]![0]).toEqual({ q: "evidence", contentLanguage: "en", limit: 12, cursor: "page-two" });
    expect(listPublic.mock.calls[2]![0]).toEqual(listPublic.mock.calls[1]![0]);
    expect(controller.getSnapshot()).toMatchObject({ items: [first, second], nextCursor: null, pageError: null });
  });

  it("also retains existing rows when the next-page transport throws", async () => {
    const first = course();
    const listPublic = vi.fn().mockResolvedValueOnce(page([first], "next")).mockRejectedValueOnce(new Error("Connection closed"));
    const controller = new CatalogController(service(listPublic));
    await controller.search({});
    await controller.loadMore();
    expect(controller.getSnapshot()).toMatchObject({ items: [first], nextCursor: "next", loadingMore: false });
    expect(controller.getSnapshot().pageError).toBeTruthy();
  });

  it("suppresses repeated pagination presses and does not duplicate overlapping records", async () => {
    const response = deferred<ServiceResult<Page<CourseSummary>>>();
    const original = course();
    const revised = course({ summary: "Updated description from the next page." });
    const next = course({ id: ids.missing, slug: "testing-claims" });
    const listPublic = vi.fn().mockResolvedValueOnce(page([original], "next")).mockReturnValueOnce(response.promise);
    const controller = new CatalogController(service(listPublic));
    await controller.search({});
    const firstPress = controller.loadMore();
    await controller.loadMore();
    expect(listPublic).toHaveBeenCalledTimes(2);
    expect(controller.getSnapshot().loadingMore).toBe(true);
    response.resolve(page([revised, next]));
    await firstPress;
    expect(controller.getSnapshot().items).toEqual([revised, next]);
  });

  it("does not append an old next page to a new query", async () => {
    const oldPage = deferred<ServiceResult<Page<CourseSummary>>>();
    const listPublic = vi.fn().mockResolvedValueOnce(page([course()], "next")).mockReturnValueOnce(oldPage.promise).mockResolvedValueOnce(page([]));
    const controller = new CatalogController(service(listPublic));
    await controller.search({ q: "first" });
    const pendingPage = controller.loadMore();
    await controller.search({ q: "second" });
    expect((listPublic.mock.calls[1]![1] as AbortSignal).aborted).toBe(true);
    oldPage.resolve(page([course({ id: ids.missing })]));
    await pendingPage;
    expect(controller.getSnapshot()).toMatchObject({ status: "ready", items: [], loadingMore: false, nextCursor: null });
  });

  it("ignores responses after disposal", async () => {
    const response = deferred<ServiceResult<Page<CourseSummary>>>();
    const listPublic = vi.fn().mockReturnValue(response.promise);
    const controller = new CatalogController(service(listPublic));
    const pending = controller.search({});
    controller.dispose();
    const stateAtDisposal = controller.getSnapshot();
    response.resolve(page([course()]));
    await pending;
    expect((listPublic.mock.calls[0]![1] as AbortSignal).aborted).toBe(true);
    expect(controller.getSnapshot()).toBe(stateAtDisposal);
  });
});
