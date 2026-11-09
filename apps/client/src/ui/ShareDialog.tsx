import type { Rect } from '@brickplace/core';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Account } from '../game/account.ts';
import type { Game } from '../game/game.ts';
import type { Screens } from '../game/screens.ts';
import {
  caption,
  discordText,
  redditUrl,
  shareLink,
  shareTitle,
  snapshotFileName,
  type View,
  viewOf,
  xUrl,
} from '../game/share.ts';
import {
  areaInView,
  captionLayout,
  cellSpan,
  dragSelects,
  type Pixels,
  type Point,
  pointOnImage,
  renderSnapshot,
  selectedArea,
  snapshotScale,
} from '../map/snapshot.ts';
import { Dialog } from './AccountDialogs.tsx';
import { useSelector } from './observable.ts';
import './screens.css';

// The Share design: a link to this spot and zoom, and a PNG drawn here from the map the page
// already holds. Reddit and X get the link (they cannot take an image from another site
// without a server); Discord gets the image on the clipboard. A drag across the preview keeps
// the cells under it, drawn again at their own scale.

type Capture = 'view' | 'open' | 'part';

/** A drag in progress on the preview: in image pixels, and in client px for the threshold. */
interface Drag {
  readonly pointer: number;
  readonly start: Point;
  readonly from: Point;
  readonly to: Point;
  /** Whether it moved far enough to select (dragSelects); no box is drawn before. */
  readonly selects: boolean;
}

function pointOn(canvas: HTMLCanvasElement, pixels: Pixels, event: PointerEvent): Point {
  return pointOnImage(
    { x: event.clientX, y: event.clientY },
    canvas.getBoundingClientRect(),
    canvas,
    pixels,
  );
}

/** Draws the snapshot, and the caption band under it when asked, onto a canvas. */
function paint(
  canvas: HTMLCanvasElement,
  pixels: Pixels,
  text: { left: string; right: string } | null,
): void {
  const band = text ? captionLayout(pixels.width) : null;
  canvas.width = pixels.width;
  canvas.height = pixels.height + (band?.height ?? 0);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.putImageData(new ImageData(pixels.data, pixels.width, pixels.height), 0, 0);
  if (!text || !band) return;
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, pixels.height, pixels.width, band.height);
  ctx.fillStyle = '#5A6175';
  ctx.font = `600 ${band.font}px Inter, system-ui, sans-serif`;
  ctx.textBaseline = 'middle';
  const y = pixels.height + band.height / 2;
  ctx.textAlign = 'left';
  ctx.fillText(text.left, band.pad, y);
  ctx.textAlign = 'right';
  ctx.fillText(text.right, pixels.width - band.pad, y);
}

function pngOf(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('no image'))), 'image/png'),
  );
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function ShareDialog({
  game,
  account,
  screens,
}: {
  game: Game;
  account: Account;
  screens: Screens;
}) {
  const season = useSelector(account.state, (s) => s.me.config.season?.id ?? null);
  // The view when the dialog opened: the map does not move under it.
  const [{ view, inView, open, openHeld }] = useState(() => {
    const ui = game.ui.get();
    return {
      view: viewOf(ui.camera) as View,
      inView: areaInView(ui.camera, ui.viewport, game.store.size),
      open: ui.rules.open,
      // A page whose socket is still opening keeps only the tiles in view current: the whole
      // open area would show empty or stale tiles.
      openHeld: game.holdsArea(ui.rules.open),
    };
  });
  const [capture, setCapture] = useState<Capture>('view');
  const [withCaption, setWithCaption] = useState(true);
  const [status, setStatus] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [part, setPart] = useState<Rect | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const area: Rect = capture === 'part' && part ? part : capture === 'open' ? open : inView;
  const scale = snapshotScale(area);
  const pixels = useMemo(() => renderSnapshot(game.store, area, scale), [game.store, area, scale]);
  // The cells under a drag, as a box over the preview in percent of the canvas.
  const span = drag?.selects ? cellSpan(area, scale, drag.from, drag.to) : null;
  const box =
    span && canvas.current
      ? {
          left: `${(((span.x - area.x) * scale) / canvas.current.width) * 100}%`,
          top: `${(((span.y - area.y) * scale) / canvas.current.height) * 100}%`,
          width: `${((span.w * scale) / canvas.current.width) * 100}%`,
          height: `${((span.h * scale) / canvas.current.height) * 100}%`,
        }
      : null;

  const startDrag = (event: PointerEvent) => {
    const target = canvas.current;
    if (!target || event.button !== 0) return;
    event.preventDefault();
    target.setPointerCapture(event.pointerId);
    const at = pointOn(target, pixels, event);
    const start = { x: event.clientX, y: event.clientY };
    setDrag({ pointer: event.pointerId, start, from: at, to: at, selects: false });
  };
  const moveDrag = (event: PointerEvent) => {
    if (!canvas.current || drag?.pointer !== event.pointerId) return;
    setDrag({
      ...drag,
      to: pointOn(canvas.current, pixels, event),
      selects: dragSelects(drag.start, { x: event.clientX, y: event.clientY }),
    });
  };
  const endDrag = (event: PointerEvent) => {
    if (!canvas.current || drag?.pointer !== event.pointerId) return;
    setDrag(null);
    const moved = dragSelects(drag.start, { x: event.clientX, y: event.clientY });
    const kept =
      moved && selectedArea(area, scale, drag.from, pointOn(canvas.current, pixels, event));
    if (!kept) return;
    setPart(kept);
    setCapture('part');
    setStatus(null);
  };
  // A part's link, caption and file name name its own middle cell, at the view's zoom.
  const shown: View =
    capture === 'part' && part
      ? viewOf({ cx: part.x + part.w / 2, cy: part.y + part.h / 2, zoom: view.zoom })
      : view;
  const link = shareLink(location.origin, shown, season);
  const title = shareTitle(shown, season);
  const text = withCaption ? caption(shown, season) : null;

  useEffect(() => {
    const target = canvas.current;
    if (!target) return;
    paint(target, pixels, text);
    // Redrawn once the UI font is in, so the caption is not drawn in a fallback font.
    let live = true;
    void document.fonts?.ready.then(() => live && paint(target, pixels, text));
    return () => {
      live = false;
    };
  }, [pixels, text?.left, text?.right]);

  const close = () => screens.close();
  const say = (message: string) => setStatus(message);

  const download = async () => {
    if (!canvas.current) return;
    try {
      const url = URL.createObjectURL(await pngOf(canvas.current));
      const a = document.createElement('a');
      a.href = url;
      a.download = snapshotFileName(shown);
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      say('Image saved.');
    } catch {
      say('This browser could not make the image.');
    }
  };

  const copyLink = async () => {
    const ok = await copyText(link);
    setCopied(ok);
    say(ok ? 'Link copied.' : 'Copy the link from the box above.');
  };

  const forDiscord = async () => {
    const message = discordText(link, title);
    try {
      if (!canvas.current || typeof ClipboardItem === 'undefined') throw new Error('no image');
      const png = pngOf(canvas.current);
      await navigator.clipboard.write([
        new ClipboardItem({
          'image/png': png,
          'text/plain': new Blob([message], { type: 'text/plain' }),
        }),
      ]);
      say('Image copied. Paste it into Discord; the link is in the box above.');
    } catch {
      say(
        (await copyText(message))
          ? 'Link copied. Paste it into Discord, and attach the downloaded PNG.'
          : 'Copy the link from the box above.',
      );
    }
  };

  const post = (url: string) => {
    window.open(url, '_blank', 'noopener,noreferrer');
    say('The post opens in a new tab with the link. Download the PNG to attach it.');
  };

  return (
    <Dialog label="Share this view" wide onClose={close}>
      <div class="share">
        <div class="share-preview">
          <div class="share-frame">
            <canvas
              ref={canvas}
              class="share-canvas"
              role="img"
              aria-label={`Preview of the map area you are sharing, around x ${shown.x}, y ${shown.y}`}
              onPointerDown={startDrag}
              onPointerMove={moveDrag}
              onPointerUp={endDrag}
              onPointerCancel={() => setDrag(null)}
            />
            {box && <span class="share-selection" style={box} aria-hidden="true" />}
          </div>
        </div>
        <div class="share-side">
          <h1 class="dialog-title share-title">Share this view</h1>
          <p class="dialog-copy">
            The link opens the map at this spot and zoom. The image is what you see now; drag across
            it to keep a part.
          </p>
          <label class="field">
            <span class="field-label">Link</span>
            <span class="share-link">
              <input
                class="field-input"
                readOnly
                value={link}
                onFocus={(e) => (e.target as HTMLInputElement).select()}
              />
              <button type="button" class="btn btn-dark" onClick={() => void copyLink()}>
                {copied ? 'Copied' : 'Copy'}
              </button>
            </span>
          </label>
          <fieldset class="share-capture">
            <legend class="field-label">Image</legend>
            <label>
              <input
                type="radio"
                name="capture"
                checked={capture === 'view'}
                onChange={() => setCapture('view')}
              />
              What you see now
            </label>
            <label>
              <input
                type="radio"
                name="capture"
                checked={capture === 'open'}
                disabled={!openHeld}
                aria-describedby={openHeld ? undefined : 'open-not-held'}
                onChange={() => setCapture('open')}
              />
              The whole open area
            </label>
            {part && (
              <label>
                <input
                  type="radio"
                  name="capture"
                  checked={capture === 'part'}
                  onChange={() => setCapture('part')}
                />
                The part you selected
              </label>
            )}
            {!openHeld && (
              <span id="open-not-held" class="field-hint">
                Not loaded yet: zoom out once, or try again in a moment.
              </span>
            )}
          </fieldset>
          <label class="share-check">
            <input
              type="checkbox"
              checked={withCaption}
              onChange={() => setWithCaption(!withCaption)}
            />
            Add season and coordinates under the image
          </label>
          <div class="share-buttons">
            <button type="button" class="btn share-main" onClick={() => void download()}>
              Download PNG
            </button>
            <button
              type="button"
              class="btn btn-light"
              onClick={() => post(redditUrl(link, title))}
            >
              Post to Reddit
            </button>
            <button type="button" class="btn btn-light" onClick={() => post(xUrl(link, title))}>
              Post to X
            </button>
            <button type="button" class="btn btn-light" onClick={() => void forDiscord()}>
              Copy for Discord
            </button>
          </div>
          <p class="field-hint" role="status">
            {status ?? ''}
          </p>
          <button type="button" class="link-btn share-back" onClick={close}>
            Back to the map
          </button>
        </div>
      </div>
    </Dialog>
  );
}
