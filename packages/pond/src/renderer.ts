import {
  createFloatTarget,
  createProgram,
  deleteTarget,
  FULLSCREEN_VERT,
  type Program,
  type Target,
} from "./gl";
import type { Ripples } from "./ripples";
import type { LayerTarget } from "./underwater";
import { BED, ETA, NOISE } from "./shaders/common";

/*
 * Each frame is drawn in three passes:
 *
 * 1. Surface: the full water surface, stored as height and slope: a field
 *    of gentle background waves, plus every ripple (see ripples.ts). Older
 *    ripples are drawn first into a half-resolution layer that's added in.
 * 2. Caustics: a fine grid of sunlight rays is bent by that surface and
 *    landed on the bed. Where rays bunch together the bed gets brighter, and
 *    where they spread it gets darker. This is the light web on a pond floor,
 *    computed rather than painted.
 * 3. Compose: look through the surface at the floor and at anything in the
 *    water above it (the underwater layer: grass, fish), light them with the
 *    caustics and let what's in the water cast shadows on the floor, let the
 *    water absorb colour with depth (red first, which is why ponds look
 *    green), then add reflection, sun glints, grain and vignette.
 */

const SURFACE_FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o_surface;

uniform float u_aspect;
uniform float u_time;
uniform float u_waves;
uniform float u_metres; // metres per world unit
uniform sampler2D u_far; // older ripples, at half resolution

// Sum of sine waves at varied angles and lengths. Each wave's height scales
// with its length squared, so all of them curve the surface about equally and
// none dominates the caustic pattern. Each travels at the speed real water
// gives that wavelength: gravity plus surface tension, ω² = gk + (σ/ρ)k³.
vec3 ambientWaves(vec2 p, float t) {
  const int N = 9;
  const float ANGLE[N] = float[N](0.31, 1.07, 1.93, 2.38, 3.29, 3.94, 4.61, 5.17, 5.83);
  const float LENGTH[N] = float[N](0.23, 0.17, 0.13, 0.19, 0.11, 0.15, 0.21, 0.12, 0.16);
  // Real swells aren't perfectly uniform; a little spread keeps the pattern alive.
  const float SPEED[N] = float[N](1.0, 0.92, 1.06, 0.97, 1.03, 0.95, 1.0, 1.08, 0.9);
  // Bend the wave fronts a little so their crossings don't form a lattice.
  p += 0.035 * vec2(sin(p.y * 7.3 + t * 0.21), sin(p.x * 6.1 - t * 0.17));
  vec3 sum = vec3(0.0);
  for (int i = 0; i < N; i++) {
    vec2 d = vec2(cos(ANGLE[i]), sin(ANGLE[i]));
    float k = 6.2831853 / LENGTH[i];
    float a = 0.13 * LENGTH[i] * LENGTH[i];
    float km = k / u_metres;
    float omega = sqrt(9.81 * km + 7.28e-5 * km * km * km) * SPEED[i];
    float phase = k * dot(d, p) - omega * t + float(i) * 1.7;
    sum += a * vec3(sin(phase), k * d * cos(phase));
  }
  return sum;
}

void main() {
  vec2 world = v_uv * vec2(u_aspect, 1.0);
  vec3 waves = ambientWaves(world, u_time) * u_waves;
  o_surface = vec4(waves, 0.0) + texture(u_far, v_uv);
}
`;

const CAUSTICS_VERT = /* glsl */ `#version 300 es
precision highp float;
in vec2 a_uv;
out vec2 v_flat;
out vec2 v_bent;

uniform sampler2D u_surface;
uniform vec3 u_sun;

${NOISE}
${BED}

vec2 landOnBed(vec2 world, vec3 normal, float height) {
  return hitFloor(world, refract(-u_sun, normal, ${ETA}), height);
}

void main() {
  vec2 world = a_uv * vec2(u_aspect, 1.0);
  vec4 s = texture(u_surface, a_uv);
  vec3 normal = normalize(vec3(-s.yz, 1.0));
  // Where this ray lands through flat water, and where it lands now.
  v_flat = landOnBed(world, vec3(0.0, 0.0, 1.0), 0.0);
  v_bent = landOnBed(world, normal, s.x);
  gl_Position = vec4(v_bent / vec2(u_aspect, 1.0) * 2.0 - 1.0, 0.0, 1.0);
}
`;

const CAUSTICS_FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_flat;
in vec2 v_bent;
out vec4 o_light;

void main() {
  // How much flat-water area got squeezed into this pixel = how bright it is.
  float flatArea = length(dFdx(v_flat)) * length(dFdy(v_flat));
  float bentArea = length(dFdx(v_bent)) * length(dFdy(v_bent));
  o_light = vec4(flatArea / max(bentArea, 1e-12), 0.0, 0.0, 1.0);
}
`;

const COMPOSE_FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o_color;

uniform sampler2D u_surface;
uniform sampler2D u_caustics;
uniform sampler2D u_layerColour; // underwater layer: albedo × coverage, coverage
uniform sampler2D u_layerDepth;  // underwater layer: depth × coverage, coverage
uniform vec3 u_sun;
uniform float u_time;
uniform vec2 u_resolution;
uniform vec3 u_absorb;   // per-channel absorption per world unit
uniform vec3 u_murk;     // light scattered back by particles in the water
uniform vec3 u_sky;

${NOISE}
${BED}

const vec3 SUN_LIGHT = vec3(3.4, 3.2, 2.9);

// Sky as seen in a reflection: bright overhead, framed by tree canopy.
vec3 skyReflection(vec3 dir, vec2 p) {
  // Tilted water reflects a different patch of canopy, so a ripple's
  // slopes show up as bands of brighter and darker reflection.
  float leaves = smoothstep(0.3, 0.7, fbm(p * 1.5 + dir.xy * 9.0));
  return mix(u_sky, u_sky * vec3(0.18, 0.28, 0.16), leaves);
}

vec2 toUv(vec2 p) {
  return p / vec2(u_aspect, 1.0);
}

// How much sunlight reaches this bit of floor past things in the water. The
// light came slanting down from the sun's side, so look that way, as far as
// the thing blocking it sits above the floor. Higher things cast softer,
// fainter shadows, as their light spreads around them.
float sunReaching(vec2 floorPoint, float floorDepthHere, vec3 toSun) {
  vec2 slant = toSun.xy / toSun.z;
  vec4 guess = textureLod(u_layerDepth, toUv(floorPoint + slant * floorDepthHere * 0.5), 2.0);
  if (guess.a < 0.003) return 1.0;
  float above = max(floorDepthHere - guess.r / guess.a, 0.0);
  float blur = log2(1.0 + above * 300.0);
  float blocked = textureLod(u_layerColour, toUv(floorPoint + slant * above), blur).a;
  return 1.0 - blocked * mix(0.8, 0.45, clamp(above / u_depth, 0.0, 1.0));
}

vec3 tonemap(vec3 x) {
  // ACES fit (Narkowicz): filmic shoulder so bright caustics don't clip flat.
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

void main() {
  vec2 world = v_uv * vec2(u_aspect, 1.0);
  vec4 s = texture(u_surface, v_uv);
  vec3 normal = normalize(vec3(-s.yz, 1.0));

  // Follow the view ray through the surface down to the floor.
  vec3 view = refract(vec3(0.0, 0.0, -1.0), normal, ${ETA});
  vec2 bed = hitFloor(world, view, s.x);
  vec2 bedUv = bed / vec2(u_aspect, 1.0);
  vec4 floorMap = texture(u_bedMap, bedUv);
  float depth = bedDepth(bed) - floorMap.a;

  // Which way the floor faces, from the slope of its height.
  vec2 texel = 1.0 / vec2(textureSize(u_bedMap, 0));
  vec2 rise = vec2(
    texture(u_bedMap, bedUv + vec2(texel.x, 0.0)).a - texture(u_bedMap, bedUv - vec2(texel.x, 0.0)).a,
    texture(u_bedMap, bedUv + vec2(0.0, texel.y)).a - texture(u_bedMap, bedUv - vec2(0.0, texel.y)).a
  ) / (2.0 * texel * vec2(u_aspect, 1.0));
  vec3 floorNormal = normalize(vec3(-rise, 1.0));

  // Sunlight reaching the floor, and the floor's light coming back up, both
  // pass through water that absorbs each colour at its own rate. Under water
  // the sun shines along its refracted direction, so stones are lit on the
  // sun's side and shaded on the other.
  vec3 down = exp(-u_absorb * depth * 1.15);
  vec3 up = exp(-u_absorb * depth);
  float caustic = texture(u_caustics, bedUv).r;
  vec3 toSun = -refract(-u_sun, vec3(0.0, 0.0, 1.0), ${ETA});
  float facing = max(dot(floorNormal, toSun), 0.0) / toSun.z;
  float skyView = 0.5 + 0.5 * floorNormal.z;
  float shade = sunReaching(bed, depth, toSun);
  vec3 light = SUN_LIGHT * caustic * facing * shade * down + u_sky * 0.08 * skyView * down;
  vec3 color = floorMap.rgb * light * up;

  // Wet stones have a soft sheen where they turn the sunlight toward us.
  float onStone = smoothstep(0.002, 0.01, floorMap.a);
  float sheen = pow(max(reflect(-toSun, floorNormal).z, 0.0), 24.0) * onStone;
  color += SUN_LIGHT * caustic * down * up * sheen * 0.06;

  // Water glows faintly with scattered light, more where it's deep, and a
  // little of the caustic brightness hangs in the water as haze.
  float haze = textureLod(u_caustics, bedUv, 4.0).r;
  color += u_murk * (1.0 - up) * (0.5 + 0.5 * haze);

  // Things in the water between us and the floor. Look halfway down first,
  // then again at the depth of whatever is there, so a blade near the
  // surface wobbles less under the ripples than the floor beneath it.
  vec2 guess = world + view.xy * ((floorDepth(world) * 0.5 + s.x) / -view.z);
  vec4 seen = textureLod(u_layerDepth, toUv(guess), 0.0);
  if (seen.a > 0.003) {
    float objectDepth = seen.r / seen.a;
    vec2 at = toUv(world + view.xy * ((objectDepth + s.x) / -view.z));
    vec4 object = textureLod(u_layerColour, at, 0.0);
    if (object.a > 0.003) {
      objectDepth = textureLod(u_layerDepth, at, 0.0).r / max(textureLod(u_layerDepth, at, 0.0).a, 1e-4);
      vec3 objectDown = exp(-u_absorb * objectDepth * 1.15);
      vec3 objectUp = exp(-u_absorb * objectDepth);
      // The light web focuses at the floor, so it's softer up in the water.
      float objectCaustic = textureLod(u_caustics, at, 1.5).r;
      vec3 lit = object.rgb / object.a
        * (SUN_LIGHT * objectCaustic * objectDown + u_sky * 0.1 * objectDown) * objectUp
        + u_murk * (1.0 - objectUp) * (0.5 + 0.5 * haze);
      color = mix(color, lit, object.a);
    }
  }

  // Reflection: tiny looking straight down, stronger on tilted ripples.
  float fresnel = 0.02 + 0.98 * pow(1.0 - normal.z, 5.0);
  vec3 reflected = reflect(vec3(0.0, 0.0, -1.0), normal);
  color = mix(color, skyReflection(reflected, world), fresnel);
  vec3 halfway = normalize(u_sun + vec3(0.0, 0.0, 1.0));
  float steep = smoothstep(0.25, 0.5, length(s.yz));
  color += SUN_LIGHT * pow(max(dot(normal, halfway), 0.0), 4000.0) * 0.4 * steep;

  color = tonemap(color);
  // Bright light washes out toward white, as it does on a camera sensor.
  float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
  color = mix(color, vec3(luma), smoothstep(0.35, 0.9, luma) * 0.75);
  color = pow(color, vec3(1.0 / 2.2));

  // Darker toward the banks, like the reference: the eye settles in the middle.
  vec2 q = v_uv - 0.5;
  color *= 1.0 - 0.55 * smoothstep(0.25, 0.75, length(q * vec2(u_aspect, 1.0) / max(u_aspect, 1.0) * 1.4));

  // Film grain, re-rolled every frame.
  float grain = hash(gl_FragCoord.xy + fract(u_time * 7.13) * 317.0) - 0.5;
  color += grain * 0.06;

  o_color = vec4(color, 1.0);
}
`;

export interface Palette {
  /** Silt colour; used when drawing the bed map. */
  bed: [number, number, number];
  absorb: [number, number, number];
  murk: [number, number, number];
  sky: [number, number, number];
}

export interface RenderSettings {
  palette: Palette;
  depth: number;
  waves: number;
  /** Metres per world unit (the canvas height). */
  metres: number;
}

/** Sunlight comes from up and to the left, so caustics lean a little. */
const SUN: [number, number, number] = (() => {
  const v = [-0.22, 0.3, 1];
  const l = Math.hypot(...v);
  return v.map((c) => c / l) as [number, number, number];
})();

/** Light rays extend this far past each edge, so light can enter from off-screen. */
const MARGIN = 0.15;

export class Renderer {
  private surfaceProgram: Program;
  private causticsProgram: Program;
  private composeProgram: Program;
  private surface: Target | null = null;
  private far: Target | null = null;
  private caustics: Target | null = null;
  private mesh: { vao: WebGLVertexArrayObject; buffers: WebGLBuffer[]; count: number } | null = null;

  constructor(private gl: WebGL2RenderingContext) {
    this.surfaceProgram = createProgram(gl, FULLSCREEN_VERT, SURFACE_FRAG);
    this.causticsProgram = createProgram(gl, CAUSTICS_VERT, CAUSTICS_FRAG);
    this.composeProgram = createProgram(gl, FULLSCREEN_VERT, COMPOSE_FRAG);
  }

  /** Sizes the surface grid and caustic map for a canvas of this shape. */
  resize(width: number, height: number, quality: { surface: number; caustics: number }) {
    const { gl } = this;
    const fit = (long: number) => {
      const s = long / Math.max(width, height);
      return [Math.max(8, Math.round(width * s)), Math.max(8, Math.round(height * s))];
    };

    const [sw, sh] = fit(quality.surface);
    if (!this.surface || this.surface.width !== sw || this.surface.height !== sh) {
      if (this.surface) deleteTarget(gl, this.surface);
      if (this.far) deleteTarget(gl, this.far);
      this.surface = createFloatTarget(gl, sw, sh);
      this.far = createFloatTarget(gl, Math.ceil(sw / 2), Math.ceil(sh / 2));
      this.buildMesh(sw, sh);
    }

    const [cw, ch] = fit(Math.min(quality.caustics, Math.max(width, height)));
    if (!this.caustics || this.caustics.width !== cw || this.caustics.height !== ch) {
      if (this.caustics) deleteTarget(gl, this.caustics);
      this.caustics = createFloatTarget(gl, cw, ch, { mipmaps: true });
    }
  }

  /** A grid of light rays, one per surface texel, a little wider than the canvas. */
  private buildMesh(columns: number, rows: number) {
    const { gl } = this;
    if (this.mesh) {
      gl.deleteVertexArray(this.mesh.vao);
      this.mesh.buffers.forEach((b) => gl.deleteBuffer(b));
    }
    const positions = new Float32Array((columns + 1) * (rows + 1) * 2);
    let i = 0;
    for (let y = 0; y <= rows; y++) {
      for (let x = 0; x <= columns; x++) {
        positions[i++] = -MARGIN + (x / columns) * (1 + 2 * MARGIN);
        positions[i++] = -MARGIN + (y / rows) * (1 + 2 * MARGIN);
      }
    }
    const indices = new Uint32Array(columns * rows * 6);
    i = 0;
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < columns; x++) {
        const a = y * (columns + 1) + x;
        const b = a + 1;
        const c = a + columns + 1;
        const d = c + 1;
        indices.set([a, b, c, b, d, c], i);
        i += 6;
      }
    }

    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const positionBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
    const location = gl.getAttribLocation(this.causticsProgram.program, "a_uv");
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);
    const indexBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    this.mesh = { vao, buffers: [positionBuffer, indexBuffer], count: indices.length };
  }

  draw(
    ripples: Ripples,
    bedMap: WebGLTexture,
    layer: LayerTarget,
    emptyVao: WebGLVertexArrayObject,
    time: number,
    { palette, depth, waves, metres }: RenderSettings,
  ) {
    const { gl, surface, far, caustics, mesh } = this;
    if (!surface || !far || !caustics || !mesh) return;
    const { width, height } = gl.canvas;
    const aspect = width / height;

    // 1. Surface: older ripples into their own layer first...
    ripples.prepare(time, metres);
    gl.bindFramebuffer(gl.FRAMEBUFFER, far.framebuffer);
    gl.viewport(0, 0, far.width, far.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    ripples.draw(time, aspect, metres, true);
    gl.disable(gl.BLEND);

    // ...then background waves plus that layer, then younger ripples on top.
    gl.bindVertexArray(emptyVao);
    gl.bindFramebuffer(gl.FRAMEBUFFER, surface.framebuffer);
    gl.viewport(0, 0, surface.width, surface.height);
    let u = this.use(this.surfaceProgram);
    this.bindTexture(0, far.texture, u.u_far);
    gl.uniform1f(u.u_aspect, aspect);
    gl.uniform1f(u.u_time, time);
    gl.uniform1f(u.u_waves, waves);
    gl.uniform1f(u.u_metres, metres);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    ripples.draw(time, aspect, metres, false);
    gl.disable(gl.BLEND);

    // 2. Caustics: add up the light every ray brings to each pixel of the bed.
    gl.bindVertexArray(emptyVao);
    gl.bindFramebuffer(gl.FRAMEBUFFER, caustics.framebuffer);
    gl.viewport(0, 0, caustics.width, caustics.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    u = this.use(this.causticsProgram);
    this.bindTexture(0, surface.texture, u.u_surface);
    this.bindTexture(1, bedMap, u.u_bedMap);
    gl.uniform3fv(u.u_sun, SUN);
    gl.uniform1f(u.u_depth, depth);
    gl.uniform1f(u.u_aspect, aspect);
    gl.bindVertexArray(mesh.vao);
    gl.drawElements(gl.TRIANGLES, mesh.count, gl.UNSIGNED_INT, 0);
    gl.disable(gl.BLEND);
    gl.bindTexture(gl.TEXTURE_2D, caustics.texture);
    gl.generateMipmap(gl.TEXTURE_2D);

    // 3. Compose
    gl.bindVertexArray(emptyVao);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, width, height);
    u = this.use(this.composeProgram);
    this.bindTexture(0, surface.texture, u.u_surface);
    this.bindTexture(1, caustics.texture, u.u_caustics);
    this.bindTexture(2, bedMap, u.u_bedMap);
    this.bindTexture(3, layer.colour, u.u_layerColour);
    this.bindTexture(4, layer.depth, u.u_layerDepth);
    gl.uniform3fv(u.u_sun, SUN);
    gl.uniform1f(u.u_depth, depth);
    gl.uniform1f(u.u_aspect, aspect);
    gl.uniform1f(u.u_time, time);
    gl.uniform2f(u.u_resolution, width, height);
    gl.uniform3fv(u.u_absorb, palette.absorb);
    gl.uniform3fv(u.u_murk, palette.murk);
    gl.uniform3fv(u.u_sky, palette.sky);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  private use({ program, uniforms }: Program) {
    this.gl.useProgram(program);
    return uniforms;
  }

  private bindTexture(unit: number, texture: WebGLTexture, location: WebGLUniformLocation) {
    const { gl } = this;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(location, unit);
  }

  dispose() {
    const { gl } = this;
    if (this.surface) deleteTarget(gl, this.surface);
    if (this.far) deleteTarget(gl, this.far);
    if (this.caustics) deleteTarget(gl, this.caustics);
    if (this.mesh) {
      gl.deleteVertexArray(this.mesh.vao);
      this.mesh.buffers.forEach((b) => gl.deleteBuffer(b));
    }
    gl.deleteProgram(this.surfaceProgram.program);
    gl.deleteProgram(this.causticsProgram.program);
    gl.deleteProgram(this.composeProgram.program);
  }
}
