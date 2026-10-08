/*
 * GLSL shared by several passes.
 *
 * World units: the canvas spans x = 0..aspect and y = 0..1, so one unit is
 * the canvas height. z points up, toward the viewer; the water surface sits
 * at z = 0, the base of the bed lies `bedDepth` below it, and pebbles and
 * stones rise from there (see bed.ts).
 */

export const NOISE = /* glsl */ `
float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash(i), hash(i + vec2(1, 0)), u.x),
    mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x),
    u.y
  );
}

float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += a * noise(p);
    p = p * 2.03 + 17.1;
    a *= 0.5;
  }
  return v;
}
`;

export const BED = /* glsl */ `
uniform float u_depth;
uniform float u_aspect;
uniform sampler2D u_bedMap; // rgb = colour, a = height above the base depth

// Depth of the bed below the surface: uneven, and shallower toward the banks.
float bedDepth(vec2 p) {
  vec2 edge = min(p, vec2(u_aspect, 1.0) - p);
  float bank = smoothstep(-0.05, 0.25, min(edge.x, edge.y));
  return u_depth * (0.85 + 0.35 * (fbm(p * 1.7) - 0.5)) * mix(0.55, 1.0, bank);
}

// Depth of whatever is down there first: silt, a pebble or a stone's top.
float floorDepth(vec2 p) {
  return bedDepth(p) - texture(u_bedMap, p / vec2(u_aspect, 1.0)).a;
}

// Where a ray entering the water at \`world\` heading along \`ray\` meets the
// floor. A second step corrects for landing on a stone instead of silt.
vec2 hitFloor(vec2 world, vec3 ray, float surfaceHeight) {
  vec2 hit = world + ray.xy * ((floorDepth(world) + surfaceHeight) / -ray.z);
  return world + ray.xy * ((floorDepth(hit) + surfaceHeight) / -ray.z);
}
`;

/** Index of refraction of air over water. */
export const ETA = "0.7519";
