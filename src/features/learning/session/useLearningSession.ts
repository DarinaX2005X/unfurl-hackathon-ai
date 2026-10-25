"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";
import { httpLearning } from "@/application/http-learning";
import { accountScope } from "@/features/account/account-scope";
import { getProductionMechanic } from "@/features/learning/registry";
import { LearningSessionController } from "./controller";
import { browserRecoveryStorage } from "./recovery";

export function useLearningSession(actorId: string, enrollmentId: string) {
  const controller = useMemo(() => new LearningSessionController(actorId, enrollmentId,
    httpLearning, getProductionMechanic, browserRecoveryStorage()), [actorId, enrollmentId]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useEffect(() => {
    const release = controller.retain();
    const clear = accountScope.onClear(actorId, () => controller.dispose());
    const online = () => controller.setOnline(navigator.onLine);
    online();
    window.addEventListener("online", online);
    window.addEventListener("offline", online);
    const leave = (event: BeforeUnloadEvent) => {
      const current = controller.getSnapshot();
      if (current.dirty || current.submissionUnconfirmed || current.actionUnconfirmed || current.commandUnconfirmed) event.preventDefault();
    };
    window.addEventListener("beforeunload", leave);
    void controller.load();
    return () => {
      clear(); release();
      window.removeEventListener("online", online);
      window.removeEventListener("offline", online);
      window.removeEventListener("beforeunload", leave);
    };
  }, [actorId, controller]);
  return { controller, state };
}
