"use client";

import { useEffect, useRef, useState } from "react";
import { Copy, Link2, Share2 } from "lucide-react";
import type { CatalogPort } from "@/application/catalog-port";
import { httpProgression } from "@/application/http-progression";
import type { ProgressionPort } from "@/application/progression-port";
import type { Visibility } from "@/domain/common";
import type { ShareList } from "@/domain/catalog";
import type { CourseVisibilityState } from "@/domain/progression";
import { Button, Dialog, Notice, TextField } from "@/components/ui";
import { CourseVisibilityControls } from "./CourseVisibilityControls";
import { afterShareRevoked, settleShareCreation, shareCreationIntent, type CreatedShareLink, type ShareCreationIntent } from "./share-intent";
import { settleVisibilityIntent, visibilityIntent, visibilityIntentIsSaved, type VisibilityIntent } from "./visibility-intent";

type LinkPending = "load" | "create" | string | null;
type VisibilityPending = "load" | "save" | null;

export function ShareCourseDialog({ services, progression = httpProgression, courseId, courseVersionId, courseVersionNumber }: {
  services: CatalogPort; progression?: ProgressionPort; courseId: string; courseVersionId: string; courseVersionNumber: number;
}) {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<ShareList | null>(null);
  const [linkPending, setLinkPending] = useState<LinkPending>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedShareLink | null>(null);
  const [copied, setCopied] = useState(false);
  const [createRetry, setCreateRetry] = useState(false);
  const [visibility, setVisibility] = useState<CourseVisibilityState | null>(null);
  const [choice, setChoice] = useState<Visibility>("private");
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const [visibilityPending, setVisibilityPending] = useState<VisibilityPending>(null);
  const [visibilityError, setVisibilityError] = useState<string | null>(null);
  const [visibilityRetry, setVisibilityRetry] = useState(false);
  const loadRequest = useRef<AbortController | null>(null);
  const createIntent = useRef<ShareCreationIntent | null>(null);
  const saveIntent = useRef<VisibilityIntent | null>(null);

  function acceptVisibility(next: CourseVisibilityState) {
    const retained = saveIntent.current;
    if (retained && visibilityIntentIsSaved(retained, next)) {
      saveIntent.current = null; setVisibilityRetry(false);
    } else if (retained) {
      setVisibility(next);
      setChoice(retained.input.visibility);
      setSelectedVersionId(retained.input.visibility === "public" ? retained.input.courseVersionId : null);
      return;
    }
    setVisibility(next);
    setChoice(next.visibility);
    setSelectedVersionId(next.visibility === "public" && next.publishedVersionId === courseVersionId ? courseVersionId : null);
  }

  async function loadLinks(signal?: AbortSignal) {
    setLinkPending("load"); setLinkError(null);
    try {
      const result = await services.listShares(courseId, signal);
      if (signal?.aborted) return;
      if (result.ok) setList(result.data);
      else setLinkError("Access links couldn’t be loaded. Try again.");
    } catch { if (!signal?.aborted) setLinkError("Access links couldn’t be loaded. Try again."); }
    finally { if (!signal?.aborted) setLinkPending(null); }
  }

  async function loadVisibility(signal?: AbortSignal) {
    setVisibilityPending("load"); setVisibilityError(null);
    try {
      const result = await progression.getCourseVisibility(courseId, signal);
      if (signal?.aborted) return;
      if (result.ok) acceptVisibility(result.data);
      else setVisibilityError("Visibility settings couldn’t be loaded. Try again.");
    } catch { if (!signal?.aborted) setVisibilityError("Visibility settings couldn’t be loaded. Try again."); }
    finally { if (!signal?.aborted) setVisibilityPending(null); }
  }

  useEffect(() => () => loadRequest.current?.abort(), []);
  function changeOpen(next: boolean) {
    setOpen(next);
    loadRequest.current?.abort();
    if (!next) return;
    const request = new AbortController();
    loadRequest.current = request;
    void loadLinks(request.signal);
    void loadVisibility(request.signal);
  }

  async function refreshVisibilityAfterCourseChange(message: string) {
    try {
      const fresh = await progression.getCourseVisibility(courseId);
      if (fresh.ok) acceptVisibility(fresh.data);
    } catch { /* A later retry or reopen will reconcile authority. */ }
    setVisibilityError(message);
  }

  async function create() {
    if (!list || linkPending || visibilityPending || saveIntent.current) return;
    setLinkPending("create"); setLinkError(null); setCopied(false);
    const intent = shareCreationIntent(createIntent.current, { courseVersionId, expectedCourseRevision: list.courseRevision });
    createIntent.current = intent;
    try {
      const result = await services.createShare(courseId, intent.input, intent.key);
      const retainedIntent = settleShareCreation(intent, result);
      createIntent.current = retainedIntent; setCreateRetry(retainedIntent !== null);
      if (!result.ok) {
        if (result.error.error.code === "revision_conflict") {
          await loadLinks();
          await refreshVisibilityAfterCourseChange("The course changed. Visibility and link details were refreshed.");
          setLinkError("The course changed. Link details were refreshed; try again.");
        } else setLinkError("A link couldn’t be created. Try again with the same request.");
        return;
      }
      setCreated({ grantId: result.data.shareId, url: new URL(result.data.shareUrl, window.location.origin).href });
      await Promise.all([loadLinks(), loadVisibility()]);
    } catch { setCreateRetry(true); setLinkError("A link couldn’t be created. Try again with the same request."); }
    finally { setLinkPending(null); }
  }

  async function revoke(shareId: string) {
    if (linkPending || visibilityPending || createIntent.current || saveIntent.current) return;
    setLinkPending(shareId); setLinkError(null);
    try {
      const result = await services.revokeShare(courseId, shareId);
      if (!result.ok) { setLinkError("The link couldn’t be revoked. Try again."); return; }
      setCreated((value) => afterShareRevoked(value, shareId)); setCopied(false);
      await Promise.all([loadLinks(), loadVisibility()]);
    } catch { setLinkError("The link couldn’t be revoked. Try again."); }
    finally { setLinkPending(null); }
  }

  async function saveVisibility() {
    if (!visibility || visibilityPending || linkPending || createIntent.current) return;
    const version = choice === "public" ? selectedVersionId : courseVersionId;
    if (!version) return;
    const intent = visibilityIntent(saveIntent.current, {
      expectedRevision: visibility.revision, visibility: choice, courseVersionId: version,
    });
    saveIntent.current = intent;
    setVisibilityPending("save"); setVisibilityError(null);
    try {
      const result = await progression.setVisibility(courseId, intent.input, { idempotencyKey: intent.key });
      const retainedIntent = settleVisibilityIntent(intent, result);
      saveIntent.current = retainedIntent; setVisibilityRetry(retainedIntent !== null);
      if (!result.ok) {
        if (result.error.error.code === "revision_conflict") {
          await loadVisibility();
          await loadLinks();
          setVisibilityError("The course changed elsewhere. Saved settings were refreshed; choose again.");
        } else setVisibilityError(result.error.error.code === "forbidden"
          ? "This course or version cannot be made public with the current account access."
          : "Visibility couldn’t be saved. Retry the same change.");
        return;
      }
      const next: CourseVisibilityState = { ...visibility, ...result.data };
      acceptVisibility(next);
      if (result.data.visibility === "private") { setCreated(null); setCopied(false); }
      await loadLinks();
    } catch { setVisibilityRetry(true); setVisibilityError("Visibility couldn’t be saved. Retry the same change."); }
    finally { setVisibilityPending(null); }
  }

  async function copy() {
    if (!created) return;
    try { await navigator.clipboard.writeText(created.url); setCopied(true); }
    catch { setLinkError("Copying wasn’t available. Select the link and copy it manually."); }
  }

  const active = list?.items.filter((item) => item.revokedAt === null) ?? [];
  const revoked = list?.items.filter((item) => item.revokedAt !== null) ?? [];
  const linkMutationBlocked = visibilityPending !== null || visibilityRetry;
  return <>
    <Button variant="secondary" onClick={() => changeOpen(true)}><Share2 size={18} aria-hidden="true" />Sharing settings</Button>
    <Dialog open={open} onOpenChange={changeOpen} title="Sharing and visibility" description={`Control who can open Version ${courseVersionNumber}. Settings change only when you use a save or link action.`}>
      <div className="uf-share-dialog">
        {visibilityPending === "load" && !visibility ? <p role="status">Loading visibility…</p> : visibility
          ? <CourseVisibilityControls state={visibility} choice={choice} selectedVersionId={selectedVersionId}
            displayedVersionId={courseVersionId} displayedVersionNumber={courseVersionNumber}
            pending={visibilityPending === "save"} locked={visibilityRetry} blocked={linkPending !== null || createRetry}
            error={visibilityError} onChoice={setChoice} onSelectVersion={() => setSelectedVersionId(courseVersionId)} onSave={() => void saveVisibility()} />
          : visibilityError && <Notice tone="error" action={<Button variant="secondary" onClick={() => void loadVisibility()}>Retry visibility</Button>}>{visibilityError}</Notice>}
        <section className="uf-share-links" aria-labelledby="access-links-heading">
          {linkError && <Notice tone="error" action={!list ? <Button variant="secondary" onClick={() => void loadLinks()}>Retry links</Button> : undefined}>{linkError}</Notice>}
          {created && <section className="uf-share-dialog__created" aria-label="New access link">
            <TextField id="new-share-link" label="New link" value={created.url} readOnly onFocus={(event) => event.currentTarget.select()} />
            <Button variant="secondary" onClick={() => void copy()}><Copy size={18} aria-hidden="true" />{copied ? "Copied" : "Copy link"}</Button>
          </section>}
          {linkPending === "load" && !list ? <p role="status">Loading access links…</p> : <>
            <div className="uf-share-dialog__heading"><div><h3 id="access-links-heading">Access links</h3><p>Links open this displayed version. Creating a link makes a Private course Unlisted; choosing Unlisted alone does not create a link.</p></div>
              <Button pending={linkPending === "create"} disabled={linkMutationBlocked || linkPending !== null || !list}
                onClick={() => void create()}><Link2 size={18} aria-hidden="true" />{createRetry ? "Retry link" : "Create link"}</Button></div>
            {active.length ? <ul className="uf-share-list">{active.map((item) => <li key={item.id}><div><strong>Version link</strong><span>Created <time dateTime={item.createdAt}>{new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" }).format(new Date(item.createdAt))}</time></span></div>
              <Button variant="danger" size="compact" pending={linkPending === item.id} disabled={linkMutationBlocked || linkPending !== null || createRetry} onClick={() => void revoke(item.id)}>Revoke</Button></li>)}</ul>
              : <p className="uf-share-dialog__empty">No active links. Create one only when you’re ready to invite a learner.</p>}
            {revoked.length > 0 && <p className="uf-share-dialog__revoked">{revoked.length} revoked {revoked.length === 1 ? "link" : "links"}</p>}
          </>}
        </section>
      </div>
    </Dialog>
  </>;
}
