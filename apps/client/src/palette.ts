import { PALETTE_SIZE } from '@brickplace/core';

/**
 * The 32 brick colours from the approved design, in swatch order (#1 is index 0).
 * The cell byte stores the index, so reordering this list repaints the whole map.
 */
export const PALETTE: readonly string[] = [
  '#E8384F',
  '#FF6B6B',
  '#FF9EAA',
  '#C2185B',
  '#FF7A1A',
  '#FFA94D',
  '#FFD23F',
  '#FFF1A8',
  '#2BB673',
  '#7BD389',
  '#B8E986',
  '#1E7F5C',
  '#12B5CB',
  '#7FDBFF',
  '#3D7BFF',
  '#1F4FB8',
  '#7B5CFF',
  '#B49CFF',
  '#E07BE0',
  '#8E2C8E',
  '#8B5A3C',
  '#C98E5D',
  '#F2D7B6',
  '#FFFFFF',
  '#E3E6EE',
  '#B5BCCB',
  '#6E7891',
  '#3B4256',
  '#1D2130',
  '#FF4FA3',
  '#00C2A8',
  '#FFE0F0',
];

if (PALETTE.length !== PALETTE_SIZE) throw new Error('palette must have exactly 32 colours');

/** '#RRGGBB' to [r, g, b] in 0..255. */
export function hexToRgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Relative luminance (WCAG 2) of '#RRGGBB'. */
export function luminance(hex: string): number {
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** Text colour for a label on top of a swatch, so every number stays readable. */
export function inkOn(hex: string): '#171B26' | '#FFFFFF' {
  return luminance(hex) > 0.18 ? '#171B26' : '#FFFFFF';
}

/** The palette as 32 × RGB floats for the shader uniform. */
export function paletteFloats(): Float32Array {
  const out = new Float32Array(PALETTE_SIZE * 3);
  PALETTE.forEach((hex, i) => {
    const [r, g, b] = hexToRgb(hex);
    out.set([r / 255, g / 255, b / 255], i * 3);
  });
  return out;
}
