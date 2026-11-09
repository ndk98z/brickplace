// GLSL for the map. Each tile is one quad; the fragment shader finds its cell from
// gl_FragCoord, reads the cell byte (packages/core/src/cell.ts) from the tile's R8UI texture
// and draws the toy-brick look: rounded cells, merged along link bits into one brick, with
// an inner shadow at the bottom and a highlight at the top.

export const VERTEX = `#version 300 es
in vec2 a_pos;
uniform vec4 u_rect;        // quad in map cells: x, y, w, h
uniform vec2 u_center;      // map point at the viewport centre
uniform float u_zoom;       // device px per cell
uniform vec2 u_resolution;  // drawing buffer in device px
void main() {
  vec2 m = u_rect.xy + a_pos * u_rect.zw;
  vec2 px = (m - u_center) * u_zoom + 0.5 * u_resolution;
  vec2 clip = px / u_resolution * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
}
`;

// Shared by both fragment shaders. Sizes are in cell units, taken from the design's 22 px cell.
const COMMON = `
precision highp float;
precision highp int;
uniform vec2 u_center;
uniform float u_zoom;
uniform vec2 u_resolution;
uniform float u_margin;     // gap on each unlinked side, in cells
uniform float u_line;       // thin line width (empty-cell ring), in cells

const float RADIUS = 5.0 / 22.0;
const float EMPTY_RADIUS = 4.0 / 22.0;
const vec3 EMPTY = vec3(1.0);

vec2 mapPos() {
  vec2 frag = vec2(gl_FragCoord.x, u_resolution.y - gl_FragCoord.y);
  return (frag - 0.5 * u_resolution) / u_zoom + u_center;
}

// Signed distance (cell units, positive inside) from p in [0,1)² to the cell's part of its
// brick. Linked sides (left, right, up, down) run to the cell edge; the others are inset by
// the margin. Only corners between two unlinked sides are rounded.
float brickDist(vec2 p, bvec4 linked, float margin, float radius) {
  float l = linked.x ? 1e3 : p.x - margin;
  float r = linked.y ? 1e3 : 1.0 - margin - p.x;
  float t = linked.z ? 1e3 : p.y - margin;
  float b = linked.w ? 1e3 : 1.0 - margin - p.y;
  float d = min(min(l, r), min(t, b));
  bool west = p.x < 0.5;
  bool north = p.y < 0.5;
  float dx = west ? l : r;
  float dy = north ? t : b;
  bool corner = !(west ? linked.x : linked.y) && !(north ? linked.z : linked.w);
  if (corner && dx < radius && dy < radius) {
    d = radius - length(vec2(radius - dx, radius - dy));
  }
  return d;
}

float coverage(float d, float aa) {
  return clamp(d / aa + 0.5, 0.0, 1.0);
}
`;

/** Area locks the tile shader draws (ADR 0024): the canvas holds at most this many. */
export const MAX_DRAWN_LOCKS = 16;

export const TILE_FRAGMENT = `#version 300 es
${COMMON}
precision highp usampler2D;

uniform vec4 u_locks[${MAX_DRAWN_LOCKS}];  // areas moderators locked: x, y, w, h
uniform int u_lockCount;

uniform usampler2D u_cells;    // this tile, 256 x 256 cell bytes
uniform usampler2D u_left;     // tile to the left, for links into this tile's first column
uniform usampler2D u_up;       // tile above, for links into this tile's first row
uniform usampler2D u_shields;  // this tile's shield layers
uniform usampler2D u_holes;    // 1 where a single brick may go (valid while u_showHoles)
uniform bool u_showHoles;
uniform bool u_grid;           // rings and gaps around empty cells (a player preference)
uniform bool u_hasLeft;
uniform bool u_hasUp;
uniform vec2 u_tile;           // tile origin in cells
uniform vec4 u_open;           // open area: x, y, w, h
uniform float u_detail;        // 0 = flat colour per cell, 1 = full brick look
uniform float u_pips;          // 0 = one shield dot per cell, 1 = a pip per shield layer
uniform vec3 u_palette[32];
out vec4 outColor;

const vec3 GAP = vec3(0.894, 0.910, 0.941);        // #E4E8F0
const vec3 EMPTY_RING = vec3(0.902, 0.918, 0.949); // #E6EAF2
const vec3 CLOSED = vec3(0.839, 0.863, 0.906);     // #D6DCE7
const vec3 HOLE = vec3(1.0, 0.851, 0.659);         // #FFD9A8, a hole a single brick can fill
const vec3 HOLE_RING = vec3(1.0, 0.663, 0.302);    // #FFA94D
const vec3 INK = vec3(0.090, 0.106, 0.149);        // #171B26
const vec3 LOCKED = vec3(0.910, 0.220, 0.310);     // #E8384F, the ghost's warning red

// Shield layers as pips along a brick cell's top edge: one per layer up to PIP_SLOTS; past
// that, PIP_SLOTS - 1 pips and a plus (the exact count shows on hover).
const int PIP_SLOTS = 5;

vec3 shieldPips(vec3 col, vec2 p, int layers, float aa) {
  bool overflow = layers > PIP_SLOTS;
  int dots = overflow ? PIP_SLOTS - 1 : layers;
  for (int i = 0; i < PIP_SLOTS; i++) {
    vec2 c = vec2(0.15 + float(i) * 0.175, 0.22);
    float d = length(p - c);
    if (i < dots) {
      col = mix(col, INK, coverage(0.075 - d, aa));
      col = mix(col, vec3(1.0), coverage(0.045 - d, aa));
    } else if (overflow && i == PIP_SLOTS - 1) {
      col = mix(col, INK, coverage(0.075 - d, aa));
      vec2 q = abs(p - c);
      float bar = max(min(coverage(0.05 - q.x, aa), coverage(0.016 - q.y, aa)),
                      min(coverage(0.016 - q.x, aa), coverage(0.05 - q.y, aa)));
      col = mix(col, vec3(1.0), bar);
    }
  }
  return col;
}

void main() {
  vec2 m = mapPos();
  vec2 cellF = floor(m);
  ivec2 local = clamp(ivec2(cellF - u_tile), ivec2(0), ivec2(255));
  vec2 p = m - cellF;
  float aa = 1.0 / u_zoom;
  bool inOpen = all(greaterThanEqual(cellF, u_open.xy)) &&
                all(lessThan(cellF, u_open.xy + u_open.zw));
  uint cell = texelFetch(u_cells, local, 0).r;

  vec3 flatColor;
  vec3 detailed;
  if ((cell & 128u) != 0u) {
    vec3 base = u_palette[int((cell >> 2u) & 31u)];
    uint left = local.x > 0 ? texelFetch(u_cells, local - ivec2(1, 0), 0).r
              : (u_hasLeft ? texelFetch(u_left, ivec2(255, local.y), 0).r : 0u);
    uint up = local.y > 0 ? texelFetch(u_cells, local - ivec2(0, 1), 0).r
            : (u_hasUp ? texelFetch(u_up, ivec2(local.x, 255), 0).r : 0u);
    bvec4 linked = bvec4((left & 2u) != 0u, (cell & 2u) != 0u,
                         (up & 1u) != 0u, (cell & 1u) != 0u);
    float d = brickDist(p, linked, u_margin, RADIUS);
    vec3 col = base;
    // Inner shadow along the brick's bottom edge, highlight along its top edge.
    float toBottom = linked.w ? 1e3 : 1.0 - u_margin - p.y;
    float toTop = linked.z ? 1e3 : p.y - u_margin;
    col = mix(col, col * 0.82, coverage(3.0 / 22.0 - toBottom, aa));
    col = mix(col, mix(col, vec3(1.0), 0.35), coverage(2.0 / 22.0 - toTop, aa));
    uint shield = texelFetch(u_shields, local, 0).r;
    if (shield > 0u) {
      // Zoomed out, pips would be specks: one dot in the corner says the cell is shielded.
      float badge = coverage(0.22 - length(p - vec2(0.70, 0.30)), aa);
      col = mix(col, mix(col, INK, badge), 1.0 - u_pips);
      col = mix(col, shieldPips(col, p, int(min(shield, 255u)), aa), u_pips);
    }
    detailed = mix(GAP, col, coverage(d, aa));
    flatColor = base;
  } else {
    float d = brickDist(p, bvec4(false), u_margin, EMPTY_RADIUS);
    bool hole = u_showHoles && inOpen && texelFetch(u_holes, local, 0).r != 0u;
    vec3 fill = hole ? HOLE : EMPTY;
    vec3 ring = hole ? HOLE_RING : EMPTY_RING;
    float ringWidth = hole ? 2.0 * u_line : u_line;
    // Without grid lines an empty cell is plain white; a hole keeps its ring.
    bool plain = !u_grid && !hole;
    vec3 col = !inOpen ? CLOSED : plain ? fill : mix(fill, ring, coverage(ringWidth - d, aa));
    detailed = plain ? col : mix(GAP, col, coverage(d, aa));
    flatColor = inOpen ? fill : CLOSED;
  }
  vec3 result = mix(flatColor, detailed, u_detail);
  // A locked area (ADR 0024): diagonal stripes, four cells apart, over whatever is there.
  for (int i = 0; i < ${MAX_DRAWN_LOCKS}; i++) {
    if (i >= u_lockCount) break;
    vec4 area = u_locks[i];
    if (all(greaterThanEqual(cellF, area.xy)) && all(lessThan(cellF, area.xy + area.zw))) {
      float stripe = step(0.5, fract((m.x + m.y) / 4.0));
      result = mix(result, LOCKED, 0.15 + 0.25 * stripe);
      break;
    }
  }
  outColor = vec4(result, 1.0);
}
`;

// Far zoomed out (under one device pixel per cell) the tile shader would pick one cell per
// pixel and shimmer as the map moves. This one samples a per-tile colour texture at half
// resolution with mipmaps instead, so each pixel shows the average of the cells it covers.
export const OVERVIEW_FRAGMENT = `#version 300 es
${COMMON}
uniform sampler2D u_overview;  // this tile's colours, RGBA8, 2 x 2 cells per texel, mipmapped
uniform vec2 u_tile;           // tile origin in cells
out vec4 outColor;

void main() {
  vec2 uv = (mapPos() - u_tile) / 256.0;
  outColor = vec4(texture(u_overview, uv).rgb, 1.0);
}
`;

// Cells the CDN feed just changed (net/spread.ts), fading from their old look to the new one:
// one instanced quad per cell, drawn over the tiles with the old cell's colour and shape at a
// falling alpha. Simplified: an old brick is drawn unlinked and without shields or shading.
export const FADE_VERTEX = `#version 300 es
layout(location = 0) in vec2 a_pos;
layout(location = 1) in vec4 a_fade;  // per cell: x, y, the cell byte before, alpha
uniform vec2 u_center;
uniform float u_zoom;
uniform vec2 u_resolution;
flat out uint v_cell;
out float v_alpha;
void main() {
  vec2 px = (a_fade.xy + a_pos - u_center) * u_zoom + 0.5 * u_resolution;
  vec2 clip = px / u_resolution * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  v_cell = uint(a_fade.z);
  v_alpha = a_fade.w;
}
`;

export const FADE_FRAGMENT = `#version 300 es
${COMMON}
uniform float u_detail;     // as in the tile shader: 0 = flat colour per cell
uniform vec3 u_palette[32];
flat in uint v_cell;
in float v_alpha;
out vec4 outColor;

void main() {
  vec2 m = mapPos();
  vec2 p = m - floor(m);
  float aa = 1.0 / u_zoom;
  bool filled = (v_cell & 128u) != 0u;
  vec3 col = filled ? u_palette[int((v_cell >> 2u) & 31u)] : EMPTY;
  float d = brickDist(p, bvec4(false), u_margin, filled ? RADIUS : EMPTY_RADIUS);
  float a = v_alpha * mix(1.0, coverage(d, aa), u_detail);
  // Premultiplied alpha, like the ghost.
  outColor = vec4(col * a, a);
}
`;

export const GHOST_FRAGMENT = `#version 300 es
${COMMON}
uniform ivec3 u_ghost[4];   // x, y, linked sides (1 left, 2 right, 4 up, 8 down)
uniform int u_ghostCount;
uniform vec3 u_fill;
uniform float u_fillAlpha;
uniform vec3 u_outline;
uniform float u_dash;       // dash period in device px
out vec4 outColor;

void main() {
  vec2 m = mapPos();
  ivec2 c = ivec2(floor(m));
  int sides = -1;
  for (int i = 0; i < 4; i++) {
    if (i < u_ghostCount && u_ghost[i].xy == c) sides = u_ghost[i].z;
  }
  if (sides < 0) discard;
  vec2 p = m - floor(m);
  bvec4 linked = bvec4((sides & 1) != 0, (sides & 2) != 0, (sides & 4) != 0, (sides & 8) != 0);
  float aa = 1.0 / u_zoom;
  float d = brickDist(p, linked, u_margin, RADIUS);
  float inside = coverage(d, aa);
  float width = max(2.0 / 22.0, 1.5 * aa);
  float dash = step(0.5, fract((gl_FragCoord.x + gl_FragCoord.y) / u_dash));
  float line = coverage(width - d, aa) * inside * dash;
  // Premultiplied alpha: outline over a translucent fill.
  vec4 fill = vec4(u_fill * u_fillAlpha, u_fillAlpha) * inside;
  outColor = vec4(u_outline, 1.0) * line + fill * (1.0 - line);
}
`;
