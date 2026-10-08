/*
 * The underwater layer: everything between the surface and the floor (grass
 * now, fish later), drawn from straight above with no refraction. It has two
 * textures, filled together:
 *
 *   colour: rgb = linear albedo, a = coverage
 *   depth:  r = depth below the surface (world units), a = coverage
 *
 * The compose pass looks at it through the rippling surface, lights it, and
 * uses it to cast shadows onto the floor. Both are mipmapped so shadows can
 * blur with height.
 */

export interface LayerTarget {
  framebuffer: WebGLFramebuffer;
  colour: WebGLTexture;
  depth: WebGLTexture;
  width: number;
  height: number;
}

function texture(gl: WebGL2RenderingContext, width: number, height: number) {
  const t = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, width, height, 0, gl.RGBA, gl.HALF_FLOAT, null);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}

export class Underwater {
  private target: LayerTarget | null = null;

  constructor(private gl: WebGL2RenderingContext) {}

  get layer() {
    return this.target;
  }

  resize(width: number, height: number) {
    const { gl } = this;
    if (this.target?.width === width && this.target?.height === height) return;
    this.disposeTarget();
    const colour = texture(gl, width, height);
    const depth = texture(gl, width, height);
    const framebuffer = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, colour, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, depth, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.target = { framebuffer, colour, depth, width, height };
  }

  /** Clears the layer and leaves it bound, set up for drawing see-through edges. */
  begin() {
    const { gl, target } = this;
    if (!target) return;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.viewport(0, 0, target.width, target.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  /** Finishes the layer: builds the blurred levels that soft shadows read. */
  end() {
    const { gl, target } = this;
    if (!target) return;
    gl.disable(gl.BLEND);
    gl.bindTexture(gl.TEXTURE_2D, target.colour);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.bindTexture(gl.TEXTURE_2D, target.depth);
    gl.generateMipmap(gl.TEXTURE_2D);
  }

  private disposeTarget() {
    const { gl, target } = this;
    if (!target) return;
    gl.deleteFramebuffer(target.framebuffer);
    gl.deleteTexture(target.colour);
    gl.deleteTexture(target.depth);
    this.target = null;
  }

  dispose() {
    this.disposeTarget();
  }
}

