# Telegram bot

A self-hosted Telegram bot for token communities on Solana launchpads. It reads the [launch feed](https://github.com/robelmit/soltoolkit-feed) and does three things in a group:

- **Token card.** Paste a token address, or send `/ca <address>`. Price, market cap and its peak, liquidity, the hour and the day, buys and sells, checks, holders, socials and a row of short links, with **Copy CA** and **Refresh** buttons under it. Refresh redraws the same message.
- **Trending.** `/trending` lists the most traded launchpad tokens of the last five minutes.
- **Buy bot.** An admin sends `/track <address>`; every buy of that token at or above a size is posted. Busy spells are merged into one post.

The bot never trades, holds no keys, and asks nobody for a wallet.

## Run it

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy its token.
2. To answer pasted addresses, send BotFather `/setprivacy` and choose **Disable**. Without this a bot sees only commands, and `/ca` still works.
3. Start the launch feed and pipe it in:

```
# with soltoolkit-feed cloned beside this repository and built (cargo build --release)
INDEXER_SOURCE=crawler SOLANA_RPC_URL=https://your-rpc.example QUOTE_PRICES_JSON='{"SOL":150}' \
  ../soltoolkit-feed/target/release/launch-feed-solana \
  | TELEGRAM_BOT_TOKEN=123456:your-token pnpm --filter @soltoolkit/telegram-bot start
```

With Redis between them, the feed and any number of bots run as separate processes: give the feed `SINK=redis` and both sides the same `REDIS_URL`. The `docker-compose.yml` at the repository root runs it that way.

4. Add the bot to a group.

## Commands

| Command | Who | What |
|---|---|---|
| `/ca <address>`, `/t <address>` | Anyone | A token card |
| `/trending` | Anyone | The five most traded tokens of the last five minutes, by dollar volume |
| `/track <address>` | Admins | Turn the buy bot on for a token |
| `/minbuy <usd>` | Admins | The least buy posted (default $25, from 1 to 1,000,000). Without a number it shows the current one |
| `/buymedia` | Admins | Reply to a picture or a GIF to post it with every buy; `/buymedia off` removes it |
| `/untrack` | Admins | Turn the buy bot off |
| `/buybot` | Anyone | The buy bot's settings, and whether trades of the token are coming in |
| `/help` | Anyone | What the bot does |

Admin commands are checked with Telegram's `getChatMember`. They are not trusted from the message.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | — | Required |
| `FEED` | `redis` when `REDIS_URL` is set, otherwise `stdin` | Where the feed is read from |
| `REDIS_URL` | — | Required with `FEED=redis` |
| `FEED_STREAM_KEY` | `stream:market:solana` | The feed's stream |
| `STORE_PATH` | `./data/telegram.json` | The file the groups' settings are kept in |
| `BOT_BUTTONS` | `Explorer` → Solscan | Buttons under cards and buy posts: `Label|https://…{address}`, comma separated, at most five |
| `LINK_ROW` | `EXP` → Solscan, `DS` → DexScreener, `X` → an X search | The short links inside a card: `CODE|https://…{address}`, comma separated, at most ten, codes up to 12 characters; `off` for none |
| `HOLDER_MAP_URL` | the soltoolkit Live site | The card's 🫧 holder map link, `https://…{address}`; `off` leaves it out |
| `BOT_CARD_IMAGE` | `0` | `1` shows the token's picture small above a card, as Telegram's link preview |
| `BOT_POWERED_BY` | — | A credit line for whoever runs the bot, at the end of the welcome and `/help` (at most 120 characters), such as `Powered by Example · example.com` |
| `LINK_TOKEN`, `LINK_WALLET`, `LINK_TX` | Solscan | Link templates with `{address}` or `{tx}` |

A missing or malformed setting stops the bot at start and says which one.

## How it behaves

- **Rates.** Everything the bot posts on its own goes through one sender that stays under Telegram's rates: one message a second in a chat, 18 a minute in a group, 25 a second across the bot. A message that would wait too long is dropped and counted, not queued.
- **Buy posts.** At most one every ten seconds per group. A buy older than a minute when the bot reads it is skipped.
- **Unasked cards.** One card per address every two minutes per group, at most ten cards a minute per group.
- **Refresh.** A card is redrawn at most once in 15 seconds and four times a minute; a press in between says so instead.
- **Markup.** Messages are MarkdownV2 with every outside text escaped. If Telegram refuses the markup, the message is sent again as plain text.
- **Groups that change.** When a group becomes a supergroup, its settings move to the new id. When the bot is removed, its buy bot stops.
- **Dollar figures** come from the feed. Give the feed a SOL price, or buys have no dollar value and none is posted.

## Limits

- It knows the tokens the feed has sent since the bot started. `/ca` for a token it has not seen says so.
- Settings live in one JSON file. That suits hundreds of groups. For more, implement the `Store` interface of `@soltoolkit/bot-core` over a database.
- Run one process per bot. Long polling does not share a bot's updates between processes.
- No holder verification and no trading.

## Tests

```
pnpm --filter @soltoolkit/telegram-bot test
```

18 tests run the bot against a fake Telegram that records every API call. The bot was not run against the real Telegram API in this repository's tests; that needs your own bot token.

## Licence

MIT
