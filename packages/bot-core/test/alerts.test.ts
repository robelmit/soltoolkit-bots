/** Token memory across restarts, the alerts, and first calls. */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AlertEngine,
  FeedState,
  MemoryStore,
  alertCard,
  callerName,
  callsCard,
  firstCall,
  linkTemplates,
  loadFeedSnapshot,
  parseLaunchArgs,
  saveFeedSnapshot,
  toText,
  tokenCard,
  type Alert,
  type AlertConfig,
  type CommunityRecord,
  type FeedEvent,
  type TokenChange,
} from '../src';

const A = 'FWFxnxR1Esvv6Ebcntr357ri1mucV5FiKTG1kEiBpump';
const B = 'FYVq4tH5MKN6DZ2WTsugg9DC6epMmMrMUczvpsFemoon';
const listed = (address: string, over: Record<string, unknown> = {}): FeedEvent => ({ type: 'token_upsert', ts: 1, token: { address, symbol: 'TOK', name: 'Tok', launchpad: 'pumpfun', stage: 'new', mc: 5_000, createdAt: 1_000, ...over } });
const patch = (address: string, p: Record<string, unknown>): FeedEvent => ({ type: 'token_patch', ts: 1, address, patch: p });

describe('token memory', () => {
  it('keeps the tokens without their trades or window figures, and takes them back without overwriting newer ones', async () => {
    let now = 10_000;
    const first = new FeedState({ now: () => now });
    first.apply(listed(A, { stats: { '1h': { buys: 3 } }, spark: [1, 2, 3] }));
    first.apply(listed(B));
    first.apply({ type: 'token_tick', ts: 1, address: A, price: 0.00003, mc: 30_000, at: 9_000 });
    const snapshot = first.exportSnapshot();
    expect(snapshot.tokens.map((t) => t.token.address)).toEqual([A, B]);
    expect(snapshot.tokens[0]!.token).not.toHaveProperty('stats');
    expect(snapshot.tokens[0]!.token).not.toHaveProperty('spark');

    const changes: TokenChange[] = [];
    const second = new FeedState({ now: () => now });
    second.onToken((c) => changes.push(c));
    second.apply(listed(B, { symbol: 'NEWER' }));
    changes.length = 0;
    expect(second.importSnapshot(snapshot)).toBe(1);
    expect((await second.token(A))!.mc).toBe(30_000);
    expect((await second.token(A))!.peak).toEqual({ mc: 30_000, at: 9_000 });
    expect((await second.token(B))!.symbol).toBe('NEWER');
    // Taking a snapshot back is not news.
    expect(changes).toEqual([]);
    now += 25 * 60 * 60_000;
    expect(new FeedState({ now: () => now }).importSnapshot(snapshot)).toBe(0);
  });

  it('writes the snapshot through a temporary file and reads it back; a missing or cut file is no snapshot', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'snap-'));
    try {
      const path = join(dir, 'data', 'feed.json');
      const state = new FeedState();
      state.apply(listed(A));
      expect(await saveFeedSnapshot(state, path)).toBe(1);
      const back = new FeedState();
      expect(await loadFeedSnapshot(back, path)).toBe(1);
      expect((await back.token(A))!.symbol).toBe('TOK');
      expect(await loadFeedSnapshot(new FeedState(), join(dir, 'none.json'))).toBe(0);
      await writeFile(path, (await readFile(path, 'utf8')).slice(0, 20));
      expect(await loadFeedSnapshot(new FeedState(), path)).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('tells listeners of listings, patches and ticks, not of a column reset', () => {
    const state = new FeedState();
    const seen: string[] = [];
    state.onToken(({ before, after }) => seen.push(`${before ? before.mc : 'new'}->${after.mc}`));
    state.apply(listed(A));
    state.apply(patch(A, { mc: 6_000 }));
    state.apply({ type: 'token_tick', ts: 1, address: A, price: 1, mc: 7_000, at: 1 });
    state.apply({ type: 'column_reset', ts: 1, stage: 'new', tokens: [{ address: B, symbol: 'B', name: 'B' }] });
    expect(seen).toEqual(['new->5000', '5000->6000', '6000->7000']);
  });
});

function setup(alerts: Partial<AlertConfig> | null, buyBot = false) {
  let now = 30 * 60_000;
  const store = new MemoryStore(() => now);
  const feed = new FeedState({ now: () => now });
  const posted: Alert[] = [];
  let outcome: 'sent' | 'gone' = 'sent';
  const engine = new AlertEngine({ store, now: () => now, post: async (_c, alert) => (posted.push(alert), outcome) });
  feed.onToken(engine.onToken);
  const ready = (async () => {
    if (alerts) await store.upsert('g', { alerts: { launches: null, graduations: null, setBy: '1', setAt: 0, ...alerts } });
    if (buyBot) await store.upsert('g', { buyBot: { address: A, symbol: 'TOK', decimals: 6, minUsd: 25, setBy: null, setAt: 0 } });
    await engine.refresh();
  })();
  return { store, feed, engine, posted, ready, tick: (ms: number) => (now += ms), gone: () => (outcome = 'gone'), now: () => now };
}

describe('AlertEngine', () => {
  it('posts a young token once, the first time it reaches the minimum, from the launchpad asked for', async () => {
    const h = setup({ launches: { minMc: 20_000, launchpad: 'pumpfun' } });
    await h.ready;
    h.feed.apply(listed(A));
    h.feed.apply(patch(A, { mc: 15_000 }));
    await h.engine.flush();
    expect(h.posted).toEqual([]);
    h.feed.apply(patch(A, { mc: 21_000 }));
    h.feed.apply(patch(A, { mc: 19_000 }));
    h.feed.apply(patch(A, { mc: 25_000 }));
    await h.engine.flush();
    expect(h.posted.map((a) => `${a.kind}:${a.address}`)).toEqual([`launch:${A}`]);
    // Another launchpad, and a token older than an hour, are not launches here.
    h.feed.apply(listed(B, { launchpad: 'meteora-dbc', mc: 50_000 }));
    h.feed.apply(listed('Old1111111111111111111111111111111111', { createdAt: -2 * 60 * 60_000, mc: 1_000 }));
    h.feed.apply(patch('Old1111111111111111111111111111111111', { mc: 90_000 }));
    h.tick(61_000);
    await h.engine.flush();
    expect(h.posted).toHaveLength(1);
  });

  it('posts a graduation once a minute at most, and drops one that waited three minutes', async () => {
    const h = setup({ graduations: { on: true } });
    await h.ready;
    h.feed.apply(listed(A, { stage: 'bonding' }));
    h.feed.apply(listed(B, { stage: 'bonding' }));
    h.feed.apply(patch(A, { stage: 'migrated' }));
    h.feed.apply(patch(B, { stage: 'migrated' }));
    await h.engine.flush();
    expect(h.posted.map((a) => a.address)).toEqual([A]);
    h.tick(30_000);
    await h.engine.flush();
    expect(h.posted).toHaveLength(1);
    h.tick(31_000);
    await h.engine.flush();
    expect(h.posted.map((a) => a.address)).toEqual([A, B]);
    // A token first seen already migrated did not graduate in front of the bot.
    h.feed.apply(listed('New1111111111111111111111111111111111', { stage: 'migrated' }));
    h.feed.apply(listed('Late111111111111111111111111111111111', { stage: 'bonding' }));
    h.feed.apply(patch('Late111111111111111111111111111111111', { stage: 'migrated' }));
    h.tick(3 * 60_000 + 1);
    await h.engine.flush();
    expect(h.posted).toHaveLength(2);
    expect(h.engine.getStats().dropped).toBe(1);
  });

  it("tells a buy bot's community at once when the tracked token's creator sells, and stops for a group that is gone", async () => {
    const h = setup(null, true);
    await h.ready;
    h.feed.apply(listed(A, { risk: { devSold: false } }));
    h.feed.apply(patch(A, { risk: { devSold: true } }));
    h.feed.apply(patch(B, { risk: { devSold: true } }));
    await h.engine.flush();
    expect(h.posted.map((a) => a.kind)).toEqual(['devSold']);
    h.gone();
    h.feed.apply(listed(A, { risk: { devSold: false } }));
    await h.engine.flush();
    expect((await h.store.get('g'))!.left).toBe(false);
  });

  it("sees the creator's first sale on a trade, once, and only from the creator's wallet", async () => {
    const now = 1_000_000;
    const store = new MemoryStore(() => now);
    const feed = new FeedState({ now: () => now });
    const posted: Alert[] = [];
    const engine = new AlertEngine({ store, now: () => now, creatorOf: (a) => feed.creatorOf(a), post: async (_c, alert) => (posted.push(alert), 'sent') });
    feed.onTrade(engine.onTrade);
    await store.upsert('g', { buyBot: { address: A, symbol: 'TOK', decimals: 6, minUsd: 25, setBy: null, setAt: 0 } });
    await engine.refresh();
    feed.apply(listed(A, { creator: 'Dev1111111111111111111111111111111111' }));
    const sell = (maker: string, at = now): FeedEvent => ({ type: 'market_trade', ts: 1, trade: { address: A, tx: `t${posted.length}`, at, side: 'sell', amountToken: '1', amountNative: '1', usd: 1_200, price: 1, mc: 1, maker } });
    feed.apply(sell('Someone111111111111111111111111111111'));
    feed.apply({ ...sell('Dev1111111111111111111111111111111111'), trade: { ...(sell('Dev1111111111111111111111111111111111') as { trade: object }).trade, side: 'buy' } } as FeedEvent);
    feed.apply(sell('Dev1111111111111111111111111111111111', now - 120_000));
    await engine.flush();
    expect(posted).toEqual([]);
    feed.apply(sell('Dev1111111111111111111111111111111111'));
    feed.apply(sell('Dev1111111111111111111111111111111111'));
    await engine.flush();
    expect(posted).toEqual([{ kind: 'devSell', address: A, at: now, usd: 1_200, tx: 't0' }]);
  });

  it('draws an alert as a heading over the card, and a dev sale as a short warning', () => {
    const token = { address: A, symbol: 'ZOP', name: 'Zop', launchpad: 'pumpfun', mc: 25_000, creator: 'Dev1111111111111111111111111111111111', m5: { trades: 0, buys: 0, volumeUsd: null, priceChangePct: null }, lastTradeAt: null };
    const community: CommunityRecord = { id: 'g', title: null, buyBot: null, alerts: { launches: { minMc: 20_000, launchpad: 'pumpfun' }, graduations: null, setBy: null, setAt: 0 }, left: false, updatedAt: 0 };
    expect(toText(alertCard({ kind: 'launch', address: A, at: 0 }, token, community, linkTemplates(), 0)).split('\n')[0]).toBe('🚀 New launch past $20K on pump.fun');
    expect(toText(alertCard({ kind: 'graduation', address: A, at: 0 }, token, community, linkTemplates(), 0)).split('\n')[0]).toBe('🎓 Graduated from pump.fun');
    expect(toText(alertCard({ kind: 'devSold', address: A, at: 0 }, token, community, linkTemplates(), 0))).toContain('🚨 Dev sold ZOP\nThe wallet that created the token sold out of it.\n💎 MC: $25K · token · dev Dev1…1111');
    expect(toText(alertCard({ kind: 'devSell', address: A, at: 0, usd: 1_200, tx: 'sig' }, token, community, linkTemplates(), 0))).toContain('🚨 Dev selling ZOP\nThe wallet that created the token just sold $1.2K of it.\n💎 MC: $25K · token · dev Dev1…1111 · tx');
  });

  it('reads /launches as a community types it, refusing a launchpad it does not know', () => {
    expect(parseLaunchArgs('on')).toEqual({ on: true, minMc: 20_000, launchpad: null });
    expect(parseLaunchArgs('ON $50k pump.fun')).toEqual({ on: true, minMc: 50_000, launchpad: 'pumpfun' });
    expect(parseLaunchArgs('on meteora dbc')).toMatchObject({ error: expect.stringContaining('"meteora"') });
    expect(parseLaunchArgs('on 1.2m Meteora-DBC')).toEqual({ on: true, minMc: 1_200_000, launchpad: 'meteora-dbc' });
    expect(parseLaunchArgs('on 500')).toMatchObject({ error: expect.stringContaining('from $1K') });
    expect(parseLaunchArgs('off')).toEqual({ on: false });
    expect(parseLaunchArgs('')).toMatchObject({ error: expect.stringContaining('/launches on') });
  });
});

describe('first calls', () => {
  it('keeps the first call of a token in a community, never a mention, and credits it on later cards', async () => {
    const store = new MemoryStore(() => 0);
    const token = { address: A, symbol: 'ZOP', mc: 10_000 };
    const call = await firstCall(store, 'g', token, { id: '7', name: '@ana\nx' }, 1_000);
    expect(call).toEqual({ address: A, symbol: 'ZOP', by: 'ana x', byId: '7', mc: 10_000, at: 1_000 });
    expect(await firstCall(store, 'g', { ...token, mc: 90_000 }, { id: '8', name: 'bo' }, 2_000)).toEqual(call);
    expect((await firstCall(store, 'other', token, { id: '8', name: 'bo' }, 2_000)).by).toBe('bo');
    expect(callerName('   ')).toBe('someone');
    const view = { address: A, symbol: 'ZOP', name: 'Zop', mc: 42_000, m5: { trades: 0, buys: 0, volumeUsd: null, priceChangePct: null }, lastTradeAt: null };
    expect(toText(tokenCard(view, linkTemplates(), 30_000, { caller: call }))).toContain('🏆 First call: ana x @ 10K');
    expect(toText(tokenCard(view, linkTemplates(), 2 * 86_400_000, { caller: call }))).toContain('🏆 ana x @ 10K · 4.2x · 2d');
  });

  it('ranks the week\'s calls by how far they went, unknown ones last', async () => {
    let now = 10 * 86_400_000;
    const store = new MemoryStore(() => now);
    const feed = new FeedState({ now: () => now });
    feed.apply(listed(A, { symbol: 'AAA', mc: 50_000 }));
    feed.apply(listed(B, { symbol: 'BBB', mc: 20_000 }));
    await firstCall(store, 'g', { address: B, symbol: 'BBB', mc: 10_000 }, { id: '1', name: 'bo' }, now - 86_400_000);
    await firstCall(store, 'g', { address: A, symbol: 'AAA', mc: 5_000 }, { id: '2', name: 'ana' }, now - 3_600_000);
    await firstCall(store, 'g', { address: 'Gone111111111111111111111111111111111', symbol: 'OLD', mc: null }, { id: '3', name: 'cy' }, now - 60_000);
    await firstCall(store, 'g', { address: 'Week111111111111111111111111111111111', symbol: 'WK', mc: 1_000 }, { id: '4', name: 'di' }, now - 8 * 86_400_000);
    const text = toText(await callsCard((await store.get('g'))!.calls!, feed, linkTemplates(), now)).split('\n');
    expect(text[0]).toBe('🏆 Best calls here · last 7 days · 3 calls');
    expect(text[1]).toBe('🥇 AAA 10x · ana · $5K → $50K · 1h');
    expect(text[2]).toBe('🥈 BBB 2.0x · bo · $10K → $20K · 1d');
    expect(text[3]).toBe('🥉 OLD — · cy · — → — · 1m');
    now = 0;
    expect(toText(await callsCard([], feed, linkTemplates(), now))).toContain('No calls in the last 7 days');
  });
});
