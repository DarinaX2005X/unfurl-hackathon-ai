import type { Metadata } from "next";
import { CreatorWorkspace } from "@/features/creator/CreatorWorkspace";

export const metadata: Metadata = { title: "Chat | Unfurl", description: "Explore a question and shape what you want to learn." };

export default async function ChatPage({ searchParams }: { searchParams: Promise<{ conversation?: string | string[] }> }) {
  const query = await searchParams;
  const conversationId = Array.isArray(query.conversation) ? "invalid" : query.conversation ?? null;
  return <CreatorWorkspace key={conversationId ?? "new"} conversationId={conversationId} />;
}
