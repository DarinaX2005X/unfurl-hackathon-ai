import Link from "next/link";
import { PublicHeader } from "@/components/shell";
import { LinkButton } from "@/components/ui";
import { routes } from "@/lib/routes";
import { BookScene } from "./BookScene";
import { RotatingHeading } from "./RotatingHeading";
import { PracticePreview } from "./PracticePreview";
import { DemoVideo } from "./DemoVideo";
import { SiteFooter } from "./info";
import "./landing.css";

const chapters = [
  { title: "Find your foundations", detail: "Connect the essential ideas in data, probability, and Python. Begin with what you know and give unfamiliar ideas time to settle.", topics: "Data, probability, Python" },
  { title: "Understand how models learn", detail: "Train a small model, investigate what it learns, and test how well that understanding travels to new examples.", topics: "Training, evaluation, generalization" },
  { title: "Build an AI system", detail: "Bring models, instructions, tools, and useful information together. Follow a request through the system and see where each decision belongs.", topics: "Models, tools, retrieval" },
  { title: "Make something of your own", detail: "Choose a problem you care about. Build a working project, explain its limitations, and decide what you would improve next.", topics: "A project and a reasoned explanation" },
] as const;

export function LandingPage() {
  return <div className="landing-page">
    <PublicHeader />
    <main id="main-content">
      <section className="landing-hero" aria-label="Learning starts with curiosity">
        <div className="landing-hero__intro">
          <RotatingHeading />
          <div className="landing-hero__actions"><LinkButton href={routes.chat()}>Create a course</LinkButton><DemoVideo /></div>
        </div>
        <BookScene />
      </section>
      <section className="landing-program landing-section" aria-labelledby="program-title">
        <div className="landing-program__intro">
          <h2 id="program-title">Learn what you’ve<br className="landing-desktop-break" /> always wanted to</h2>
          <p>Describe what you want to learn. The agent researches the subject and proposes a program for you to review before creating its lessons.</p>
          <Link href={routes.chat()} className="landing-text-link">Start with your idea</Link>
        </div>
        <figure className="landing-syllabus">
          <div className="landing-syllabus__paper">
            <div className="landing-syllabus__heading"><h3>Understanding AI,<br />from idea to application</h3><span className="landing-syllabus__binding" aria-hidden="true" /></div>
            <div className="landing-syllabus__chapters">
              {chapters.map((chapter, index) => <details key={chapter.title} className="landing-chapter" name="example-program" open={index === 0}>
                <summary><span className="landing-chapter__number" aria-hidden="true">{String(index + 1).padStart(2, "0")}</span><span>{chapter.title}</span><span className="landing-chapter__toggle" aria-hidden="true" /></summary>
                <div className="landing-chapter__body"><p>{chapter.detail}</p><p className="landing-chapter__topics">{chapter.topics}</p></div>
              </details>)}
            </div>
          </div>
          <figcaption>An example program. Open a chapter to explore its direction.</figcaption>
        </figure>
      </section>
      <section className="landing-practice" aria-labelledby="practice-title">
        <div className="landing-practice__inner landing-section">
          <div className="landing-practice__heading"><h2 id="practice-title">Learn through experiments<br />and explanations</h2><p>Adjust a model, connect the parts of a process, and explain the choices you make.</p></div>
          <PracticePreview />
          <div className="landing-practice__action"><LinkButton href={routes.try}>Try the featured AI course</LinkButton><p>Start a published course and keep your place in your library after signing in.</p></div>
        </div>
      </section>
      <section className="landing-workspace landing-section" aria-labelledby="workspace-title">
        <div className="landing-workspace__copy">
          <h2 id="workspace-title">One conversation<br />Several courses</h2>
          <p>Revise a course or create another in the same conversation. Each course has its own program; your library brings your courses and learning progress together.</p>
          <div className="landing-workspace__links"><Link href={routes.chat()} className="landing-text-link">Start a conversation</Link><Link href={routes.library} className="landing-text-link">Open your library</Link></div>
        </div>
        <figure className="landing-collection" aria-label="Illustration of a conversation unfolding into separate courses">
          <svg viewBox="0 0 570 390" aria-hidden="true">
            <defs><linearGradient id="collection-paper" x1="0" y1="0" x2="1" y2="1"><stop stopColor="#FFFEFA" /><stop offset="1" stopColor="#E4DCCC" /></linearGradient><linearGradient id="collection-red" x1="0" y1="0" x2="1" y2="1"><stop stopColor="#D88164" /><stop offset="1" stopColor="#AD4931" /></linearGradient><filter id="collection-shadow"><feGaussianBlur stdDeviation="9" /></filter></defs>
            <ellipse cx="289" cy="334" rx="226" ry="25" fill="#5F503B" opacity=".12" filter="url(#collection-shadow)" />
            <g className="landing-collection__conversation"><path d="m57 86 255-33 44 182-78 9-21 34-14-29-146 18Z" fill="#D4CCBA" /><path d="m53 78 255-33 44 182-78 9-21 34-14-29-146 18Z" fill="url(#collection-paper)" stroke="#BFB5A2" /><path d="m89 112 150-20m-143 48 175-23m-167 51 124-16" stroke="#A79D88" strokeWidth="7" strokeLinecap="round" /><path d="m112 209 76-10" stroke="#BE654C" strokeWidth="8" strokeLinecap="round" /></g>
            <g className="landing-collection__book landing-collection__book--back"><path d="m315 128 148-33 49 185-149 34-17-9-49-166Z" fill="#57664D" /><path d="m315 128 148-33 44 171-148 34Z" fill="#9CA58E" /><path d="m359 300 148-34 0 14-144 34Z" fill="#F0E9D8" /><path d="m365 305 135-31" stroke="#B8AE98" /><path d="m315 128 12-3 44 171-12 4Z" fill="#7E8B6D" /><path d="m348 164 81-18m-74 39 61-14" stroke="#F0EEDF" strokeWidth="5" strokeLinecap="round" /></g>
            <g className="landing-collection__book landing-collection__book--front"><path d="m184 208 154-23 60 139-152 28-16-8-62-124Z" fill="#8F3C29" /><path d="m184 208 154-23 60 139-152 25Z" fill="url(#collection-red)" /><path d="m246 349 152-25-1 15-146 24Z" fill="#F1E8D7" /><path d="m253 355 136-23" stroke="#B9AB92" /><path d="m184 208 13-2 62 141-13 2Z" fill="#AA4C35" /><path d="m220 242 84-13m-75 34 65-10" stroke="#F6E9D3" strokeWidth="5" strokeLinecap="round" /></g>
          </svg>
          <figcaption>One conversation can become more than one course.</figcaption>
        </figure>
      </section>
      <section className="landing-start landing-section" aria-labelledby="start-title">
        <h2 id="start-title">What have you<br />always wanted to learn</h2>
        <LinkButton href={routes.chat()}>Create a course</LinkButton>
      </section>
    </main>
    <SiteFooter />
  </div>;
}
