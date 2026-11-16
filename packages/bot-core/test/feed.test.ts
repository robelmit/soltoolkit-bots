import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { FeedState, parseFeedEvent, readJsonl, readRedisStream, type FeedEvent, type FeedTrade } from '../src';

const FIXTURE = readFileSync(new URL('./fixtures/feed.jsonl', import.meta.url), 'utf8');
const ZOP = 'FWFxnxR1Esvv6Ebcntr357ri1mucV5FiKTG1kEiBpump';
const GTA6 = 'FYVq4tH5MKN6DZ2WTsugg9DC6epMmMrMUczvpsFemoon';

const events = (): FeedEvent[] =>
  FIXTURE.trim()
    .split('\n')
    .map((line) => parseFeedEvent(line))
    .filter((e): e is FeedEvent => e !== null);

const trade = (over: Partial<FeedTrade> = {}): FeedTrade => ({ address: 'Mint1', tx: 'sig', at: 1_000, side: 'buy', amountToken: '1000000', amountNative: '1000000000', usd: 100, price: 0.001, mc: 1000, maker: 'maker', ...over });
const listed = (address: string, symbol = 'TOK'): FeedEvent => ({ type: 'token_upsert', ts: 1, token: { address, symbol, name: symbol } });

describe('parseFeedEvent', () => {
  it('reads every line the launch feed printed', () => {
    expect(events()).toHaveLength(12);
  });

  it('reads a bare event and a parsed object, and leaves other chains and junk out', () => {
    const line = FIXTURE.split('\n')[0]!;
    const bare = JSON.stringify(JSON.parse(line).event);
    expect(parseFeedEvent(bare)?.type).toBe('token_upsert');
    expect(parseFeedEvent(JSON.parse(line))?.type).toBe('token_upsert');
    expect(parseFeedEvent('{not json')).toBeNull();
    expect(parseFeedEvent('[]')).toBeNull();
    expect(parseFeedEvent(JSON.stringify({ type: 'token_tick', ts: 1, chain: 'bsc', address: 'x', price: 1, mc: null, at: 1 }))).toBeNull();
    expect(parseFeedEvent(JSON.stringify({ type: 'market_trade', ts: 1, trade: { address: 'x' } }))).toBeNull();
    expect(parseFeedEvent(JSON.stringify({ type: 'something_new', ts: 1 }))).toBeNull();
  });
});

describe('FeedState', () => {
  it('keeps the tokens the feed listed, patched by what followed', async () => {
    const state = new FeedState({ now: () => 1_790_714_230_000 });
    for (const event of events()) state.apply(event);
    expect(state.getStats()).toMatchObject({ events: 12, trades: 3, tokens: 4 });
    const zop = await state.token(ZOP);
    expect(zop).toMatchObject({ symbol: 'ZOP', launchpad: 'pumpfun', stage: 'new', holders: 1 });
    expect(zop!.curve).toBeCloseTo(3.893, 2);
    // The patch carried part of `risk`; what the listing said about the rest stays.
    expect(zop!.risk).toMatchObject({ devSold: false, snipersPct: 0, rugged: null });
    expect(zop!.audit).toMatchObject({ mintRevoked: true, freezeRevoked: true });
    expect(await state.token('NeverSeen')).toBeNull();
  });

  it('sums the last five minutes and ranks by dollar volume', async () => {
    let now = 1_790_714_230_000;
    const state = new FeedState({ now: () => now });
    for (const event of events()) state.apply(event);
    const top = await state.trending(5);
    // ZOP traded days before GTA6 in the recording, so only GTA6 is inside the window.
    expect(top.map((t) => t.symbol)).toEqual(['GTA6']);
    expect(top[0]!.m5).toMatchObject({ trades: 2, buys: 2, volumeUsd: 17_955 });
    expect(state.lastTradeAt(GTA6)).toBe(1_790_714_227_000);
    now += 6 * 60_000;
    expect(await state.trending(5)).toEqual([]);
    expect((await state.token(GTA6))!.m5).toEqual({ trades: 0, buys: 0, volumeUsd: null, priceChangePct: null });
  });

  it('never counts an unknown dollar value as zero, and keeps side-pool trades out of the window', async () => {
    const state = new FeedState({ now: () => 2_000 });
    state.apply(listed('Mint1'));
    state.apply(listed('Mint2'));
    state.apply({ type: 'market_trade', ts: 1, trade: trade({ usd: null, price: null }) });
    state.apply({ type: 'market_trade', ts: 1, trade: trade({ address: 'Mint2', offMarket: true }) });
    expect((await state.token('Mint1'))!.m5).toEqual({ trades: 1, buys: 1, volumeUsd: null, priceChangePct: null });
    expect((await state.token('Mint2'))!.m5.trades).toBe(0);
    expect(state.lastTradeAt('Mint2')).toBe(1_000);
    expect(await state.trending(5)).toEqual([]);
  });

  it('reports the price change across the window from priced trades', async () => {
    const state = new FeedState({ now: () => 5_000 });
    state.apply(listed('Mint1'));
    state.apply({ type: 'market_trade', ts: 1, trade: trade({ at: 1_000, price: 2 }) });
    expect((await state.token('Mint1'))!.m5.priceChangePct).toBeNull();
    state.apply({ type: 'market_trade', ts: 1, trade: trade({ at: 2_000, price: 3, side: 'sell' }) });
    expect((await state.token('Mint1'))!.m5).toMatchObject({ trades: 2, buys: 1, volumeUsd: 200, priceChangePct: 50 });
  });

  it('applies ticks, drops aged tokens, keeps migrated ones, and hands trades to listeners', async () => {
    const state = new FeedState({ now: () => 2_000 });
    const seen: string[] = [];
    const stop = state.onTrade((t) => seen.push(t.tx));
    state.apply(listed('Mint1'));
    state.apply({ type: 'token_tick', ts: 1, address: 'Mint1', price: 7, mc: null, at: 1 });
    expect((await state.token('Mint1'))!.price).toBe(7);
    state.apply({ type: 'token_tick', ts: 1, address: 'Unknown', price: 7, mc: 1, at: 1 });
    expect(await state.token('Unknown')).toBeNull();
    state.apply({ type: 'market_trade', ts: 1, trade: trade({ tx: 'a' }) });
    stop();
    state.apply({ type: 'market_trade', ts: 1, trade: trade({ tx: 'b' }) });
    expect(seen).toEqual(['a']);
    state.apply({ type: 'token_remove', ts: 1, address: 'Mint1', stage: 'bonding', reason: 'migrated' });
    expect(await state.token('Mint1')).not.toBeNull();
    state.apply({ type: 'token_remove', ts: 1, address: 'Mint1', stage: 'new', reason: 'aged' });
    expect(await state.token('Mint1')).toBeNull();
    state.apply({ type: 'column_reset', ts: 1, stage: 'new', tokens: [{ address: 'A', symbol: 'A', name: 'A' }, { address: 'B', symbol: 'B', name: 'B' }] });
    expect(state.getStats().tokens).toBe(2);
  });

  it('lists the newest tokens first, leaving out the ones without a creation time', async () => {
    const state = new FeedState();
    for (const event of events()) state.apply(event);
    state.apply(listed('Undated'));
    const newest = await state.latest(3);
    expect(newest).toHaveLength(3);
    expect(newest.map((t) => t.createdAt)).toEqual([...newest.map((t) => t.createdAt)].sort((a, b) => (b as number) - (a as number)));
    expect((await state.latest(50)).some((t) => t.address === 'Undated')).toBe(false);
    expect(await state.latest(0)).toEqual([]);
  });

  it('holds at most the tokens it was told to, dropping the ones untouched longest', async () => {
    const state = new FeedState({ maxTokens: 10 });
    for (let i = 0; i < 10; i += 1) state.apply(listed(`M${i}`));
    state.apply({ type: 'token_tick', ts: 1, address: 'M0', price: 1, mc: null, at: 1 });
    state.apply(listed('M10'));
    expect(state.getStats().tokens).toBe(10);
    expect(await state.token('M0')).not.toBeNull();
    expect(await state.token('M1')).toBeNull();
  });
});

describe('readers', () => {
  it('reads lines of JSON and skips what is not an event', async () => {
    const got: string[] = [];
    const result = await readJsonl(Readable.from([`${FIXTURE}\nnot an event\n\n`]), (e) => got.push(e.type));
    expect(result.events).toBe(12);
    expect(result.lines).toBeGreaterThan(12);
    expect(got.filter((t) => t === 'market_trade')).toHaveLength(3);
  });

  it('reads a Redis Stream entry by entry, continues from the last id, and retries a failed read', async () => {
    const payload = JSON.stringify(JSON.parse(FIXTURE.split('\n')[1]!).event);
    const calls: (string | number)[][] = [];
    const abort = new AbortController();
    const client = {
      async xread(...args: (string | number)[]): Promise<unknown> {
        calls.push(args);
        if (calls.length === 1) throw new Error('connection lost');
        if (calls.length === 2) return [['stream:market:solana', [['5-1', ['v', '1', 'payload', payload]], ['5-2', ['v', '1', 'payload', '{bad']], ['5-3', ['v', '1']]]]];
        abort.abort();
        return null;
      },
    };
    const got: FeedEvent[] = [];
    const warned: string[] = [];
    await readRedisStream(client, (e) => got.push(e), abort.signal, { retryMs: 1, log: { info: () => undefined, warn: (m) => warned.push(m), error: () => undefined } });
    expect(got.map((e) => e.type)).toEqual(['market_trade']);
    expect(warned).toHaveLength(1);
    expect(calls[0]!.slice(-2)).toEqual(['stream:market:solana', '$']);
    expect(calls[2]!.slice(-1)).toEqual(['5-3']);
  });
});
