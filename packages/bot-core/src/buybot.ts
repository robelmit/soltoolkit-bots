/**
 * The buy bot's engine, with no bot library in it. A community's admins pick
 * one token and a least size; every buy of it at or above that size is
 * posted. At most one post per community every ten seconds: the buys of a
 * busy spell are merged into one post ("5 buys, $820 in 10 s, biggest $400"),
 * so a busy token never floods a group or trips the platform's rate limit.
 *
 * The engine decides what to post and when. Sending is the caller's: `post`
 * gets the community and the post, and answers what happened.
 */

import { buyOf, type Buy, type BuyPost } from './cards';
import type { CommunityRecord, FeedTrade, Logger, Store } from './types';
import { silentLogger } from './types';

/** The least time between two buy posts in one community. */
export const BUY_POST_GAP_MS = 10_000;
export const DEFAULT_MIN_BUY_USD = 25;
export const MIN_BUY_USD_RANGE = Object.freeze({ min: 1, max: 1_000_000 });
/** A buy older than this when it is read (a backlog after a restart) is not news and is not posted. */
export const MAX_BUY_AGE_MS = 60_000;
/** The most buys held for one community between two posts; a storm keeps the biggest. */
const MAX_PENDING = 200;
const KEPT_OF_A_STORM = 50;

export type PostOutcome = 'sent' | 'dropped' | 'gone' | 'failed';

export interface BuyBotStats {
  trades: number;
  matched: number;
  posts: number;
  merged: number;
  dropped: number;
  communities: number;
  lastPostAt: number | null;
}

export interface BuyBotOptions {
  readonly store: Store;
  /** Sends one post to one community. `gone`: the bot is no longer there. */
  readonly post: (community: CommunityRecord, post: BuyPost) => Promise<PostOutcome>;
  readonly log?: Logger;
  readonly now?: () => number;
  /** How often pending buys are looked at, in milliseconds (default 1,000). */
  readonly flushMs?: number;
  /** The least time between two posts in one community (default 10 s). */
  readonly gapMs?: number;
  /** How often the communities are read again from the store (default 60 s). */
  readonly reloadMs?: number;
}

export class BuyBotEngine {
  private readonly now: () => number;
  private readonly log: Logger;
  private readonly gapMs: number;
  private byToken = new Map<string, CommunityRecord[]>();
  private byCommunity = new Map<string, CommunityRecord>();
  private readonly pending = new Map<string, Buy[]>();
  private readonly lastPost = new Map<string, number>();
  private loadedAt = 0;
  private stale = true;
  private flushing = false;
  private readonly stats: BuyBotStats = { trades: 0, matched: 0, posts: 0, merged: 0, dropped: 0, communities: 0, lastPostAt: null };

  constructor(private readonly options: BuyBotOptions) {
    this.now = options.now ?? Date.now;
    this.log = options.log ?? silentLogger;
    this.gapMs = options.gapMs ?? BUY_POST_GAP_MS;
  }

  getStats(): Readonly<BuyBotStats> {
    return { ...this.stats };
  }

  /** A community changed its settings: read them again before the next post. */
  invalidate(): void {
    this.stale = true;
  }

  /** Give every trade of the feed to this (`feed.onTrade(engine.onTrade)`). */
  readonly onTrade = (trade: FeedTrade): void => {
    this.stats.trades += 1;
    const watchers = this.byToken.get(trade.address);
    if (!watchers) return;
    const buy = buyOf(trade);
    if (!buy || this.now() - buy.at > MAX_BUY_AGE_MS) return;
    for (const community of watchers) {
      const config = community.buyBot;
      if (!config || buy.usd < config.minUsd) continue;
      this.stats.matched += 1;
      const list = this.pending.get(community.id) ?? [];
      list.push(buy);
      if (list.length > MAX_PENDING) list.sort((a, b) => b.usd - a.usd).splice(KEPT_OF_A_STORM);
      this.pending.set(community.id, list);
    }
  };

  /** Reads the communities with a buy bot again: after a change, and every minute. */
  async refresh(): Promise<void> {
    if (!this.stale && this.now() - this.loadedAt < (this.options.reloadMs ?? 60_000)) return;
    // Cleared first: a change that arrives while the store is being read marks the result stale again.
    this.stale = false;
    const rows = await this.options.store.withBuyBot();
    const byToken = new Map<string, CommunityRecord[]>();
    const byCommunity = new Map<string, CommunityRecord>();
    for (const row of rows) {
      if (!row.buyBot || row.left) continue;
      byToken.set(row.buyBot.address, [...(byToken.get(row.buyBot.address) ?? []), row]);
      byCommunity.set(row.id, row);
    }
    this.byToken = byToken;
    this.byCommunity = byCommunity;
    this.stats.communities = byCommunity.size;
    this.loadedAt = this.now();
  }

  /** Posts every community whose gap has passed: one buy as itself, several merged. Communities post side by side. */
  async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      await this.refresh().catch((error: unknown) => {
        this.stale = true;
        this.log.warn('buy bot: the communities could not be read', { error: error instanceof Error ? error.message : String(error) });
      });
      const at = this.now();
      const due: { community: CommunityRecord; buys: Buy[] }[] = [];
      for (const [id, buys] of [...this.pending]) {
        if (!buys.length || at - (this.lastPost.get(id) ?? -Infinity) < this.gapMs) continue;
        this.pending.delete(id);
        const community = this.byCommunity.get(id);
        // The community stopped its buy bot, or changed token, since these buys were held.
        if (!community?.buyBot) continue;
        const mine = buys.filter((b) => b.address === community.buyBot!.address && b.usd >= community.buyBot!.minUsd);
        if (!mine.length) continue;
        this.lastPost.set(id, at);
        due.push({ community, buys: mine });
      }
      for (let i = 0; i < due.length; i += 25) await Promise.all(due.slice(i, i + 25).map((d) => this.send(d.community, d.buys, at)));
      if (this.lastPost.size > 20_000) for (const [id, t] of this.lastPost) if (at - t > 3_600_000) this.lastPost.delete(id);
    } finally {
      this.flushing = false;
    }
  }

  private async send(community: CommunityRecord, buys: readonly Buy[], at: number): Promise<void> {
    const windowMs = Math.max(1_000, Math.min(this.gapMs, at - Math.min(...buys.map((b) => b.at))));
    let outcome: PostOutcome;
    try {
      outcome = await this.options.post(community, { config: community.buyBot!, buys, windowMs });
    } catch (error) {
      this.log.warn('buy bot: a post failed', { community: community.id, error: error instanceof Error ? error.message : String(error) });
      outcome = 'failed';
    }
    if (outcome === 'sent') {
      this.stats.posts += 1;
      if (buys.length > 1) this.stats.merged += 1;
      this.stats.lastPostAt = at;
    } else if (outcome === 'gone') {
      await this.options.store.upsert(community.id, { left: true }).catch(() => undefined);
      this.invalidate();
    } else {
      this.stats.dropped += 1;
    }
  }

  /** Flushes on a timer until `signal` aborts. */
  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await this.flush().catch((error: unknown) => this.log.warn('buy bot: flush failed', { error: error instanceof Error ? error.message : String(error) }));
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.options.flushMs ?? 1_000);
        signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
      });
    }
  }
}
