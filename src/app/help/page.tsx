import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Help with Unfurl",
  description: "Get help with conversations, courses, practice activities, message delivery, and local storage.",
};

export { HelpPage as default } from "@/features/landing/info";
