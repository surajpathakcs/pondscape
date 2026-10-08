"use client";

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPond, type Pond as PondInstance, type PondOptions } from "./pond";

export interface PondProps {
  /** Read once when the pond mounts. Remount (change `key`) to apply new options. */
  options?: PondOptions;
  /**
   * Called with the pond once it's running, e.g. to call `ripple()` yourself.
   * May return a cleanup function, run before the pond is destroyed.
   */
  onReady?: (pond: PondInstance) => void | (() => void);
  /** Shown instead of the pond when the device can't run it. */
  fallback?: ReactNode;
  className?: string;
  style?: CSSProperties;
}

export function Pond({ options, onReady, fallback = null, className, style }: PondProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);
  // Keep the latest values without restarting the pond when they change.
  const optionsRef = useRef(options);
  const onReadyRef = useRef(onReady);
  useEffect(() => {
    onReadyRef.current = onReady;
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let pond: PondInstance;
    try {
      pond = createPond(canvas, optionsRef.current);
    } catch (error) {
      console.warn(error);
      setFailed(true);
      return;
    }
    const cleanup = onReadyRef.current?.(pond);
    return () => {
      cleanup?.();
      pond.destroy();
    };
  }, []);

  if (failed) return <>{fallback}</>;
  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={{ display: "block", width: "100%", height: "100%", ...style }}
    />
  );
}
