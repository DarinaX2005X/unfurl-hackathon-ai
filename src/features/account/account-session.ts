"use client";

import { useSyncExternalStore } from "react";
import { httpAccount } from "@/application/http-account";
import type { AccountState } from "@/application/account-port";
import type { AccountSession, Profile } from "@/domain/account";
import { safeReturnTo } from "@/lib/auth-return-to";
import { accountScope } from "./account-scope";

export type AccountSnapshot =
  | { status: "loading"; session: null }
  | { status: "error"; session: null }
  | ({ status: "ready" } & AccountState);

const initialSnapshot: AccountSnapshot = { status: "loading", session: null };
let snapshot: AccountSnapshot = initialSnapshot;
let sessionRequest: AbortController | null = null;
let epoch = 0;
let channel: BroadcastChannel | null = null;
let listening = false;
const listeners = new Set<() => void>();

function publish(next: AccountSnapshot) {
  snapshot = next;
  for (const notify of listeners) notify();
}

export async function refreshAccount(): Promise<void> {
  sessionRequest?.abort();
  const controller = new AbortController();
  sessionRequest = controller;
  const requestEpoch = epoch;
  try {
    const result = await httpAccount.getSession(controller.signal);
    if (controller.signal.aborted || requestEpoch !== epoch) return;
    sessionRequest = null;
    if (result.ok) {
      accountScope.replaceActor(result.data.session?.identity.id ?? null);
      publish({ status: "ready", ...result.data });
    } else {
      accountScope.replaceActor(null);
      publish({ status: "error", session: null });
    }
  } catch {
    if (controller.signal.aborted || requestEpoch !== epoch) return;
    sessionRequest = null;
    accountScope.replaceActor(null);
    publish({ status: "error", session: null });
  }
}

function discardAccount() {
  epoch += 1;
  sessionRequest?.abort();
  sessionRequest = null;
  accountScope.invalidate();
  accountScope.replaceActor(null);
  publish(initialSnapshot);
}

function beginListening() {
  if (listening || typeof window === "undefined") return;
  listening = true;
  if (typeof BroadcastChannel !== "undefined") {
    try {
      channel = new BroadcastChannel("unfurl-account");
      channel.onmessage = (event: MessageEvent<unknown>) => {
        const message = event.data;
        if (typeof message !== "object" || message === null || !("type" in message) || message.type !== "account-changed") return;
        discardAccount();
        void refreshAccount();
      };
    } catch { channel = null; }
  }
  // Also reconcile on return to a tab when BroadcastChannel is unavailable.
  window.addEventListener("focus", () => { void refreshAccount(); });
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) { discardAccount(); void refreshAccount(); }
  });
}

function subscribe(notify: () => void) {
  listeners.add(notify);
  beginListening();
  if (snapshot.status === "loading" && !sessionRequest) void refreshAccount();
  return () => { listeners.delete(notify); };
}

export function useAccountSession() {
  return useSyncExternalStore(subscribe, () => snapshot, () => initialSnapshot);
}

export function useAccountEpoch(): number {
  return useSyncExternalStore(subscribe, () => epoch, () => 0);
}

export function acceptProfile(profile: Profile) {
  if (snapshot.status !== "ready" || snapshot.session?.identity.id !== profile.id) return;
  const session: AccountSession = { ...snapshot.session, profile };
  publish({ ...snapshot, session });
}

/** Call only after a successful server mutation. No credentials enter browser storage. */
export function finishAccountChange(redirectTo: string) {
  beginListening();
  discardAccount();
  try { channel?.postMessage({ type: "account-changed" }); } catch { /* Navigation still replaces this session. */ }
  window.location.assign(safeReturnTo(redirectTo));
}
