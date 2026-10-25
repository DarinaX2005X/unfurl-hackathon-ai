"use client";

import { useEffect, useRef, useState } from "react";
import { Copy, Link2, Share2 } from "lucide-react";
import type { CatalogPort } from "@/application/catalog-port";
import type { ShareList } from "@/domain/catalog";
import { Button, Dialog, Notice, TextField } from "@/components/ui";
import { afterShareRevoked, settleShareCreation, shareCreationIntent, type CreatedShareLink, type ShareCreationIntent } from "./share-intent";

export function ShareCourseDialog({ services, courseId, courseVersionId }: {
  services: CatalogPort; courseId: string; courseVersionId: string;
}) {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<ShareList | null>(null);
  const [pending, setPending] = useState<"load" | "create" | string | null>(null);
  const [created, setCreated] = useState<CreatedShareLink | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadRequest = useRef<AbortController | null>(null);
  const createIntent = useRef<ShareCreationIntent | null>(null);

  async function load(signal?: AbortSignal) {
    setPending("load"); setError(null);
    const result = await services.listShares(courseId, signal);
    if (signal?.aborted) return;
    if (result.ok) setList(result.data);
    else setError("Sharing details couldn’t be loaded. Try again.");
    setPending(null);
  }
  useEffect(() => () => loadRequest.current?.abort(), []);
  function changeOpen(next: boolean) {
    setOpen(next);
    loadRequest.current?.abort();
    if (!next) return;
    const request = new AbortController();
    loadRequest.current = request;
    void load(request.signal).catch(() => {
      if (!request.signal.aborted) { setError("Sharing details couldn’t be loaded. Try again."); setPending(null); }
    });
  }

  async function create() {
    if (!list || pending) return;
    setPending("create"); setError(null); setCopied(false);
    const intent = shareCreationIntent(createIntent.current, { courseVersionId, expectedCourseRevision: list.courseRevision });
    createIntent.current = intent;
    try {
      const result = await services.createShare(courseId, intent.input, intent.key);
      createIntent.current = settleShareCreation(intent, result);
      if (!result.ok) {
        if (result.error.error.code === "revision_conflict") {
          try {
            const fresh = await services.listShares(courseId);
            if (fresh.ok) setList(fresh.data);
          } catch { /* The next open will fetch the current revision. */ }
          setError("The course changed. Sharing details were refreshed; try again.");
        } else setError("A share link couldn’t be created. Try again.");
        return;
      }
      setCreated({ grantId: result.data.shareId, url: new URL(result.data.shareUrl, window.location.origin).href });
      try {
        const fresh = await services.listShares(courseId);
        if (fresh.ok) setList(fresh.data);
        else setError("The link was created, but the updated link list couldn’t be loaded.");
      } catch { setError("The link was created, but the updated link list couldn’t be loaded."); }
    } catch { setError("A share link couldn’t be created. Try again."); }
    finally { setPending(null); }
  }
  async function revoke(shareId: string) {
    if (pending) return;
    setPending(shareId); setError(null);
    try {
      const result = await services.revokeShare(courseId, shareId);
      if (!result.ok) { setError("The link couldn’t be revoked. Try again."); return; }
      setCreated((value) => afterShareRevoked(value, shareId)); setCopied(false);
      try {
        const fresh = await services.listShares(courseId);
        if (fresh.ok) setList(fresh.data);
        else setError("The link was revoked, but the updated list couldn’t be loaded.");
      } catch { setError("The link was revoked, but the updated list couldn’t be loaded."); }
    } catch { setError("The link couldn’t be revoked. Try again."); }
    finally { setPending(null); }
  }
  async function copy() {
    if (!created) return;
    try { await navigator.clipboard.writeText(created.url); setCopied(true); }
    catch { setError("Copying wasn’t available. Select the link and copy it manually."); }
  }

  const active = list?.items.filter((item) => item.revokedAt === null) ?? [];
  const revoked = list?.items.filter((item) => item.revokedAt !== null) ?? [];
  return <>
    <Button variant="secondary" onClick={() => changeOpen(true)}><Share2 size={18} aria-hidden="true" />Share course</Button>
    <Dialog open={open} onOpenChange={changeOpen} title="Share this course" description="Each link opens this exact ready version. Revoking it prevents new access and enrollments; people already enrolled keep their course.">
      <div className="uf-share-dialog">
        {error && <Notice tone="error">{error}</Notice>}
        {created && <section className="uf-share-dialog__created" aria-label="New share link">
          <TextField id="new-share-link" label="New link" value={created.url} readOnly onFocus={(event) => event.currentTarget.select()} />
          <Button variant="secondary" onClick={() => void copy()}><Copy size={18} aria-hidden="true" />{copied ? "Copied" : "Copy link"}</Button>
        </section>}
        {pending === "load" && !list ? <p role="status">Loading share links…</p> : <>
          <div className="uf-share-dialog__heading"><div><h3>Active links</h3><p>Copy your new link before leaving this page. You can revoke older links below.</p></div>
            <Button pending={pending === "create"} disabled={pending !== null || !list} onClick={() => void create()}><Link2 size={18} aria-hidden="true" />Create link</Button></div>
          {active.length ? <ul className="uf-share-list">{active.map((item) => <li key={item.id}><div><strong>Version link</strong><span>Created <time dateTime={item.createdAt}>{new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" }).format(new Date(item.createdAt))}</time></span></div>
            <Button variant="danger" size="compact" pending={pending === item.id} disabled={pending !== null} onClick={() => void revoke(item.id)}>Revoke</Button></li>)}</ul>
            : <p className="uf-share-dialog__empty">No active links. Create one when you’re ready to invite a learner.</p>}
          {revoked.length > 0 && <p className="uf-share-dialog__revoked">{revoked.length} revoked {revoked.length === 1 ? "link" : "links"}</p>}
        </>}
      </div>
    </Dialog>
  </>;
}
