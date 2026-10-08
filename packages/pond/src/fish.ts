import { random } from "./bed";
import { createProgram, type Program } from "./gl";
import { NOISE } from "./shaders/common";

/*
 * Koi.
 *
 * Each fish is a chain of points that follows its head through the water,
 * so the body traces the path the head took. On top of that a swimming wave
 * travels down the body from head to tail, small at the head and largest at
 * the tail, the way carp swim. Faster swimming means quicker, larger beats.
 *
 * The body is a strip of triangles laid along that spine; its shader works
 * out a rounded cross-section, patterns and scales. Fins are separate
 * see-through surfaces hung off the spine: paddling pectorals, small
 * pelvics, and a fan tail that lags behind the body's swing.
 *
 * Fish are drawn into the underwater layer at their own depth, so the
 * compose pass bends them with the ripples, lights them with the caustics,
 * tints them with the water and casts their shadows onto the floor.
 */

export type KoiVariety = "kohaku" | "sanke" | "showa" | "tancho" | "ogon" | "platinum" | "karasu";

export const koiVarieties: KoiVariety[] = ["kohaku", "sanke", "showa", "tancho", "ogon", "platinum", "karasu"];

export interface FishSpec {
  variety?: KoiVariety;
  /** Body length in metres, without the tail fin. Default 0.18 to 0.26. */
  length?: number;
}

/** Ripples a fish makes in the water, in world units and metres. */
export interface Splash {
  tap(x: number, y: number, depth: number): void;
  move(x: number, y: number, depth: number, dx: number, dy: number): void;
}

const SPINE = 20;
const FISH_TEXELS = SPINE + 2;
const MAX_FISH = 16;
const BODY_ALONG = 40;
const BODY_ACROSS = 12;
const FIN_ALONG = 10;
const FIN_ACROSS = 8;
const FINS = 5;

const FISH_COMMON = /* glsl */ `
uniform highp sampler2D u_fish; // one row per fish: spine points, then two texels of parameters
uniform highp int u_index;
uniform float u_aspect;

const int SPINE = ${SPINE};

// A point along the spine (u = 0 at the snout, 1 at the tail's root):
// position and the direction the body faces there.
vec3 spineAt(float u) {
  float f = clamp(u, 0.0, 1.0) * float(SPINE - 1);
  int i = min(int(floor(f)), SPINE - 2);
  vec4 a = texelFetch(u_fish, ivec2(i, u_index), 0);
  vec4 b = texelFetch(u_fish, ivec2(i + 1, u_index), 0);
  float t = f - float(i);
  float turn = atan(sin(b.z - a.z), cos(b.z - a.z));
  return vec3(mix(a.xy, b.xy, t), a.z + turn * t);
}

vec4 fishParams() { return texelFetch(u_fish, ivec2(SPINE, u_index), 0); }     // length; depth; variety; seed
vec4 fishMotion() { return texelFetch(u_fish, ivec2(SPINE + 1, u_index), 0); } // fin phase; fold; tail lag; -

// Half the body's width, as a fraction of its length: a blunt, rounded
// head, widest at the shoulders, tapering to a slim tail root.
float halfWidth(float u) {
  float head = sqrt(max(1.0 - pow(1.0 - clamp(u / 0.3, 0.0, 1.0), 2.0), 0.0));
  float taper = 1.0 - 0.84 * pow(clamp((u - 0.32) / 0.68, 0.0, 1.0), 1.3);
  return 0.13 * head * taper;
}

vec4 toClip(vec2 world) {
  return vec4(world / vec2(u_aspect, 1.0) * 2.0 - 1.0, 0.0, 1.0);
}
`;

const BODY_VERT = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_uv; // along 0..1; across -1..1

${FISH_COMMON}

out vec2 v_uv;
out vec2 v_forward;
out vec2 v_side;

void main() {
  vec4 params = fishParams();
  vec3 s = spineAt(a_uv.x);
  v_forward = vec2(cos(s.z), sin(s.z));
  v_side = vec2(-v_forward.y, v_forward.x);
  v_uv = a_uv;
  vec2 world = s.xy + v_side * a_uv.y * halfWidth(a_uv.x) * params.x;
  gl_Position = toClip(world);
}
`;

const PATTERN = /* glsl */ `
const vec3 WHITE = vec3(0.3, 0.295, 0.27);
const vec3 RED = vec3(0.4, 0.06, 0.016);
const vec3 BLACK = vec3(0.018, 0.018, 0.022);
const vec3 GOLD = vec3(0.4, 0.22, 0.035);
const vec3 PLATINUM = vec3(0.33, 0.33, 0.31);

// Koi colour patches have crisp but not hard edges.
float colourPatch(float n, float level) {
  return smoothstep(level - 0.015, level + 0.015, n);
}

// Albedo at a point on the body. p is in body lengths (along, across).
vec3 koiPattern(vec2 p, float u, float v, int variety, float seed) {
  // Patterns sit on the back; the flanks we glimpse are paler.
  float back = 1.0 - smoothstep(0.6, 1.0, abs(v));
  // Red (hi): big patches, often on the head, rarely on the snout or the tail root.
  float hiNoise = fbm(p * 4.5 + seed * 31.0) + 0.12 * back
    + 0.1 * smoothstep(0.06, 0.12, u) * (1.0 - smoothstep(0.22, 0.3, u))
    - 0.4 * (1.0 - smoothstep(0.03, 0.08, u))
    - 0.4 * smoothstep(0.86, 0.97, u);
  float hi = colourPatch(hiNoise, 0.45);
  // Black (sumi): small patches on the back.
  float sumi = colourPatch(fbm(p * 9.0 + seed * 7.0 + 5.0) + 0.1 * back, 0.68) * step(0.2, u) * back;

  if (variety == 0) return mix(WHITE, RED, hi);                                   // kohaku
  if (variety == 1) return mix(mix(WHITE, RED, hi), BLACK, sumi);                 // sanke
  if (variety == 2) {                                                             // showa
    float white = colourPatch(fbm(p * 4.0 + seed * 3.0 + 11.0), 0.52);
    return mix(mix(BLACK, WHITE, white), RED, hi * white);
  }
  if (variety == 3) {                                                             // tancho
    float spot = 1.0 - smoothstep(0.036, 0.044, length(p - vec2(0.13, 0.0)));
    return mix(WHITE, RED, spot);
  }
  if (variety == 4) return GOLD * (0.9 + 0.2 * fbm(p * 6.0 + seed));              // ogon
  if (variety == 5) return PLATINUM * (0.94 + 0.1 * fbm(p * 6.0 + seed));         // platinum
  return BLACK * (1.0 + 0.6 * smoothstep(0.5, 1.0, abs(v)));                      // karasu
}

bool isMetallic(int variety) {
  return variety == 4 || variety == 5;
}
`;

const BODY_FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
in vec2 v_forward;
in vec2 v_side;
layout(location = 0) out vec4 o_colour;
layout(location = 1) out vec4 o_depth;

${FISH_COMMON}
${NOISE}
${PATTERN}

uniform vec3 u_toSun; // toward the sun, under water

void main() {
  vec4 params = fishParams();
  int variety = int(params.z);
  float seed = params.w;
  float u = v_uv.x, v = v_uv.y;
  vec2 p = vec2(u, v * halfWidth(u));

  vec3 albedo = koiPattern(p, u, v, variety, seed);

  // A fine net of scales, fading out where it would be too fine to see.
  vec2 g = p * 46.0;
  g.y += 0.5 * mod(floor(g.x), 2.0);
  float edge = smoothstep(0.32, 0.5, length(fract(g) - 0.5));
  float visible = 1.0 - smoothstep(0.25, 0.6, fwidth(g.x));
  albedo *= 1.0 - (variety == 6 ? -0.25 : 0.07) * edge * visible * smoothstep(0.08, 0.2, u);

  // The dorsal fin, seen edge-on from above: a thin ridge down the back.
  float dorsal = (1.0 - smoothstep(0.0, 0.07, abs(v))) * smoothstep(0.3, 0.36, u) * (1.0 - smoothstep(0.7, 0.78, u));
  albedo = mix(albedo, albedo * 0.7, dorsal * 0.6);

  // Eyes, on the sides of the head.
  vec2 eye = vec2(0.085, sign(v) * 0.056);
  float eyeR = length(p - eye);
  float eyeBall = 1.0 - smoothstep(0.009, 0.012, eyeR);
  vec3 eyeColour = mix(vec3(0.02), vec3(0.3, 0.24, 0.12), smoothstep(0.004, 0.008, eyeR));
  albedo = mix(albedo, eyeColour, eyeBall);

  // A rounded body: an oval cross-section, the head sloping down to the snout.
  float z = sqrt(max(1.0 - v * v, 0.0));
  float slope = u < 0.3 ? (0.3 - u) / 0.3 * 0.9 : -(u - 0.3) * 0.35;
  vec3 normal = normalize(vec3(v_side * v * 1.3 + v_forward * slope, z + 0.15));
  // Soft light that wraps around the body, so it reads round without a hard terminator.
  float wrap = clamp((dot(normal, u_toSun) + 0.5) / 1.5, 0.0, 1.0);
  float form = 0.45 + 0.75 * wrap;
  // Wet, glossy skin; metallic varieties shine much more.
  float gloss = isMetallic(variety) ? 0.45 : 0.07;
  float spec = pow(max(reflect(-u_toSun, normal).z, 0.0), 14.0) * gloss;
  vec3 colour = albedo * form + mix(vec3(1.0), albedo * 1.3, isMetallic(variety) ? 0.7 : 0.2) * spec;

  float alpha = (1.0 - smoothstep(0.82, 1.0, abs(v))) * smoothstep(0.0, 0.02, u);
  o_colour = vec4(colour, alpha);
  o_depth = vec4(params.y, 0.0, 0.0, alpha);
}
`;

const FIN_VERT = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_st; // along the fin from its root 0..1; across -1..1

${FISH_COMMON}

out vec2 v_st;
flat out int v_fin;

// Each fin's shape: how far along the body it hangs (u), its length and
// widest half-width (body lengths), and how it's swept back from straight out.
void finShape(int fin, out float u, out float side, out float len, out float width, out float sweep) {
  side = (fin == 0 || fin == 2) ? 1.0 : -1.0;
  if (fin <= 1) { u = 0.25; len = 0.2; width = 0.085; sweep = 0.5; }
  else if (fin <= 3) { u = 0.52; len = 0.11; width = 0.045; sweep = 0.9; }
  else { u = 1.0; side = 0.0; len = 0.27; width = 0.13; sweep = 0.0; }
}

// Half-width along the fin: narrow at the root, fanning out to a rounded
// tip; the tail spreads into two lobes.
float finWidth(int fin, float s) {
  if (fin == 4) return 0.18 + 0.82 * pow(s, 0.8);
  return sin(3.14159 * pow(s, 0.65)) * (0.35 + 0.65 * s);
}

void main() {
  int fin = gl_InstanceID;
  vec4 params = fishParams();
  vec4 motion = fishMotion();
  float L = params.x;
  float u, side, len, width, sweep;
  finShape(fin, u, side, len, width, sweep);

  vec3 root = spineAt(u);
  vec2 forward = vec2(cos(root.z), sin(root.z));
  vec2 left = vec2(-forward.y, forward.x);
  float s = a_st.x, t = a_st.y;
  vec2 world;
  if (fin == 4) {
    // The tail: points straight back and swings a little behind the body.
    float bend = motion.z;
    float a = root.z + 3.14159 + bend * s * 0.6;
    vec2 dir = vec2(cos(root.z + 3.14159 + bend * s * 0.3), sin(root.z + 3.14159 + bend * s * 0.3));
    vec2 across = vec2(-sin(a), cos(a));
    world = root.xy + dir * s * len * L + across * t * finWidth(fin, s) * width * L;
  } else {
    // Pectorals paddle; when darting, all side fins fold back along the body.
    float paddle = fin <= 1 ? 0.35 * sin(motion.x + side * 0.6) : 0.12 * sin(motion.x * 0.7);
    float angle = mix(1.5708 + sweep + paddle, 2.75, motion.y);
    float a = root.z + side * angle;
    vec2 dir = vec2(cos(a), sin(a));
    vec2 across = vec2(-dir.y, dir.x);
    vec2 base = root.xy + left * side * halfWidth(u) * L * 0.75;
    world = base + dir * s * len * L + across * t * finWidth(fin, s) * width * L;
  }
  v_st = a_st;
  v_fin = fin;
  gl_Position = toClip(world);
}
`;

const FIN_FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_st;
flat in int v_fin;
layout(location = 0) out vec4 o_colour;
layout(location = 1) out vec4 o_depth;

${FISH_COMMON}

void main() {
  vec4 params = fishParams();
  int variety = int(params.z);
  float s = v_st.x, t = v_st.y;

  // Soft outline; the tail's trailing edge is forked into two lobes.
  float outline = 1.0 - smoothstep(0.45, 1.0, abs(t));
  float tip = v_fin == 4 ? 1.0 - 0.14 * (1.0 - abs(t)) : 1.0;
  outline *= 1.0 - smoothstep(tip - 0.25, tip, s);
  // Rays fanning out from the root.
  float rays = 0.88 + 0.12 * smoothstep(0.2, 0.9, abs(sin(t * (v_fin == 4 ? 12.0 : 7.0))));

  vec3 tint = vec3(0.3, 0.295, 0.27);
  vec3 root = tint;
  if (variety == 4) tint = root = vec3(0.4, 0.24, 0.05);          // ogon: golden fins
  if (variety == 6) tint = root = vec3(0.03, 0.03, 0.035);        // karasu: black fins
  if (variety == 2) root = vec3(0.03, 0.03, 0.035);               // showa: black at the fin roots
  if (variety == 1 && v_fin != 4) tint = mix(tint, vec3(0.04), step(0.7, fract(s * 3.0 + params.w)) * 0.8); // sanke: stripes
  vec3 colour = mix(root, tint, smoothstep(0.1, 0.45, s)) * rays;

  // Thin fins are see-through, most of all toward their edges.
  float alpha = outline * (0.5 - 0.3 * s);
  o_colour = vec4(colour, alpha);
  o_depth = vec4(params.y, 0.0, 0.0, alpha);
}
`;

type Mode = "cruise" | "rest";

interface Koi {
  variety: number;
  seed: number;
  /** Body length, world units and metres. */
  length: number;
  lengthM: number;
  /** Spine points following the head, world units: x, y pairs, snout first. */
  chain: Float32Array;
  heading: number;
  /** Metres per second. */
  speed: number;
  cruiseSpeed: number;
  /** World units below the surface. */
  depth: number;
  targetDepth: number;
  phase: number;
  finPhase: number;
  mode: Mode;
  modeTimer: number;
  wanderTime: number;
  /** 0..1: how much of a startled dash is left. */
  dart: number;
  dartHeading: number;
  dartSpeed: number;
  riseTimer: number;
  rising: boolean;
  lastWake: { x: number; y: number };
  lastBeat: number;
}

/** Smooth 1D value noise in 0..1. */
function noise1(x: number, seed: number) {
  const i = Math.floor(x);
  const f = x - i;
  const h = (n: number) => {
    const s = Math.sin(n * 127.1 + seed * 311.7) * 43758.5453;
    return s - Math.floor(s);
  };
  const u = f * f * (3 - 2 * f);
  return h(i) * (1 - u) + h(i + 1) * u;
}

function wrapAngle(a: number) {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

/** A pond's koi: their behaviour, swimming, and drawing. */
export class School {
  private fish: Koi[] = [];
  private body: Program;
  private fins: Program;
  private bodyVao: WebGLVertexArrayObject;
  private finVao: WebGLVertexArrayObject;
  private buffers: WebGLBuffer[];
  private bodyCount: number;
  private finCount: number;
  private texture: WebGLTexture;
  private data = new Float32Array(MAX_FISH * FISH_TEXELS * 4);
  private aspect = 1;
  private metres = 1;

  constructor(private gl: WebGL2RenderingContext) {
    this.body = createProgram(gl, BODY_VERT, BODY_FRAG);
    this.fins = createProgram(gl, FIN_VERT, FIN_FRAG);
    const grid = (along: number, across: number) => {
      const vertices: number[] = [];
      for (let i = 0; i <= along; i++) {
        for (let j = 0; j <= across; j++) vertices.push(i / along, (j / across) * 2 - 1);
      }
      const indices: number[] = [];
      for (let i = 0; i < along; i++) {
        for (let j = 0; j < across; j++) {
          const a = i * (across + 1) + j;
          const b = a + across + 1;
          indices.push(a, b, a + 1, a + 1, b, b + 1);
        }
      }
      const vao = gl.createVertexArray()!;
      gl.bindVertexArray(vao);
      const vertexBuffer = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      const indexBuffer = gl.createBuffer()!;
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(indices), gl.STATIC_DRAW);
      gl.bindVertexArray(null);
      return { vao, buffers: [vertexBuffer, indexBuffer], count: indices.length };
    };
    const body = grid(BODY_ALONG, BODY_ACROSS);
    const fins = grid(FIN_ALONG, FIN_ACROSS);
    this.bodyVao = body.vao;
    this.finVao = fins.vao;
    this.bodyCount = body.count;
    this.finCount = fins.count;
    this.buffers = [...body.buffers, ...fins.buffers];

    this.texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, FISH_TEXELS, MAX_FISH, 0, gl.RGBA, gl.FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  }

  /** Releases fish into a pond `aspect` wide and 1 tall, at `metres` per world unit. */
  populate(specs: FishSpec[], seed: number, aspect: number, metres: number) {
    const rand = random(seed * 15485863 + 3);
    this.aspect = aspect;
    this.metres = metres;
    this.fish = specs.slice(0, MAX_FISH).map((spec) => {
      const lengthM = spec.length ?? 0.18 + 0.08 * rand();
      const length = lengthM / metres;
      const heading = rand() * Math.PI * 2;
      const x = (0.2 + 0.6 * rand()) * aspect;
      const y = 0.2 + 0.6 * rand();
      const chain = new Float32Array(SPINE * 2);
      for (let i = 0; i < SPINE; i++) {
        const back = (i / (SPINE - 1)) * length;
        chain[i * 2] = x - Math.cos(heading) * back;
        chain[i * 2 + 1] = y - Math.sin(heading) * back;
      }
      const depth = (0.05 + 0.07 * rand()) / metres;
      return {
        variety: koiVarieties.indexOf(spec.variety ?? koiVarieties[Math.floor(rand() * koiVarieties.length)]),
        seed: rand(),
        length,
        lengthM,
        chain,
        heading,
        speed: 0.05,
        cruiseSpeed: 0.06 + 0.06 * rand(),
        depth,
        targetDepth: depth,
        phase: rand() * 10,
        finPhase: rand() * 10,
        mode: "cruise" as Mode,
        modeTimer: 4 + 8 * rand(),
        wanderTime: rand() * 100,
        dart: 0,
        dartHeading: 0,
        dartSpeed: 0,
        riseTimer: 10 + 40 * rand(),
        rising: false,
        lastWake: { x, y },
        lastBeat: 0,
      };
    });
  }

  /** Keeps the fish when the canvas changes shape, just inside the new bounds. */
  resize(aspect: number, metres: number) {
    const scale = this.metres / metres;
    this.aspect = aspect;
    this.metres = metres;
    for (const f of this.fish) {
      f.length = f.lengthM / metres;
      f.depth *= scale;
      f.targetDepth *= scale;
    }
  }

  /** Startles fish near a point (world units): they dash away and dive. */
  startle(x: number, y: number, radiusM = 0.25) {
    const radius = radiusM / this.metres;
    for (const f of this.fish) {
      const dx = f.chain[0] - x;
      const dy = f.chain[1] - y;
      const d = Math.hypot(dx, dy);
      if (d > radius) continue;
      const closeness = 1 - d / radius;
      f.dart = 1;
      f.dartHeading = Math.atan2(dy, dx) + (Math.random() - 0.5) * 1.2;
      f.dartSpeed = 0.45 + 0.75 * closeness;
      f.targetDepth = Math.min(f.targetDepth + 0.03 / this.metres, 0.14 / this.metres);
      f.rising = false;
      f.mode = "cruise";
      f.modeTimer = 3 + 3 * Math.random();
    }
  }

  step(dt: number, finger: { x: number; y: number } | null, splash: Splash) {
    if (dt <= 0) return;
    const m = this.metres;
    for (const f of this.fish) {
      const L = f.length;
      const head = { x: f.chain[0], y: f.chain[1] };

      // Moods: mostly cruising, now and then hanging still with fins paddling.
      f.modeTimer -= dt;
      if (f.modeTimer <= 0) {
        f.mode = f.mode === "cruise" && Math.random() < 0.3 ? "rest" : "cruise";
        f.modeTimer = f.mode === "rest" ? 3 + 5 * Math.random() : 6 + 10 * Math.random();
      }
      // Now and then a koi comes up to gulp at the surface.
      f.riseTimer -= dt;
      if (f.riseTimer <= 0 && !f.rising && f.dart === 0) {
        f.rising = true;
        f.targetDepth = 0.008 / m;
      }
      if (f.rising && f.depth < 0.014 / m) {
        const snoutX = head.x + Math.cos(f.heading) * L * 0.02;
        const snoutY = head.y + Math.sin(f.heading) * L * 0.02;
        splash.tap(snoutX, snoutY, 0.0025);
        f.rising = false;
        f.riseTimer = 25 + 45 * Math.random();
        f.targetDepth = (0.05 + 0.07 * Math.random()) / m;
      }

      // Steering: wander, keep off the banks, give each other room, flee a finger.
      f.wanderTime += dt * 0.15;
      const wander = (noise1(f.wanderTime, f.seed * 100) - 0.5) * 2.2;
      let desiredX = Math.cos(f.heading + wander);
      let desiredY = Math.sin(f.heading + wander);
      if (f.dart > 0) {
        desiredX = Math.cos(f.dartHeading) * 3;
        desiredY = Math.sin(f.dartHeading) * 3;
      }
      const ahead = { x: head.x + Math.cos(f.heading) * L * 0.8, y: head.y + Math.sin(f.heading) * L * 0.8 };
      const margin = 0.12 / m + L * 0.4;
      const wall = (d: number) => (d < margin ? ((margin - d) / margin) ** 2 * 4 : 0);
      desiredX += wall(ahead.x) - wall(this.aspect - ahead.x);
      desiredY += wall(ahead.y) - wall(1 - ahead.y);
      for (const o of this.fish) {
        if (o === f || Math.abs(o.depth - f.depth) > 0.03 / m) continue;
        const dx = head.x - o.chain[SPINE];
        const dy = head.y - o.chain[SPINE + 1];
        const d = Math.hypot(dx, dy);
        if (d > 0 && d < L * 0.9) {
          desiredX += (dx / d) * (1 - d / (L * 0.9)) * 1.5;
          desiredY += (dy / d) * (1 - d / (L * 0.9)) * 1.5;
        }
      }
      if (finger) {
        const dx = head.x - finger.x;
        const dy = head.y - finger.y;
        const d = Math.hypot(dx, dy);
        const reach = 0.15 / m;
        if (d < 0.05 / m && f.dart === 0) this.startle(finger.x, finger.y, 0.08);
        else if (d < reach) {
          desiredX += (dx / d) * (1 - d / reach) * 3;
          desiredY += (dy / d) * (1 - d / reach) * 3;
        }
      }
      const desired = Math.atan2(desiredY, desiredX);
      const maxTurn = f.dart > 0 ? 7 : 0.6 + 2 * f.speed;
      f.heading += Math.max(-maxTurn * dt, Math.min(maxTurn * dt, wrapAngle(desired - f.heading)));

      // Speed: drift toward this mood's pace; a dash starts fast and fades.
      const pace = f.mode === "rest" && !f.rising ? 0.012 : f.cruiseSpeed * (0.8 + 0.5 * noise1(f.wanderTime * 0.7, f.seed * 50));
      f.speed += (pace - f.speed) * (1 - Math.exp(-dt * 1.2));
      if (f.dart > 0) {
        f.speed = Math.max(f.speed, f.dartSpeed * f.dart ** 0.6);
        f.dart = Math.max(0, f.dart - dt / 0.7);
      }
      f.depth += Math.max(-0.03 * dt / m, Math.min(0.03 * dt / m, f.targetDepth - f.depth));

      // Move the head, and let the body follow its path.
      const step = (f.speed / m) * dt;
      f.chain[0] = Math.min(Math.max(head.x + Math.cos(f.heading) * step, 0), this.aspect);
      f.chain[1] = Math.min(Math.max(head.y + Math.sin(f.heading) * step, 0), 1);
      const segment = L / (SPINE - 1);
      let previous = f.heading;
      for (let i = 1; i < SPINE; i++) {
        const dx = f.chain[(i - 1) * 2] - f.chain[i * 2];
        const dy = f.chain[(i - 1) * 2 + 1] - f.chain[i * 2 + 1];
        // A spine only bends so far between neighbouring points.
        let angle = Math.atan2(dy, dx);
        const bend = wrapAngle(angle - previous);
        angle = previous + Math.max(-0.28, Math.min(0.28, bend));
        f.chain[i * 2] = f.chain[(i - 1) * 2] - Math.cos(angle) * segment;
        f.chain[i * 2 + 1] = f.chain[(i - 1) * 2 + 1] - Math.sin(angle) * segment;
        previous = angle;
      }

      // Tail beats come quicker the faster it swims; pectorals paddle most when hovering.
      const beat = 0.5 + 4.2 * f.speed;
      f.phase += Math.PI * 2 * beat * dt;
      f.finPhase += Math.PI * 2 * (f.speed < 0.03 ? 1.1 : 0.45) * dt;

      // Near the surface, a swimming koi pushes a wake ahead of it.
      const shallow = Math.max(0, 1 - f.depth / (0.05 / m));
      const moved = Math.hypot(f.chain[0] - f.lastWake.x, f.chain[1] - f.lastWake.y) * m;
      if (shallow > 0 && moved > 0.008) {
        splash.move(f.chain[0], f.chain[1], 0.006 * shallow, (f.chain[0] - f.lastWake.x) * m, (f.chain[1] - f.lastWake.y) * m);
        f.lastWake = { x: f.chain[0], y: f.chain[1] };
      } else if (shallow === 0) {
        f.lastWake = { x: f.chain[0], y: f.chain[1] };
      }
      // A dash near the surface swirls it with each stroke of the tail.
      const swirl = Math.max(0, 1 - f.depth / (0.11 / m));
      if (f.dart > 0.4 && swirl > 0 && f.phase - f.lastBeat > Math.PI) {
        splash.tap(f.chain[(SPINE - 1) * 2], f.chain[(SPINE - 1) * 2 + 1], 0.004 * swirl);
        f.lastBeat = f.phase;
      }
    }
  }

  /** Draws every fish into the underwater layer, which must be bound and blending. */
  draw(toSun: [number, number, number]) {
    const { gl } = this;
    if (this.fish.length === 0) return;
    this.upload();
    // Deeper fish first, so shallower ones swim over them.
    const order = this.fish.map((f, i) => i).sort((a, b) => this.fish[b].depth - this.fish[a].depth);

    const parts = [
      [this.fins, this.finVao, this.finCount, FINS],
      [this.body, this.bodyVao, this.bodyCount, 1],
    ] as const;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    for (const [program] of parts) {
      gl.useProgram(program.program);
      gl.uniform1i(program.uniforms.u_fish, 0);
      gl.uniform1f(program.uniforms.u_aspect, this.aspect);
      gl.uniform3fv(program.uniforms.u_toSun, toSun);
    }

    // Each fish's fins, then its body over them.
    for (const i of order) {
      for (const [program, vao, count, instances] of parts) {
        gl.useProgram(program.program);
        gl.uniform1i(program.uniforms.u_index, i);
        gl.bindVertexArray(vao);
        gl.drawElementsInstanced(gl.TRIANGLES, count, gl.UNSIGNED_SHORT, 0, instances);
      }
    }
  }

  /** Writes each fish's bent spine and parameters into the fish texture. */
  private upload() {
    const { gl, data } = this;
    const bent = new Float32Array(SPINE * 2);
    this.fish.forEach((f, row) => {
      const L = f.length;
      // The swimming wave: travels from head to tail, growing toward the tail.
      const amplitude = L * (0.05 + 0.09 * Math.min(f.speed / 0.3, 1) + 0.1 * f.dart);
      for (let i = 0; i < SPINE; i++) {
        const u = i / (SPINE - 1);
        const j = Math.max(i, 1);
        const dx = f.chain[(j - 1) * 2] - f.chain[j * 2];
        const dy = f.chain[(j - 1) * 2 + 1] - f.chain[j * 2 + 1];
        const d = Math.hypot(dx, dy) || 1;
        const offset = amplitude * (0.03 + 0.97 * u * u) * Math.sin(f.phase - Math.PI * 2 * 0.9 * u);
        bent[i * 2] = f.chain[i * 2] - (dy / d) * offset;
        bent[i * 2 + 1] = f.chain[i * 2 + 1] + (dx / d) * offset;
      }
      const base = row * FISH_TEXELS * 4;
      for (let i = 0; i < SPINE; i++) {
        const j = Math.max(i, 1);
        const angle = Math.atan2(bent[(j - 1) * 2 + 1] - bent[j * 2 + 1], bent[(j - 1) * 2] - bent[j * 2]);
        data.set([bent[i * 2], bent[i * 2 + 1], angle, 0], base + i * 4);
      }
      // The tail fin lags a quarter-beat behind the body's swing.
      const lag = (amplitude / L) * 3 * Math.cos(f.phase - Math.PI * 2 * 0.9);
      const fold = Math.min(1, f.dart * 1.6);
      data.set([L, f.depth, f.variety, f.seed], base + SPINE * 4);
      data.set([f.finPhase, fold, lag, 0], base + (SPINE + 1) * 4);
    });
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, FISH_TEXELS, this.fish.length, gl.RGBA, gl.FLOAT, data);
  }

  dispose() {
    const { gl } = this;
    gl.deleteProgram(this.body.program);
    gl.deleteProgram(this.fins.program);
    gl.deleteVertexArray(this.bodyVao);
    gl.deleteVertexArray(this.finVao);
    this.buffers.forEach((b) => gl.deleteBuffer(b));
    gl.deleteTexture(this.texture);
  }
}
