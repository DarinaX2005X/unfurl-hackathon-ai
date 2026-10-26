"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { ConversationPort } from "@/application/conversation-port";
import type { ConversationDetail } from "@/domain/conversations";
import { accountScope } from "@/features/account/account-scope";
import { buildTransport, ConversationBuilds, type ConversationBuildState } from "./conversation-builds";

const empty: ConversationBuildState = { builds: [], loading: false, error: false };
const noopSubscribe = () => () => {};
const emptySnapshot = () => empty;
export function useConversationBuilds(actorId: string, conversationId: string | undefined, branchId: string | undefined,
  conversations: ConversationPort, onDetail: (detail: ConversationDetail) => void) {
  const controller = useMemo(() => conversationId && branchId
    ? new ConversationBuilds({ actorId, conversationId, branchId }, buildTransport(conversations)) : null,
  [actorId, conversationId, branchId, conversations]);
  const state = useSyncExternalStore(controller?.subscribe ?? noopSubscribe, controller?.getSnapshot ?? emptySnapshot, controller?.getSnapshot ?? emptySnapshot);
  useEffect(() => { controller?.setDetailHandler(onDetail); }, [controller, onDetail]);
  useEffect(() => {
    if (!controller) return;
    const stop = accountScope.onClear(actorId, () => controller.stop());
    void controller.start();
    return () => { stop(); controller.stop(); };
  }, [actorId, controller]);
  return { state, controller };
}
