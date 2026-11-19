/**
 * The launch feed, kept in memory: every token the feed listed, patched as it
 * moves, with the last five minutes of its trades. This is the bots' default
 * data source, so a community bot needs nothing but the feed.
 *
 * It knows only what the feed sent since this process started (plus what a
 * `column_reset` carries). A token it never saw is `null`, not an empty card.
 */

import type { DataSource, FeedEvent, FeedToken, FeedTrade, FeedWindowStats, Peak, TokenView, Window5m, WindowFigures } from './types';

export const WINDOW_MS = 5 * 60_000;
/** The bot keeps an hour of trades itself, for chains whose feed sends no hourly figures. */
export const HOUR_MS = 60 * 60_000;
/** The feed's own window figures are shown while they are at most this old. */
export const STATS_FRESH_MS = 5 * 60_000;

interface Entry {
  token: FeedToken;
  /** Trades of the last hour, oldest first. */
  recent: { at: number; usd: number | null; price: number | null; buy: boolean }[];
  /** The time of the newest trade dropped to stay under the per-token cap: the hour before it is incomplete. */
  trimmedAt: number | null;
  /** When the feed last sent `stats`. */
  statsAt: number | null;
  /** The highest market cap the bot saw, and when. */
  peakMc: number | null;
  peakAt: number | null;
  lastTradeAt: number | null;
  touchedAt: number;
}

export interface FeedStateOptions {
  /** The most tokens kept; the ones untouched longest go first (default 50,000). */
  readonly maxTokens?: number;
  /** The most trades kept per token inside the hour (default 5,000). */
  readonly maxTradesPerToken?: number;
  readonly now?: () => number;
}

/** A token the feed listed or changed: what it was before (null when it is new to the bot) and what it is now. */
export interface TokenChange {
  readonly before: FeedToken | null;
  readonly after: FeedToken;
}

/** What `exportSnapshot` writes: the tokens without their trades or window figures, which go stale anyway. */
export interface FeedSnapshot {
  readonly version: 1;
  readonly savedAt: number;
  readonly tokens: readonly { readonly token: FeedToken; readonly peakMc: number | null; readonly peakAt: number | null; readonly lastTradeAt: number | null; readonly touchedAt: number }[];
}

const finite = (value: number | null | undefined): value is number => typeof value === 'number' && Number.isFinite(value);
const count = (value: number | null | undefined): number | null => (finite(value) && value >= 0 ? value : null);

/** The feed's figures for one window, or null when it sent none. */
function figuresOf(stats: FeedWindowStats | undefined): WindowFigures | null {
  if (!stats) return null;
  const figures: WindowFigures = {
    buys: count(stats.buys),
    sells: count(stats.sells),
    volumeUsd: count(stats.volumeUsd),
    priceChangePct: finite(stats.priceChangePct) ? stats.priceChangePct : null,
  };
  return Object.values(figures).some((v) => v !== null) ? figures : null;
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
  private readonly tokenListeners = new Set<(change: TokenChange) => void>();
  private readonly maxTokens: number;
  private readonly maxTrades: number;
  private readonly now: () => number;
  private readonly stats: FeedStats = { events: 0, trades: 0, tokens: 0, lastEventAt: null };
  /** Before an hour has passed since this, the bot has not seen a whole hour itself. */
  private readonly startedAt: number;

  constructor(options: FeedStateOptions = {}) {
    this.maxTokens = Math.max(1, options.maxTokens ?? 50_000);
    this.maxTrades = Math.max(1, options.maxTradesPerToken ?? 5_000);
    this.now = options.now ?? Date.now;
    this.startedAt = this.now();
  }

  getStats(): Readonly<FeedStats> {
    return { ...this.stats, tokens: this.entries.size };
  }

  /** Calls `listener` with every trade as it is applied; returns the way to stop. */
  onTrade(listener: (trade: FeedTrade) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Calls `listener` each time the feed lists or changes a token (a listing, a patch, a tick). A `column_reset` and a
   * restored snapshot are not news and call nothing. Returns the way to stop.
   */
  onToken(listener: (change: TokenChange) => void): () => void {
    this.tokenListeners.add(listener);
    return () => this.tokenListeners.delete(listener);
  }

  private changed(before: FeedToken | null, after: FeedToken): void {
    for (const listener of this.tokenListeners) listener({ before, after });
  }

  /** The tokens touched in the last `maxAgeMs` (default a day), newest first, at most `limit` (default 20,000). */
  exportSnapshot(options: { readonly maxAgeMs?: number; readonly limit?: number } = {}): FeedSnapshot {
    const at = this.now();
    const cutoff = at - (options.maxAgeMs ?? 24 * 60 * 60_000);
    const limit = options.limit ?? 20_000;
    const tokens: FeedSnapshot['tokens'][number][] = [];
    // The map is in the order of last use, so the newest are at its end.
    for (const entry of [...this.entries.values()].reverse()) {
      if (tokens.length >= limit || entry.touchedAt < cutoff) break;
      const token: Record<string, unknown> = { ...entry.token };
      delete token.stats;
      delete token.spark;
      tokens.push({ token: token as unknown as FeedToken, peakMc: entry.peakMc, peakAt: entry.peakAt, lastTradeAt: entry.lastTradeAt, touchedAt: entry.touchedAt });
    }
    return { version: 1, savedAt: at, tokens };
  }

  /**
   * Takes back the tokens of a snapshot no older than `maxAgeMs` (default a day). A token the feed has already sent
   * since the start is kept as the feed has it. Calls no listener. Returns how many tokens were taken back.
   */
  importSnapshot(snapshot: FeedSnapshot, options: { readonly maxAgeMs?: number } = {}): number {
    if (snapshot?.version !== 1 || !Array.isArray(snapshot.tokens) || this.now() - snapshot.savedAt > (options.maxAgeMs ?? 24 * 60 * 60_000)) return 0;
    let n = 0;
    // Oldest first, so the map's order of last use comes back as it was.
    for (const row of [...snapshot.tokens].reverse()) {
      const token = row?.token;
      if (!token || typeof token.address !== 'string' || typeof token.symbol !== 'string' || this.entries.has(token.address)) continue;
      if (this.entries.size >= this.maxTokens) break;
      this.entries.set(token.address, {
        token,
        recent: [],
        trimmedAt: null,
        statsAt: null,
        peakMc: finite(row.peakMc) ? row.peakMc : null,
        peakAt: finite(row.peakAt) ? row.peakAt : null,
        lastTradeAt: finite(row.lastTradeAt) ? row.lastTradeAt : null,
        touchedAt: finite(row.touchedAt) ? row.touchedAt : snapshot.savedAt,
      });
      n += 1;
    }
    return n;
  }

  private touch(address: string, token?: FeedToken): Entry | null {
    const at = this.now();
    let entry = this.entries.get(address);
    if (!entry) {
      if (!token) return null;
      entry = { token, recent: [], trimmedAt: null, statsAt: null, peakMc: null, peakAt: null, lastTradeAt: null, touchedAt: at };
      if (this.entries.size >= this.maxTokens) this.evict();
    } else {
      // Re-inserted so the map's order is the order of last use.
      this.entries.delete(address);
      if (token) entry.token = token;
    }
    entry.touchedAt = at;
    this.entries.set(address, entry);
    if (token) this.noted(entry, token);
    return entry;
  }

  /** Notes the market cap for the peak, and when the feed's window figures arrived. */
  private noted(entry: Entry, fields: Partial<FeedToken>, at: number = this.now()): void {
    if (fields.stats && typeof fields.stats === 'object') entry.statsAt = this.now();
    this.notePeak(entry, fields.mc, at);
  }

  private notePeak(entry: Entry, mc: number | null | undefined, at: number): void {
    if (!finite(mc) || mc <= 0) return;
    if (entry.peakMc === null || mc > entry.peakMc) {
      entry.peakMc = mc;
      entry.peakAt = at;
    }
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
      case 'token_upsert': {
        const before = this.entries.get(event.token.address)?.token ?? null;
        const entry = this.touch(event.token.address, event.token);
        if (entry) this.changed(before, entry.token);
        return;
      }
      case 'column_reset':
        for (const token of event.tokens) if (token && typeof token.address === 'string') this.touch(token.address, token);
        return;
      case 'token_patch': {
        const entry = this.touch(event.address);
        if (!entry) return;
        const before = entry.token;
        const { audit, risk, ...rest } = event.patch;
        entry.token = {
          ...entry.token,
          ...rest,
          ...(audit ? { audit: { ...entry.token.audit, ...audit } } : {}),
          ...(risk ? { risk: { ...entry.token.risk, ...risk } } : {}),
          address: entry.token.address,
        };
        this.noted(entry, rest);
        this.changed(before, entry.token);
        return;
      }
      case 'token_tick': {
        const entry = this.touch(event.address);
        if (!entry) return;
        const before = entry.token;
        entry.token = { ...entry.token, price: event.price, ...(event.mc !== null ? { mc: event.mc } : {}) };
        this.notePeak(entry, event.mc, finite(event.at) && event.at > 0 ? event.at : this.now());
        this.changed(before, entry.token);
        return;
      }
      case 'market_trade': {
        this.stats.trades += 1;
        const trade = event.trade;
        const entry = this.touch(trade.address);
        if (entry) {
          entry.lastTradeAt = Math.max(entry.lastTradeAt ?? 0, trade.at);
          // A trade in a side pool prices nothing, so it stays out of the window's volume, price change and peak.
          if (trade.offMarket !== true) {
            entry.recent.push({ at: trade.at, usd: trade.usd, price: trade.price, buy: trade.side === 'buy' });
            if (entry.recent.length > this.maxTrades) {
              const dropped = entry.recent.splice(0, entry.recent.length - this.maxTrades);
              entry.trimmedAt = Math.max(entry.trimmedAt ?? 0, dropped.at(-1)!.at);
            }
            this.notePeak(entry, trade.mc, trade.at);
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

  /** The trades since `cutoff`, summed. A dollar volume is known only when every trade in it had a dollar value. */
  private static sum(trades: Entry['recent'], from: number): { trades: number; buys: number; volumeUsd: number | null; priceChangePct: number | null } {
    let volume: number | null = 0;
    let n = 0;
    let buys = 0;
    let priced = 0;
    let open: number | null = null;
    let close: number | null = null;
    for (let i = from; i < trades.length; i += 1) {
      const t = trades[i]!;
      n += 1;
      if (t.buy) buys += 1;
      volume = volume !== null && t.usd !== null && Number.isFinite(t.usd) ? volume + t.usd : null;
      if (t.price !== null && Number.isFinite(t.price) && t.price > 0) {
        priced += 1;
        open ??= t.price;
        close = t.price;
      }
    }
    return { trades: n, buys, volumeUsd: n > 0 ? volume : null, priceChangePct: priced >= 2 && open !== null && close !== null ? ((close - open) / open) * 100 : null };
  }

  private window(entry: Entry, at: number): Window5m {
    // Trades older than an hour are let go; the five minutes are the tail of what is left.
    const hourAgo = at - HOUR_MS;
    let first = 0;
    while (first < entry.recent.length && entry.recent[first]!.at < hourAgo) first += 1;
    if (first > 0) entry.recent.splice(0, first);
    const cutoff = at - WINDOW_MS;
    let five = entry.recent.length;
    while (five > 0 && entry.recent[five - 1]!.at >= cutoff) five -= 1;
    return FeedState.sum(entry.recent, five);
  }

  /** The hour: the feed's own figures while fresh, else the bot's when it has watched the whole hour, else null. */
  private hour(entry: Entry, at: number): WindowFigures | null {
    const fresh = entry.statsAt !== null && at - entry.statsAt <= STATS_FRESH_MS;
    const fromFeed = fresh ? figuresOf(entry.token.stats?.['1h']) : null;
    if (fromFeed) return fromFeed;
    const watchedWholeHour = at - this.startedAt >= HOUR_MS && (entry.trimmedAt === null || entry.trimmedAt < at - HOUR_MS);
    if (!watchedWholeHour) return null;
    const own = FeedState.sum(entry.recent, 0);
    return { buys: own.buys, sells: own.trades - own.buys, volumeUsd: own.trades === 0 ? 0 : own.volumeUsd, priceChangePct: own.priceChangePct };
  }

  private day(entry: Entry, at: number): WindowFigures | null {
    const fresh = entry.statsAt !== null && at - entry.statsAt <= STATS_FRESH_MS;
    return fresh ? figuresOf(entry.token.stats?.['24h']) : null;
  }

  /** The highest market cap known: the feed's `ath` or the bot's own peak. The bot's carries its time; the feed's does not. */
  private peak(entry: Entry): Peak | null {
    const { ath, mc } = entry.token;
    const fromFeed = finite(ath) && ath > 0 ? ath : null;
    const own = entry.peakMc;
    const best = fromFeed !== null && (own === null || fromFeed > own * 1.0001) ? { mc: fromFeed, at: null } : own !== null ? { mc: own, at: entry.peakAt } : null;
    // A peak below the current market cap would read as a fall that never happened.
    return best && finite(mc) && best.mc < mc ? { mc, at: null } : best;
  }

  private view(entry: Entry, at: number): TokenView {
    return { ...entry.token, m5: this.window(entry, at), h1: this.hour(entry, at), h24: this.day(entry, at), peak: this.peak(entry), lastTradeAt: entry.lastTradeAt };
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

  /** The token's place among the 100 most traded of the last five minutes, or null outside them. */
  async rank(address: string): Promise<number | null> {
    const at = this.entries.get(address)?.lastTradeAt ?? null;
    if (at === null || this.now() - at > WINDOW_MS) return null;
    const place = (await this.trending(100)).findIndex((t) => t.address === address);
    return place < 0 ? null : place + 1;
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

  /** The wallet that created the token, when the feed said. */
  creatorOf(address: string): string | null {
    const creator = this.entries.get(address)?.token.creator;
    return typeof creator === 'string' && creator ? creator : null;
  }
}
