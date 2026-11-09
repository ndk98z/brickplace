// One byte per cell:
//   bit 7     filled
//   bits 2..6 colour index (0..31)
//   bit 1     linked to the cell on the right (same brick)
//   bit 0     linked to the cell below (same brick)
// Two link bits are enough to draw brick outlines without storing a brick id per cell.

export const FILLED = 0b1000_0000;
export const LINK_RIGHT = 0b0000_0010;
export const LINK_DOWN = 0b0000_0001;
const COLOR_SHIFT = 2;
const COLOR_MASK = 0b0111_1100;

export function encodeCell(color: number, linkRight: boolean, linkDown: boolean): number {
  return (
    FILLED |
    ((color << COLOR_SHIFT) & COLOR_MASK) |
    (linkRight ? LINK_RIGHT : 0) |
    (linkDown ? LINK_DOWN : 0)
  );
}

export function isFilled(cell: number): boolean {
  return (cell & FILLED) !== 0;
}

export function colorOf(cell: number): number {
  return (cell & COLOR_MASK) >> COLOR_SHIFT;
}
