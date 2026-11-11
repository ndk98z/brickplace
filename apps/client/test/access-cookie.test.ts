import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Staging sits behind Cloudflare Access (ADR 0045, amended 2026-11-11), which lets a request to
// the page's own host through only with its cookie. Requests a browser sends without cookies
// by default would be redirected to Access's login page there.
const root = new URL('../', import.meta.url);
const pages = readdirSync(root).filter((name) => name.endsWith('.html'));

describe('requests to the page host carry the Access cookie', () => {
  it('fetches the web app manifest with credentials on every page', () => {
    expect(pages.length).toBeGreaterThanOrEqual(6);
    for (const name of pages) {
      const html = readFileSync(new URL(name, root), 'utf8');
      for (const link of html.match(/<link[^>]*rel="manifest"[^>]*>/g) ?? []) {
        expect(link, name).toContain('crossorigin="use-credentials"');
      }
    }
  });

  it('omits credentials only for the public CDN, never for the page host', () => {
    const source = (path: string) => readFileSync(new URL(path, root), 'utf8');
    expect(source('src/timelapse/main.ts')).not.toMatch(/fetch\('\/api\/[^)]*'omit'/);
    expect(source('src/net/cdn-fetch.ts')).toMatch(/credentials: 'omit'/);
  });
});
