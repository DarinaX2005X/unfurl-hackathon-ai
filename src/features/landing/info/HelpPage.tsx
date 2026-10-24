import Link from "next/link";
import { LinkButton } from "@/components/ui";
import { routes } from "@/lib/routes";
import { InfoLayout } from "./InfoLayout";

const topics = [
  { id: "start", label: "Start a conversation" },
  { id: "history", label: "Return to your chats" },
  { id: "courses", label: "Find your courses" },
  { id: "practice", label: "Try a practice activity" },
  { id: "delivery", label: "If a message is not sent" },
  { id: "storage", label: "If work will not save" },
] as const;

export function HelpPage() {
  return <InfoLayout>
    <header className="uf-info__intro uf-info__intro--reading"><h1>Help with Unfurl</h1><p className="uf-info__lead">Start a conversation, find your work, and get to know the practice experience.</p></header>
    <div className="uf-info-document">
      <nav className="uf-info-topics" aria-label="Help topics">{topics.map((topic) => <a key={topic.id} href={`#${topic.id}`}>{topic.label}</a>)}</nav>
      <div className="uf-info-document__body">
        <section id="start" className="uf-info-section" aria-labelledby="start-title"><h2 id="start-title">Start a conversation</h2><p>Open Create a course and describe what you want to learn. Include your starting point and something you would like to be able to do. A starter idea can help you begin; choosing one puts editable text in the composer without sending it.</p><p>For example: “I know basic Python. I want to understand how models learn and train a small model myself. I can study for three hours a week.”</p><p>Your text is saved automatically on this device as you write. Send when you are ready to continue with the agent. Opening an empty chat does not create a history entry.</p><LinkButton href={routes.chat()}>Create a course</LinkButton></section>
        <section id="history" className="uf-info-section" aria-labelledby="history-title"><h2 id="history-title">Return to your chats</h2><p>Use Chats in the sidebar to reopen a conversation. Its messages and any text still in the composer are kept together. You can rename a chat to make it easier to find, or delete a chat you no longer need.</p><p>Chats are stored in the browser profile you used to write them. Use the same site address and profile when you return. They are not currently synced between devices.</p><p>Deleting a chat removes that conversation from local history. Courses created through the chat are separate and are not deleted with it.</p><Link href={routes.chat()} className="uf-info-link">Open chats</Link></section>
        <section id="courses" className="uf-info-section" aria-labelledby="courses-title"><h2 id="courses-title">Find your courses</h2><p>My library holds courses you create and join. A conversation can contain several courses, each with its own title, program, and learning content. Switch between them within the conversation when you need to refine a particular course.</p><p>Writing or sending a message does not itself create a course. A course appears only when it has actually been created. A saved chat and a course in your library are different pieces of work.</p><Link href={routes.library} className="uf-info-link">Open my library</Link></section>
        <section id="practice" className="uf-info-section" aria-labelledby="practice-title"><h2 id="practice-title">Try a practice activity</h2><p>The sample guides you through how a model fits data. Start with the shape of a model, adjust its settings, and compare what happens. You can then make a prediction and explain your choice.</p><p>The sample saves your activity separately in this browser. Reset starts it again and clears its attempts and hints. It leaves your chats and courses alone. The sample does not add a course to your library.</p><LinkButton href={routes.try} variant="secondary">Try an activity</LinkButton></section>
        <section id="delivery" className="uf-info-section" aria-labelledby="delivery-title"><h2 id="delivery-title">If a message is not sent</h2><p>A message can be saved on your device without having reached the agent. Check the delivery status beside the message. If delivery fails or the service is unavailable, the message remains in the conversation.</p><p>Use Retry to send that same message again. To change what you want to say, use Edit and send the revised text. If the composer already contains another idea, keep or clear that text before editing a previous message.</p><p>An unavailable service does not produce an agent reply or a course. Your conversation remains available while you decide what to do next.</p></section>
        <section id="storage" className="uf-info-section" aria-labelledby="storage-title"><h2 id="storage-title">If work will not save</h2><p>Automatic saving can fail if the browser blocks site storage or runs out of space. Keep the page open and copy text you need to retain before retrying. A save error means there is no confirmed saved copy of the latest changes.</p><p>If work is missing, check the site address, browser, and profile first. A private browsing session has separate storage. Clearing this site’s data can remove local chats and sample progress, and there is currently no cloud backup of those records.</p><p>If an older request was saved as a draft, Unfurl brings it into chat history. The original local record is retained during this transition. Read the privacy page for the exact deletion boundary.</p><Link href={routes.privacy} className="uf-info-link">Read about local storage and deletion</Link></section>
      </div>
    </div>
  </InfoLayout>;
}
