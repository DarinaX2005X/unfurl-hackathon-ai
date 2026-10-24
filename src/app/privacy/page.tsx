import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy in Unfurl",
  description: "Understand how Unfurl stores course request drafts and sample activity in your browser, and how to remove local work.",
};

export { PrivacyPage as default } from "@/features/landing/info";
