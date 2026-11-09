import {
  ACCESS_HEADER,
  type AccessIdentity,
  type AccessKeys,
  accessSettings,
  verifyAccessToken,
} from './access.ts';
import type { Env } from './index.ts';

// Who is asking (ADR 0022): the person Cloudflare Access signed in, and their role from D1.
// Access decides who may reach the hostname; the role table decides what they may do there.
// Neither the list of admins nor their emails is ever in this repo.

export const ROLES = ['owner', 'moderator'] as const;
export type Role = (typeof ROLES)[number];

export interface Admin {
  /** Lower case, as Access verified it. */
  readonly email: string;
  readonly sub: string;
  readonly role: Role;
  /** The local dev identity (ENVIRONMENT=dev), never a real person. */
  readonly dev: boolean;
}

export type WhoResult =
  | { readonly ok: true; readonly admin: Admin }
  | {
      readonly ok: false;
      readonly status: number;
      readonly error: string;
      readonly detail?: string;
      /** Who Access signed in, when the refusal is for want of a role (it is audited). */
      readonly identity?: AccessIdentity;
    };

/** The identity local dev runs as, with no Access in front of `wrangler dev`. */
export const DEV_ADMIN: Admin = {
  email: 'dev-admin@localhost',
  sub: 'dev',
  role: 'owner',
  dev: true,
};

export async function whoIsAsking(
  request: Request,
  env: Env,
  keys: AccessKeys,
  now: number,
): Promise<WhoResult> {
  // The dev bypass, like the fake OAuth provider: only with ENVIRONMENT=dev, which only a local
  // .dev.vars sets (every committed environment is checked by the tests not to be `dev`).
  if (env.ENVIRONMENT === 'dev') return { ok: true, admin: DEV_ADMIN };
  if (env.ENVIRONMENT !== 'staging' && env.ENVIRONMENT !== 'production') {
    return { ok: false, status: 501, error: 'locked' };
  }
  const settings = accessSettings(env.ACCESS_TEAM_DOMAIN, env.ACCESS_AUD);
  if (!settings) return { ok: false, status: 503, error: 'access_not_configured' };
  const checked = await verifyAccessToken(request.headers.get(ACCESS_HEADER), settings, keys, now);
  if (!checked.ok) {
    const status = checked.reason === 'keys_unavailable' ? 503 : 401;
    return { ok: false, status, error: 'access', detail: checked.reason };
  }
  const { email, sub } = checked.identity;
  const row = await env.ADMIN_DB.prepare('SELECT role FROM admin_roles WHERE email = ?')
    .bind(email)
    .first<{ role: string }>();
  const role = ROLES.find((r) => r === row?.role);
  if (!role) return { ok: false, status: 403, error: 'no_role', identity: checked.identity };
  return { ok: true, admin: { email, sub, role, dev: false } };
}

/** Whether `admin` may do something that needs one of `roles`. */
export function allowed(admin: Admin, roles: readonly Role[]): boolean {
  return roles.includes(admin.role);
}
