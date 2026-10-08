import { random } from "./bed";
import { createProgram, type Program } from "./gl";

/*
 * Water lily flowers, built in 3D the way the real flower is.
 *
 * Every organ (sepal, petal, stamen) is one small curved surface: a pointed
 * oval, cupped across its width so its sides rise, curving up toward its
 * tip, with a slight twist. They're set on a golden-angle spiral, as real
 * petals are: four broad sepals lying flat underneath, then petals leaning
 * up more and more toward the centre until they stand in a bowl, then a
 * spiral of slim golden stamens curving in over a domed stigma. Each organ
 * gets its own size, lean, bend and twist, so no two petals or flowers match.
 *
 * Seen from straight above, the 3D shape does the work: inner petals look
 * shorter and show their inner faces, and the sun lights each surface by how
 * it truly faces. Organs are drawn outermost first, so inner ones (which sit
 * higher) cover them, with no depth buffer needed.
 */

const ALONG = 12;
const ACROSS = 8;

const SEPAL = 0;
const PETAL = 1;
const STAMEN = 2;
const STIGMA = 3;

const LILY_VERT = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_uv;    // along the organ 0..1; across -1..1
layout(location = 1) in vec4 a_shape; // turn around the flower; lean up from flat; length; width / length
layout(location = 2) in vec4 a_bend;  // cup; upward curve; twist; distance out from the centre
layout(location = 3) in vec4 a_kind;  // kind; blush; how far in 0..1; seed

uniform vec2 u_centre;   // world units
uniform float u_angle;
uniform float u_radius;  // world units per flower unit
uniform float u_aspect;
uniform sampler2D u_surface;

out vec3 v_normal;
out vec2 v_uv;
out vec4 v_kind;

vec2 turn(vec2 p, float a) {
  float c = cos(a), s = sin(a);
  return vec2(c * p.x - s * p.y, s * p.x + c * p.y);
}

// A point on this organ, in the flower's own frame (radius about 1, z up).
vec3 organ(vec2 uv) {
  float u = clamp(uv.x, 0.0, 1.0), v = uv.y;
  if (a_kind.x == ${STIGMA}.0) {
    // A low dome at the centre.
    float r = 0.13 * u;
    float a = v * 3.14159;
    return vec3(r * cos(a), r * sin(a), 0.2 + 0.035 * (1.0 - u * u));
  }
  float len = a_shape.z;
  // An oblong oval with a blunt, rounded tip, widest a little past the middle.
  float halfWidth = a_shape.w * len * pow(max(sin(3.14159 * pow(u, 0.7)), 0.0), 0.45);
  vec3 p = vec3(len * u, halfWidth * v, 0.0);
  p.z += a_bend.x * halfWidth * v * v; // cupped: the sides rise
  p.z += a_bend.y * len * u * u;       // curving up toward the tip
  p.yz = turn(p.yz, a_bend.z * u);     // a slight twist along its length
  p.xz = turn(p.xz, a_shape.y);        // leaning up from flat
  p.x += a_bend.w;                     // out from the centre
  p.xy = turn(p.xy, a_shape.x);        // around the flower
  p.z += 0.04 + 0.16 * a_kind.z;       // inner organs grow from higher up
  return p;
}

void main() {
  vec2 uv = vec2(max(a_uv.x, 0.02), a_uv.y);
  vec3 p = organ(uv);
  vec3 alongDir = organ(uv + vec2(0.01, 0.0)) - organ(uv - vec2(0.01, 0.0));
  vec3 acrossDir = organ(uv + vec2(0.0, 0.02)) - organ(uv - vec2(0.0, 0.02));
  vec3 normal = normalize(cross(alongDir, acrossDir));

  // Into the world: turned with the flower, tilted with the water under it.
  vec2 slope = textureLod(u_surface, u_centre / vec2(u_aspect, 1.0), 0.0).yz;
  normal.xy = turn(normal.xy, u_angle);
  v_normal = normalize(normal - vec3(slope * normal.z, 0.0));
  v_uv = a_uv;
  v_kind = a_kind;
  vec2 world = u_centre + turn(p.xy, u_angle) * u_radius;
  gl_Position = vec4(world / vec2(u_aspect, 1.0) * 2.0 - 1.0, 0.0, 1.0);
}
`;

const LILY_FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec3 v_normal;
in vec2 v_uv;
in vec4 v_kind;
layout(location = 0) out vec4 o_colour;

uniform vec3 u_sun;
uniform vec3 u_sky;
const vec3 SUN_LIGHT = vec3(3.4, 3.2, 2.9);

void main() {
  float u = v_uv.x, v = v_uv.y;
  float kind = v_kind.x;
  float inner = v_kind.z;
  vec3 normal = normalize(v_normal);
  // We may be looking at an organ's underside; light the side we see.
  bool underside = normal.z < 0.0;
  if (underside) normal = -normal;

  vec3 colour;
  float occlusion = 1.0;
  if (kind == ${SEPAL}.0) {
    // Whitish above, washed with green toward the base.
    colour = mix(vec3(0.24, 0.32, 0.14), vec3(0.6, 0.62, 0.52), smoothstep(0.15, 0.85, u));
    occlusion = mix(0.7, 1.0, smoothstep(0.0, 0.4, u));
  } else if (kind == ${PETAL}.0) {
    // Cream at the base, white through the body, a blush toward the tip.
    colour = mix(vec3(0.66, 0.62, 0.45), vec3(0.74, 0.73, 0.69), smoothstep(0.0, 0.35, u));
    colour = mix(colour, vec3(0.74, 0.4, 0.5), clamp(v_kind.y * smoothstep(0.35, 1.0, u), 0.0, 0.7));
    // Light bouncing off the golden stamens tints the inner petals' bases.
    colour = mix(colour, vec3(0.75, 0.6, 0.2), inner * (1.0 - smoothstep(0.0, 0.55, u)) * 0.55);
    // Faint veins running lengthwise.
    colour *= 1.0 - 0.04 * smoothstep(0.5, 1.0, sin(v * 15.0 + v_kind.w * 20.0)) * (1.0 - u);
    // Each petal catches the light a little differently.
    colour *= mix(0.95, 1.02, fract(v_kind.w * 37.0));
    if (underside) colour *= vec3(0.86, 0.9, 0.82);
    // Deep in the cup, less light gets in.
    occlusion = mix(mix(0.66, 0.8, inner), 1.0, smoothstep(0.0, 0.55, u));
  } else if (kind == ${STAMEN}.0) {
    // Golden filaments with brighter anthers at their tips.
    colour = mix(vec3(0.55, 0.36, 0.04), vec3(0.82, 0.62, 0.1), smoothstep(0.3, 0.9, u));
    occlusion = mix(0.7, 1.0, u);
  } else {
    // The stigma: a yellow-green dome with fine radiating ridges.
    float ridges = smoothstep(0.3, 1.0, sin(v * 3.14159 * 14.0)) * smoothstep(0.2, 0.6, u);
    colour = mix(vec3(0.34, 0.32, 0.06), vec3(0.6, 0.48, 0.08), ridges);
  }
  colour *= occlusion;

  // Soft light, to sit with the rest of the pond: it wraps around each petal
  // rather than splitting it into a sunny side and a shadowed one, and much
  // of it is the glow of sunlight through the thin petals, which is even.
  float wrap = clamp((dot(normal, u_sun) + 0.4) / 1.4, 0.0, 1.0);
  vec3 lit = colour * (SUN_LIGHT * 0.34 * wrap + u_sky * 0.2);
  float behind = max(dot(-normalize(v_normal), u_sun), 0.0);
  lit += colour * vec3(1.0, 0.95, 0.86) * SUN_LIGHT * (kind == ${PETAL}.0 ? 0.13 : 0.06) * (0.6 + 0.4 * behind);

  // Wide, melting edges, so petals blend into one another.
  float alpha = kind == ${STIGMA}.0 ? 1.0
    : (1.0 - smoothstep(0.45, 1.0, abs(v))) * (1.0 - smoothstep(0.88, 1.0, u));
  o_colour = vec4(lit * alpha, alpha);
}
`;

const FLOATS_PER_ORGAN = 12;

/** One flower's organs, outermost first. */
function buildFlower(seed: number, pinkness: number, openness: number) {
  const rand = random(Math.floor(seed * 1e6) + 17);
  const organs: number[][] = [];
  const golden = 2.39996323;
  const jitter = (amount: number) => (rand() - 0.5) * 2 * amount;
  const base = rand() * Math.PI * 2;

  // Sepals: four broad ones lying nearly flat beneath everything.
  for (let k = 0; k < 4; k++) {
    organs.push([
      base + (k * Math.PI) / 2 + jitter(0.2),
      0.04 + jitter(0.05),
      0.86 + jitter(0.06),
      0.24 + jitter(0.03),
      0.35,
      0.1,
      jitter(0.1),
      0.08,
      SEPAL,
      0,
      0,
      rand(),
    ]);
  }

  // Petals on a golden-angle spiral, leaning up more toward the centre.
  const petals = Math.round(20 + 8 * rand());
  for (let i = 0; i < petals; i++) {
    const f = i / petals;
    const lean = (0.08 + 0.7 * f ** 0.9) * (1.2 - 0.2 * openness) + jitter(0.1);
    organs.push([
      base + i * golden + jitter(0.12),
      Math.min(lean, 0.95),
      (0.92 - 0.38 * f) * (1 + jitter(0.08)) * (0.85 + 0.15 * openness),
      (0.25 - 0.06 * f) * (1 + jitter(0.12)),
      0.4 + 0.3 * rand(),
      0.12 + 0.25 * f + jitter(0.06),
      jitter(0.18),
      0.09 + 0.03 * f,
      PETAL,
      pinkness * (0.5 + 0.7 * rand()),
      f,
      rand(),
    ]);
  }

  // Stamens: slim, nearly upright, their tips curving in over the centre.
  for (let j = 0; j < 40; j++) {
    const f = j / 40;
    organs.push([
      base + j * golden,
      0.6 + 0.35 * f + jitter(0.1),
      (0.28 - 0.1 * f) * (1 + jitter(0.12)),
      0.08,
      0.2,
      0.35,
      jitter(0.3),
      0.1 - 0.03 * f,
      STAMEN,
      0,
      0.85 + 0.15 * f,
      rand(),
    ]);
  }

  organs.push([0, 0, 0, 0, 0, 0, 0, 0, STIGMA, 0, 1, 0]);
  return organs;
}

export interface LilyPose {
  x: number;
  y: number;
  angle: number;
  radius: number;
}

export class Lilies {
  private program: Program;
  private vao: WebGLVertexArrayObject;
  private buffers: WebGLBuffer[];
  private indexCount: number;
  /** Where each flower's organs start in the instance buffer, and how many. */
  private flowers: { first: number; count: number }[] = [];

  constructor(private gl: WebGL2RenderingContext) {
    this.program = createProgram(gl, LILY_VERT, LILY_FRAG);
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);

    // One organ's surface: a grid running along and across it.
    const grid: number[] = [];
    for (let i = 0; i <= ALONG; i++) {
      for (let j = 0; j <= ACROSS; j++) grid.push(i / ALONG, (j / ACROSS) * 2 - 1);
    }
    const indices: number[] = [];
    for (let i = 0; i < ALONG; i++) {
      for (let j = 0; j < ACROSS; j++) {
        const a = i * (ACROSS + 1) + j;
        const b = a + ACROSS + 1;
        indices.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
    const gridBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, gridBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(grid), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const indexBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(indices), gl.STATIC_DRAW);
    this.indexCount = indices.length;

    const organBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, organBuffer);
    for (const location of [1, 2, 3]) {
      gl.enableVertexAttribArray(location);
      gl.vertexAttribDivisor(location, 1);
    }
    gl.bindVertexArray(null);
    this.buffers = [gridBuffer, indexBuffer, organBuffer];
  }

  /** Builds the flowers' organs: one entry per flower, as [seed, pinkness, openness]. */
  set(flowers: [number, number, number][]) {
    const { gl } = this;
    const all: number[] = [];
    this.flowers = flowers.map(([seed, pinkness, openness]) => {
      const organs = buildFlower(seed, pinkness, openness);
      const first = all.length / FLOATS_PER_ORGAN;
      organs.forEach((o) => all.push(...o));
      return { first, count: organs.length };
    });
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers[2]);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(all), gl.STATIC_DRAW);
  }

  /**
   * Draws each flower where it now sits, into the bound layer (premultiplied
   * blending must be on). `poses` match the order given to set().
   */
  draw(poses: LilyPose[], aspect: number, surface: WebGLTexture, sun: [number, number, number], sky: [number, number, number]) {
    const { gl } = this;
    const { program, uniforms } = this.program;
    gl.useProgram(program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, surface);
    gl.uniform1i(uniforms.u_surface, 0);
    gl.uniform1f(uniforms.u_aspect, aspect);
    gl.uniform3fv(uniforms.u_sun, sun);
    gl.uniform3fv(uniforms.u_sky, sky);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers[2]);
    const stride = FLOATS_PER_ORGAN * 4;
    poses.forEach((pose, i) => {
      const flower = this.flowers[i];
      if (!flower) return;
      // WebGL2 can't start an instanced draw partway through the buffer, so
      // point the per-organ attributes at this flower's organs instead.
      for (const [location, offset] of [[1, 0], [2, 16], [3, 32]] as const) {
        gl.vertexAttribPointer(location, 4, gl.FLOAT, false, stride, flower.first * stride + offset);
      }
      gl.uniform2f(uniforms.u_centre, pose.x, pose.y);
      gl.uniform1f(uniforms.u_angle, pose.angle);
      gl.uniform1f(uniforms.u_radius, pose.radius);
      gl.drawElementsInstanced(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_SHORT, 0, flower.count);
    });
  }

  dispose() {
    const { gl } = this;
    gl.deleteProgram(this.program.program);
    gl.deleteVertexArray(this.vao);
    this.buffers.forEach((b) => gl.deleteBuffer(b));
  }
}
