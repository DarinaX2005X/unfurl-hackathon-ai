import { Suspense } from "react";
import { CatalogPage } from "@/features/catalog/CatalogPage";
export const metadata = { title: "Explore courses | Unfurl" };
export default function ExploreRoute() { return <Suspense><CatalogPage /></Suspense>; }
