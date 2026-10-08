import { Bed, scatterStones } from "./bed";
import { Floating } from "./floating";
import { enableFloatTargets, parseColor } from "./gl";
import { Grass, growGrass } from "./grass";
import { Underwater } from "./underwater";
import { Renderer, type Palette } from "./renderer";
import { Ripples } from "./ripples";

export interface PondPalette {
  /** Colour of the pond floor. */
  bed: string;
  /** What white looks like through half a pond's height of this water. Greener means greener water. */
  water: string;
  /** Glow of light scattered by particles in the water. */
  murk: string;
  /** Colour of the sky reflected in the water. */
  sky: string;
}

export type PondQuality = "low" | "medium" | "high";

export interface PondOptions {
  /**
   * How many metres of pond the canvas's shorter side shows. Ripples and
   * waves move at real-world speeds, so this sets how fast they cross the
   * screen. Default 0.8.
   */
  size?: number;
  /** Ripple when the pond is tapped or dragged across. Default true. */
  interactive?: boolean;
  /** Cap on device pixel ratio, to keep big screens fast. Default 2. */
  maxPixelRatio?: number;
  /** Pond depth, as a fraction of the canvas height. Default 0.25. */
  depth?: number;
  /** Strength of the gentle waves that are always moving, 0 for still water. Default 0.4. */
  waves?: number;
  /** Detail of the light patterns. Default "high", or "medium" on touch devices. */
  quality?: PondQuality;
  /** How many river stones lie on the bed, up to 16. Default 6. */
  stones?: number;
  /** How many clumps of grass grow in the shallows. Default 5. */
  grass?: number;
  /** How many lily pads float on the surface. Default 9. */
  lilies?: number;
  /** How many water lilies bloom on the pads. Default 3. */
  flowers?: number;
  /** Picks the layout of stones and pebbles; the same seed always gives the same pond. Default 1. */
  seed?: number;
  palette?: Partial<PondPalette>;
}

export interface RippleOptions {
  /** How hard the water is poked. 1 is a fingertip tap. Default 1. */
  strength?: number;
}

export interface Pond {
  readonly canvas: HTMLCanvasElement;
  /** Makes a ripple at a point, in CSS pixels from the canvas's top-left. */
  ripple(x: number, y: number, options?: RippleOptions): void;
  pause(): void;
  resume(): void;
  /** Frames per second, averaged over the last second. */
  readonly fps: number;
  /** Stops the pond and frees its GPU memory. */
  destroy(): void;
}

export const defaultPalette: PondPalette = {
  bed: "#4a5a30",
  water: "#7fbf8c",
  murk: "#163f28",
  sky: "#d6ebff",
};

/** Surface grid, caustic map and bed map sizes, along the canvas's longer side. */
const QUALITY = {
  low: { surface: 224, caustics: 512, bed: 512 },
  medium: { surface: 320, caustics: 768, bed: 768 },
  high: { surface: 400, caustics: 1024, bed: 1024 },
};

/** Radius of a fingertip, metres. */
const FINGER_RADIUS = 0.01;
/** How deep a fingertip tap pushes the water, metres. */
const TAP_DEPTH = 0.007;
/** Depth of the dent a finger carries as it moves through the water, metres. */
const DRAG_DEPTH = 0.007;
/** A drag is split into steps no longer than this, metres... */
const DRAG_STEP = 0.006;
/**
 * ...and no more than this many per frame; a fast flick takes longer steps.
 * When the pond is already busy with ripples, fewer, so it stays smooth.
 */
function maxDragSteps(liveRipples: number) {
  return liveRipples < 900 ? 12 : liveRipples < 1400 ? 6 : 3;
}
/** Ignore jitter smaller than this, metres. */
const DRAG_DEADZONE = 0.002;

/** Hex colours are sRGB; lighting maths needs linear values. */
function linear(hex: string) {
  return parseColor(hex).map((c) => c ** 2.2) as [number, number, number];
}

export function isPondSupported(): boolean {
  if (typeof document === "undefined") return false;
  const gl = document.createElement("canvas").getContext("webgl2");
  return Boolean(gl && enableFloatTargets(gl));
}

export function createPond(canvas: HTMLCanvasElement, options: PondOptions = {}): Pond {
  const {
    size = 0.8,
    interactive = true,
    maxPixelRatio = 2,
    depth = 0.25,
    waves = 0.4,
    stones = 6,
    grass = 5,
    lilies = 9,
    flowers = 3,
    seed = 1,
  } = options;
  const quality =
    QUALITY[
      options.quality ??
        (typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches
          ? "medium"
          : "high")
    ];
  const colors = { ...defaultPalette, ...options.palette };
  const palette: Palette = {
    bed: linear(colors.bed),
    // Light surviving 0.5 units of water is the water colour, so per unit of
    // depth each channel is absorbed at -ln(colour) / 0.5.
    absorb: linear(colors.water).map((c) => -Math.log(Math.max(c, 1e-3)) / 0.5) as Palette["absorb"],
    murk: linear(colors.murk),
    sky: linear(colors.sky),
  };

  const gl = canvas.getContext("webgl2", { antialias: false, alpha: false });
  if (!gl) throw new Error("pond: WebGL2 isn't available in this browser");
  if (!enableFloatTargets(gl)) {
    throw new Error("pond: this device can't render to float textures");
  }

  // Drawing without vertex buffers still needs a vertex array bound.
  const vao = gl.createVertexArray()!;
  const renderer = new Renderer(gl);
  const bed = new Bed(gl);
  const underwater = new Underwater(gl);
  const plants = new Grass(gl);
  const floating = new Floating(gl);
  // The direction the pond's slow current flows, which the grass leans with.
  const current = seed * 2.399963;
  const ripples = new Ripples(gl);
  let cssWidth = 0;
  let cssHeight = 0;
  /** Metres per world unit (one canvas height). */
  let metres = size;

  function resize() {
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    cssWidth = rect.width;
    cssHeight = rect.height;
    metres = (size * cssHeight) / Math.min(cssWidth, cssHeight);
    const ratio = Math.min(window.devicePixelRatio || 1, maxPixelRatio);
    canvas.width = Math.round(cssWidth * ratio);
    canvas.height = Math.round(cssHeight * ratio);
    renderer.resize(canvas.width, canvas.height, quality);

    // The bed only changes with the canvas's shape, so it's drawn here.
    const aspect = cssWidth / cssHeight;
    const bedScale = quality.bed / Math.max(cssWidth, cssHeight);
    bed.draw(
      Math.round(cssWidth * bedScale),
      Math.round(cssHeight * bedScale),
      vao,
      palette.bed,
      scatterStones(stones, seed, aspect, metres),
    );
    const layerScale = quality.caustics / Math.max(cssWidth, cssHeight);
    underwater.resize(Math.round(cssWidth * layerScale), Math.round(cssHeight * layerScale));
    plants.set(growGrass(grass, seed, aspect, metres, current));
    floating.place({ lilies, flowers }, seed, aspect, metres);
  }

  /** CSS pixels from the top-left to world units (y up, canvas height = 1). */
  function toWorld(x: number, y: number) {
    return { x: x / cssHeight, y: 1 - y / cssHeight };
  }

  let time = 0;

  function ripple(x: number, y: number, { strength = 1 }: RippleOptions = {}) {
    const p = toWorld(x, y);
    ripples.tap(p.x, p.y, time, TAP_DEPTH * strength);
  }

  // Dragging: the finger's dent travels along the pointer's path since the
  // last frame, in short steps, each born when the pointer passed that spot.
  let dragging = false;
  let dragFrom = { x: 0, y: 0, time: 0 };
  let dragTo = { x: 0, y: 0 };
  let fingerLast = { x: 0, y: 0 };

  function emitDrag() {
    const dx = dragTo.x - dragFrom.x;
    const dy = dragTo.y - dragFrom.y;
    const distance = Math.hypot(dx, dy) * metres;
    if (distance < DRAG_DEADZONE) return;
    const count = Math.min(Math.ceil(distance / DRAG_STEP), maxDragSteps(ripples.count));
    for (let i = 1; i <= count; i++) {
      const f = i / count;
      ripples.move(
        dragFrom.x + dx * f,
        dragFrom.y + dy * f,
        dragFrom.time + (time - dragFrom.time) * f,
        DRAG_DEPTH,
        (dx * metres) / count,
        (dy * metres) / count,
      );
    }
    dragFrom = { ...dragTo, time };
  }

  let frame = 0;
  let running = false;
  let last = 0;
  let fps = 0;
  let fpsFrames = 0;
  let fpsSince = 0;

  function tick(now: number) {
    frame = requestAnimationFrame(tick);
    // Clamp long gaps (e.g. a background tab) so time doesn't jump.
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    fpsFrames++;
    if (now - fpsSince >= 1000) {
      fps = (fpsFrames * 1000) / (now - fpsSince);
      fpsFrames = 0;
      fpsSince = now;
    }
    const layer = underwater.layer;
    if (cssWidth === 0 || !bed.texture || !layer) return;

    time += dt;
    // A finger in the water shoves floating things; its speed comes from
    // how far it moved since the last frame.
    const finger = dragging
      ? {
          x: dragTo.x,
          y: dragTo.y,
          vx: dt > 0 ? (dragTo.x - fingerLast.x) / dt : 0,
          vy: dt > 0 ? (dragTo.y - fingerLast.y) / dt : 0,
          radius: FINGER_RADIUS / metres,
        }
      : null;
    fingerLast = dragTo;
    floating.step(dt, finger);
    if (dragging) emitDrag();
    ripples.build(vao);
    underwater.begin();
    plants.draw(time, cssWidth / cssHeight, depth, bed.texture);
    underwater.end();
    renderer.draw(ripples, bed.texture, layer, floating, vao, time, { palette, depth, waves, metres });
  }

  function resume() {
    if (running) return;
    running = true;
    last = fpsSince = performance.now();
    fpsFrames = 0;
    frame = requestAnimationFrame(tick);
  }

  function pause() {
    running = false;
    cancelAnimationFrame(frame);
  }

  function local(e: PointerEvent) {
    const rect = canvas.getBoundingClientRect();
    return toWorld(e.clientX - rect.left, e.clientY - rect.top);
  }

  function onPointerDown(e: PointerEvent) {
    const p = local(e);
    ripples.tap(p.x, p.y, time, TAP_DEPTH);
    floating.tap(p.x, p.y);
    dragging = true;
    dragFrom = { ...p, time };
    dragTo = p;
    fingerLast = p;
  }

  function onPointerMove(e: PointerEvent) {
    if (dragging) dragTo = local(e);
  }

  function onPointerUp() {
    dragging = false;
  }

  if (interactive) {
    // Let fingers draw ripples instead of scrolling the page.
    canvas.style.touchAction = "none";
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
  }

  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  resize();
  resume();

  return {
    canvas,
    ripple,
    get fps() {
      return fps;
    },
    pause,
    resume,
    destroy() {
      pause();
      observer.disconnect();
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      ripples.dispose();
      bed.dispose();
      plants.dispose();
      floating.dispose();
      underwater.dispose();
      renderer.dispose();
      gl.deleteVertexArray(vao);
    },
  };
}
