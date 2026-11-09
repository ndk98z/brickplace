// The fake provider's own pages, ENVIRONMENT=dev only (see devProvider in providers.ts):
// GET shows a form to sign in as anyone, POST issues a signed code and redirects back
// exactly as a real provider does.

import { type Context, escapeHtml, html, json, redirect } from './http.ts';
import { redirectUri } from './oauth.ts';
import type { DevCode } from './providers.ts';
import { seal } from './token.ts';

/** Codes are traded at once; a real provider allows about as long. */
const CODE_TTL_MS = 60 * 1000;
const SUBJECT = /^[A-Za-z0-9_-]{1,64}$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,185}$/;

export async function devAuthorize(ctx: Context): Promise<Response> {
  if (!ctx.dev || !ctx.ring || !ctx.origin) return json({ error: 'not_found' }, 404);
  const fields =
    ctx.request.method === 'POST'
      ? await ctx.request.formData().catch(() => null)
      : ctx.url.searchParams;
  const get = (name: string) => {
    const value = fields?.get(name);
    return typeof value === 'string' ? value : '';
  };
  // Like a real provider: only the redirect URI registered for this app, exactly.
  const expected = redirectUri(ctx.origin, 'dev');
  if (get('redirect_uri') !== expected) return json({ error: 'redirect_uri' }, 400);
  const state = get('state');
  const challenge = get('code_challenge');
  const nonce = get('nonce');
  if (!state || !challenge || !nonce) return json({ error: 'missing_parameters' }, 400);
  if (ctx.request.method !== 'POST') return html(page({ state, challenge, nonce, expected }));

  const subject = get('subject').trim();
  const name = get('name').trim().slice(0, 100) || null;
  const email = get('email').trim() || null;
  if (!SUBJECT.test(subject) || (email !== null && !EMAIL.test(email))) {
    return html(page({ state, challenge, nonce, expected, error: true }), 400);
  }
  const code: DevCode = {
    sub: subject,
    name,
    email,
    ch: challenge,
    nn: nonce,
    ru: expected,
    e: ctx.now + CODE_TTL_MS,
  };
  const back = new URL(expected);
  back.searchParams.set('code', await seal(ctx.ring, 'devcode', code));
  back.searchParams.set('state', state);
  return redirect(back.toString());
}

function page(p: {
  state: string;
  challenge: string;
  nonce: string;
  expected: string;
  error?: boolean;
}): string {
  const hidden = (name: string, value: string) =>
    `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Dev sign-in</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#DDE3EE;font-family:system-ui,sans-serif;color:#171B26}
form{width:100%;max-width:380px;padding:28px;border-radius:24px;background:#fff;display:flex;flex-direction:column;gap:12px;box-shadow:0 30px 60px rgba(23,27,38,.3)}
h1{margin:0;font-size:24px}p{margin:0;color:#5A6175;font-size:14px;line-height:1.5}
label{display:flex;flex-direction:column;gap:4px;font-size:13px;font-weight:600}
input{height:40px;padding:0 12px;border:1.5px solid #C9D0DE;border-radius:10px;font:inherit}
button{height:48px;border:none;border-radius:14px;background:#171B26;color:#fff;font:inherit;font-weight:600;cursor:pointer}
.error{color:#8F2236}
</style></head><body>
<form method="post">
<h1>Dev sign-in</h1>
<p>Local development only: this page plays the OAuth provider. The same subject signs in to the same account.</p>
${p.error ? '<p class="error">Use 1–64 letters, digits, _ or - for the subject, and a valid email or none.</p>' : ''}
<label>Subject (provider user id)<input name="subject" required pattern="[A-Za-z0-9_\\-]{1,64}" value="alice"></label>
<label>Name at the provider<input name="name" value="Alice Example"></label>
<label>Verified email (optional)<input name="email" type="email" value="alice@example.test"></label>
${hidden('redirect_uri', p.expected)}${hidden('state', p.state)}${hidden('code_challenge', p.challenge)}${hidden('nonce', p.nonce)}
<button type="submit">Sign in</button>
</form></body></html>`;
}
