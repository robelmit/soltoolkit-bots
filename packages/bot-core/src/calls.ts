/**
 * First calls: the first time a token's card is asked for in a community,
 * the bot notes who asked, the market cap then and the time. Every later card
 * of that token there credits them ("🏆 ana @ 10K · 4.0x · 2d"), and `/calls`
 * ranks the community's calls of the last week by how far they went.
 *
 * Names are kept as text and printed as text: never a mention, so a call
 * pings nobody.
 */

import { DASH, ago, fmtShort, shortAddr } from './format';
import { tokenUrl, type LinkTemplates } from './links';
import type { Line, Span } from './rich';
import type { Call, DataSource, Store } from './types';

/** The most calls kept per community, and for how long. */
export const MAX_CALLS = 300;
export const CALL_KEPT_MS = 30 * 24 * 60 * 60_000;
/** `/calls` ranks the calls of this window. */
export const CALLS_WINDOW_MS = 7 * 24 * 60 * 60_000;

/** A name as a call shows it: no leading @ (it would mention), no line breaks, at most 32 characters. */
export function callerName(raw: string | null | undefined, fallback = 'someone'): string {
  const name = (raw ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/^@+/, '')
    .trim();
  return (name || fallback).slice(0, 32);
}

/**
 * The community's first call of a token: the one already noted, or this one, noted now. A token whose market cap
 * is unknown is noted with an unknown one; it is never counted from zero.
 */
export async function firstCall(store: Store, communityId: string, token: { readonly address: string; readonly symbol: string | null; readonly mc: number | null | undefined }, caller: { readonly id: string; readonly name: string }, now: number): Promise<Call> {
  const record = await store.get(communityId);
  const calls = record?.calls ?? [];
  const known = calls.find((c) => c.address === token.address);
  if (known) return known;
  const mc = typeof token.mc === 'number' && Number.isFinite(token.mc) && token.mc > 0 ? token.mc : null;
  const call: Call = { address: token.address, symbol: token.symbol, by: callerName(caller.name), byId: caller.id, mc, at: now };
  const kept = [...calls.filter((c) => now - c.at <= CALL_KEPT_MS), call].slice(-MAX_CALLS);
  await store.upsert(communityId, { calls: kept });
  return call;
}

/** How many times the market cap went up since the call; null when either is unknown. */
export const callMultiple = (call: Pick<Call, 'mc'>, mcNow: number | null | undefined): number | null =>
  call.mc !== null && call.mc > 0 && typeof mcNow === 'number' && Number.isFinite(mcNow) && mcNow > 0 ? mcNow / call.mc : null;

export const fmtMultiple = (x: number | null): string => (x === null ? DASH : x >= 10 ? `${Math.round(x)}x` : `${x.toFixed(1)}x`);

/** The community's best calls of the last week, by how far the market cap went since. */
export async function callsCard(calls: readonly Call[], source: Pick<DataSource, 'token'>, links: LinkTemplates, now: number, limit = 10): Promise<Line[]> {
  const recent = calls.filter((c) => now - c.at <= CALLS_WINDOW_MS);
  if (!recent.length) return [[{ bold: '🏆 Calls here' }], ['No calls in the last 7 days. The first card of a token in this chat counts as a call: paste an address or send /ca <address>.']];
  const rows = await Promise.all(
    recent.map(async (call) => {
      const token = await source.token(call.address).catch(() => null);
      return { call, symbol: token?.symbol ?? call.symbol, mcNow: token?.mc ?? null, x: callMultiple(call, token?.mc ?? null) };
    }),
  );
  // Known multiples first, highest first; calls whose market cap is unknown now come last, newest first.
  rows.sort((a, b) => (a.x === null ? (b.x === null ? b.call.at - a.call.at : 1) : b.x === null ? -1 : b.x - a.x));
  const lines: Line[] = [[{ bold: '🏆 Best calls here' }, ` · last 7 days · ${recent.length} call${recent.length === 1 ? '' : 's'}`]];
  rows.slice(0, limit).forEach((row, i) => {
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
    const spans: Span[] = [`${medal} `, { link: row.symbol ?? shortAddr(row.call.address), url: tokenUrl(links, row.call.address) }, ' ', { value: fmtMultiple(row.x) }, ` · ${row.call.by} · ${row.call.mc !== null ? `$${fmtShort(row.call.mc)}` : DASH} → ${row.mcNow !== null ? `$${fmtShort(row.mcNow)}` : DASH} · ${ago(row.call.at, now)}`];
    lines.push(spans);
  });
  return lines;
}
