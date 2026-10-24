import { LinkButton } from "@/components/ui";
import { routes } from "@/lib/routes";
import { InfoLayout } from "./InfoLayout";

export function AboutPage() {
  return <InfoLayout>
    <div className="uf-about-opening">
      <header className="uf-info__intro"><h1>Courses around what you want to learn</h1><p className="uf-info__lead">Describe your goal and starting point. Work with an AI agent to develop a researched program, then learn through practice.</p></header>
      <figure className="uf-about-request"><p>I want to understand artificial intelligence, from the fundamentals to training a model and building an AI system.</p><figcaption>An example of where a course could begin</figcaption></figure>
    </div>
    <section className="uf-about-principles" aria-labelledby="course-principles">
      <h2 id="course-principles">How learning works</h2>
      <dl>
        <div><dt>Review the program</dt><dd>Discuss what you want to understand and be able to do. Review the proposed topics, prerequisites, and learning outcomes before the agent creates the lessons.</dd></div>
        <div><dt>Learn by doing</dt><dd>Change a model, connect a process, compare examples, or explain a decision. See the effect of your choices and use feedback to revise your answer.</dd></div>
        <div><dt>Revise and create courses</dt><dd>Use the same conversation to revise a course or start another. Each course has its own program and appears separately in your library.</dd></div>
        <div><dt>Get support where you need it</dt><dd>Learners share the course’s core outcomes. Explanations and practice can respond to individual difficulties while preserving the subject’s depth.</dd></div>
      </dl>
    </section>
    <section className="uf-about-start" aria-labelledby="begin-here"><div><h2 id="begin-here">Choose a subject</h2><p>Describe what you want to learn, or try an activity about how models fit data.</p></div><div className="uf-info__actions"><LinkButton href={routes.chat()}>Create a course</LinkButton><LinkButton href={routes.try} variant="secondary">Try an activity</LinkButton></div></section>
  </InfoLayout>;
}
