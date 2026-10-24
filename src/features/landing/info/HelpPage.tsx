import Link from "next/link";
import { LinkButton } from "@/components/ui";
import { routes } from "@/lib/routes";
import { InfoLayout } from "./InfoLayout";

const topics = [
  { id: "course-request", label: "Write a course request" },
  { id: "saved-drafts", label: "Find and manage drafts" },
  { id: "practice", label: "Try a practice activity" },
  { id: "generation", label: "When generation is unavailable" },
  { id: "storage", label: "If work is missing or will not save" },
] as const;

export function HelpPage() {
  return (
    <InfoLayout>
      <header className="uf-info__intro uf-info__intro--reading">
        <h1>Help with Unfurl</h1>
        <p className="uf-info__lead">
          Prepare a course request, find your saved work, or get to know the practice experience.
          These guides explain what happens to your work along the way.
        </p>
      </header>

      <div className="uf-info-document">
        <nav className="uf-info-topics" aria-label="Help topics">
          {topics.map((topic) => <a key={topic.id} href={`#${topic.id}`}>{topic.label}</a>)}
        </nav>
        <div className="uf-info-document__body">
          <section id="course-request" className="uf-info-section" aria-labelledby="request-title">
            <h2 id="request-title">Write a course request</h2>
            <p>
              Open Create a course and describe what you want to learn in your own words.
              Include what you already know and something you would like to be able to do by the end.
              You can also set the language of the course separately from the English interface.
            </p>
            <p>
              For example: “I know basic Python. I want to understand how models learn and train a small model
              myself. I can study for three hours a week.”
            </p>
            <p>
              Course generation is currently unavailable. You can still prepare your request and use Save draft
              to keep it on this device. Wait for the save confirmation before leaving the page.
            </p>
            <LinkButton href={routes.create()}>Create a course</LinkButton>
          </section>

          <section id="saved-drafts" className="uf-info-section" aria-labelledby="drafts-title">
            <h2 id="drafts-title">Find and manage drafts</h2>
            <ol className="uf-info-steps">
              <li>Open My library in the same browser and browser profile you used to save the request.</li>
              <li>Find your local draft and open it to continue editing. A descriptive title can make it easier to find again.</li>
              <li>Before leaving an edited request, check its save status so you know which changes are stored.</li>
            </ol>
            <p>
              The library lets you rename or delete a local draft. Deletion applies to that draft and asks for confirmation.
              It does not delete your other saved requests. Local drafts are stored on this device and are not synced to a cloud account.
            </p>
            <Link href={routes.library} className="uf-info-link">Open my library</Link>
          </section>

          <section id="practice" className="uf-info-section" aria-labelledby="practice-title">
            <h2 id="practice-title">Try a practice activity</h2>
            <p>
              The sample explores how a model fits data. Make a prediction, adjust the model’s complexity or
              regularization, and compare its training and validation errors. Check your answer to see feedback
              about the choices you made.
            </p>
            <p>
              Your sample activity is kept separately in this browser so you can return to it.
              Reset starts the activity again and clears its attempts and hints. It leaves your course drafts alone.
              The sample does not create a course in your library or award account XP.
            </p>
            <LinkButton href={routes.try} variant="secondary">Try an activity</LinkButton>
          </section>

          <section id="generation" className="uf-info-section" aria-labelledby="generation-title">
            <h2 id="generation-title">When generation is unavailable</h2>
            <p>
              An unavailable message means course creation has not started.
              Your text stays in the composer so you can edit it, save it as a local draft, or retry.
              Retrying uses the current request; a saved draft is not automatically sent.
            </p>
            <p>
              Saving a request does not create lessons or publish a course. You can visit
              {" "}<Link href={routes.explore} className="uf-info-link uf-info-link--inline">Explore courses</Link>{" "}
              to see the current catalog, or use the separate practice activity while generation is unavailable.
            </p>
          </section>

          <section id="storage" className="uf-info-section" aria-labelledby="storage-title">
            <h2 id="storage-title">If work is missing or will not save</h2>
            <p>
              First check that you are using the same site address, browser, and browser profile.
              A different device or a private browsing session has separate storage. Clearing this site’s
              browser data can remove drafts and sample activity.
            </p>
            <p>
              If a save fails, keep the page open and copy important text before trying again. The browser may
              have run out of storage, blocked access, or be waiting for another Unfurl tab to close.
              A failed save is not a saved copy.
            </p>
            <p>
              If a draft cannot be read, avoid clearing all site data as a first step: that can also remove other
              drafts. There is currently no cloud copy from which deleted or missing local work can be restored.
            </p>
            <Link href={routes.privacy} className="uf-info-link">Read about local storage and deletion</Link>
          </section>
        </div>
      </div>
    </InfoLayout>
  );
}
