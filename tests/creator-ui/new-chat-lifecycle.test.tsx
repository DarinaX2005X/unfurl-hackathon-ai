// @vitest-environment happy-dom
import { act, StrictMode, type AnchorHTMLAttributes, type PropsWithChildren, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationPort } from "../../src/application/conversation-port";
import { localApplication } from "../../src/application/local-adapter";
import type { ConversationDetail } from "../../src/domain/conversations";
import { accountScope } from "../../src/features/account/account-scope";
import { CreatorWorkspace } from "../../src/features/creator/CreatorWorkspace";
import { ids, timestamp } from "../domain/fixtures";

let params = new URLSearchParams();
vi.mock("next/navigation", () => ({ useSearchParams: () => params }));
vi.mock("next/link", () => ({ default: (props: AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props} /> }));
vi.mock("../../src/components/shell/AppShell", () => ({ AppShell: ({ children, sidebarContent }: PropsWithChildren<{ sidebarContent?: ReactNode }>) => <main>{sidebarContent}{children}</main> }));
vi.mock("../../src/features/account/account-session", () => ({ useAccountSession: () => ({ status: "ready", session: { identity: { id: ids.actor } } }), refreshAccount: vi.fn() }));
vi.mock("../../src/features/creator/LegacyChatImport", () => ({ LegacyChatImport: () => null }));

let root: Root;
let container: HTMLDivElement;
let port: ConversationPort;
let records: Map<string, ConversationDetail>;
let services: typeof localApplication;
function stored(id: string, title: string, text = ""): ConversationDetail {
  return { conversation: { id, ownerId: ids.actor, title, activeBranchId: ids.sample, revision: 1,
    createdAt: timestamp, updatedAt: timestamp }, messages: [], artifacts: [], activeTurn: null,
  composerDraft: { conversationId: id, revision: 1, text, pendingMessages: [], updatedAt: timestamp } };
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.useFakeTimers();
  window.sessionStorage.clear(); params = new URLSearchParams(); accountScope.replaceActor(ids.actor);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  records = new Map([[ids.conversation, stored(ids.conversation, "Existing chat")]]);
  port = {
    list: vi.fn(async () => ({ ok: true, data: { items: [...records.values()].map((value) => value.conversation), nextCursor: null } })),
    get: vi.fn(async (id) => ({ ok: true, data: structuredClone(records.get(id)!) })),
    create: vi.fn(async (input) => { const value = stored(ids.request, input.composerText, input.composerText); records.set(ids.request, value); return { ok: true, data: structuredClone(value) }; }),
    saveComposer: vi.fn(async (id, input) => {
      const value = records.get(id)!;
      value.composerDraft = { ...value.composerDraft, revision: input.expectedRevision + 1, text: input.text, pendingMessages: structuredClone(input.pendingMessages) };
      return { ok: true, data: structuredClone(value.composerDraft) };
    }),
  } as unknown as ConversationPort;
  services = { ...localApplication, sendMessage: vi.fn(localApplication.sendMessage) };
});
afterEach(async () => {
  await act(async () => root.unmount()); accountScope.replaceActor(null); container.remove();
  vi.useRealTimers(); vi.unstubAllGlobals();
});
async function render() {
  await act(async () => root.render(<StrictMode><CreatorWorkspace conversations={port} services={services} /></StrictMode>));
}
async function type(text: string) {
  await act(async () => {
    const field = container.querySelector<HTMLTextAreaElement>("#chat-message")!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, text);
    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
async function submit() { await act(async () => { container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); }); }

describe("mounted new-chat lifecycle", () => {
  it("keeps typing out of history across StrictMode, pagehide and route changes, while existing drafts autosave", async () => {
    await render(); await type("Unsent new question");
    expect(container.querySelector<HTMLTextAreaElement>("#chat-message")!.value).toBe("Unsent new question");
    await act(async () => { await vi.advanceTimersByTimeAsync(500); window.dispatchEvent(new Event("pagehide")); });
    expect(port.create).not.toHaveBeenCalled(); expect(port.saveComposer).not.toHaveBeenCalled();
    expect(container.querySelectorAll(".creator-history li")).toHaveLength(1);
    params = new URLSearchParams({ conversation: ids.conversation }); await render(); await type("Draft in an existing chat");
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(records.get(ids.conversation)!.composerDraft.text).toBe("Draft in an existing chat");
    expect(port.create).not.toHaveBeenCalled();
    params = new URLSearchParams(); await render();
    expect(container.querySelector<HTMLTextAreaElement>("#chat-message")!.value).toBe("Unsent new question");
    expect(container.querySelectorAll(".creator-history li")).toHaveLength(1);
  });

  it("creates on first submit and retries the same failed message without another chat", async () => {
    await render(); await type("First submitted question"); await submit();
    expect(port.create).toHaveBeenCalledOnce(); expect(services.sendMessage).toHaveBeenCalledOnce();
    expect(container.querySelectorAll(".creator-history li")).toHaveLength(2);
    expect(records.get(ids.request)!.conversation.title).toBe("First submitted question");
    const first = vi.mocked(services.sendMessage).mock.calls[0]![0];
    await act(async () => { [...container.querySelectorAll("button")].find((button) => button.textContent === "Retry")!.click(); });
    expect(port.create).toHaveBeenCalledOnce();
    expect(vi.mocked(services.sendMessage).mock.calls[1]![0]).toEqual(first);
    expect(records.get(ids.request)!.composerDraft.pendingMessages).toHaveLength(1);
  });

  it("offers Retry sending after first creation fails and retains the original creation key", async () => {
    const create = vi.mocked(port.create).getMockImplementation()!;
    vi.mocked(port.create).mockRejectedValueOnce(new Error("offline")).mockImplementation(create);
    await render(); await type("Keep my first message"); await submit();
    expect(container.querySelector<HTMLTextAreaElement>("#chat-message")!.value).toBe("Keep my first message");
    expect(services.sendMessage).not.toHaveBeenCalled();
    await act(async () => { [...container.querySelectorAll("button")].find((button) => button.textContent === "Retry sending")!.click(); });
    expect(port.create).toHaveBeenCalledTimes(2);
    expect(vi.mocked(port.create).mock.calls[1]!.slice(0, 2)).toEqual(vi.mocked(port.create).mock.calls[0]!.slice(0, 2));
    expect(services.sendMessage).toHaveBeenCalledOnce();
  });
});
