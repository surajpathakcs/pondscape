import { parseColor } from "./gl";

/*
 * Custom head markings for koi: a shape given as SVG path data, drawn by the
 * pattern shader as a natural colour patch on the top of the head.
 *
 * Each shape is drawn once, softly, into its own cell of a small texture.
 * The shader warps its edge with noise and mottles it, so it reads as
 * part of the fish's pattern rather than a printed stamp.
 */

export interface KoiMark {
  /**
   * SVG path data in a 100 × 100 box. The box sits on top of the head with
   * its top edge toward the snout and its left edge on the fish's left.
   */
  path: string;
  /** Draw the path as a line this wide (in the same units) instead of filling it. */
  stroke?: number;
  /** Colour of the mark. Default koi red. */
  colour?: string;
  /** How strongly it shows, 0 to 1. Lower values let it blend into the pattern. Default 0.9. */
  strength?: number;
}

/** Pixels per mark cell; the shape is drawn inside a small margin. */
const CELL = 64;
const MARGIN = 4;

/** The pattern's red (linear), for marks without a colour. */
const KOI_RED: [number, number, number] = [0.4, 0.06, 0.016];

export class MarkAtlas {
  private atlas: WebGLTexture;

  constructor(
    private gl: WebGL2RenderingContext,
    private cells: number,
  ) {
    this.atlas = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.atlas);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, CELL * cells, CELL, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  get texture() {
    return this.atlas;
  }

  get cellCount() {
    return this.cells;
  }

  /**
   * Draws a mark into cell `index`, and returns its colour (linear) and
   * strength for the shader; strength 0 means no mark.
   */
  set(index: number, mark: KoiMark | undefined): [number, number, number, number] {
    if (!mark) return [0, 0, 0, 0];
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = CELL;
    const ctx = canvas.getContext("2d")!;
    const scale = (CELL - MARGIN * 2) / 100;
    // A slight blur gives the shader a soft edge to shape.
    ctx.filter = "blur(1px)";
    ctx.translate(MARGIN, MARGIN);
    ctx.scale(scale, scale);
    const path = new Path2D(mark.path);
    ctx.fillStyle = ctx.strokeStyle = "#fff";
    if (mark.stroke) {
      ctx.lineWidth = mark.stroke;
      ctx.lineCap = ctx.lineJoin = "round";
      ctx.stroke(path);
    } else {
      ctx.fill(path);
    }
    const { gl } = this;
    gl.bindTexture(gl.TEXTURE_2D, this.atlas);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, index * CELL, 0, gl.RGBA, gl.UNSIGNED_BYTE, canvas);

    const colour = mark.colour
      ? (parseColor(mark.colour).map((c) => c ** 2.2 * 0.75) as [number, number, number])
      : KOI_RED;
    return [...colour, Math.min(Math.max(mark.strength ?? 0.9, 0), 1)];
  }

  dispose() {
    this.gl.deleteTexture(this.atlas);
  }
}
