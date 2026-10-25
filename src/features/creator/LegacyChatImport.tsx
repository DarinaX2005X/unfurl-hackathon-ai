"use client";

import { useEffect, useRef, useState } from "react";
import { Button, Dialog, Notice } from "@/components/ui";
import type { ConversationPort } from "@/application/conversation-port";
import type { ChatStore, LocalConversation } from "@/domain/chat";
import { accountScope } from "@/features/account/account-scope";
import { localConversationImport } from "./legacy-import";

export function LegacyChatImport({ actorId, store, conversations, initialSourceId, onImported }: {
  actorId: string; store: ChatStore; conversations: ConversationPort; initialSourceId: string | null; onImported: (id: string) => void;
}) {
  const [open, setOpen] = useState(initialSourceId !== null);
  const [sources, setSources] = useState<LocalConversation[] | null>(null);
  const [selectedId, setSelectedId] = useState(initialSourceId);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keys = useRef(new Map<string, string>());
  useEffect(() => {
    if (!open) return;
    const request = accountScope.request(actorId);
    void store.list().then((items) => { if (request.isCurrent()) { setSources(items); setError(null); } }).catch(() => {
      if (request.isCurrent()) setError("Older chats couldn’t be opened. Their original data is still in this browser.");
    }).finally(request.release);
    return request.abort;
  }, [open, actorId, store]);

  async function importSelected() {
    const source = sources?.find((item) => item.id === selectedId);
    if (!source || pending) return;
    const request = accountScope.request(actorId);
    setPending(true); setError(null);
    try {
      let input;
      try { input = localConversationImport(source); }
      catch { setError("This chat exceeds the import limit of 100 user messages or 2 MB. Nothing was imported, and the complete original is still in this browser."); return; }
      let key = keys.current.get(source.id);
      if (!key) { key = crypto.randomUUID(); keys.current.set(source.id, key); }
      const result = await conversations.importLocal(input, key, request.signal);
      if (!request.isCurrent()) return;
      if (!result.ok) {
        setError(result.error.error.messageKey === "chat.importDeleted" ? "The account copy of this chat was deleted. Its browser original is still here."
          : result.error.error.messageKey === "chat.importChanged" ? "This browser copy changed after it was imported. The saved chat and this original have both been kept."
            : "The import wasn’t confirmed. Retry to check the same chat. The original is still here.");
        return;
      }
      if (result.data.sourceId !== source.id || result.data.conversation.conversation.ownerId !== actorId) throw new Error("Import acknowledgement did not match");
      onImported(result.data.conversation.conversation.id);
    } catch { if (request.isCurrent()) setError("The import wasn’t confirmed. Retry to check the same chat. The original is still here."); }
    finally { if (request.isCurrent()) setPending(false); request.release(); }
  }

  return <><Button className="creator-history__import" variant="quiet" size="compact" onClick={() => setOpen(true)}>Import a browser chat</Button>
    <Dialog open={open} onOpenChange={(value) => { if (!pending) setOpen(value); }} title="Bring a chat into your account"
      footer={<><Button variant="quiet" disabled={pending} onClick={() => setOpen(false)}>Cancel</Button><Button pending={pending} disabled={!sources?.some((item) => item.id === selectedId)} onClick={() => void importSelected()}>Import selected chat</Button></>}>
      <div className="creator-import"><p>Your messages and unfinished input will be saved as unsent messages. Nothing is sent to the agent. The complete browser copy, including earlier replies and courses, stays here.</p>
        {sources === null && !error && <p role="status">Looking for browser chats…</p>}
        {sources?.length === 0 && <p>No older chats were found in this browser.</p>}
        {sources && sources.length > 0 && <fieldset><legend>Choose a chat</legend>{sources.map((source) => <label key={source.id} className="creator-import__choice"><input type="radio" name="legacy-chat" value={source.id} checked={selectedId === source.id} onChange={() => setSelectedId(source.id)} disabled={pending} /><span><strong>{source.title}</strong><span>{source.messages.filter((item) => item.role === "user").length} user messages{source.composerText ? " and unfinished input" : ""}</span></span></label>)}</fieldset>}
        {initialSourceId && sources && !sources.some((item) => item.id === initialSourceId) && <Notice tone="info">The chat from this older link isn’t available in this browser. You can choose another chat.</Notice>}
        {error && <Notice tone="error">{error}</Notice>}
      </div>
    </Dialog>
  </>;
}
