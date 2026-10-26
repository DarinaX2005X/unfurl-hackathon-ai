import { Check } from "lucide-react";

const chapters = [
  { title: "Find your foundations", detail: "Connect the essential ideas in data, probability, and Python. Begin with what you know and give unfamiliar ideas time to settle.", topics: "Data, probability, Python" },
  { title: "Understand how models learn", detail: "Train a small model, investigate what it learns, and test how well that understanding travels to new examples.", topics: "Training, evaluation, generalization" },
  { title: "Build an AI system", detail: "Bring models, instructions, tools, and useful information together. Follow a request through the system and see where each decision belongs.", topics: "Models, tools, retrieval" },
  { title: "Make something of your own", detail: "Choose a problem you care about. Build a working project, explain its limitations, and decide what you would improve next.", topics: "A project and a reasoned explanation" },
] as const;

const steps = [
  { title: "Say what you want to understand", detail: "Write the goal in your own words, with what you already know and the language you want to study in." },
  { title: "Unfurl researches the subject", detail: "It searches for sources, reads them, and shows in the conversation what it read and why." },
  { title: "Review and approve the program", detail: "Change the outcomes, the order or the scope. Nothing is built until you approve a version." },
  { title: "Lessons and practice are built and checked", detail: "Each section gets reading material and activities, and every activity is validated before you start." },
] as const;

export function HowItWorks() {
  return <section className="landing-how landing-section" aria-labelledby="how-title">
    <div className="landing-how__intro">
      <h2 id="how-title">From a question to a course you approve</h2>
      <ol className="landing-steps">
        {steps.map((step, index) => <li key={step.title} className="landing-step">
          <span className="landing-step__n" aria-hidden="true">{index + 1}</span>
          <div><h3>{step.title}</h3><p>{step.detail}</p></div>
        </li>)}
      </ol>
    </div>
    <figure className="landing-syllabus landing-how__program" aria-label="An example course program you can explore">
      <div className="landing-syllabus__paper">
        <div className="landing-syllabus__heading"><h3>Understanding AI,<br />from idea to application</h3><span className="landing-syllabus__binding" aria-hidden="true" /></div>
        <div className="landing-syllabus__chapters">
          {chapters.map((chapter, index) => <details key={chapter.title} className="landing-chapter" name="example-program" open={index === 0}>
            <summary><span className="landing-chapter__number" aria-hidden="true">{String(index + 1).padStart(2, "0")}</span><span>{chapter.title}</span><span className="landing-chapter__toggle" aria-hidden="true" /></summary>
            <div className="landing-chapter__body"><p>{chapter.detail}</p><p className="landing-chapter__topics">{chapter.topics}</p></div>
          </details>)}
        </div>
        <div className="landing-how__approval" aria-hidden="true"><Check size={18} strokeWidth={2.6} />Version 1 approved, lessons in progress</div>
      </div>
    </figure>
  </section>;
}
