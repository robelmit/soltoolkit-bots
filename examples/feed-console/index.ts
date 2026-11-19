/**
 * The bot kit without a bot: reads the launch feed on standard input and
 * prints, as plain text, what a community bot would post.
 *
 *   launch-feed-solana | pnpm --filter example-feed-console start
 *   launch-feed-solana | pnpm --filter example-feed-console start -- <token address> [least buy in USD]
 *
 * With no address it follows every token and prints each buy of $25 or more.
 * With an address it behaves like one group's buy bot for that token. When
 * the feed ends it prints the trending list and stops.
 */

import { BuyBotEngine, DEFAULT_MIN_BUY_USD, FeedState, MemoryStore, buyOf, buyPostCard, detectAddress, linkTemplates, parseUsd, readJsonl, toAnsi, toText, tokenCard, trendingCard, withTokenFacts, type Line } from '@soltoolkit/bot-core';

const [addressArg, minArg] = process.argv.slice(2).filter((arg) => arg !== '--');
const address = addressArg ? detectAddress(addressArg) : null;
if (addressArg && !address) throw new Error(`"${addressArg}" is not a Solana token address`);
const minUsd = minArg ? parseUsd(minArg) : DEFAULT_MIN_BUY_USD;
if (minUsd === null) throw new Error(`"${minArg}" is not a dollar amount`);

const links = linkTemplates();
const feed = new FeedState();
const store = new MemoryStore();
// Bold figures and underlined link words in a terminal; plain text when piped on.
const print = (lines: readonly Line[]): void => console.log(`${process.stdout.isTTY ? toAnsi(lines) : toText(lines)}\n`);

// One "group" with a buy bot for the token asked for. A recorded feed is replayed in an instant, so the gap between
// posts is switched off here; a real bot keeps the default ten seconds.
const engine = new BuyBotEngine({
  store,
  gapMs: 0,
  post: async (_community, post) => {
    print(buyPostCard(await withTokenFacts(post, feed), links));
    return 'sent';
  },
});

const counts = { listed: 0, buys: 0 };

feed.onTrade((trade) => {
  if (address) return;
  const buy = buyOf(trade);
  if (!buy || buy.usd < minUsd) return;
  counts.buys += 1;
  void feed.token(trade.address).then((token) => print(buyPostCard({ config: { address: trade.address, symbol: token?.symbol ?? null, decimals: token?.decimals ?? null, minUsd, setBy: null, setAt: 0 }, buys: [buy], windowMs: 1_000 }, links)));
});

if (address) {
  await store.upsert('console', { title: 'console', buyBot: { address, symbol: null, decimals: null, minUsd, setBy: null, setAt: Date.now() } });
  await engine.refresh();
}

const result = await readJsonl(process.stdin, (event) => {
  feed.apply(event);
  if (event.type === 'token_upsert' && !address) {
    counts.listed += 1;
    void feed.token(event.token.address).then((token) => token && print(tokenCard(token, links, event.ts)));
  }
  if (address && event.type === 'market_trade') {
    // A real bot skips buys older than a minute (a backlog is not news). A recorded feed is all old trades, so here
    // each one is treated as if it had just happened.
    engine.onTrade({ ...event.trade, at: Date.now() });
    void engine.flush();
  }
});

await engine.flush();
print(trendingCard(await feed.trending(5), links));
console.error(`read ${result.events} events from ${result.lines} lines; ${feed.getStats().tokens} tokens, ${feed.getStats().trades} trades${address ? `; ${engine.getStats().posts} buy posts` : `; ${counts.listed} cards, ${counts.buys} buys printed`}`);
