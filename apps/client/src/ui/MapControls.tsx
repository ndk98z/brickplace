import { TILE_SIZE } from '@brickplace/core';
import { useEffect, useRef } from 'preact/hooks';
import type { Game } from '../game/game.ts';
import type { Teams } from '../game/teams.ts';
import { mapToScreen, visibleRect } from '../map/camera.ts';
import { drawMinimapTile } from '../map/minimap.ts';
import { CameraIcon, FlagIcon, MinusIcon, PlusIcon } from './icons.tsx';
import { useSelector } from './observable.ts';
import { TeamPill } from './TeamScreens.tsx';

const number = new Intl.NumberFormat('en-US');

export function zoomLabel(zoom: number): string {
  if (zoom >= 10) return `${Math.round(zoom)}×`;
  return `${Number(zoom.toFixed(zoom >= 1 ? 1 : 2))}×`;
}

function Coordinates({ game }: { game: Game }) {
  const { x, y, zoom } = useSelector(game.ui, (s) => ({
    x: s.hover?.x ?? Math.floor(s.camera.cx),
    y: s.hover?.y ?? Math.floor(s.camera.cy),
    zoom: s.camera.zoom,
  }));
  const coords = useSelector(game.prefs.state, (p) => p.coords);
  return (
    <span class="pill" aria-live="off">
      {coords && `x ${number.format(x)} · y ${number.format(y)} · `}
      {zoomLabel(zoom)}
    </span>
  );
}

/**
 * The exact shield count of the brick cell under the pointer, beside it: the map draws at
 * most a few pips per cell. Hidden while bricks are drawn flat (zoomed far out).
 */
export function ShieldTip({ game }: { game: Game }) {
  const tip = useSelector(game.ui, (s) => {
    if (!s.hover || s.camera.zoom < 3) return null;
    const layers = game.store.shield(s.hover.x, s.hover.y);
    if (layers === 0) return null;
    const at = mapToScreen(s.camera, s.viewport, { x: s.hover.x + 1, y: s.hover.y });
    return { layers, left: Math.round(at.x), top: Math.round(at.y) };
  });
  if (!tip) return null;
  return (
    <span class="shield-tip" style={{ left: `${tip.left}px`, top: `${tip.top}px` }}>
      Shield ×{tip.layers}
    </span>
  );
}

/** Coordinates, team, zoom, snapshot and report, top left over the map. */
export function MapControls({
  game,
  teams,
  onShare,
  onHelp,
}: {
  game: Game;
  teams: Teams;
  onShare?: () => void;
  onHelp?: () => void;
}) {
  return (
    <>
      <div class="map-pills">
        <Coordinates game={game} />
        <TeamPill teams={teams} game={game} />
      </div>
      <div class="map-buttons">
        <button type="button" class="icon-btn" aria-label="Zoom in" onClick={() => game.zoomBy(2)}>
          <PlusIcon />
        </button>
        <button
          type="button"
          class="icon-btn"
          aria-label="Zoom out"
          onClick={() => game.zoomBy(0.5)}
        >
          <MinusIcon />
        </button>
        <button
          type="button"
          class="icon-btn"
          aria-label="Share this view"
          title="Share this view"
          disabled={!onShare}
          onClick={onShare}
        >
          <CameraIcon />
        </button>
        {onHelp && (
          <button
            type="button"
            class="icon-btn icon-btn-text"
            aria-label="How to play"
            title="How to play"
            onClick={onHelp}
          >
            ?
          </button>
        )}
        <button
          type="button"
          class="icon-btn"
          aria-label="Report this area (coming soon)"
          title="Reports are not built yet (stub)"
          disabled
        >
          <FlagIcon />
        </button>
      </div>
    </>
  );
}

const MINIMAP_PX = 168;
const REDRAW_MS = 250;

/** Overview of the whole map, bottom left; click or drag to jump. */
export function Minimap({ game }: { game: Game }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { store } = game;
  // Redrawn in full when the server's open area arrives or grows.
  const open = useSelector(game.ui, (s) => s.rules.open, Object.is);
  // One minimap pixel per `factor`² cells: 256 px for any map of 256² or more.
  const factor = Math.max(1, store.size / 256);
  const side = store.size / factor;

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const tracker = store.track();
    const image = ctx.createImageData(side, side);
    const tilePx = TILE_SIZE / factor;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const redraw = () => {
      timer = null;
      for (const tile of tracker.take().keys()) {
        drawMinimapTile(store, tile, factor, open, image.data, side);
        const x = (tile % store.tilesPerSide) * tilePx;
        const y = Math.floor(tile / store.tilesPerSide) * tilePx;
        ctx.putImageData(image, 0, 0, x, y, tilePx, tilePx);
      }
    };
    redraw();
    const unsubscribe = store.subscribe(() => {
      timer ??= setTimeout(redraw, REDRAW_MS);
    });
    return () => {
      unsubscribe();
      store.untrack(tracker);
      if (timer !== null) clearTimeout(timer);
    };
  }, [store, open, factor, side]);

  const rect = useSelector(game.ui, (s) => {
    const r = visibleRect(s.camera, s.viewport);
    const scale = MINIMAP_PX / store.size;
    const x0 = Math.max(0, r.x0) * scale;
    const y0 = Math.max(0, r.y0) * scale;
    const x1 = Math.min(store.size, r.x1) * scale;
    const y1 = Math.min(store.size, r.y1) * scale;
    return { left: x0, top: y0, width: Math.max(4, x1 - x0), height: Math.max(4, y1 - y0) };
  });

  const jump = (event: PointerEvent) => {
    const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const x = ((event.clientX - box.left) / box.width) * store.size;
    const y = ((event.clientY - box.top) / box.height) * store.size;
    game.centerOn(x, y);
  };

  return (
    <div class="minimap">
      <div class="minimap-title">
        Overview · {number.format(store.size)} × {number.format(store.size)}
      </div>
      <div
        class="minimap-map"
        style={{ width: `${MINIMAP_PX}px`, height: `${MINIMAP_PX}px` }}
        onPointerDown={(e) => {
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          jump(e);
        }}
        onPointerMove={(e) => {
          if ((e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) jump(e);
        }}
      >
        <canvas
          ref={canvasRef}
          width={side}
          height={side}
          role="img"
          aria-label="Overview of the whole map"
        />
        <div
          class="minimap-view"
          aria-hidden="true"
          style={{
            left: `${rect.left}px`,
            top: `${rect.top}px`,
            width: `${rect.width}px`,
            height: `${rect.height}px`,
          }}
        />
      </div>
    </div>
  );
}
