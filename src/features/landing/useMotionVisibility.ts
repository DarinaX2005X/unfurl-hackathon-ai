"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";

const motionQuery = "(prefers-reduced-motion: reduce)";
function subscribeToMotion(onChange: () => void) {
  const query = window.matchMedia(motionQuery);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}
function prefersReducedMotion() { return window.matchMedia(motionQuery).matches; }
function subscribeToPageVisibility(onChange: () => void) {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}
function isPageVisible() { return document.visibilityState === "visible"; }

export function useMotionVisibility<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [visible, setVisible] = useState(false);
  const [started, setStarted] = useState(false);
  const reducedMotion = useSyncExternalStore(subscribeToMotion, prefersReducedMotion, () => true);
  const pageVisible = useSyncExternalStore(subscribeToPageVisibility, isPageVisible, () => true);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new IntersectionObserver(([entry]) => {
      const inView = entry?.isIntersecting ?? false;
      setVisible(inView);
      if (inView) setStarted(true);
    }, { threshold: 0.12 });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return { ref, active: visible && pageVisible && !reducedMotion, started, reducedMotion };
}

