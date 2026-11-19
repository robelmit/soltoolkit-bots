# @soltoolkit/bot-core

The shared half of a community bot for Solana launchpad tokens. It reads the [launch feed](https://github.com/robelmit/soltoolkit-feed), keeps the tokens and their last hour of trades in memory, and builds what a bot says: a token card, a trending list, and buy posts that are merged when a token is busy.

A token card reads the way traders read one:

```
🧪 Zop [40K / -12% 1h] $ZOP/SOL
☀️ Solana @ pump.fun · curve 71% · 🔥 #4
💰 Price: $0.0₄4
💎 MC: $40K ⇨ $120K peak [1h]
💧 Liq: $9.5K
📈 1H: -11.7% · $1.5K · 🅑 25 Ⓢ 30 · 5M +12.3%
📊 24H: +48% · Vol $6.6K · Age: 1h
🛡 mint ✅ · freeze ✅ · top 10 31% · dev sold · bundlers 13%
👥 Holders: 412 · 🫧 Map
🌐 X · Web
🔗 EXP · DS · X

FWFxnxR1Esvv6Ebcntr357ri1mucV5FiKTG1kEiBpump
♻️ Updated 14:05 UTC
```

On Discord the figures sit in grey boxes and "Updated" ticks in the reader's own time. A row with nothing known in it is left out.

There is no bot library inside. The [Telegram bot](../../apps/telegram-bot) and the [Discord bot](../../apps/discord-bot) are thin layers over this package, and a bot for any other platform can be built the same way.

```ts
import { BuyBotEngine, FeedState, MemoryStore, buyPostCard, linkTemplates, readJsonl, toPlain } from '@soltoolkit/bot-core';

const links = linkTemplates();
const feed = new FeedState();
const store = new MemoryStore();

const engine = new BuyBotEngine({
  store,
  post: async (community, post) => {
    console.log(`to ${community.id}:\n${toPlain(buyPostCard(post, links))}`);
    return 'sent';
  },
});
feed.onTrade(engine.onTrade);

await store.upsert('my-group', { buyBot: { address: '<token address>', symbol: null, decimals: null, minUsd: 25, setBy: null, setAt: Date.now() } });
void engine.run(new AbortController().signal);

// The launch feed's standard output, piped in.
await readJsonl(process.stdin, (event) => feed.apply(event));
```

## Install

```
npm i @soltoolkit/bot-core
```

Node 20 or later. No dependencies.

## What is in it

| Part | What it does |
|---|---|
| `FeedState` | Applies the feed's events. Answers `token(address)`, `trending(limit)`, `rank(address)`, `latest(limit)` and `lastTradeAt(address)`. Holds at most `maxTokens` tokens (50,000 by default) and drops the ones untouched longest |
| `readJsonl`, `readRedisStream` | Read the feed from lines of JSON, or from its Redis Stream with any client that has `xread` (ioredis fits) |
| `BuyBotEngine` | Decides which buys to post and when: the community's least size, one post per community every ten seconds, busy spells merged, old buys skipped |
| `tokenCard`, `trendingCard`, `buyPostCard` | Build the messages as rich-text lines. A card can carry the token's trending rank and the chat's first call |
| `toMarkdownV2`, `toDiscord`, `toPlain`, `toText` | Print those lines for Telegram, for Discord, as plain text with links, or as text alone, escaping what each platform treats as markup |
| `telegramEntities` | How many formatting entities a message makes; Telegram ignores those past 100 |
| `CardLimiter`, `SendSlots` | A budget for unasked cards, and send times that stay inside a platform's rates |
| `MemoryStore`, `JsonFileStore` | Where communities' settings are kept; `Store` is four methods if you want a database |
| `linkTemplates`, `parseButtons`, `parseLinkRow`, `linksFromSettings` | Where links and buttons point, read from the bots' settings |

## What a card shows, and from where

| Row | From |
|---|---|
| Price, market cap, liquidity, holders, curve, checks | The feed's token and its patches |
| Peak market cap | The feed's `ath`, its highest market cap; or the highest market cap the bot saw itself, with its time, whichever is higher |
| The hour and the day | The feed's `stats["1h"]` and `stats["24h"]` while they are at most five minutes old. Without them, the hour from the bot's own trades, but only once the bot has watched a whole hour; otherwise the row falls back to the five minutes |
| Five minutes | The bot's own trades |
| Rank | The token's place among the 100 most traded of the last five minutes |
| Socials, Dex paid, picture | The feed, when it sent them. Only `http(s)` links are printed; a bare X handle becomes its page |
| "via Axiom" on a buy | The trade's `platform`, when the feed could tell |

## Rules it keeps

- **Unknown is never zero.** A trade without a dollar value is not counted as $0 of volume and is never posted as a buy; a window's volume is known only when every trade in it had a dollar value. A token whose trades have no dollar value is left out of the trending list. An unknown figure prints as `—`, and an hour the bot has not fully seen is not shown as an hour.
- **Text from outside cannot break a message.** A token's name and symbol are escaped by the renderer for each platform, and Discord mentions are defused, so a token called `@everyone` pings nobody.
- **Late is worse than never.** A buy older than a minute when it is read is not posted. `SendSlots` tells a caller how long a message would wait, so the caller can drop it.
- **A busy token does not flood a group.** At most one post per community every ten seconds. Buys in between are merged into one post with the count, the total, the biggest buyer and the latest market cap. In a storm the 50 biggest buys are kept.
- **Links are neutral.** The default buttons open a block explorer, and the card's short links open Solscan, DexScreener and an X search; the holder map link opens the soltoolkit Live site. A community sets its own with `{address}` and `{tx}` templates. Only `https` links are accepted, and a bad template stops the bot at start.

## What the feed must provide

`FeedState` knows only what the feed has sent since the process started. A token it has not seen is `null`.

Dollar figures come from the feed. The launch feed converts with the prices it is given (`QUOTE_PRICES_JSON` or a Redis hash, see its README). Without a price there, trades have no dollar value, and the buy bot posts nothing, because its least size is in dollars.

## Another data source

The bots read tokens through `DataSource`:

```ts
interface DataSource {
  token(address: string): Promise<TokenView | null>;
  trending(limit: number): Promise<TokenView[]>;
  lastTradeAt(address: string): number | null;
  rank?(address: string): Promise<number | null>;
}
```

`FeedState` is the built-in one. Anything else that answers the first three can stand in; `rank` is optional.

## What it does not do

- It does not trade, sign, or hold keys.
- It does not verify holders or manage roles.
- It does not keep history: a restart starts with an empty `FeedState`.
- Solana only, as the launch feed is.

## Tests

```
pnpm --filter @soltoolkit/bot-core test
```

57 tests. The feed tests replay real output of the launch feed (`test/fixtures/feed.jsonl`).

## Licence

MIT
