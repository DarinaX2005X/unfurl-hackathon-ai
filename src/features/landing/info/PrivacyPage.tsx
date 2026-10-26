import Link from "next/link";
import { LinkButton } from "@/components/ui";
import { routes } from "@/lib/routes";
import { InfoLayout } from "./InfoLayout";

export function PrivacyPage() {
  return <InfoLayout>
    <header className="uf-info__intro uf-info__intro--reading"><h1>Your work and your privacy</h1><p className="uf-info__lead">Unfurl saves conversations, courses, and learning progress to your account. This page explains those records, temporary browser recovery, message delivery, and deletion.</p></header>
    <div className="uf-privacy-document">
      <section className="uf-info-section" aria-labelledby="stored-work"><h2 id="stored-work">What is saved to your account</h2>
        <dl className="uf-privacy-records">
          <div><dt>Conversations and messages</dt><dd><p>In a new chat, your unfinished message stays on this device until you choose Send. That first Send creates a conversation in your account. Once a conversation exists, Unfurl automatically saves unfinished input to your account as you type. The record includes its title, messages, pending user input, delivery state, timestamps, and identifiers used to keep updates in order. An empty visit does not create a conversation.</p><p>Course references connect a conversation to the courses created through it. A message may also include a browser language hint when it is sent. The app interface stays in English; course content can have its own language.</p></dd></div>
          <div><dt>Courses and learning</dt><dd><p>Courses you create or join appear in your library. Starting a published course creates a private enrollment for the exact course version you opened.</p><p>Your place in the course, submitted answers, feedback, support choices, and progress are saved with that enrollment so you can continue later.</p></dd></div>
        </dl>
      </section>
      <section className="uf-info-section" aria-labelledby="browser-records"><h2 id="browser-records">Temporary records on this device</h2>
        <dl className="uf-privacy-records">
          <div><dt>Composer recovery</dt><dd><p>While a save or send is pending, Unfurl keeps a limited copy of your input and retry identifiers in this tab’s session storage when possible. The matching copy is cleared after the latest changes are confirmed by the account service.</p><p>If session storage is unavailable, recovery can only remain in memory while the app is open. Closing the tab normally ends its session storage, though browser session restore may bring it back. A temporary copy does not mean an account save succeeded.</p></dd></div>
          <div><dt>Chats from an earlier version</dt><dd><p>An earlier local-only version of Unfurl may have left chats in this browser’s IndexedDB storage. You decide whether to import one. Importing saves its user messages and unfinished input as unsent account content; it does not send anything to the agent.</p><p>The complete browser original remains in place after import, including material that is not brought into the account copy.</p></dd></div>
        </dl>
      </section>
      <section className="uf-info-section" aria-labelledby="removing-work"><h2 id="removing-work">Removing saved work</h2><p>Delete a chat from chat history to remove it from your available account history. Unfurl clears the matching tab-recovery copy when possible. If the chat came from a legacy import, the same browser source cannot recreate that deleted account copy.</p><p>Deleting a chat does not delete courses created through it. It also does not erase an older browser original. Clearing this site’s browser data removes temporary recovery and legacy local records, but it does not delete conversations, courses, enrollments, or progress already saved to your account.</p><LinkButton href={routes.chat()} variant="secondary">Open chat history</LinkButton></section>
      <section className="uf-info-section" aria-labelledby="message-delivery"><h2 id="message-delivery">Saving a chat and sending a message</h2><p>Choosing Send saves a new conversation to your account if needed, then submits the message text and the conversation, message, and request identifiers to the application’s chat service, along with a language hint when available.</p><p>A saved composer does not mean the agent accepted a message. Each message has its own delivery status. If delivery fails or the service is unavailable, the saved intent remains in the conversation and can be retried. No agent reply or created course is shown without a corresponding service response.</p></section>
      <section className="uf-info-section" aria-labelledby="storage-limits"><h2 id="storage-limits">Recovery has limits</h2><p>Temporary browser recovery is not a backup. Closing a tab, clearing site data, using private browsing, or the browser removing stored data can make an unconfirmed copy unavailable.</p><p>Account saving can also fail when the service is unavailable or your session changes. Check the saving status and keep a separate copy of text you need to retain until the account save is confirmed.</p><Link href={`${routes.help}#storage`} className="uf-info-link">Get help with saved work</Link></section>
    </div>
  </InfoLayout>;
}
