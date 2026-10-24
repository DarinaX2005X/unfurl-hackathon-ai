"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { RefreshCw } from "lucide-react";
import type { ApplicationPort } from "@/application/ports";
import { localApplication } from "@/application/local-adapter";
import { AppShell } from "@/components/shell";
import { Button, LinkButton } from "@/components/ui";
import { routes } from "@/lib/routes";
import { CollectionFilters } from "@/features/catalog/CollectionFilters";
import { readCourseQuery, readLibraryView, updateCollectionQuery, type LibraryView } from "@/features/catalog/query";
import { LibraryController } from "./library-controller";
import { LibraryCollection } from "./LibraryCollection";
import "@/features/catalog/catalog.css";
import "./library.css";

const views: { id: LibraryView; label: string }[] = [{ id: "all", label: "All courses" }, { id: "in_progress", label: "In progress" }, { id: "courses", label: "Created by you" }];

export function LibraryPage({ services = localApplication }: { services?: ApplicationPort }) {
  const router = useRouter(), params = useSearchParams();
  const { q = "", contentLanguage = "" } = readCourseQuery(params);
  const view = readLibraryView(params);
  const controller = useMemo(() => new LibraryController(services), [services]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);

  useEffect(() => {
    void controller.refresh();
    const refresh = () => { if (document.visibilityState === "visible") void controller.refresh(); };
    window.addEventListener("focus", refresh);
    window.addEventListener("pageshow", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      controller.dispose();
      window.removeEventListener("focus", refresh);
      window.removeEventListener("pageshow", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
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
    <LibraryCollection state={state} query={{ ...(q ? { q } : {}), ...(contentLanguage ? { contentLanguage } : {}) }} view={view} onRetry={() => void controller.refresh()} onReset={() => changeFilters("", "")} />
  </div></AppShell>;
}
