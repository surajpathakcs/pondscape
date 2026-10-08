import { random } from "./bed";
import type { Splash } from "./fish";
import { createProgram, type Program } from "./gl";
import { NOISE } from "./shaders/common";

/*
 * Axolotls.
 *
 * They live on the pond floor. Most of the time they rest; sometimes they
 * walk, sometimes they swim a short way, and every so often they swim up to
 * gulp air and sink back down with their legs splayed.
 *
 * Walking uses a salamander's gait: diagonal legs step together (front left
 * with back right), each foot stays planted on the floor while the body
 * moves over it, then swings forward to its next spot, and the body sways
 * in an S with each step. Swimming tucks the legs back and waves the tail.
 *
 * As with the koi, the body is a strip of triangles laid along a spine that
 * follows the head. Legs, hands and the feathery gills are separate strips,
 * drawn first so the body lies over their roots. Everything goes into the
 * underwater layer at the axolotl's depth, so it's lit, tinted and shaded
 * like everything else in the water.
 */

export type AxolotlMorph = "leucistic" | "golden" | "wild" | "copper" | "melanoid";

export const axolotlMorphs: AxolotlMorph[] = ["leucistic", "golden", "wild", "copper", "melanoid"];

export interface AxolotlSpec {
  morph?: AxolotlMorph;
  /** Length in metres, snout to tail tip. Default 0.18 to 0.23. */
  length?: number;
}

const SPINE = 16;
const LEGS = 4;
const TEXELS = SPINE + 2 + LEGS;
const MAX_AXOLOTLS = 8;

/** Where the legs join the body (along it), and which side (+1 left). */
const LEG_U = [0.21, 0.21, 0.47, 0.47];
const LEG_SIDE = [1, -1, 1, -1];
/** Diagonal pairs step together: front left with back right. */
const LEG_OFFSET = [0, Math.PI, Math.PI, 0];

const COMMON = /* glsl */ `
uniform highp sampler2D u_axolotls; // one row each: spine, two parameter texels, four feet
uniform highp int u_index;
uniform float u_aspect;

const int SPINE = ${SPINE};

vec3 spineAt(float u) {
  float f = clamp(u, 0.0, 1.0) * float(SPINE - 1);
  int i = min(int(floor(f)), SPINE - 2);
  vec4 a = texelFetch(u_axolotls, ivec2(i, u_index), 0);
  vec4 b = texelFetch(u_axolotls, ivec2(i + 1, u_index), 0);
  float t = f - float(i);
  return vec3(mix(a.xy, b.xy, t), a.z + atan(sin(b.z - a.z), cos(b.z - a.z)) * t);
}

vec4 params() { return texelFetch(u_axolotls, ivec2(SPINE, u_index), 0); }     // length; depth; morph; seed
vec4 motion() { return texelFetch(u_axolotls, ivec2(SPINE + 1, u_index), 0); } // gill phase; legs tucked 0..1; -; -
vec4 foot(int leg) { return texelFetch(u_axolotls, ivec2(SPINE + 2 + leg, u_index), 0); } // x; y; lift; -

// Half the width of the body itself, as a fraction of its length: a broad,
// rounded head, a slim neck and body, and a tail that's flattened
// side to side, so it looks narrow from above, tapering to a point.
float halfWidth(float u) {
  float snout = sqrt(max(1.0 - pow(max(0.085 - u, 0.0) / 0.085, 2.0), 0.0));
  float w = mix(0.108, 0.068, smoothstep(0.11, 0.21, u));
  w += 0.01 * sin(clamp((u - 0.2) / 0.3, 0.0, 1.0) * 3.14159);
  w *= mix(1.0, 0.72, smoothstep(0.45, 0.6, u));
  return w * snout * pow(max(1.0 - max(u - 0.55, 0.0) / 0.45, 0.0), 0.8);
}

// The see-through fin running along the top of the back and tail.
float finWidth(float u) {
  return 0.034 * smoothstep(0.32, 0.62, u) * sqrt(max(1.0 - pow(max(u - 0.8, 0.0) / 0.2, 2.0), 0.0));
}

// Each morph's skin colour (linear), without its markings.
vec3 skinBase(int morph) {
  if (morph == 0) return vec3(0.42, 0.31, 0.3);    // leucistic: pink-white
  if (morph == 1) return vec3(0.5, 0.3, 0.05);     // golden albino
  if (morph == 2) return vec3(0.05, 0.055, 0.03);  // wild: dark olive
  if (morph == 3) return vec3(0.28, 0.17, 0.09);   // copper
  return vec3(0.022, 0.022, 0.026);                // melanoid: black
}

vec3 gillColour(int morph) {
  if (morph == 0) return vec3(0.5, 0.06, 0.08);
  if (morph == 1) return vec3(0.52, 0.17, 0.16);
  if (morph == 2) return vec3(0.12, 0.05, 0.08);
  if (morph == 3) return vec3(0.42, 0.1, 0.09);
  return vec3(0.06, 0.03, 0.05);
}

vec4 toClip(vec2 world) {
  return vec4(world / vec2(u_aspect, 1.0) * 2.0 - 1.0, 0.0, 1.0);
}
`;

const BODY_VERT = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_uv;
${COMMON}
out vec2 v_uv;
out vec2 v_forward;
out vec2 v_side;

void main() {
  vec4 p = params();
  vec3 s = spineAt(a_uv.x);
  v_forward = vec2(cos(s.z), sin(s.z));
  v_side = vec2(-v_forward.y, v_forward.x);
  v_uv = a_uv;
  float width = halfWidth(a_uv.x) + finWidth(a_uv.x);
  gl_Position = toClip(s.xy + v_side * a_uv.y * width * p.x);
}
`;

const BODY_FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
in vec2 v_forward;
in vec2 v_side;
layout(location = 0) out vec4 o_colour;
layout(location = 1) out vec4 o_depth;
${COMMON}
${NOISE}
uniform vec3 u_toSun;

// Soft round spots: one per cell at most, of varied size. density 0..1.
float spots(vec2 p, float scale, float density, float seed) {
  vec2 g = p * scale;
  vec2 cell = floor(g);
  vec2 centre = cell + 0.25 + 0.5 * vec2(hash(cell + seed), hash(cell + seed + 7.3));
  float r = 0.18 + 0.2 * hash(cell + seed + 3.1);
  float on = step(hash(cell + seed + 5.7), density);
  return on * (1.0 - smoothstep(r * 0.6, r, length(g - centre)));
}

vec3 skin(vec2 p, int morph, float seed) {
  vec3 c = skinBase(morph);
  float back = 1.0 - smoothstep(0.03, 0.06, abs(p.y));
  if (morph == 0) {
    // A few dark freckles on the head and back.
    c = mix(c, vec3(0.12, 0.08, 0.08), spots(p, 90.0, 0.22, seed) * back * 0.6);
  } else if (morph == 1) {
    // Shimmering pale flecks.
    c += vec3(0.1, 0.09, 0.05) * spots(p, 110.0, 0.3, seed);
  } else if (morph == 2) {
    // Darker blotches and fine golden flecks.
    c *= 0.6 + 0.7 * smoothstep(0.3, 0.7, fbm(p * 28.0 + seed * 9.0));
    c += vec3(0.06, 0.05, 0.015) * spots(p, 120.0, 0.3, seed + 2.0);
  } else if (morph == 3) {
    // Darker copper spots.
    c = mix(c, vec3(0.15, 0.075, 0.035), spots(p, 55.0, 0.4, seed) * 0.8);
  } else {
    c *= 0.9 + 0.25 * fbm(p * 20.0 + seed);
  }
  return c;
}

void main() {
  vec4 par = params();
  int morph = int(par.z);
  float seed = par.w;
  float u = v_uv.x;
  float flesh = halfWidth(u);
  float across = v_uv.y * (flesh + finWidth(u)); // in body lengths
  float fv = clamp(across / max(flesh, 1e-4), -1.0, 1.0);
  vec2 p = vec2(u, across);

  vec3 albedo = skin(p, morph, seed);

  // Small lidless eyes on the top sides of the head.
  float eyeR = length(p - vec2(0.062, sign(across) * 0.05));
  float eye = 1.0 - smoothstep(0.006, 0.0085, eyeR);
  vec3 eyeColour = morph == 1 ? vec3(0.55, 0.45, 0.22)
    : morph == 3 ? vec3(0.3, 0.05, 0.04)
    : mix(vec3(0.01), vec3(0.25, 0.2, 0.08), morph == 2 ? smoothstep(0.003, 0.006, eyeR) : 0.0);
  albedo = mix(albedo, eyeColour, eye);

  // A soft, rounded body; the head is flatter and slopes down to the snout.
  float z = sqrt(max(1.0 - fv * fv, 0.0));
  float slope = u < 0.1 ? (0.1 - u) / 0.1 * 0.8 : 0.0;
  vec3 normal = normalize(vec3(v_side * fv * (u < 0.18 ? 0.8 : 1.2) + v_forward * slope, z + 0.2));
  float wrap = clamp((dot(normal, u_toSun) + 0.5) / 1.5, 0.0, 1.0);
  vec3 colour = albedo * (0.5 + 0.7 * wrap);
  colour += albedo * 0.6 * pow(max(reflect(-u_toSun, normal).z, 0.0), 10.0) * 0.12;

  // Flesh is solid with soft edges; the fin beyond it is thin and see-through.
  float fleshAlpha = 1.0 - smoothstep(flesh * 0.8, flesh, abs(across));
  float fin = finWidth(u);
  float finAlpha = fin > 0.0 ? 0.45 * (1.0 - smoothstep(0.5, 1.0, (abs(across) - flesh) / fin)) : 0.0;
  if (abs(across) > flesh * 0.9) colour = mix(colour, albedo * 1.3, 0.5);
  float alpha = max(fleshAlpha, finAlpha) * smoothstep(0.0, 0.01, u);
  o_colour = vec4(colour, alpha);
  o_depth = vec4(par.y, 0.0, 0.0, alpha);
}
`;

const GILL_VERT = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_st;
${COMMON}
out vec2 v_st;

void main() {
  int i = gl_InstanceID;
  float side = i < 3 ? 1.0 : -1.0;
  float k = float(i - (i < 3 ? 0 : 3));
  vec4 par = params();
  float L = par.x;
  // Three stalks a side behind the eyes, fanning back, front ones longest.
  float u = 0.125 + 0.014 * k;
  vec3 root = spineAt(u);
  vec2 forward = vec2(cos(root.z), sin(root.z));
  vec2 left = vec2(-forward.y, forward.x);
  float sway = 0.14 * sin(motion().x + k * 0.9 + side);
  float angle = root.z + side * (1.75 + 0.38 * k + sway) ;
  float len = (0.125 - 0.014 * k) * L;
  vec2 base = root.xy + left * side * halfWidth(u) * L * 0.8;
  // Each stalk curves gently backward along its length.
  float s = a_st.x;
  float a = angle + side * 0.35 * s;
  vec2 dir = vec2(cos(angle + side * 0.17 * s), sin(angle + side * 0.17 * s));
  vec2 across = vec2(-sin(a), cos(a));
  float width = (0.007 + 0.03 * sin(3.14159 * pow(s, 0.7))) * L;
  v_st = a_st;
  gl_Position = toClip(base + dir * s * len + across * a_st.y * width);
}
`;

const GILL_FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_st;
layout(location = 0) out vec4 o_colour;
layout(location = 1) out vec4 o_depth;
${COMMON}

void main() {
  vec4 par = params();
  float s = v_st.x, t = v_st.y;
  float total = 0.007 + 0.03 * sin(3.14159 * pow(s, 0.7));
  float core = 0.007 / total;
  // Fine filaments comb out from the stalk, swept toward its tip.
  float comb = abs(fract(s * 20.0 - abs(t) * 1.1) - 0.5) * 2.0;
  float filament = 1.0 - smoothstep(0.2, 0.8, comb);
  float stalk = 1.0 - smoothstep(core * 0.7, core, abs(t));
  float alpha = max(stalk, filament * 0.85 * (1.0 - smoothstep(0.7, 1.0, abs(t)))) * (1.0 - smoothstep(0.92, 1.0, s));
  vec3 colour = gillColour(int(par.z)) * mix(0.8, 1.2, smoothstep(core, 1.0, abs(t)));
  o_colour = vec4(colour, alpha);
  o_depth = vec4(par.y, 0.0, 0.0, alpha);
}
`;

const LIMB_VERT = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_st;
${COMMON}
out vec2 v_st;
flat out int v_part;

const float LEG_U[4] = float[4](${LEG_U.join(", ")});
const float LEG_SIDE[4] = float[4](${LEG_SIDE.map((s) => s.toFixed(1)).join(", ")});

void main() {
  int i = gl_InstanceID;
  int leg = i % 4;
  float side = LEG_SIDE[leg];
  vec4 par = params();
  float L = par.x;
  vec3 at = spineAt(LEG_U[leg]);
  vec2 forward = vec2(cos(at.z), sin(at.z));
  vec2 left = vec2(-forward.y, forward.x);
  vec2 shoulder = at.xy + left * side * halfWidth(LEG_U[leg]) * L * 0.7;
  vec2 hand = foot(leg).xy;
  v_st = a_st;
  v_part = i < 4 ? 0 : (leg < 2 ? 1 : 2);

  if (i < 4) {
    // The leg: from shoulder to hand, the elbow bowed outward.
    float s = a_st.x;
    vec2 elbow = mix(shoulder, hand, 0.5) + left * side * length(hand - shoulder) * 0.12;
    vec2 p = mix(mix(shoulder, elbow, s), mix(elbow, hand, s), s);
    vec2 dir = normalize(mix(elbow - shoulder, hand - elbow, s) + 1e-6);
    vec2 across = vec2(-dir.y, dir.x);
    gl_Position = toClip(p + across * a_st.y * mix(0.032, 0.022, s) * L);
  } else {
    // The hand: splayed forward and out; tucked back along the body when swimming.
    float tucked = motion().y;
    float spread = leg < 2 ? 0.55 : 1.1;
    float angle = at.z + mix(side * spread, 3.14159 - side * 0.3, tucked);
    vec2 dir = vec2(cos(angle), sin(angle));
    vec2 across = vec2(-dir.y, dir.x);
    vec2 local = (vec2(a_st.x * 2.0 - 1.0, a_st.y)) * 0.034 * L;
    gl_Position = toClip(hand + dir * local.x + across * local.y);
  }
}
`;

const LIMB_FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_st;
flat in int v_part;
layout(location = 0) out vec4 o_colour;
layout(location = 1) out vec4 o_depth;
${COMMON}

float capsule(vec2 p, vec2 a, vec2 b, float r) {
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h) - r;
}

void main() {
  vec4 par = params();
  vec3 base = skinBase(int(par.z));
  float alpha;
  vec3 colour = base;
  if (v_part == 0) {
    alpha = 1.0 - smoothstep(0.6, 1.0, abs(v_st.y));
    colour *= 0.85 + 0.25 * (1.0 - abs(v_st.y));
  } else {
    // A small palm with slim, round-tipped fingers fanned forward:
    // four on the front hands, five on the back feet.
    vec2 p = vec2(v_st.x * 2.0 - 1.0, v_st.y);
    float d = length(p + vec2(0.25, 0.0)) - 0.32;
    int fingers = v_part == 1 ? 4 : 5;
    for (int f = 0; f < 5; f++) {
      if (f >= fingers) break;
      float a = (float(f) / float(fingers - 1) - 0.5) * 1.5;
      vec2 tip = vec2(-0.25, 0.0) + vec2(cos(a), sin(a)) * 0.95;
      d = min(d, capsule(p, vec2(-0.25, 0.0), tip, 0.11));
    }
    alpha = 1.0 - smoothstep(-0.04, 0.04, d);
    colour *= 1.05;
  }
  if (alpha < 0.003) discard;
  o_colour = vec4(colour * 0.85, alpha);
  o_depth = vec4(par.y, 0.0, 0.0, alpha);
}
`;

type Mode = "rest" | "walk" | "swim";

interface Foot {
  x: number;
  y: number;
  lift: number;
  fromX: number;
  fromY: number;
  swinging: boolean;
}

interface Axolotl {
  morph: number;
  seed: number;
  length: number;
  lengthM: number;
  chain: Float32Array;
  heading: number;
  /** Metres per second. */
  speed: number;
  walkSpeed: number;
  mode: Mode;
  modeTimer: number;
  wanderTime: number;
  depth: number;
  targetDepth: number;
  swimPhase: number;
  gaitPhase: number;
  gillPhase: number;
  /** 0 with legs out, 1 tucked back for swimming. */
  tucked: number;
  feet: Foot[];
  dart: number;
  dartHeading: number;
  gulpTimer: number;
  gulping: boolean;
  lastWake: { x: number; y: number };
}

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

function smoothstep(a: number, b: number, x: number) {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
}

/** Matches halfWidth() in the shaders, for placing legs on the CPU. */
function halfWidth(u: number) {
  const snout = Math.sqrt(Math.max(1 - (Math.max(0.085 - u, 0) / 0.085) ** 2, 0));
  let w = 0.108 + (0.068 - 0.108) * smoothstep(0.11, 0.21, u);
  w += 0.01 * Math.sin(Math.min(Math.max((u - 0.2) / 0.3, 0), 1) * Math.PI);
  w *= 1 + (0.72 - 1) * smoothstep(0.45, 0.6, u);
  return w * snout * Math.max(1 - Math.max(u - 0.55, 0) / 0.45, 0) ** 0.8;
}

export class Axolotls {
  private animals: Axolotl[] = [];
  private body: Program;
  private gills: Program;
  private limbs: Program;
  private bodyMesh: { vao: WebGLVertexArrayObject; count: number };
  private stripMesh: { vao: WebGLVertexArrayObject; count: number };
  private buffers: WebGLBuffer[] = [];
  private texture: WebGLTexture;
  private data = new Float32Array(MAX_AXOLOTLS * TEXELS * 4);
  private aspect = 1;
  private metres = 1;
  /** Base pond depth, world units. */
  private pondDepth = 0.25;

  constructor(private gl: WebGL2RenderingContext) {
    this.body = createProgram(gl, BODY_VERT, BODY_FRAG);
    this.gills = createProgram(gl, GILL_VERT, GILL_FRAG);
    this.limbs = createProgram(gl, LIMB_VERT, LIMB_FRAG);
    this.bodyMesh = this.grid(48, 12);
    this.stripMesh = this.grid(14, 6);
    this.texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, TEXELS, MAX_AXOLOTLS, 0, gl.RGBA, gl.FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  }

  private grid(along: number, across: number) {
    const { gl } = this;
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
    this.buffers.push(vertexBuffer, indexBuffer);
    return { vao, count: indices.length };
  }

  /** The floor's depth here (world units), matching bedDepth() in the shaders, roughly. */
  private floorDepth(x: number, y: number) {
    const edge = Math.min(x, y, this.aspect - x, 1 - y);
    return this.pondDepth * 0.85 * (0.55 + 0.45 * smoothstep(-0.05, 0.25, edge));
  }

  /** How high the body sits off the floor on its legs, world units. */
  private get stance() {
    return 0.012 / this.metres;
  }

  populate(specs: AxolotlSpec[], seed: number, aspect: number, metres: number, pondDepth: number) {
    const rand = random(seed * 49979687 + 11);
    this.aspect = aspect;
    this.metres = metres;
    this.pondDepth = pondDepth;
    this.animals = specs.slice(0, MAX_AXOLOTLS).map((spec) => {
      const lengthM = spec.length ?? 0.18 + 0.05 * rand();
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
      const a: Axolotl = {
        morph: axolotlMorphs.indexOf(spec.morph ?? axolotlMorphs[Math.floor(rand() * axolotlMorphs.length)]),
        seed: rand(),
        length,
        lengthM,
        chain,
        heading,
        speed: 0,
        walkSpeed: 0.022 + 0.015 * rand(),
        mode: "rest",
        modeTimer: 2 + 6 * rand(),
        wanderTime: rand() * 100,
        depth: 0,
        targetDepth: 0,
        swimPhase: rand() * 10,
        gaitPhase: rand() * 10,
        gillPhase: rand() * 10,
        tucked: 0,
        feet: [],
        dart: 0,
        dartHeading: 0,
        gulpTimer: 30 + 50 * rand(),
        gulping: false,
        lastWake: { x, y },
      };
      a.depth = a.targetDepth = this.floorDepth(x, y) - this.stance;
      a.feet = LEG_U.map((_, leg) => {
        const home = this.home(a, leg, 0);
        return { ...home, lift: 0, fromX: home.x, fromY: home.y, swinging: false };
      });
      return a;
    });
  }

  resize(aspect: number, metres: number, pondDepth: number) {
    const scale = this.metres / metres;
    this.aspect = aspect;
    this.metres = metres;
    this.pondDepth = pondDepth;
    for (const a of this.animals) {
      a.length = a.lengthM / metres;
      a.depth *= scale;
      a.targetDepth *= scale;
    }
  }

  /** Where a leg's hand rests beside the body, `ahead` body lengths forward of its shoulder. */
  private home(a: Axolotl, leg: number, ahead: number) {
    const i = Math.round(LEG_U[leg] * (SPINE - 1));
    const x = a.chain[i * 2];
    const y = a.chain[i * 2 + 1];
    const angle = Math.atan2(a.chain[(i - 1) * 2 + 1] - y, a.chain[(i - 1) * 2] - x);
    const side = LEG_SIDE[leg];
    const out = (halfWidth(LEG_U[leg]) + 0.06) * a.length * side;
    const forward = (ahead + (leg < 2 ? 0.035 : -0.01)) * a.length;
    return {
      x: x + Math.cos(angle) * forward - Math.sin(angle) * out,
      y: y + Math.sin(angle) * forward + Math.cos(angle) * out,
    };
  }

  /** Where a hand lies when tucked back along the body for swimming. */
  private tuckedAt(a: Axolotl, leg: number) {
    const i = Math.round(LEG_U[leg] * (SPINE - 1));
    const x = a.chain[i * 2];
    const y = a.chain[i * 2 + 1];
    const angle = Math.atan2(a.chain[(i - 1) * 2 + 1] - y, a.chain[(i - 1) * 2] - x);
    const side = LEG_SIDE[leg];
    const out = halfWidth(LEG_U[leg]) * a.length * side * 1.05;
    const back = -0.09 * a.length;
    return {
      x: x + Math.cos(angle) * back - Math.sin(angle) * out,
      y: y + Math.sin(angle) * back + Math.cos(angle) * out,
    };
  }

  /** Startles axolotls near a point (world units): they bolt with legs tucked. */
  startle(x: number, y: number, radiusM = 0.2) {
    const radius = radiusM / this.metres;
    for (const a of this.animals) {
      const d = Math.hypot(a.chain[0] - x, a.chain[1] - y);
      if (d > radius) continue;
      a.mode = "swim";
      a.modeTimer = 1.2 + Math.random();
      a.dart = 1;
      a.dartHeading = Math.atan2(a.chain[1] - y, a.chain[0] - x) + (Math.random() - 0.5) * 1.2;
      a.gulping = false;
      a.targetDepth = this.floorDepth(a.chain[0], a.chain[1]) - 0.04 / this.metres;
    }
  }

  step(dt: number, finger: { x: number; y: number } | null, splash: Splash) {
    if (dt <= 0) return;
    const m = this.metres;
    for (const a of this.animals) {
      const L = a.length;
      const head = { x: a.chain[0], y: a.chain[1] };
      const floor = this.floorDepth(head.x, head.y) - this.stance;
      const onFloor = a.depth >= floor - 0.004 / m;

      // Moods: mostly resting, sometimes walking, now and then a short swim.
      a.modeTimer -= dt;
      if (a.modeTimer <= 0) {
        const roll = Math.random();
        a.mode = a.mode !== "rest" ? "rest" : roll < 0.75 ? "walk" : "swim";
        a.modeTimer = a.mode === "rest" ? 4 + 9 * Math.random() : a.mode === "walk" ? 3 + 6 * Math.random() : 2 + 2 * Math.random();
        a.targetDepth = a.mode === "swim" ? floor - (0.03 + 0.06 * Math.random()) / m : floor;
      }
      // Every so often, up for a gulp of air.
      a.gulpTimer -= dt;
      if (a.gulpTimer <= 0 && !a.gulping && a.dart === 0) {
        a.gulping = true;
        a.mode = "swim";
        a.modeTimer = 30;
        a.targetDepth = 0.008 / m;
      }
      if (a.gulping && a.depth < 0.016 / m) {
        splash.tap(head.x, head.y, 0.003);
        a.gulping = false;
        a.gulpTimer = 40 + 60 * Math.random();
        a.mode = "rest";
        a.modeTimer = 5 + 5 * Math.random();
      }
      if (a.mode !== "swim") a.targetDepth = floor;
      if (finger) {
        const d = Math.hypot(head.x - finger.x, head.y - finger.y);
        if (d < 0.06 / m && a.dart === 0) this.startle(finger.x, finger.y, 0.1);
      }

      // Steering: a slow wander, kept off the banks and away from each other.
      a.wanderTime += dt * (a.mode === "swim" ? 0.3 : 0.12);
      const wander = (noise1(a.wanderTime, a.seed * 100) - 0.5) * 2;
      let dx = Math.cos(a.heading + wander);
      let dy = Math.sin(a.heading + wander);
      if (a.dart > 0) {
        dx = Math.cos(a.dartHeading) * 3;
        dy = Math.sin(a.dartHeading) * 3;
      }
      const ahead = { x: head.x + Math.cos(a.heading) * L * 0.6, y: head.y + Math.sin(a.heading) * L * 0.6 };
      const margin = 0.1 / m + L * 0.3;
      const wall = (d: number) => (d < margin ? ((margin - d) / margin) ** 2 * 4 : 0);
      dx += wall(ahead.x) - wall(this.aspect - ahead.x);
      dy += wall(ahead.y) - wall(1 - ahead.y);
      for (const o of this.animals) {
        if (o === a) continue;
        const ox = head.x - o.chain[SPINE];
        const oy = head.y - o.chain[SPINE + 1];
        const d = Math.hypot(ox, oy);
        if (d > 0 && d < L * 0.8) {
          dx += (ox / d) * (1 - d / (L * 0.8)) * 1.5;
          dy += (oy / d) * (1 - d / (L * 0.8)) * 1.5;
        }
      }
      const moving = a.mode !== "rest" || !onFloor;
      if (moving) {
        const maxTurn = a.dart > 0 ? 5 : a.mode === "swim" ? 1.4 : 0.6;
        const turn = wrapAngle(Math.atan2(dy, dx) - a.heading);
        a.heading += Math.max(-maxTurn * dt, Math.min(maxTurn * dt, turn));
      }

      // Speed: a slow amble on the floor, faster swimming, a quick bolt when startled.
      const pace = a.mode === "walk" && onFloor ? a.walkSpeed : a.mode === "swim" ? 0.12 : 0;
      a.speed += (pace - a.speed) * (1 - Math.exp(-dt * 2));
      if (a.dart > 0) {
        a.speed = Math.max(a.speed, 0.38 * a.dart ** 0.5);
        a.dart = Math.max(0, a.dart - dt / 0.8);
      }
      // Rising and sinking; sinking is a slow drift down.
      const rate = (a.targetDepth > a.depth ? 0.025 : 0.04) / m;
      a.depth += Math.max(-rate * dt, Math.min(rate * dt, a.targetDepth - a.depth));

      // Legs tuck back to swim and spread again to land.
      const wantTucked = a.mode === "swim" && a.speed > 0.05 ? 1 : 0;
      a.tucked += (wantTucked - a.tucked) * (1 - Math.exp(-dt * 6));

      // Move the head; the body follows.
      const step = (a.speed / m) * dt;
      a.chain[0] = Math.min(Math.max(head.x + Math.cos(a.heading) * step, 0), this.aspect);
      a.chain[1] = Math.min(Math.max(head.y + Math.sin(a.heading) * step, 0), 1);
      const segment = L / (SPINE - 1);
      let previous = a.heading;
      for (let i = 1; i < SPINE; i++) {
        const sx = a.chain[(i - 1) * 2] - a.chain[i * 2];
        const sy = a.chain[(i - 1) * 2 + 1] - a.chain[i * 2 + 1];
        let angle = Math.atan2(sy, sx);
        angle = previous + Math.max(-0.3, Math.min(0.3, wrapAngle(angle - previous)));
        a.chain[i * 2] = a.chain[(i - 1) * 2] - Math.cos(angle) * segment;
        a.chain[i * 2 + 1] = a.chain[(i - 1) * 2 + 1] - Math.sin(angle) * segment;
        previous = angle;
      }

      this.walk(a, dt, onFloor);
      a.swimPhase += Math.PI * 2 * (1 + 6 * a.speed) * dt;
      a.gillPhase += Math.PI * 2 * 0.35 * dt;

      // Swimming close to the surface leaves a wake.
      const shallow = Math.max(0, 1 - a.depth / (0.04 / m));
      const moved = Math.hypot(a.chain[0] - a.lastWake.x, a.chain[1] - a.lastWake.y) * m;
      if (shallow > 0 && moved > 0.008) {
        splash.move(a.chain[0], a.chain[1], 0.005 * shallow, (a.chain[0] - a.lastWake.x) * m, (a.chain[1] - a.lastWake.y) * m);
        a.lastWake = { x: a.chain[0], y: a.chain[1] };
      } else if (shallow === 0) {
        a.lastWake = { x: a.chain[0], y: a.chain[1] };
      }
    }
  }

  /**
   * The walking gait. Each diagonal pair spends a little under half the
   * cycle swinging forward; the rest of the time its hands stay planted.
   */
  private walk(a: Axolotl, dt: number, onFloor: boolean) {
    const L = a.length;
    const stride = 0.16 * L;
    const speed = a.speed / this.metres;
    const walking = onFloor && a.tucked < 0.5;
    let rate = walking ? speed / stride : 0;
    // After turning on the spot, take a few small steps to square up.
    if (walking && rate < 0.3) {
      const off = a.feet.some((f, leg) => {
        const h = this.home(a, leg, 0);
        return Math.hypot(f.x - h.x, f.y - h.y) > 0.07 * L;
      });
      if (off) rate = 0.8;
    }
    a.gaitPhase += Math.PI * 2 * rate * dt;
    const swingPart = 0.9 * Math.PI;
    a.feet.forEach((f, leg) => {
      if (!walking) {
        // Off the floor, hands just follow the body (tucked or splayed).
        const h = this.home(a, leg, 0);
        f.x = h.x;
        f.y = h.y;
        f.swinging = false;
        f.lift = 0;
        return;
      }
      const c = (((a.gaitPhase + LEG_OFFSET[leg]) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
      const target = this.home(a, leg, rate > 0.3 ? 0.08 : 0);
      if (c < swingPart && rate > 0) {
        if (!f.swinging) {
          f.swinging = true;
          f.fromX = f.x;
          f.fromY = f.y;
        }
        const t = c / swingPart;
        const ease = t * t * (3 - 2 * t);
        f.x = f.fromX + (target.x - f.fromX) * ease;
        f.y = f.fromY + (target.y - f.fromY) * ease;
        f.lift = Math.sin(Math.PI * t);
      } else {
        if (f.swinging) {
          f.swinging = false;
          f.x = target.x;
          f.y = target.y;
        }
        f.lift = 0;
      }
    });
  }

  /** Draws every axolotl into the underwater layer, which must be bound and blending. */
  draw(toSun: [number, number, number]) {
    const { gl } = this;
    if (this.animals.length === 0) return;
    this.upload();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    const parts = [
      [this.limbs, this.stripMesh, LEGS * 2],
      [this.gills, this.stripMesh, 6],
      [this.body, this.bodyMesh, 1],
    ] as const;
    for (const [program] of parts) {
      gl.useProgram(program.program);
      gl.uniform1i(program.uniforms.u_axolotls, 0);
      gl.uniform1f(program.uniforms.u_aspect, this.aspect);
      gl.uniform3fv(program.uniforms.u_toSun, toSun);
    }
    const order = this.animals.map((_, i) => i).sort((i, j) => this.animals[j].depth - this.animals[i].depth);
    for (const i of order) {
      for (const [program, mesh, instances] of parts) {
        gl.useProgram(program.program);
        gl.uniform1i(program.uniforms.u_index, i);
        gl.bindVertexArray(mesh.vao);
        gl.drawElementsInstanced(gl.TRIANGLES, mesh.count, gl.UNSIGNED_SHORT, 0, instances);
      }
    }
  }

  private upload() {
    const { gl, data } = this;
    const bent = new Float32Array(SPINE * 2);
    this.animals.forEach((a, row) => {
      const L = a.length;
      const onFloorWalk = (1 - a.tucked) * Math.min(a.speed / Math.max(a.walkSpeed, 1e-3), 1);
      for (let i = 0; i < SPINE; i++) {
        const u = i / (SPINE - 1);
        const j = Math.max(i, 1);
        const dx = a.chain[(j - 1) * 2] - a.chain[j * 2];
        const dy = a.chain[(j - 1) * 2 + 1] - a.chain[j * 2 + 1];
        const d = Math.hypot(dx, dy) || 1;
        // Swimming: a wave travelling down to the tail. Walking: the body
        // swings in an S, in time with the steps. Resting: the tail just stirs.
        const swim = L * (0.06 + 0.08 * a.dart) * a.tucked * (0.05 + 0.95 * u * u) * Math.sin(a.swimPhase - Math.PI * 2 * 1.1 * u);
        const walk = L * 0.035 * onFloorWalk * Math.sin(a.gaitPhase) * Math.sin(Math.PI * 2 * (u - 0.15) * 0.9);
        const idle = L * 0.012 * smoothstep(0.5, 1, u) * Math.sin(a.swimPhase * 0.08 + u * 3);
        const offset = swim + walk + idle;
        bent[i * 2] = a.chain[i * 2] - (dy / d) * offset;
        bent[i * 2 + 1] = a.chain[i * 2 + 1] + (dx / d) * offset;
      }
      const base = row * TEXELS * 4;
      for (let i = 0; i < SPINE; i++) {
        const j = Math.max(i, 1);
        const angle = Math.atan2(bent[(j - 1) * 2 + 1] - bent[j * 2 + 1], bent[(j - 1) * 2] - bent[j * 2]);
        data.set([bent[i * 2], bent[i * 2 + 1], angle, 0], base + i * 4);
      }
      data.set([L, a.depth, a.morph, a.seed], base + SPINE * 4);
      data.set([a.gillPhase, a.tucked, 0, 0], base + (SPINE + 1) * 4);
      a.feet.forEach((f, leg) => {
        const t = this.tuckedAt(a, leg);
        const x = f.x + (t.x - f.x) * a.tucked;
        const y = f.y + (t.y - f.y) * a.tucked;
        data.set([x, y, f.lift, 0], base + (SPINE + 2 + leg) * 4);
      });
    });
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, TEXELS, this.animals.length, gl.RGBA, gl.FLOAT, data);
  }

  dispose() {
    const { gl } = this;
    [this.body, this.gills, this.limbs].forEach((p) => gl.deleteProgram(p.program));
    gl.deleteVertexArray(this.bodyMesh.vao);
    gl.deleteVertexArray(this.stripMesh.vao);
    this.buffers.forEach((b) => gl.deleteBuffer(b));
    gl.deleteTexture(this.texture);
  }
}
