"use client";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { CatalogPort } from "@/application/catalog-port";
import { httpCatalog } from "@/application/http-catalog";
import { AppShell } from "@/components/shell";
import { Button, LinkButton, Notice } from "@/components/ui";
import { routes } from "@/lib/routes";
import { CatalogController } from "./catalog-controller";
import { readCourseQuery, updateCollectionQuery } from "./query";
import { CollectionFilters } from "./CollectionFilters";
import { CourseCard } from "./CourseCard";
import { EmptyShelfArtwork } from "./EmptyShelfArtwork";
import "./catalog.css";

export function CatalogPage({ services = httpCatalog }: { services?: CatalogPort }) {
  const params = useSearchParams(), router = useRouter();
  const { q = "", contentLanguage = "" } = readCourseQuery(params);
  const controller = useMemo(() => new CatalogController(services), [services]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useEffect(() => { void controller.search({ ...(q ? { q } : {}), ...(contentLanguage ? { contentLanguage } : {}) }); return controller.dispose; }, [controller, q, contentLanguage]);
  const filtered = Boolean(q || contentLanguage);
  function change(query: string, language: string) { router.push(routes.explore + updateCollectionQuery(params.toString(), { q: query, contentLanguage: language }), { scroll: false }); }
  return <AppShell active="explore"><div className="uf-collection">
    <header className="uf-collection__heading"><h1>Explore courses</h1><LinkButton href={routes.create()}>New course</LinkButton></header>
    <CollectionFilters q={q} contentLanguage={contentLanguage} onChange={change} />
    <section className="uf-catalog-results" aria-label="Public courses" aria-busy={state.status === "loading"}>
      {(state.status === "idle" || state.status === "loading") && <div className="uf-collection-loading" role="status"><span className="uf-collection-loading__book" aria-hidden="true" /><p>Finding courses</p></div>}
      {state.status === "error" && <Notice tone="error" title="Courses are unavailable" action={<Button variant="secondary" onClick={() => void controller.retry()}>Try again</Button>}>{state.error}</Notice>}
      {state.status === "ready" && state.items.length === 0 && (filtered ? <div className="uf-collection-empty uf-collection-empty--search"><h2>No courses match your search</h2><p>Try a broader subject or choose a different course language.</p><Button variant="secondary" onClick={() => change("", "")}>Reset filters</Button></div> : <div className="uf-collection-empty"><div className="uf-collection-empty__copy"><h2>No public courses yet</h2><p>Create a course around what you want to learn, or try a short activity.</p><LinkButton variant="secondary" href={routes.try}>Try an activity</LinkButton></div><EmptyShelfArtwork /></div>)}
      {state.items.length > 0 && <div className="uf-course-list">{state.items.map((course) => <CourseCard key={course.id} course={course} />)}</div>}
      {state.pageError && <Notice tone="error" title="Some courses could not be loaded" action={<Button variant="secondary" onClick={() => void controller.retry()}>Retry loading more</Button>}>{state.pageError}</Notice>}
      {state.nextCursor && !state.pageError && <div className="uf-collection-more"><Button variant="secondary" pending={state.loadingMore} onClick={() => void controller.loadMore()}>Load more courses</Button></div>}
    </section>
    {state.items.length > 0 && <aside className="uf-catalog-practice"><LinkButton variant="secondary" href={routes.try}>Try an activity</LinkButton></aside>}
  </div></AppShell>;
}
