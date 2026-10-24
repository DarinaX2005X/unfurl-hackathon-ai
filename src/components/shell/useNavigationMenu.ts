"use client";

import { useCallback, useState, useSyncExternalStore } from "react";

const desktopQuery = "(min-width: 960px)";

function getDesktopSnapshot() {
  return window.matchMedia(desktopQuery).matches;
}

function getServerSnapshot() {
  return false;
}

export function useNavigationMenu() {
  const [open, setOpen] = useState(false);
  const subscribe = useCallback((onChange: () => void) => {
    const query = window.matchMedia(desktopQuery);
    const onBreakpointChange = () => {
      setOpen(false);
      onChange();
    };
    query.addEventListener("change", onBreakpointChange);
    return () => query.removeEventListener("change", onBreakpointChange);
  }, []);

  const desktop = useSyncExternalStore(subscribe, getDesktopSnapshot, getServerSnapshot);
  const close = useCallback(() => setOpen(false), []);

  return { open, setOpen, close, desktop };
}
