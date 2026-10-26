import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy in Unfurl",
  description: "Understand how Unfurl stores account work, uses temporary browser recovery, and handles deletion.",
};

export { PrivacyPage as default } from "@/features/landing/info";
