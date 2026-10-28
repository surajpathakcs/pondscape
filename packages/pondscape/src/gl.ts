/** Small WebGL2 helpers shared by the simulation and the renderer. */

export const FULLSCREEN_VERT = /* glsl */ `#version 300 es
out vec2 v_uv;
void main() {
  // One oversized triangle covers the viewport; no vertex buffer needed.
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  v_uv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

export interface Program {
  program: WebGLProgram;
  /** Empty until the program has linked; see programsReady. */
  uniforms: Record<string, WebGLUniformLocation>;
}

// Asking whether a program compiled makes the page wait until it has. For all
// of the pond's programs that was seconds on a browser with no shader cache,
// with the page frozen; so programs are started here and only asked about
// once the browser says they're done.
const compiling = new WeakMap<
  WebGL2RenderingContext,
  { parallel: KHR_parallel_shader_compile | null; pending: { program: Program; shaders: WebGLShader[] }[] }
>();

function shader(gl: WebGL2RenderingContext, type: number, source: string) {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  return shader;
}

/** Starts compiling and linking a program, and returns without waiting for it. */
export function createProgram(
  gl: WebGL2RenderingContext,
  vertexSource: string,
  fragmentSource: string,
): Program {
  let state = compiling.get(gl);
  if (!state) {
    state = { parallel: gl.getExtension("KHR_parallel_shader_compile"), pending: [] };
    compiling.set(gl, state);
  }
  const shaders = [shader(gl, gl.VERTEX_SHADER, vertexSource), shader(gl, gl.FRAGMENT_SHADER, fragmentSource)];
  const program = gl.createProgram()!;
  for (const s of shaders) gl.attachShader(program, s);
  gl.linkProgram(program);
  const result: Program = { program, uniforms: {} };
  state.pending.push({ program: result, shaders });
  return result;
}

/**
 * Whether every program made with createProgram has linked; their uniforms
 * are filled in as they do. Call it once a frame. Browsers with
 * KHR_parallel_shader_compile compile in the background, so this never
 * waits; without it each call waits for one program. Throws if one failed.
 */
export function programsReady(gl: WebGL2RenderingContext) {
  const state = compiling.get(gl);
  if (!state) return true;
  const { parallel, pending } = state;
  while (pending.length) {
    const { program: { program, uniforms }, shaders } = pending[0];
    if (parallel && !gl.getProgramParameter(program, parallel.COMPLETION_STATUS_KHR)) return false;
    pending.shift();
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const failed = shaders.find((s) => !gl.getShaderParameter(s, gl.COMPILE_STATUS));
      throw new Error(
        failed
          ? `pondscape: shader failed to compile\n${gl.getShaderInfoLog(failed)}`
          : `pondscape: program failed to link\n${gl.getProgramInfoLog(program)}`,
      );
    }
    for (const s of shaders) gl.deleteShader(s);
    const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) as number;
    for (let i = 0; i < count; i++) {
      const info = gl.getActiveUniform(program, i)!;
      uniforms[info.name] = gl.getUniformLocation(program, info.name)!;
    }
    if (!parallel) return pending.length === 0;
  }
  return true;
}

/** A texture you can render into. */
export interface Target {
  texture: WebGLTexture;
  framebuffer: WebGLFramebuffer;
  width: number;
  height: number;
}

export function createFloatTarget(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
  { mipmaps = false } = {},
): Target {
  const texture = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, texture);
  // WebGL zero-fills textures created from null, so the water starts flat.
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, width, height, 0, gl.RGBA, gl.HALF_FLOAT, null);
  if (mipmaps) gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(
    gl.TEXTURE_2D,
    gl.TEXTURE_MIN_FILTER,
    mipmaps ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR,
  );
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  const framebuffer = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    throw new Error("pondscape: this device can't render to half-float textures");
  }
  return { texture, framebuffer, width, height };
}

export function deleteTarget(gl: WebGL2RenderingContext, target: Target) {
  gl.deleteFramebuffer(target.framebuffer);
  gl.deleteTexture(target.texture);
}

/** Enables float render targets. Returns false if the device can't do it. */
export function enableFloatTargets(gl: WebGL2RenderingContext) {
  return Boolean(
    gl.getExtension("EXT_color_buffer_float") ??
      gl.getExtension("EXT_color_buffer_half_float"),
  );
}

export function parseColor(hex: string): [number, number, number] {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h.replace(/./g, (c) => c + c);
  const n = parseInt(h, 16);
  if (h.length !== 6 || Number.isNaN(n)) {
    throw new Error(`pondscape: "${hex}" is not a hex color like #3a7 or #33aa77`);
  }
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
