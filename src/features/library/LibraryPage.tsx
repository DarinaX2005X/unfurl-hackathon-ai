"use client";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { FileText, Monitor, Plus } from "lucide-react";
import type { ApplicationPort, LibraryItem } from "@/application/ports";
import { localApplication } from "@/application/local-adapter";
import { draftStore, type DraftStore, type LocalDraft } from "@/lib/drafts";
import { routes } from "@/lib/routes";
import { AppShell } from "@/components/shell";
import { Button, Dialog, LinkButton, Menu, Notice, TextField } from "@/components/ui";
import { CollectionFilters } from "@/features/catalog/CollectionFilters";
import { CourseCard } from "@/features/catalog/CourseCard";
import { EmptyBookArtwork } from "@/features/catalog/CourseArtwork";
import { languageName, readCourseQuery, readLibraryView, updateCollectionQuery, type LibraryView } from "@/features/catalog/query";
import { DraftController } from "./draft-controller";
import "@/features/catalog/catalog.css";
import "./library.css";

type CloudState = { kind: "loading" | "unavailable" | "error" } | { kind: "ready"; items: LibraryItem[] };
type DraftAction = { kind: "new" } | { kind: "rename" | "delete"; draft: LocalDraft };
const views: { id: LibraryView; label: string }[] = [{ id: "all", label: "Everything" }, { id: "drafts", label: "Drafts" }, { id: "courses", label: "Courses" }, { id: "in_progress", label: "In progress" }];
function matches(text: string, language: string, q: string, filterLanguage: string) { return (!q || text.toLocaleLowerCase("en").includes(q.toLocaleLowerCase("en"))) && (!filterLanguage || language.toLowerCase() === filterLanguage.toLowerCase()); }

export function LibraryPage({ services = localApplication, store = draftStore }: { services?: ApplicationPort; store?: DraftStore }) {
  const router = useRouter(), params = useSearchParams();
  const { q = "", contentLanguage = "" } = readCourseQuery(params);
  const view = readLibraryView(params);
  const controller = useMemo(() => new DraftController(store), [store]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [cloud, setCloud] = useState<CloudState>({ kind: "loading" });
  const [cloudRetry, setCloudRetry] = useState(0);
  const [action, setAction] = useState<DraftAction | null>(null);
  const [title, setTitle] = useState("");
  const titleRef = useRef<HTMLInputElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (action) (action.kind === "delete" ? cancelRef.current : titleRef.current)?.focus(); }, [action]);
  const [titleError, setTitleError] = useState<string | undefined>();
  const [confirmation, setConfirmation] = useState("");
  useEffect(() => {
    void controller.refresh();
    const refresh = () => { if (document.visibilityState === "visible") void controller.refresh(); };
    window.addEventListener("focus", refresh); window.addEventListener("pageshow", refresh); document.addEventListener("visibilitychange", refresh);
    return () => { controller.dispose(); window.removeEventListener("focus", refresh); window.removeEventListener("pageshow", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, [controller]);
  useEffect(() => {
    const request = new AbortController();
    void (async () => {
      try {
        const capabilities = await services.capabilities();
        if (request.signal.aborted) return;
        if (!capabilities.cloudPersistence) { setCloud({ kind: "unavailable" }); return; }
        const result = await services.listLibrary(request.signal);
        if (!request.signal.aborted) setCloud(result.ok ? { kind: "ready", items: result.data.items } : { kind: "error" });
      } catch { if (!request.signal.aborted) setCloud({ kind: "error" }); }
    })();
    return () => request.abort();
  }, [services, cloudRetry]);
  function changeFilters(query: string, language: string) { router.push(routes.library + updateCollectionQuery(params.toString(), { q: query, contentLanguage: language }), { scroll: false }); }
  function openAction(next: DraftAction) { setAction(next); setTitle(next.kind === "new" ? "" : next.draft.title); setTitleError(undefined); controller.clearActionError(); }
  function closeAction() { if (!state.pending) { setAction(null); controller.clearActionError(); } }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!action || state.pending) return;
    if (action.kind !== "delete" && !title.trim()) { setTitleError("Give this draft a title."); return; }
    if (action.kind === "new") { const id = await controller.create(title); if (id) { setAction(null); router.push(routes.create(id)); } }
    else if (action.kind === "rename") { if (await controller.rename(action.draft.id, title)) { setAction(null); setConfirmation("Draft renamed."); } }
    else if (await controller.remove(action.draft.id)) { setAction(null); setConfirmation("Draft deleted from this device."); }
  }
  const drafts = state.drafts.filter((draft) => matches(`${draft.title} ${draft.text}`, draft.contentLanguage, q, contentLanguage));
  const records = cloud.kind === "ready" ? cloud.items.filter((item) => matches(`${item.course.title} ${item.course.summary}`, item.course.contentLanguage, q, contentLanguage)) : [];
  const enrolled = records.filter((item) => item.kind === "enrolled");
  const owned = records.filter((item) => item.kind === "owned");
  const hasFilters = Boolean(q || contentLanguage);
  const showDrafts = view === "all" || view === "drafts";
  const showCourses = view !== "drafts";
  const dialogTitle = action?.kind === "new" ? "Name your course draft" : action?.kind === "rename" ? "Rename draft" : "Delete this draft?";
  return <AppShell active="library"><div className="uf-collection uf-library">
    <header className="uf-collection__heading"><div><h1>Your library</h1><p>A place for what you’re learning and what comes next.</p></div><Button onClick={() => openAction({ kind: "new" })}><Plus size={20} aria-hidden="true" />New draft</Button></header>
    <nav className="uf-library-views" aria-label="Library view">{views.map((item) => <a key={item.id} href={routes.library + updateCollectionQuery(params.toString(), { view: item.id })} aria-current={view === item.id ? "page" : undefined} onClick={(event) => { if (event.button === 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) { event.preventDefault(); router.push(routes.library + updateCollectionQuery(params.toString(), { view: item.id }), { scroll: false }); } }}>{item.label}</a>)}</nav>
    <CollectionFilters q={q} contentLanguage={contentLanguage} onChange={changeFilters} noun="library" />
    {confirmation && <div className="uf-library-confirmation" role="status">{confirmation}<Button variant="quiet" size="compact" onClick={() => setConfirmation("")}>Dismiss</Button></div>}
    {showCourses && <section className="uf-library-cloud" aria-label="Your courses">
      {cloud.kind === "loading" && <p role="status">Opening your courses</p>}
      {(cloud.kind === "unavailable" || cloud.kind === "error") && <div className="uf-library-cloud__unavailable"><div><h2>Your courses aren’t available right now</h2><p>You can still work with course drafts saved on this device.</p></div><Button variant="quiet" onClick={() => { setCloud({ kind: "loading" }); setCloudRetry((value) => value + 1); }}>Try again</Button></div>}
      {cloud.kind === "ready" && (view === "in_progress" ? enrolled.length === 0 : records.length === 0) && <div className="uf-library-cloud__unavailable"><div><h2>{hasFilters ? "No courses match your search" : view === "in_progress" ? "You haven’t started a course yet" : "No courses in your library yet"}</h2><p>{hasFilters ? "Try a broader subject or choose another course language." : "Explore the catalog to find something you want to learn."}</p></div>{hasFilters ? <Button variant="quiet" onClick={() => changeFilters("", "")}>Reset filters</Button> : <LinkButton variant="secondary" href={routes.explore}>Explore courses</LinkButton>}</div>}
      {enrolled.length > 0 && <section className="uf-library-course-group"><h2>Continue learning</h2><div className="uf-library-enrolled">{enrolled.map((item) => item.kind === "enrolled" && <article key={item.enrollmentId}><div><h3>{item.course.title}</h3><p>{item.lastStudiedAt ? `Last opened ${new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" }).format(new Date(item.lastStudiedAt))}` : "Ready to begin"}</p></div><LinkButton href={routes.learn(item.enrollmentId)} variant="secondary">{item.lastStudiedAt ? "Continue course" : "Start course"}</LinkButton></article>)}</div></section>}
      {view !== "in_progress" && owned.length > 0 && <section className="uf-library-course-group"><h2>Your courses</h2><div className="uf-course-grid">{owned.map((item) => <CourseCard key={item.course.id} course={item.course} />)}</div></section>}
    </section>}
    {showDrafts && <section className="uf-library-drafts" aria-labelledby="local-drafts-heading" aria-busy={state.status === "loading"}>
      <header className="uf-library-drafts__heading"><div><h2 id="local-drafts-heading">Course drafts</h2><span><Monitor size={18} aria-hidden="true" />On this device</span></div><Button variant="quiet" onClick={() => void controller.refresh()} pending={state.status === "loading"}>Refresh drafts</Button></header>
      {state.error && <Notice tone="error" title="Drafts could not be read" action={<Button variant="secondary" onClick={() => void controller.refresh()}>Try again</Button>}>{state.error}</Notice>}
      {(state.status === "loading" || state.status === "idle") && state.drafts.length === 0 && <p className="uf-library-drafts__loading" role="status">Reading drafts on this device</p>}
      {state.status === "ready" && drafts.length === 0 && (hasFilters ? <div className="uf-collection-empty uf-collection-empty--search"><h3>No drafts match your search</h3><p>Try a broader subject or choose another course language.</p><Button variant="secondary" onClick={() => changeFilters("", "")}>Reset filters</Button></div> : <div className="uf-library-first-draft"><EmptyBookArtwork /><div><h3>Keep your next learning idea here</h3><p>Save a course draft to return to its goal, starting point, and the questions you want to answer.</p><p className="uf-library-first-draft__note">Drafts stay in this browser on this device.</p><Button variant="secondary" onClick={() => openAction({ kind: "new" })}>Create a draft</Button></div></div>)}
      {drafts.length > 0 && <ul className="uf-draft-list">{drafts.map((draft) => <li key={draft.id} className="uf-draft-row"><div className="uf-draft-row__paper" aria-hidden="true"><FileText size={30} strokeWidth={1.4} /></div><div className="uf-draft-row__content"><h3><a href={routes.create(draft.id)}>{draft.title}</a></h3>{draft.text && <p>{draft.text}</p>}<div className="uf-draft-row__meta"><span>{languageName(draft.contentLanguage)}</span><time dateTime={draft.updatedAt}>Edited {new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" }).format(new Date(draft.updatedAt))}</time></div></div><div className="uf-draft-row__actions" role="group" aria-label={`Actions for ${draft.title}`}><LinkButton href={routes.create(draft.id)} variant="secondary" size="compact">Open draft</LinkButton><Menu label="Manage" items={[{ id: "rename", label: "Rename draft", onSelect: () => openAction({ kind: "rename", draft }) }, { id: "delete", label: "Delete draft", danger: true, onSelect: () => openAction({ kind: "delete", draft }) }]} /></div></li>)}</ul>}
    </section>}
    <Dialog open={action !== null} onOpenChange={(open) => { if (!open) closeAction(); }} title={dialogTitle} {...(action?.kind === "delete" ? { description: "This removes the saved draft from this device. It cannot be undone." } : {})}>
      <form onSubmit={submit} className="uf-draft-form">{action?.kind === "delete" ? <p className="uf-draft-form__delete-title">{action.draft.title}</p> : <TextField ref={titleRef} id="draft-title" label="Course title" value={title} maxLength={120} disabled={Boolean(state.pending)} required {...(titleError ? { error: titleError } : {})} onChange={(event) => { setTitle(event.target.value); setTitleError(undefined); }} hint={action?.kind === "new" ? "You can develop the learning goal after saving this draft." : undefined} />}{state.actionError && <Notice tone="error">{state.actionError}</Notice>}<div className="uf-draft-form__actions"><Button ref={cancelRef} variant="quiet" disabled={Boolean(state.pending)} onClick={closeAction}>Cancel</Button><Button type="submit" variant={action?.kind === "delete" ? "danger" : "primary"} pending={Boolean(state.pending)}>{action?.kind === "delete" ? "Delete draft" : action?.kind === "new" ? "Create draft" : "Save name"}</Button></div></form>
    </Dialog>
  </div></AppShell>;
}
