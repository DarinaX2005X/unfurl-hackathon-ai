"use client";

import { useEffect, useState } from "react";
import { landingCopy } from "./copy";
import { useMotionVisibility } from "./useMotionVisibility";

export function RotatingHeading() {
  const { ref, active, reducedMotion } = useMotionVisibility<HTMLHeadingElement>();
  const [index, setIndex] = useState(0);
  const [changing, setChanging] = useState(false);

  useEffect(() => {
    if (!active) return;
    const timer = window.setTimeout(() => {
      if (changing) {
        setIndex((current) => (current + 1) % landingCopy.topics.length);
        setChanging(false);
      } else setChanging(true);
    }, changing ? 450 : 2200);
    return () => window.clearTimeout(timer);
  }, [active, changing]);

  const current = reducedMotion ? "everything" : landingCopy.topics[index];
  const next = landingCopy.topics[(index + 1) % landingCopy.topics.length];

  return <h1 ref={ref} className="landing-heading">
    <span className="uf-sr-only">Learn everything</span>
    <span aria-hidden="true" className="landing-heading__fixed">Learn</span>
    <span aria-hidden="true" className="landing-topics" data-running={active}>
      <span className="landing-topics__window">
        <span className="landing-topics__track" data-changing={changing && !reducedMotion} key={index}>
          <span className="landing-topics__word">{current}</span>
          <span className="landing-topics__word">{next}</span>
        </span>
      </span>
    </span>
  </h1>;
}

