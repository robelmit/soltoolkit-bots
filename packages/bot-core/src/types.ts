/**
 * The shapes the kit works with. The feed types are the part of the launch
 * feed's wire format the bots read (see `indexer/README.md`); every figure the
 * feed could not know is `null` or absent, and stays that way here.
 */

export type Stage = 'new' | 'bonding' | 'migrated';

/** The feed's trading figures over one window (`stats["1h"]` and the like). Each is null or absent when unknown. */
export interface FeedWindowStats {
  readonly priceChangePct?: number | null;
  readonly volumeUsd?: number | null;
  readonly buys?: number | null;
  readonly sells?: number | null;
  readonly buyers?: number | null;
  readonly sellers?: number | null;
  readonly netBuyUsd?: number | null;
}

/** A token as the launch feed sends it (the fields the bots read). */
export interface FeedToken {
  readonly address: string;
  readonly symbol: string;
  readonly name: string;
  readonly decimals?: number | null;
  readonly supply?: string | null;
  readonly launchpad?: string | null;
  readonly stage?: Stage | null;
  readonly curve?: number | null;
  readonly quote?: string | null;
  readonly price?: number | null;
  readonly mc?: number | null;
  readonly liqUsd?: number | null;
  readonly holders?: number | null;
  readonly createdAt?: number | null;
  readonly migratedAt?: number | null;
  readonly creator?: string | null;
  /** The highest market cap the feed has seen, in dollars (its all-time high). */
  readonly ath?: number | null;
  /** The token's picture, as a URL. */
  readonly image?: string | null;
  readonly socials?: { readonly x?: string | null; readonly telegram?: string | null; readonly website?: string | null } | null;
  readonly dexPaid?: boolean | null;
  /** Trading figures by window: `1m`, `5m`, `1h`, `6h`, `24h`, as far as the feed computes them. */
  readonly stats?: Readonly<Record<string, FeedWindowStats>> | null;
  readonly audit?: { readonly mintRevoked?: boolean | null; readonly freezeRevoked?: boolean | null } | null;
  readonly risk?: {
    readonly top10Pct?: number | null;
    readonly devPct?: number | null;
    /** The creator sold out of the token. */
    readonly devSold?: boolean | null;
    readonly snipersPct?: number | null;
    readonly bundlersPct?: number | null;
    readonly insidersPct?: number | null;
    readonly rugged?: boolean | null;
  } | null;
}

/** A trade as the launch feed sends it. Amounts are integer strings in base units. */
export interface FeedTrade {
  readonly address: string;
  readonly tx: string;
  readonly at: number;
  readonly side: 'buy' | 'sell';
  readonly amountToken: string;
  readonly amountNative: string;
  readonly usd: number | null;
  readonly price: number | null;
  readonly mc: number | null;
  readonly maker: string;
  readonly tags?: readonly string[];
  readonly route?: string | null;
  readonly platform?: string | null;
  /** A trade in a pool that is not the token's own market: it prices nothing. */
  readonly offMarket?: boolean;
}

export type FeedEvent =
  | { readonly type: 'token_upsert'; readonly ts: number; readonly token: FeedToken }
  | { readonly type: 'token_patch'; readonly ts: number; readonly address: string; readonly patch: Partial<FeedToken> }
  | { readonly type: 'token_tick'; readonly ts: number; readonly address: string; readonly price: number; readonly mc: number | null; readonly at: number }
  | { readonly type: 'market_trade'; readonly ts: number; readonly trade: FeedTrade }
  | { readonly type: 'token_remove'; readonly ts: number; readonly address: string; readonly stage: Stage; readonly reason: string }
  | { readonly type: 'column_reset'; readonly ts: number; readonly stage: Stage; readonly tokens: readonly FeedToken[] };

/** What the last five minutes of trades say about a token. */
export interface Window5m {
  readonly trades: number;
  readonly buys: number;
  readonly volumeUsd: number | null;
  /** Price change over the window in percent; null without two priced trades. */
  readonly priceChangePct: number | null;
}

/**
 * Trading figures over a longer window (an hour, a day). Each is null when unknown: the feed did not send it lately,
 * or the bot has not been running long enough to have seen the whole window itself.
 */
export interface WindowFigures {
  readonly buys: number | null;
  readonly sells: number | null;
  readonly volumeUsd: number | null;
  readonly priceChangePct: number | null;
}

/** The highest market cap known, and when it was reached when the bot saw it happen. */
export interface Peak {
  readonly mc: number;
  /** Null when the figure came from the feed, which does not say when. */
  readonly at: number | null;
}

/** A token with what the bot has seen of it lately. */
export interface TokenView extends FeedToken {
  readonly m5: Window5m;
  /** The last hour; null when nothing is known about it. */
  readonly h1?: WindowFigures | null;
  /** The last 24 hours, from the feed only; null when it did not send them lately. */
  readonly h24?: WindowFigures | null;
  /** The highest market cap known, at or above the current one; null when unknown. */
  readonly peak?: Peak | null;
  readonly lastTradeAt: number | null;
}

/** Where the bots read tokens from. `FeedState` is the built-in one; any other source can stand in. */
export interface DataSource {
  token(address: string): Promise<TokenView | null>;
  /** The most traded tokens of the last five minutes, by dollar volume. */
  trending(limit: number): Promise<TokenView[]>;
  /** When a trade of the token was last seen, or null. */
  lastTradeAt(address: string): number | null;
  /** The token's place in the trending list (1 is first), or null outside it. Optional for other sources. */
  rank?(address: string): Promise<number | null>;
}

/** A group's buy bot: one token, a least size, and where the posts go. */
export interface BuyBotConfig {
  readonly address: string;
  readonly symbol: string | null;
  readonly decimals: number | null;
  readonly minUsd: number;
  /** A picture or GIF posted with each buy, by the platform's own file id. */
  readonly media?: { readonly kind: 'photo' | 'animation'; readonly fileId: string } | null;
  /** The channel the posts go to, where a community has several (Discord); the community itself when absent. */
  readonly channelId?: string | null;
  readonly setBy: string | null;
  readonly setAt: number;
}

/** One community: a Telegram group or a Discord server. */
export interface CommunityRecord {
  readonly id: string;
  readonly title: string | null;
  readonly buyBot: BuyBotConfig | null;
  /** The bot was removed, or the community is gone. */
  readonly left: boolean;
  readonly updatedAt: number;
}

export interface CommunityPatch {
  readonly title?: string | null;
  readonly buyBot?: BuyBotConfig | null;
  readonly left?: boolean;
}

/** Where the bots keep what communities set. */
export interface Store {
  get(id: string): Promise<CommunityRecord | null>;
  upsert(id: string, patch: CommunityPatch): Promise<CommunityRecord>;
  /** Communities with a buy bot that the bot is still in. */
  withBuyBot(): Promise<CommunityRecord[]>;
  /** A community got a new id (a Telegram group upgraded to a supergroup). */
  migrate(fromId: string, toId: string): Promise<void>;
}

/** A logger's four levels; `console` fits. */
export interface Logger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export const silentLogger: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };
