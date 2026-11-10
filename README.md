# BrickPlace

[![OpenSSF Best Practices](https://www.bestpractices.dev/projects/16514/badge)](https://www.bestpractices.dev/projects/16514)
[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/ndk98z/brickplace/badge)](https://securityscorecards.dev/viewer/?uri=github.com/ndk98z/brickplace)

A long-running collaborative map game. Every minute you receive an item — a brick, a
hammer or a shield — and use it on a shared map with everyone else online.

> Status: pre-alpha. Season 1 has not started yet.
>
> **Try it on staging: <https://staging.brickplace.app>.** It is a test server that runs the
> latest `develop`. Its map and accounts can be reset at any time.

## Quick start

```sh
pnpm install
pnpm verify   # lint, typecheck, tests, Worker bundles
pnpm dev      # gateway + realtime + game Workers on http://localhost:8787
```

Requires Node 24 and pnpm 11.

## How it is built

Everything runs on Cloudflare Workers and Durable Objects:

| Path                | What                                                      |
| ------------------- | --------------------------------------------------------- |
| `packages/core`     | Game rules: pure, deterministic, platform-free            |
| `packages/protocol` | Versioned binary WebSocket protocol                       |
| `packages/golden`   | Op-log fixtures every rules implementation must reproduce |
| `workers/gateway`   | Auth, routing, static client                              |
| `workers/realtime`  | FanoutDO: player WebSockets                               |
| `workers/game`      | CanvasDO: the map, the op log                             |
| `apps/client`       | WebGL2 client                                             |

Architecture decisions live in [`docs/adr`](docs/adr).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Commits need a DCO sign-off (`git commit -s`).

## License

Code: [AGPL-3.0-or-later](LICENSE). Art and sound: CC BY-SA 4.0. The BrickPlace name and
logo are not covered by these licenses; see [TRADEMARKS.md](TRADEMARKS.md) and
[COPYING.md](COPYING.md).
