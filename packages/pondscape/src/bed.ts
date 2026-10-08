import { createFloatTarget, createProgram, deleteTarget, FULLSCREEN_VERT, type Program, type Target } from "./gl";
import { BED_DEPTH, NOISE } from "./shaders/common";

/*
 * The pond floor: its colour and how far it rises above the base depth,
 * stored in one texture (rgb = colour, a = height in world units). It doesn't
 * move, so it's drawn once per size change rather than every frame.
 *
 * It holds algae-covered silt, patches of small pebbles, and a few river
 * stones. Stones are flattened domes, so they reach up toward the light:
 * the water over them is shallower, caustics land on their tops, and the
 * sun shades their sides, which is what makes them read as solid.
 */

const MAX_STONES = 16;

const BED_FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o_bed;

uniform float u_aspect;
uniform vec3 u_silt;
uniform int u_count;
uniform vec4 u_stone[${MAX_STONES}]; // centre x, y; radius x, y (world units)
uniform vec4 u_look[${MAX_STONES}];  // angle; height (world units); seed; tone 0..1

${NOISE}

vec3 siltAlbedo(vec2 p) {
  // Algae-covered silt: blotchy green-brown with fine speckle.
  float blotch = fbm(p * 3.0);
  float fine = fbm(p * 22.0);
  vec3 c = u_silt * (0.6 + 0.8 * blotch);
  c = mix(c, c * vec3(1.25, 1.05, 0.7), smoothstep(0.55, 0.75, fbm(p * 5.0 + 9.0)));
  c *= 0.75 + 0.5 * fine;
  return c * mix(0.55, 1.0, smoothstep(0.3, 0.55, fbm(p * 9.0 + 3.0)));
}

// Natural river-stone colours, linear: slate, olive, umber, pale granite.
vec3 stoneBase(float tone) {
  vec3 slate = vec3(0.045, 0.048, 0.047);
  vec3 olive = vec3(0.075, 0.072, 0.045);
  vec3 umber = vec3(0.10, 0.075, 0.05);
  vec3 pale = vec3(0.20, 0.19, 0.16);
  if (tone < 0.33) return mix(slate, olive, tone / 0.33);
  if (tone < 0.66) return mix(olive, umber, (tone - 0.33) / 0.33);
  return mix(umber, pale, (tone - 0.66) / 0.34);
}

vec3 stoneAlbedo(vec2 q, float r, float seed, float tone) {
  vec3 c = stoneBase(tone);
  vec2 s = q * 2.2 + seed * 17.0;
  c *= 0.7 + 0.6 * fbm(s);                          // mottling
  c *= 0.9 + 0.2 * hash(floor(q * 60.0) + seed);    // grain
  // A film of algae, thickest toward the bottom edges where silt settles.
  vec3 algae = vec3(0.035, 0.06, 0.02);
  return mix(c, algae, smoothstep(0.55, 1.0, r) * 0.6);
}

void main() {
  vec2 p = v_uv * vec2(u_aspect, 1.0);
  vec3 albedo = siltAlbedo(p);
  float height = 0.0;

  // Patches of small pebbles half sunk in the silt (cells about 2.5 cm).
  float patchMask = smoothstep(0.52, 0.68, fbm(p * 2.2 + 5.0));
  if (patchMask > 0.0) {
    vec2 cell = floor(p * 32.0);
    vec2 f = fract(p * 32.0);
    for (int y = -1; y <= 1; y++) {
      for (int x = -1; x <= 1; x++) {
        vec2 g = cell + vec2(x, y);
        vec2 centre = vec2(x, y) + 0.2 + 0.6 * vec2(hash(g), hash(g + 7.7));
        float size = 0.28 + 0.2 * hash(g + 3.1);
        float r = length(f - centre) / size;
        if (r < 1.0 && hash(g + 9.4) < patchMask * 0.7) {
          float h = 0.003 * (1.0 - pow(r, 2.5));
          if (h > height) {
            height = h;
            // Half sunk: the rim disappears into the silt rather than sitting on it.
            vec3 pebble = stoneBase(0.6 * hash(g + 5.5)) * (0.75 + 0.5 * hash(g + 1.3));
            albedo = mix(albedo, pebble, smoothstep(1.0, 0.65, r));
          }
        }
      }
    }
  }

  float contact = 1.0;
  for (int i = 0; i < ${MAX_STONES}; i++) {
    if (i >= u_count) break;
    vec4 s = u_stone[i];
    vec4 look = u_look[i];
    vec2 d = p - s.xy;
    float c = cos(look.x), sn = sin(look.x);
    vec2 q = vec2(c * d.x + sn * d.y, -sn * d.x + c * d.y) / s.zw;
    // Real stones aren't perfect ellipses: wobble the outline a little.
    float wobble = 1.0 + 0.16 * (noise(normalize(q + 1e-4) * 1.6 + look.z * 13.0) - 0.5);
    float r = length(q) * wobble;
    // Silt darkens just outside a stone: less light reaches into the crease.
    if (r >= 1.0) contact *= mix(0.65, 1.0, smoothstep(1.0, 1.35, r));
    if (r < 1.0) {
      float h = look.y * (1.0 - pow(r, 2.5)); // flattish top, rounded shoulders
      if (h > height) {
        height = h;
        albedo = stoneAlbedo(q, r, look.z, look.w);
      }
    }
  }
  albedo *= contact;

  o_bed = vec4(albedo, height);
}
`;

// The floor's depth below the surface (the bed's base depth less the
// height of any pebble or stone on it), and how steeply the floor rises.
const FLOOR_FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o_floor;

uniform float u_depth;
uniform float u_aspect;
uniform sampler2D u_bedMap;

${NOISE}
${BED_DEPTH}

void main() {
  float height = texture(u_bedMap, v_uv).a;
  vec2 texel = 1.0 / vec2(textureSize(u_bedMap, 0));
  vec2 rise = vec2(
    texture(u_bedMap, v_uv + vec2(texel.x, 0.0)).a - texture(u_bedMap, v_uv - vec2(texel.x, 0.0)).a,
    texture(u_bedMap, v_uv + vec2(0.0, texel.y)).a - texture(u_bedMap, v_uv - vec2(0.0, texel.y)).a
  ) / (2.0 * texel * vec2(u_aspect, 1.0));
  o_floor = vec4(bedDepth(v_uv * vec2(u_aspect, 1.0)) - height, rise, 1.0);
}
`;

export interface Stone {
  x: number;
  y: number;
  radiusX: number;
  radiusY: number;
  angle: number;
  height: number;
  seed: number;
  tone: number;
}

/** A small seeded random generator (mulberry32), so a seed always gives the same pond. */
export function random(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Scatters stones over a pond `aspect` wide and 1 tall, leaving gaps between
 * them. `metres` per world unit keeps stone sizes real: 6 to 16 cm across.
 */
export function scatterStones(count: number, seed: number, aspect: number, metres: number): Stone[] {
  const rand = random(seed);
  const stones: Stone[] = [];
  for (let tries = 0; stones.length < Math.min(count, MAX_STONES) && tries < count * 40; tries++) {
    const size = (0.03 + 0.05 * rand() ** 1.5) / metres; // half-length, world units
    const stone: Stone = {
      x: size + rand() * (aspect - 2 * size),
      y: size + rand() * (1 - 2 * size),
      radiusX: size,
      radiusY: size * (0.6 + 0.3 * rand()),
      angle: rand() * Math.PI,
      height: size * (0.35 + 0.2 * rand()),
      seed: rand(),
      tone: rand(),
    };
    const clear = stones.every(
      (s) => Math.hypot(s.x - stone.x, s.y - stone.y) > (s.radiusX + stone.radiusX) * 1.3,
    );
    if (clear) stones.push(stone);
  }
  return stones;
}

export class Bed {
  private program: Program;
  private floorProgram: Program;
  private target: Target | null = null;
  private floorTarget: Target | null = null;

  constructor(private gl: WebGL2RenderingContext) {
    this.program = createProgram(gl, FULLSCREEN_VERT, BED_FRAG);
    this.floorProgram = createProgram(gl, FULLSCREEN_VERT, FLOOR_FRAG);
  }

  /** The bed map: rgb = linear colour, a = height above the base depth (world units). */
  get texture() {
    return this.target?.texture ?? null;
  }

  /** The floor map: r = depth of the floor below the surface (world units); gb = its slope. */
  get floor() {
    return this.floorTarget?.texture ?? null;
  }

  /** Redraws the bed for a canvas of this shape, `depth` being the pond's base depth. */
  draw(
    width: number,
    height: number,
    emptyVao: WebGLVertexArrayObject,
    silt: [number, number, number],
    stones: Stone[],
    depth: number,
  ) {
    const { gl } = this;
    if (this.target?.width !== width || this.target?.height !== height) {
      if (this.target) deleteTarget(gl, this.target);
      if (this.floorTarget) deleteTarget(gl, this.floorTarget);
      this.target = createFloatTarget(gl, width, height);
      this.floorTarget = createFloatTarget(gl, width, height);
    }
    const stoneData = new Float32Array(MAX_STONES * 4);
    const lookData = new Float32Array(MAX_STONES * 4);
    stones.forEach((s, i) => {
      stoneData.set([s.x, s.y, s.radiusX, s.radiusY], i * 4);
      lookData.set([s.angle, s.height, s.seed, s.tone], i * 4);
    });

    const { program, uniforms } = this.program;
    gl.bindVertexArray(emptyVao);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.target!.framebuffer);
    gl.viewport(0, 0, width, height);
    gl.useProgram(program);
    gl.uniform1f(uniforms.u_aspect, width / height);
    gl.uniform3fv(uniforms.u_silt, silt);
    gl.uniform1i(uniforms.u_count, stones.length);
    gl.uniform4fv(uniforms["u_stone[0]"], stoneData);
    gl.uniform4fv(uniforms["u_look[0]"], lookData);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    const floor = this.floorProgram;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.floorTarget!.framebuffer);
    gl.useProgram(floor.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.target!.texture);
    gl.uniform1i(floor.uniforms.u_bedMap, 0);
    gl.uniform1f(floor.uniforms.u_depth, depth);
    gl.uniform1f(floor.uniforms.u_aspect, width / height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  dispose() {
    if (this.target) deleteTarget(this.gl, this.target);
    if (this.floorTarget) deleteTarget(this.gl, this.floorTarget);
    this.gl.deleteProgram(this.program.program);
    this.gl.deleteProgram(this.floorProgram.program);
  }
}
