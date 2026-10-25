import { describe, expect, it, vi } from "vitest";
import { AccountScope } from "../../src/features/account/account-scope";

describe("account changes invalidate only scoped work", () => {
  it("aborts old requests, rejects late results and clears registered actor caches when identity changes", () => {
    const scope = new AccountScope();
    scope.replaceActor("first");
    const clear = vi.fn();
    scope.onClear("first", clear);
    const oldRequest = scope.request("first");
    scope.replaceActor("second");
    expect(oldRequest.signal.aborted).toBe(true);
    expect(oldRequest.isCurrent()).toBe(false);
    expect(clear).toHaveBeenCalledTimes(1);
    const currentRequest = scope.request("second");
    expect(currentRequest.isCurrent()).toBe(true);
    expect(scope.request("first").signal.aborted).toBe(true);
  });

  it("keeps current work on a profile refresh but invalidates it on an explicit logout", () => {
    const scope = new AccountScope();
    scope.replaceActor("first");
    const current = scope.request("first");
    scope.replaceActor("first");
    expect(current.isCurrent()).toBe(true);
    scope.invalidate();
    expect(current.isCurrent()).toBe(false);
  });

  it("does not let one failing cache cleanup retain another consumer's private data", () => {
    const scope = new AccountScope();
    scope.replaceActor("first");
    const clear = vi.fn();
    scope.onClear("first", () => { throw new Error("consumer failure"); });
    scope.onClear("first", clear);
    scope.replaceActor(null);
    expect(clear).toHaveBeenCalledTimes(1);
    expect(scope.actorId).toBeNull();
  });

  it("invalidates an in-flight anonymous sign-in when another tab changes identity", () => {
    const scope = new AccountScope();
    const guest = scope.request(null);
    scope.replaceActor("second");
    expect(guest.signal.aborted).toBe(true);
    expect(guest.isCurrent()).toBe(false);
  });
});
