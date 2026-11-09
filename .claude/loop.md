Continue BrickPlace work from PROGRESS.md, one item per iteration.
1. Read PROGRESS.md and `git status`. If a worktree from a previous iteration has
   unfinished work, finish or verify that first.
2. Pick the first unchecked item under "Now". If it needs a product decision or touches
   secrets, deploys or Durable Object migrations, stop and ask instead.
3. Call EnterWorktree with a short name for the item, then run
   `pnpm install --frozen-lockfile --prefer-offline` in it. All edits happen there; the
   auto-worktree hook refuses edits in the main tree.
4. If the item touches rules, protocol, workers, fixtures, workflows or `.claude/`, write the
   plan file the require-plan hook names (at least 3 lines: what changes, which rule or
   invariant it is near, how you will verify it).
5. Implement it with tests. Run `pnpm verify` until green. Commit on the worktree branch
   with `git commit -s` and a Conventional Commit message.
6. Independent review: launch the `reviewer` agent. Give it only the PROGRESS item and where
   the change lives, not your reasoning, so its read is not anchored on yours. Fix every
   blocker or should-fix it reports (or write down why one is wrong), commit, and review
   again if the fixes were more than small (at most two rounds). It writes the receipt the
   Stop hook needs.
7. Tick the item in PROGRESS.md on the same branch and commit.
8. Stop. The Stop hook runs the gates and fast-forwards the branch onto local `develop`. It
   never pushes: pushing `develop` deploys staging and stays the user's call. Report: what changed, the
   reviewer's verdict, which findings you fixed and which you rejected and why.
