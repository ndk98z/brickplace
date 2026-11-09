# Tools

- Change files with Edit or Write. Never write, move or delete repo files from inline
  interpreter code (`python3 -c`, `node -e`, a heredoc fed to `python3` or `node`): those
  writes skip the worktree, plan, invariant and formatting hooks. `guard-bash` refuses the
  inline ones it can read; a script file run by path is not seen, so do not route around it
  that way either. For scratch output, print to stdout and redirect to a literal path in the
  session scratchpad.
- Write tests for a 2-CPU runner (the margin; CI's has 4), not this machine: there
  `pnpm verify` runs every package's tests at once, about 10x slower. A new vitest package sets `testTimeout` (30 s
  plain Node, 15 s Workers). No `toEqual` on large typed arrays (a 64K-cell tile took 5 s
  there). No "sleep 50-300 ms, then expect", no upper bound on elapsed time, no item due in
  a few hundred ms: poll for the condition up to a generous deadline, or gate the step the
  test waits on. Before calling a timing fix done, run the gate in a 2-CPU container from a
  clean tree (this machine's `node_modules` are darwin builds), and look at tests near their
  timeout, not only failures: `git archive HEAD | docker run -i --rm --cpus=2 node:24 bash -c
  'mkdir /w && cd /w && tar x && corepack enable && pnpm install --frozen-lockfile && pnpm
  verify'`. The repo is public now (ADR 0046) and its runner has 4 CPUs; keep the 2-CPU
  check as the margin.
- Close every browser page you open (chrome-devtools `close_page`, Playwright
  `browser.close()`) and stop every dev server you start (`pnpm dev`, `wrangler dev`, Vite)
  as soon as the check is done, before reporting. Say in the report that you did. Never
  close the owner's own browser windows.
