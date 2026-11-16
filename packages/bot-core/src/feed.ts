/**
 * The launch feed, kept in memory: every token the feed listed, patched as it
 * moves, with the last five minutes of its trades. This is the bots' default
 * data source, so a community bot needs nothing but the feed.
 *
 * It knows only what the feed sent since this process started (plus what a
 * `column_reset` carries). A token it never saw is `null`, not an empty card.
 */

import type { DataSource, FeedEvent, FeedToken, FeedTrade, TokenView, Window5m } from './types';

export const WINDOW_MS = 5 * 60_000;

interface Entry {
  token: FeedToken;
  /** Trades of the last five minutes, oldest first. */
  recent: { at: number; usd: number | null; price: number | null; buy: boolean }[];
  lastTradeAt: number | null;
  touchedAt: number;
}

export interface FeedStateOptions {
  /** The most tokens kept; the ones untouched longest go first (default 50,000). */
  readonly maxTokens?: number;
  /** The most trades kept per token inside the window (default 2,000). */
  readonly maxTradesPerToken?: number;
  readonly now?: () => number;
}

export interface FeedStats {
  events: number;
  trades: number;
  tokens: number;
  lastEventAt: number | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * One event out of a line of the feed: a JSONL line (`{"stream", "event"}`), a bare event, or the `payload` of a
 * Redis Stream entry. Null for anything else; the feed's other chains are left out.
 */
export function parseFeedEvent(input: string | unknown): FeedEvent | null {
  let value: unknown = input;
  if (typeof input === 'string') {
    try {
      value = JSON.parse(input);
    } catch {
      return null;
    }
  }
  if (!isRecord(value)) return null;
  const event = isRecord(value.event) ? value.event : value;
  if (typeof event.type !== 'string' || typeof event.ts !== 'number') return null;
  if (typeof event.chain === 'string' && event.chain !== 'solana') return null;
  switch (event.type) {
    case 'token_upsert':
      return isRecord(event.token) && typeof event.token.address === 'string' ? (event as unknown as FeedEvent) : null;
    case 'token_patch':
      return typeof event.address === 'string' && isRecord(event.patch) ? (event as unknown as FeedEvent) : null;
    case 'token_tick':
      return typeof event.address === 'string' && typeof event.price === 'number' ? (event as unknown as FeedEvent) : null;
    case 'market_trade': {
      const t = event.trade;
      if (!isRecord(t) || typeof t.address !== 'string' || typeof t.tx !== 'string' || typeof t.at !== 'number' || (t.side !== 'buy' && t.side !== 'sell') || typeof t.maker !== 'string') return null;
      if (typeof t.amountToken !== 'string' || typeof t.amountNative !== 'string') return null;
      return event as unknown as FeedEvent;
    }
    case 'token_remove':
      return typeof event.address === 'string' ? (event as unknown as FeedEvent) : null;
    case 'column_reset':
      return Array.isArray(event.tokens) ? (event as unknown as FeedEvent) : null;
    default:
      return null;
  }
}

export class FeedState implements DataSource {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<(trade: FeedTrade) => void>();
  private readonly maxTokens: number;
  private readonly maxTrades: number;
  private readonly now: () => number;
  private readonly stats: FeedStats = { events: 0, trades: 0, tokens: 0, lastEventAt: null };

  constructor(options: FeedStateOptions = {}) {
    this.maxTokens = Math.max(1, options.maxTokens ?? 50_000);
    this.maxTrades = Math.max(1, options.maxTradesPerToken ?? 2_000);
    this.now = options.now ?? Date.now;
  }

  getStats(): Readonly<FeedStats> {
    return { ...this.stats, tokens: this.entries.size };
  }

  /** Calls `listener` with every trade as it is applied; returns the way to stop. */
  onTrade(listener: (trade: FeedTrade) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private touch(address: string, token?: FeedToken): Entry | null {
    const at = this.now();
    let entry = this.entries.get(address);
    if (!entry) {
      if (!token) return null;
      entry = { token, recent: [], lastTradeAt: null, touchedAt: at };
      if (this.entries.size >= this.maxTokens) this.evict();
    } else {
      // Re-inserted so the map's order is the order of last use.
      this.entries.delete(address);
      if (token) entry.token = token;
    }
    entry.touchedAt = at;
    this.entries.set(address, entry);
    return entry;
  }

  private evict(): void {
    const drop = Math.max(1, Math.floor(this.maxTokens / 10));
    let n = 0;
    for (const key of this.entries.keys()) {
      this.entries.delete(key);
      if (++n >= drop) break;
    }
  }

  apply(event: FeedEvent): void {
    this.stats.events += 1;
    this.stats.lastEventAt = this.now();
    switch (event.type) {
      case 'token_upsert':
        this.touch(event.token.address, event.token);
        return;
      case 'column_reset':
        for (const token of event.tokens) if (token && typeof token.address === 'string') this.touch(token.address, token);
        return;
      case 'token_patch': {
        const entry = this.touch(event.address);
        if (!entry) return;
        const { audit, risk, ...rest } = event.patch;
        entry.token = {
          ...entry.token,
          ...rest,
          ...(audit ? { audit: { ...entry.token.audit, ...audit } } : {}),
          ...(risk ? { risk: { ...entry.token.risk, ...risk } } : {}),
          address: entry.token.address,
        };
        return;
      }
      case 'token_tick': {
        const entry = this.touch(event.address);
        if (entry) entry.token = { ...entry.token, price: event.price, ...(event.mc !== null ? { mc: event.mc } : {}) };
        return;
      }
      case 'market_trade': {
        this.stats.trades += 1;
        const trade = event.trade;
        const entry = this.touch(trade.address);
        if (entry) {
          entry.lastTradeAt = Math.max(entry.lastTradeAt ?? 0, trade.at);
          // A trade in a side pool prices nothing, so it stays out of the window's volume and price change.
          if (trade.offMarket !== true) {
            entry.recent.push({ at: trade.at, usd: trade.usd, price: trade.price, buy: trade.side === 'buy' });
            if (entry.recent.length > this.maxTrades) entry.recent.splice(0, entry.recent.length - this.maxTrades);
          }
        }
        for (const listener of this.listeners) listener(trade);
        return;
      }
      case 'token_remove':
        // A token that left a stage for `migrated` comes back as an upsert; one that aged out or was hidden is dropped.
        if (event.reason !== 'migrated') this.entries.delete(event.address);
        return;
    }
  }

  private window(entry: Entry, at: number): Window5m {
    const cutoff = at - WINDOW_MS;
    let first = 0;
    while (first < entry.recent.length && entry.recent[first]!.at < cutoff) first += 1;
    if (first > 0) entry.recent.splice(0, first);
    let volume: number | null = null;
    let buys = 0;
    let open: number | null = null;
    let close: number | null = null;
    for (const t of entry.recent) {
      if (t.usd !== null && Number.isFinite(t.usd)) volume = (volume ?? 0) + t.usd;
      if (t.buy) buys += 1;
      if (t.price !== null && Number.isFinite(t.price) && t.price > 0) {
        open ??= t.price;
        close = t.price;
      }
    }
    const priced = entry.recent.filter((t) => t.price !== null && t.price > 0).length;
    return { trades: entry.recent.length, buys, volumeUsd: volume, priceChangePct: priced >= 2 && open !== null && close !== null ? ((close - open) / open) * 100 : null };
  }

  private view(entry: Entry, at: number): TokenView {
    return { ...entry.token, m5: this.window(entry, at), lastTradeAt: entry.lastTradeAt };
  }

  async token(address: string): Promise<TokenView | null> {
    const entry = this.entries.get(address);
    return entry ? this.view(entry, this.now()) : null;
  }

  async trending(limit: number): Promise<TokenView[]> {
    const at = this.now();
    const out: TokenView[] = [];
    for (const entry of this.entries.values()) {
      if (entry.lastTradeAt === null || at - entry.lastTradeAt > WINDOW_MS) continue;
      const view = this.view(entry, at);
      // A token whose trades have no dollar value cannot be ranked by volume; unknown is not zero.
      if (view.m5.volumeUsd === null || view.risk?.rugged === true) continue;
      out.push(view);
    }
    return out.sort((a, b) => (b.m5.volumeUsd ?? 0) - (a.m5.volumeUsd ?? 0)).slice(0, Math.max(0, limit));
  }

  /** The newest tokens by the time they were created; tokens without a creation time are left out. */
  async latest(limit: number): Promise<TokenView[]> {
    const at = this.now();
    const dated: Entry[] = [];
    for (const entry of this.entries.values()) if (typeof entry.token.createdAt === 'number' && Number.isFinite(entry.token.createdAt)) dated.push(entry);
    return dated
      .sort((a, b) => (b.token.createdAt as number) - (a.token.createdAt as number))
      .slice(0, Math.max(0, limit))
      .map((entry) => this.view(entry, at));
  }

  lastTradeAt(address: string): number | null {
    return this.entries.get(address)?.lastTradeAt ?? null;
  }
}
