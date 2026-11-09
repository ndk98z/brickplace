#!/usr/bin/env node
// PreToolUse: refuses edits that break a rule visible in the text being written.
//
// Deliberately narrow: only rules that can be judged from the new text of a file live here.
//   core-determinism  packages/core and packages/protocol never read the clock or randomness
//                     (Date, Math.random, performance.now, crypto): replay must give the same grid.
//   gateway-locked    workers/gateway/wrangler.jsonc and workers/admin/wrangler.jsonc never set
//                     ENVIRONMENT to "dev"; local dev unlocks /ws (and skips Access on the admin
//                     Worker) through .dev.vars only.
//   no-secrets        no non-empty secret-looking value in a wrangler.jsonc.
//   no-tetris-names   code never says "tetris" or "tetromino" (ADR 0002).
//   english-code      code under apps/, packages/, workers/ and tools/ has no Vietnamese text.
// Rules about control flow (write order, durability before reply, idempotency) cannot be read
// from a diff; tests and the reviewer agent cover them, and this hook does not pretend to.
//
// Shell writes that put content into INVARIANT_FILES are refused: the content cannot be read
// from the command. Deleting or creating directories carries no content and is allowed.
//
// Exit 0 allows. Exit 2 blocks and feeds the reason back.

import { relative } from 'node:path';
import {
  block,
  guard,
  isExempt,
  log,
  readInput,
  realPath,
  rootFor,
  treeInfo,
} from './lib/repo.mjs';
import { INVARIANT_FILES, matches } from './lib/sensitive-paths.mjs';
import { bashWrites } from './lib/shell.mjs';

const CONTENT_FREE = new Set(['rm', 'rmdir', 'mkdir']);

guard('check-invariants.mjs', () => {
  const input = readInput();
  if (!input?.tool_input) process.exit(0);
  const cwd = input.cwd || process.cwd();
  const info = treeInfo(cwd);
  if (!info) process.exit(0);
  const tool = input.tool_name;
  const ti = input.tool_input;

  const refuse = (rel, reason, message) => {
    log(info.commonDir, {
      hook: 'check-invariants',
      session: input.session_id,
      tool,
      decision: 'block',
      target: rel,
      reason,
    });
    block(
      `Blocked by .claude/hooks/check-invariants.mjs (${reason}): ${message}\nAsk the user before working around this.`,
    );
  };

  const relOf = (raw) => {
    const path = realPath(String(raw));
    if (isExempt(path, info.mainRoot)) return null;
    return relative(rootFor(path, info.mainRoot), path);
  };

  if (tool === 'Bash') {
    for (const { path, command } of bashWrites(String(ti.command ?? ''), cwd)) {
      // Unknown targets (after an unreadable `cd`) are refused by auto-worktree.
      if (CONTENT_FREE.has(command) || path === null) continue;
      const rel = relOf(path);
      if (rel && matches(INVARIANT_FILES, rel)) {
        refuse(
          rel,
          'shell-write',
          `${rel} must be changed with Edit or Write so its content can be checked (use git rm / git mv to delete or move).`,
        );
      }
    }
    process.exit(0);
  }

  const file = ti.file_path ?? ti.notebook_path;
  if (!file) process.exit(0);
  const rel = relOf(file);
  if (!rel) process.exit(0);
  const edits = Array.isArray(ti.edits) ? ti.edits : [];
  const text = [ti.content, ti.new_string, ...edits.map((e) => e?.new_string)]
    .filter((t) => typeof t === 'string')
    .join('\n');
  const isCode = /\.(ts|tsx|js|mjs|cjs|jsx|css|html|json|jsonc)$/.test(rel);
  const inCodeDirs = /^(apps|packages|workers|tools)\//.test(rel);

  if (/^packages\/(core|protocol)\/src\//.test(rel)) {
    const found = text.match(/\b(Date\.now|new Date|Math\.random|performance\.now|crypto\.)/);
    if (found) {
      refuse(
        rel,
        'core-determinism',
        `${rel} must stay deterministic; found \`${found[1]}\`. Pass time in from the op log instead.`,
      );
    }
  }
  // The admin Worker too: with ENVIRONMENT=dev it skips Cloudflare Access (ADR 0022).
  if (
    /^workers\/(gateway|admin)\/wrangler\.jsonc$/.test(rel) &&
    /"ENVIRONMENT"\s*:\s*"dev"/.test(text)
  ) {
    refuse(
      rel,
      'gateway-locked',
      'the gateway and admin configs must never set ENVIRONMENT to "dev"; use .dev.vars locally.',
    );
  }
  if (/wrangler\.jsonc$/.test(rel)) {
    const secret = text.match(
      /"([A-Z0-9_]*(SECRET|TOKEN|PASSWORD|PRIVATE|API_KEY|SIGNING)[A-Z0-9_]*)"\s*:\s*"[^"]+"/,
    );
    if (secret) {
      refuse(
        rel,
        'no-secrets',
        `${secret[1]} looks like a secret; use \`wrangler secret\` via CI, never wrangler.jsonc.`,
      );
    }
  }
  if (isCode && inCodeDirs && /\btetr(is|omino)/i.test(text)) {
    refuse(
      rel,
      'no-tetris-names',
      'code must not say "tetris" or "tetromino" (ADR 0002); say brick, shape, rotation.',
    );
  }
  if (
    isCode &&
    inCodeDirs &&
    /[ăâđêôơưàáảãạằắẳẵặầấẩẫậèẻẽẹềếểễệìỉĩịòỏõọồốổỗộờớởỡợùủũụừứửữựỳỷỹỵ]/i.test(text)
  ) {
    refuse(rel, 'english-code', 'code, comments and identifiers are written in English.');
  }
  process.exit(0);
});
