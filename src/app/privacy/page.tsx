import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy in Unfurl",
  description: "Understand how Unfurl stores conversations and sample activity in your browser, and what deleting local work removes.",
};

export { PrivacyPage as default } from "@/features/landing/info";
