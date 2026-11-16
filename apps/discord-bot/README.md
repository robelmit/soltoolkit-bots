# Discord bot

A self-hosted Discord bot for token communities on Solana launchpads. It reads the [launch feed](https://github.com/robelmit/soltoolkit-feed) and posts the same cards as the [Telegram bot](../telegram-bot), as embeds:

- **Token card.** `/ca <address>`.
- **Trending.** `/trending` lists the most traded launchpad tokens of the last five minutes.
- **Buy bot.** A server manager runs `/track <address>`; every buy of that token at or above a size is posted in a channel. Busy spells are merged into one post.

The bot never trades, holds no keys, and asks nobody for a wallet.

## Run it

1. In the [Discord developer portal](https://discord.com/developers/applications), create an application, add a bot, and copy the bot token and the application id.
2. Invite it with the `bot` and `applications.commands` scopes and the **Send Messages** and **Embed Links** permissions.
3. Start the launch feed and pipe it in:

```
# with soltoolkit-feed cloned beside this repository and built (cargo build --release)
INDEXER_SOURCE=crawler SOLANA_RPC_URL=https://your-rpc.example QUOTE_PRICES_JSON='{"SOL":150}' \
  ../soltoolkit-feed/target/release/launch-feed-solana \
  | DISCORD_BOT_TOKEN=your-token DISCORD_APPLICATION_ID=123456789012345678 pnpm --filter @soltoolkit/discord-bot start
```

With Redis between them, the feed and the bots run as separate processes: give the feed `SINK=redis` and both sides the same `REDIS_URL`. The `docker-compose.yml` at the repository root runs it that way.

Slash commands are registered when the bot starts. Discord can take a while to show new global commands.

## Commands

| Command | Who | What |
|---|---|---|
| `/ca address` | Anyone | A token card |
| `/trending` | Anyone | The five most traded tokens of the last five minutes, by dollar volume |
| `/track address [channel]` | Manage Server | Turn the buy bot on for a token; buys go to the channel given, or the one the command was run in |
| `/minbuy usd` | Manage Server | The least buy posted (default $25, from 1 to 1,000,000) |
| `/untrack` | Manage Server | Turn the buy bot off |
| `/buybot` | Anyone | The buy bot's settings, shown only to you |
| `/help` | Anyone | What the bot does |

The manager commands are declared with the Manage Server permission, and the permission is checked again when the command runs.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `DISCORD_BOT_TOKEN` | — | Required |
| `DISCORD_APPLICATION_ID` | — | Required |
| `DISCORD_MESSAGE_CONTENT` | `0` | `1` answers a pasted address without a command. It needs the Message Content intent, switched on for the application in the developer portal |
| `FEED` | `redis` when `REDIS_URL` is set, otherwise `stdin` | Where the feed is read from |
| `REDIS_URL` | — | Required with `FEED=redis` |
| `FEED_STREAM_KEY` | `stream:market:solana` | The feed's stream |
| `STORE_PATH` | `./data/discord.json` | The file the servers' settings are kept in |
| `BOT_BUTTONS` | `Explorer` → Solscan | Link buttons under cards and buy posts: `Label|https://…{address}`, comma separated, at most five |
| `LINK_TOKEN`, `LINK_WALLET`, `LINK_TX` | Solscan | Link templates with `{address}` or `{tx}` |

A missing or malformed setting stops the bot at start and says which one.

## How it behaves

- **Nobody is pinged.** Every message is sent with mentions switched off, and outside text is escaped, so a token called `@everyone` is only text.
- **Buy posts.** At most one every ten seconds per server. A buy older than a minute when the bot reads it is skipped. discord.js handles Discord's own rate limits.
- **A channel that is gone.** If the bot can no longer post in the buy bot's channel, the buy bot is switched off for that server; a manager runs `/track` again.
- **Dollar figures** come from the feed. Give the feed a SOL price, or buys have no dollar value and none is posted.

## Limits

- It knows the tokens the feed has sent since the bot started.
- Settings live in one JSON file; for many servers, implement the `Store` interface of `@soltoolkit/bot-core` over a database.
- One process, no sharding.
- No holder verification, no roles, no trading.

## Tests

```
pnpm --filter @soltoolkit/discord-bot test
```

10 tests cover the commands and the embeds as plain functions. The connection to Discord (`src/main.ts`) is type-checked and was not run against the real Discord API in this repository's tests; that needs your own bot token.

## Licence

MIT
