import { describe, expect, it } from "vitest";
import { routes } from "../../src/lib/routes";

const origin = "https://unfurl.test";

describe("routes", () => {
  it("provides the agreed public destinations", () => {
    expect({
      home: routes.home,
      explore: routes.explore,
      library: routes.library,
      try: routes.try,
      about: routes.about,
      help: routes.help,
      privacy: routes.privacy,
    }).toEqual({
      home: "/",
      explore: "/explore",
      library: "/library",
      try: "/try",
      about: "/about",
      help: "/help",
      privacy: "/privacy",
    });
  });

  it("opens a new creator without an optional draft identifier", () => {
    expect(routes.create()).toBe("/create");
    expect(routes.create(undefined)).toBe("/create");
  });

  it("keeps a draft identifier in exactly one query parameter", () => {
    const id = "draft/one ?mode=publish&next=/library#section +%";
    const destination = new URL(routes.create(id), origin);

    expect(destination.pathname).toBe("/create");
    expect([...destination.searchParams.keys()]).toEqual(["draft"]);
    expect(destination.searchParams.get("draft")).toBe(id);
    expect(destination.hash).toBe("");
  });

  it("keeps a supplied empty draft distinct from a new creator", () => {
    expect(routes.create("")).toBe("/create?draft=");
  });

  it.each([
    ["course", routes.course, "/courses/"],
    ["learning", routes.learn, "/learn/"],
  ] as const)("encodes a %s identifier as one path segment", (_name, route, prefix) => {
    const id = "lesson/one?copy=true#details&more +%";
    const destination = new URL(route(id), origin);

    expect(destination.origin).toBe(origin);
    expect(destination.pathname.startsWith(prefix)).toBe(true);
    expect(destination.pathname.slice(prefix.length).split("/")).toHaveLength(1);
    expect(decodeURIComponent(destination.pathname.slice(prefix.length))).toBe(id);
    expect(destination.search).toBe("");
    expect(destination.hash).toBe("");
  });

  it("uses the plural course path and preserves a normal slug", () => {
    expect(routes.course("artificial-intelligence")).toBe("/courses/artificial-intelligence");
    expect(routes.learn("df225785-b18b-4e2f-9166-7dd2ab6a04fb"))
      .toBe("/learn/df225785-b18b-4e2f-9166-7dd2ab6a04fb");
  });

  it("encodes international text without losing the original value", () => {
    const id = "日本語 fundamentals";
    expect(decodeURIComponent(routes.course(id).slice("/courses/".length))).toBe(id);
    expect(new URL(routes.create(id), origin).searchParams.get("draft")).toBe(id);
  });

  it.each(["", ".", ".."])("rejects a path segment that browsers normalize: %j", (id) => {
    expect(() => routes.course(id)).toThrow(RangeError);
    expect(() => routes.learn(id)).toThrow(RangeError);
  });

  it("does not decode a caller-supplied escape into path traversal", () => {
    const destination = new URL(routes.course("%2e%2e%2fprivate"), origin);
    expect(destination.pathname).toBe("/courses/%252e%252e%252fprivate");
  });
});
