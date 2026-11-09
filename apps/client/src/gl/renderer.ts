import { type Rect, TILE_SIZE } from '@brickplace/core';
import { type Camera, type Viewport, visibleTiles } from '../map/camera.ts';
import type { Ghost } from '../map/ghost.ts';
import { HoleMasks } from '../map/holes.ts';
import { drawMinimapTile } from '../map/minimap.ts';
import type { DirtyRect, DirtyTracker, MapStore } from '../map/store.ts';
import { hexToRgb, paletteFloats } from '../palette.ts';
import {
  FADE_FRAGMENT,
  FADE_VERTEX,
  GHOST_FRAGMENT,
  MAX_DRAWN_LOCKS,
  OVERVIEW_FRAGMENT,
  TILE_FRAGMENT,
  VERTEX,
} from './shaders.ts';

export interface Frame {
  readonly camera: Camera;
  readonly viewport: Viewport;
  readonly dpr: number;
  /** The frame's time (ms, performance.now's clock), for fading cells. */
  readonly now: number;
  readonly ghost: GhostStyle | null;
  /** Highlight the holes a single brick can fill (a single brick is selected). */
  readonly holes: boolean;
  /** Rings and gaps around empty cells (the "Grid lines" preference). */
  readonly grid: boolean;
}

/** Cells per overview texel along each side: a 256² tile becomes 128² colours. */
export const OVERVIEW_FACTOR = 2;

/**
 * Below one device pixel per cell the map is drawn from the mipmapped overview, so far
 * zoom-out does not shimmer; at or above it every cell gets at least one pixel.
 */
export function useOverview(zoomDevicePx: number): boolean {
  return zoomDevicePx < 1;
}

/**
 * Holes are highlighted from this zoom (CSS px per cell) on: further out they are too small
 * to see, and computing them for the whole map would stall a frame.
 */
export const HOLES_MIN_ZOOM = 2;

export function showHoles(wanted: boolean, zoom: number): boolean {
  return wanted && zoom >= HOLES_MIN_ZOOM;
}

export interface GhostStyle {
  readonly ghost: Ghost;
  /** Brick colour for a brick; tint for a hammer or shield target. */
  readonly fill: string;
  readonly fillAlpha: number;
  readonly outline: string;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * How much of the brick look to draw at a zoom (CSS px per cell). Below a few px per cell
 * gaps and rounded corners would alias into noise, so cells fade to flat colour.
 */
export function detailFor(zoom: number): { detail: number; pips: number } {
  return { detail: smoothstep(3, 9, zoom), pips: smoothstep(10, 16, zoom) };
}

/**
 * Gap and thin-line widths in cells. They follow the design's 22 px cell (1 px each) up to
 * that zoom, then stay about one CSS px wide so a zoomed-in map does not turn into a grid.
 */
export function cellMetrics(zoom: number): { margin: number; line: number } {
  const designPx = 1 / 22;
  return { margin: Math.min(designPx, 1.25 / zoom), line: Math.min(designPx, 1 / zoom) };
}

/** How long a cell the CDN feed changed takes to fade from its old look to its new one (ms). */
export const FADE_MS = 300;
/** Cells fading at once at most; past that, changes show without fading. */
export const MAX_FADES = 4096;

/** How much of a cell's old look still shows `age` ms into its fade: 1, easing to 0. */
export function fadeAlpha(age: number): number {
  return 1 - smoothstep(0, FADE_MS, age);
}

/** A dirty rect as texSubImage2D arguments for a 256-wide tile buffer. */
export function uploadRegion(rect: DirtyRect): {
  x: number;
  y: number;
  width: number;
  height: number;
  offset: number;
} {
  return {
    x: rect.x0,
    y: rect.y0,
    width: rect.x1 - rect.x0 + 1,
    height: rect.y1 - rect.y0 + 1,
    offset: rect.y0 * TILE_SIZE + rect.x0,
  };
}

/** The ghost as the shader's uniform array: x, y, linked sides per cell. */
export function ghostUniform(ghost: Ghost): Int32Array {
  const out = new Int32Array(12);
  ghost.cells.slice(0, 4).forEach((c, i) => {
    out.set([c.x, c.y, c.sides], i * 3);
  });
  return out;
}

function rgb(hex: string): [number, number, number] {
  const [r, g, b] = hexToRgb(hex);
  return [r / 255, g / 255, b / 255];
}

const BACKGROUND = rgb('#E4E8F0');

interface Programs {
  tile: WebGLProgram;
  ghost: WebGLProgram;
  overview: WebGLProgram;
  fade: WebGLProgram;
  tileUniforms: Record<string, WebGLUniformLocation | null>;
  ghostUniforms: Record<string, WebGLUniformLocation | null>;
  overviewUniforms: Record<string, WebGLUniformLocation | null>;
  fadeUniforms: Record<string, WebGLUniformLocation | null>;
}

/** A cell fading from its old look: where, the cell byte it had, and since when (ms). */
interface Fade {
  readonly x: number;
  readonly y: number;
  readonly before: number;
  readonly start: number;
}

/**
 * Draws the map with WebGL2: one R8UI texture of cell bytes and one of shield layers per
 * 256² tile, coloured by the palette in the shader. Changed cells are uploaded with
 * texSubImage2D once per frame, and nothing runs while nothing changes: the owner calls
 * draw() only when the camera, the ghost or the map moved.
 *
 * Two more per-tile textures are made on first use: an R8UI hole mask while a single brick
 * is selected, and, far zoomed out, a mipmapped RGBA8 overview (see OVERVIEW_FRAGMENT). Both
 * are refreshed only for tiles on screen.
 *
 * Cells handed to fade() are drawn over the tiles in their old look for FADE_MS, fading out;
 * the owner keeps drawing frames while `fading`.
 */
export class MapRenderer {
  private gl: WebGL2RenderingContext;
  private programs!: Programs;
  private vao!: WebGLVertexArrayObject;
  /** The quad plus one instance per fading cell (FADE_VERTEX). */
  private fadeVao!: WebGLVertexArrayObject;
  private fadeBuffer!: WebGLBuffer;
  private fades: Fade[] = [];
  private cellTextures: WebGLTexture[] = [];
  private shieldTextures: WebGLTexture[] = [];
  private holeTextures = new Map<number, WebGLTexture>();
  private overviewTextures = new Map<number, WebGLTexture>();
  /** Tiles whose overview is out of date (all at first). */
  private readonly overviewStale = new Set<number>();
  private readonly overviewTracker: DirtyTracker;
  private readonly overviewPixels: Uint8Array;
  private readonly holes: HoleMasks;
  private readonly tracker: DirtyTracker;
  private lost = false;
  /** Areas moderators locked (ADR 0024), drawn striped; at most MAX_DRAWN_LOCKS of them. */
  private locks: readonly Rect[] = [];

  static create(
    canvas: HTMLCanvasElement,
    store: MapStore,
    open: Rect,
    onRestored: () => void,
  ): MapRenderer | null {
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false });
    if (!gl) return null;
    return new MapRenderer(canvas, gl, store, open, onRestored);
  }

  private constructor(
    canvas: HTMLCanvasElement,
    gl: WebGL2RenderingContext,
    private readonly store: MapStore,
    private open: Rect,
    onRestored: () => void,
  ) {
    this.gl = gl;
    this.tracker = store.track();
    this.overviewTracker = store.track();
    const side = TILE_SIZE / OVERVIEW_FACTOR;
    this.overviewPixels = new Uint8Array(side * side * 4);
    this.holes = new HoleMasks(store, open);
    canvas.addEventListener('webglcontextlost', (event) => {
      event.preventDefault();
      this.lost = true;
      // Nothing is drawn until the context is back: no fade may keep the owner drawing.
      this.fades = [];
    });
    canvas.addEventListener('webglcontextrestored', () => {
      this.lost = false;
      this.init();
      this.tracker.markAll();
      onRestored();
    });
    this.init();
  }

  /**
   * Fades cells from the cell byte they had before (`before`) to what the store holds now,
   * starting at `now` (ms). Past MAX_FADES at once, the rest show without fading.
   */
  fade(cells: readonly { readonly index: number; readonly before: number }[], now: number): void {
    if (this.lost) return;
    const size = this.store.size;
    for (const { index, before } of cells) {
      if (this.fades.length >= MAX_FADES) break;
      const x = index % size;
      this.fades.push({ x, y: (index - x) / size, before, start: now });
    }
  }

  /** Cells are still fading: the owner should draw another frame. */
  get fading(): boolean {
    return this.fades.length > 0;
  }

  /** Stops every fade: the store's map was replaced (a socket's grid), the old looks are moot. */
  clearFades(): void {
    this.fades = [];
  }

  /** The server's area locks changed (ADR 0024): they are drawn striped over the map. */
  setLocks(locks: readonly Rect[]): void {
    this.locks = locks.slice(0, MAX_DRAWN_LOCKS);
    if (this.lost) return;
    this.uploadLocks();
  }

  private uploadLocks(): void {
    const gl = this.gl;
    const values = new Float32Array(MAX_DRAWN_LOCKS * 4);
    for (const [i, lock] of this.locks.entries()) {
      values.set([lock.x, lock.y, lock.w, lock.h], i * 4);
    }
    gl.useProgram(this.programs.tile);
    gl.uniform4fv(this.programs.tileUniforms.u_locks!, values);
    gl.uniform1i(this.programs.tileUniforms.u_lockCount!, this.locks.length);
  }

  /** The server's open area arrived or grew: closed cells, holes and overview change. */
  setOpenArea(open: Rect): void {
    this.open = open;
    this.holes.setOpen(open);
    this.overviewTracker.markAll();
    if (this.lost) return;
    const gl = this.gl;
    gl.useProgram(this.programs.tile);
    gl.uniform4f(this.programs.tileUniforms.u_open!, open.x, open.y, open.w, open.h);
  }

  private init(): void {
    const gl = this.gl;
    const tile = link(gl, VERTEX, TILE_FRAGMENT);
    const ghost = link(gl, VERTEX, GHOST_FRAGMENT);
    const overview = link(gl, VERTEX, OVERVIEW_FRAGMENT);
    const fade = link(gl, FADE_VERTEX, FADE_FRAGMENT);
    const common = ['u_rect', 'u_center', 'u_zoom', 'u_resolution', 'u_margin', 'u_line'];
    this.programs = {
      tile,
      ghost,
      overview,
      fade,
      tileUniforms: locations(gl, tile, [
        ...common,
        'u_cells',
        'u_left',
        'u_up',
        'u_shields',
        'u_holes',
        'u_showHoles',
        'u_grid',
        'u_hasLeft',
        'u_hasUp',
        'u_tile',
        'u_open',
        'u_detail',
        'u_pips',
        'u_palette',
        'u_locks',
        'u_lockCount',
      ]),
      ghostUniforms: locations(gl, ghost, [
        ...common,
        'u_ghost',
        'u_ghostCount',
        'u_fill',
        'u_fillAlpha',
        'u_outline',
        'u_dash',
      ]),
      overviewUniforms: locations(gl, overview, [...common, 'u_overview', 'u_tile']),
      fadeUniforms: locations(gl, fade, [...common, 'u_detail', 'u_palette']),
    };

    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    for (const program of [tile, ghost, overview]) {
      const at = gl.getAttribLocation(program, 'a_pos');
      gl.enableVertexAttribArray(at);
      gl.vertexAttribPointer(at, 2, gl.FLOAT, false, 0, 0);
    }
    // The fade pass: the same quad at location 0, one vec4 per fading cell at location 1.
    this.fadeVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.fadeVao);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.fadeBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.fadeBuffer);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.bindVertexArray(this.vao);

    gl.useProgram(fade);
    gl.uniform3fv(this.programs.fadeUniforms.u_palette!, paletteFloats());
    gl.useProgram(tile);
    gl.uniform3fv(this.programs.tileUniforms.u_palette!, paletteFloats());
    gl.uniform1i(this.programs.tileUniforms.u_cells!, 0);
    gl.uniform1i(this.programs.tileUniforms.u_left!, 1);
    gl.uniform1i(this.programs.tileUniforms.u_up!, 2);
    gl.uniform1i(this.programs.tileUniforms.u_shields!, 3);
    gl.uniform1i(this.programs.tileUniforms.u_holes!, 4);
    gl.useProgram(overview);
    gl.uniform1i(this.programs.overviewUniforms.u_overview!, 0);
    gl.useProgram(tile);
    gl.uniform4f(
      this.programs.tileUniforms.u_open!,
      this.open.x,
      this.open.y,
      this.open.w,
      this.open.h,
    );
    this.uploadLocks();

    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, TILE_SIZE);
    this.cellTextures = [];
    this.shieldTextures = [];
    for (let i = 0; i < this.store.tileCount; i++) {
      this.cellTextures.push(createTileTexture(gl, this.store.cells[i]!));
      this.shieldTextures.push(createTileTexture(gl, this.store.shields[i]!));
    }
    // The textures were just filled from the store, so nothing is pending.
    this.tracker.take();
    // Hole masks and overviews are made again on first use (a lost context took them).
    this.holeTextures = new Map();
    this.overviewTextures = new Map();
    this.holes.setOpen(this.open);
    this.overviewTracker.markAll();
  }

  /** Uploads what changed since the last frame, then draws the visible tiles and the ghost. */
  draw(frame: Frame): void {
    if (this.lost) return;
    const gl = this.gl;
    const canvas = gl.canvas as HTMLCanvasElement;
    const width = Math.max(1, Math.round(frame.viewport.width * frame.dpr));
    const height = Math.max(1, Math.round(frame.viewport.height * frame.dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    this.upload();

    gl.viewport(0, 0, width, height);
    gl.clearColor(BACKGROUND[0], BACKGROUND[1], BACKGROUND[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindVertexArray(this.vao);

    const { camera } = frame;
    const zoomPx = camera.zoom * frame.dpr;
    const visible = visibleTiles(camera, frame.viewport, this.store.size);
    gl.disable(gl.BLEND);
    this.fades = this.fades.filter((f) => frame.now - f.start < FADE_MS);
    if (useOverview(zoomPx)) {
      this.drawOverview(visible, frame, zoomPx, width, height);
    } else {
      this.drawTiles(visible, frame, zoomPx, width, height);
      this.drawFades(frame, zoomPx, width, height);
    }
    if (frame.ghost) this.drawGhost(frame, zoomPx, width, height);
  }

  /** Draws each fading cell's old look over the tiles, more transparent as it ages. */
  private drawFades(frame: Frame, zoomPx: number, width: number, height: number): void {
    if (this.fades.length === 0) return;
    const gl = this.gl;
    const data = new Float32Array(this.fades.length * 4);
    this.fades.forEach((f, i) => {
      data.set([f.x, f.y, f.before, fadeAlpha(frame.now - f.start)], i * 4);
    });
    const { fade, fadeUniforms: u } = this.programs;
    gl.useProgram(fade);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.uniform2f(u.u_center!, frame.camera.cx, frame.camera.cy);
    gl.uniform1f(u.u_zoom!, zoomPx);
    gl.uniform2f(u.u_resolution!, width, height);
    gl.uniform1f(u.u_margin!, cellMetrics(frame.camera.zoom).margin);
    gl.uniform1f(u.u_detail!, detailFor(frame.camera.zoom).detail);
    gl.bindVertexArray(this.fadeVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.fadeBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STREAM_DRAW);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.fades.length);
    gl.bindVertexArray(this.vao);
    gl.disable(gl.BLEND);
  }

  private drawTiles(
    visible: readonly number[],
    frame: Frame,
    zoomPx: number,
    width: number,
    height: number,
  ): void {
    const gl = this.gl;
    const { camera } = frame;
    const holes = showHoles(frame.holes, camera.zoom);
    if (holes) this.uploadHoles(visible);
    const { tile, tileUniforms: u } = this.programs;
    gl.useProgram(tile);
    gl.uniform1i(u.u_showHoles!, holes ? 1 : 0);
    gl.uniform1i(u.u_grid!, frame.grid ? 1 : 0);
    gl.uniform2f(u.u_center!, camera.cx, camera.cy);
    gl.uniform1f(u.u_zoom!, zoomPx);
    gl.uniform2f(u.u_resolution!, width, height);
    const { margin, line } = cellMetrics(camera.zoom);
    gl.uniform1f(u.u_margin!, margin);
    gl.uniform1f(u.u_line!, line);
    const { detail, pips } = detailFor(camera.zoom);
    gl.uniform1f(u.u_detail!, detail);
    gl.uniform1f(u.u_pips!, pips);

    const perSide = this.store.tilesPerSide;
    for (const index of visible) {
      const tx = index % perSide;
      const ty = Math.floor(index / perSide);
      bindTexture(gl, 0, this.cellTextures[index]!);
      bindTexture(gl, 1, tx > 0 ? this.cellTextures[index - 1]! : this.cellTextures[index]!);
      bindTexture(gl, 2, ty > 0 ? this.cellTextures[index - perSide]! : this.cellTextures[index]!);
      bindTexture(gl, 3, this.shieldTextures[index]!);
      // Unit 4 always holds an integer texture; it is only read while holes are shown.
      bindTexture(gl, 4, (holes && this.holeTextures.get(index)) || this.cellTextures[index]!);
      gl.uniform1i(u.u_hasLeft!, tx > 0 ? 1 : 0);
      gl.uniform1i(u.u_hasUp!, ty > 0 ? 1 : 0);
      gl.uniform2f(u.u_tile!, tx * TILE_SIZE, ty * TILE_SIZE);
      gl.uniform4f(u.u_rect!, tx * TILE_SIZE, ty * TILE_SIZE, TILE_SIZE, TILE_SIZE);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
  }

  private drawOverview(
    visible: readonly number[],
    frame: Frame,
    zoomPx: number,
    width: number,
    height: number,
  ): void {
    const gl = this.gl;
    this.uploadOverview(visible);
    const { overview, overviewUniforms: u } = this.programs;
    gl.useProgram(overview);
    gl.uniform2f(u.u_center!, frame.camera.cx, frame.camera.cy);
    gl.uniform1f(u.u_zoom!, zoomPx);
    gl.uniform2f(u.u_resolution!, width, height);
    const perSide = this.store.tilesPerSide;
    for (const index of visible) {
      const tx = index % perSide;
      const ty = Math.floor(index / perSide);
      bindTexture(gl, 0, this.overviewTextures.get(index)!);
      gl.uniform2f(u.u_tile!, tx * TILE_SIZE, ty * TILE_SIZE);
      gl.uniform4f(u.u_rect!, tx * TILE_SIZE, ty * TILE_SIZE, TILE_SIZE, TILE_SIZE);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
  }

  /** Recomputes and uploads the hole masks of visible tiles where cells nearby changed. */
  private uploadHoles(visible: readonly number[]): void {
    const gl = this.gl;
    for (const [index, mask] of this.holes.update(visible)) {
      const texture = this.holeTextures.get(index);
      if (!texture) {
        this.holeTextures.set(index, createTileTexture(gl, mask));
        continue;
      }
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        0,
        TILE_SIZE,
        TILE_SIZE,
        gl.RED_INTEGER,
        gl.UNSIGNED_BYTE,
        mask,
      );
    }
  }

  /** Rebuilds the overview (colours and mipmaps) of visible tiles that changed. */
  private uploadOverview(visible: readonly number[]): void {
    for (const index of this.overviewTracker.take().keys()) this.overviewStale.add(index);
    const gl = this.gl;
    const side = TILE_SIZE / OVERVIEW_FACTOR;
    gl.activeTexture(gl.TEXTURE0);
    // The overview buffer is tightly packed, unlike the 256-wide cell buffers.
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
    for (const index of visible) {
      let texture = this.overviewTextures.get(index);
      if (texture && !this.overviewStale.has(index)) continue;
      this.overviewStale.delete(index);
      drawMinimapTile(this.store, index, OVERVIEW_FACTOR, this.open, this.overviewPixels, side, {
        boost: 1,
        atOrigin: true,
      });
      if (!texture) {
        texture = gl.createTexture()!;
        this.overviewTextures.set(index, texture);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      } else {
        gl.bindTexture(gl.TEXTURE_2D, texture);
      }
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA8,
        side,
        side,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        this.overviewPixels,
      );
      gl.generateMipmap(gl.TEXTURE_2D);
    }
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, TILE_SIZE);
  }

  private drawGhost(frame: Frame, zoomPx: number, width: number, height: number): void {
    const gl = this.gl;
    const style = frame.ghost!;
    const cells = style.ghost.cells;
    if (cells.length === 0) return;
    const { ghost, ghostUniforms: u } = this.programs;
    gl.useProgram(ghost);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.uniform2f(u.u_center!, frame.camera.cx, frame.camera.cy);
    gl.uniform1f(u.u_zoom!, zoomPx);
    gl.uniform2f(u.u_resolution!, width, height);
    gl.uniform1f(u.u_margin!, cellMetrics(frame.camera.zoom).margin);
    const xs = cells.map((c) => c.x);
    const ys = cells.map((c) => c.y);
    const x0 = Math.min(...xs);
    const y0 = Math.min(...ys);
    gl.uniform4f(u.u_rect!, x0, y0, Math.max(...xs) - x0 + 1, Math.max(...ys) - y0 + 1);
    gl.uniform3iv(u.u_ghost!, ghostUniform(style.ghost));
    gl.uniform1i(u.u_ghostCount!, Math.min(4, cells.length));
    gl.uniform3fv(u.u_fill!, rgb(style.fill));
    gl.uniform1f(u.u_fillAlpha!, style.fillAlpha);
    gl.uniform3fv(u.u_outline!, rgb(style.outline));
    gl.uniform1f(u.u_dash!, 10 * frame.dpr);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  private upload(): void {
    if (this.tracker.size === 0) return;
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    for (const [index, rect] of this.tracker.take()) {
      const r = uploadRegion(rect);
      for (const [texture, data] of [
        [this.cellTextures[index]!, this.store.cells[index]!],
        [this.shieldTextures[index]!, this.store.shields[index]!],
      ] as const) {
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texSubImage2D(
          gl.TEXTURE_2D,
          0,
          r.x,
          r.y,
          r.width,
          r.height,
          gl.RED_INTEGER,
          gl.UNSIGNED_BYTE,
          data,
          r.offset,
        );
      }
    }
  }
}

function createTileTexture(gl: WebGL2RenderingContext, data: Uint8Array): WebGLTexture {
  const texture = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, texture);
  // Integer textures cannot be filtered; NEAREST and texelFetch keep every cell exact.
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.R8UI,
    TILE_SIZE,
    TILE_SIZE,
    0,
    gl.RED_INTEGER,
    gl.UNSIGNED_BYTE,
    data,
  );
  return texture;
}

function bindTexture(gl: WebGL2RenderingContext, unit: number, texture: WebGLTexture): void {
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, texture);
}

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(`shader compile failed: ${gl.getShaderInfoLog(shader)}`);
  }
  return shader;
}

function link(gl: WebGL2RenderingContext, vertex: string, fragment: string): WebGLProgram {
  const program = gl.createProgram()!;
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, vertex));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, fragment));
  gl.bindAttribLocation(program, 0, 'a_pos');
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`program link failed: ${gl.getProgramInfoLog(program)}`);
  }
  return program;
}

function locations(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
  names: readonly string[],
): Record<string, WebGLUniformLocation | null> {
  return Object.fromEntries(names.map((name) => [name, gl.getUniformLocation(program, name)]));
}
