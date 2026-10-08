import { createFloatTarget, createProgram, deleteTarget, FULLSCREEN_VERT, type Program, type Target } from "./gl";

/*
 * Ripples, computed from the physics of real water.
 *
 * A tap is a small dent in the surface. Linear water-wave theory (the
 * Cauchy–Poisson problem) gives exactly how such a dent evolves: it breaks
 * into a train of rings, because each wavelength travels at its own speed
 * (gravity pulls long waves along, surface tension pushes short ones), and
 * short ripples fade fastest because viscosity damps them as k². The result
 * depends only on distance and time, so we compute it once into a lookup
 * table and every tap afterwards is just a table read.
 *
 * Something moving through the water (a finger, later a fish) doesn't remove
 * water: it pushes it up ahead and leaves a hollow behind, so its dent
 * travels with it. Each step of the motion is a "moving dent": fill the old
 * spot, dig the new one. Adding those up is how real wakes form, so V-shaped
 * wakes appear by themselves, and nothing is left behind but waves.
 *
 * Natural ponds have sloping banks that absorb waves rather than reflect
 * them, so rings simply pass off the edge of the canvas.
 */

/** Physical constants, SI units. */
const GRAVITY = 9.81;
/** Surface tension over density for water, m³/s². */
const TENSION = 7.28e-5;
/**
 * Kinematic viscosity, m²/s. Above clean water's 1e-6, as pond water carries
 * surface films that damp fine ripples harder. This is what makes ripples
 * fade: short ones soften first, long ones linger.
 */
const VISCOSITY = 3.5e-6;

/** Radius of the dent a fingertip makes, metres. */
const TAP_RADIUS = 0.012;
/** The table covers rings up to this far out (m) and this old (s). */
const MAX_DISTANCE = 0.8;
const MAX_AGE = 4;
const TABLE_WIDTH = 384; // distance samples
const TABLE_HEIGHT = 640; // time samples
/** Table rows computed per frame, so building it never causes a hitch. */
const ROWS_PER_FRAME = 16;

/** Speed of the leading visible ring for this dent size, m/s, with a little headroom. */
const FRONT_SPEED = 0.3;
const MAX_SOURCES = 2048;

/**
 * After about a second only the longer waves are left, so older ripples are
 * drawn into a half-resolution layer at a quarter of the cost. Between these
 * ages each ripple crossfades from one layer to the other.
 */
const FAR_FROM = 0.7;
const FAR_TO = 1.0;

/**
 * As a stroke's ripples move to the far layer, each run of steps this close
 * in space (m) and time (s) is merged into one: filled where the run began,
 * dug where it ended. By then only waves several centimetres long remain, and
 * they can't tell the difference, while the far layer has far less to draw.
 */
const MERGE_DISTANCE = 0.02;
const MERGE_TIME = 0.05;

/** Which layers a ripple source is drawn in. */
const BOTH = 0;
const NEAR_ONLY = 1;
const FAR_ONLY = 2;

/** Every ripple lives as long as the table lasts; viscosity has faded it by then. */
const LIFE = MAX_AGE;

const TABLE_FRAG = /* glsl */ `#version 300 es
precision highp float;
out vec4 o_ring;

// Bessel functions J0 and J1 (Abramowitz & Stegun 9.4.1 to 9.4.6).
float besselJ0(float x) {
  if (x < 3.0) {
    float y = x * x / 9.0;
    return 1.0 + y * (-2.2499997 + y * (1.2656208 + y * (-0.3163866 + y * (0.0444479 + y * (-0.0039444 + y * 0.0002100)))));
  }
  float y = 3.0 / x;
  float f = 0.79788456 + y * (-0.00000077 + y * (-0.00552740 + y * (-0.00009512 + y * (0.00137237 + y * (-0.00072805 + y * 0.00014476)))));
  float theta = x - 0.78539816 + y * (-0.04166397 + y * (-0.00003954 + y * (0.00262573 + y * (-0.00054125 + y * (-0.00029333 + y * 0.00013558)))));
  return f * cos(theta) / sqrt(x);
}

float besselJ1(float x) {
  if (x < 3.0) {
    float y = x * x / 9.0;
    return x * (0.5 + y * (-0.56249985 + y * (0.21093573 + y * (-0.03954289 + y * (0.00443319 + y * (-0.00031761 + y * 0.00001109))))));
  }
  float y = 3.0 / x;
  float f = 0.79788456 + y * (0.00000156 + y * (0.01659667 + y * (0.00017105 + y * (-0.00249511 + y * (0.00113653 - y * 0.00020033)))));
  float theta = x - 2.35619449 + y * (0.12499612 + y * (0.00005650 + y * (-0.00637879 + y * (0.00074348 + y * (0.00079824 - y * 0.00029166)))));
  return f * cos(theta) / sqrt(x);
}

const float DK = 0.45;   // wavenumber step, 1/m
const int STEPS = 1130;  // up to k ≈ 508/m, where the dent's spectrum has died out

void main() {
  float r = (gl_FragCoord.x - 0.5) / ${TABLE_WIDTH - 1}.0 * ${MAX_DISTANCE.toFixed(3)};
  float t = (gl_FragCoord.y - 0.5) / ${TABLE_HEIGHT - 1}.0 * ${MAX_AGE.toFixed(3)};
  float a = ${TAP_RADIUS};

  // Surface height h(r, t) and its slope dh/dr, as a sum over wavelengths.
  // A Gaussian dent of depth 1 and radius a has spectrum (a²/2)·exp(-k²a²/4).
  float h = 0.0, slope = 0.0;
  for (int i = 0; i < STEPS; i++) {
    float k = (float(i) + 0.5) * DK;
    float omega = sqrt(${GRAVITY} * k + ${TENSION} * k * k * k);
    float weight = exp(-k * k * (a * a * 0.25 + 2.0 * ${VISCOSITY} * t)) * cos(omega * t) * k * DK;
    h += weight * besselJ0(k * r);
    slope -= weight * k * besselJ1(k * r);
  }
  float dent = -0.5 * a * a;
  o_ring = vec4(h * dent, slope * dent, 0.0, 1.0);
}
`;

const SOURCE_VERT = /* glsl */ `#version 300 es
precision highp float;
in vec2 a_corner;
in vec4 a_where;  // dent position x, y (world units); birth time; lifetime
in vec4 a_what;   // dent depth (m); where it was filled, relative to the dent (m); layers

uniform float u_time;
uniform float u_aspect;
uniform float u_metres; // metres per world unit
uniform bool u_far;     // drawing the half-resolution layer for older ripples

out vec2 v_offset; // metres from the dent
out vec2 v_fill;   // where the dent was filled, metres from the dent; zero for a tap
out float v_depth;
out float v_reach;
out float v_age;
out float v_life;
out float v_layer; // this source's share in the layer being drawn

void main() {
  float age = u_time - a_where.z;
  float far = smoothstep(${FAR_FROM.toFixed(2)}, ${FAR_TO.toFixed(2)}, age);
  // Merged sources only exist in the far layer, and the originals they
  // replace only in the near one; together they still crossfade smoothly.
  if (a_what.w == ${NEAR_ONLY}.0 && u_far) far = 0.0;
  if (a_what.w == ${FAR_ONLY}.0 && !u_far) far = 1.0;
  v_layer = u_far ? far : 1.0 - far;

  // The quad only needs to cover how far the rings have travelled, from
  // both the dent and the spot it filled.
  v_reach = min(${TAP_RADIUS * 4} + ${FRONT_SPEED} * age, ${MAX_DISTANCE.toFixed(3)});
  float size = age < 0.0 || age > a_where.w || v_layer <= 0.0 ? 0.0 : v_reach + length(a_what.yz);
  v_offset = a_corner * size;
  v_fill = a_what.yz;
  v_depth = a_what.x;
  v_age = age;
  v_life = a_where.w;
  vec2 world = a_where.xy + v_offset / u_metres;
  gl_Position = vec4(world / vec2(u_aspect, 1.0) * 2.0 - 1.0, 0.0, 1.0);
}
`;

const SOURCE_FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_offset;
in vec2 v_fill;
in float v_depth;
in float v_reach;
in float v_age;
in float v_life;
in float v_layer;
out vec4 o_surface;

uniform sampler2D u_table;
uniform float u_metres;

// Height and slope (as a vector) of one dent's rings, at this offset from it.
vec3 rings(vec2 offset) {
  float r = length(offset);
  vec2 size = vec2(${TABLE_WIDTH}.0, ${TABLE_HEIGHT}.0);
  vec2 uv = vec2(r / ${MAX_DISTANCE.toFixed(3)}, v_age / ${MAX_AGE.toFixed(3)});
  vec2 ring = texture(u_table, (uv * (size - 1.0) + 0.5) / size).xy;
  // Fade softly before the table's edge and the edge of the drawn quad.
  ring *= (1.0 - smoothstep(${(MAX_DISTANCE * 0.75).toFixed(3)}, ${MAX_DISTANCE.toFixed(3)}, r))
    * (1.0 - smoothstep(0.8 * v_reach, v_reach, r));
  vec2 dir = r > 1e-5 ? offset / r : vec2(0.0);
  return vec3(ring.x, ring.y * dir);
}

void main() {
  vec3 surface = rings(v_offset);
  // A moving dent also fills the spot it left.
  if (v_fill != vec2(0.0)) surface -= rings(v_offset - v_fill);

  // Viscosity does most of the fading. This long, gentle ramp only clears
  // what little is left by the end of the table, so nothing ever pops.
  float fade = (1.0 - smoothstep(0.35 * v_life, v_life, v_age)) * v_layer;
  surface *= v_depth * fade;

  // Height goes to world units; slope is metres per metre, the same in any unit.
  o_surface = vec4(surface.x / u_metres, surface.yz, 0.0);
}
`;

interface Source {
  /** Dent position, world units. */
  x: number;
  y: number;
  birth: number;
  life: number;
  /** Dent depth, metres. */
  depth: number;
  /** Where the dent was filled, metres from it; zero for a tap. */
  fillX: number;
  fillY: number;
  layers: number;
}

const FLOATS_PER_SOURCE = 8;

export class Ripples {
  private table: Target;
  private rowsDone = 0;
  private tableProgram: Program;
  private sourceProgram: Program;
  private vao: WebGLVertexArrayObject;
  private buffers: WebGLBuffer[];
  private instanceData = new Float32Array(MAX_SOURCES * FLOATS_PER_SOURCE);
  private sources: Source[] = [];

  constructor(private gl: WebGL2RenderingContext) {
    this.table = createFloatTarget(gl, TABLE_WIDTH, TABLE_HEIGHT);
    this.tableProgram = createProgram(gl, FULLSCREEN_VERT, TABLE_FRAG);
    this.sourceProgram = createProgram(gl, SOURCE_VERT, SOURCE_FRAG);

    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    const corners = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, corners);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const cornerLocation = gl.getAttribLocation(this.sourceProgram.program, "a_corner");
    gl.enableVertexAttribArray(cornerLocation);
    gl.vertexAttribPointer(cornerLocation, 2, gl.FLOAT, false, 0, 0);

    const instances = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, instances);
    gl.bufferData(gl.ARRAY_BUFFER, this.instanceData.byteLength, gl.DYNAMIC_DRAW);
    const stride = FLOATS_PER_SOURCE * 4;
    for (const [name, offset] of [["a_where", 0], ["a_what", 16]] as const) {
      const location = gl.getAttribLocation(this.sourceProgram.program, name);
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, 4, gl.FLOAT, false, stride, offset);
      gl.vertexAttribDivisor(location, 1);
    }
    gl.bindVertexArray(null);
    this.buffers = [corners, instances];
  }

  /** A tap: a dent this deep (metres). Position in world units, birth on the pond's clock. */
  tap(x: number, y: number, birth: number, depth: number) {
    this.push({ x, y, birth, life: LIFE, depth, fillX: 0, fillY: 0, layers: BOTH });
  }

  /** A dent this deep (metres) moving by (dx, dy) metres to arrive at (x, y). */
  move(x: number, y: number, birth: number, depth: number, dx: number, dy: number) {
    this.push({ x, y, birth, life: LIFE, depth, fillX: -dx, fillY: -dy, layers: BOTH });
  }

  /** How many ripple sources are live. */
  get count() {
    return this.sources.length;
  }

  private push(source: Source) {
    if (this.sources.length >= MAX_SOURCES) this.sources.shift();
    this.sources.push(source);
  }

  /** Builds a few more rows of the ring table, if it isn't finished. */
  build(emptyVao: WebGLVertexArrayObject) {
    if (this.rowsDone >= TABLE_HEIGHT) return;
    const { gl } = this;
    const rows = Math.min(ROWS_PER_FRAME, TABLE_HEIGHT - this.rowsDone);
    gl.bindVertexArray(emptyVao);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.table.framebuffer);
    gl.viewport(0, 0, TABLE_WIDTH, TABLE_HEIGHT);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(0, this.rowsDone, TABLE_WIDTH, rows);
    gl.useProgram(this.tableProgram.program);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.disable(gl.SCISSOR_TEST);
    this.rowsDone += rows;
  }

  /**
   * Drops finished ripples, merges ones reaching the far layer, and uploads
   * the rest. Call once per frame, before draw(). `metres` per world unit.
   */
  prepare(time: number, metres: number) {
    const { gl } = this;
    this.sources = this.sources.filter((s) =>
      s.layers === NEAR_ONLY ? time - s.birth < FAR_TO : time - s.birth < s.life,
    );
    this.mergeForFarLayer(time, metres);
    this.sources.forEach((s, i) =>
      this.instanceData.set(
        [s.x, s.y, s.birth, s.life, s.depth, s.fillX, s.fillY, s.layers],
        i * FLOATS_PER_SOURCE,
      ),
    );
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers[1]);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.instanceData, 0, this.sources.length * FLOATS_PER_SOURCE);
  }

  /**
   * Moving-dent steps about to enter the far layer are grouped into runs
   * that are close in space and time (sources are stored in the order they
   * were made, so a stroke is one long run). Each run is replaced in the far
   * layer by one source, filled where the run began and dug where it ended.
   */
  private mergeForFarLayer(time: number, metres: number) {
    const merged: Source[] = [];
    let run: Source[] = [];
    const flush = () => {
      if (run.length === 0) return;
      const first = run[0];
      const last = run[run.length - 1];
      merged.push({
        x: last.x,
        y: last.y,
        birth: run.reduce((total, s) => total + s.birth, 0) / run.length,
        life: last.life,
        depth: last.depth,
        fillX: (first.x - last.x) * metres + first.fillX,
        fillY: (first.y - last.y) * metres + first.fillY,
        layers: FAR_ONLY,
      });
      for (const s of run) s.layers = NEAR_ONLY;
      run = [];
    };
    for (const s of this.sources) {
      const isMove = s.fillX !== 0 || s.fillY !== 0;
      if (!isMove || s.layers !== BOTH || time - s.birth < FAR_FROM) continue;
      const first = run[0];
      if (
        first &&
        (s.depth !== first.depth ||
          Math.hypot(s.x - first.x, s.y - first.y) * metres > MERGE_DISTANCE ||
          s.birth - first.birth > MERGE_TIME)
      ) {
        flush();
      }
      run.push(s);
    }
    flush();
    for (const s of merged) this.push(s);
  }

  /**
   * Adds live ripples into the surface currently bound as the render target,
   * which must be set up for additive blending. `far` selects older ripples,
   * for the half-resolution layer; otherwise younger ones.
   */
  draw(time: number, aspect: number, metres: number, far: boolean) {
    const { gl } = this;
    const count = this.sources.length;
    if (count === 0) return;
    const { program, uniforms } = this.sourceProgram;
    gl.useProgram(program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.table.texture);
    gl.uniform1i(uniforms.u_table, 0);
    gl.uniform1f(uniforms.u_time, time);
    gl.uniform1f(uniforms.u_aspect, aspect);
    gl.uniform1f(uniforms.u_metres, metres);
    gl.uniform1i(uniforms.u_far, far ? 1 : 0);
    gl.bindVertexArray(this.vao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
  }

  dispose() {
    const { gl } = this;
    deleteTarget(gl, this.table);
    gl.deleteProgram(this.tableProgram.program);
    gl.deleteProgram(this.sourceProgram.program);
    gl.deleteVertexArray(this.vao);
    this.buffers.forEach((b) => gl.deleteBuffer(b));
  }
}
