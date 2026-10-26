"use client";

import { useEffect, useRef, useState } from "react";
import type { CatalogPort } from "@/application/catalog-port";
import { httpCatalog } from "@/application/http-catalog";
import { AppShell } from "@/components/shell";
import { Button, LinkButton, Notice } from "@/components/ui";
import { accountScope } from "@/features/account/account-scope";
import { refreshAccount, useAccountSession } from "@/features/account/account-session";
import { routes } from "@/lib/routes";
import { startCoursePath } from "./paths";
import "./catalog.css";

export function StartCourseContinuation({ courseId, versionId, shareToken, valid = true, services = httpCatalog }: {
  courseId: string; versionId: string; shareToken?: string; valid?: boolean; services?: CatalogPort;
}) {
  const account = useAccountSession();
  const [failure, setFailure] = useState<{ identity: string; retry: number; status: "error" | "unavailable" } | null>(null);
  const [retry, setRetry] = useState(0);
  const attempt = useRef<{ identity: string; key: string } | null>(null);
  const actorId = account.status === "ready" ? account.session?.identity.id ?? null : null;
  const identity = JSON.stringify([actorId, courseId, versionId, shareToken ?? null]);
  const status = failure?.identity === identity && failure.retry === retry ? failure.status : "joining";
  const returnTo = valid ? startCoursePath(courseId, versionId, shareToken) : routes.explore;
  useEffect(() => {
    if (!valid || !actorId) return;
    // Preserve delivery identity across retries and StrictMode effect replay.
    // A new actor or course target must never reuse the previous command key.
    if (attempt.current?.identity !== identity) attempt.current = { identity, key: crypto.randomUUID() };
    const request = accountScope.request(actorId);
    void services.createEnrollment(courseId, { courseVersionId: versionId, ...(shareToken ? { shareToken } : {}) }, attempt.current.key, request.signal)
      .then((result) => {
        if (!request.isCurrent()) return;
        if (result.ok) window.location.replace(result.data.redirectTo);
        else setFailure({ identity, retry, status: ["not_found", "forbidden"].includes(result.error.error.code) ? "unavailable" : "error" });
      }).catch(() => { if (request.isCurrent()) setFailure({ identity, retry, status: "error" }); }).finally(request.release);
    return request.abort;
  }, [valid, actorId, courseId, versionId, shareToken, services, retry, identity]);

  if (!valid) return <AppShell active="explore"><div className="uf-collection"><section className="uf-start-course"><h1>This course link isn’t valid</h1><p>Open the course again from Explore or your library.</p><LinkButton href={routes.explore}>Explore courses</LinkButton></section></div></AppShell>;
  if (account.status !== "ready" || !account.session) return <AppShell active="explore"><div className="uf-collection"><section className="uf-start-course">
    <div className="uf-start-course__book" aria-hidden="true"><span /><span /></div>
    <h1>{account.status === "loading" ? "Checking your account…" : account.status === "error" ? "Your account couldn’t be checked" : "Sign in to start this course"}</h1>
    {account.status === "error" ? <><p>Your course link is still here. Try checking your account again.</p><Button onClick={() => void refreshAccount()}>Try again</Button></>
      : account.status === "ready" ? <><p>Your enrollment is private to your account. The course author and other learners won’t see your answers.</p><div><LinkButton href={routes.login(returnTo)}>Sign in</LinkButton><LinkButton variant="secondary" href={routes.signup(returnTo)}>Create account</LinkButton></div></> : null}
  </section></div></AppShell>;
  return <AppShell active="explore"><div className="uf-collection"><section className="uf-start-course">
    <div className="uf-start-course__book" aria-hidden="true"><span /><span /></div>
    {status === "unavailable" ? <><h1>This course isn’t available</h1><p>The course or private link may have changed or been revoked.</p><LinkButton href={routes.explore}>Explore courses</LinkButton></>
      : status === "error" ? <><Notice tone="error" title="The course couldn’t be added">Your account and any existing progress are unchanged.</Notice><Button onClick={() => setRetry((value) => value + 1)}>Try again</Button></>
      : <><h1>Adding this course to your library…</h1><p role="status">This creates one private enrollment pinned to the version you opened.</p></>}
  </section></div></AppShell>;
}
