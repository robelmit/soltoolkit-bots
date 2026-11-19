/**
 * Cards for the answers that need the chain itself, not only the feed: a
 * quote, a safety grade, the largest holders, the app behind a trade. The bots
 * get these answers from the toolkit's read-only tools (the same ones its MCP
 * server offers AI agents) and print them here, so every platform shows the
 * same thing. Nothing here reads the chain; it only draws what it is given.
 */

import { DASH, fmtNum, fmtPct, fromBaseUnits, shortAddr } from './format';
import { holderMapUrl, tokenUrl, txUrl, walletUrl, type LinkTemplates } from './links';
import type { Line, Span } from './rich';

/** A quote, in terms any chain can fill: what goes in, what comes out, and what the venue takes. */
export interface QuoteView {
  readonly side: 'buy' | 'sell';
  /** Where the trade would run (pump.fun, a Pons curve); null when the tool did not say. */
  readonly venue: string | null;
  readonly amountIn: string;
  readonly inSymbol: string;
  readonly inDecimals: number | null;
  readonly amountOut: string;
  readonly minOut: string;
  readonly outSymbol: string;
  readonly outDecimals: number | null;
  readonly slippageBps: number;
  /** The venue's fee as text with its unit (`0.005 SOL`); null when unknown. */
  readonly fee: string | null;
  /** Price impact in basis points; null when the venue gives none. */
  readonly impactBps: number | null;
  /** Anything else the trader should know (a snipe tax, a refund). */
  readonly notes?: readonly string[];
}

/** Base units as a short whole amount: `12.3M`, `0.5`, or a dash when the decimals are unknown. */
export function fmtUnits(baseUnits: string, decimals: number | null): string {
  const whole = fromBaseUnits(baseUnits, decimals);
  if (whole === null) return DASH;
  const value = Number(whole);
  if (!Number.isFinite(value)) return DASH;
  if (value >= 1) return fmtNum(value, value >= 100 ? 0 : 4);
  return value === 0 ? '0' : String(Number(value.toPrecision(4)));
}

/** An amount with its unit; base units as they are when the decimals are unknown, never a guessed amount. */
const amountText = (units: string, decimals: number | null, symbol: string): string => (decimals === null ? `${units} base units of ${symbol}` : `${fmtUnits(units, decimals)} ${symbol}`);

export function quoteCard(q: QuoteView, address: string, links: LinkTemplates): Line[] {
  const lines: Line[] = [
    ['💱 ', { bold: `Quote: ${amountText(q.amountIn, q.inDecimals, q.inSymbol)} → ${q.outSymbol}` }, q.venue ? ` · on ${q.venue}` : ''],
    ['🪙 You get: ', { value: amountText(q.amountOut, q.outDecimals, q.outSymbol) }],
    [`🛡 At least: `, { value: amountText(q.minOut, q.outDecimals, q.outSymbol) }, ` at ${fmtPct(q.slippageBps / 100, 1).replace('+', '')} slippage`],
    ['📉 Price impact: ', { value: q.impactBps === null ? DASH : fmtPct(q.impactBps / 100, 2).replace('+', '') }, ...(q.fee ? [' · Fee: ', { value: q.fee } as Span] : [])],
  ];
  for (const note of q.notes ?? []) lines.push([`⚠️ ${note}`]);
  lines.push(['A quote only: nothing was built, signed or sent. Prices move; the trade decides.'], [{ link: 'Token', url: tokenUrl(links, address) }, ' · ', { code: address }]);
  return lines;
}

/** The safety tool's answer: the grade, each check, and what could not be checked. */
export interface SafetyView {
  readonly report: {
    readonly grade: string;
    readonly score: number;
    readonly maxScore: number;
    readonly unverifiedCount: number;
    readonly incomplete: boolean;
    readonly checks: readonly { readonly label: string; readonly passed: boolean; readonly unverified?: boolean; readonly critical?: boolean; readonly detail?: string }[];
  };
  readonly warnings?: readonly string[];
}

const GRADES: Readonly<Record<string, string>> = { safe: '🟢 Safe', caution: '🟡 Caution', risky: '🟠 Risky', dangerous: '🔴 Dangerous', unknown: '⚪ Unknown' };

export function safetyCard(view: SafetyView, symbol: string | null, address: string, links: LinkTemplates): Line[] {
  const r = view.report;
  const lines: Line[] = [
    ['🛡 ', { bold: `Safety: ${symbol ?? shortAddr(address)}` }, ' · ', { bold: GRADES[r.grade] ?? r.grade }, r.incomplete ? '' : ` · ${r.score}/${r.maxScore}`],
  ];
  for (const c of r.checks) lines.push([`${c.unverified ? '❔' : c.passed ? '✅' : c.critical ? '⛔' : '⚠️'} ${c.label}${c.unverified ? ': not verified' : c.detail ? `: ${c.detail}` : ''}`]);
  for (const w of view.warnings ?? []) lines.push([`⚠️ ${w}`]);
  if (r.unverifiedCount > 0) lines.push([`${r.unverifiedCount} check${r.unverifiedCount === 1 ? '' : 's'} could not run; one that could not run never counts as a pass.`]);
  lines.push(['Read from the chain. A grade is a start, not advice.'], [{ link: 'Token', url: tokenUrl(links, address) }, ' · ', { code: address }]);
  return lines;
}

/** The holder map tool's answer: the largest holders, and the clusters of linked ones. */
export interface HoldersView {
  readonly nodes: readonly { readonly id: string; readonly pct: number | null; readonly type: string; readonly label?: string; readonly cluster?: number }[];
  readonly clusters: readonly { readonly id: number; readonly pct: number; readonly wallets: number }[];
}

/** The holder kinds the holder map treats as passive (its `PASSIVE_HOLDER_TYPES`). */
const PASSIVE: readonly string[] = ['pool', 'burn', 'program'];

export function holdersCard(view: HoldersView, symbol: string | null, address: string, links: LinkTemplates, top = 5): Line[] {
  // Pools, burn addresses and programs hold tokens nobody trades with; they are left out of the list.
  const holders = view.nodes.filter((n) => !PASSIVE.includes(n.type));
  const lines: Line[] = [['👥 ', { bold: `Top holders: ${symbol ?? shortAddr(address)}` }]];
  holders.slice(0, top).forEach((n, i) => {
    const tag = n.cluster !== undefined ? ` · group ${n.cluster}` : '';
    lines.push([`${i + 1}. `, { link: n.label ?? shortAddr(n.id), url: walletUrl(links, n.id) }, ' ', { value: n.pct === null ? DASH : `${fmtNum(n.pct, 2)}%` }, tag]);
  });
  const top5 = holders.slice(0, top).reduce<number | null>((sum, n) => (sum === null || n.pct === null ? null : sum + n.pct), 0);
  lines.push([`Top ${Math.min(top, holders.length)}: `, { value: top5 === null ? DASH : `${fmtNum(top5, 1)}%` }]);
  const groups = view.clusters.filter((c) => c.wallets > 1);
  if (groups.length) {
    const biggest = groups.reduce((a, b) => (b.pct > a.pct ? b : a));
    lines.push([`🔗 ${groups.length} linked group${groups.length === 1 ? '' : 's'}; the largest is ${biggest.wallets} wallets holding `, { value: `${fmtNum(biggest.pct, 1)}%` }]);
  } else lines.push(['🔗 No linked holders found among the ones read.']);
  const map = holderMapUrl(links, address);
  if (map) lines.push([{ link: '🫧 Open the holder map', url: map }]);
  lines.push([{ code: address }]);
  return lines;
}

/** The trading-app tool's answer. */
export interface AppView {
  readonly signature: string;
  readonly failed?: boolean;
  readonly platform: string | null;
  readonly by: string | null;
  readonly evidence: string | null;
}

const EVIDENCE: Readonly<Record<string, string>> = { 'fee-wallet': 'its fee wallet was paid', 'fee-payer': 'its relayer paid the fee', program: 'its program ran', router: 'its router was called', 'builder-code': 'its builder code is set', selector: 'its contract call was used' };

export function appCard(view: AppView, links: LinkTemplates): Line[] {
  const lines: Line[] = view.platform
    ? [['🔎 ', { bold: `Placed with ${view.platform}` }], [`How it is known: ${view.by ? (EVIDENCE[view.by] ?? view.by) : DASH}${view.evidence ? ` (${shortAddr(view.evidence)})` : ''}.`]]
    : [['🔎 ', { bold: 'No listed app could be named' }], ['That means unknown, not "none": the trade may come from an app the registry does not list, or from a wallet directly.']];
  if (view.failed) lines.push(['⚠️ The transaction failed on chain.']);
  lines.push([{ link: 'Transaction', url: txUrl(links, view.signature) }]);
  return lines;
}

/** The read-only tools a bot asks, as `createToolRunner` of the toolkit's MCP package gives them. */
export interface ChainTools {
  readonly tools: readonly string[];
  run(name: string, args: Record<string, unknown>): Promise<unknown>;
}

/**
 * What a bot says when a tool gave no data. A tool's own failure (it has a `code`) is said as the tool said it; anything
 * else is a general sentence, so no endpoint address or stack reaches a chat.
 */
export function toolErrorText(error: unknown): string {
  if (error instanceof Error && typeof (error as { code?: unknown }).code === 'string') return error.message;
  return 'The chain could not be read just now. Try again in a moment.';
}

/** A Solana transaction signature, bare or at the end of an explorer link; null for anything else. */
export function detectSignature(text: string): string | null {
  for (const word of text.split(/\s+/)) {
    const last = word.split(/[/?#=&]/).filter(Boolean).reverse().find((part) => /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(part));
    if (last) return last;
  }
  return null;
}

/** An RPC endpoint setting: an http(s) URL, or none (absent or `off`). Throws on anything else, naming the setting. */
export function readRpcUrl(raw: string | undefined, name: string): string | null {
  if (!raw || raw.toLowerCase() === 'off') return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} is not a URL`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`${name} must start with https:// (or http:// for a node of your own)`);
  return raw;
}

/**
 * The chain tools from `@soltoolkit/mcp`'s `createToolRunner`, given as the imported module so the bot does not
 * need it to build. Null, with the reason, when the installed version has no runner (it came in 0.2).
 */
export function toolsFromModule(module: unknown, options: { readonly rpcUrl: string; readonly feed?: unknown }): { readonly tools: ChainTools | null; readonly reason: string | null } {
  const create = (module as { createToolRunner?: (o: Record<string, unknown>) => ChainTools } | null)?.createToolRunner;
  if (typeof create !== 'function') return { tools: null, reason: 'the installed MCP package has no createToolRunner (version 0.2 or later has it)' };
  return { tools: create({ rpcUrl: options.rpcUrl, feed: options.feed ?? null, maxConcurrentCalls: 4 }), reason: null };
}
