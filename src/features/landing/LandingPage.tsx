import Link from "next/link";
import { PublicHeader } from "@/components/shell";
import { LinkButton } from "@/components/ui";
import { routes } from "@/lib/routes";
import { BookScene } from "./BookScene";
import { RotatingHeading } from "./RotatingHeading";
import { SiteFooter } from "./info";
import "./landing.css";

export function LandingPage() {
  return <div className="landing-page">
    <PublicHeader />
    <main id="main-content">
      <section className="landing-hero" aria-label="Learning starts with curiosity">
        <div className="landing-hero__intro">
          <RotatingHeading />
          <p className="landing-hero__description">Create a course with an AI agent. Learn through experiments, challenges, and ideas you can put to work.</p>
          <div className="landing-hero__actions">
            <LinkButton href={routes.create()}>Create a course</LinkButton>
            <LinkButton href={routes.try} variant="secondary">Try an activity</LinkButton>
          </div>
        </div>
        <BookScene />
      </section>
      <section className="landing-beginning landing-section" aria-labelledby="beginning-title">
        <div className="landing-beginning__intro">
          <h2 id="beginning-title">A question is a<br className="landing-desktop-break" /> good beginning</h2>
          <p>You don’t need a perfect prompt or a ready-made syllabus. Start with what you want to understand, make, or do.</p>
          <Link href={routes.create()} className="landing-text-link">Write your course idea</Link>
        </div>
        <div className="landing-beginning__example">
          <p className="landing-beginning__idea">I want to understand how AI works, then build something useful with it.</p>
          <div className="landing-beginning__details">
            <div><span>Starting point</span><p>A little Python, a lot of curiosity</p></div>
            <div><span>Direction</span><p>From the foundations to working models and systems</p></div>
            <div><span>Your pace</span><p>Time to explore, practise, and come back</p></div>
          </div>
          <p className="landing-beginning__caption">One possible starting point. Your subject and goal can be entirely different.</p>
        </div>
      </section>
      <section className="landing-program landing-section" aria-labelledby="program-title">
        <div className="landing-program__heading">
          <h2 id="program-title">A program with<br /> a point of view</h2>
          <p>A course should make sense before you begin: a researched path, clear outcomes, and room to refine the plan together.</p>
        </div>
        <ol className="landing-program__steps">
          <li><span className="landing-program__number" aria-hidden="true">01</span><div><h3>Start with your goal</h3><p>Bring your interests, your starting knowledge, and the things you want to be able to do.</p></div></li>
          <li><span className="landing-program__number" aria-hidden="true">02</span><div><h3>See how it connects</h3><p>A strong program connects the foundations to deeper ideas, with a reason for each part.</p></div></li>
          <li><span className="landing-program__number" aria-hidden="true">03</span><div><h3>Make the plan yours</h3><p>Review the direction and the scope before the lessons and activities are created.</p></div></li>
        </ol>
      </section>
      <section className="landing-practice" aria-labelledby="practice-title">
        <div className="landing-practice__inner landing-section">
          <div className="landing-practice__illustration" aria-hidden="true">
            <svg viewBox="0 0 520 380" className="landing-practice__graph">
              <defs><linearGradient id="practice-sheet" x1="0" y1="0" x2="1" y2="1"><stop stopColor="#FFFEFA" /><stop offset="1" stopColor="#E7E0D0" /></linearGradient></defs>
              <ellipse cx="265" cy="331" rx="201" ry="24" fill="#4C3A2B" opacity=".09" />
              <path d="m70 52 357 24 22 244-361-18Z" fill="#C1B6A1" />
              <path d="m66 44 357 24 22 244-361-18Z" fill="url(#practice-sheet)" stroke="#D4CCBB" />
              <path d="M117 100v149h259" fill="none" stroke="#A9A28F" strokeWidth="2" />
              <path d="M122 227C157 226 150 106 203 130S277 258 310 171 355 102 378 109" fill="none" stroke="#BA432D" strokeWidth="5" strokeLinecap="round" />
              <g fill="#FFFEFA" stroke="#505C4E" strokeWidth="3"><circle cx="132" cy="211" r="7" /><circle cx="169" cy="164" r="7" /><circle cx="204" cy="137" r="7" /><circle cx="243" cy="191" r="7" /><circle cx="279" cy="214" r="7" /><circle cx="319" cy="156" r="7" /><circle cx="364" cy="115" r="7" /></g>
              <path d="m111 277 141 8" stroke="#C7BEAA" strokeWidth="3" strokeLinecap="round" />
              <path d="m374 250 47 3 5 40-48-3Z" fill="#C9684E" /><path d="m378 290 48 3 0 8-47-3Z" fill="#A74832" />
              <path d="m387 272 9 9 14-18" stroke="#FFFEFA" strokeWidth="3" fill="none" strokeLinecap="round" />
            </svg>
          </div>
          <div className="landing-practice__copy">
            <h2 id="practice-title">Understanding needs<br className="landing-desktop-break" /> something to do</h2>
            <p>Change something. Notice what happens. Explain why. Practice should help an idea make sense, not just ask whether you remember it.</p>
            <p className="landing-practice__sample">Try a working activity about fitting a model. Adjust its complexity, compare the errors, and decide what the result really tells you.</p>
            <LinkButton href={routes.try}>Try the learning activity</LinkButton>
          </div>
        </div>
      </section>
      <section className="landing-personal landing-section" aria-labelledby="personal-title">
        <div className="landing-personal__copy">
          <h2 id="personal-title">A shared course,<br /> a personal route</h2>
          <p>Learning alongside others shouldn’t mean moving in lockstep. The same course can give people a common foundation while leaving room for different questions, practice, and support.</p>
          <p className="landing-personal__future">Shared courses are unavailable right now. You can save a course idea or try a learning activity.</p>
          <Link href="/about" className="landing-text-link">More about Unfurl</Link>
        </div>
        <div className="landing-personal__route" role="img" aria-label="Two learning paths take different routes through the same ideas, then reconnect">
          <svg viewBox="0 0 540 350" aria-hidden="true">
            <path d="M63 181C129 181 129 81 219 81H308C377 81 377 181 466 181" fill="none" stroke="#C05B40" strokeWidth="4" strokeLinecap="round" />
            <path d="M63 181C159 181 129 275 240 275H308C386 275 381 181 466 181" fill="none" stroke="#7B8D75" strokeWidth="4" strokeLinecap="round" />
            <path d="M63 181H466" fill="none" stroke="#C5BDAC" strokeWidth="2" strokeDasharray="5 8" />
            <g fill="#FFFEFA" stroke="#C7BEAB" strokeWidth="2"><circle cx="63" cy="181" r="21" /><circle cx="466" cy="181" r="21" /></g>
            <g fill="#F5F3ED" stroke="#C05B40" strokeWidth="3"><circle cx="219" cy="81" r="13" /><circle cx="308" cy="81" r="13" /></g>
            <g fill="#F5F3ED" stroke="#7B8D75" strokeWidth="3"><circle cx="240" cy="275" r="13" /><circle cx="308" cy="275" r="13" /></g>
            <circle cx="63" cy="181" r="6" fill="#BA432D" /><circle cx="466" cy="181" r="6" fill="#BA432D" />
          </svg>
          <div className="landing-personal__route-labels"><span>A common foundation</span><span>Your understanding</span></div>
        </div>
      </section>
      <section className="landing-start landing-section" aria-labelledby="start-title">
        <div><h2 id="start-title">Where will your<br /> curiosity take you?</h2><p>Keep an idea for later, or learn something by doing it now.</p></div>
        <div className="landing-start__actions"><LinkButton href={routes.create()}>Create a course</LinkButton><Link href={routes.explore} className="landing-text-link">Explore courses</Link></div>
      </section>
    </main>
    <SiteFooter />
  </div>;
}
