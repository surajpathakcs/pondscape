"use client";

import { useState } from "react";
import type { PondOptions } from "pond";
import { Pond } from "pond/react";
import { giftFish } from "./gift";

/** The pond's usual six (what the default seed gives), so adding hers keeps them as they are. */
const usualFish = ["sanke", "ogon", "karasu", "tancho", "showa", "platinum"] as const;

export function PondDemo() {
  const [fps, setFps] = useState(0);
  // Try /?calm for still water, or counts like /?fish=0&axolotls=5&lilies=0.
  const params = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
  const count = (name: string) => (params?.has(name) ? Number(params.get(name)) : undefined);
  const options: PondOptions = {
    waves: params?.has("calm") ? 0 : undefined,
    // /?gift adds her three fish to the usual six.
    fish: params?.has("gift") ? [...usualFish.map((variety) => ({ variety })), ...giftFish] : count("fish"),
    axolotls: count("axolotls"),
    lilies: count("lilies"),
    flowers: count("flowers"),
  };

  return (
    <>
      <Pond
        className="absolute inset-0"
        options={options}
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
