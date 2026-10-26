import Link from "next/link";
import { LinkButton } from "@/components/ui";
import { routes } from "@/lib/routes";
import { InfoLayout } from "./InfoLayout";

const topics = [
  { id: "start", label: "Start a conversation" },
  { id: "history", label: "Return to your chats" },
  { id: "courses", label: "Find your courses" },
  { id: "featured", label: "Try the featured AI course" },
  { id: "delivery", label: "If a message is not sent" },
  { id: "storage", label: "If work will not save" },
] as const;

export function HelpPage() {
  return <InfoLayout>
    <header className="uf-info__intro uf-info__intro--reading"><h1>Help with Unfurl</h1><p className="uf-info__lead">Start a conversation, find your work, and begin learning in a published course.</p></header>
    <div className="uf-info-document">
      <nav className="uf-info-topics" aria-label="Help topics">{topics.map((topic) => <a key={topic.id} href={`#${topic.id}`}>{topic.label}</a>)}</nav>
      <div className="uf-info-document__body">
        <section id="start" className="uf-info-section" aria-labelledby="start-title"><h2 id="start-title">Start a conversation</h2><p>Open Create a course and describe what you want to learn. Include your starting point and something you would like to be able to do. A starter idea can help you begin; choosing one puts editable text in the composer without sending it.</p><p>For example: “I know basic Python. I want to understand how models learn and train a small model myself. I can study for three hours a week.”</p><p>Unfurl saves your composer to your account as you write. Send when you are ready to continue with the agent. Opening an empty chat does not create a history entry.</p><LinkButton href={routes.chat()}>Create a course</LinkButton></section>
        <section id="history" className="uf-info-section" aria-labelledby="history-title"><h2 id="history-title">Return to your chats</h2><p>Use Chats in the sidebar to reopen a conversation. Its messages and any text still in the composer are kept together in your account. You can rename a chat to make it easier to find, or delete a chat you no longer need.</p><p>Sign in to the same account when you return. If this browser contains a conversation from an earlier local-only version of Unfurl, you can choose to import it into your account.</p><p>Deleting a chat removes that conversation from your available history. Courses created through the chat are separate and are not deleted with it.</p><Link href={routes.chat()} className="uf-info-link">Open chats</Link></section>
        <section id="courses" className="uf-info-section" aria-labelledby="courses-title"><h2 id="courses-title">Find your courses</h2><p>My library holds courses you create and join. A conversation can contain several courses, each with its own title, program, and learning content. Switch between them within the conversation when you need to refine a particular course.</p><p>Writing or sending a message does not itself create a course. A course appears only when it has actually been created. A saved chat and a course in your library are different pieces of work.</p><Link href={routes.library} className="uf-info-link">Open my library</Link></section>
        <section id="featured" className="uf-info-section" aria-labelledby="featured-title"><h2 id="featured-title">Try the featured AI course</h2><p>Try opens a specific published course selected by Unfurl. If you are signed out, sign in or create an account and Unfurl will return you to that same course.</p><p>Starting the course adds it to your library and creates a private enrollment pinned to the version you opened. Your position, answers, feedback, and progress are saved with that enrollment. If the featured course is not available, you can still explore other published courses.</p><LinkButton href={routes.try} variant="secondary">Try the featured AI course</LinkButton></section>
        <section id="delivery" className="uf-info-section" aria-labelledby="delivery-title"><h2 id="delivery-title">If a message is not sent</h2><p>A message can be saved to your account without having reached the agent. Check the delivery status beside the message. If delivery fails or the service is unavailable, the message remains in the conversation.</p><p>Use Retry to send that same message again. To change what you want to say, use Edit and send the revised text. If the composer already contains another idea, keep or clear that text before editing a previous message.</p><p>An unavailable service does not produce an agent reply or a course. Your saved conversation remains available while you decide what to do next.</p></section>
        <section id="storage" className="uf-info-section" aria-labelledby="storage-title"><h2 id="storage-title">If work will not save</h2><p>Automatic saving can fail when the account service is unavailable or your session has changed. Keep the page open and copy text you need to retain before retrying. A save error means there is no confirmed account copy of the latest changes.</p><p>The current tab keeps a limited recovery copy of unsaved composer input when possible. It is not a backup and may disappear when the tab or browser session ends. Clearing this site’s data can also remove that temporary copy and any older local-only records, but it does not delete work already saved to your account.</p><p>If this browser holds a conversation from an earlier version, Unfurl lets you choose whether to import it. Importing creates an account-backed conversation while leaving the older browser record in place.</p><Link href={routes.privacy} className="uf-info-link">Read about saved work and deletion</Link></section>
      </div>
    </div>
  </InfoLayout>;
}
