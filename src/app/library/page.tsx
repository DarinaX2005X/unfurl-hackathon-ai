import { Suspense } from "react";
import { LibraryPage } from "@/features/library/LibraryPage";
export const metadata = { title: "Your library | Unfurl" };
export default function LibraryRoute() { return <Suspense><LibraryPage /></Suspense>; }
