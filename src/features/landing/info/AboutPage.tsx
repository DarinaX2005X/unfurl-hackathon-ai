import { LinkButton } from "@/components/ui";
import { routes } from "@/lib/routes";
import { InfoLayout } from "./InfoLayout";

export function AboutPage() {
  return (
    <InfoLayout>
      <div className="uf-about-opening">
        <header className="uf-info__intro">
          <h1>Curiosity deserves a course</h1>
          <p className="uf-info__lead">
            The idea behind Unfurl is a course you shape with an agent, then explore through practice.
            A subject can begin with a small question and grow into something you understand well enough to use.
          </p>
        </header>
        <figure className="uf-about-request">
          <p>
            I want to understand artificial intelligence, from the fundamentals to training a model and building an AI system.
          </p>
          <figcaption>An example of where a course could begin</figcaption>
        </figure>
      </div>

      <section className="uf-about-principles" aria-labelledby="course-principles">
        <h2 id="course-principles">Room for depth, room for you</h2>
        <dl>
          <div>
            <dt>A clear destination</dt>
            <dd>
              Start with what you want to be able to do. Your existing knowledge, the questions you care about,
              and the time you can give it all help define a worthwhile course. The intended journey includes
              researching the subject and agreeing on a curriculum before creating its lessons.
            </dd>
          </div>
          <div>
            <dt>Understanding through practice</dt>
            <dd>
              Different ideas call for different kinds of work. Change a model, arrange a process, compare examples,
              or explain a decision. A useful activity lets you see what your choice changes and gives you a reason
              to try again.
            </dd>
          </div>
          <div>
            <dt>A shared foundation</dt>
            <dd>
              A personal route can keep the depth of a shared course. The goal is to adapt the support and order
              around each learner while preserving the important ideas. A difficult answer can call for a helpful
              explanation without sending you away from the subject you came to learn.
            </dd>
          </div>
        </dl>
      </section>

      <section className="uf-about-start" aria-labelledby="begin-here">
        <div>
          <h2 id="begin-here">Give your next question a place to start</h2>
          <p>
            You can write a course request and save it on this device, or explore a working practice activity
            about model fitting. Course generation and cloud libraries are currently unavailable.
            Saved requests remain separate from finished courses.
          </p>
        </div>
        <div className="uf-info__actions">
          <LinkButton href={routes.create()}>Create a course</LinkButton>
          <LinkButton href={routes.try} variant="secondary">Try an activity</LinkButton>
        </div>
      </section>
    </InfoLayout>
  );
}
