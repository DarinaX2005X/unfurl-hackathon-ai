"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { RefreshCw } from "lucide-react";
import type { CatalogPort } from "@/application/catalog-port";
import { httpCatalog } from "@/application/http-catalog";
import { AppShell } from "@/components/shell";
import { Button, LinkButton } from "@/components/ui";
import { routes } from "@/lib/routes";
import { CollectionFilters } from "@/features/catalog/CollectionFilters";
import { readCourseQuery, readLibraryView, resetLibraryFilters, showAllLibraryCourses, updateCollectionQuery, type LibraryView } from "@/features/catalog/query";
import { refreshAccount, useAccountSession } from "@/features/account/account-session";
import { LibraryController } from "./library-controller";
import { LibraryCollection } from "./LibraryCollection";
import "@/features/catalog/catalog.css";
import "./library.css";

const views: { id: LibraryView; label: string }[] = [{ id: "all", label: "All courses" }, { id: "in_progress", label: "In progress" }, { id: "courses", label: "Created by you" }];

export function LibraryPage({ services = httpCatalog }: { services?: CatalogPort }) {
  const account = useAccountSession();
  if (account.status !== "ready" || !account.session) return <AppShell active="library"><div className="uf-collection"><section className="uf-library-account">
    <h1>{account.status === "loading" ? "Opening your library…" : account.status === "error" ? "Your account couldn’t be checked" : "Keep your courses together"}</h1>
    {account.status === "error" ? <><p>Try again to open your saved courses.</p><Button onClick={() => void refreshAccount()}>Try again</Button></>
      : account.status === "ready" ? <><p>Sign in to return to courses you created or joined.</p><div><LinkButton href={routes.login(routes.library)}>Sign in</LinkButton><LinkButton variant="secondary" href={routes.signup(routes.library)}>Create account</LinkButton></div></> : null}
  </section></div></AppShell>;
  return <AccountLibrary key={account.session.identity.id} actorId={account.session.identity.id} services={services} />;
}

function AccountLibrary({ actorId, services }: { actorId: string; services: CatalogPort }) {
  const router = useRouter(), params = useSearchParams();
  const { q = "", contentLanguage = "" } = readCourseQuery(params);
  const view = readLibraryView(params);
  const controller = useMemo(() => new LibraryController(services, actorId), [services, actorId]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);

  useEffect(() => {
    void controller.search({ view, ...(q ? { q } : {}), ...(contentLanguage ? { contentLanguage } : {}) });
    return controller.dispose;
  }, [controller, q, contentLanguage, view]);
  useEffect(() => {
    const refresh = () => { if (document.visibilityState === "visible") void controller.refresh(); };
    window.addEventListener("focus", refresh); window.addEventListener("pageshow", refresh); document.addEventListener("visibilitychange", refresh);
    return () => { window.removeEventListener("focus", refresh); window.removeEventListener("pageshow", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, [controller]);

  function changeFilters(query: string, language: string) {
    router.push(routes.library + updateCollectionQuery(params.toString(), { q: query, contentLanguage: language }), { scroll: false });
  }
  const showTools = state.items.length > 0 || (state.status === "ready" && Boolean(q || contentLanguage || view !== "all"));
  return <AppShell active="library"><div className="uf-collection uf-library">
    <header className="uf-collection__heading"><h1>Your library</h1><LinkButton href={routes.create()}>New course</LinkButton></header>
    {showTools && <div className="uf-library-tools">
      <div className="uf-library-tools__views"><nav className="uf-library-views" aria-label="Library view">{views.map((item) => {
        const href = routes.library + updateCollectionQuery(params.toString(), { view: item.id });
        return <a key={item.id} href={href} aria-current={view === item.id ? "page" : undefined} onClick={(event) => {
          if (event.button === 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) { event.preventDefault(); router.push(href, { scroll: false }); }
        }}>{item.label}</a>;
      })}</nav><Button variant="quiet" pending={state.refreshing} onClick={() => void controller.refresh()}><RefreshCw size={18} aria-hidden="true" />Refresh</Button></div>
      <CollectionFilters q={q} contentLanguage={contentLanguage} onChange={changeFilters} noun="library" />
    </div>}
    <LibraryCollection state={state} view={view} filtered={Boolean(q || contentLanguage)} onRetry={() => void controller.refresh()}
      onResetFilters={() => router.push(routes.library + resetLibraryFilters(params.toString()), { scroll: false })}
      onShowAll={() => router.push(routes.library + showAllLibraryCourses(params.toString()), { scroll: false })}
      onLoadMore={() => void controller.loadMore()} />
  </div></AppShell>;
}
