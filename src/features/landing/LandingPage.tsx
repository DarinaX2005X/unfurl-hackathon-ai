import Link from "next/link";
import { PublicHeader } from "@/components/shell";
import { LinkButton } from "@/components/ui";
import { routes } from "@/lib/routes";
import { HeroDemo } from "./HeroDemo";
import { HowItWorks } from "./HowItWorks";
import { PracticePreview } from "./PracticePreview";
import { SiteFooter } from "./info";
import "./landing.css";
import "./landing-v2.css";

const families = [
  "Recall reconstruction", "Confusable discrimination", "Rule induction", "Procedure reconstruction", "State tracing", "Outcome prediction",
  "Cause diagnosis", "Self-explanation", "Experimental investigation", "Causal intervention", "Source investigation", "Relational mapping",
  "Analogy transfer", "Representation translation", "Estimation", "Example construction", "Counterexample construction", "Plan construction",
  "Artifact construction", "Diagnosis and repair", "Adversarial testing", "Constrained optimization", "Argument and rebuttal", "Critique and revision",
  "Misconception tutoring", "Information gap", "Role simulation", "Audience mediation", "Strategy selection",
] as const;

export function LandingPage() {
  return <div className="landing-page">
    <PublicHeader />
    <main id="main-content">
      <HeroDemo />
      <HowItWorks />
      <section className="landing-practice" aria-labelledby="practice-title">
        <div className="landing-practice__inner landing-section">
          <div className="landing-practice__heading"><h2 id="practice-title">Learn through experiments<br />and explanations</h2><p>Adjust a model, connect the parts of a process, and explain the choices you make.</p></div>
          <PracticePreview />
          <div className="landing-families">
            <h3>{families.length} kinds of practice, chosen for what the subject needs</h3>
            <ul>{families.map((family) => <li key={family} data-live={family === "Experimental investigation" || family === "Relational mapping" || family === "Self-explanation"}>{family}</li>)}</ul>
          </div>
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
