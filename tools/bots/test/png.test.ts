import { crc32, deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { imageArt, NONE } from '../src/art.ts';
import { nearestColor, PALETTE_RGB } from '../src/palette.ts';
import { decodePng } from '../src/png.ts';

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  out.set(Buffer.from(type, 'latin1'), 4);
  out.set(body, 8);
  view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
  return out;
}

/** A PNG with each row written through the given filter (0 to 4), from raw samples. */
function png(
  width: number,
  height: number,
  colorType: number,
  samples: number[],
  filters: number[],
  extra: Uint8Array[] = [],
): Uint8Array {
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType]!;
  const stride = width * channels;
  const raw: number[] = [];
  for (let y = 0; y < height; y++) {
    const filter = filters[y % filters.length]!;
    raw.push(filter);
    for (let x = 0; x < stride; x++) {
      const at = y * stride + x;
      const value = samples[at]!;
      const a = x >= channels ? samples[at - channels]! : 0;
      const b = y > 0 ? samples[at - stride]! : 0;
      const c = x >= channels && y > 0 ? samples[at - stride - channels]! : 0;
      const predictor = [
        0,
        a,
        b,
        (a + b) >> 1,
        (() => {
          const p = a + b - c;
          const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
          return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        })(),
      ][filter]!;
      raw.push((value - predictor) & 0xff);
    }
  }
  const header = new Uint8Array(13);
  new DataView(header.buffer).setUint32(0, width);
  new DataView(header.buffer).setUint32(4, height);
  header.set([8, colorType, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    ...extra.map((e) => Buffer.from(e)),
    chunk('IDAT', deflateSync(Uint8Array.from(raw))),
    chunk('IEND', new Uint8Array()),
  ]);
}

describe('PNG decoding', () => {
  it('reads RGBA through every row filter', () => {
    const width = 5;
    const height = 6;
    const samples = Array.from(
      { length: width * height * 4 },
      (_, i) => (i * 37 + (i >> 3) * 11) & 0xff,
    );
    const decoded = decodePng(png(width, height, 6, samples, [0, 1, 2, 3, 4, 4]));
    expect(decoded.width).toBe(width);
    expect(decoded.height).toBe(height);
    for (let i = 0; i < samples.length; i++)
      expect(decoded.rgba[i], `sample ${i}`).toBe(samples[i]);
  });

  it('reads RGB, grey and palette images, with palette transparency', () => {
    const rgb = decodePng(png(2, 1, 2, [10, 20, 30, 40, 50, 60], [1]));
    expect([...rgb.rgba]).toEqual([10, 20, 30, 255, 40, 50, 60, 255]);
    const grey = decodePng(png(2, 1, 0, [7, 200], [2]));
    expect([...grey.rgba]).toEqual([7, 7, 7, 255, 200, 200, 200, 255]);
    const palette = chunk('PLTE', Uint8Array.from([1, 2, 3, 4, 5, 6]));
    const transparency = chunk('tRNS', Uint8Array.from([0]));
    const indexed = decodePng(png(2, 1, 3, [0, 1], [0], [palette, transparency]));
    expect([...indexed.rgba]).toEqual([1, 2, 3, 0, 4, 5, 6, 255]);
  });

  it('refuses what it cannot read, saying so', () => {
    expect(() => decodePng(Uint8Array.from([1, 2, 3]))).toThrow('not a PNG');
    const sixteenBit = png(1, 1, 2, [1, 2, 3], [0]);
    sixteenBit[24] = 16; // IHDR bit depth
    expect(() => decodePng(sixteenBit)).toThrow('8-bit');
  });
});

describe('images as artworks', () => {
  it('maps each pixel to the nearest palette colour and leaves transparent ones alone', () => {
    const [r, g, b] = PALETTE_RGB[14]!;
    // A 2x2 image: palette colour 14, almost white, transparent, almost black.
    const image = {
      width: 2,
      height: 2,
      rgba: Uint8Array.from([r, g, b, 255, 250, 250, 252, 255, 0, 0, 0, 0, 30, 32, 45, 255]),
    };
    const art = imageArt(image, 100, 200);
    expect(art.rect).toEqual({ x: 100, y: 200, w: 2, h: 2 });
    expect([...art.target]).toEqual([
      14,
      nearestColor(250, 250, 252),
      NONE,
      nearestColor(30, 32, 45),
    ]);
    expect(art.target[1]).toBe(23); // #FFFFFF
    expect(art.target[3]).toBe(28); // #1D2130
    expect(art.cells).toBe(3);
    expect(art.strict).toBe(true);
  });

  it('scales to the width asked for, keeping the aspect ratio', () => {
    const image = { width: 4, height: 2, rgba: new Uint8Array(4 * 2 * 4).fill(255) };
    const art = imageArt(image, 0, 0, 8);
    expect(art.rect).toEqual({ x: 0, y: 0, w: 8, h: 4 });
  });
});
