import { random } from "./bed";
import { Lilies } from "./lily";
import { createProgram, type Program } from "./gl";
import { NOISE } from "./shaders/common";

/*
 * Things floating on the surface: lily pads and water lilies.
 *
 * They sit above the water, so they're seen directly (no refraction) and lit
 * by the sun directly (no green tint). Each one reads the water surface
 * under it every frame and tilts with it as ripples pass.
 *
 * A lily pad hangs from a stem only a little longer than the water is deep,
 * so it can shift just a few centimetres before the stem goes taut, and the
 * stem resists twisting. A push makes it give, then settle back. Flowers
 * ride on their pads.
 *
 * They're drawn into their own layer (premultiplied, lit, linear colour),
 * which the compose pass lays over the water and uses to cast their shadows
 * onto the floor.
 */

const FLOAT_VERT = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_corner;
layout(location = 1) in vec4 a_where; // centre x, y (world units); radius (world units); angle
layout(location = 2) in vec4 a_look;  // per-kind details: seed and shape parameters

uniform float u_aspect;
uniform sampler2D u_surface; // water height and slope

out vec2 v_local;  // -1..1 across the object, in its own orientation
out vec2 v_slope;  // slope of the water beneath it
out vec4 v_look;
out float v_angle;

void main() {
  // Ride the water: the whole object tilts with the surface at its centre.
  v_slope = textureLod(u_surface, a_where.xy / vec2(u_aspect, 1.0), 0.0).yz;
  float c = cos(a_where.w), s = sin(a_where.w);
  vec2 offset = vec2(c * a_corner.x - s * a_corner.y, s * a_corner.x + c * a_corner.y) * a_where.z;
  v_local = a_corner;
  v_look = a_look;
  v_angle = a_where.w;
  vec2 world = a_where.xy + offset;
  gl_Position = vec4(world / vec2(u_aspect, 1.0) * 2.0 - 1.0, 0.0, 1.0);
}
`;

/** Shared lighting for things in open air: direct sun, sky, and a waxy sheen. */
const AIR_LIGHT = /* glsl */ `
uniform vec3 u_sun;
uniform vec3 u_sky;
const vec3 SUN_LIGHT = vec3(3.4, 3.2, 2.9);

// Turns a direction in the object's own frame into world space.
vec2 toWorld(vec2 v, float angle) {
  float c = cos(angle), s = sin(angle);
  return vec2(c * v.x - s * v.y, s * v.x + c * v.y);
}

// The scene is exposed for the water, so open-air sunlight is scaled to sit
// with it. A waxy surface also mirrors a little sky, more where it tilts.
vec3 lightInAir(vec3 albedo, vec3 normal, float sheen, float sharpness) {
  float sun = max(dot(normal, u_sun), 0.0);
  vec3 lit = albedo * (SUN_LIGHT * 0.6 * sun + u_sky * 0.2 * (0.6 + 0.4 * normal.z));
  vec3 mirror = reflect(-u_sun, normal);
  lit += SUN_LIGHT * pow(max(mirror.z, 0.0), sharpness) * sheen;
  lit += u_sky * sheen * (0.05 + 0.15 * pow(1.0 - normal.z, 3.0));
  return lit;
}
`;

const PAD_FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_local;
in vec2 v_slope;
in vec4 v_look; // seed; slit angle; how weathered 0..1; -
in float v_angle;
layout(location = 0) out vec4 o_colour;

${NOISE}
${AIR_LIGHT}

void main() {
  float r = length(v_local);
  float a = atan(v_local.y, v_local.x);
  float seed = v_look.x;
  float soft = fwidth(r) * 1.5;

  // A gently wavy, slightly ragged rim.
  float rim = 0.96 + 0.02 * sin(a * 6.0 + seed * 40.0) + 0.03 * (noise(vec2(a * 3.0, seed * 17.0)) - 0.5);
  float alpha = 1.0 - smoothstep(rim - soft, rim, r);
  // The slit: a narrow wedge running from the rim into the centre.
  float off = abs(atan(sin(a - v_look.y), cos(a - v_look.y))) * r;
  float slit = 0.035 * smoothstep(0.0, 1.0, r);
  alpha *= smoothstep(slit, slit + soft, off);
  if (alpha < 0.003) discard;

  // Flat, with the rim curling up a little; the curl tilts the edge inward.
  float curl = smoothstep(0.78, 1.0, r / rim);
  vec2 radial = toWorld(v_local / max(r, 1e-4), v_angle);
  // Real pads gently undulate, so glare off the wax breaks into patches
  // instead of the whole pad flashing at once.
  vec2 undulate = 0.07 * vec2(
    sin(v_local.x * 4.7 + seed * 7.0 + 1.3 * cos(v_local.y * 3.9)),
    cos(v_local.y * 5.3 + seed * 3.0 + 1.3 * sin(v_local.x * 4.1))
  );
  vec3 normal = normalize(vec3(-v_slope - radial * curl * 0.3 + toWorld(undulate, v_angle), 1.0));

  // Faint, irregular radial veins, fading toward the rim and the centre.
  float vein = smoothstep(0.93, 1.0, abs(cos(a * 11.0 + 2.2 * noise(vec2(r * 3.0, seed * 9.0)))));
  vein *= smoothstep(0.1, 0.35, r) * (1.0 - smoothstep(0.6, 0.9, r)) * (0.5 + 0.5 * noise(vec2(a * 5.0, seed)));

  vec3 green = mix(vec3(0.016, 0.05, 0.01), vec3(0.035, 0.08, 0.014), fbm(v_local * 2.0 + seed * 11.0));
  vec3 colour = green * (1.0 + 0.18 * vein);
  // Weathering: yellow-brown patches, and a reddish rim on older pads.
  float aged = smoothstep(0.62, 0.8, fbm(v_local * 2.6 + seed * 23.0)) * v_look.z;
  colour = mix(colour, vec3(0.16, 0.11, 0.025), aged);
  colour = mix(colour, vec3(0.09, 0.035, 0.02), smoothstep(0.86, 1.0, r / rim) * (0.3 + 0.5 * v_look.z));

  vec3 lit = lightInAir(colour, normal, 0.035 * (1.0 - aged), 40.0);
  o_colour = vec4(lit * alpha, alpha);
}
`;

// A lily casts a soft shadow on its pad, away from the sun. The flower
// itself is 3D and drawn separately (see lily.ts).
const FLOWER_SHADOW_FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_local;
in vec2 v_slope;
in vec4 v_look;
in float v_angle;
layout(location = 0) out vec4 o_colour;

${AIR_LIGHT}

void main() {
  vec2 away = toWorld(-u_sun.xy / u_sun.z, -v_angle) * 0.14;
  float shadow = (1.0 - smoothstep(0.45, 0.95, length(v_local - away))) * 0.45;
  if (shadow < 0.003) discard;
  o_colour = vec4(0.0, 0.0, 0.0, shadow);
}
`;

type Kind = "pad" | "flower";

interface Floater {
  kind: Kind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  spin: number;
  /** World units. */
  radius: number;
  /** Where a pad's stem holds it, its resting angle, and how far it can stray (world units). */
  stem: { x: number; y: number; angle: number; slack: number } | null;
  /** Kind-specific shape details, passed to the shader. */
  look: [number, number, number, number];
  /** A flower rides on this pad, at this offset in the pad's own frame. */
  host?: Floater;
  offset?: { x: number; y: number };
}

export interface FloatingCounts {
  lilies: number;
  flowers: number;
}

export interface Finger {
  /** World units. */
  x: number;
  y: number;
  /** World units per second. */
  vx: number;
  vy: number;
  /** World units. */
  radius: number;
}

const FLOATS_PER_INSTANCE = 8;
const MAX_INSTANCES = 256;

/** How motion dies away in water, per second. */
const WATER_DRAG = 2.5;
/** Buoyancy and stem tension draw a pad back to rest, per second squared. */
const SETTLE = 1.5;
/** The stem resists twisting: a spring back to rest, per second squared, and how far it can turn (radians). */
const TWIST = 2;
const MAX_TWIST = 0.5;
const SPIN_DRAG = 3;

export class Floating {
  private floaters: Floater[] = [];
  private programs: Record<Kind, Program>;
  private vao: WebGLVertexArrayObject;
  private buffers: WebGLBuffer[];
  private instances = new Float32Array(MAX_INSTANCES * FLOATS_PER_INSTANCE);
  private target: { framebuffer: WebGLFramebuffer; texture: WebGLTexture; width: number; height: number } | null = null;
  private aspect = 1;
  private lilies: Lilies;

  constructor(private gl: WebGL2RenderingContext) {
    this.programs = {
      pad: createProgram(gl, FLOAT_VERT, PAD_FRAG),
      flower: createProgram(gl, FLOAT_VERT, FLOWER_SHADOW_FRAG),
    };
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    const corners = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, corners);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    // Both programs share one vertex shader with fixed attribute locations.
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const instanceBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.instances.byteLength, gl.DYNAMIC_DRAW);
    for (const [location, offset] of [[1, 0], [2, 16]] as const) {
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, 4, gl.FLOAT, false, FLOATS_PER_INSTANCE * 4, offset);
      gl.vertexAttribDivisor(location, 1);
    }
    gl.bindVertexArray(null);
    this.buffers = [corners, instanceBuffer];
    this.lilies = new Lilies(gl);
  }

  /** The floating layer: premultiplied lit colour and coverage, mipmapped for soft shadows. */
  get texture() {
    return this.target?.texture ?? null;
  }

  /**
   * Places everything for a pond `aspect` wide and 1 tall. `metres` per world
   * unit keeps sizes real: pads 14 to 26 cm across, lilies 10 to 14 cm.
   */
  place(counts: FloatingCounts, seed: number, aspect: number, metres: number) {
    const rand = random(seed * 104729 + 7);
    const m = 1 / metres;
    this.aspect = aspect;

    // Lily pads grow in a few colonies, each toward a different corner.
    const pads: Floater[] = [];
    const colonies = Math.max(1, Math.round(counts.lilies / 4));
    const corners = [0, 1, 2, 3].sort(() => rand() - 0.5);
    for (let c = 0; c < colonies && pads.length < counts.lilies; c++) {
      const corner = corners[c % 4];
      const cx = (corner % 2 === 0 ? 0.08 + 0.15 * rand() : 0.77 + 0.15 * rand()) * aspect;
      const cy = corner < 2 ? 0.1 + 0.2 * rand() : 0.7 + 0.2 * rand();
      const inColony = Math.ceil(counts.lilies / colonies);
      for (let i = 0; i < inColony && pads.length < counts.lilies; i++) {
        const radius = (0.07 + 0.06 * rand()) * m;
        const angle = rand() * Math.PI * 2;
        const spread = 0.18 * m * Math.sqrt(rand());
        const x = cx + Math.cos(angle) * spread;
        const y = cy + Math.sin(angle) * spread;
        const rest = rand() * Math.PI * 2;
        pads.push({
          kind: "pad",
          x,
          y,
          vx: 0,
          vy: 0,
          angle: rest,
          spin: 0,
          radius,
          stem: { x, y, angle: rest, slack: (0.03 + 0.02 * rand()) * m },
          look: [rand(), rand() * Math.PI * 2, rand() ** 2, 0],
        });
      }
    }

    // Lilies open on some of the pads, near the middle.
    const flowers: Floater[] = [];
    for (let i = 0; i < Math.min(counts.flowers, pads.length); i++) {
      const host = pads[Math.floor((i * pads.length) / Math.max(counts.flowers, 1))];
      flowers.push({
        kind: "flower",
        x: host.x,
        y: host.y,
        vx: 0,
        vy: 0,
        angle: rand() * Math.PI * 2,
        spin: 0,
        radius: (0.05 + 0.02 * rand()) * m,
        stem: null,
        look: [rand(), rand() < 0.5 ? 0.15 : 0.7 + 0.3 * rand(), 0.7 + 0.3 * rand(), 0],
        host,
        offset: { x: (rand() - 0.5) * host.radius * 0.5, y: (rand() - 0.5) * host.radius * 0.5 },
      });
    }

    this.floaters = [...pads, ...flowers];
    this.lilies.set(flowers.map((f) => [f.look[0], f.look[1], f.look[2]]));
  }

  /** A tap on the water: a pad it lands on is nudged away from it and turned a little. */
  tap(x: number, y: number) {
    for (const f of this.floaters) {
      if (f.kind !== "pad") continue;
      const dx = f.x - x;
      const dy = f.y - y;
      const d = Math.hypot(dx, dy);
      if (d > f.radius) continue;
      const push = f.radius * 0.3;
      f.vx += (dx / (d || 1)) * push;
      f.vy += (dy / (d || 1)) * push;
      f.spin += (Math.random() - 0.5) * 0.4;
    }
  }

  /** Advances the motion by dt seconds, with an optional finger in the water. */
  step(dt: number, finger: Finger | null) {
    const pads = this.floaters.filter((f) => f.kind === "pad");
    for (const f of pads) {
      const stem = f.stem!;
      f.vx -= (f.x - stem.x) * SETTLE * dt;
      f.vy -= (f.y - stem.y) * SETTLE * dt;
      f.spin -= (f.angle - stem.angle) * TWIST * dt;
      if (finger) this.push(f, finger);
      const drag = Math.exp(-WATER_DRAG * dt);
      f.vx *= drag;
      f.vy *= drag;
      f.spin *= Math.exp(-SPIN_DRAG * dt);
      f.x += f.vx * dt;
      f.y += f.vy * dt;
      f.angle += f.spin * dt;
      this.holdByStem(f);
    }
    // Pads jostle rather than pass through each other; they may overlap a little.
    for (let i = 0; i < pads.length; i++) {
      for (let j = i + 1; j < pads.length; j++) {
        const a = pads[i];
        const b = pads[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d = Math.hypot(dx, dy) || 1e-6;
        const overlap = (a.radius + b.radius) * 0.8 - d;
        if (overlap <= 0) continue;
        const nx = dx / d;
        const ny = dy / d;
        a.x -= (nx * overlap) / 2;
        a.y -= (ny * overlap) / 2;
        b.x += (nx * overlap) / 2;
        b.y += (ny * overlap) / 2;
        this.holdByStem(a);
        this.holdByStem(b);
      }
    }
    // Flowers ride their pads.
    for (const f of this.floaters) {
      if (!f.host || !f.offset) continue;
      const c = Math.cos(f.host.angle);
      const s = Math.sin(f.host.angle);
      f.x = f.host.x + c * f.offset.x - s * f.offset.y;
      f.y = f.host.y + s * f.offset.x + c * f.offset.y;
    }
  }

  /** A taut stem stops a pad dead: no further out, and no more twist than it allows. */
  private holdByStem(f: Floater) {
    const stem = f.stem!;
    const dx = f.x - stem.x;
    const dy = f.y - stem.y;
    const d = Math.hypot(dx, dy);
    if (d > stem.slack) {
      const nx = dx / d;
      const ny = dy / d;
      f.x = stem.x + nx * stem.slack;
      f.y = stem.y + ny * stem.slack;
      const outward = f.vx * nx + f.vy * ny;
      if (outward > 0) {
        f.vx -= nx * outward;
        f.vy -= ny * outward;
      }
    }
    const twist = f.angle - stem.angle;
    if (Math.abs(twist) > MAX_TWIST) {
      f.angle = stem.angle + Math.sign(twist) * MAX_TWIST;
      if (Math.sign(f.spin) === Math.sign(twist)) f.spin = 0;
    }
  }

  /** A finger shoves a pad it touches, as far as the pad's stem lets it go. */
  private push(f: Floater, finger: Finger) {
    const dx = f.x - finger.x;
    const dy = f.y - finger.y;
    const d = Math.hypot(dx, dy) || 1e-6;
    const reach = f.radius + finger.radius;
    if (d >= reach) return;
    const nx = dx / d;
    const ny = dy / d;
    // Carried along as far as the finger is moving into it...
    const into = finger.vx * nx + finger.vy * ny - (f.vx * nx + f.vy * ny);
    if (into > 0) {
      f.vx += nx * into;
      f.vy += ny * into;
    }
    // ...and turned a little, when it's pushed off-centre.
    const cross = dx * finger.vy - dy * finger.vx;
    f.spin += (cross / (reach * reach)) * 0.05;
  }

  /** Redraws the floating layer for a canvas of this size. */
  draw(width: number, height: number, surface: WebGLTexture, sun: [number, number, number], sky: [number, number, number]) {
    const { gl } = this;
    this.ensureTarget(width, height);
    const target = this.target!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.viewport(0, 0, target.width, target.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers[1]);

    for (const kind of ["pad", "flower"] as const) {
      const count = this.fill(kind);
      if (count === 0) continue;
      const { program, uniforms } = this.programs[kind];
      gl.useProgram(program);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, surface);
      gl.uniform1i(uniforms.u_surface, 0);
      gl.uniform1f(uniforms.u_aspect, width / height);
      gl.uniform3fv(uniforms.u_sun, sun);
      gl.uniform3fv(uniforms.u_sky, sky);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.instances, 0, count * FLOATS_PER_INSTANCE);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
    }

    // The flowers themselves, in 3D, over their shadows.
    this.lilies.draw(
      this.floaters.filter((f) => f.kind === "flower"),
      width / height,
      surface,
      sun,
      sky,
    );

    gl.disable(gl.BLEND);
    gl.bindTexture(gl.TEXTURE_2D, target.texture);
    gl.generateMipmap(gl.TEXTURE_2D);
  }

  /** Writes one kind's instances into the upload array; returns how many. */
  private fill(kind: Kind) {
    let n = 0;
    for (const f of this.floaters) {
      if (f.kind !== kind || n >= MAX_INSTANCES) continue;
      this.instances.set([f.x, f.y, f.radius, f.angle, ...f.look], n * FLOATS_PER_INSTANCE);
      n++;
    }
    return n;
  }

  private ensureTarget(width: number, height: number) {
    const { gl } = this;
    if (this.target?.width === width && this.target?.height === height) return;
    if (this.target) {
      gl.deleteFramebuffer(this.target.framebuffer);
      gl.deleteTexture(this.target.texture);
    }
    const texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, width, height, 0, gl.RGBA, gl.HALF_FLOAT, null);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const framebuffer = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    this.target = { framebuffer, texture, width, height };
  }

  dispose() {
    const { gl } = this;
    Object.values(this.programs).forEach((p) => gl.deleteProgram(p.program));
    this.lilies.dispose();
    gl.deleteVertexArray(this.vao);
    this.buffers.forEach((b) => gl.deleteBuffer(b));
    if (this.target) {
      gl.deleteFramebuffer(this.target.framebuffer);
      gl.deleteTexture(this.target.texture);
    }
  }
}
