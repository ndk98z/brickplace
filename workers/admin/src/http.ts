// Small HTTP helpers for the admin Worker.

const NO_STORE = { 'Cache-Control': 'no-store' };

/** No framing, no other origins, no referrer: the admin page loads only its own script. */
const PAGE_HEADERS = {
  ...NO_STORE,
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; " +
    "img-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...PAGE_HEADERS, 'Content-Type': 'application/json' },
  });
}

export function asset(body: string, contentType: string): Response {
  return new Response(body, { headers: { ...PAGE_HEADERS, 'Content-Type': contentType } });
}

/** The header the admin page sends with every change; other sites cannot set it. */
export const REQUEST_HEADER = 'X-BrickPlace-Admin';

/**
 * True when a state-changing request may come from our own page: JSON with our header (a
 * cross-site form can send neither, and a cross-site fetch with them needs a preflight we
 * never answer) and, when the browser names one, our own Origin.
 */
export function ownRequest(request: Request): boolean {
  const url = new URL(request.url);
  const origin = request.headers.get('Origin');
  if (origin !== null && origin !== url.origin) return false;
  const type = request.headers.get('Content-Type') ?? '';
  return request.headers.get(REQUEST_HEADER) === '1' && type.startsWith('application/json');
}

/** The request body as a JSON object, or null. Bodies over 64 KB are refused. */
export async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  const text = await request.text().catch(() => null);
  if (text === null || text.length > 64 * 1024) return null;
  try {
    const value = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/** A reason or note typed by an admin: trimmed, at most 500 characters, '' when absent. */
export function text(value: unknown, max = 500): string | null {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length <= max ? trimmed : null;
}
