import { random } from "./bed";
import { createProgram, type Program } from "./gl";
import { BED, NOISE } from "./shaders/common";

/*
 * Pond grass: long ribbon blades growing in clumps, rising from the floor
 * toward the surface and leaning with a slow current. Seen from above, each
 * blade is a tapering curve from root to tip. They're drawn into the
 * underwater layer, which lights them and lets them cast shadows.
 */

const SEGMENTS = 14;

const GRASS_VERT = /* glsl */ `#version 300 es
precision highp float;
in vec2 a_along;  // position along the blade 0..1; which edge -1 or 1
in vec4 a_root;   // root x, y (world units); lean angle; phase
in vec2 a_size;   // length, width at the root (world units)

uniform float u_time;
uniform float u_current; // the current's direction, radians

${NOISE}
${BED}

out float v_along;
out float v_edge;
out float v_depth;
out float v_phase;

void main() {
  float s = a_along.x;
  float phase = a_root.w;
  // The current sways the blade, more toward the free tip, in slow
  // overlapping rhythms so neighbouring blades don't move in lockstep.
  float sway = (sin(u_time * 0.7 + phase * 6.28 + s * 2.2) * 0.22
    + sin(u_time * 1.3 + phase * 3.1 + s * 3.5) * 0.08) * s;
  // Blades lean downstream, more as they rise.
  float lean = mix(a_root.z, u_current, 0.55 * s);
  float angle = lean + sway;
  vec2 dir = vec2(cos(angle), sin(angle));
  vec2 side = vec2(-dir.y, dir.x);

  float width = a_size.y * (1.0 - 0.6 * s * s);
  vec2 world = a_root.xy + dir * a_size.x * s + side * width * a_along.y;

  // From the floor at the root up toward the surface at the tip.
  float floorHere = floorDepth(a_root.xy);
  v_depth = mix(floorHere, floorHere * 0.12, pow(s, 0.8));
  v_along = s;
  v_edge = a_along.y;
  v_phase = phase;
  gl_Position = vec4(world / vec2(u_aspect, 1.0) * 2.0 - 1.0, 0.0, 1.0);
}
`;

const GRASS_FRAG = /* glsl */ `#version 300 es
precision highp float;
in float v_along;
in float v_edge;
in float v_depth;
in float v_phase;
layout(location = 0) out vec4 o_colour;
layout(location = 1) out vec4 o_depth;

void main() {
  // Soft edges, so thin blades don't shimmer.
  float coverage = 1.0 - smoothstep(0.55, 1.0, abs(v_edge));
  // Deep green, a little yellower with age toward the tip, a paler midrib.
  vec3 young = vec3(0.016, 0.045, 0.01);
  vec3 old = vec3(0.03, 0.05, 0.012);
  vec3 colour = mix(young, old, v_along * (0.4 + 0.6 * fract(v_phase * 7.3)));
  colour *= 1.0 + 0.5 * (1.0 - smoothstep(0.0, 0.3, abs(v_edge)));
  o_colour = vec4(colour, coverage);
  o_depth = vec4(v_depth, 0.0, 0.0, coverage);
}
`;

export interface Blade {
  x: number;
  y: number;
  lean: number;
  phase: number;
  length: number;
  width: number;
}

/**
 * Grows `clumps` clumps of grass, mostly in the shallows near the banks.
 * `metres` per world unit keeps blades real: 15 to 40 cm long, 8 to 14 mm wide.
 */
export function growGrass(clumps: number, seed: number, aspect: number, metres: number, current: number) {
  const rand = random(seed * 7919 + 13);
  const blades: Blade[] = [];
  for (let c = 0; c < clumps; c++) {
    // Pick a spot near an edge: shallow water is where pond plants root.
    const edge = Math.floor(rand() * 4);
    const along = rand();
    const inset = 0.03 + 0.12 * rand();
    const [cx, cy] =
      edge === 0 ? [along * aspect, inset]
      : edge === 1 ? [along * aspect, 1 - inset]
      : edge === 2 ? [inset, along]
      : [aspect - inset, along];
    const count = 7 + Math.floor(rand() * 8);
    // Each clump leans roughly away from the bank it grows on.
    const outward = edge === 0 ? Math.PI / 2 : edge === 1 ? -Math.PI / 2 : edge === 2 ? 0 : Math.PI;
    for (let b = 0; b < count; b++) {
      const spread = 0.06 / metres;
      blades.push({
        x: cx + (rand() - 0.5) * spread,
        y: cy + (rand() - 0.5) * spread,
        lean: outward + (rand() - 0.5) * 1.6,
        phase: rand(),
        length: (0.15 + 0.25 * rand()) / metres,
        width: (0.004 + 0.003 * rand()) / metres,
      });
    }
  }
  return { blades, current };
}

export class Grass {
  private program: Program;
  private vao: WebGLVertexArrayObject;
  private buffers: WebGLBuffer[];
  private count = 0;
  private current = 0;

  constructor(private gl: WebGL2RenderingContext) {
    this.program = createProgram(gl, GRASS_VERT, GRASS_FRAG);
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);

    // One blade's strip: pairs of edge vertices from root to tip.
    const strip = new Float32Array((SEGMENTS + 1) * 4);
    for (let i = 0; i <= SEGMENTS; i++) strip.set([i / SEGMENTS, -1, i / SEGMENTS, 1], i * 4);
    const stripBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, stripBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, strip, gl.STATIC_DRAW);
    const along = gl.getAttribLocation(this.program.program, "a_along");
    gl.enableVertexAttribArray(along);
    gl.vertexAttribPointer(along, 2, gl.FLOAT, false, 0, 0);

    const bladeBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, bladeBuffer);
    const stride = 6 * 4;
    const root = gl.getAttribLocation(this.program.program, "a_root");
    gl.enableVertexAttribArray(root);
    gl.vertexAttribPointer(root, 4, gl.FLOAT, false, stride, 0);
    gl.vertexAttribDivisor(root, 1);
    const size = gl.getAttribLocation(this.program.program, "a_size");
    gl.enableVertexAttribArray(size);
    gl.vertexAttribPointer(size, 2, gl.FLOAT, false, stride, 16);
    gl.vertexAttribDivisor(size, 1);
    gl.bindVertexArray(null);
    this.buffers = [stripBuffer, bladeBuffer];
  }

  set({ blades, current }: { blades: Blade[]; current: number }) {
    const { gl } = this;
    const data = new Float32Array(blades.length * 6);
    blades.forEach((b, i) => data.set([b.x, b.y, b.lean, b.phase, b.length, b.width], i * 6));
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers[1]);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    this.count = blades.length;
    this.current = current;
  }

  /** Draws into the underwater layer, which must be bound (see Underwater.begin). */
  draw(time: number, aspect: number, depth: number, floorMap: WebGLTexture) {
    const { gl } = this;
    if (this.count === 0) return;
    const { program, uniforms } = this.program;
    gl.useProgram(program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, floorMap);
    gl.uniform1i(uniforms.u_floor, 0);
    gl.uniform1f(uniforms.u_time, time);
    gl.uniform1f(uniforms.u_current, this.current);
    gl.uniform1f(uniforms.u_aspect, aspect);
    gl.uniform1f(uniforms.u_depth, depth);
    gl.bindVertexArray(this.vao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, (SEGMENTS + 1) * 2, this.count);
  }

  dispose() {
    const { gl } = this;
    gl.deleteProgram(this.program.program);
    gl.deleteVertexArray(this.vao);
    this.buffers.forEach((b) => gl.deleteBuffer(b));
  }
}
