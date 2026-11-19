# soltoolkit-bots

Self-hosted community bots for tokens on Solana launchpads, from the team behind the Hexa trading terminal. They read the launch feed, never trade, and hold no keys.

## What is here

| Piece | What it does |
|---|---|
| [telegram-bot](apps/telegram-bot) | A token card for a pasted address or `/ca`, `/trending`, and a buy bot a group's admins set up with `/track` |
| [discord-bot](apps/discord-bot) | The same as slash commands and embeds, with every mention switched off |
| [`@soltoolkit/bot-core`](packages/bot-core) | The shared half, with no bot library inside: a reader for the launch feed, cards, the buy-bot engine, rate limits, stores, and renderers for both platforms |

The bots read the launch feed of [soltoolkit-feed](https://github.com/robelmit/soltoolkit-feed). [docs/self-hosting.md](docs/self-hosting.md) runs everything on one machine, with or without Docker.

```bash
launch-feed-solana | pnpm --filter example-feed-console start   # what a bot would post, as plain text
```

## Principles

- **Nothing here signs, sends or holds a key.**
- **Unknown is never zero.** A value that could not be read stays `null`; it is never counted as a pass or as nothing.
- **Refuse rather than guess.** A failed read is an error, not "not found".
- **No API key needed.** Everything runs against a plain Solana JSON-RPC endpoint you choose.

## Develop

Node 22.13 or newer and pnpm, to work on the repository. The published packages run on Node 20 or newer.

This repository uses packages of [soltoolkit-agents](https://github.com/robelmit/soltoolkit-agents). Until those are on npm, clone it beside this one and run `pnpm install && pnpm build` there first; `.pnpmfile.cjs` then links the local copies.

```bash
pnpm install
pnpm check        # build, typecheck, test, lint
```

## The soltoolkit family

| Repository | What it holds |
|---|---|
| [soltoolkit-sdk](https://github.com/robelmit/soltoolkit-sdk) | Launchpad trade SDK and the shared RPC client |
| [soltoolkit-feed](https://github.com/robelmit/soltoolkit-feed) | The launch feed: a Rust indexer for launches, trades and migrations |
| [soltoolkit-insights](https://github.com/robelmit/soltoolkit-insights) | Token safety, holder maps and their viewer, wallet PnL, the trading-app registry |
| **soltoolkit-bots** (this one) | Telegram and Discord community bots |
| [soltoolkit-agents](https://github.com/robelmit/soltoolkit-agents) | A read-only MCP server for AI agents, an HTTP API, and the soltoolkit Live site |

See [CONTRIBUTING.md](CONTRIBUTING.md) to contribute and [SECURITY.md](SECURITY.md) to report a vulnerability.

## Licence

[MIT](LICENSE)
