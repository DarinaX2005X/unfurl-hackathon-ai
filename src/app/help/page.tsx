import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Help with Unfurl",
  description: "Get help writing course requests, saving local drafts, trying a practice activity, and recovering from storage problems.",
};

export { HelpPage as default } from "@/features/landing/info";
