import type { FishSpec } from "pond";

/*
 * Her fish: three tancho whose red head patch is shaped, not round. The S
 * and A are faint enough to pass for a quirk of the pattern; the heart is
 * clearer. This file is the only place they exist: leave them out of the
 * fish list and they're gone. Before this repository goes public, move this
 * file to her site.
 *
 * Paths are SVG path data in a 100 × 100 box, top toward the fish's snout.
 */

const S = "M72 24 C 62 12 32 12 30 32 C 28 48 72 50 72 68 C 72 88 36 92 26 76";
const A = "M24 86 L 50 16 L 76 86 M 35 62 L 65 62";
const HEART = "M50 86 C 22 66 8 50 12 32 C 16 16 36 12 50 30 C 64 12 84 16 88 32 C 92 50 78 66 50 86 Z";

export const giftFish: FishSpec[] = [
  { variety: "tancho", mark: { path: S, stroke: 15, strength: 0.7 } },
  { variety: "tancho", mark: { path: A, stroke: 15, strength: 0.7 } },
  { variety: "tancho", mark: { path: HEART, strength: 0.95 } },
];
