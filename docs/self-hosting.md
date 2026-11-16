# Self-hosting

This page runs the launch feed and the community bots on one machine. You need a Solana RPC endpoint. Nothing here needs a wallet or a key.

## What you need

| For | You need |
|---|---|
| Everything | A Solana JSON-RPC endpoint. A public one works for a try; it will rate-limit you |
| The TypeScript side | Node 20 or later, pnpm |
| The launch feed | Rust (the version in `rust-toolchain.toml` of soltoolkit-feed), or Docker |
| The Telegram bot | A bot token from [@BotFather](https://t.me/BotFather) |
| The Discord bot | A bot token and an application id from the [developer portal](https://discord.com/developers/applications) |
| Several processes sharing the feed | Redis |

## The smallest thing that works

The feed prints events; a bot reads them from a pipe. No Redis, no Docker.

```bash
pnpm install && pnpm build

# with soltoolkit-feed cloned beside this repository and built (cargo build --release)
INDEXER_SOURCE=crawler SOLANA_RPC_URL=https://your-rpc.example QUOTE_PRICES_JSON='{"SOL":150}' \
  ../soltoolkit-feed/target/release/launch-feed-solana \
  | TELEGRAM_BOT_TOKEN=123456:your-token pnpm --filter @soltoolkit/telegram-bot start
```

To see what the bot would post without creating a bot, pipe the feed into the console example instead:

```bash
... ../soltoolkit-feed/target/release/launch-feed-solana | pnpm --filter example-feed-console start
```

## With Docker

```bash
cp .env.example .env        # fill in SOLANA_RPC_URL and the bot tokens you have
docker compose up -d                      # Redis and the feed
docker compose --profile telegram up -d   # plus the Telegram bot
docker compose --profile discord up -d    # plus the Discord bot
```

The feed writes to a Redis Stream; each bot reads it. The bots keep their settings in a Docker volume.

## Things to decide

**The feed's source.** `crawler` works on any RPC endpoint and sees a sample of transactions, a few seconds behind. `geyser` needs a Yellowstone gRPC endpoint and sees everything the stream delivers. See [the feed's README](https://github.com/robelmit/soltoolkit-feed/tree/main/README.md#two-sources).

**Dollar figures.** The feed fetches no prices. `QUOTE_PRICES_JSON='{"SOL":150}'` is fixed for the life of the process and goes stale. For figures that follow the market, have a process of your own write the SOL price to the Redis hash `prices:majors`; the feed reads it every 15 seconds. Without any price, trades have no dollar value, and the buy bot (whose least size is in dollars) posts nothing.

**Buttons.** By default cards and buy posts carry one button, to a block explorer. Set `BOT_BUTTONS` to your own, for example `Chart|https://example.com/chart/{address}`.

**Redis size.** The compose file runs the feed with holder books off, which keeps Redis small. Turn them on (`HOLDERS=1`) only if something of yours reads them.

## What was and was not run

The maintainers' checks are listed in each README. In short:

- The TypeScript packages, the bots' logic, the MCP server and the demo API have unit tests, and the packages were installed from their packed tarballs.
- The launch feed's tests replay recorded mainnet transactions. Its crawler source was run against a public mainnet endpoint.
- The MCP server and the demo API were run against a public mainnet endpoint.
- The bots were tested against fakes of Telegram and Discord, not the real services.
- The Dockerfiles and the compose file were written without a Docker daemon to run them on. Treat the first build as a test, and open an issue if it fails.
- The feed's `geyser` source does not build on Windows and was not run by the maintainers on the machine this was written on.
