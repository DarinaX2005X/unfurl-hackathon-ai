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
  const [status, setStatus] = useState<"idle" | "joining" | "error" | "unavailable">("idle");
  const attempted = useRef(false);
  const returnTo = valid ? startCoursePath(courseId, versionId, shareToken) : routes.explore;
  useEffect(() => {
    if (!valid || account.status !== "ready" || !account.session || attempted.current) return;
    attempted.current = true;
    const request = accountScope.request(account.session.identity.id);
    setStatus("joining");
    void services.createEnrollment(courseId, { courseVersionId: versionId, ...(shareToken ? { shareToken } : {}) }, crypto.randomUUID(), request.signal)
      .then((result) => {
        if (!request.isCurrent()) return;
        if (result.ok) window.location.replace(result.data.redirectTo);
        else setStatus(["not_found", "forbidden"].includes(result.error.error.code) ? "unavailable" : "error");
      }).catch(() => { if (request.isCurrent()) setStatus("error"); }).finally(request.release);
    return request.abort;
  }, [valid, account, courseId, versionId, shareToken, services, status]);

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
      : status === "error" ? <><Notice tone="error" title="The course couldn’t be added">Your account and any existing progress are unchanged.</Notice><Button onClick={() => { attempted.current = false; setStatus("idle"); }}>Try again</Button></>
      : <><h1>Adding this course to your library…</h1><p role="status">This creates one private enrollment pinned to the version you opened.</p></>}
  </section></div></AppShell>;
}
