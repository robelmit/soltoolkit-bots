/**
 * What the bots say: a token card, the trending list, a buy post. Each is
 * built once as rich-text lines (`rich.ts`) and printed by the platform's
 * renderer. A figure the feed does not know prints as a dash.
 */

import { DASH, ago, fmtNum, fmtPct, fmtPrice, fmtSol, fmtTokenAmount, fmtUsd, shortAddr } from './format';
import { tokenUrl, txUrl, walletUrl, type LinkTemplates } from './links';
import type { Line, Span } from './rich';
import type { BuyBotConfig, DataSource, FeedTrade, TokenView } from './types';

const known = (value: number | null | undefined): value is number => value !== null && value !== undefined && Number.isFinite(value);
const flag = (value: boolean | null | undefined): string => (value === null || value === undefined ? DASH : value ? '✅' : '⚠️');

const stageOf = (token: Pick<TokenView, 'stage' | 'curve'>): string | null => (token.stage === 'bonding' && known(token.curve) ? `bonding ${Math.round(token.curve)}%` : (token.stage ?? null));

/**
 * The checks line: mint and freeze authority as ✅ revoked, ⚠️ live or — unknown; the shares only when known.
 * Null when the feed said nothing about either.
 */
export function checksText(token: Pick<TokenView, 'audit' | 'risk'>): string | null {
  const audit = token.audit ?? null;
  const risk = token.risk ?? null;
  if (!audit && !risk) return null;
  return [
    `mint ${flag(audit?.mintRevoked)}`,
    `freeze ${flag(audit?.freezeRevoked)}`,
    known(risk?.top10Pct) ? `top 10 ${Math.round(risk.top10Pct)}%` : null,
    known(risk?.devPct) ? `dev ${Math.round(risk.devPct)}%` : null,
    known(risk?.snipersPct) && risk.snipersPct > 0 ? `snipers ${Math.round(risk.snipersPct)}%` : null,
    known(risk?.bundlersPct) && risk.bundlersPct > 0 ? `bundlers ${Math.round(risk.bundlersPct)}%` : null,
    risk?.rugged === true ? 'rugged ⚠️' : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** A token card. */
export function tokenCard(token: TokenView, links: LinkTemplates, now: number): Line[] {
  const lines: Line[] = [
    [{ bold: token.symbol }, ` ${DASH} ${token.name}`],
    [{ code: token.address }],
    [['Solana', token.launchpad ?? null, stageOf(token), token.createdAt ? `${ago(token.createdAt, now)} old` : null].filter(Boolean).join(' · ')],
    [`Price ${fmtPrice(token.price)} · MC ${fmtUsd(token.mc)} · Liq ${fmtUsd(token.liqUsd)}`],
    [`5m ${fmtPct(token.m5.priceChangePct)} · Vol 5m ${fmtUsd(token.m5.volumeUsd)} · Holders ${fmtNum(token.holders, 0)}`],
  ];
  const checks = checksText(token);
  if (checks) lines.push([`Checks: ${checks}`]);
  lines.push([{ link: 'Open in explorer', url: tokenUrl(links, token.address) }]);
  return lines;
}

/** The trending list: the most traded tokens of the last five minutes. */
export function trendingCard(tokens: readonly TokenView[], links: LinkTemplates): Line[] {
  if (!tokens.length) return [[{ bold: 'Trending on Solana launchpads' }], ['Nothing with a dollar volume traded in the last 5 minutes.']];
  const lines: Line[] = [[{ bold: 'Trending on Solana launchpads' }, ` ${DASH} top ${tokens.length} by 5m volume`]];
  tokens.forEach((t, i) => {
    const stage = stageOf(t);
    lines.push([`${i + 1}. `, { link: t.symbol, url: tokenUrl(links, t.address) }, ` MC ${fmtUsd(t.mc)} · 5m ${fmtPct(t.m5.priceChangePct)} · vol ${fmtUsd(t.m5.volumeUsd)}${stage ? ` · ${stage}` : ''}`]);
    lines.push(['   ', { code: t.address }]);
  });
  return lines;
}

/** A buy the buy bot can post: a buy on the token's own market with a dollar value. */
export interface Buy {
  readonly address: string;
  readonly tx: string;
  readonly at: number;
  readonly usd: number;
  readonly amountToken: string;
  readonly amountNative: string;
  readonly price: number | null;
  readonly mc: number | null;
  readonly maker: string;
}

/** A trade as a postable buy, or null: a sell, a trade without a dollar value, or one in a side pool. */
export function buyOf(trade: FeedTrade): Buy | null {
  if (trade.side !== 'buy' || trade.offMarket === true) return null;
  if (trade.usd === null || !Number.isFinite(trade.usd) || trade.usd <= 0) return null;
  return { address: trade.address, tx: trade.tx, at: trade.at, usd: trade.usd, amountToken: trade.amountToken, amountNative: trade.amountNative, price: trade.price, mc: trade.mc, maker: trade.maker };
}

/** The size bar of a buy: one dot per step of the community's minimum, at least one, at most thirty. */
export function sizeBar(usd: number, minUsd: number): string {
  const step = Math.max(minUsd, 10);
  return '🟢'.repeat(Math.max(1, Math.min(30, Math.round(usd / step))));
}

/** A buy at least this many times the minimum, and at least this many dollars, is posted as a whale buy. */
export const WHALE_FACTOR = 10;
export const WHALE_FLOOR_USD = 1_000;

export const isWhale = (usd: number, minUsd: number): boolean => usd >= Math.max(WHALE_FLOOR_USD, minUsd * WHALE_FACTOR);

export interface BuyPost {
  readonly config: BuyBotConfig;
  /** One buy, or the buys of a busy spell merged into one post. */
  readonly buys: readonly Buy[];
  /** How long the merged buys span, in milliseconds. */
  readonly windowMs: number;
}

const symbolOf = (config: BuyBotConfig): string => config.symbol ?? shortAddr(config.address);

/**
 * The post with the token's symbol and decimals filled in from the data source when the buy bot was set up before
 * the source had seen the token. What the source does not know stays unknown.
 */
export async function withTokenFacts(post: BuyPost, source: Pick<DataSource, 'token'>): Promise<BuyPost> {
  if (post.config.symbol !== null && post.config.decimals !== null) return post;
  const token = await source.token(post.config.address).catch(() => null);
  if (!token) return post;
  const decimals = post.config.decimals ?? (typeof token.decimals === 'number' && Number.isInteger(token.decimals) ? token.decimals : null);
  return { ...post, config: { ...post.config, symbol: post.config.symbol ?? token.symbol ?? null, decimals } };
}

/** One buy, or several merged: count, total, the biggest, the latest market cap. */
export function buyPostCard(post: BuyPost, links: LinkTemplates): Line[] {
  const { config, buys } = post;
  const symbol = symbolOf(config);
  if (buys.length === 1) {
    const buy = buys[0]!;
    const head: Span[] = isWhale(buy.usd, config.minUsd) ? ['🐳 ', { bold: `Whale buy · ${symbol}` }] : ['🟢 ', { bold: `${symbol} buy` }];
    return [
      head,
      [sizeBar(buy.usd, config.minUsd)],
      [`💵 ${fmtUsd(buy.usd)} (${fmtSol(buy.amountNative)})`],
      [`🪙 ${fmtTokenAmount(buy.amountToken, config.decimals)} ${symbol}`],
      ['👤 ', { link: shortAddr(buy.maker), url: walletUrl(links, buy.maker) }, ' · ', { link: 'tx', url: txUrl(links, buy.tx) }],
      [`MC ${fmtUsd(buy.mc)} · Price ${fmtPrice(buy.price)}`],
    ];
  }
  const total = buys.reduce((sum, b) => sum + b.usd, 0);
  const biggest = buys.reduce((a, b) => (b.usd > a.usd ? b : a));
  const latest = buys.reduce((a, b) => (b.at > a.at ? b : a));
  return [
    ['🟢 ', { bold: `${symbol}: ${buys.length} buys` }, ` · ${fmtUsd(total)} in ${Math.max(1, Math.round(post.windowMs / 1000))} s`],
    [sizeBar(total, config.minUsd)],
    [`Biggest ${fmtUsd(biggest.usd)} by `, { link: shortAddr(biggest.maker), url: walletUrl(links, biggest.maker) }],
    [`MC ${fmtUsd(latest.mc)} · Price ${fmtPrice(latest.price)}`],
  ];
}
