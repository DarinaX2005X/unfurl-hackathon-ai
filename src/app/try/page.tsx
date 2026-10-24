import type { Metadata } from "next";
import { PublicHeader } from "@/components/shell";
import { SamplePlayer } from "@/features/learning/player/SamplePlayer";

export const metadata: Metadata = { title: "Try a learning experiment | Unfurl", description: "Change a model, compare its errors, and discover why a perfect fit can be misleading." };

export default function TryPage() {
  return <><PublicHeader /><main id="main-content"><SamplePlayer /></main></>;
}
