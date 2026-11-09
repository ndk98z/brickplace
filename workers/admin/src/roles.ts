import { auditStatement } from './audit.ts';
import type { Outcome } from './config.ts';
import type { Admin, Role } from './identity.ts';
import { ROLES } from './identity.ts';

// Roles (ADR 0022): owners grant and revoke them from the admin page, every change audited in
// the same batch. Nobody changes their own role, so an owner cannot lock the last owner out by
// accident; the first owner is inserted by the operator with `wrangler d1 execute`.

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,185}$/;

export async function listRoles(db: D1Database): Promise<Outcome> {
  const { results } = await db
    .prepare('SELECT email, role, granted_by, granted_at FROM admin_roles ORDER BY role, email')
    .all<{ email: string; role: Role; granted_by: string; granted_at: number }>();
  return {
    status: 200,
    body: {
      roles: results.map((r) => ({
        email: r.email,
        role: r.role,
        grantedBy: r.granted_by,
        grantedAt: r.granted_at,
      })),
    },
  };
}

/** Grants `role` to `email`, or revokes theirs when `role` is null. */
export async function setRole(
  db: D1Database,
  admin: Admin,
  emailInput: unknown,
  roleInput: unknown,
  reason: string,
  now: number,
): Promise<Outcome> {
  if (typeof emailInput !== 'string' || !EMAIL.test(emailInput.trim())) {
    return { status: 400, body: { error: 'invalid', detail: 'email' } };
  }
  const email = emailInput.trim().toLowerCase();
  const role = roleInput === null ? null : ROLES.find((r) => r === roleInput);
  if (role === undefined) return { status: 400, body: { error: 'invalid', detail: 'role' } };
  if (email === admin.email) return { status: 409, body: { error: 'own_role' } };
  const before = await db
    .prepare('SELECT role FROM admin_roles WHERE email = ?')
    .bind(email)
    .first<{ role: Role }>();
  const change =
    role === null
      ? db.prepare('DELETE FROM admin_roles WHERE email = ?').bind(email)
      : db
          .prepare(
            'INSERT INTO admin_roles (email, role, granted_by, granted_at) VALUES (?, ?, ?, ?) ' +
              'ON CONFLICT (email) DO UPDATE SET role = excluded.role, ' +
              'granted_by = excluded.granted_by, granted_at = excluded.granted_at',
          )
          .bind(email, role, admin.email, now);
  await db.batch([
    change,
    auditStatement(db, admin, now, {
      action: role === null ? 'role.revoke' : 'role.grant',
      target: email,
      before: before?.role ?? null,
      after: role,
      reason,
    }),
  ]);
  return { status: 200, body: { email, role } };
}
