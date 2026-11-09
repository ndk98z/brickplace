import { inflateSync } from 'node:zlib';

/** An image as 8-bit RGBA, row-major. */
export interface Image {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array;
}

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
/** Channels per colour type: grey, RGB, palette, grey + alpha, RGBA. */
const CHANNELS: Readonly<Record<number, number>> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
/** Larger images are not something bots can draw anyway (a 1024² map). */
const MAX_EDGE = 4096;

/**
 * Decodes a PNG: 8-bit depth, any colour type, not interlaced. That covers what image editors
 * export by default; anything else is refused with a message that says how to re-export it.
 * No dependency: zlib and the five filters are all it takes.
 */
export function decodePng(bytes: Uint8Array): Image {
  if (bytes.length < 8 || SIGNATURE.some((b, i) => bytes[i] !== b)) {
    throw new Error('not a PNG file');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0;
  let height = 0;
  let colorType = -1;
  let palette: Uint8Array | null = null;
  let transparency: Uint8Array | null = null;
  const data: Uint8Array[] = [];
  for (let at = 8; at + 8 <= bytes.length; ) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    const body = bytes.subarray(at + 8, at + 8 + length);
    if (body.length !== length) throw new Error('PNG file is cut short');
    if (type === 'IHDR') {
      width = view.getUint32(at + 8);
      height = view.getUint32(at + 12);
      const depth = body[8]!;
      colorType = body[9]!;
      const interlace = body[12]!;
      if (depth !== 8 || !(colorType in CHANNELS) || interlace !== 0) {
        throw new Error('only 8-bit, non-interlaced PNGs are supported: re-export the image');
      }
      if (width < 1 || height < 1 || width > MAX_EDGE || height > MAX_EDGE) {
        throw new Error(`PNG must be 1 to ${MAX_EDGE} pixels a side`);
      }
    } else if (type === 'PLTE') {
      palette = body;
    } else if (type === 'tRNS') {
      transparency = body;
    } else if (type === 'IDAT') {
      data.push(body);
    } else if (type === 'IEND') {
      break;
    }
    at += 12 + length;
  }
  if (colorType < 0) throw new Error('PNG has no header');
  if (colorType === 3 && !palette) throw new Error('palette PNG without a palette');
  const channels = CHANNELS[colorType]!;
  const stride = width * channels;
  // Never more than the image needs, whatever the compressed data claims.
  const raw = inflateSync(Buffer.concat(data), { maxOutputLength: height * (stride + 1) });
  if (raw.length < height * (stride + 1)) throw new Error('PNG image data is cut short');
  const pixels = unfilter(raw, width, height, channels);
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const p = i * channels;
    const o = i * 4;
    switch (colorType) {
      case 0:
        rgba.set([pixels[p]!, pixels[p]!, pixels[p]!, 255], o);
        break;
      case 2:
        rgba.set([pixels[p]!, pixels[p + 1]!, pixels[p + 2]!, 255], o);
        break;
      case 3: {
        const k = pixels[p]!;
        const alpha = transparency && k < transparency.length ? transparency[k]! : 255;
        rgba.set(
          [palette![k * 3] ?? 0, palette![k * 3 + 1] ?? 0, palette![k * 3 + 2] ?? 0, alpha],
          o,
        );
        break;
      }
      case 4:
        rgba.set([pixels[p]!, pixels[p]!, pixels[p]!, pixels[p + 1]!], o);
        break;
      default:
        rgba.set(pixels.subarray(p, p + 4), o);
    }
  }
  return { width, height, rgba };
}

/** Undoes the per-row filters (PNG spec, section 9) for 8-bit samples. */
function unfilter(raw: Uint8Array, width: number, height: number, bpp: number): Uint8Array {
  const stride = width * bpp;
  const out = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[row + x - bpp]! : 0;
      const b = y > 0 ? out[row - stride + x]! : 0;
      const c = x >= bpp && y > 0 ? out[row - stride + x - bpp]! : 0;
      let value = line[x]!;
      switch (filter) {
        case 0:
          break;
        case 1:
          value += a;
          break;
        case 2:
          value += b;
          break;
        case 3:
          value += (a + b) >> 1;
          break;
        case 4:
          value += paeth(a, b, c);
          break;
        default:
          throw new Error(`unknown PNG filter ${filter}`);
      }
      out[row + x] = value & 0xff;
    }
  }
  return out;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}
