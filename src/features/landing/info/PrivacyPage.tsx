import Link from "next/link";
import { LinkButton } from "@/components/ui";
import { routes } from "@/lib/routes";
import { InfoLayout } from "./InfoLayout";

export function PrivacyPage() {
  return (
    <InfoLayout>
      <header className="uf-info__intro uf-info__intro--reading">
        <h1>Your work and your privacy</h1>
        <p className="uf-info__lead">
          The saved work currently available in Unfurl lives in your browser.
          Here is what the app stores, why it stores it, and how you can remove it.
        </p>
      </header>

      <div className="uf-privacy-document">
        <section className="uf-info-section" aria-labelledby="stored-work">
          <h2 id="stored-work">What is saved on this device</h2>
          <dl className="uf-privacy-records">
            <div>
              <dt>Unsaved course requests</dt>
              <dd>
                <p>
                  While you edit a request, its text and course language are kept in this tab’s session storage
                  so they can be recovered after a reload or a visit to another Unfurl page. Edits to an existing
                  draft also keep the draft’s saved update time to check that the recovered text belongs to that version.
                </p>
                <p>
                  This temporary recovery copy does not create a record in your library or mean that your draft
                  has been saved. If session storage is unavailable, the app can only keep this recovery copy in memory
                  while the page remains open. Use Save draft and check its confirmation to keep the request for a later visit.
                </p>
              </dd>
            </div>
            <div>
              <dt>Course request drafts</dt>
              <dd>
                <p>
                  Saving a draft stores its title, request text, course language, update time, and record identifiers
                  in IndexedDB, a storage area provided by your browser. These details let the library find the
                  request and reopen it for editing.
                </p>
                <p>
                  The draft belongs to this site in this browser profile. It is not a finished course, a public
                  catalog entry, or a copy synced to another device.
                </p>
              </dd>
            </div>
            <div>
              <dt>Practice activity</dt>
              <dd>
                <p>
                  Once you interact with the sample, its responses, submitted attempts and feedback, hints used,
                  and session details are saved separately in this browser’s local storage. This lets the activity resume when you return.
                </p>
                <p>
                  The sample has its own saved state. It does not create a course in your library or add account XP.
                </p>
              </dd>
            </div>
          </dl>
        </section>

        <section className="uf-info-section" aria-labelledby="removing-work">
          <h2 id="removing-work">Removing saved work</h2>
          <p>
            To remove one course request, open My library and delete that draft. Confirming deletion removes the
            selected record from this browser’s draft storage. Other drafts remain in place.
          </p>
          <p>
            The temporary request recovery copy belongs to the current tab session. Saving the current changes
            clears the matching recovery copy when the browser allows it. Closing the tab normally ends its session
            storage, though a browser’s session restore may bring it back. It is separate from the saved draft in your library.
          </p>
          <p>
            To start the practice activity again, use Reset in the sample. Reset clears the saved sample attempt
            and hints while leaving course drafts intact.
          </p>
          <p>
            If the browser cannot remove a saved record, the app reports that failure. A sample can reset on the
            open page while its previous saved copy remains in browser storage, so check any message shown after resetting.
          </p>
          <p>
            You can also clear this site’s data in your browser settings. That is a broader action: it can remove
            local drafts, temporary request recovery copies, and sample progress for this site. It does not remove copies of text you have saved elsewhere.
          </p>
          <LinkButton href={routes.library} variant="secondary">Manage my drafts</LinkButton>
        </section>

        <section className="uf-info-section" aria-labelledby="storage-limits">
          <h2 id="storage-limits">Local storage has limits</h2>
          <p>
            Browser storage is not a backup. Clearing site data, using a different browser profile, or your browser
            removing stored data can make local work unavailable. Private browsing may discard its data when that session ends.
          </p>
          <p>
            Saving can also fail if storage is full or unavailable. Check the save confirmation, and keep a separate
            copy of text you need to retain. Unfurl cannot restore a deleted local draft from a cloud copy.
          </p>
        </section>

        <section className="uf-info-section" aria-labelledby="generation-data">
          <h2 id="generation-data">Course generation and cloud libraries</h2>
          <p>
            Course generation, cloud accounts, and cloud saving are currently unavailable. An unavailable
            message means course creation has not started. Your request remains available
            in the composer, where you can save it locally or retry.
          </p>
          <p>
            Saving a local draft does not publish it or make it visible to other learners in the catalog.
            Your local requests remain separate from finished courses.
          </p>
          <Link href={`${routes.help}#storage`} className="uf-info-link">Get help with saved work</Link>
        </section>
      </div>
    </InfoLayout>
  );
}
