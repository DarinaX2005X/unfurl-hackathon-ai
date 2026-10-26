"use client";

import { useEffect, useState } from "react";
import { ArrowUp, Check } from "lucide-react";
import { LinkButton } from "@/components/ui";
import { routes } from "@/lib/routes";
import { BookScene } from "./BookScene";
import { DemoVideo } from "./DemoVideo";
import { heroExamples } from "./examples";
import { useMotionVisibility } from "./useMotionVisibility";

type Phase = "typing" | "research" | "program";

/** Timeline of one example, in milliseconds from the topic change. */
const TYPE_START = 520;
const TYPE_STEP = 26;
const HOLD_AFTER_PROGRAM = 3200;

export function HeroDemo() {
  const { ref, active, reducedMotion } = useMotionVisibility<HTMLElement>();
  const [index, setIndex] = useState(0);
  const [changing, setChanging] = useState(false);
  const [typed, setTyped] = useState(0);
  const [phase, setPhase] = useState<Phase>("typing");

  const example = heroExamples[index] ?? heroExamples[0]!;
  const next = heroExamples[(index + 1) % heroExamples.length]!;
  const still = reducedMotion;

  useEffect(() => {
    if (!active) return;
    const timers: number[] = [];
    const at = (ms: number, fn: () => void) => timers.push(window.setTimeout(fn, ms));
    const typeEnd = TYPE_START + example.goal.length * TYPE_STEP;
    at(0, () => { setTyped(0); setPhase("typing"); });
    at(TYPE_START, () => {
      const started = performance.now();
      const tick = () => {
        const count = Math.min(example.goal.length, Math.floor((performance.now() - started) / TYPE_STEP));
        setTyped(count);
        if (count < example.goal.length) timers.push(window.setTimeout(tick, TYPE_STEP));
      };
      tick();
    });
    at(typeEnd + 320, () => setPhase("research"));
    at(typeEnd + 1300, () => setPhase("program"));
    at(typeEnd + 1300 + HOLD_AFTER_PROGRAM, () => setChanging(true));
    at(typeEnd + 1300 + HOLD_AFTER_PROGRAM + 450, () => {
      setIndex((current) => (current + 1) % heroExamples.length);
      setChanging(false);
      setTyped(0);
      setPhase("typing");
    });
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [active, index, example.goal.length]);

  const shownPhase: Phase = still ? "program" : phase;
  const shownGoal = still ? example.goal : example.goal.slice(0, typed);
  const sent = shownPhase !== "typing";
  const ready = shownPhase === "program";

  return <section ref={ref} className="landing-hero2" aria-labelledby="hero-title">
    <h1 id="hero-title" className="landing-heading landing-hero2__title">
      <span className="uf-sr-only">Learn everything</span>
      <span aria-hidden="true" className="landing-heading__fixed">Learn</span>
      <span aria-hidden="true" className="landing-topics" data-running={active}>
        <span className="landing-topics__window">
          <span className="landing-topics__track" data-changing={changing && !still} key={index}>
            <span className="landing-topics__word">{example.topic}</span>
            <span className="landing-topics__word">{next.topic}</span>
          </span>
        </span>
      </span>
    </h1>

    <div className="landing-hero2__left">
      <p className="landing-hero2__lead">Describe what you want to understand. Unfurl researches the subject, drafts a program for you to approve, then builds the lessons and practice.</p>
      <div className="landing-hero__actions landing-hero2__actions"><LinkButton href={routes.chat()}>Create a course</LinkButton><DemoVideo /></div>
      <div className="landing-hero2__book"><BookScene /></div>
    </div>

    <div className="landing-stage" data-phase={shownPhase} data-changing={changing && !still} aria-hidden="true">
      <div className="landing-stage__composer">
        <p className="landing-stage__goal">{shownGoal}{!sent && !still && <span className="landing-stage__caret" />}</p>
        <span className="landing-stage__send" data-sent={sent}><ArrowUp size={22} strokeWidth={2.4} /></span>
        <div className="landing-stage__status">
          {shownPhase === "research"
            ? <><span className="landing-stage__dots"><i /><i /><i /></span>Reading sources</>
            : shownPhase === "program"
              ? <><Check size={18} strokeWidth={2.6} />Sources read, program drafted</>
              : <span className="landing-stage__hint">Your goal, in your own words</span>}
        </div>
      </div>

      <svg className="landing-stage__thread" viewBox="0 0 60 64" aria-hidden="true"><path d="M8 0c0 30 44 26 44 64" /></svg>

      <div className="landing-stage__program" data-ready={ready}>
        <div className="landing-stage__program-top"><span>Course program</span><span className="landing-stage__waiting">Ready for your review</span></div>
        <div className="landing-stage__program-body" key={`program-${index}`}>
          <p className="landing-stage__program-title"><span>{example.title}</span></p>
          <ol>
            {example.chapters.map((chapter, chapterIndex) => <li key={chapter} style={{ transitionDelay: ready ? `${160 + chapterIndex * 70}ms` : "0ms" }}>
              <span className="landing-stage__n">{String(chapterIndex + 1).padStart(2, "0")}</span><span className="landing-stage__chapter">{chapter}</span>
            </li>)}
          </ol>
        </div>
      </div>
    </div>
  </section>;
}
