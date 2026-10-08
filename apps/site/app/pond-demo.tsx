"use client";

import { useState } from "react";
import { Pond } from "pond/react";

export function PondDemo() {
  const [fps, setFps] = useState(0);
  // Visit /?calm for still water, which shows the ripples on their own.
  const calm = typeof window !== "undefined" && new URLSearchParams(window.location.search).has("calm");

  return (
    <>
      <Pond
        className="absolute inset-0"
        options={calm ? { waves: 0 } : undefined}
        onReady={(pond) => {
          // A welcome splash so the first thing you see is the water moving.
          const { width, height } = pond.canvas.getBoundingClientRect();
          pond.ripple(width / 2, height / 2, { strength: 1.5 });
          const timer = setInterval(() => setFps(Math.round(pond.fps)), 1000);
          return () => clearInterval(timer);
        }}
        fallback={
          <p className="absolute inset-0 grid place-items-center text-zinc-400">
            Your browser can&apos;t show the pond (it needs WebGL2).
          </p>
        }
      />
      <span className="pointer-events-none absolute right-3 top-3 font-mono text-xs text-white/60">
        {fps} fps
      </span>
    </>
  );
}
