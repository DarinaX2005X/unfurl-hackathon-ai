"use client";

import { useEffect, useRef, useState } from "react";
import { LogOut } from "lucide-react";
import { httpAccount } from "@/application/http-account";
import { Button, Notice } from "@/components/ui";
import { accountErrorMessage } from "./account-form";
import { accountScope } from "./account-scope";
import { finishAccountChange } from "./account-session";

export function SignOutButton({ actorId, compact = false }: { actorId: string; compact?: boolean }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef<ReturnType<typeof accountScope.request> | null>(null);
  useEffect(() => () => { requestRef.current?.abort(); requestRef.current = null; }, []);

  async function signOut() {
    if (requestRef.current) return;
    const request = accountScope.request(actorId);
    requestRef.current = request;
    setPending(true);
    setError(null);
    try {
      const result = await httpAccount.signOut(request.signal);
      if (!request.isCurrent()) return;
      if (result.ok) finishAccountChange(result.data.redirectTo);
      else setError(accountErrorMessage(result.error));
    } catch { if (!request.signal.aborted) setError("We could not sign you out. Please try again."); }
    finally {
      request.release();
      if (requestRef.current === request) { requestRef.current = null; setPending(false); }
    }
  }

  return <div className="uf-account-signout">
    <Button variant="quiet" size={compact ? "compact" : "default"} className="uf-account-signout__button" pending={pending} onClick={() => void signOut()}>
      <LogOut size={20} strokeWidth={1.75} aria-hidden="true" />{pending ? "Signing out" : "Sign out"}
    </Button>
    {error && <Notice tone="error">{error}</Notice>}
  </div>;
}
