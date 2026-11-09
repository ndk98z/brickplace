import { PALETTE_SIZE } from '@brickplace/core';
import type { HoldMessage } from '@brickplace/protocol';
import { describe, expect, it } from 'vitest';
import { MAX_SPONSORS, parseSponsors, siteInfoFrom } from '../src/config.ts';
import {
  consume,
  emptyHold,
  fromServer,
  markPending,
  newSocket,
  refund,
} from '../src/game/hold.ts';
import { cellMetrics, detailFor } from '../src/gl/renderer.ts';
import { noticeFor } from '../src/net/messages.ts';
import { inkOn, PALETTE, paletteFloats } from '../src/palette.ts';
import { HERO_COLUMNS, HERO_ROWS, HERO_SEED, heroArt, nextSeed } from '../src/ui/ItemArt.tsx';

describe('landing hero art', () => {
  it('steps an exact 31-bit sequence', () => {
    // The reference in exact integers: seed × 1103515245 + 12345 mod 2^31.
    const exact = (seed: number) => Number((BigInt(seed) * 1103515245n + 12345n) % 2n ** 31n);
    const seeds = [HERO_SEED];
    for (let i = 0; i < 6; i++) seeds.push(nextSeed(seeds.at(-1)!));
    // Pinned: the first steps from the hero's seed, as the drawing uses them.
    expect(seeds).toEqual([5, 1222621274, 554244747, 695785320, 2089129857, 668008486, 1701631079]);
    for (let i = 1; i < seeds.length; i++) expect(seeds[i]).toBe(exact(seeds[i - 1]!));
    // Large seeds, where a float product would pass 2^53 and round.
    for (const seed of [0x7fffffff, 0x40000001, 123456789]) {
      expect(nextSeed(seed)).toBe(exact(seed));
    }
  });

  it('is the same fixed drawing on every visit, in palette colours', () => {
    const art = heroArt();
    expect(art).toHaveLength(HERO_COLUMNS * HERO_ROWS);
    expect(heroArt()).toBe(art);
    // The heart's middle is filled; the drawing is not all filled.
    expect(art[6 * HERO_COLUMNS + 7]).toBe('#E8384F');
    expect(art.filter((c) => c === null).length).toBeGreaterThan(art.length / 3);
    for (const color of art) if (color) expect(PALETTE).toContain(color);
  });
});

describe('palette', () => {
  it('has the 32 design colours, all distinct', () => {
    expect(PALETTE).toHaveLength(PALETTE_SIZE);
    expect(new Set(PALETTE).size).toBe(PALETTE_SIZE);
    expect(paletteFloats()).toHaveLength(PALETTE_SIZE * 3);
  });

  it('picks a readable number colour for each swatch', () => {
    expect(inkOn('#FFFFFF')).toBe('#171B26');
    expect(inkOn('#1D2130')).toBe('#FFFFFF');
  });
});

describe('sponsors config', () => {
  it('is empty by default and on bad JSON', () => {
    expect(parseSponsors(undefined)).toEqual([]);
    expect(parseSponsors('{nope')).toEqual([]);
    expect(parseSponsors('{"name":"x"}')).toEqual([]);
  });

  it('keeps valid https entries, the first featured one first, at most five', () => {
    const list = [
      { name: 'A', href: 'https://a.example' },
      { name: 'B', href: 'http://b.example' },
      { name: '', href: 'https://c.example' },
      { name: 'D', href: 'https://d.example', featured: true, logo: 'javascript:alert(1)' },
      { name: 'E', href: 'https://e.example', featured: true },
      ...['F', 'G', 'H'].map((name) => ({ name, href: `https://${name}.example` })),
    ];
    const sponsors = parseSponsors(JSON.stringify(list));
    expect(sponsors).toHaveLength(MAX_SPONSORS);
    expect(sponsors[0]).toEqual({ name: 'D', href: 'https://d.example', featured: true });
    expect(sponsors.map((s) => s.name)).toEqual(['D', 'A', 'E', 'F', 'G']);
  });

  it('reads the admin area list and links with the same checks (ADR 0038)', () => {
    const logo = `/api/sponsor-logos/${'a'.repeat(64)}.png`;
    const site = siteInfoFrom({
      sponsors: [
        { name: 'A', href: 'https://a.example', logo, featured: true },
        { name: 'B', href: 'https://b.example', logo: 'https://evil.example/b.png' },
        { name: 'C', href: 'javascript:alert(1)' },
      ],
      links: { kofi: 'https://ko-fi.com/x', sponsorInfo: 'http://plain.example' },
    });
    expect(site).toEqual({
      sponsors: [
        { name: 'A', href: 'https://a.example', logo, featured: true },
        { name: 'B', href: 'https://b.example' },
      ],
      kofiUrl: 'https://ko-fi.com/x',
      sponsorInfoUrl: null,
    });
    expect(siteInfoFrom({ error: 'unavailable' })).toBeNull();
    expect(siteInfoFrom(null)).toBeNull();
  });
});

describe('server hold', () => {
  let revision = 0;
  const message = (items: HoldMessage['items'], nextIn: number | null = 30_000): HoldMessage => ({
    type: 'hold',
    capacity: 3,
    cooldown: 60_000,
    nextIn,
    revision: ++revision,
    items,
  });
  const O = { kind: 'brick', shape: 1 } as const;
  const hammer = { kind: 'hammer' } as const;

  it('starts empty, then shows the server hold with the countdown on this clock', () => {
    const hold = fromServer(emptyHold(), message([O, hammer]), 1000);
    expect(hold.items).toEqual([
      { ...O, id: 1 },
      { ...hammer, id: 2 },
    ]);
    expect(hold.nextAt).toBe(31_000);
    expect(hold.cooldownMs).toBe(60_000);
    expect(fromServer(hold, message([O, hammer, O], null), 2000).nextAt).toBeNull();
  });

  it('keeps ids and pending marks of items still held', () => {
    let hold = fromServer(emptyHold(), message([O, hammer]), 0);
    hold = markPending(hold, 2);
    // The O was used elsewhere and a shield arrived: the hammer keeps id 2 and stays pending.
    hold = fromServer(hold, message([hammer, { kind: 'shield' }]), 0);
    expect(hold.items.map((i) => [i.kind, i.id])).toEqual([
      ['hammer', 2],
      ['shield', 3],
    ]);
    expect([...hold.pending]).toEqual([2]);
    // A brick of another shape is a different item.
    hold = fromServer(hold, message([{ kind: 'brick', shape: 2 }]), 0);
    expect(hold.items).toEqual([{ kind: 'brick', shape: 2, id: 4 }]);
    expect(hold.pending.size).toBe(0);
  });

  it('matches items not waiting for an ack first', () => {
    // Two Os, the first one sent; the server now holds one O: it is the unsent one.
    let hold = fromServer(emptyHold(), message([O, O]), 0);
    hold = markPending(hold, 1);
    hold = fromServer(hold, message([O]), 0);
    expect(hold.items).toEqual([{ ...O, id: 2 }]);
    expect(hold.pending.size).toBe(0);
  });

  it('ignores a hold older than the one shown, until a new socket', () => {
    const newer = fromServer(emptyHold(), { ...message([O]), revision: 7 }, 0);
    const late = { ...message([O, hammer]), revision: 6 };
    expect(fromServer(newer, late, 0)).toBe(newer);
    expect(fromServer(newer, { ...late, revision: 7 }, 0).items).toHaveLength(2);
    expect(fromServer(newSocket(newer), late, 0).items).toHaveLength(2);
  });

  it('spends an accepted item and keeps a refused one', () => {
    let hold = markPending(fromServer(emptyHold(), message([O, hammer]), 0), 1);
    expect(refund(hold, 1).pending.size).toBe(0);
    expect(refund(hold, 1).items).toHaveLength(2);
    hold = consume(hold, 1);
    expect(hold.items.map((i) => i.id)).toEqual([2]);
    expect(hold.pending.size).toBe(0);
  });
});

describe('notices and detail levels', () => {
  it('uses the design copy for taken cells and unconfirmed moves', () => {
    expect(noticeFor('occupied', 'brick').title).toBe('Cell already taken');
    expect(noticeFor('unavailable', 'hammer')).toMatchObject({
      title: "Couldn't confirm that move",
      tone: 'warn',
    });
  });

  it('does not claim a refund for a move that was never sent', () => {
    expect(noticeFor('occupied', 'brick', false).body).toBe(
      'Someone got there first. Your brick is still in your hold.',
    );
  });

  it('keeps cell gaps about one pixel wide when zoomed in', () => {
    expect(cellMetrics(11)).toEqual({ margin: 1 / 22, line: 1 / 22 });
    expect(cellMetrics(50)).toEqual({ margin: 1.25 / 50, line: 1 / 50 });
  });

  it('fades brick detail in with zoom', () => {
    expect(detailFor(1)).toEqual({ detail: 0, pips: 0 });
    expect(detailFor(32)).toEqual({ detail: 1, pips: 1 });
    expect(detailFor(6).detail).toBeGreaterThan(0);
  });
});
