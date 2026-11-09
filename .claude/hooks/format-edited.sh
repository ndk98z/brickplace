#!/usr/bin/env bash
# PostToolUse(Edit|Write): format the file Claude just edited with Biome. Never blocks.
#
# Biome runs from the git top-level of the edited file, not from CLAUDE_PROJECT_DIR: the main
# tree gitignores .claude/worktrees/, so running there silently skipped every worktree edit.
file=$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).tool_input?.file_path??"")}catch{}})')
case "$file" in
  *.ts | *.tsx | *.js | *.mjs | *.json | *.jsonc | *.css | *.md | *.yml | *.yaml) ;;
  *) exit 0 ;;
esac
[ -f "$file" ] || exit 0
root=$(git -C "$(dirname "$file")" rev-parse --show-toplevel 2>/dev/null) || root="${CLAUDE_PROJECT_DIR:-.}"
cd "$root" && pnpm exec biome check --write --no-errors-on-unmatched "$file" >/dev/null 2>&1
exit 0
