"use client";

import { useEffect, useRef, useState } from "react";
import { Play } from "lucide-react";
import { Button, Dialog } from "@/components/ui";

export function DemoVideo() {
  const [open, setOpen] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!open || !video) return;
    return () => { video.pause(); };
  }, [open]);

  return <div className="landing-demo">
    <Button variant="secondary" className="landing-demo__trigger" aria-haspopup="dialog" onClick={() => setOpen(true)}>
      <Play size={17} strokeWidth={1.8} aria-hidden="true" />Watch demo
    </Button>
    {open && <Dialog open={open} onOpenChange={setOpen} title="Watch Unfurl">
      <video ref={videoRef} className="landing-demo__video" controls autoPlay playsInline preload="metadata"
        poster="/media/unfurl-film-poster.jpg" aria-label="Unfurl product demonstration">
        <source src="/media/unfurl-film.mp4" type="video/mp4" />
        Your browser cannot play this video. <a href="/media/unfurl-film.mp4">Open the demo video</a>.
      </video>
    </Dialog>}
  </div>;
}
