/**
 * What the bots say: a token card, the trending list, a buy post. Each is
 * built once as rich-text lines (`rich.ts`) and printed by the platform's
 * renderer. A figure the feed does not know prints as a dash, and a row with
 * nothing known in it is left out.
 */

import { callMultiple, fmtMultiple } from './calls';
import { DASH, ago, fmtNum, fmtPct, fmtPrice, fmtShort, fmtSol, fmtTokenAmount, fmtUsd, shortAddr } from './format';
import { holderMapUrl, rowFor, tokenUrl, txUrl, walletUrl, type LinkTemplates } from './links';
import type { Line, Span } from './rich';
import type { BuyBotConfig, DataSource, FeedTrade, TokenView, WindowFigures } from './types';

/** The chain this kit's cards name. */
export const CHAIN = Object.freeze({ name: 'Solana', emoji: '☀️', native: 'SOL' });

const known = (value: number | null | undefined): value is number => value !== null && value !== undefined && Number.isFinite(value);
const flag = (value: boolean | null | undefined): string => (value === null || value === undefined ? DASH : value ? '✅' : '⚠️');
const v = (text: string): Span => ({ value: text });
/** A market cap, a liquidity or a volume: no cents (`$4.4K`, `$820`). */
const money = (value: number | null | undefined): string => (known(value) ? `${value < 0 ? '-' : ''}$${fmtShort(Math.abs(value))}` : DASH);

const LAUNCHPADS: Readonly<Record<string, string>> = {
  pumpfun: 'pump.fun',
  pumpswap: 'PumpSwap',
  'meteora-dbc': 'Meteora DBC',
  launchlab: 'LaunchLab',
  'raydium-launchlab': 'LaunchLab',
  letsbonk: 'LetsBonk',
  bonk: 'LetsBonk',
  moonshot: 'Moonshot',
  bags: 'Bags',
  believe: 'Believe',
};

/** A launchpad's name as people write it. */
export const launchpadLabel = (id: string | null | undefined): string | null => (id ? (LAUNCHPADS[id] ?? id) : null);

const squash = (text: string): string => text.toLowerCase().replace(/[\s._-]+/g, '');

/** The feed's id of a launchpad as somebody typed it (`pump.fun`, `pumpfun`, `Meteora DBC`); null when unknown. */
export function launchpadId(typed: string): string | null {
  const want = squash(typed);
  if (!want) return null;
  for (const [id, label] of Object.entries(LAUNCHPADS)) if (squash(id) === want || squash(label) === want) return id;
  return null;
}

const APPS: Readonly<Record<string, string>> = {
  axiom: 'Axiom',
  'pumpfun-app': 'pump.fun',
  gmgn: 'GMGN',
  fomo: 'Fomo',
  padre: 'Padre',
  okx: 'OKX Wallet',
  phantom: 'Phantom',
  binance: 'Binance Wallet',
  trojan: 'Trojan',
  photon: 'Photon',
  bullx: 'BullX',
  ave: 'Ave',
  maestro: 'Maestro',
  bonkbot: 'BONKbot',
  mevx: 'MevX',
  bloom: 'Bloom',
  hexa: 'Hexa',
};

/** The trading app behind a trade, as people write it; the feed's id when the kit does not know the name. */
export const appLabel = (id: string | null | undefined): string | null => (id ? (APPS[id] ?? id) : null);

/** Where the token is in its life: the curve's progress, or migrated. */
const stageOf = (token: Pick<TokenView, 'stage' | 'curve'>): string | null =>
  token.stage === 'migrated' ? '🎓 migrated' : known(token.curve) ? `curve ${Math.round(token.curve)}%` : (token.stage ?? null);

/** An http(s) link from the feed, or null: nothing else goes into a card. A bare X handle becomes its page. */
function safeUrl(value: string | null | undefined, xHandle = false): string | null {
  if (!value) return null;
  const text = value.trim();
  if (xHandle && /^@?[A-Za-z0-9_]{1,15}$/.test(text)) return `https://x.com/${text.replace(/^@/, '')}`;
  try {
    const url = new URL(text);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

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
    risk?.devSold === true ? 'dev sold' : known(risk?.devPct) ? `dev ${Math.round(risk.devPct)}%` : null,
    known(risk?.snipersPct) && risk.snipersPct > 0 ? `snipers ${Math.round(risk.snipersPct)}%` : null,
    known(risk?.bundlersPct) && risk.bundlersPct > 0 ? `bundlers ${Math.round(risk.bundlersPct)}%` : null,
    known(risk?.insidersPct) && risk.insidersPct > 0 ? `insiders ${Math.round(risk.insidersPct)}%` : null,
    risk?.rugged === true ? 'rugged ⚠️' : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

const hasFigures = (w: WindowFigures | null | undefined): w is WindowFigures => !!w && (known(w.volumeUsd) || known(w.priceChangePct) || known(w.buys));

/** What a card can carry besides the token: its place in trending, who called it first. */
export interface CardExtras {
  readonly rank?: number | null;
  /** The chat's first call of this token: who, at what market cap, when. */
  readonly caller?: { readonly by: string; readonly mc: number | null; readonly at: number } | null;
}

/** A token card, in the order traders read one: what it is, what it is worth, how it trades, who holds it, links. */
export function tokenCard(token: TokenView, links: LinkTemplates, now: number, extras: CardExtras = {}): Line[] {
  const h1 = hasFigures(token.h1) ? token.h1 : null;
  const h24 = hasFigures(token.h24) ? token.h24 : null;
  const name = token.name.length > 32 ? `${token.name.slice(0, 31)}…` : token.name;
  const change = known(h1?.priceChangePct) ? `${fmtPct(h1.priceChangePct, 0)} 1h` : known(token.m5.priceChangePct) ? `${fmtPct(token.m5.priceChangePct, 0)} 5m` : null;
  const lines: Line[] = [];

  const quote = token.quote ? (token.quote.length > 10 ? shortAddr(token.quote) : token.quote) : CHAIN.native;
  const figures = [known(token.mc) ? fmtShort(token.mc) : null, change].filter(Boolean).join(' / ');
  lines.push(['🧪 ', { link: name, url: tokenUrl(links, token.address) }, ...(figures ? [' ', { bold: `[${figures}]` }] : []), ` $${token.symbol}/${quote}`]);

  const where = [`${CHAIN.emoji} ${CHAIN.name}${token.launchpad ? ` @ ${launchpadLabel(token.launchpad)}` : ''}`, stageOf(token), known(extras.rank) ? `🔥 #${extras.rank}` : null];
  lines.push([where.filter(Boolean).join(' · ')]);

  lines.push(['💰 Price: ', v(fmtPrice(token.price))]);

  const mcLine: Span[] = ['💎 MC: ', v(money(token.mc))];
  const peak = token.peak ?? null;
  if (peak && known(token.mc) && peak.mc > token.mc * 1.05) mcLine.push(' ⇨ ', v(money(peak.mc)), ` peak${peak.at !== null ? ` [${ago(peak.at, now)}]` : ''}`);
  lines.push(mcLine);

  lines.push(['💧 Liq: ', v(money(token.liqUsd))]);

  // The hour when known, else the bot's five minutes: change, volume, buys and sells of the same window.
  const m5: WindowFigures = { buys: token.m5.trades > 0 ? token.m5.buys : null, sells: token.m5.trades > 0 ? token.m5.trades - token.m5.buys : null, volumeUsd: token.m5.volumeUsd, priceChangePct: token.m5.priceChangePct };
  const w = h1 ?? m5;
  const label = `📈 ${h1 ? '1H' : '5M'}: `;
  if (w.buys === 0 && w.sells === 0) {
    lines.push([label, 'no trades']);
  } else {
    const moves: Span[] = [label, v(fmtPct(w.priceChangePct)), ' · ', v(money(w.volumeUsd))];
    if (known(w.buys) || known(w.sells)) moves.push(` · 🅑 ${known(w.buys) ? fmtNum(w.buys, 0) : DASH} Ⓢ ${known(w.sells) ? fmtNum(w.sells, 0) : DASH}`);
    if (h1 && known(token.m5.priceChangePct)) moves.push(' · 5M ', v(fmtPct(token.m5.priceChangePct)));
    lines.push(moves);
  }

  const day: Span[] = ['📊 '];
  if (h24) day.push('24H: ', v(fmtPct(h24.priceChangePct)), ' · Vol ', v(money(h24.volumeUsd)), ' · ');
  day.push('Age: ', v(token.createdAt ? ago(token.createdAt, now) : DASH));
  lines.push(day);

  const checks = checksText(token);
  if (checks) lines.push([`🛡 ${checks}`]);

  const holders: Span[] = ['👥 Holders: ', v(fmtNum(token.holders, 0))];
  const map = holderMapUrl(links, token.address);
  if (map) holders.push(' · ', { link: '🫧 Map', url: map });
  lines.push(holders);

  const social: Span[] = [];
  const add = (label: string, url: string | null): void => {
    if (!url) return;
    if (social.length) social.push(' · ');
    social.push({ link: label, url });
  };
  add('X', safeUrl(token.socials?.x, true));
  add('TG', safeUrl(token.socials?.telegram));
  add('Web', safeUrl(token.socials?.website));
  if (token.dexPaid === true || token.dexPaid === false) social.push(social.length ? ' · ' : '', `Dex paid ${token.dexPaid ? '✅' : '✗'}`);
  if (social.length) lines.push(['🌐 ', ...social]);

  const row = rowFor(links, token.address);
  if (row.length) lines.push(['🔗 ', ...row.flatMap((link, i): Span[] => (i ? [' · ', { link: link.label, url: link.url }] : [{ link: link.label, url: link.url }]))]);

  lines.push([''], [{ code: token.address }]);
  const caller = extras.caller ?? null;
  if (caller) {
    // The call being made now credits its caller; a later card says how far it went since.
    if (now - caller.at < 60_000) lines.push([`🏆 First call: ${caller.by} @ `, v(fmtShort(caller.mc))]);
    else {
      const times = callMultiple(caller, token.mc);
      lines.push([`🏆 ${caller.by} @ `, v(fmtShort(caller.mc)), times !== null ? ` · ${fmtMultiple(times)}` : '', ` · ${ago(caller.at, now)}`]);
    }
  }
  lines.push(['♻️ Updated ', { time: now }]);
  return lines;
}

/** The trending list: the most traded tokens of the last five minutes. */
export function trendingCard(tokens: readonly TokenView[], links: LinkTemplates): Line[] {
  if (!tokens.length) return [[{ bold: `🔥 Trending on ${CHAIN.name} launchpads` }], ['Nothing with a dollar volume traded in the last 5 minutes.']];
  const lines: Line[] = [[{ bold: `🔥 Trending on ${CHAIN.name} launchpads` }, ` ${DASH} top ${tokens.length} by 5m volume`]];
  tokens.forEach((t, i) => {
    const stage = stageOf(t);
    lines.push([`${i + 1}. `, { link: t.symbol, url: tokenUrl(links, t.address) }, ' · MC ', v(money(t.mc)), ' · 5m ', v(fmtPct(t.m5.priceChangePct)), ' · Vol ', v(money(t.m5.volumeUsd)), stage ? ` · ${stage}` : '']);
    lines.push(['    ', { code: t.address }]);
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
  /** The trading app the buyer used, when the feed could tell. */
  readonly platform?: string | null;
}

/** A trade as a postable buy, or null: a sell, a trade without a dollar value, or one in a side pool. */
export function buyOf(trade: FeedTrade): Buy | null {
  if (trade.side !== 'buy' || trade.offMarket === true) return null;
  if (trade.usd === null || !Number.isFinite(trade.usd) || trade.usd <= 0) return null;
  return { address: trade.address, tx: trade.tx, at: trade.at, usd: trade.usd, amountToken: trade.amountToken, amountNative: trade.amountNative, price: trade.price, mc: trade.mc, maker: trade.maker, platform: trade.platform ?? null };
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
    const app = appLabel(buy.platform);
    return [
      head,
      [sizeBar(buy.usd, config.minUsd)],
      ['💵 ', v(fmtUsd(buy.usd)), ` (${fmtSol(buy.amountNative)})`],
      ['🪙 ', v(fmtTokenAmount(buy.amountToken, config.decimals)), ` ${symbol}`],
      ['👤 ', { link: shortAddr(buy.maker), url: walletUrl(links, buy.maker) }, ' · ', { link: 'tx', url: txUrl(links, buy.tx) }, app ? ` · via ${app}` : ''],
      ['💎 MC ', v(money(buy.mc)), ' · Price ', v(fmtPrice(buy.price))],
    ];
  }
  const total = buys.reduce((sum, b) => sum + b.usd, 0);
  const biggest = buys.reduce((a, b) => (b.usd > a.usd ? b : a));
  const latest = buys.reduce((a, b) => (b.at > a.at ? b : a));
  return [
    ['🟢 ', { bold: `${symbol}: ${buys.length} buys` }, ` · ${fmtUsd(total)} in ${Math.max(1, Math.round(post.windowMs / 1000))} s`],
    [sizeBar(total, config.minUsd)],
    ['🐋 Biggest ', v(fmtUsd(biggest.usd)), ' by ', { link: shortAddr(biggest.maker), url: walletUrl(links, biggest.maker) }],
    ['💎 MC ', v(money(latest.mc)), ' · Price ', v(fmtPrice(latest.price))],
  ];
}
